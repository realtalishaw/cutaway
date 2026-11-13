import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// Browser tabs as recording targets.
//
//   browser-tabs [--ask <bundleId>]
//   browser-tabs --select --bundle <bundleId> --window <n> --tab <n> [--raise]
//   browser-tabs --content --bundle <bundleId> --window-id <CGWindowID>
//
// Listing and selecting tabs goes through Apple Events, which macOS gates per browser
// ("Cutaway wants to control Safari"). Nothing is asked unless `--ask` names that browser.
// Only tab titles and the host name of each tab are read; full URLs and page contents never
// leave this process and are not logged.
//
// The page area inside the window (everything below the tab strip and toolbar) is found with
// the Accessibility API when Cutaway has that permission, and estimated per browser otherwise.

enum BrowserTabs {
    enum Family { case safari, chromium, arc }
    struct Browser { let bundleId: String; let name: String; let family: Family }

    static let known: [Browser] = [
        Browser(bundleId: "com.apple.Safari", name: "Safari", family: .safari),
        Browser(bundleId: "com.apple.SafariTechnologyPreview", name: "Safari Technology Preview", family: .safari),
        Browser(bundleId: "com.google.Chrome", name: "Google Chrome", family: .chromium),
        Browser(bundleId: "com.microsoft.edgemac", name: "Microsoft Edge", family: .chromium),
        Browser(bundleId: "com.brave.Browser", name: "Brave", family: .chromium),
        Browser(bundleId: "com.vivaldi.Vivaldi", name: "Vivaldi", family: .chromium),
        Browser(bundleId: "company.thebrowser.Browser", name: "Arc", family: .arc),
    ]

    /// Top margin used when the page area cannot be measured: tab strip plus toolbar, in points.
    static func estimatedInsets(_ family: Family) -> RecordConfig.Insets {
        switch family {
        case .safari: return RecordConfig.Insets(top: 88, left: 0, bottom: 0, right: 0)
        case .chromium: return RecordConfig.Insets(top: 87, left: 0, bottom: 0, right: 0)
        case .arc: return RecordConfig.Insets(top: 44, left: 0, bottom: 0, right: 0)
        }
    }

    // MARK: permission

    /// "granted" | "denied" | "undetermined" | "not-running" | "unknown". Shows the macOS prompt only when `ask` is true.
    static func automation(_ bundleId: String, ask: Bool) -> String {
        var address = AEAddressDesc()
        let data = Data(bundleId.utf8)
        let made = data.withUnsafeBytes { AECreateDesc(typeApplicationBundleID, $0.baseAddress, data.count, &address) }
        guard made == noErr else { return "unknown" }
        defer { AEDisposeDesc(&address) }
        let status = AEDeterminePermissionToAutomateTarget(&address, typeWildCard, typeWildCard, ask)
        switch Int(status) {
        case 0: return "granted"
        case -1743: return "denied"          // errAEEventNotPermitted
        case -1744: return "undetermined"    // errAEEventWouldRequireUserConsent
        case -600: return "not-running"      // procNotFound
        default: return "unknown"
        }
    }

    // MARK: AppleScript

    private static let fs = "\u{1F}", rs = "\u{1E}"

    private static func run(_ source: String) throws -> String {
        var result: String?
        var failure: String?
        let work = {
            var error: NSDictionary?
            let out = NSAppleScript(source: source)?.executeAndReturnError(&error)
            if let error {
                failure = (error[NSAppleScript.errorMessage] as? String) ?? "AppleScript error \(error[NSAppleScript.errorNumber] ?? 0)"
            } else {
                result = out?.stringValue ?? ""
            }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
        if let failure { throw CLIError("browser-script", failure) }
        return result ?? ""
    }

    private static func listScript(_ b: Browser) -> String {
        let head = "tell application id \"\(b.bundleId)\"\nset fs to character id 31\nset rs to character id 30\nset out to \"\"\nset wi to 0\nrepeat with w in windows\nset wi to wi + 1\ntry\nset b to bounds of w\n"
        let row = "set out to out & (wi as text) & fs & (ti as text) & fs & (isActive as text) & fs & ((item 1 of b) as text) & fs & ((item 2 of b) as text) & fs & ((item 3 of b) as text) & fs & ((item 4 of b) as text) & fs & tabTitle & fs & tabUrl & rs\n"
        let tail = "end try\nend repeat\nreturn out\nend tell"
        switch b.family {
        case .safari:
            return head + "set ci to 0\ntry\nset ci to index of current tab of w\nend try\nrepeat with t in tabs of w\nset ti to index of t\nset isActive to (ti = ci)\nset tabTitle to \"\"\ntry\nset tabTitle to (name of t) as text\nend try\nset tabUrl to \"\"\ntry\nset tabUrl to (URL of t) as text\nend try\n" + row + "end repeat\n" + tail
        case .chromium:
            return head + "set ai to active tab index of w\nset ti to 0\nrepeat with t in tabs of w\nset ti to ti + 1\nset isActive to (ti = ai)\nset tabTitle to \"\"\ntry\nset tabTitle to (title of t) as text\nend try\nset tabUrl to \"\"\ntry\nset tabUrl to (URL of t) as text\nend try\n" + row + "end repeat\n" + tail
        case .arc:
            return head + "set aid to \"\"\ntry\nset aid to (id of active tab of w) as text\nend try\nset ti to 0\nrepeat with t in tabs of w\nset ti to ti + 1\nset isActive to false\ntry\nset isActive to (((id of t) as text) = aid)\nend try\nset tabTitle to \"\"\ntry\nset tabTitle to (title of t) as text\nend try\nset tabUrl to \"\"\ntry\nset tabUrl to (URL of t) as text\nend try\n" + row + "end repeat\n" + tail
        }
    }

    private static func selectScript(_ b: Browser, window: Int, tab: Int, raise: Bool) -> String {
        let pick: String
        switch b.family {
        case .safari: pick = "set current tab of window \(window) to tab \(tab) of window \(window)"
        case .chromium: pick = "set active tab index of window \(window) to \(tab)"
        case .arc: pick = "tell tab \(tab) of window \(window) to select"
        }
        // Raising reorders the windows, so the bounds are read before it.
        let front = raise ? "try\nset index of window \(window) to 1\nend try\nactivate\n" : ""
        return "tell application id \"\(b.bundleId)\"\n\(pick)\nset b to bounds of window \(window)\n\(front)return ((item 1 of b) as text) & \",\" & ((item 2 of b) as text) & \",\" & ((item 3 of b) as text) & \",\" & ((item 4 of b) as text)\nend tell"
    }

    /// Host name only: the rest of the address is dropped here and never returned.
    static func host(of url: String) -> String {
        guard !url.isEmpty, url != "missing value", let c = URLComponents(string: url) else { return "" }
        if c.scheme == "file" { return "local file" }
        guard let h = c.host, !h.isEmpty else { return c.scheme.map { "\($0) page" } ?? "" }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    // MARK: windows

    /// The on-screen window of `pid` whose frame matches (AppleScript bounds are left, top, right, bottom).
    static func windowId(pid: pid_t, frame: CGRect) -> CGWindowID? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        var best: (id: CGWindowID, score: Double)?
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let bounds = w[kCGWindowBounds as String] as? [String: Any],
                  let r = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { continue }
            let d = abs(r.minX - frame.minX) + abs(r.minY - frame.minY) + abs(r.width - frame.width) + abs(r.height - frame.height)
            if d <= 8, best == nil || d < best!.score { best = (id, Double(d)) }
        }
        return best?.id
    }

    static func frame(ofWindow id: CGWindowID) -> CGRect? {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let bounds = info.first?[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }

    // MARK: page area

    private static func axValue<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? T
    }

    private static func axFrame(_ element: AXUIElement) -> CGRect? {
        var p: CFTypeRef?, s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &s) == .success,
              let pv = p, let sv = s, CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &point), AXValueGetValue(sv as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    /// Margins around the web page inside a browser window, measured through Accessibility.
    /// nil when Cutaway lacks that permission or the page area cannot be found.
    static func measuredInsets(pid: pid_t, windowFrame: CGRect) -> RecordConfig.Insets? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.5)
        guard let windows: [AXUIElement] = axValue(app, kAXWindowsAttribute as String) else { return nil }
        let window = windows.first { w in
            guard let f = axFrame(w) else { return false }
            return abs(f.minX - windowFrame.minX) + abs(f.minY - windowFrame.minY) + abs(f.width - windowFrame.width) + abs(f.height - windowFrame.height) <= 8
        }
        guard let window else { return nil }
        // Breadth-first, bounded: the page area sits a few levels below the window.
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited = 0
        var best: CGRect?
        while !queue.isEmpty, visited < 2500 {
            let (el, depth) = queue.removeFirst()
            visited += 1
            let role: String? = axValue(el, kAXRoleAttribute as String)
            if role == "AXWebArea", let f = axFrame(el), f.width >= 120, f.height >= 120 {
                let clipped = f.intersection(windowFrame)
                if !clipped.isNull, best == nil || clipped.width * clipped.height > best!.width * best!.height { best = clipped }
                continue // never walk into the page itself
            }
            guard depth < 14, let children: [AXUIElement] = axValue(el, kAXChildrenAttribute as String) else { continue }
            for c in children.prefix(60) { queue.append((c, depth + 1)) }
        }
        guard let area = best else { return nil }
        return RecordConfig.Insets(top: Double(area.minY - windowFrame.minY), left: Double(area.minX - windowFrame.minX),
                                   bottom: Double(windowFrame.maxY - area.maxY), right: Double(windowFrame.maxX - area.maxX))
    }

    static func contentInfo(_ b: Browser, pid: pid_t, windowFrame: CGRect) -> [String: Any] {
        if let m = measuredInsets(pid: pid, windowFrame: windowFrame) {
            let f = m.fitted(to: windowFrame.size)
            return ["top": r3(f.top), "left": r3(f.left), "bottom": r3(f.bottom), "right": r3(f.right), "method": "accessibility"]
        }
        let e = estimatedInsets(b.family).fitted(to: windowFrame.size)
        return ["top": e.top, "left": e.left, "bottom": e.bottom, "right": e.right, "method": "estimate"]
    }

    // MARK: commands

    static func running(_ b: Browser) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: b.bundleId).first { !$0.isTerminated }
    }

    static func list(ask: String?) -> Any {
        var browsers: [[String: Any]] = []
        for b in known {
            guard let app = running(b) else { continue }
            var entry: [String: Any] = ["bundleId": b.bundleId, "name": app.localizedName ?? b.name, "pid": Int(app.processIdentifier)]
            let permission = automation(b.bundleId, ask: ask == b.bundleId)
            entry["permission"] = permission
            var tabs: [[String: Any]] = []
            if permission == "granted" {
                do {
                    let raw = try run(listScript(b))
                    var ids: [String: CGWindowID?] = [:]
                    for record in raw.components(separatedBy: rs) where !record.isEmpty {
                        let f = record.components(separatedBy: fs)
                        guard f.count >= 9, let wi = Int(f[0]), let ti = Int(f[1]),
                              let x1 = Double(f[3]), let y1 = Double(f[4]), let x2 = Double(f[5]), let y2 = Double(f[6]) else { continue }
                        let frame = CGRect(x: x1, y: y1, width: x2 - x1, height: y2 - y1)
                        let key = "\(wi)"
                        if ids[key] == nil { ids[key] = windowId(pid: app.processIdentifier, frame: frame) }
                        var tab: [String: Any] = [
                            "window": wi, "tab": ti, "active": f[2] == "true",
                            "title": String(f[7].prefix(200)), "host": host(of: f[8]),
                            "x": Int(frame.minX), "y": Int(frame.minY), "width": Int(frame.width), "height": Int(frame.height),
                        ]
                        // Minimised or other-Space windows have no on-screen window to record.
                        if let id = ids[key] ?? nil { tab["windowId"] = Int(id) }
                        tabs.append(tab)
                    }
                } catch let e as CLIError {
                    entry["error"] = e.message
                } catch {
                    entry["error"] = String(describing: error)
                }
            }
            entry["tabs"] = tabs
            browsers.append(entry)
        }
        return ["accessibility": AXIsProcessTrusted() ? "granted" : "denied", "browsers": browsers]
    }

    static func select(bundleId: String, window: Int, tab: Int, raise: Bool) throws -> Any {
        guard let b = known.first(where: { $0.bundleId == bundleId }) else { throw CLIError("bad-config", "Unknown browser \(bundleId).") }
        guard let app = running(b) else { throw CLIError("missing-device", "\(b.name) is not running.") }
        guard window >= 1, tab >= 1 else { throw CLIError("bad-config", "Window and tab numbers start at 1.") }
        let permission = automation(bundleId, ask: false)
        guard permission == "granted" else {
            throw CLIError("permission-denied", "Cutaway is not allowed to control \(b.name). Allow it in System Settings › Privacy & Security › Automation.")
        }
        let raw: String
        do { raw = try run(selectScript(b, window: window, tab: tab, raise: raise)) } catch let e as CLIError {
            throw CLIError("missing-device", "That tab is no longer there (\(e.message)). Look again and pick another.")
        }
        let n = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard n.count == 4 else { throw CLIError("browser-script", "\(b.name) did not report the window's position.") }
        var frame = CGRect(x: n[0], y: n[1], width: n[2] - n[0], height: n[3] - n[1])
        // Give the browser a moment to bring the tab (and, when raised, the window) forward.
        Thread.sleep(forTimeInterval: raise ? 0.45 : 0.25)
        guard let id = windowId(pid: app.processIdentifier, frame: frame) else {
            throw CLIError("missing-device", "The window with that tab is not on screen. Bring it to this desktop (not minimised) and try again.")
        }
        if let now = BrowserTabs.frame(ofWindow: id) { frame = now }
        return [
            "bundleId": bundleId, "window": raise ? 1 : window, "tab": tab, "windowId": Int(id),
            "x": Int(frame.minX), "y": Int(frame.minY), "width": Int(frame.width), "height": Int(frame.height),
            "content": contentInfo(b, pid: app.processIdentifier, windowFrame: frame),
            "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
        ] as [String: Any]
    }

    static func content(bundleId: String, windowId id: CGWindowID) throws -> Any {
        guard let b = known.first(where: { $0.bundleId == bundleId }), let app = running(b) else { throw CLIError("missing-device", "That browser is not running.") }
        guard let frame = frame(ofWindow: id) else { throw CLIError("missing-device", "That window is no longer open.") }
        return ["windowId": Int(id), "x": Int(frame.minX), "y": Int(frame.minY), "width": Int(frame.width), "height": Int(frame.height),
                "content": contentInfo(b, pid: app.processIdentifier, windowFrame: frame),
                "accessibility": AXIsProcessTrusted() ? "granted" : "denied"] as [String: Any]
    }
}

enum BrowserTabsCommand {
    static func run(_ a: Args) async throws -> Any {
        if a.flags.contains("select") {
            guard let w = a.int("window"), let t = a.int("tab") else { throw CLIError("usage", "browser-tabs --select --bundle <id> --window <n> --tab <n> [--raise]") }
            return try BrowserTabs.select(bundleId: try a.require("bundle"), window: w, tab: t, raise: a.flags.contains("raise"))
        }
        if a.flags.contains("content") {
            guard let id = a.int("window-id") else { throw CLIError("usage", "browser-tabs --content --bundle <id> --window-id <n>") }
            return try BrowserTabs.content(bundleId: try a.require("bundle"), windowId: CGWindowID(id))
        }
        return BrowserTabs.list(ask: a.string("ask"))
    }
}
