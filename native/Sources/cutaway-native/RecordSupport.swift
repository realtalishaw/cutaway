import Foundation
import AVFoundation
import CoreMedia
import CoreGraphics
import Accelerate

// MARK: - Config

struct RecordConfig {
    struct Screen {
        var type: String            // display | window | region | device
        var displayId: UInt32?
        var deviceId: String?       // type == "device": a connected iPhone/iPad
        var hideDesktopIcons: Bool
        var hideNotifications: Bool
        var windowId: UInt32?
        var rect: CGRect?           // global display points, top-left origin
        var showCursor: Bool
        var excludeBundleIds: [String]
        var maxHeight: Int
    }
    struct Camera {
        var slot: String            // "A" | "B"
        var deviceId: String
        var width: Int?
        var height: Int?
        var fps: Double?
        var sourceId: String { "camera\(slot.uppercased())" }
        var fileName: String { "camera-\(slot.lowercased()).mov" }
    }
    struct Microphone { var deviceId: String? }

    var outDir: URL
    var fps: Int
    var screen: Screen?
    var cameras: [Camera]
    var microphone: Microphone?
    var systemAudio: Bool
    /// When set, system audio is captured from these apps only (bundle identifiers).
    var systemAudioApps: [String]?
    /// Record shortcuts and typing activity (never characters) to keys.jsonl.
    var captureKeys: Bool
    var checkpointSeconds: Double
    var minFreeBytes: Int64
    var waitForStart: Bool
    var maxDuration: Double?
    var synthetic: Bool

    /// The screen source when it is captured with ScreenCaptureKit (display, window or region).
    var sckScreen: Screen? { screen.flatMap { $0.type == "device" ? nil : $0 } }
    /// The screen source when it is a connected iPhone or iPad.
    var deviceScreen: Screen? { screen.flatMap { $0.type == "device" ? $0 : nil } }

    static func load(path: String) throws -> RecordConfig {
        guard let data = FileManager.default.contents(atPath: path) else {
            throw CLIError("not-found", "No config file at \(path)")
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw CLIError("bad-config", "The config file is not a JSON object.")
        }
        guard let out = json["outDir"] as? String, !out.isEmpty else {
            throw CLIError("bad-config", "outDir is required.")
        }
        func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
        var screen: Screen?
        if let s = json["screen"] as? [String: Any] {
            var rect: CGRect?
            if let r = s["rect"] as? [String: Any], let x = num(r["x"]), let y = num(r["y"]),
               let w = num(r["width"]), let h = num(r["height"]) {
                rect = CGRect(x: x, y: y, width: w, height: h)
            }
            screen = Screen(
                type: (s["type"] as? String) ?? "display",
                displayId: num(s["displayId"]).map { UInt32($0) },
                deviceId: s["deviceId"] as? String,
                hideDesktopIcons: (s["hideDesktopIcons"] as? Bool) ?? false,
                hideNotifications: (s["hideNotifications"] as? Bool) ?? false,
                windowId: num(s["windowId"]).map { UInt32($0) },
                rect: rect,
                showCursor: (s["showCursor"] as? Bool) ?? false,
                excludeBundleIds: (s["excludeBundleIds"] as? [String]) ?? [],
                maxHeight: Int(num(s["maxHeight"]) ?? 2160))
        }
        let cameras: [Camera] = ((json["cameras"] as? [[String: Any]]) ?? []).compactMap { c in
            guard let id = c["deviceId"] as? String else { return nil }
            return Camera(slot: ((c["slot"] as? String) ?? "A").uppercased(), deviceId: id,
                          width: num(c["width"]).map(Int.init), height: num(c["height"]).map(Int.init), fps: num(c["fps"]))
        }
        var mic: Microphone?
        if let m = json["microphone"] as? [String: Any] {
            mic = Microphone(deviceId: m["deviceId"] as? String)
        }
        // systemAudio: true | false | { "apps": ["bundle.id", …] }
        var systemAudio = (json["systemAudio"] as? Bool) ?? false
        var systemAudioApps: [String]?
        if let obj = json["systemAudio"] as? [String: Any] {
            systemAudio = true
            if let apps = obj["apps"] as? [String] {
                let cleaned = apps.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                if !cleaned.isEmpty { systemAudioApps = cleaned }
            }
        }
        return RecordConfig(
            outDir: URL(fileURLWithPath: out),
            fps: Int(num(json["fps"]) ?? 60),
            screen: screen,
            cameras: cameras,
            microphone: mic,
            systemAudio: systemAudio,
            systemAudioApps: systemAudioApps,
            captureKeys: (json["captureKeys"] as? Bool) ?? false,
            checkpointSeconds: max(0.5, min(num(json["checkpointSeconds"]) ?? 2, 2)),
            minFreeBytes: Int64(num(json["minFreeBytes"]) ?? 2_000_000_000),
            waitForStart: (json["waitForStart"] as? Bool) ?? false,
            maxDuration: num(json["maxDuration"]),
            synthetic: (json["synthetic"] as? Bool) ?? false)
    }
}

enum Bitrates {
    /// H.264 hardware encoding tops out at 4096×2304; the screen is scaled to fit inside it.
    static let maxScreenWidth = 4096
    static let maxScreenHeight = 2304
    static func screen(width: Int, height: Int, fps: Int) -> Int {
        Int(max(4_000_000, min(80_000_000, Double(width * height * fps) * 0.07)))
    }
    static func camera(width: Int, height: Int, fps: Double) -> Int {
        Int(max(3_000_000, min(25_000_000, Double(width * height) * fps * 0.12)))
    }
    static let microphone = 160_000
    static let system = 192_000
}

// MARK: - Session clock

/// Maps capture host-time stamps onto the shared session clock: zero at the first accepted
/// sample of the take, with paused intervals removed.
final class SessionClock {
    private let lock = NSLock()
    private var armedAt: Double?
    private var zero: Double?
    private var pauses: [(start: Double, end: Double?)] = []
    private var closedAt: Double?

    func arm(at host: Double) {
        lock.lock(); armedAt = host; lock.unlock()
    }

    /// Ends the take: samples stamped after `host` are dropped.
    func close(at host: Double) {
        lock.lock(); if closedAt == nil { closedAt = host }; lock.unlock()
    }

    var isArmed: Bool { lock.lock(); defer { lock.unlock() }; return armedAt != nil }
    var isPaused: Bool { lock.lock(); defer { lock.unlock() }; return pauses.last.map { $0.end == nil } ?? false }
    var hasZero: Bool { lock.lock(); defer { lock.unlock() }; return zero != nil }

    /// Session time for a sample stamped `host`, or nil when it must be dropped
    /// (before the take started, or inside a pause).
    func sessionTime(host: Double, establish: Bool) -> Double? {
        lock.lock(); defer { lock.unlock() }
        guard let armed = armedAt, host >= armed else { return nil }
        if let end = closedAt, host > end { return nil }
        if zero == nil {
            guard establish else { return nil }
            zero = host
        }
        guard let z = zero, host >= z else { return nil }
        var paused = 0.0
        for p in pauses {
            if let end = p.end {
                if host >= end { paused += end - p.start } else if host >= p.start { return nil }
            } else if host >= p.start {
                return nil
            }
        }
        return host - z - paused
    }

    /// Current position of the session clock (frozen while paused).
    func elapsed(host: Double) -> Double {
        lock.lock(); defer { lock.unlock() }
        guard let z = zero else { return 0 }
        var paused = 0.0
        var t = host
        for p in pauses {
            if let end = p.end { if host >= end { paused += end - p.start } else if host >= p.start { t = p.start } }
            else if host >= p.start { t = p.start }
        }
        return max(0, t - z - paused)
    }

    func pause(at host: Double) {
        lock.lock(); defer { lock.unlock() }
        if let last = pauses.last, last.end == nil { return }
        pauses.append((start: host, end: nil))
    }

    func resume(at host: Double) {
        lock.lock(); defer { lock.unlock() }
        guard let last = pauses.last, last.end == nil else { return }
        pauses[pauses.count - 1].end = max(host, last.start)
    }

    /// Pauses for the manifest: `at` in session time, `wallDuration` in real seconds.
    func pauseList(nowHost: Double) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        guard let z = zero else { return [] }
        var out: [[String: Any]] = []
        var paused = 0.0
        for p in pauses {
            let end = p.end ?? nowHost
            out.append(["at": r3(max(0, p.start - z - paused)), "wallDuration": r3(end - p.start)])
            paused += end - p.start
        }
        return out
    }
}

// MARK: - Per-source writer

final class SourceWriter {
    struct Gap { var start: Double; var end: Double?; var reason: String }

    let id: String
    let role: String
    let fileName: String
    let url: URL
    let isVideo: Bool
    var meta: [String: Any] = [:]

    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private let lock = NSLock()
    private var sessionStarted = false
    private var firstTime: Double?
    private var lastTime: Double?
    private var lastDuration: Double = 0
    private var frameCount = 0
    private var dropCount = 0
    private var gaps: [Gap] = []
    private var failure: String?
    private var finished = false
    private var rawFirst: Double?
    private var rawLastEnd: Double = 0
    private var audioSampleRate: Double = 0
    private var resyncNext = false
    private var endTime: Double?

    /// Call when the take resumes after a pause so the next audio buffer is re-aligned to the clock.
    func markDiscontinuity() { lock.lock(); resyncNext = true; lock.unlock() }

    init(id: String, role: String, fileName: String, dir: URL, mediaType: AVMediaType,
         outputSettings: [String: Any], fragmentSeconds: Double, nominalFrameDuration: Double = 0) throws {
        self.id = id
        self.role = role
        self.fileName = fileName
        self.url = dir.appendingPathComponent(fileName)
        self.isVideo = mediaType == .video
        self.lastDuration = nominalFrameDuration
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        // Movie fragments make the file playable up to the last flush if the process dies.
        writer.movieFragmentInterval = CMTime(seconds: fragmentSeconds, preferredTimescale: 600)
        writer.shouldOptimizeForNetworkUse = false
        input = AVAssetWriterInput(mediaType: mediaType, outputSettings: outputSettings)
        input.expectsMediaDataInRealTime = true
        if mediaType == .video { input.mediaTimeScale = 60000 }   // fine enough that close frames never share a tick
        guard writer.canAdd(input) else { throw CLIError("writer-failed", "Cannot configure the writer for \(id).") }
        writer.add(input)
        if mediaType == .video {
            adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        } else {
            adaptor = nil
        }
        guard writer.startWriting() else {
            throw CLIError("writer-failed", "Cannot start writing \(fileName): \(writer.error?.localizedDescription ?? "unknown")")
        }
    }

    private static func time(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 1_000_000) }

    /// Returns true when a previously lost source just produced data again.
    @discardableResult
    private func beginSample(at t: Double) -> (accept: Bool, restored: Bool) {
        // lock held by caller
        if failure != nil || finished { return (false, false) }
        if let last = lastTime, t - last < 0.002 { return (false, false) }   // out of order or a duplicate
        if writer.status != .writing {
            failure = writer.error?.localizedDescription ?? "writer stopped (status \(writer.status.rawValue))"
            return (false, false)
        }
        if !sessionStarted {
            writer.startSession(atSourceTime: Self.time(t))
            sessionStarted = true
            firstTime = t
        }
        var restored = false
        if let i = gaps.indices.last, gaps[i].end == nil {
            gaps[i].end = t
            restored = true
        }
        return (true, restored)
    }

    /// Appends a video frame at session time `t`. Returns (written, restoredFromGap).
    func appendVideo(_ pixelBuffer: CVPixelBuffer, at t: Double) -> (written: Bool, restored: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard let adaptor else { return (false, false) }
        guard input.isReadyForMoreMediaData else { dropCount += 1; return (false, false) }
        let (accept, restored) = beginSample(at: t)
        guard accept else { return (false, false) }
        if adaptor.append(pixelBuffer, withPresentationTime: Self.time(t)) {
            if let last = lastTime, !restored { lastDuration = min(1.0, t - last) }
            lastTime = t
            frameCount += 1
            return (true, restored)
        }
        failure = writer.error?.localizedDescription ?? "append failed"
        return (false, restored)
    }

    /// Appends an audio buffer whose first sample sits at session time `t`.
    ///
    /// AVAssetWriter packs encoded audio back to back and ignores gaps between buffer time stamps,
    /// so a sample's position in the file is simply the number of samples written before it. To keep
    /// the file on the session clock this method therefore (a) writes contiguously while capture
    /// jitter is small, (b) trims overlap sample-accurately and (c) fills real gaps with silence —
    /// after every pause and whenever the stream jumps by 100 ms or more (stall, reconnect).
    func appendAudio(_ sampleBuffer: CMSampleBuffer, at t: Double) -> (written: Bool, restored: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard input.isReadyForMoreMediaData else { dropCount += 1; return (false, false) }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0, let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee, asbd.mSampleRate > 0 else {
            return (false, false)
        }
        if failure != nil || finished { return (false, false) }
        if writer.status != .writing {
            failure = writer.error?.localizedDescription ?? "writer stopped (status \(writer.status.rawValue))"
            return (false, false)
        }
        let rate = asbd.mSampleRate
        var buffer = sampleBuffer
        var usable = frames

        if let first = firstTime {
            let expected = first + Double(frameCount) / rate      // where the next written sample lands
            let gap = t - expected
            if resyncNext || abs(gap) >= 0.1 {
                if gap < 0 {
                    let trim = Int((-gap * rate).rounded())
                    if trim >= frames { return (false, false) }     // entirely before audio already written
                    if trim > 0 {
                        var sliced: CMSampleBuffer?
                        guard CMSampleBufferCopySampleBufferForRange(
                            allocator: kCFAllocatorDefault, sampleBuffer: sampleBuffer,
                            sampleRange: CFRange(location: trim, length: frames - trim), sampleBufferOut: &sliced) == noErr,
                            let s = sliced else { return (false, false) }
                        buffer = s
                        usable = frames - trim
                    }
                } else {
                    var missing = Int((gap * rate).rounded())
                    while missing > 0 {
                        let n = min(missing, Int(rate))             // at most one second per buffer
                        guard let silence = Self.silence(frames: n, format: fd, asbd: asbd,
                                                         at: first + Double(frameCount) / rate) else { break }
                        var tries = 0
                        while !input.isReadyForMoreMediaData && tries < 200 { usleep(1000); tries += 1 }
                        guard input.append(silence) else {
                            failure = writer.error?.localizedDescription ?? "append failed"
                            return (false, false)
                        }
                        frameCount += n
                        missing -= n
                    }
                }
                resyncNext = false
            }
        }

        let start = firstTime.map { $0 + Double(frameCount) / rate } ?? t
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
            presentationTimeStamp: Self.time(start), decodeTimeStamp: .invalid)
        var retimed: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault, sampleBuffer: buffer, sampleTimingEntryCount: 1,
            sampleTimingArray: &timing, sampleBufferOut: &retimed) == noErr, let out = retimed else {
            return (false, false)
        }
        if !sessionStarted {
            writer.startSession(atSourceTime: Self.time(start))
            sessionStarted = true
            firstTime = start
        }
        var restored = false
        if let i = gaps.indices.last, gaps[i].end == nil {
            gaps[i].end = start
            restored = true
        }
        if rawFirst == nil { rawFirst = t }
        rawLastEnd = t + Double(frames) / rate
        audioSampleRate = rate
        if input.append(out) {
            frameCount += usable
            lastDuration = Double(usable) / rate
            lastTime = (firstTime ?? start) + Double(frameCount) / rate - lastDuration
            return (true, restored)
        }
        failure = writer.error?.localizedDescription ?? "append failed"
        return (false, restored)
    }

    private static func silence(frames: Int, format: CMAudioFormatDescription, asbd: AudioStreamBasicDescription, at t: Double) -> CMSampleBuffer? {
        let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let bytes = frames * Int(asbd.mBytesPerFrame) * (planar ? Int(asbd.mChannelsPerFrame) : 1)
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block) == noErr, let bb = block else { return nil }
        CMBlockBufferAssureBlockMemory(bb)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: bb, offsetIntoDestination: 0, dataLength: bytes)
        var out: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: bb, formatDescription: format, sampleCount: frames,
            presentationTimeStamp: time(t), packetDescriptions: nil, sampleBufferOut: &out) == noErr else { return nil }
        return out
    }

    /// Marks the source as producing nothing from session time `t` on. Returns false if already lost.
    func markLost(at t: Double, reason: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let last = gaps.last, last.end == nil { return false }
        gaps.append(Gap(start: max(t, 0), end: nil, reason: reason))
        return true
    }

    var isLost: Bool { lock.lock(); defer { lock.unlock() }; return gaps.last.map { $0.end == nil } ?? false }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return frameCount }
    var dropped: Int { lock.lock(); defer { lock.unlock() }; return dropCount }
    var lastSampleTime: Double? { lock.lock(); defer { lock.unlock() }; return lastTime }
    var hasStarted: Bool { lock.lock(); defer { lock.unlock() }; return sessionStarted }
    var failureMessage: String? { lock.lock(); defer { lock.unlock() }; return failure }
    func countDrop() { lock.lock(); dropCount += 1; lock.unlock() }

    /// Finalises the file. For video, `endAt` (session time the take stopped) makes the last frame
    /// last exactly until the stop, unless the source was lost before that.
    func finish(endAt: Double? = nil) async {
        guard let plan = beginFinish(endAt: endAt) else { return }
        input.markAsFinished()
        if plan.started, writer.status == .writing {
            if let stop = plan.stopTime { writer.endSession(atSourceTime: Self.time(stop)) }
            await writer.finishWriting()
        } else {
            writer.cancelWriting()
        }
    }

    private func beginFinish(endAt: Double?) -> (started: Bool, stopTime: Double?)? {
        lock.lock(); defer { lock.unlock() }
        if finished { return nil }
        finished = true
        if isVideo, sessionStarted, let end = endAt, let last = lastTime {
            let lostAtEnd = gaps.last.map { $0.end == nil } ?? false
            endTime = lostAtEnd ? last + min(lastDuration, 0.1) : max(end, last + 0.001)
        }
        return (sessionStarted, endTime)
    }

    func cancel() {
        lock.lock(); finished = true; lock.unlock()
        writer.cancelWriting()
        try? FileManager.default.removeItem(at: url)
    }

    /// The manifest entry as of now. `takeDuration` closes any gap that is still open.
    func manifestEntry(takeDuration: Double) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var d: [String: Any] = meta
        d["id"] = id
        d["role"] = role
        d["file"] = fileName
        let start = firstTime ?? 0
        d["start"] = r6(start)
        let end = endTime ?? ((lastTime ?? start) + (lastTime == nil ? 0 : lastDuration))
        d["duration"] = r6(max(0, end - start))
        d["gaps"] = gaps.map { g -> [String: Any] in
            ["start": r3(g.start), "end": r3(g.end ?? max(takeDuration, g.start)), "reason": g.reason]
        }
        if isVideo {
            d["frames"] = frameCount; d["droppedFrames"] = dropCount
        } else if let rf = rawFirst, audioSampleRate > 0, rawLastEnd - rf > 10, gaps.isEmpty {
            // Audio seconds written per session second; 1.0 means the device clock matches the host clock.
            d["measuredRate"] = r6((Double(frameCount) / audioSampleRate) / (rawLastEnd - rf))
        }
        if let f = failure { d["writerError"] = f }
        if !sessionStarted { d["empty"] = true }
        return d
    }
}

// MARK: - Audio level metering

final class LevelMeter {
    private let lock = NSLock()
    private var peak: Float = 0
    private var touched = false

    func ingest(_ sampleBuffer: CMSampleBuffer) {
        guard let fd = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee else { return }
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        var localPeak: Float = 0
        try? sampleBuffer.withAudioBufferList { list, _ in
            for buffer in list {
                guard let data = buffer.mData, buffer.mDataByteSize > 0 else { continue }
                if isFloat && asbd.mBitsPerChannel == 32 {
                    var m: Float = 0
                    vDSP_maxmgv(data.assumingMemoryBound(to: Float.self), 1, &m, vDSP_Length(Int(buffer.mDataByteSize) / 4))
                    localPeak = max(localPeak, m)
                } else if !isFloat && asbd.mBitsPerChannel == 16 {
                    let p = data.assumingMemoryBound(to: Int16.self)
                    let n = Int(buffer.mDataByteSize) / 2
                    var m: Int32 = 0
                    for i in 0..<n { m = max(m, abs(Int32(p[i]))) }
                    localPeak = max(localPeak, Float(m) / 32768)
                }
            }
        }
        lock.lock(); peak = max(peak, localPeak); touched = true; lock.unlock()
    }

    /// Peak dBFS since the last call, or nil when no audio arrived.
    func take() -> Double? {
        lock.lock(); defer { lock.unlock() }
        guard touched else { return nil }
        let p = peak
        peak = 0; touched = false
        return p <= 0.000_001 ? -120 : Double(max(-120, 20 * log10(p)))
    }
}
