import Foundation
import AVFoundation
import AppKit
import ApplicationServices
import CoreGraphics
import CoreMedia
import CoreVideo
import ImageIO
import UniformTypeIdentifiers
import Vision
import Accelerate

// MARK: - resize-window

/// Moves/resizes another app's window through the Accessibility API. Never prompts.
enum ResizeWindowCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let wid = a.int("window-id"), let width = a.double("width"), let height = a.double("height"), width >= 50, height >= 50 else {
            throw CLIError("usage", "resize-window --window-id N --width W --height H [--x X --y Y]")
        }
        guard AXIsProcessTrusted() else {
            throw CLIError("permission-denied", "Accessibility permission is not granted, so windows cannot be resized. Enable it in System Settings › Privacy & Security › Accessibility.")
        }
        guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(wid)) as? [[String: Any]])?.first,
              let pid = info[kCGWindowOwnerPID as String] as? Int,
              let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else {
            throw CLIError("not-found", "That window is no longer open.")
        }
        let title = info[kCGWindowName as String] as? String
        let app = AXUIElementCreateApplication(pid_t(pid))
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let windows = value as? [AXUIElement], !windows.isEmpty else {
            throw CLIError("not-found", "The app does not expose that window to Accessibility.")
        }
        func point(_ el: AXUIElement) -> CGPoint? {
            var v: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &v) == .success, let v else { return nil }
            var p = CGPoint.zero
            return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
        }
        func size(_ el: AXUIElement) -> CGSize? {
            var v: CFTypeRef?
            guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &v) == .success, let v else { return nil }
            var s = CGSize.zero
            return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
        }
        func name(_ el: AXUIElement) -> String? {
            var v: CFTypeRef?
            return AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &v) == .success ? v as? String : nil
        }
        // Match the Accessibility window to the window id by its frame, then by title.
        let byFrame = windows.first { el in
            guard let p = point(el), let s = size(el) else { return false }
            return abs(p.x - bounds.minX) < 3 && abs(p.y - bounds.minY) < 3 && abs(s.width - bounds.width) < 3 && abs(s.height - bounds.height) < 3
        }
        guard let target = byFrame ?? windows.first(where: { title != nil && !title!.isEmpty && name($0) == title }) else {
            throw CLIError("not-found", "The window could not be matched. Bring it to the front and try again.")
        }
        if let x = a.double("x"), let y = a.double("y") {
            var p = CGPoint(x: x, y: y)
            if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(target, kAXPositionAttribute as CFString, v) }
        }
        var s = CGSize(width: width, height: height)
        guard let sv = AXValueCreate(.cgSize, &s), AXUIElementSetAttributeValue(target, kAXSizeAttribute as CFString, sv) == .success else {
            throw CLIError("resize-failed", "The app refused to resize this window.")
        }
        let finalPoint = point(target) ?? bounds.origin
        let finalSize = size(target) ?? CGSize(width: width, height: height)
        return ["windowId": wid, "x": Int(finalPoint.x.rounded()), "y": Int(finalPoint.y.rounded()),
                "width": Int(finalSize.width.rounded()), "height": Int(finalSize.height.rounded()),
                "exact": abs(finalSize.width - width) < 1.5 && abs(finalSize.height - height) < 1.5]
    }
}

// MARK: - Upright frame reader

/// Decodes a video track as BGRA frames in display orientation, scaled so the longer side is at most `maxSide`.
final class UprightFrameReader {
    let reader: AVAssetReader
    let output: AVAssetReaderOutput
    let duration: Double
    let width: Int
    let height: Int
    let nominalFps: Double

    init(path: String, maxSide: Int) async throws {
        guard FileManager.default.fileExists(atPath: path) else { throw CLIError("not-found", "No file exists at \(path)") }
        let asset = AVURLAsset(url: URL(fileURLWithPath: path), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let track = try? await asset.loadTracks(withMediaType: .video).first else {
            throw CLIError("no-video", "This file has no video track.")
        }
        let natural = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        duration = try await asset.load(.duration).seconds
        nominalFps = Double(try await track.load(.nominalFrameRate))
        let shown = natural.applying(transform)
        let sw = abs(shown.width), sh = abs(shown.height)
        guard sw >= 2, sh >= 2 else { throw CLIError("corrupt", "The video has no usable picture size.") }
        let scale = min(1, Double(maxSide) / Double(max(sw, sh)))
        width = max(2, (Int((Double(sw) * scale).rounded()) / 2) * 2)
        height = max(2, (Int((Double(sh) * scale).rounded()) / 2) * 2)
        reader = try AVAssetReader(asset: asset)
        if transform.isIdentity {
            // Exact source frame timing.
            let o = AVAssetReaderTrackOutput(track: track, outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ])
            o.alwaysCopiesSampleData = false
            output = o
        } else {
            // Rotated footage (phones): let AVFoundation apply the rotation.
            let comp = try await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset)
            let o = AVAssetReaderVideoCompositionOutput(videoTracks: [track], videoSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ])
            o.videoComposition = comp
            o.alwaysCopiesSampleData = false
            output = o
        }
        guard reader.canAdd(output) else { throw CLIError("unsupported-codec", "The video cannot be decoded.") }
        reader.add(output)
        guard reader.startReading() else {
            throw CLIError("corrupt", "Video could not be read: \(reader.error?.localizedDescription ?? "unknown")")
        }
    }

    func next() -> (pb: CVPixelBuffer, pts: Double)? {
        while let sb = output.copyNextSampleBuffer() {
            if let pb = CMSampleBufferGetImageBuffer(sb) { return (pb, CMSampleBufferGetPresentationTimeStamp(sb).seconds) }
        }
        return nil
    }

    func checkFinished() throws {
        if reader.status == .failed {
            throw CLIError("corrupt", "Video decoding failed: \(reader.error?.localizedDescription ?? "unknown")")
        }
    }
}

// MARK: - faces

/// Largest face per sampled frame, for keeping a camera crop centred on the speaker.
enum FacesCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else { throw CLIError("usage", "faces <video> [--fps 5]") }
        let fps = max(0.5, min(a.double("fps") ?? 5, 30))
        let frames = try await UprightFrameReader(path: input, maxSide: 960)
        var samples: [[String: Any]] = []
        var k = 0
        let step = 1.0 / fps
        func detect(_ pb: CVPixelBuffer) -> CGRect? {
            let request = VNDetectFaceRectanglesRequest()
            let handler = VNImageRequestHandler(cvPixelBuffer: pb, orientation: .up, options: [:])
            guard (try? handler.perform([request])) != nil, let faces = request.results, !faces.isEmpty else { return nil }
            return faces.max { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }?.boundingBox
        }
        while let f = frames.next() {
            guard f.pts + 1e-4 >= Double(k) * step else { continue }
            let box = detect(f.pb)
            // One decoded frame can answer several sample times when the video's own rate is lower than --fps.
            while Double(k) * step <= f.pts + 1e-4 {
                let t = r3(Double(k) * step)
                if let b = box {
                    // Vision's origin is bottom-left; ours is top-left.
                    samples.append(["t": t, "x": r6(Double(b.minX)), "y": r6(Double(1 - b.maxY)), "w": r6(Double(b.width)), "h": r6(Double(b.height))])
                } else {
                    samples.append(["t": t, "none": true])
                }
                k += 1
            }
        }
        try frames.checkFinished()
        return ["fps": fps, "samples": samples, "found": samples.filter { $0["none"] == nil }.count]
    }
}

// MARK: - matte

/// Person-segmentation matte (white = person) as a greyscale H.264 movie on the input's own timeline.
enum MatteCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first, let outPath = a.string("out") else {
            throw CLIError("usage", "matte <video> --out <mov> [--fps 30] [--quality fast|balanced|accurate]")
        }
        let maxFps = max(1, min(a.double("fps") ?? 30, 120))
        let qualityName = a.string("quality") ?? "balanced"
        let quality: VNGeneratePersonSegmentationRequest.QualityLevel
        switch qualityName {
        case "fast": quality = .fast
        case "accurate": quality = .accurate
        case "balanced": quality = .balanced
        default: throw CLIError("usage", "--quality must be fast, balanced or accurate")
        }
        let outURL = URL(fileURLWithPath: outPath)
        if FileManager.default.fileExists(atPath: outPath) { throw CLIError("exists", "\(outPath) already exists.") }
        let frames = try await UprightFrameReader(path: input, maxSide: 1280)
        // The matte is soft and gets scaled when composited; 720 on the long side is plenty.
        let scale = min(1, 720.0 / Double(max(frames.width, frames.height)))
        let w = max(2, (Int((Double(frames.width) * scale).rounded()) / 2) * 2)
        let h = max(2, (Int((Double(frames.height) * scale).rounded()) / 2) * 2)

        let writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w,
            AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(600_000, w * h * 2),
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ])
        vInput.expectsMediaDataInRealTime = false
        vInput.mediaTimeScale = 60000
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vInput, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelBufferWidthKey as String: w,
            kCVPixelBufferHeightKey as String: h,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ])
        guard writer.canAdd(vInput) else { throw CLIError("writer-failed", "Cannot configure the matte writer.") }
        writer.add(vInput)
        guard writer.startWriting() else { throw CLIError("writer-failed", writer.error?.localizedDescription ?? "Cannot start writing the matte.") }
        writer.startSession(atSourceTime: .zero)

        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = quality
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        let sequence = VNSequenceRequestHandler()

        func matteBuffer(from mask: CVPixelBuffer?) -> CVPixelBuffer? {
            guard let pool = adaptor.pixelBufferPool else { return nil }
            var out: CVPixelBuffer?
            guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess, let dst = out else { return nil }
            CVPixelBufferLockBaseAddress(dst, [])
            defer { CVPixelBufferUnlockBaseAddress(dst, []) }
            guard let yBase = CVPixelBufferGetBaseAddressOfPlane(dst, 0), let cBase = CVPixelBufferGetBaseAddressOfPlane(dst, 1) else { return nil }
            let yStride = CVPixelBufferGetBytesPerRowOfPlane(dst, 0)
            memset(cBase, 128, CVPixelBufferGetBytesPerRowOfPlane(dst, 1) * CVPixelBufferGetHeightOfPlane(dst, 1))
            guard let mask else {
                memset(yBase, 0, yStride * h)
                return dst
            }
            CVPixelBufferLockBaseAddress(mask, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
            guard let mBase = CVPixelBufferGetBaseAddress(mask) else { memset(yBase, 0, yStride * h); return dst }
            var src = vImage_Buffer(data: mBase, height: vImagePixelCount(CVPixelBufferGetHeight(mask)), width: vImagePixelCount(CVPixelBufferGetWidth(mask)), rowBytes: CVPixelBufferGetBytesPerRow(mask))
            var dest = vImage_Buffer(data: yBase, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: yStride)
            vImageScale_Planar8(&src, &dest, nil, vImage_Flags(kvImageHighQualityResampling))
            return dst
        }

        var written = 0
        var lastWritten = -1.0
        var lastProgress = -1.0
        var withPerson = 0
        let minGap = 1.0 / maxFps - 1e-4
        while let f = frames.next() {
            // Above --fps, intermediate frames are skipped; the ones kept retain their own timestamps.
            if lastWritten >= 0, f.pts - lastWritten < minGap { continue }
            var mask: CVPixelBuffer?
            if (try? sequence.perform([request], on: f.pb, orientation: .up)) != nil { mask = request.results?.first?.pixelBuffer }
            guard let pb = matteBuffer(from: mask) else { throw CLIError("writer-failed", "Could not allocate a matte frame.") }
            if mask != nil, hasCoverage(pb, width: w, height: h) { withPerson += 1 }
            while !vInput.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
            guard adaptor.append(pb, withPresentationTime: CMTime(seconds: max(0, f.pts), preferredTimescale: 60000)) else {
                throw CLIError("writer-failed", writer.error?.localizedDescription ?? "Could not write a matte frame.")
            }
            written += 1
            lastWritten = f.pts
            if frames.duration > 0 {
                let p = (f.pts / frames.duration * 100).rounded() / 100
                if p - lastProgress >= 0.05 { lastProgress = p; Out.log("progress \(min(1, max(0, p)))") }
            }
        }
        try frames.checkFinished()
        guard written > 0 else {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: outURL)
            throw CLIError("corrupt", "No frames could be decoded.")
        }
        vInput.markAsFinished()
        // Same duration as the input: the last matte frame holds until the video ends.
        writer.endSession(atSourceTime: CMTime(seconds: max(frames.duration, lastWritten + 0.001), preferredTimescale: 60000))
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw CLIError("writer-failed", writer.error?.localizedDescription ?? "The matte could not be finished.")
        }
        Out.log("progress 1.0")
        return ["path": outPath, "duration": r3(frames.duration), "frames": written, "width": w, "height": h,
                "quality": qualityName, "framesWithPerson": withPerson]
    }

    /// True when at least 0.5% of the matte is clearly "person".
    private static func hasCoverage(_ pb: CVPixelBuffer, width: Int, height: Int) -> Bool {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return false }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let p = base.assumingMemoryBound(to: UInt8.self)
        var hits = 0, total = 0
        var y = 0
        while y < height {
            var x = 0
            while x < width {
                if p[y * stride + x] > 128 { hits += 1 }
                total += 1
                x += 4
            }
            y += 4
        }
        return total > 0 && Double(hits) / Double(total) > 0.005
    }
}

// MARK: - gif

enum GifCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let input = a.string("video") ?? a.positional.first, let outPath = a.string("out") else {
            throw CLIError("usage", "gif --video <mp4> --out <gif> [--fps 15] [--width 800] [--start s --duration s]")
        }
        guard FileManager.default.fileExists(atPath: input) else { throw CLIError("not-found", "No file exists at \(input)") }
        if FileManager.default.fileExists(atPath: outPath) { throw CLIError("exists", "\(outPath) already exists.") }
        let fps = max(1, min(a.double("fps") ?? 15, 50))
        let width = max(64, min(a.int("width") ?? 800, 1920))
        let asset = AVURLAsset(url: URL(fileURLWithPath: input), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard (try? await asset.loadTracks(withMediaType: .video).first) != nil else { throw CLIError("no-video", "This file has no video track.") }
        let total = try await asset.load(.duration).seconds
        let start = max(0, min(a.double("start") ?? 0, max(0, total - 0.05)))
        let length = max(0.05, min(a.double("duration") ?? (total - start), total - start))
        let count = max(1, Int((length * fps).rounded(.down)))
        guard count <= 3000 else {
            throw CLIError("too-long", "That would be \(count) frames. Shorten the range or lower the frame rate (3000 frames at most).")
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: width, height: width * 4)
        let tol = CMTime(seconds: 0.5 / fps, preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tol
        generator.requestedTimeToleranceAfter = tol

        let outURL = URL(fileURLWithPath: outPath)
        guard let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.gif.identifier as CFString, count, nil) else {
            throw CLIError("io", "Cannot create \(outPath).")
        }
        CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary as String: [kCGImagePropertyGIFLoopCount as String: 0]] as CFDictionary)
        // GIF delays are whole hundredths of a second; carry the rounding error so the total length stays right.
        var owed = 0.0
        var added = 0
        var size = CGSize.zero
        for i in 0..<count {
            let t = start + Double(i) / fps
            guard let image = try? await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)).image else { continue }
            let ideal = 1.0 / fps + owed
            let delay = max(0.02, (ideal * 100).rounded() / 100)
            owed = ideal - delay
            let props: [String: Any] = [kCGImagePropertyGIFDictionary as String: [
                kCGImagePropertyGIFDelayTime as String: delay,
                kCGImagePropertyGIFUnclampedDelayTime as String: delay,
            ]]
            CGImageDestinationAddImage(dest, image, props as CFDictionary)
            size = CGSize(width: image.width, height: image.height)
            added += 1
            if i % 10 == 0 { Out.log("progress \((Double(i + 1) / Double(count) * 100).rounded() / 100)") }
        }
        guard added > 0 else { throw CLIError("corrupt", "No frames could be read from the video.") }
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: outURL)
            throw CLIError("io", "The GIF could not be written.")
        }
        let bytes = ((try? FileManager.default.attributesOfItem(atPath: outPath))?[.size] as? NSNumber)?.int64Value ?? 0
        return ["path": outPath, "frames": added, "sizeBytes": bytes, "width": Int(size.width), "height": Int(size.height),
                "fps": fps, "duration": r3(Double(added) / fps)]
    }
}

// MARK: - voices / speak (on-device speech synthesis)

enum VoicesCommand {
    static func run() async throws -> Any {
        AVSpeechSynthesisVoice.speechVoices().map { v -> [String: Any] in
            let quality: String
            switch v.quality {
            case .premium: quality = "premium"
            case .enhanced: quality = "enhanced"
            default: quality = "default"
            }
            return ["id": v.identifier, "name": v.name, "language": v.language, "quality": quality]
        }.sorted { a, b in
            let la = a["language"] as! String, lb = b["language"] as! String
            return la == lb ? (a["name"] as! String) < (b["name"] as! String) : la < lb
        }
    }
}

enum SpeakCommand {
    private final class Collector {
        var buffers: [AVAudioPCMBuffer] = []
        var marks: [(offset: Int, range: NSRange)] = []
        var done = false
        let lock = NSLock()
    }

    static func run(_ a: Args) async throws -> Any {
        guard let textFile = a.string("text-file"), let outPath = a.string("out") else {
            throw CLIError("usage", "speak --text-file <txt> --out <wav> [--voice <id>] [--rate 0.5]")
        }
        guard let text = try? String(contentsOfFile: textFile, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CLIError("not-found", "The text file is missing or empty.")
        }
        if FileManager.default.fileExists(atPath: outPath) { throw CLIError("exists", "\(outPath) already exists.") }
        let utterance = AVSpeechUtterance(string: text)
        if let id = a.string("voice") {
            guard let voice = AVSpeechSynthesisVoice(identifier: id) else { throw CLIError("voice-unavailable", "That voice is not installed on this Mac.") }
            utterance.voice = voice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        }
        utterance.rate = Float(max(0, min(a.double("rate") ?? Double(AVSpeechUtteranceDefaultSpeechRate), 1)))

        let synth = AVSpeechSynthesizer()
        let box = Collector()
        await MainActor.run {
            synth.write(utterance, toBufferCallback: { buffer in
                box.lock.lock(); defer { box.lock.unlock() }
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else { box.done = true; return }
                box.buffers.append(pcm)
            }, toMarkerCallback: { markers in
                box.lock.lock(); defer { box.lock.unlock() }
                if ProcessInfo.processInfo.environment["CUTAWAY_DEBUG_MARKS"] != nil { Out.log("markers \(markers.map { "\($0.mark.rawValue)@\($0.byteSampleOffset)" })") }
                for m in markers where m.mark == .word { box.marks.append((Int(m.byteSampleOffset), m.textRange)) }
            })
        }
        let deadline = Date().addingTimeInterval(300)
        while true {
            box.lock.lock(); let done = box.done; box.lock.unlock()
            if done { break }
            if Date() > deadline { throw CLIError("timeout", "Speech synthesis did not finish.") }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        box.lock.lock()
        let buffers = box.buffers
        let marks = box.marks
        box.lock.unlock()
        guard let first = buffers.first else { throw CLIError("speak-failed", "The voice produced no audio.") }
        let format = first.format
        let outURL = URL(fileURLWithPath: outPath)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: Int(format.channelCount),
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        var frames: Int64 = 0
        do {
            let file = try AVAudioFile(forWriting: outURL, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
            for b in buffers { try file.write(from: b); frames += Int64(b.frameLength) }
        } catch {
            try? FileManager.default.removeItem(at: outURL)
            throw CLIError("io", "The audio could not be written: \(error.localizedDescription)")
        }
        let duration = Double(frames) / format.sampleRate
        var result: [String: Any] = ["path": outPath, "duration": r3(duration), "sampleRate": Int(format.sampleRate),
                                     "channels": Int(format.channelCount), "voice": utterance.voice?.identifier ?? ""]
        // Word marks: the synthesizer reports byte offsets into its own stream.
        let bytesPerFrame = max(1, Int(format.streamDescription.pointee.mBytesPerFrame))
        let ns = text as NSString
        var out: [[String: Any]] = []
        let sorted = marks.sorted { $0.offset < $1.offset }
        for (i, m) in sorted.enumerated() {
            guard m.range.location != NSNotFound, m.range.location + m.range.length <= ns.length else { continue }
            let start = Double(m.offset) / Double(bytesPerFrame) / format.sampleRate
            let end = i + 1 < sorted.count ? Double(sorted[i + 1].offset) / Double(bytesPerFrame) / format.sampleRate : duration
            guard start <= duration + 0.05 else { continue }
            out.append(["word": ns.substring(with: m.range), "start": r3(start), "end": r3(min(max(end, start), duration))])
        }
        if !out.isEmpty { result["marks"] = out }
        return result
    }
}
