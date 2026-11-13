import Foundation
import AVFoundation
import AppKit
import CoreMedia
import CoreGraphics
import ScreenCaptureKit

/// Callbacks every capture source uses to hand samples to the recorder.
protocol CaptureSink: AnyObject {
    var clock: SessionClock { get }
    func sourceRestored(_ id: String, at t: Double)
    func sourceLost(_ id: String, reason: String)
    func nonFatal(_ code: String, _ message: String, source: String?)
}

private func hostTime(of sampleBuffer: CMSampleBuffer, from clock: CMClock?) -> Double {
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard let clock else { return pts.seconds }
    let host = CMClockGetHostTimeClock()
    if CFEqual(clock, host) { return pts.seconds }
    return CMSyncConvertTime(pts, from: clock, to: host).seconds
}

// MARK: - Screen + system audio (ScreenCaptureKit)

final class ScreenSource: NSObject, SCStreamOutput, SCStreamDelegate {
    private let config: RecordConfig
    private weak var sink: CaptureSink?
    private var stream: SCStream?
    private let videoQueue = DispatchQueue(label: "cutaway.screen.video", qos: .userInteractive)
    private let audioQueue = DispatchQueue(label: "cutaway.screen.audio", qos: .userInteractive)
    private var lastPixelBuffer: CVPixelBuffer?
    private var stopped = false

    var videoWriter: SourceWriter?
    var audioWriter: SourceWriter?
    let systemMeter = LevelMeter()
    /// Whether system audio may define the start of the take. nil = only when this stream has no picture.
    var audioMayEstablish: Bool?

    /// Captured area in global display points (top-left origin). Used to normalise the cursor.
    private(set) var captureRect: CGRect = .zero
    private(set) var windowId: CGWindowID?
    private(set) var pixelWidth = 0
    private(set) var pixelHeight = 0
    private(set) var scale: Double = 1

    /// What this stream delivers. One stream normally carries picture and system audio; when the
    /// audio must come from selected apps only, a second audio-only stream is used for it.
    private let wantsVideo: Bool
    private let wantsAudio: Bool
    private let audioApps: [String]?
    private var filterDisplay: SCDisplay?
    private var lastExcepted: Set<CGWindowID> = []
    private var lastRefresh = 0.0
    private var refreshing = false

    static let notificationBundleIds: Set<String> = ["com.apple.notificationcenterui", "com.apple.UserNotificationCenter"]
    static let finderBundleId = "com.apple.finder"

    init(config: RecordConfig, sink: CaptureSink, video: Bool? = nil, audio: Bool? = nil, audioApps: [String]? = nil) {
        self.config = config
        self.sink = sink
        self.wantsVideo = video ?? (config.sckScreen != nil)
        self.wantsAudio = audio ?? config.systemAudio
        self.audioApps = audioApps
    }

    private var hidesDesktopIcons: Bool { wantsVideo && (config.sckScreen?.hideDesktopIcons ?? false) }

    private func excludedBundleIds() -> Set<String> {
        var ids = Set(config.sckScreen?.excludeBundleIds ?? [])
        if config.sckScreen?.hideNotifications == true { ids.formUnion(Self.notificationBundleIds) }
        return ids
    }

    /// Display filter honouring the exclusion list and the hide-desktop-icons / hide-notifications
    /// options. Nothing in System Settings is touched: the content is simply left out of the capture.
    private func displayFilter(_ d: SCDisplay, content: SCShareableContent) -> (filter: SCContentFilter, excepted: Set<CGWindowID>) {
        var ids = excludedBundleIds()
        var keep: [SCWindow] = []
        if hidesDesktopIcons {
            // Finder draws the desktop icons in windows below the normal layer. Excluding Finder and
            // re-admitting its ordinary windows removes only the icons.
            ids.insert(Self.finderBundleId)
            keep = content.windows.filter { $0.owningApplication?.bundleIdentifier == Self.finderBundleId && $0.windowLayer >= 0 }
            if lastRefresh == 0 {
                let hidden = content.windows.filter { $0.owningApplication?.bundleIdentifier == Self.finderBundleId && $0.windowLayer < 0 }.count
                Out.log("hide-desktop-icons: \(hidden) Finder desktop-layer window(s) left out, \(keep.count) ordinary Finder window(s) kept")
            }
        }
        let excluded = content.applications.filter { ids.contains($0.bundleIdentifier) }
        return (SCContentFilter(display: d, excludingApplications: excluded, exceptingWindows: keep), Set(keep.map(\.windowID)))
    }

    /// With desktop icons hidden, Finder windows opened during the take must be re-admitted.
    func refreshFilter(hostNow now: Double) {
        guard hidesDesktopIcons, !stopped, !refreshing, now - lastRefresh >= 1.0, let stream, let d = filterDisplay else { return }
        lastRefresh = now
        refreshing = true
        Task.detached { [weak self] in
            defer { self?.refreshing = false }
            guard let self,
                  let content = try? await withTimeout(seconds: 4, { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }) else { return }
            let next = self.displayFilter(d, content: content)
            guard next.excepted != self.lastExcepted else { return }
            self.lastExcepted = next.excepted
            try? await stream.updateContentFilter(next.filter)
        }
    }

    /// Resolves the capture target and builds the stream. Does not start capturing.
    func prepare() async throws {
        let content: SCShareableContent
        do {
            content = try await withTimeout(seconds: 10) {
                try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            }
        } catch {
            if !CGPreflightScreenCaptureAccess() {
                throw CLIError("permission-denied", "Screen Recording permission is not granted. Enable it in System Settings › Privacy & Security › Screen & System Audio Recording.")
            }
            throw CLIError("capture-failed", "Could not list capturable screen content: \(error.localizedDescription)")
        }
        guard !content.displays.isEmpty else { throw CLIError("missing-device", "No display is available to capture.") }

        let screenCfg = wantsVideo ? config.sckScreen : nil
        let filter: SCContentFilter
        var sourceRect: CGRect?
        let type = screenCfg?.type ?? "display"

        func display(for id: UInt32?) -> SCDisplay {
            if let id, let d = content.displays.first(where: { $0.displayID == id }) { return d }
            return content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays[0]
        }
        if !wantsVideo, let apps = audioApps {
            // Audio-only stream limited to chosen apps.
            let wanted = Set(apps)
            let included = content.applications.filter { wanted.contains($0.bundleIdentifier) }
            guard !included.isEmpty else {
                throw CLIError("app-audio-unavailable", "None of the selected apps is running, so there is no app audio to record.")
            }
            let d = display(for: nil)
            filter = SCContentFilter(display: d, including: included, exceptingWindows: [])
            captureRect = d.frame
            try buildStream(filter: filter, screenCfg: nil, sourceRect: nil)
            return
        }

        switch type {
        case "window":
            guard let wid = screenCfg?.windowId, let window = content.windows.first(where: { $0.windowID == wid }) else {
                throw CLIError("missing-device", "The selected window is no longer available.")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            captureRect = window.frame
            windowId = window.windowID
        case "region":
            guard let rect = screenCfg?.rect, rect.width >= 16, rect.height >= 16 else {
                throw CLIError("bad-config", "A region capture needs a rect of at least 16×16 points.")
            }
            let center = CGPoint(x: rect.midX, y: rect.midY)
            let d = content.displays.first(where: { $0.frame.contains(center) }) ?? display(for: screenCfg?.displayId)
            let clipped = rect.intersection(d.frame)
            guard !clipped.isNull, clipped.width >= 16, clipped.height >= 16 else {
                throw CLIError("bad-config", "The region is outside the display.")
            }
            let made = displayFilter(d, content: content)
            filter = made.filter
            lastExcepted = made.excepted
            filterDisplay = d
            sourceRect = CGRect(x: clipped.minX - d.frame.minX, y: clipped.minY - d.frame.minY, width: clipped.width, height: clipped.height)
            captureRect = clipped
        default:
            let d = display(for: screenCfg?.displayId)
            if let wanted = screenCfg?.displayId, wanted != d.displayID {
                throw CLIError("missing-device", "The selected display is no longer connected.")
            }
            let made = displayFilter(d, content: content)
            filter = made.filter
            lastExcepted = made.excepted
            filterDisplay = d
            captureRect = d.frame
        }
        try buildStream(filter: filter, screenCfg: screenCfg, sourceRect: sourceRect)
    }

    private func buildStream(filter: SCContentFilter, screenCfg: RecordConfig.Screen?, sourceRect: CGRect?) throws {
        scale = Double(filter.pointPixelScale)
        if scale <= 0 { scale = 2 }
        var w = captureRect.width * scale
        var h = captureRect.height * scale
        let maxH = Double(min(Bitrates.maxScreenHeight, max(360, screenCfg?.maxHeight ?? 2160)))
        if h > maxH { w = w * maxH / h; h = maxH }
        let maxW = Double(Bitrates.maxScreenWidth)
        if w > maxW { h = h * maxW / w; w = maxW }
        pixelWidth = max(2, (Int(w.rounded()) / 2) * 2)
        pixelHeight = max(2, (Int(h.rounded()) / 2) * 2)

        let sc = SCStreamConfiguration()
        if screenCfg != nil {
            sc.width = pixelWidth
            sc.height = pixelHeight
            sc.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, config.fps)))
            sc.queueDepth = 6
        } else {
            // System audio only: ScreenCaptureKit still needs a video configuration, keep it tiny.
            sc.width = 2
            sc.height = 2
            sc.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            sc.queueDepth = 3
        }
        if let sourceRect { sc.sourceRect = sourceRect }
        sc.showsCursor = screenCfg?.showCursor ?? false
        sc.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        sc.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        sc.colorSpaceName = CGColorSpace.sRGB
        sc.scalesToFit = true
        if wantsAudio {
            sc.capturesAudio = true
            sc.sampleRate = 48000
            sc.channelCount = 2
            sc.excludesCurrentProcessAudio = true
        }

        let stream = SCStream(filter: filter, configuration: sc, delegate: self)
        if screenCfg != nil {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
        }
        if wantsAudio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        }
        self.stream = stream
    }

    func start() async throws {
        guard let stream else { return }
        do {
            try await withTimeout(seconds: 15) { try await stream.startCapture() }
        } catch {
            if !CGPreflightScreenCaptureAccess() {
                throw CLIError("permission-denied", "Screen Recording permission is not granted. Enable it in System Settings › Privacy & Security › Screen & System Audio Recording.")
            }
            throw CLIError("capture-failed", "Screen capture could not start: \(error.localizedDescription)")
        }
    }

    func stop() async {
        stopped = true
        guard let stream else { return }
        _ = try? await withTimeout(seconds: 5) { try await stream.stopCapture() }
        self.stream = nil
    }

    /// Follows a captured window when it moves, so cursor positions stay relative to it.
    func refreshWindowFrame() {
        guard let wid = windowId,
              let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]],
              let bounds = info.first?[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return }
        captureRect = rect
    }

    /// Re-appends the frame that is still on screen so an idle display keeps producing fragments
    /// and the file's duration matches the take.
    func keepAlive(hostNow: Double, idleFor: Double) {
        videoQueue.async { [weak self] in
            guard let self, !self.stopped, let pb = self.lastPixelBuffer, let writer = self.videoWriter, let sink = self.sink else { return }
            guard let t = sink.clock.sessionTime(host: hostNow, establish: false) else { return }
            if let last = writer.lastSampleTime, t - last < idleFor { return }
            _ = writer.appendVideo(pb, at: t)
        }
    }

    /// Writes the final frame at the stop time. Call before finishing the writer.
    func flushFinalFrame(hostNow: Double) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            videoQueue.async { [weak self] in
                if let self, let pb = self.lastPixelBuffer, let writer = self.videoWriter, let sink = self.sink,
                   let t = sink.clock.sessionTime(host: hostNow, establish: false) {
                    _ = writer.appendVideo(pb, at: t)
                }
                c.resume()
            }
        }
    }

    // SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopped, sampleBuffer.isValid, let sink else { return }
        switch type {
        case .screen:
            guard let writer = videoWriter else { return }
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
                  let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lastPixelBuffer = pb
            let host = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
            guard let t = sink.clock.sessionTime(host: host, establish: true) else { return }
            let res = writer.appendVideo(pb, at: t)
            if res.restored { sink.sourceRestored(writer.id, at: t) }
        case .audio:
            systemMeter.ingest(sampleBuffer)
            guard let writer = audioWriter else { return }
            let host = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
            // System audio never defines the start of a take on its own unless it is the only source.
            guard let t = sink.clock.sessionTime(host: host, establish: audioMayEstablish ?? (videoWriter == nil)) else { return }
            let res = writer.appendAudio(sampleBuffer, at: t)
            if res.restored { sink.sourceRestored(writer.id, at: t) }
        default:
            break
        }
    }

    // SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard !stopped else { return }
        let ns = error as NSError
        let reason = ns.code == -3817 ? "stopped-by-user" : "capture-stopped"   // SCStreamErrorUserStopped
        if videoWriter != nil { sink?.sourceLost("screen", reason: reason) }
        if audioWriter != nil { sink?.sourceLost("system", reason: reason) }
        sink?.nonFatal("screen-stopped", "Screen capture stopped: \(ns.localizedDescription)", source: "screen")
    }
}

// MARK: - Camera

final class CameraSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let camera: RecordConfig.Camera
    private weak var sink: CaptureSink?
    private var device: AVCaptureDevice
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue: DispatchQueue
    private var observers: [NSObjectProtocol] = []
    private var stopped = false

    var writer: SourceWriter?
    private(set) var width = 0
    private(set) var height = 0
    private(set) var fps: Double = 30
    var deviceName: String { device.localizedName }
    var sourceId: String { camera.sourceId }

    init(camera: RecordConfig.Camera, device: AVCaptureDevice, sink: CaptureSink) {
        self.camera = camera
        self.device = device
        self.sink = sink
        self.queue = DispatchQueue(label: "cutaway.camera.\(camera.slot)", qos: .userInteractive)
    }

    /// Picks the device format for the requested size and rate. Returns nil when unsupported.
    static func chooseFormat(device: AVCaptureDevice, width: Int?, height: Int?, fps: Double?)
        -> (format: AVCaptureDevice.Format, frameDuration: CMTime, fps: Double)? {
        func dims(_ f: AVCaptureDevice.Format) -> CMVideoDimensions { CMVideoFormatDescriptionGetDimensions(f.formatDescription) }
        var candidates = device.formats
        if let w = width, let h = height {
            candidates = candidates.filter { dims($0).width == Int32(w) && dims($0).height == Int32(h) }
        } else {
            // Default: the largest format up to 1080p.
            let capped = candidates.filter { dims($0).height <= 1080 }
            let pool = capped.isEmpty ? candidates : capped
            let best = pool.map { Int(dims($0).width) * Int(dims($0).height) }.max() ?? 0
            candidates = pool.filter { Int(dims($0).width) * Int(dims($0).height) == best }
        }
        let wanted = fps ?? 30
        for f in candidates {
            for range in f.videoSupportedFrameRateRanges {
                if wanted >= range.minFrameRate - 0.01 && wanted <= range.maxFrameRate + 0.01 {
                    let duration = abs(range.maxFrameRate - wanted) < 0.01
                        ? range.minFrameDuration
                        : CMTime(value: 1000, timescale: CMTimeScale((wanted * 1000).rounded()))
                    return (f, duration, wanted)
                }
            }
        }
        if fps == nil, let f = candidates.first, let range = f.videoSupportedFrameRateRanges.max(by: { $0.maxFrameRate < $1.maxFrameRate }) {
            return (f, range.minFrameDuration, range.maxFrameRate)
        }
        return nil
    }

    func prepare() throws {
        guard let choice = Self.chooseFormat(device: device, width: camera.width, height: camera.height, fps: camera.fps) else {
            throw CLIError("unsupported-format", "\(device.localizedName) does not support \(camera.width ?? 0)x\(camera.height ?? 0)@\(camera.fps ?? 30).")
        }
        let d = CMVideoFormatDescriptionGetDimensions(choice.format.formatDescription)
        width = Int(d.width); height = Int(d.height); fps = choice.fps

        let input: AVCaptureDeviceInput
        do { input = try AVCaptureDeviceInput(device: device) } catch {
            throw CLIError("capture-failed", "Cannot open \(device.localizedName): \(error.localizedDescription)")
        }
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CLIError("capture-failed", "Cannot use \(device.localizedName) as a capture input.")
        }
        session.addInput(input)
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw CLIError("capture-failed", "Cannot read frames from \(device.localizedName).")
        }
        session.addOutput(output)
        session.commitConfiguration()

        // Lock the format, then start while still holding the lock so the session preset cannot override it.
        do {
            try device.lockForConfiguration()
            device.activeFormat = choice.format
            device.activeVideoMinFrameDuration = choice.frameDuration
            device.activeVideoMaxFrameDuration = choice.frameDuration
            session.startRunning()
            device.unlockForConfiguration()
        } catch {
            throw CLIError("capture-failed", "Cannot configure \(device.localizedName): \(error.localizedDescription)")
        }
        guard session.isRunning else {
            throw CLIError("capture-failed", "\(device.localizedName) did not start.")
        }

        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let d = note.object as? AVCaptureDevice, d.uniqueID == self.device.uniqueID else { return }
            self.sink?.sourceLost(self.sourceId, reason: "disconnected")
        })
        observers.append(nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            guard let self, !self.stopped else { return }
            let err = (note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription ?? "runtime error"
            self.sink?.sourceLost(self.sourceId, reason: "error")
            self.sink?.nonFatal("camera-error", "\(self.device.localizedName): \(err)", source: self.sourceId)
        })
        observers.append(nc.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, !self.stopped, let d = note.object as? AVCaptureDevice, d.uniqueID == self.device.uniqueID else { return }
            self.reattach(d)
        })
    }

    /// The same physical camera came back: rebuild the input so frames flow again.
    private func reattach(_ newDevice: AVCaptureDevice) {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.session.beginConfiguration()
            for input in self.session.inputs { self.session.removeInput(input) }
            if let input = try? AVCaptureDeviceInput(device: newDevice), self.session.canAddInput(input) {
                self.session.addInput(input)
                self.device = newDevice
            }
            self.session.commitConfiguration()
            if let choice = Self.chooseFormat(device: newDevice, width: self.width, height: self.height, fps: self.fps),
               (try? newDevice.lockForConfiguration()) != nil {
                newDevice.activeFormat = choice.format
                newDevice.activeVideoMinFrameDuration = choice.frameDuration
                newDevice.activeVideoMaxFrameDuration = choice.frameDuration
                if !self.session.isRunning { self.session.startRunning() }
                newDevice.unlockForConfiguration()
            } else if !self.session.isRunning {
                self.session.startRunning()
            }
        }
    }

    func stop() {
        stopped = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if session.isRunning { session.stopRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !stopped, let sink, let writer, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let host = hostTime(of: sampleBuffer, from: session.synchronizationClock)
        guard let t = sink.clock.sessionTime(host: host, establish: true) else { return }
        let res = writer.appendVideo(pb, at: t)
        if res.restored { sink.sourceRestored(writer.id, at: t) }
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !stopped, let sink, sink.clock.hasZero, !sink.clock.isPaused else { return }
        writer?.countDrop()
    }
}

// MARK: - Microphone

final class MicrophoneSource: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private weak var sink: CaptureSink?
    private var device: AVCaptureDevice
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "cutaway.microphone", qos: .userInteractive)
    private var observers: [NSObjectProtocol] = []
    private var stopped = false
    private let establishes: Bool

    var writer: SourceWriter?
    let meter = LevelMeter()
    private(set) var channels = 1
    var deviceName: String { device.localizedName }

    /// `establishes`: whether the microphone may define the start of the take (true when it is the only source).
    init(device: AVCaptureDevice, sink: CaptureSink, establishes: Bool) {
        self.device = device
        self.sink = sink
        self.establishes = establishes
    }

    func prepare() throws {
        let input: AVCaptureDeviceInput
        do { input = try AVCaptureDeviceInput(device: device) } catch {
            throw CLIError("capture-failed", "Cannot open \(device.localizedName): \(error.localizedDescription)")
        }
        if let fd = device.activeFormat.formatDescription as CMFormatDescription?,
           let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
            channels = max(1, min(2, Int(asbd.mChannelsPerFrame)))
        }
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CLIError("capture-failed", "Cannot use \(device.localizedName) as an audio input.")
        }
        session.addInput(input)
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw CLIError("capture-failed", "Cannot read audio from \(device.localizedName).")
        }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
        guard session.isRunning else { throw CLIError("capture-failed", "\(device.localizedName) did not start.") }

        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let d = note.object as? AVCaptureDevice, d.uniqueID == self.device.uniqueID else { return }
            self.sink?.sourceLost("microphone", reason: "disconnected")
        })
        observers.append(nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            guard let self, !self.stopped else { return }
            let err = (note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription ?? "runtime error"
            self.sink?.sourceLost("microphone", reason: "error")
            self.sink?.nonFatal("microphone-error", "\(self.device.localizedName): \(err)", source: "microphone")
        })
    }

    func stop() {
        stopped = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if session.isRunning { session.stopRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !stopped, let sink else { return }
        meter.ingest(sampleBuffer)
        guard let writer else { return }
        let host = hostTime(of: sampleBuffer, from: session.synchronizationClock)
        guard let t = sink.clock.sessionTime(host: host, establish: establishes) else { return }
        let res = writer.appendAudio(sampleBuffer, at: t)
        if res.restored { sink.sourceRestored(writer.id, at: t) }
    }
}

// MARK: - Cursor telemetry

/// Polls the pointer at ~120 Hz. Needs no Accessibility or Input Monitoring permission.
final class CursorTracker {
    private let handle: FileHandle
    private let clock: SessionClock
    private let rectProvider: () -> CGRect
    private let queue = DispatchQueue(label: "cutaway.cursor", qos: .userInitiated)
    private var timer: DispatchSourceTimer?
    private var typeTimer: Timer?
    private var buffer = Data()
    private var lastFlush = 0.0
    private var lastX = Double.nan, lastY = Double.nan
    private var lastType = ""
    private var leftDown = false, rightDown = false
    private var lastWrite = -1.0
    private let typeLock = NSLock()
    private var currentType = "arrow"
    private(set) var samples = 0

    init?(url: URL, clock: SessionClock, rectProvider: @escaping () -> CGRect) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let h = try? FileHandle(forWritingTo: url) else { return nil }
        handle = h
        self.clock = clock
        self.rectProvider = rectProvider
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .nanoseconds(8_333_333), leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume()
        timer = t
        // The cursor image can only be read on the main thread.
        DispatchQueue.main.async { [weak self] in
            self?.typeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
                let type = CursorClassifier.shared.currentType()
                self?.typeLock.lock(); self?.currentType = type; self?.typeLock.unlock()
            }
        }
    }

    private func poll() {
        guard let t = clock.sessionTime(host: hostNow(), establish: false) else { return }
        guard let location = CGEvent(source: nil)?.location else { return }
        let rect = rectProvider()
        guard rect.width > 0, rect.height > 0 else { return }
        let x = Double((location.x - rect.minX) / rect.width)
        let y = Double((location.y - rect.minY) / rect.height)
        typeLock.lock(); let type = currentType; typeLock.unlock()
        let left = CGEventSource.buttonState(.combinedSessionState, button: .left)
        let right = CGEventSource.buttonState(.combinedSessionState, button: .right)

        if left != leftDown { write(t, x, y, type, left ? "down" : "up"); leftDown = left }
        if right != rightDown { write(t, x, y, type, right ? "rdown" : "rup"); rightDown = right }
        let moved = lastX.isNaN || abs(x - lastX) > 0.00005 || abs(y - lastY) > 0.00005
        // Idle heartbeat once a second keeps long pauses in pointer movement unambiguous.
        if moved || type != lastType || t - lastWrite >= 1.0 {
            write(t, x, y, type, "move")
        }
        if t - lastFlush > 0.5 { flush(); lastFlush = t }
    }

    private func write(_ t: Double, _ x: Double, _ y: Double, _ type: String, _ event: String) {
        let line = String(format: "{\"t\":%.4f,\"x\":%.5f,\"y\":%.5f,\"c\":\"%@\",\"e\":\"%@\"}\n", t, x, y, type, event)
        buffer.append(Data(line.utf8))
        lastX = x; lastY = y; lastType = type; lastWrite = t
        samples += 1
    }

    private func flush() {
        guard !buffer.isEmpty else { return }
        try? handle.write(contentsOf: buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    /// Flushes to disk; called at every checkpoint.
    func checkpoint() {
        queue.async { [weak self] in
            self?.flush()
            try? self?.handle.synchronize()
        }
    }

    func stop() {
        timer?.cancel()
        timer = nil
        DispatchQueue.main.async { [weak self] in self?.typeTimer?.invalidate() }
        queue.sync {
            flush()
            try? handle.synchronize()
            try? handle.close()
        }
    }
}

/// Best-effort mapping of the current system cursor image to a coarse category.
final class CursorClassifier {
    static let shared = CursorClassifier()
    private struct Signature: Hashable { let w: Int; let h: Int; let hx: Int; let hy: Int }
    private var table: [Signature: String] = [:]

    private init() {
        func add(_ cursor: NSCursor, _ name: String) {
            let s = signature(cursor)
            if table[s] == nil { table[s] = name }
        }
        add(.arrow, "arrow")
        add(.iBeam, "ibeam")
        add(.pointingHand, "pointer")
        add(.openHand, "grab")
        add(.closedHand, "grab")
        add(.resizeLeftRight, "resize")
        add(.resizeUpDown, "resize")
        add(.resizeLeft, "resize")
        add(.resizeRight, "resize")
        add(.resizeUp, "resize")
        add(.resizeDown, "resize")
        add(.crosshair, "other")
    }

    private func signature(_ c: NSCursor) -> Signature {
        Signature(w: Int(c.image.size.width.rounded()), h: Int(c.image.size.height.rounded()),
                  hx: Int(c.hotSpot.x.rounded()), hy: Int(c.hotSpot.y.rounded()))
    }

    func currentType() -> String {
        guard let cursor = NSCursor.currentSystem else { return "arrow" }
        return table[signature(cursor)] ?? "other"
    }
}
