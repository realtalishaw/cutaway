import Foundation
import AppKit
import CoreGraphics
import IOKit.hid

// Keyboard activity for the shortcut overlay and typing detection.
//
// PRIVACY: typed characters are never read or stored. A listen-only event tap sees key-down
// events; only two things are written:
//   • shortcuts  – a key pressed with ⌘, ⌃ or ⌥, or a navigation/function key – as key names
//     taken from a fixed key-code table (never from the keyboard layout's character output);
//   • typing     – a bare "something was typed" tick with no key and no character.

enum InputAccess {
    /// Input Monitoring status without prompting.
    static func inputMonitoring() -> String {
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: return "granted"
        case kIOHIDAccessTypeDenied: return "denied"
        default: return "undetermined"
        }
    }

    /// Accessibility status without prompting. macOS does not distinguish "never asked" from "denied".
    static func accessibility() -> String {
        AXIsProcessTrusted() ? "granted" : "undetermined"
    }
}

enum KeyNames {
    static let table: [Int64: String] = [
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r",
        16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8", 29: "0",
        30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p", 36: "return", 37: "l", 38: "j", 39: "'", 40: "k", 41: ";", 42: "\\",
        43: ",", 44: "/", 45: "n", 46: "m", 47: ".", 48: "tab", 49: "space", 50: "`", 51: "delete", 53: "escape", 76: "enter",
        96: "f5", 97: "f6", 98: "f7", 99: "f3", 100: "f8", 101: "f9", 103: "f11", 109: "f10", 111: "f12", 118: "f4", 120: "f2", 122: "f1",
        115: "home", 116: "pageup", 117: "forwarddelete", 119: "end", 121: "pagedown",
        123: "left", 124: "right", 125: "down", 126: "up",
    ]
    /// Keys that count as a shortcut on their own.
    static let standalone: Set<Int64> = [36, 48, 51, 53, 76, 96, 97, 98, 99, 100, 101, 103, 109, 111, 118, 120, 122, 115, 116, 117, 119, 121, 123, 124, 125, 126]
}

private func keyTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let tracker = Unmanaged<KeyTracker>.fromOpaque(refcon).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        tracker.reenable()
    } else if type == .keyDown {
        tracker.keyDown(event)
    }
    return Unmanaged.passUnretained(event)
}

final class KeyTracker {
    private let handle: FileHandle
    private let clock: SessionClock
    private let queue = DispatchQueue(label: "cutaway.keys", qos: .userInitiated)
    private var buffer = Data()
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var synthTimer: DispatchSourceTimer?
    private var synthNext = 0
    private let countLock = NSLock()
    private var count = 0
    var events: Int { countLock.lock(); defer { countLock.unlock() }; return count }

    init?(url: URL, clock: SessionClock) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let h = try? FileHandle(forWritingTo: url) else { return nil }
        handle = h
        self.clock = clock
    }

    /// Installs the listen-only tap. Returns false (and installs nothing) when Input Monitoring is
    /// not already granted, so macOS is never made to prompt.
    func startTap() -> Bool {
        guard CGPreflightListenEventAccess() else { return false }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                          eventsOfInterest: mask, callback: keyTapCallback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        self.tap = tap
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        source = src
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    fileprivate func reenable() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    }

    fileprivate func keyDown(_ event: CGEvent) {
        let host = hostNow()
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        let modified = flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate)
        queue.async { [self] in
            guard let t = clock.sessionTime(host: host, establish: false) else { return }
            if modified || KeyNames.standalone.contains(code) {
                if isRepeat { return }
                var keys: [String] = []
                if flags.contains(.maskCommand) { keys.append("cmd") }
                if flags.contains(.maskControl) { keys.append("ctrl") }
                if flags.contains(.maskAlternate) { keys.append("alt") }
                if flags.contains(.maskShift) { keys.append("shift") }
                // A modified key with no entry in the table is recorded without a name rather than guessed.
                keys.append(KeyNames.table[code] ?? "key")
                writeShortcut(t, keys)
            } else {
                writeType(t)
            }
        }
    }

    private func writeShortcut(_ t: Double, _ keys: [String]) {
        let list = keys.map { "\"" + $0.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }.joined(separator: ",")
        append(String(format: "{\"t\":%.4f,\"e\":\"shortcut\",\"keys\":[%@]}\n", t, list))
    }

    private func writeType(_ t: Double) {
        append(String(format: "{\"t\":%.4f,\"e\":\"type\"}\n", t))
    }

    private func append(_ line: String) {
        buffer.append(Data(line.utf8))
        countLock.lock(); count += 1; countLock.unlock()
        if buffer.count > 4096 { flush() }
    }

    private func flush() {
        guard !buffer.isEmpty else { return }
        try? handle.write(contentsOf: buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    /// Test mode: a repeating eight-second pattern of made-up shortcuts and typing ticks.
    func startSynthetic() {
        var pattern: [(Double, [String]?)] = [(1.0, ["cmd", "k"]), (3.5, ["cmd", "shift", "4"]), (6.0, ["escape"])]
        var t = 1.8
        while t < 3.0 { pattern.append((t, nil)); t += 0.12 }
        t = 4.2
        while t < 5.2 { pattern.append((t, nil)); t += 0.12 }
        pattern.sort { $0.0 < $1.0 }
        let period = 8.0
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(40), leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in
            guard let self, let now = self.clock.sessionTime(host: hostNow(), establish: false) else { return }
            while true {
                let cycle = Double(self.synthNext / pattern.count) * period
                let item = pattern[self.synthNext % pattern.count]
                let at = cycle + item.0
                if at > now { break }
                if let keys = item.1 { self.writeShortcut(at, keys) } else { self.writeType(at) }
                self.synthNext += 1
            }
        }
        timer.resume()
        synthTimer = timer
    }

    func checkpoint() {
        queue.async { [weak self] in
            self?.flush()
            try? self?.handle.synchronize()
        }
    }

    func stop() {
        synthTimer?.cancel()
        synthTimer = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        queue.sync {
            flush()
            try? handle.synchronize()
            try? handle.close()
        }
    }
}
