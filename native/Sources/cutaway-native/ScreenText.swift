import Foundation
import AVFoundation
import CoreGraphics
import Vision

// MARK: - screen-text

/// Text recognised on sampled frames of a screen recording, with a box per line and per word.
/// Runs entirely on this Mac (Vision). The app classifies the text in memory to find things worth
/// masking and keeps only a category and a box; this command writes nothing to disk and logs no text.
enum ScreenTextCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else {
            throw CLIError("usage", "screen-text <video> [--interval 1] [--start S] [--end S] [--width 2560]")
        }
        guard FileManager.default.fileExists(atPath: input) else { throw CLIError("not-found", "No file exists at \(input)") }
        let asset = AVURLAsset(url: URL(fileURLWithPath: input), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard (try? await asset.loadTracks(withMediaType: .video).first) != nil else {
            throw CLIError("no-video", "This file has no video track.")
        }
        let duration = (try? await asset.load(.duration).seconds) ?? 0
        let interval = max(0.2, min(a.double("interval") ?? 1, 10))
        let start = max(0, min(a.double("start") ?? 0, duration))
        let end = max(start, min(a.double("end") ?? duration, duration))
        let maxWidth = max(640, min(a.int("width") ?? 2560, 5120))

        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        // A frame near the requested time is enough, and far cheaper to decode than an exact one.
        let tolerance = CMTime(seconds: interval / 3, preferredTimescale: 600)
        gen.requestedTimeToleranceBefore = tolerance
        gen.requestedTimeToleranceAfter = tolerance
        gen.maximumSize = CGSize(width: maxWidth, height: 0)

        var frames: [[String: Any]] = []
        var lastSignature: [UInt8]?
        var lastLines: [[String: Any]] = []
        var reusedInARow = 0
        var recognised = 0
        var width = 0
        var height = 0
        var t = start
        while t < end || (frames.isEmpty && duration > 0) {
            let clamped = max(0, min(t, max(0, duration - 0.001)))
            guard let result = try? await gen.image(at: CMTime(seconds: clamped, preferredTimescale: 600)) else {
                t += interval
                if t >= end { break }
                continue
            }
            let image = result.image
            width = image.width
            height = image.height
            let signature = Self.signature(image)
            // An unchanged picture has the same text. Still look again every few samples, because one
            // newly typed character can be too small to move the signature.
            let unchanged = lastSignature.map { Self.same($0, signature) } ?? false
            if unchanged && reusedInARow < 4 {
                reusedInARow += 1
            } else {
                lastLines = Self.recognise(image)
                lastSignature = signature
                reusedInARow = 0
                recognised += 1
            }
            frames.append(["t": r3(result.actualTime.seconds.isFinite ? result.actualTime.seconds : clamped), "lines": lastLines])
            t += interval
        }
        return ["interval": interval, "start": r3(start), "end": r3(end), "duration": r3(duration),
                "width": width, "height": height, "recognised": recognised, "frames": frames]
    }

    /// 96 × 54 luminance thumbnail.
    private static func signature(_ image: CGImage) -> [UInt8] {
        let w = 96, h = 54
        var bytes = [UInt8](repeating: 0, count: w * h)
        bytes.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            ctx.interpolationQuality = .low
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return bytes
    }

    private static func same(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > 3 { return false }
        return true
    }

    private static func recognise(_ image: CGImage) -> [[String: Any]] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // Keys, addresses and numbers must come back as written, not "corrected" into words.
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil else { return [] }
        // Vision boxes are normalised with the origin at the bottom-left; the app uses top-left.
        func flip(_ r: CGRect) -> [String: Any] {
            ["x": r6(Double(r.minX)), "y": r6(Double(1 - r.maxY)), "w": r6(Double(r.width)), "h": r6(Double(r.height))]
        }
        var lines: [[String: Any]] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string
            guard !text.isEmpty else { continue }
            var tokens: [[String: Any]] = []
            var index = text.startIndex
            while index < text.endIndex {
                while index < text.endIndex, text[index].isWhitespace { index = text.index(after: index) }
                guard index < text.endIndex else { break }
                var stop = index
                while stop < text.endIndex, !text[stop].isWhitespace { stop = text.index(after: stop) }
                if let box = try? candidate.boundingBox(for: index..<stop) {
                    // Offsets are UTF-16 code units, which is how the app's JavaScript indexes strings.
                    tokens.append(["start": index.utf16Offset(in: text), "end": stop.utf16Offset(in: text), "box": flip(box.boundingBox)])
                }
                index = stop
            }
            lines.append(["text": text, "box": flip(observation.boundingBox), "tokens": tokens])
        }
        return lines
    }
}
