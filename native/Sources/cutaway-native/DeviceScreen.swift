import Foundation
import AVFoundation
import CoreMedia
import CoreMediaIO

// iPhone / iPad connected by USB, recorded as the "screen" source. macOS exposes them as
// CoreMediaIO screen-capture devices once a process opts in; they then appear to AVFoundation
// as external muxed devices.

enum ExternalDevices {
    private static var enabled = false

    /// Opts this process in to seeing screen-capture devices. Changes nothing system-wide.
    static func enable() {
        guard !enabled else { return }
        enabled = true
        var address = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var allow: UInt32 = 1
        CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
    }

    static func current() -> [AVCaptureDevice] {
        enable()
        let session = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified)
        var seen = Set<String>()
        return session.devices.filter { seen.insert($0.uniqueID).inserted }
    }

    /// Devices take a moment to appear after opting in; poll for up to `wait` seconds.
    static func list(wait: Double) async -> [AVCaptureDevice] {
        var found = current()
        let deadline = Date().addingTimeInterval(max(0, wait))
        while found.isEmpty && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            found = current()
        }
        return found
    }

    static func kind(of device: AVCaptureDevice) -> String? {
        let text = (device.localizedName + " " + device.modelID).lowercased()
        if text.contains("ipad") { return "ipad" }
        if text.contains("iphone") || text.contains("ipod") { return "iphone" }
        return nil
    }

    static func describe(_ d: AVCaptureDevice) -> [String: Any] {
        let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
        return ["id": d.uniqueID, "name": d.localizedName, "width": Int(dims.width), "height": Int(dims.height),
                "kind": kind(of: d) as Any? ?? NSNull()]
    }
}

final class DeviceScreenSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private weak var sink: CaptureSink?
    private let device: AVCaptureDevice
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "cutaway.device.screen", qos: .userInteractive)
    private var observers: [NSObjectProtocol] = []
    private var stopped = false
    private let lock = NSLock()
    private var firstDims: (Int, Int)?

    var writer: SourceWriter?
    var deviceName: String { device.localizedName }
    var deviceKind: String? { ExternalDevices.kind(of: device) }

    init(device: AVCaptureDevice, sink: CaptureSink) {
        self.device = device
        self.sink = sink
    }

    /// Opens the device and waits for its first picture so the real size is known.
    func prepare() async throws -> (width: Int, height: Int) {
        let input: AVCaptureDeviceInput
        do { input = try AVCaptureDeviceInput(device: device) } catch {
            throw CLIError("capture-failed", "Cannot open \(device.localizedName): \(error.localizedDescription). Unlock the device and choose Trust if it asks.")
        }
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CLIError("capture-failed", "Cannot use \(device.localizedName) as a screen source.")
        }
        session.addInput(input)
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw CLIError("capture-failed", "Cannot read the picture from \(device.localizedName).")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()

        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            lock.lock(); let d = firstDims; lock.unlock()
            if let d { installObservers(); return (d.0, d.1) }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        session.stopRunning()
        throw CLIError("capture-failed", "\(device.localizedName) did not send a picture. Unlock it, keep it awake, and choose Trust if it asks.")
    }

    private func installObservers() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let d = note.object as? AVCaptureDevice, d.uniqueID == self.device.uniqueID else { return }
            self.sink?.sourceLost("screen", reason: "disconnected")
        })
        observers.append(nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            guard let self, !self.stopped else { return }
            let err = (note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription ?? "runtime error"
            self.sink?.sourceLost("screen", reason: "error")
            self.sink?.nonFatal("device-error", "\(self.device.localizedName): \(err)", source: "screen")
        })
    }

    func stop() {
        stopped = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if session.isRunning { session.stopRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !stopped, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lock.lock()
        if firstDims == nil { firstDims = (CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb)) }
        lock.unlock()
        guard let sink, let writer else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let host: Double
        if let clock = session.synchronizationClock, !CFEqual(clock, CMClockGetHostTimeClock()) {
            host = CMSyncConvertTime(pts, from: clock, to: CMClockGetHostTimeClock()).seconds
        } else {
            host = pts.seconds
        }
        guard let t = sink.clock.sessionTime(host: host, establish: true) else { return }
        let res = writer.appendVideo(pb, at: t)
        if res.restored { sink.sourceRestored(writer.id, at: t) }
    }
}
