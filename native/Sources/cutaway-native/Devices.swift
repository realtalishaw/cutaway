import Foundation
import AVFoundation
import AppKit
import CoreGraphics
import ScreenCaptureKit

enum Permissions {
    static func screen() -> String {
        // macOS offers no way to tell "never asked" from "denied" for screen recording.
        CGPreflightScreenCaptureAccess() ? "granted" : "undetermined"
    }

    static func media(_ type: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "undetermined"
        @unknown default: return "undetermined"
        }
    }

    static func all() -> [String: Any] {
        ["screen": screen(), "camera": media(.video), "microphone": media(.audio),
         "accessibility": InputAccess.accessibility(), "inputMonitoring": InputAccess.inputMonitoring()]
    }
}

enum DeviceCatalog {
    static func cameras() -> [AVCaptureDevice] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video,
            position: .unspecified)
        var seen = Set<String>()
        return session.devices.filter { seen.insert($0.uniqueID).inserted }
    }

    static func microphones() -> [AVCaptureDevice] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified)
        var seen = Set<String>()
        return session.devices.filter { seen.insert($0.uniqueID).inserted }
    }

    /// Unique (width, height) pairs with the best frame rate each, largest first.
    static func formats(of device: AVCaptureDevice) -> [(width: Int, height: Int, maxFps: Double)] {
        var best: [String: (Int, Int, Double)] = [:]
        for f in device.formats {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let fps = f.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
            let key = "\(d.width)x\(d.height)"
            if let cur = best[key], cur.2 >= fps { continue }
            best[key] = (Int(d.width), Int(d.height), fps)
        }
        return best.values
            .sorted { ($0.0 * $0.1, $0.2) > ($1.0 * $1.1, $1.2) }
            .map { (width: $0.0, height: $0.1, maxFps: $0.2) }
    }

    static func displays() -> [[String: Any]] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let screens = NSScreen.screens
        return ids.map { id in
            let bounds = CGDisplayBounds(id)
            let screen = screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }
            let scale: Double
            if let s = screen {
                scale = Double(s.backingScaleFactor)
            } else if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
                scale = Double(mode.pixelWidth) / Double(mode.width)
            } else {
                scale = 1
            }
            return [
                "id": Int(id),
                "name": screen?.localizedName ?? "Display \(id)",
                "width": Int(bounds.width), "height": Int(bounds.height),
                "scale": scale,
                "x": Int(bounds.origin.x), "y": Int(bounds.origin.y),
                "main": id == CGMainDisplayID(),
            ]
        }
    }
}

enum DevicesCommand {
    static func run(_ a: Args = Args([])) async throws -> Any {
        // iPhones and iPads appear a moment after this process opts in to screen-capture devices.
        ExternalDevices.enable()
        let externalWait = max(0, min(a.double("wait-external") ?? 0.4, 10))
        var windows: [[String: Any]] = []
        if CGPreflightScreenCaptureAccess() {
            if let content = try? await withTimeout(seconds: 8, {
                try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            }) {
                let ownPid = ProcessInfo.processInfo.processIdentifier
                for w in content.windows {
                    guard w.windowLayer == 0, let app = w.owningApplication, app.processID != ownPid else { continue }
                    guard let title = w.title, !title.isEmpty, w.frame.width >= 80, w.frame.height >= 60 else { continue }
                    let center = CGPoint(x: w.frame.midX, y: w.frame.midY)
                    let display = content.displays.first { $0.frame.contains(center) } ?? content.displays.first
                    windows.append([
                        "id": Int(w.windowID), "title": title,
                        "app": app.applicationName, "bundleId": app.bundleIdentifier,
                        "x": Int(w.frame.origin.x), "y": Int(w.frame.origin.y),
                        "width": Int(w.frame.width), "height": Int(w.frame.height),
                        "displayId": display.map { Int($0.displayID) } as Any? ?? NSNull(),
                    ])
                }
            }
        }

        let cameras: [[String: Any]] = DeviceCatalog.cameras().map { d in
            [
                "id": d.uniqueID, "name": d.localizedName,
                "formats": DeviceCatalog.formats(of: d).map { ["width": $0.width, "height": $0.height, "maxFps": r3($0.maxFps)] },
            ]
        }
        let defaultMic = AVCaptureDevice.default(for: .audio)?.uniqueID
        let mics: [[String: Any]] = DeviceCatalog.microphones().map { d in
            ["id": d.uniqueID, "name": d.localizedName, "default": d.uniqueID == defaultMic]
        }
        let external = await ExternalDevices.list(wait: externalWait).map(ExternalDevices.describe)
        let ownPid = ProcessInfo.processInfo.processIdentifier
        let apps: [[String: Any]] = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.processIdentifier != ownPid && $0.bundleIdentifier != nil }
            .map { ["bundleId": $0.bundleIdentifier!, "name": $0.localizedName ?? $0.bundleIdentifier!, "pid": Int($0.processIdentifier)] }
            .sorted { ($0["name"] as! String).localizedCaseInsensitiveCompare($1["name"] as! String) == .orderedAscending }
        return [
            "permissions": Permissions.all(),
            "displays": DeviceCatalog.displays(),
            "windows": windows,
            "cameras": cameras,
            "microphones": mics,
            "externalDevices": external,
            "apps": apps,
        ]
    }
}
