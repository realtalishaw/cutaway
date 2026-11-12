import Foundation
import AVFoundation
import AppKit
import CoreMedia
import CoreGraphics

struct SourceError: Error {
    let code: String
    let message: String
    let source: String?
}

private func sourced<T>(_ source: String, _ body: () throws -> T) throws -> T {
    do { return try body() } catch let e as CLIError { throw SourceError(code: e.code, message: e.message, source: source) }
}

private func sourcedAsync<T>(_ source: String, _ body: () async throws -> T) async throws -> T {
    do { return try await body() } catch let e as CLIError { throw SourceError(code: e.code, message: e.message, source: source) }
}

/// Asks for camera/microphone access when it was never decided; never waits forever on a prompt.
private func ensureMediaAccess(_ type: AVMediaType, source: String, label: String) async throws {
    switch AVCaptureDevice.authorizationStatus(for: type) {
    case .authorized:
        return
    case .notDetermined:
        let granted = (try? await withTimeout(seconds: 60) { await AVCaptureDevice.requestAccess(for: type) }) ?? false
        if !granted {
            throw SourceError(code: "permission-denied", message: "\(label) permission was not granted. Enable it in System Settings › Privacy & Security › \(label).", source: source)
        }
    default:
        throw SourceError(code: "permission-denied", message: "\(label) permission is denied. Enable it in System Settings › Privacy & Security › \(label).", source: source)
    }
}

final class Recorder: CaptureSink {
    enum Phase { case idle, preparing, ready, recording, paused, stopping, stopped }

    let config: RecordConfig
    let clock = SessionClock()

    private var writers: [SourceWriter] = []
    private var screen: ScreenSource?
    private var cameras: [CameraSource] = []
    private var microphone: MicrophoneSource?
    private var cursor: CursorTracker?
    private var syntheticVideo: [SyntheticVideoSource] = []
    private var syntheticAudio: [SyntheticAudioSource] = []
    private var silentMicTicks = 0
    private var reportedSilentMic = false

    private let control = DispatchQueue(label: "cutaway.recorder.control")
    private var phase: Phase = .idle
    private var pendingStop: String?
    private var startedAt: Date?
    private var timer: DispatchSourceTimer?
    private var tickCount = 0
    private var lastCheckpoint = 0.0
    private var reportedWriterFailures = Set<String>()
    private var startHost = 0.0

    init(config: RecordConfig) {
        self.config = config
    }

    private var takeId: String { config.outDir.lastPathComponent }
    private var manifestURL: URL { config.outDir.appendingPathComponent("manifest.json") }

    // MARK: Prepare

    func prepare() async throws {
        control.sync { phase = .preparing }
        guard config.screen != nil || !config.cameras.isEmpty || config.microphone != nil || config.systemAudio else {
            throw SourceError(code: "bad-config", message: "At least one source (screen, camera, microphone or system audio) is required.", source: nil)
        }
        do {
            try FileManager.default.createDirectory(at: config.outDir, withIntermediateDirectories: true)
        } catch {
            throw SourceError(code: "io", message: "Cannot create \(config.outDir.path): \(error.localizedDescription)", source: nil)
        }
        let free = freeBytes(at: config.outDir)
        if free < config.minFreeBytes {
            throw SourceError(code: "low-disk", message: "Only \(free / 1_000_000) MB free; at least \(config.minFreeBytes / 1_000_000) MB is needed to record safely.", source: nil)
        }

        if config.synthetic {
            try prepareSynthetic()
            writeManifest(complete: false, duration: 0, nowHost: hostNow())
            let stopNow: String? = control.sync {
                if let p = pendingStop { return p }
                phase = .ready
                return nil
            }
            Out.emit(["type": "ready"])
            if stopNow != nil { await finish(reason: "cancel") } else if !config.waitForStart { start() }
            return
        }

        // Cameras
        var seen = Set<String>()
        var slots = Set<String>()
        for cam in config.cameras {
            guard seen.insert(cam.deviceId).inserted else {
                throw SourceError(code: "duplicate-camera", message: "The same camera is assigned to two slots. Choose a different device for camera \(cam.slot).", source: cam.sourceId)
            }
            guard slots.insert(cam.slot).inserted, ["A", "B"].contains(cam.slot) else {
                throw SourceError(code: "bad-config", message: "Camera slots must be A and B, each used once.", source: cam.sourceId)
            }
        }
        if !config.cameras.isEmpty {
            try await ensureMediaAccess(.video, source: config.cameras[0].sourceId, label: "Camera")
        }
        if config.microphone != nil {
            try await ensureMediaAccess(.audio, source: "microphone", label: "Microphone")
        }
        let fragment = config.checkpointSeconds

        // Screen and system audio
        if config.screen != nil || config.systemAudio {
            let s = ScreenSource(config: config, sink: self)
            try await sourcedAsync(config.screen != nil ? "screen" : "system") { try await s.prepare() }
            if config.screen != nil {
                // Always H.264 High: the editor decodes these files inside Chromium.
                let compression: [String: Any] = [
                    AVVideoAverageBitRateKey: Bitrates.screen(width: s.pixelWidth, height: s.pixelHeight, fps: config.fps),
                    AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                    AVVideoAllowFrameReorderingKey: false,
                    AVVideoExpectedSourceFrameRateKey: config.fps,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ]
                let settings: [String: Any] = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: s.pixelWidth,
                    AVVideoHeightKey: s.pixelHeight,
                    AVVideoCompressionPropertiesKey: compression,
                    AVVideoColorPropertiesKey: [
                        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
                    ],
                ]
                let w = try sourced("screen") {
                    try SourceWriter(id: "screen", role: "screen", fileName: "screen.mov", dir: config.outDir, mediaType: .video,
                                     outputSettings: settings, fragmentSeconds: fragment, nominalFrameDuration: 1.0 / Double(max(1, config.fps)))
                }
                w.meta = [
                    "width": s.pixelWidth, "height": s.pixelHeight,
                    "pointWidth": Int(s.captureRect.width.rounded()), "pointHeight": Int(s.captureRect.height.rounded()),
                    "originX": Int(s.captureRect.minX.rounded()), "originY": Int(s.captureRect.minY.rounded()),
                    "scale": s.scale,
                    "fps": config.fps, "codec": "avc1",
                    "captureType": config.screen?.type ?? "display",
                    "cursorBaked": config.screen?.showCursor ?? false,
                ]
                s.videoWriter = w
                writers.append(w)
            }
            screen = s
        }

        for cam in config.cameras {
            guard let device = DeviceCatalog.cameras().first(where: { $0.uniqueID == cam.deviceId }) ?? AVCaptureDevice(uniqueID: cam.deviceId) else {
                throw SourceError(code: "missing-device", message: "Camera \(cam.slot) is not connected.", source: cam.sourceId)
            }
            let source = CameraSource(camera: cam, device: device, sink: self)
            try sourced(cam.sourceId) { try source.prepare() }
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: source.width,
                AVVideoHeightKey: source.height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: Bitrates.camera(width: source.width, height: source.height, fps: source.fps),
                    AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                    AVVideoAllowFrameReorderingKey: false,
                    AVVideoExpectedSourceFrameRateKey: Int(source.fps.rounded()),
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ] as [String: Any],
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
                ],
            ]
            let w = try sourced(cam.sourceId) {
                try SourceWriter(id: cam.sourceId, role: cam.sourceId, fileName: cam.fileName, dir: config.outDir, mediaType: .video,
                                 outputSettings: settings, fragmentSeconds: fragment, nominalFrameDuration: 1.0 / max(1, source.fps))
            }
            w.meta = ["width": source.width, "height": source.height, "fps": r3(source.fps), "codec": "avc1",
                      "deviceName": source.deviceName, "deviceId": cam.deviceId]
            source.writer = w
            writers.append(w)
            cameras.append(source)
        }

        if let micCfg = config.microphone {
            let device: AVCaptureDevice?
            if let id = micCfg.deviceId, !id.isEmpty {
                device = DeviceCatalog.microphones().first(where: { $0.uniqueID == id }) ?? AVCaptureDevice(uniqueID: id)
            } else {
                device = AVCaptureDevice.default(for: .audio)
            }
            guard let device else {
                throw SourceError(code: "missing-device", message: "The selected microphone is not connected.", source: "microphone")
            }
            let onlySource = config.screen == nil && config.cameras.isEmpty
            let mic = MicrophoneSource(device: device, sink: self, establishes: onlySource)
            try sourced("microphone") { try mic.prepare() }
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: mic.channels,
                AVEncoderBitRateKey: Bitrates.microphone,
            ]
            let w = try sourced("microphone") {
                try SourceWriter(id: "microphone", role: "voice", fileName: "mic.mov", dir: config.outDir, mediaType: .audio,
                                 outputSettings: settings, fragmentSeconds: fragment)
            }
            w.meta = ["channels": mic.channels, "sampleRate": 48000, "codec": "aac ", "deviceName": mic.deviceName, "deviceId": device.uniqueID]
            mic.writer = w
            writers.append(w)
            microphone = mic
        }

        if config.systemAudio, let s = screen {
            var layout = AudioChannelLayout()
            layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: Bitrates.system,
                AVChannelLayoutKey: Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size),
            ]
            let w = try sourced("system") {
                try SourceWriter(id: "system", role: "systemAudio", fileName: "system.mov", dir: config.outDir, mediaType: .audio,
                                 outputSettings: settings, fragmentSeconds: fragment)
            }
            w.meta = ["channels": 2, "sampleRate": 48000, "codec": "aac "]
            s.audioWriter = w
            writers.append(w)
        }

        if config.screen != nil, let s = screen {
            cursor = CursorTracker(url: config.outDir.appendingPathComponent("cursor.jsonl"), clock: clock) { [weak s] in
                s?.captureRect ?? .zero
            }
        }

        if let s = screen {
            try await sourcedAsync(config.screen != nil ? "screen" : "system") { try await s.start() }
        }
        writeManifest(complete: false, duration: 0, nowHost: hostNow())

        let stopNow: String? = control.sync {
            if let p = pendingStop { return p }
            phase = .ready
            return nil
        }
        Out.emit(["type": "ready"])
        if stopNow != nil {
            await finish(reason: "cancel")
        } else if !config.waitForStart {
            start()
        }
    }

    private func h264Settings(width: Int, height: Int, fps: Double, bitrate: Int) -> [String: Any] {
        [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
    }

    /// Test mode: generated pictures and tones instead of devices, same pipeline otherwise.
    private func prepareSynthetic() throws {
        let fragment = config.checkpointSeconds
        var seen = Set<String>()
        for cam in config.cameras {
            guard seen.insert(cam.deviceId).inserted else {
                throw SourceError(code: "duplicate-camera", message: "The same camera is assigned to two slots. Choose a different device for camera \(cam.slot).", source: cam.sourceId)
            }
        }
        if let sc = config.screen {
            let w = max(64, (Int(sc.rect?.width ?? 1920) / 2) * 2), h = max(64, (Int(sc.rect?.height ?? 1080) / 2) * 2)
            let writer = try sourced("screen") {
                try SourceWriter(id: "screen", role: "screen", fileName: "screen.mov", dir: config.outDir, mediaType: .video,
                                 outputSettings: h264Settings(width: w, height: h, fps: Double(config.fps), bitrate: Bitrates.screen(width: w, height: h, fps: config.fps)),
                                 fragmentSeconds: fragment, nominalFrameDuration: 1.0 / Double(max(1, config.fps)))
            }
            writer.meta = ["width": w, "height": h, "pointWidth": w, "pointHeight": h, "originX": 0, "originY": 0, "scale": 1,
                           "fps": config.fps, "codec": "avc1", "captureType": sc.type, "cursorBaked": sc.showCursor, "synthetic": true]
            let src = SyntheticVideoSource(id: "screen", width: w, height: h, fps: Double(config.fps), color: (120, 60, 30), sink: self)
            src.writer = writer
            writers.append(writer)
            syntheticVideo.append(src)
            let rect = CGDisplayBounds(CGMainDisplayID())
            cursor = CursorTracker(url: config.outDir.appendingPathComponent("cursor.jsonl"), clock: clock) { rect }
        }
        for cam in config.cameras {
            let w = cam.width ?? 1280, h = cam.height ?? 720, fps = cam.fps ?? 30
            let writer = try sourced(cam.sourceId) {
                try SourceWriter(id: cam.sourceId, role: cam.sourceId, fileName: cam.fileName, dir: config.outDir, mediaType: .video,
                                 outputSettings: h264Settings(width: w, height: h, fps: fps, bitrate: Bitrates.camera(width: w, height: h, fps: fps)),
                                 fragmentSeconds: fragment, nominalFrameDuration: 1.0 / max(1, fps))
            }
            writer.meta = ["width": w, "height": h, "fps": r3(fps), "codec": "avc1", "deviceName": "Synthetic camera \(cam.slot)", "deviceId": cam.deviceId, "synthetic": true]
            let src = SyntheticVideoSource(id: cam.sourceId, width: w, height: h, fps: fps, color: cam.slot == "A" ? (40, 110, 40) : (40, 40, 140), sink: self)
            src.writer = writer
            writers.append(writer)
            syntheticVideo.append(src)
        }
        func audio(_ id: String, role: String, file: String, channels: Int, frequency: Double, bitrate: Int, establishes: Bool) throws {
            var settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: bitrate,
            ]
            if channels == 2 {
                var layout = AudioChannelLayout()
                layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
                settings[AVChannelLayoutKey] = Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size)
            }
            let writer = try sourced(id) {
                try SourceWriter(id: id, role: role, fileName: file, dir: config.outDir, mediaType: .audio, outputSettings: settings, fragmentSeconds: fragment)
            }
            writer.meta = ["channels": channels, "sampleRate": 48000, "codec": "aac ", "synthetic": true]
            let src = SyntheticAudioSource(id: id, channels: channels, frequency: frequency, establishes: establishes, sink: self)
            src.writer = writer
            writers.append(writer)
            syntheticAudio.append(src)
        }
        let audioOnly = syntheticVideo.isEmpty
        if config.microphone != nil {
            try audio("microphone", role: "voice", file: "mic.mov", channels: 1, frequency: 1000, bitrate: Bitrates.microphone, establishes: audioOnly)
        }
        if config.systemAudio {
            try audio("system", role: "systemAudio", file: "system.mov", channels: 2, frequency: 440, bitrate: Bitrates.system,
                      establishes: audioOnly && config.microphone == nil)
        }
        syntheticVideo.forEach { $0.start() }
        syntheticAudio.forEach { $0.start() }
    }

    /// Test hook (synthetic mode only): make a source stop or resume delivering, like an unplugged camera.
    func simulate(lost: Bool, source id: String) {
        guard config.synthetic else { return }
        syntheticVideo.first { $0.id == id }?.setLost(lost)
        syntheticAudio.first { $0.id == id }?.setLost(lost)
        if lost { sourceLost(id, reason: "disconnected") }
    }

    // MARK: Control

    func start() {
        control.async { [self] in
            guard phase == .ready else { return }
            phase = .recording
            startedAt = Date()
            startHost = hostNow()
            clock.arm(at: startHost)
            Out.emit([
                "type": "started", "at": isoString(startedAt!),
                "sources": writers.map { ["id": $0.id, "file": $0.fileName] },
            ])
            cursor?.start()
            let t = DispatchSource.makeTimerSource(queue: control)
            t.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50), leeway: .milliseconds(5))
            t.setEventHandler { [weak self] in self?.onTimer() }
            t.resume()
            timer = t
        }
    }

    func pause() {
        control.async { [self] in
            guard phase == .recording else { return }
            let now = hostNow()
            clock.pause(at: now)
            phase = .paused
            Out.emit(["type": "paused", "elapsed": r3(clock.elapsed(host: now))])
        }
    }

    func resume() {
        control.async { [self] in
            guard phase == .paused else { return }
            let now = hostNow()
            clock.resume(at: now)
            writers.filter { !$0.isVideo }.forEach { $0.markDiscontinuity() }
            phase = .recording
            Out.emit(["type": "resumed", "elapsed": r3(clock.elapsed(host: now))])
        }
    }

    /// Stops and finalises (`stop`), or discards the take (`cancel`). Safe to call from any thread, any number of times.
    func requestStop(reason: String) {
        let go: Bool = control.sync {
            switch phase {
            case .recording, .paused, .ready:
                phase = .stopping
                return true
            case .idle, .preparing:
                pendingStop = reason
                return false
            case .stopping, .stopped:
                return false
            }
        }
        if go { Task.detached { await self.finish(reason: reason) } }
    }

    private func finish(reason: String) async {
        let stopHost = hostNow()
        control.sync {
            phase = .stopping
            timer?.cancel()
            timer = nil
        }
        let neverStarted = !clock.isArmed
        let cancelled = reason == "cancel" || neverStarted

        clock.close(at: stopHost)
        let duration = clock.elapsed(host: stopHost)

        await screen?.stop()
        syntheticVideo.forEach { $0.stop() }
        syntheticAudio.forEach { $0.stop() }
        cameras.forEach { $0.stop() }
        microphone?.stop()
        cursor?.stop()

        if cancelled {
            writers.forEach { $0.cancel() }
            try? FileManager.default.removeItem(at: config.outDir.appendingPathComponent("cursor.jsonl"))
            try? FileManager.default.removeItem(at: manifestURL)
            if let rest = try? FileManager.default.contentsOfDirectory(atPath: config.outDir.path), rest.isEmpty {
                try? FileManager.default.removeItem(at: config.outDir)
            }
            Out.emit(["type": "stopped", "cancelled": true, "manifest": NSNull()])
            control.sync { phase = .stopped }
            exit(0)
        }

        await withTaskGroup(of: Void.self) { group in
            for w in writers { group.addTask { await w.finish(endAt: duration) } }
        }
        let manifest = writeManifest(complete: true, duration: duration, nowHost: stopHost, stopReason: reason)
        Out.emit(["type": "stopped", "manifest": manifest])
        control.sync { phase = .stopped }
        exit(0)
    }

    // MARK: Periodic work (control queue, 20 Hz)

    private func onTimer() {
        guard phase == .recording || phase == .paused else { return }
        tickCount += 1
        let now = hostNow()
        let elapsed = clock.elapsed(host: now)

        if tickCount % 2 == 0 {
            var levels: [String: Any] = ["type": "levels"]
            let micLevel = microphone?.meter.take() ?? syntheticAudio.first { $0.id == "microphone" }?.meter.take()
            if let m = micLevel {
                levels["microphone"] = r3(m)
                // Digital silence for 3 s usually means a muted input, a closed lid or a blocked permission.
                silentMicTicks = m <= -119 ? silentMicTicks + 1 : 0
                if silentMicTicks >= 30, !reportedSilentMic, phase == .recording {
                    reportedSilentMic = true
                    Out.emit(["type": "error", "code": "microphone-silent", "source": "microphone", "fatal": false,
                              "message": "The microphone is delivering pure silence. Check that it is not muted, that the laptop lid is open, and that Microphone permission is granted."])
                }
            }
            if config.systemAudio {
                if let s = screen?.systemMeter.take() ?? syntheticAudio.first(where: { $0.id == "system" })?.meter.take() { levels["system"] = r3(s) }
            }
            if levels.count > 1 { Out.emit(levels) }
        }

        if tickCount % 5 == 0 {
            var frames: [String: Any] = [:]
            var dropped: [String: Any] = [:]
            for w in writers where w.isVideo {
                frames[w.id] = w.frames
                dropped[w.id] = w.dropped
            }
            Out.emit(["type": "tick", "elapsed": r3(elapsed), "frames": frames, "dropped": dropped,
                      "freeBytes": freeBytes(at: config.outDir), "paused": phase == .paused])
        }

        if tickCount % 10 == 0 {
            housekeeping(now: now, elapsed: elapsed)
        }

        if phase == .recording, elapsed - lastCheckpoint >= config.checkpointSeconds {
            lastCheckpoint = elapsed
            cursor?.checkpoint()
            writeManifest(complete: false, duration: elapsed, nowHost: now)
            Out.emit(["type": "checkpoint", "elapsed": r3(elapsed)])
        }

        if let limit = config.maxDuration, elapsed >= limit {
            requestStopFromControl(reason: "max-duration")
        }
    }

    private func requestStopFromControl(reason: String) {
        guard phase == .recording || phase == .paused else { return }
        phase = .stopping
        Task.detached { await self.finish(reason: reason) }
    }

    private func housekeeping(now: Double, elapsed: Double) {
        screen?.refreshWindowFrame()
        if phase == .recording {
            screen?.keepAlive(hostNow: now, idleFor: 0.5)
            // Sources that stopped delivering without telling us.
            for w in writers where !w.isLost {
                if w.id == "screen" || w.id == "system" { continue }   // screen idles legitimately; system audio can be silent
                if let last = w.lastSampleTime {
                    if elapsed - last > 2.0, w.markLost(at: last, reason: "stalled") {
                        Out.emit(["type": "source-lost", "source": w.id, "elapsed": r3(last), "reason": "stalled"])
                    }
                } else if clock.hasZero, elapsed > 3.0, w.markLost(at: 0, reason: "no-data") {
                    Out.emit(["type": "source-lost", "source": w.id, "elapsed": 0, "reason": "no-data"])
                }
            }
        }
        for w in writers {
            if let failure = w.failureMessage, reportedWriterFailures.insert(w.id).inserted {
                Out.emit(["type": "error", "code": "writer-failed", "message": "\(w.fileName): \(failure)", "source": w.id, "fatal": false])
                if w.markLost(at: w.lastSampleTime ?? elapsed, reason: "writer-failed") {
                    Out.emit(["type": "source-lost", "source": w.id, "elapsed": r3(w.lastSampleTime ?? elapsed), "reason": "writer-failed"])
                }
            }
        }
        let free = freeBytes(at: config.outDir)
        if free < config.minFreeBytes {
            Out.emit(["type": "disk-low", "freeBytes": free])
            requestStopFromControl(reason: "disk-low")
        }
    }

    // MARK: CaptureSink

    func sourceRestored(_ id: String, at t: Double) {
        Out.emit(["type": "source-restored", "source": id, "elapsed": r3(t)])
    }

    func sourceLost(_ id: String, reason: String) {
        guard let w = writers.first(where: { $0.id == id }) else { return }
        guard clock.isArmed else { return }
        let t = w.lastSampleTime ?? clock.elapsed(host: hostNow())
        if w.markLost(at: t, reason: reason) {
            Out.emit(["type": "source-lost", "source": id, "elapsed": r3(t), "reason": reason])
        }
    }

    func nonFatal(_ code: String, _ message: String, source: String?) {
        var e: [String: Any] = ["type": "error", "code": code, "message": message, "fatal": false]
        if let source { e["source"] = source }
        Out.emit(e)
    }

    // MARK: Manifest

    @discardableResult
    private func writeManifest(complete: Bool, duration: Double, nowHost: Double, stopReason: String? = nil) -> [String: Any] {
        var m: [String: Any] = [
            "version": 1,
            "takeId": takeId,
            "startedAt": isoString(startedAt ?? Date()),
            "duration": r3(duration),
            "fps": config.fps,
            "complete": complete,
            "recovered": false,
            "pauses": clock.pauseList(nowHost: nowHost),
            "sources": writers.map { $0.manifestEntry(takeDuration: duration) },
            "cursor": cursor.map { ["file": "cursor.jsonl", "samples": $0.samples] as [String: Any] } as Any? ?? NSNull(),
        ]
        if let stopReason, stopReason != "stop" { m["stopReason"] = stopReason }
        if let data = try? JSONSerialization.data(withJSONObject: Out.tidy(m), options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            try? data.write(to: manifestURL, options: .atomic)
        }
        return m
    }
}

// MARK: - record command

enum RecordCommand {
    private static var signalSources: [DispatchSourceSignal] = []

    static func run(_ a: Args) -> Never {
        var config: RecordConfig
        do {
            config = try RecordConfig.load(path: try a.require("config"))
        } catch let e as CLIError {
            Out.emit(["type": "error", "code": e.code, "message": e.message, "fatal": true])
            exit(1)
        } catch {
            Out.emit(["type": "error", "code": "bad-config", "message": String(describing: error), "fatal": true])
            exit(1)
        }
        if let d = a.double("duration") { config.maxDuration = d }

        // A window-server connection is needed to read the current cursor image.
        _ = NSApplication.shared

        let recorder = Recorder(config: config)
        let outDir = config.outDir
        func removeIfEmpty() {
            try? FileManager.default.removeItem(at: outDir.appendingPathComponent("manifest.json"))
            if let rest = try? FileManager.default.contentsOfDirectory(atPath: outDir.path), rest.isEmpty {
                try? FileManager.default.removeItem(at: outDir)
            }
        }
        Task.detached {
            do {
                try await recorder.prepare()
            } catch let e as SourceError {
                removeIfEmpty()
                var event: [String: Any] = ["type": "error", "code": e.code, "message": e.message, "fatal": true]
                if let s = e.source { event["source"] = s }
                Out.emit(event)
                exit(1)
            } catch let e as CLIError {
                removeIfEmpty()
                Out.emit(["type": "error", "code": e.code, "message": e.message, "fatal": true])
                exit(1)
            } catch {
                removeIfEmpty()
                Out.emit(["type": "error", "code": "internal", "message": String(describing: error), "fatal": true])
                exit(1)
            }
        }

        let hasDeadline = config.maxDuration != nil
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                switch line.trimmingCharacters(in: .whitespaces).lowercased() {
                case "start": recorder.start()
                case "pause": recorder.pause()
                case "resume": recorder.resume()
                case "stop": recorder.requestStop(reason: "stop")
                case "cancel": recorder.requestStop(reason: "cancel")
                case "": break
                case let cmd where cmd.hasPrefix("simulate-lost "):
                    recorder.simulate(lost: true, source: String(line.trimmingCharacters(in: .whitespaces).dropFirst("simulate-lost ".count)))
                case let cmd where cmd.hasPrefix("simulate-restore "):
                    recorder.simulate(lost: false, source: String(line.trimmingCharacters(in: .whitespaces).dropFirst("simulate-restore ".count)))
                default: Out.log("unknown control command: \(line)")
                }
            }
            // The parent went away. Finalise what we have unless a fixed duration was requested.
            if !hasDeadline { recorder.requestStop(reason: "stdin-closed") }
        }

        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global())
            src.setEventHandler { recorder.requestStop(reason: "signal") }
            src.resume()
            signalSources.append(src)
        }

        RunLoop.main.run()
        exit(0)
    }
}

// MARK: - preflight

enum PreflightCommand {
    static func run(configPath: String) async throws -> Any {
        let config = try RecordConfig.load(path: configPath)
        var issues: [[String: Any]] = []
        func issue(_ code: String, _ source: String?, _ message: String, alternatives: [String] = []) {
            var d: [String: Any] = ["code": code, "message": message, "alternatives": alternatives]
            d["source"] = source ?? NSNull()
            issues.append(d)
        }
        var bitsPerSecond = 0

        if config.screen == nil && config.cameras.isEmpty && config.microphone == nil && !config.systemAudio {
            issue("no-sources", nil, "Choose at least one source to record.")
        }

        if config.screen != nil || config.systemAudio {
            let source = config.screen != nil ? "screen" : "system"
            if !CGPreflightScreenCaptureAccess() {
                issue("permission-denied", source, "Screen Recording permission is not granted. Enable it in System Settings › Privacy & Security › Screen & System Audio Recording, or record without the screen\(config.systemAudio ? " and system audio" : "").")
            }
        }
        if let s = config.screen {
            let displays = DeviceCatalog.displays()
            var points = CGSize(width: 1920, height: 1080)
            var scale = 2.0
            switch s.type {
            case "window":
                if let wid = s.windowId,
                   let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]],
                   let b = info.first?[kCGWindowBounds as String] as? [String: Any],
                   let rect = CGRect(dictionaryRepresentation: b as CFDictionary) {
                    points = rect.size
                } else {
                    issue("missing-device", "screen", "The selected window is no longer open. Choose another window or a display.")
                }
            case "region":
                if let rect = s.rect, rect.width >= 16, rect.height >= 16 {
                    points = rect.size
                    let inside = displays.contains { d in
                        let frame = CGRect(x: d["x"] as! Int, y: d["y"] as! Int, width: d["width"] as! Int, height: d["height"] as! Int)
                        return frame.contains(CGPoint(x: rect.midX, y: rect.midY))
                    }
                    if !inside { issue("unsupported-format", "screen", "The selected region is outside every display.") }
                } else {
                    issue("unsupported-format", "screen", "A region must be at least 16×16 points.")
                }
            default:
                if let id = s.displayId {
                    if let d = displays.first(where: { ($0["id"] as? Int) == Int(id) }) {
                        points = CGSize(width: d["width"] as! Int, height: d["height"] as! Int)
                        scale = d["scale"] as? Double ?? 2
                    } else {
                        issue("missing-device", "screen", "The selected display is not connected.", alternatives: displays.compactMap { $0["name"] as? String })
                    }
                } else if let d = displays.first(where: { $0["main"] as? Bool == true }) {
                    points = CGSize(width: d["width"] as! Int, height: d["height"] as! Int)
                    scale = d["scale"] as? Double ?? 2
                }
            }
            var w = Double(points.width) * scale, h = Double(points.height) * scale
            let maxH = Double(min(Bitrates.maxScreenHeight, max(360, s.maxHeight)))
            if h > maxH { w = w * maxH / h; h = maxH }
            if w > Double(Bitrates.maxScreenWidth) { h = h * Double(Bitrates.maxScreenWidth) / w; w = Double(Bitrates.maxScreenWidth) }
            bitsPerSecond += Bitrates.screen(width: Int(w), height: Int(h), fps: config.fps)
        }

        if config.cameras.count > 2 {
            issue("multicam-unsupported", nil, "Cutaway records at most two cameras at once (A and B).")
        }
        let cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
        if !config.cameras.isEmpty, cameraStatus == .denied || cameraStatus == .restricted {
            issue("permission-denied", config.cameras[0].sourceId, "Camera permission is denied. Enable it in System Settings › Privacy & Security › Camera, or record without a camera.")
        }
        let available = DeviceCatalog.cameras()
        var seenDevices: [String: String] = [:]
        var seenSlots = Set<String>()
        for cam in config.cameras {
            if !["A", "B"].contains(cam.slot) || !seenSlots.insert(cam.slot).inserted {
                issue("multicam-unsupported", cam.sourceId, "Camera slots must be A and B, each used once.")
            }
            if let other = seenDevices[cam.deviceId] {
                let others = available.filter { $0.uniqueID != cam.deviceId }.map(\.localizedName)
                issue("duplicate-camera", cam.sourceId,
                      "This camera is already assigned to camera \(other). Choose a different device for camera \(cam.slot)\(others.isEmpty ? " — no other camera is connected" : "").",
                      alternatives: others)
                continue
            }
            seenDevices[cam.deviceId] = cam.slot
            guard let device = available.first(where: { $0.uniqueID == cam.deviceId }) else {
                issue("missing-device", cam.sourceId, "Camera \(cam.slot) is not connected.", alternatives: available.map(\.localizedName))
                continue
            }
            if device.isSuspended {
                issue("missing-device", cam.sourceId, "\(device.localizedName) is suspended (for example, the laptop lid is closed).")
            }
            if let choice = CameraSource.chooseFormat(device: device, width: cam.width, height: cam.height, fps: cam.fps) {
                let d = CMVideoFormatDescriptionGetDimensions(choice.format.formatDescription)
                bitsPerSecond += Bitrates.camera(width: Int(d.width), height: Int(d.height), fps: choice.fps)
            } else {
                let alts = DeviceCatalog.formats(of: device).prefix(6).map { "\($0.width)x\($0.height)@\(Int($0.maxFps.rounded()))" }
                issue("unsupported-format", cam.sourceId,
                      "\(device.localizedName) cannot record \(cam.width ?? 0)x\(cam.height ?? 0) at \(Int((cam.fps ?? 30).rounded())) fps.",
                      alternatives: Array(alts))
            }
        }

        if let mic = config.microphone {
            let status = AVCaptureDevice.authorizationStatus(for: .audio)
            if status == .denied || status == .restricted {
                issue("permission-denied", "microphone", "Microphone permission is denied. Enable it in System Settings › Privacy & Security › Microphone, or record without a microphone.")
            }
            let mics = DeviceCatalog.microphones()
            if let id = mic.deviceId, !id.isEmpty, !mics.contains(where: { $0.uniqueID == id }) {
                issue("missing-device", "microphone", "The selected microphone is not connected.", alternatives: mics.map(\.localizedName))
            } else if mics.isEmpty {
                issue("missing-device", "microphone", "No microphone is connected.")
            }
            bitsPerSecond += Bitrates.microphone
        }
        if config.systemAudio { bitsPerSecond += Bitrates.system }

        let free = freeBytes(at: config.outDir)
        if free < config.minFreeBytes {
            issue("low-disk", nil, "Only \(free / 1_000_000) MB free on the destination disk; at least \(config.minFreeBytes / 1_000_000) MB is needed to record safely.")
        }
        return [
            "ok": issues.isEmpty,
            "issues": issues,
            "estimatedBytesPerMinute": bitsPerSecond / 8 * 60,
            "freeBytes": free,
        ]
    }
}

// MARK: - recover

enum RecoverCommand {
    private static let known: [(file: String, id: String, role: String, video: Bool)] = [
        ("screen.mov", "screen", "screen", true),
        ("camera-a.mov", "cameraA", "cameraA", true),
        ("camera-b.mov", "cameraB", "cameraB", true),
        ("mic.mov", "microphone", "voice", false),
        ("system.mov", "system", "systemAudio", false),
    ]

    static func run(_ a: Args) async throws -> Any {
        guard let path = a.positional.first else { throw CLIError("usage", "recover <takeDir>") }
        let dir = URL(fileURLWithPath: path)
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
            throw CLIError("not-found", "No take directory at \(path)")
        }
        let manifestURL = dir.appendingPathComponent("manifest.json")
        var manifest: [String: Any] = [:]
        if let data = fm.contents(atPath: manifestURL.path),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            manifest = json
        }
        if manifest["complete"] as? Bool == true { return manifest }

        if manifest.isEmpty {
            let created = ((try? fm.attributesOfItem(atPath: dir.path))?[.creationDate] as? Date) ?? Date()
            manifest = ["version": 1, "takeId": dir.lastPathComponent, "startedAt": isoString(created), "fps": 0, "pauses": []]
        }
        var sources = (manifest["sources"] as? [[String: Any]]) ?? []
        for k in known where fm.fileExists(atPath: dir.appendingPathComponent(k.file).path) {
            if !sources.contains(where: { ($0["file"] as? String) == k.file }) {
                sources.append(["id": k.id, "role": k.role, "file": k.file, "start": 0.0, "gaps": [], "startUnknown": true])
            }
        }

        var takeDuration = 0.0
        var usable = 0
        for i in sources.indices {
            guard let file = sources[i]["file"] as? String else { continue }
            let url = dir.appendingPathComponent(file)
            sources[i].removeValue(forKey: "empty")
            guard fm.fileExists(atPath: url.path) else {
                sources[i]["readable"] = false
                sources[i]["duration"] = 0.0
                continue
            }
            let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            var duration = 0.0
            var readable = false
            if let tracks = try? await asset.load(.tracks), let track = tracks.first,
               let range = try? await track.load(.timeRange) {
                // The track range reflects every fragment that reached the disk.
                duration = range.duration.seconds.isFinite ? range.duration.seconds : 0
                readable = duration > 0
                if track.mediaType == .video, let size = try? await track.load(.naturalSize) {
                    if sources[i]["width"] == nil { sources[i]["width"] = Int(size.width) }
                    if sources[i]["height"] == nil { sources[i]["height"] = Int(size.height) }
                }
            }
            sources[i]["readable"] = readable
            sources[i]["duration"] = r6(duration)
            if readable {
                usable += 1
                let start = (sources[i]["start"] as? NSNumber)?.doubleValue ?? 0
                takeDuration = max(takeDuration, start + duration)
            }
        }
        // Close gaps that were still open when the process died.
        for i in sources.indices {
            if var gaps = sources[i]["gaps"] as? [[String: Any]] {
                for g in gaps.indices {
                    let start = (gaps[g]["start"] as? NSNumber)?.doubleValue ?? 0
                    let end = (gaps[g]["end"] as? NSNumber)?.doubleValue ?? takeDuration
                    gaps[g]["end"] = r3(max(start, min(end, takeDuration)))
                }
                sources[i]["gaps"] = gaps
            }
        }

        // Cursor log: drop a half-written last line.
        let cursorURL = dir.appendingPathComponent("cursor.jsonl")
        if let data = fm.contents(atPath: cursorURL.path) {
            var text = String(decoding: data, as: UTF8.self)
            if !text.isEmpty, !text.hasSuffix("\n") {
                if let idx = text.lastIndex(of: "\n") { text = String(text[...idx]) } else { text = "" }
                try? Data(text.utf8).write(to: cursorURL, options: .atomic)
            }
            let lines = text.split(separator: "\n", omittingEmptySubsequences: true).count
            manifest["cursor"] = ["file": "cursor.jsonl", "samples": lines]
        } else if manifest["cursor"] == nil {
            manifest["cursor"] = NSNull()
        }

        manifest["sources"] = sources
        manifest["duration"] = r3(takeDuration)
        manifest["complete"] = false
        manifest["recovered"] = true
        manifest["usableSources"] = usable
        let data = try JSONSerialization.data(withJSONObject: Out.tidy(manifest), options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: manifestURL, options: .atomic)
        return manifest
    }
}
