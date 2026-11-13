import Foundation
import AVFoundation
import CoreMedia
import CoreVideo

/// `mux --codec prores422`: decodes the rendered video and writes it as Apple ProRes 422
/// in a QuickTime movie with uncompressed 48 kHz stereo sound, tagged BT.709.
enum ProResExport {
    static func run(videoPath: String, audioPath: String?, outPath: String) async throws -> Any {
        let fm = FileManager.default
        guard fm.fileExists(atPath: videoPath) else { throw CLIError("not-found", "No file exists at \(videoPath)") }
        if let ap = audioPath, !fm.fileExists(atPath: ap) { throw CLIError("not-found", "No file exists at \(ap)") }
        guard !fm.fileExists(atPath: outPath) else {
            throw CLIError("exists", "Refusing to overwrite \(outPath). Choose a new output path.")
        }
        let outURL = URL(fileURLWithPath: outPath)
        try fm.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        let videoAsset = AVURLAsset(url: URL(fileURLWithPath: videoPath), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let vTrack = try await videoAsset.loadTracks(withMediaType: .video).first else {
            throw CLIError("no-video", "The video file has no video track.")
        }
        let size = try await vTrack.load(.naturalSize)
        let width = Int(size.width.rounded()), height = Int(size.height.rounded())

        let vReader = try AVAssetReader(asset: videoAsset)
        let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        vOut.alwaysCopiesSampleData = false
        vReader.add(vOut)

        // Written under a temporary name; the finished movie is moved into place.
        let stagingURL = outURL.deletingLastPathComponent().appendingPathComponent(".\(outURL.lastPathComponent).\(UUID().uuidString.prefix(8)).partial.mov")
        defer { try? fm.removeItem(at: stagingURL) }
        let writer = try AVAssetWriter(outputURL: stagingURL, fileType: .mov)
        let colour: [String: Any] = [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ]
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.proRes422,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoColorPropertiesKey: colour,
        ])
        vIn.expectsMediaDataInRealTime = false
        guard writer.canAdd(vIn) else { throw CLIError("mux-failed", "This Mac cannot encode ProRes 422.") }
        writer.add(vIn)

        var aReader: AVAssetReader?
        var aOut: AVAssetReaderAudioMixOutput?
        var aIn: AVAssetWriterInput?
        if let ap = audioPath {
            let audioAsset = AVURLAsset(url: URL(fileURLWithPath: ap))
            let aTracks = try await audioAsset.loadTracks(withMediaType: .audio)
            guard !aTracks.isEmpty else { throw CLIError("no-audio", "The audio file has no audio track.") }
            var layout = AudioChannelLayout()
            layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
            let pcm: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
            let reader = try AVAssetReader(asset: audioAsset)
            let out = AVAssetReaderAudioMixOutput(audioTracks: aTracks, audioSettings: pcm)
            reader.add(out)
            var settings = pcm
            settings[AVChannelLayoutKey] = Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size)
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
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

        var frames = 0
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await MuxCommand.pump(vIn, label: "prores") {
                    guard let sb = vOut.copyNextSampleBuffer() else { return nil }
                    // The picture is display-referred BT.709 by convention. Label the decoded frames
                    // that way so the encoder copies the values instead of applying a transfer conversion.
                    if let pb = CMSampleBufferGetImageBuffer(sb) {
                        CVBufferSetAttachment(pb, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
                        CVBufferSetAttachment(pb, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
                        CVBufferSetAttachment(pb, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
                    }
                    frames += 1
                    return sb
                }
            }
            if let aIn, let aOut {
                group.addTask { await MuxCommand.pump(aIn, label: "prores-audio") { aOut.copyNextSampleBuffer() } }
            }
        }
        await writer.finishWriting()
        if writer.status != .completed || vReader.status == .failed || aReader?.status == .failed {
            let msg = writer.error?.localizedDescription ?? vReader.error?.localizedDescription ?? aReader?.error?.localizedDescription ?? "unknown"
            throw CLIError("mux-failed", "ProRes export failed: \(msg)")
        }
        try fm.moveItem(at: stagingURL, to: outURL)
        let outAsset = AVURLAsset(url: outURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration = (try? await outAsset.load(.duration).seconds) ?? 0
        let bytes = ((try? fm.attributesOfItem(atPath: outPath))?[.size] as? NSNumber)?.int64Value ?? 0
        return ["path": outPath, "duration": r6(duration), "sizeBytes": bytes, "bt709Tagged": true, "codec": "prores422", "frames": frames]
    }
}
