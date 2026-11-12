import Foundation
import AVFoundation
import CoreMedia
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// MARK: - probe

enum ProbeCommand {
    static func run(_ paths: [String]) async throws -> Any {
        guard !paths.isEmpty else { throw CLIError("usage", "probe needs at least one file") }
        var out: [[String: Any]] = []
        for p in paths { out.append(await probe(path: p)) }
        return out
    }

    private static func failure(_ base: [String: Any], _ code: String, _ message: String) -> [String: Any] {
        var d = base
        d["ok"] = false
        d["error"] = ["code": code, "message": message]
        return d
    }

    static func probe(path: String) async -> [String: Any] {
        let url = URL(fileURLWithPath: path)
        var base: [String: Any] = [
            "path": path, "ok": false, "kind": NSNull(), "duration": 0, "sizeBytes": 0,
            "video": NSNull(), "audio": NSNull(), "createdAt": NSNull(), "error": NSNull(),
        ]
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else {
            return failure(base, "not-found", "No file exists at this path.")
        }
        let attrs = try? fm.attributesOfItem(atPath: path)
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        base["sizeBytes"] = size
        if let created = attrs?[.creationDate] as? Date { base["createdAt"] = isoString(created) }
        guard size > 0 else { return failure(base, "corrupt", "The file is empty.") }

        // Still images
        if let type = UTType(filenameExtension: url.pathExtension.lowercased()), type.conforms(to: .image) {
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
                  CGImageSourceGetCount(src) > 0,
                  let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
                  let w = props[kCGImagePropertyPixelWidth] as? Int,
                  let h = props[kCGImagePropertyPixelHeight] as? Int,
                  CGImageSourceCreateImageAtIndex(src, 0, nil) != nil
            else {
                return failure(base, "corrupt", "The image could not be decoded.")
            }
            base["ok"] = true
            base["kind"] = "image"
            base["image"] = ["width": w, "height": h]
            return base
        }

        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        do {
            let (readable, protected, duration) = try await asset.load(.isReadable, .hasProtectedContent, .duration)
            if protected {
                return failure(base, "protected", "This file is copy-protected (DRM) and cannot be edited.")
            }
            let tracks = try await asset.load(.tracks)
            let videoTracks = tracks.filter { $0.mediaType == .video }
            let audioTracks = tracks.filter { $0.mediaType == .audio }
            guard readable, !(videoTracks.isEmpty && audioTracks.isEmpty) else {
                return failure(base, "corrupt", "No readable video or audio was found in this file.")
            }
            var seconds = CMTimeGetSeconds(duration)
            if !seconds.isFinite { seconds = 0 }
            base["duration"] = r6(seconds)

            if let vt = videoTracks.first {
                let (size, transform, nominal, minFrame, formats, decodable) = try await vt.load(
                    .naturalSize, .preferredTransform, .nominalFrameRate, .minFrameDuration, .formatDescriptions, .isDecodable)
                guard let fd = formats.first else {
                    return failure(base, "corrupt", "The video track has no format description.")
                }
                let codec = fourCC(CMFormatDescriptionGetMediaSubType(fd))
                if !decodable {
                    return failure(base, "unsupported-codec", "The video codec '\(codec)' cannot be decoded on this Mac. Convert it to H.264 or HEVC first.")
                }
                let rect = CGRect(origin: .zero, size: size).applying(transform)
                let angle = atan2(Double(transform.b), Double(transform.a)) * 180 / .pi
                let rotation = ((Int(angle.rounded()) % 360) + 360) % 360
                let ext = (CMFormatDescriptionGetExtensions(fd) as? [String: Any]) ?? [:]
                let primaries = ext[kCMFormatDescriptionExtension_ColorPrimaries as String] as? String
                let transfer = ext[kCMFormatDescriptionExtension_TransferFunction as String] as? String
                let hdr = transfer == (kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String)
                    || transfer == (kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String)

                let timing = sampleTiming(asset: asset, track: vt)
                if timing.failed {
                    return failure(base, "corrupt", "The video data could not be read: \(timing.error ?? "unknown error").")
                }
                var fps = Double(nominal)
                if fps <= 0, minFrame.isNumeric, minFrame.seconds > 0 { fps = 1 / minFrame.seconds }
                base["video"] = [
                    "width": Int(abs(rect.width).rounded()), "height": Int(abs(rect.height).rounded()),
                    "fps": r3(fps), "variableFrameRate": timing.variable,
                    "codec": codec, "rotation": rotation,
                    "colorPrimaries": primaries as Any? ?? NSNull(),
                    "hdr": hdr,
                ]
            }
            if let at = audioTracks.first {
                let (formats, decodable) = try await at.load(.formatDescriptions, .isDecodable)
                if let fd = formats.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                    let codec = fourCC(asbd.mFormatID)
                    if !decodable && videoTracks.isEmpty {
                        return failure(base, "unsupported-codec", "The audio codec '\(codec)' cannot be decoded on this Mac.")
                    }
                    base["audio"] = ["channels": Int(asbd.mChannelsPerFrame), "sampleRate": Int(asbd.mSampleRate), "codec": codec]
                }
                if videoTracks.isEmpty {
                    // Make sure audio-only files really decode.
                    if let reader = try? AVAssetReader(asset: asset) {
                        let o = AVAssetReaderTrackOutput(track: at, outputSettings: nil)
                        if reader.canAdd(o) {
                            reader.add(o)
                            reader.startReading()
                            _ = o.copyNextSampleBuffer()
                            if reader.status == .failed {
                                return failure(base, "corrupt", "The audio data could not be read: \(reader.error?.localizedDescription ?? "unknown error").")
                            }
                            reader.cancelReading()
                        }
                    }
                }
            }
            if let created = try? await asset.load(.creationDate), let date = try? await created.load(.dateValue) {
                base["createdAt"] = isoString(date)
            }
            base["kind"] = videoTracks.isEmpty ? "audio" : "video"
            base["ok"] = true
            return base
        } catch {
            let ns = error as NSError
            let code = (ns.domain == AVFoundationErrorDomain && ns.code == AVError.Code.fileFormatNotRecognized.rawValue) ? "corrupt" : "corrupt"
            return failure(base, code, "The file could not be opened: \(ns.localizedDescription)")
        }
    }

    /// Reads up to 600 compressed samples (no decode) to detect variable frame timing and unreadable data.
    private static func sampleTiming(asset: AVAsset, track: AVAssetTrack) -> (variable: Bool, failed: Bool, error: String?) {
        guard let reader = try? AVAssetReader(asset: asset) else { return (false, true, "cannot create reader") }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return (false, true, "cannot read track") }
        reader.add(output)
        guard reader.startReading() else { return (false, true, reader.error?.localizedDescription) }
        var pts: [Double] = []
        while pts.count < 600, let sb = output.copyNextSampleBuffer() {
            let t = CMSampleBufferGetPresentationTimeStamp(sb)
            if t.isNumeric { pts.append(t.seconds) }
        }
        if reader.status == .failed { return (false, true, reader.error?.localizedDescription) }
        reader.cancelReading()
        guard !pts.isEmpty else { return (false, true, "the track contains no samples") }
        guard pts.count > 4 else { return (false, false, nil) }
        pts.sort()
        var deltas: [Double] = []
        for i in 1..<pts.count { deltas.append(pts[i] - pts[i - 1]) }
        let sorted = deltas.sorted()
        let median = sorted[sorted.count / 2]
        guard median > 0 else { return (true, false, nil) }
        let off = deltas.filter { abs($0 - median) / median > 0.2 }.count
        return (Double(off) / Double(deltas.count) > 0.02, false, nil)
    }
}

// MARK: - pcm

enum PcmCommand {
    struct Result { let path: String; let sampleRate: Int; let samples: Int; let duration: Double }

    static func extract(input: String, output: String, rate: Int) async throws -> Result {
        let url = URL(fileURLWithPath: input)
        guard FileManager.default.fileExists(atPath: input) else { throw CLIError("not-found", "No file exists at \(input)") }
        let asset = AVURLAsset(url: url)
        let tracks: [AVAssetTrack]
        do { tracks = try await asset.loadTracks(withMediaType: .audio) } catch {
            throw CLIError("corrupt", "The file could not be opened: \(error.localizedDescription)")
        }
        guard !tracks.isEmpty else { throw CLIError("no-audio", "This file has no audio track.") }
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: rate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let out = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: settings)
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { throw CLIError("no-audio", "The audio track cannot be decoded.") }
        reader.add(out)
        guard reader.startReading() else {
            throw CLIError("corrupt", "Audio could not be read: \(reader.error?.localizedDescription ?? "unknown")")
        }
        let outURL = URL(fileURLWithPath: output)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: output, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: outURL) else { throw CLIError("io", "Cannot write \(output)") }
        defer { try? handle.close() }
        var total = 0
        while let sb = out.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sb) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var data = Data(count: length)
            data.withUnsafeMutableBytes { raw in
                _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
            }
            try handle.write(contentsOf: data)
            total += length / 4
        }
        if reader.status == .failed {
            throw CLIError("corrupt", "Audio decoding failed: \(reader.error?.localizedDescription ?? "unknown")")
        }
        return Result(path: output, sampleRate: rate, samples: total, duration: Double(total) / Double(rate))
    }

    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else { throw CLIError("usage", "pcm <file> --out <path> [--rate 16000]") }
        let res = try await extract(input: input, output: try a.require("out"), rate: a.int("rate") ?? 16000)
        return ["path": res.path, "sampleRate": res.sampleRate, "samples": res.samples, "duration": r6(res.duration)]
    }
}

// MARK: - frames

enum FramesCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else { throw CLIError("usage", "frames <file> --times a,b --width 640 --out-dir <dir>") }
        guard FileManager.default.fileExists(atPath: input) else { throw CLIError("not-found", "No file exists at \(input)") }
        let times = (try a.require("times")).split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard !times.isEmpty else { throw CLIError("usage", "--times needs comma-separated seconds") }
        let width = a.int("width") ?? 640
        let dir = URL(fileURLWithPath: try a.require("out-dir"))
        let prefix = a.string("prefix") ?? "f"
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let asset = AVURLAsset(url: URL(fileURLWithPath: input), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let track = try? await asset.loadTracks(withMediaType: .video).first else {
            throw CLIError("no-video", "This file has no video track.")
        }
        _ = track
        let duration = (try? await asset.load(.duration).seconds) ?? 0
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        gen.maximumSize = CGSize(width: width, height: 0)

        var out: [[String: Any]] = []
        for t in times {
            // The last frame's own timestamp is the latest exact time that can be decoded.
            let clamped = max(0, min(t, max(0, duration - 0.001)))
            let time = CMTime(seconds: clamped, preferredTimescale: 60000)
            let image: CGImage
            do {
                image = try await gen.image(at: time).image
            } catch {
                // Retry with a small tolerance (helps at the very end of fragmented files).
                gen.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 10)
                defer { gen.requestedTimeToleranceBefore = .zero }
                guard let img = try? await gen.image(at: time).image else {
                    throw CLIError("frame-failed", "Could not decode a frame at \(t)s: \(error.localizedDescription)")
                }
                image = img
            }
            let name = String(format: "%@-%09d.jpg", prefix, Int((t * 1000).rounded()))
            let url = dir.appendingPathComponent(name)
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw CLIError("io", "Cannot write \(url.path)")
            }
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { throw CLIError("io", "Cannot write \(url.path)") }
            out.append(["t": t, "path": url.path, "width": image.width, "height": image.height])
        }
        return out
    }
}

// MARK: - activity

enum ActivityCommand {
    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else { throw CLIError("usage", "activity <video> [--fps 4] [--width 96]") }
        guard FileManager.default.fileExists(atPath: input) else { throw CLIError("not-found", "No file exists at \(input)") }
        let fps = max(0.25, min(a.double("fps") ?? 4, 30))
        let width = max(16, min(a.int("width") ?? 96, 512))
        let asset = AVURLAsset(url: URL(fileURLWithPath: input), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let track = try? await asset.loadTracks(withMediaType: .video).first else {
            throw CLIError("no-video", "This file has no video track.")
        }
        let natural = try await track.load(.naturalSize)
        let duration = try await asset.load(.duration).seconds
        let aspect = natural.width > 0 ? Double(natural.height / natural.width) : 0.5625
        let w = (width / 2) * 2
        let h = max(2, (Int((Double(w) * aspect).rounded()) / 2) * 2)

        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelBufferWidthKey as String: w,
            kCVPixelBufferHeightKey as String: h,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw CLIError("unsupported-codec", "The video cannot be decoded.") }
        reader.add(output)
        guard reader.startReading() else {
            throw CLIError("corrupt", "Video could not be read: \(reader.error?.localizedDescription ?? "unknown")")
        }

        func luma(_ pb: CVPixelBuffer) -> [UInt8] {
            CVPixelBufferLockBaseAddress(pb, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
            let pw = CVPixelBufferGetWidthOfPlane(pb, 0), ph = CVPixelBufferGetHeightOfPlane(pb, 0)
            let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
            guard let basePtr = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return [] }
            let p = basePtr.assumingMemoryBound(to: UInt8.self)
            var out = [UInt8](repeating: 0, count: pw * ph)
            for y in 0..<ph {
                out.withUnsafeMutableBufferPointer { dst in
                    (dst.baseAddress! + y * pw).update(from: p + y * stride, count: pw)
                }
            }
            return out
        }
        func diff(_ a: [UInt8], _ b: [UInt8]) -> Double {
            guard a.count == b.count, !a.isEmpty else { return 0 }
            var sum = 0
            for i in 0..<a.count { sum += abs(Int(a[i]) - Int(b[i])) }
            return Double(sum) / Double(a.count) / 255.0
        }

        // The frame shown at sample time T is the last decoded frame with pts <= T.
        var samples: [[String: Any]] = []
        var held: [UInt8]? = nil          // frame currently on screen
        var lastSampled: [UInt8]? = nil   // frame used for the previous sample
        var next = 0
        let step = 1.0 / fps
        func emitSamples(upTo limit: Double) {
            while Double(next) * step < limit {
                let t = Double(next) * step
                guard let cur = held else { samples.append(["t": r3(t), "change": 0.0]); next += 1; continue }
                let change = lastSampled.map { diff($0, cur) } ?? 0
                samples.append(["t": r3(t), "change": r6(change)])
                lastSampled = cur
                next += 1
            }
        }
        while let sb = output.copyNextSampleBuffer() {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            if held != nil { emitSamples(upTo: pts) }
            held = luma(pb)
            if samples.isEmpty && next == 0 && pts > 0 { emitSamples(upTo: pts) }
        }
        if reader.status == .failed {
            throw CLIError("corrupt", "Video decoding failed: \(reader.error?.localizedDescription ?? "unknown")")
        }
        emitSamples(upTo: max(duration, 1e-6))
        return ["fps": fps, "samples": samples]
    }
}

// MARK: - mux

enum MuxCommand {
    private static func bt709Tagged(_ fd: CMFormatDescription) -> CMFormatDescription {
        var ext = (CMFormatDescriptionGetExtensions(fd) as? [String: Any]) ?? [:]
        ext[kCMFormatDescriptionExtension_ColorPrimaries as String] = kCMFormatDescriptionColorPrimaries_ITU_R_709_2
        ext[kCMFormatDescriptionExtension_TransferFunction as String] = kCMFormatDescriptionTransferFunction_ITU_R_709_2
        ext[kCMFormatDescriptionExtension_YCbCrMatrix as String] = kCMFormatDescriptionYCbCrMatrix_ITU_R_709_2
        let dims = CMVideoFormatDescriptionGetDimensions(fd)
        var out: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, codecType: CMFormatDescriptionGetMediaSubType(fd),
            width: dims.width, height: dims.height, extensions: ext as CFDictionary, formatDescriptionOut: &out)
        return out ?? fd
    }

    /// Re-wraps a compressed sample with a new format description, keeping data, timing and sync flags.
    private static func rewrap(_ sb: CMSampleBuffer, format: CMFormatDescription) -> CMSampleBuffer? {
        guard let data = CMSampleBufferGetDataBuffer(sb) else { return nil }
        let count = CMSampleBufferGetNumSamples(sb)
        var timingCount: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: 0, arrayToFill: nil, entriesNeededOut: &timingCount)
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: max(1, timingCount))
        CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: timingCount, arrayToFill: &timing, entriesNeededOut: &timingCount)
        var sizeCount: CMItemCount = 0
        CMSampleBufferGetSampleSizeArray(sb, entryCount: 0, arrayToFill: nil, entriesNeededOut: &sizeCount)
        var sizes = [Int](repeating: 0, count: max(1, sizeCount))
        CMSampleBufferGetSampleSizeArray(sb, entryCount: sizeCount, arrayToFill: &sizes, entriesNeededOut: &sizeCount)
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault, dataBuffer: data, formatDescription: format,
            sampleCount: count, sampleTimingEntryCount: timingCount, sampleTimingArray: &timing,
            sampleSizeEntryCount: sizeCount, sampleSizeArray: &sizes, sampleBufferOut: &out)
        guard status == noErr, let result = out else { return nil }
        if let src = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
           let dst = CMSampleBufferGetSampleAttachmentsArray(result, createIfNecessary: true) {
            for (i, attachments) in src.enumerated() where i < CFArrayGetCount(dst) {
                let dict = unsafeBitCast(CFArrayGetValueAtIndex(dst, i), to: CFMutableDictionary.self)
                for (k, v) in attachments {
                    CFDictionarySetValue(dict, Unmanaged.passUnretained(k).toOpaque(), Unmanaged.passUnretained(v as AnyObject).toOpaque())
                }
            }
        }
        return result
    }

    private static func pump(_ input: AVAssetWriterInput, label: String, next: @escaping () -> CMSampleBuffer?) async {
        let queue = DispatchQueue(label: "cutaway.mux.\(label)")
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            var finished = false
            input.requestMediaDataWhenReady(on: queue) {
                guard !finished else { return }
                while input.isReadyForMoreMediaData {
                    if let sb = next(), input.append(sb) { continue }
                    finished = true
                    input.markAsFinished()
                    cont.resume()
                    return
                }
            }
        }
    }

    static func run(_ a: Args) async throws -> Any {
        let videoPath = try a.require("video")
        let outPath = try a.require("out")
        let audioPath = a.string("audio")
        let fm = FileManager.default
        guard fm.fileExists(atPath: videoPath) else { throw CLIError("not-found", "No file exists at \(videoPath)") }
        if let ap = audioPath, !fm.fileExists(atPath: ap) { throw CLIError("not-found", "No file exists at \(ap)") }
        let outURL = URL(fileURLWithPath: outPath)
        guard !fm.fileExists(atPath: outPath) else {
            throw CLIError("exists", "Refusing to overwrite \(outPath). Choose a new output path.")
        }
        try fm.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        let videoAsset = AVURLAsset(url: URL(fileURLWithPath: videoPath), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let vTrack = try await videoAsset.loadTracks(withMediaType: .video).first else {
            throw CLIError("no-video", "The video file has no video track.")
        }
        guard let srcFormat = try await vTrack.load(.formatDescriptions).first else {
            throw CLIError("corrupt", "The video track has no format description.")
        }
        let tagged = bt709Tagged(srcFormat)

        let vReader = try AVAssetReader(asset: videoAsset)
        let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: nil)
        vOut.alwaysCopiesSampleData = false
        vReader.add(vOut)

        // Written next to the destination first; the colour-tagged copy becomes the final file.
        let stagingURL = outURL.deletingLastPathComponent().appendingPathComponent(".\(outURL.lastPathComponent).\(UUID().uuidString.prefix(8)).partial")
        defer { try? fm.removeItem(at: stagingURL) }
        let writer = try AVAssetWriter(outputURL: stagingURL, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true   // moov at the front
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: tagged)
        vIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(vIn) else { throw CLIError("mux-failed", "Cannot add the video track to the output.") }
        writer.add(vIn)

        var aReader: AVAssetReader?
        var aOut: AVAssetReaderAudioMixOutput?
        var aIn: AVAssetWriterInput?
        if let ap = audioPath {
            let audioAsset = AVURLAsset(url: URL(fileURLWithPath: ap))
            let aTracks = try await audioAsset.loadTracks(withMediaType: .audio)
            guard !aTracks.isEmpty else { throw CLIError("no-audio", "The audio file has no audio track.") }
            let reader = try AVAssetReader(asset: audioAsset)
            let out = AVAssetReaderAudioMixOutput(audioTracks: aTracks, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
            reader.add(out)
            var layout = AudioChannelLayout()
            layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 192_000,
                AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
            ])
            input.expectsMediaDataInRealTime = false
            guard writer.canAdd(input) else { throw CLIError("mux-failed", "Cannot add the audio track to the output.") }
            writer.add(input)
            aReader = reader; aOut = out; aIn = input
        }

        guard vReader.startReading() else {
            throw CLIError("corrupt", "Video could not be read: \(vReader.error?.localizedDescription ?? "unknown")")
        }
        if let ar = aReader, !ar.startReading() {
            throw CLIError("corrupt", "Audio could not be read: \(ar.error?.localizedDescription ?? "unknown")")
        }
        guard writer.startWriting() else {
            throw CLIError("mux-failed", writer.error?.localizedDescription ?? "Cannot start writing.")
        }
        writer.startSession(atSourceTime: .zero)

        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await pump(vIn, label: "video") {
                    guard let sb = vOut.copyNextSampleBuffer() else { return nil }
                    return rewrap(sb, format: tagged) ?? sb
                }
            }
            if let aIn, let aOut {
                group.addTask { await pump(aIn, label: "audio") { aOut.copyNextSampleBuffer() } }
            }
        }
        await writer.finishWriting()
        if writer.status != .completed || vReader.status == .failed || aReader?.status == .failed {
            let msg = writer.error?.localizedDescription ?? vReader.error?.localizedDescription ?? aReader?.error?.localizedDescription ?? "unknown"
            throw CLIError("mux-failed", "Muxing failed: \(msg)")
        }
        var colorTagged = true
        do {
            if try !MP4ColorTagger.tagBT709(input: stagingURL, output: outURL) {
                // Already tagged by the writer: keep the staged file as is.
                try? fm.removeItem(at: outURL)
                try fm.moveItem(at: stagingURL, to: outURL)
            }
        } catch {
            Out.log("could not add the BT.709 colr box (\(error)); keeping the untagged file")
            colorTagged = false
            try? fm.removeItem(at: outURL)
            try fm.moveItem(at: stagingURL, to: outURL)
        }
        let outAsset = AVURLAsset(url: outURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration = (try? await outAsset.load(.duration).seconds) ?? 0
        let size = ((try? fm.attributesOfItem(atPath: outPath))?[.size] as? NSNumber)?.int64Value ?? 0
        return ["path": outPath, "duration": r6(duration), "sizeBytes": size, "bt709Tagged": colorTagged]
    }
}
