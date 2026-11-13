import Foundation
import AVFoundation
import CoreMedia
import CoreVideo

// Synthetic capture sources for automated tests ("synthetic": true in the record config).
// They push generated frames and tones through exactly the same clock, writers, checkpoints
// and manifest code as real devices, so pause/resume, disconnect handling and crash recovery
// can be verified on machines without capture permission or hardware.

final class SyntheticVideoSource {
    let id: String
    let width: Int
    let height: Int
    let fps: Double
    var writer: SourceWriter?
    var preview: PreviewEmitter?
    private weak var sink: CaptureSink?
    private let queue: DispatchQueue
    private var timer: DispatchSourceTimer?
    private var pool: CVPixelBufferPool?
    private let color: (b: UInt8, g: UInt8, r: UInt8)
    private var lost = false
    private var stopped = false

    init(id: String, width: Int, height: Int, fps: Double, color: (UInt8, UInt8, UInt8), sink: CaptureSink) {
        self.id = id
        self.width = width
        self.height = height
        self.fps = fps
        self.color = (color.0, color.1, color.2)
        self.sink = sink
        self.queue = DispatchQueue(label: "cutaway.synthetic.\(id)", qos: .userInteractive)
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &pool)
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / fps, leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        stopped = true
        timer?.cancel()
        timer = nil
    }

    func setLost(_ value: Bool) { queue.async { self.lost = value } }

    private func tick() {
        guard !stopped, !lost, let sink, let writer, let pool else { return }
        let host = hostNow()
        guard let t = sink.clock.sessionTime(host: host, establish: true) else { return }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess, let pb = out else { return }
        CVPixelBufferLockBaseAddress(pb, [])
        if let base = CVPixelBufferGetBaseAddress(pb) {
            let stride = CVPixelBufferGetBytesPerRow(pb)
            // A bar sweeps left to right every two seconds of host time, identical in every source,
            // so cross-source alignment can be checked from the pictures alone.
            let phase = (host / 2).truncatingRemainder(dividingBy: 1)
            let barStart = Int(phase * Double(width - 40))
            var row = [UInt8](repeating: 255, count: stride)
            for x in 0..<width {
                let inBar = x >= barStart && x < barStart + 40
                row[x * 4] = inBar ? 255 : color.b
                row[x * 4 + 1] = inBar ? 255 : color.g
                row[x * 4 + 2] = inBar ? 255 : color.r
            }
            row.withUnsafeBytes { src in
                for y in 0..<height { memcpy(base + y * stride, src.baseAddress!, stride) }
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        preview?.offer(pb, hostNow: host)
        let res = writer.appendVideo(pb, at: t)
        if res.restored { sink.sourceRestored(id, at: t) }
    }
}

final class SyntheticAudioSource {
    let id: String
    let channels: Int
    var writer: SourceWriter?
    let meter = LevelMeter()
    private weak var sink: CaptureSink?
    private let queue: DispatchQueue
    private var timer: DispatchSourceTimer?
    private let frequency: Double
    private let establishes: Bool
    private var anchorHost = 0.0
    private var produced = 0
    private var format: CMAudioFormatDescription?
    private var lost = false
    private var stopped = false
    private let rate = 48000.0

    init(id: String, channels: Int, frequency: Double, establishes: Bool, sink: CaptureSink) {
        self.id = id
        self.channels = channels
        self.frequency = frequency
        self.establishes = establishes
        self.sink = sink
        self.queue = DispatchQueue(label: "cutaway.synthetic.\(id)", qos: .userInteractive)
        var asbd = AudioStreamBasicDescription(
            mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(4 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(4 * channels),
            mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    }

    func start() {
        anchorHost = hostNow()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(20), repeating: .milliseconds(20), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        stopped = true
        timer?.cancel()
        timer = nil
    }

    func setLost(_ value: Bool) { queue.async { self.lost = value } }

    private func tick() {
        guard !stopped, let sink, let format else { return }
        let target = Int((hostNow() - anchorHost) * rate)
        let n = target - produced
        guard n > 0 else { return }
        let startHost = anchorHost + Double(produced) / rate
        defer { produced = target }
        guard !lost else { return }

        // A 100 ms beep at the top of every host-clock second: a shared marker for sync tests.
        var samples = [Float](repeating: 0, count: n * channels)
        for i in 0..<n {
            let th = startHost + Double(i) / rate
            let inBeep = th.truncatingRemainder(dividingBy: 1) < 0.1
            let v = inBeep ? Float(sin(2 * Double.pi * frequency * th) * 0.5) : Float.random(in: -0.0008...0.0008)
            for c in 0..<channels { samples[i * channels + c] = v }
        }
        let bytes = samples.count * 4
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block) == noErr, let bb = block else { return }
        CMBlockBufferAssureBlockMemory(bb)
        samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: bytes) }
        var sb: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: bb, formatDescription: format, sampleCount: n,
            presentationTimeStamp: CMTime(seconds: startHost, preferredTimescale: 1_000_000_000),
            packetDescriptions: nil, sampleBufferOut: &sb) == noErr, let buffer = sb else { return }
        meter.ingest(buffer)
        guard let writer, let t = sink.clock.sessionTime(host: startHost, establish: establishes) else { return }
        let res = writer.appendAudio(buffer, at: t)
        if res.restored { sink.sourceRestored(id, at: t) }
    }
}
