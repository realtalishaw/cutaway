import Foundation
import CoreImage
import CoreVideo

/// Small JPEG stills of a camera, emitted on the event stream while a take is being recorded,
/// so the app can show the creator a live self-view without opening the camera a second time.
/// A second reader (the app's own getUserMedia) can renegotiate the device's active format
/// and disturb the take; these frames come from the very buffers that are being recorded.
final class PreviewEmitter {
    /// Whether previews are wanted right now. Toggled by the `preview-on` / `preview-off` commands.
    static var enabled = true

    let id: String
    private let interval: Double
    private let maxWidth: Int
    private let queue = DispatchQueue(label: "cutaway.preview", qos: .utility)
    private let lock = NSLock()
    private var busy = false
    private var last = 0.0
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    init(id: String, fps: Double, width: Int) {
        self.id = id
        self.interval = 1.0 / max(1, min(fps, 30))
        self.maxWidth = max(120, min(width, 960))
    }

    /// Never blocks the capture queue: a frame is skipped when the previous one is still being encoded.
    func offer(_ pixelBuffer: CVPixelBuffer, hostNow now: Double) {
        guard Self.enabled else { return }
        lock.lock()
        if busy || now - last < interval { lock.unlock(); return }
        busy = true
        last = now
        lock.unlock()
        queue.async { [self] in
            defer { lock.lock(); busy = false; lock.unlock() }
            let w = CVPixelBufferGetWidth(pixelBuffer), h = CVPixelBufferGetHeight(pixelBuffer)
            guard w > 0, h > 0 else { return }
            let scale = min(1, Double(maxWidth) / Double(w))
            var image = CIImage(cvPixelBuffer: pixelBuffer)
            if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
            let options: [CIImageRepresentationOption: Any] = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.6]
            guard let data = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else { return }
            Out.emit(["type": "preview", "source": id, "width": Int((Double(w) * scale).rounded()), "height": Int((Double(h) * scale).rounded()),
                      "jpeg": data.base64EncodedString()])
        }
    }
}
