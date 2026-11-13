import Foundation
import AVFoundation
import CoreMedia

// MARK: - Errors

struct CLIError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

// MARK: - Output

enum Out {
    private static let lock = NSLock()

    /// Doubles are re-expressed as shortest-form decimals so 2.002 is not printed as 2.0019999999999998.
    static func tidy(_ value: Any) -> Any {
        if let d = value as? [String: Any] { return d.mapValues(tidy) }
        if let a = value as? [Any] { return a.map(tidy) }
        if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), CFNumberIsFloatType(n) {
            let d = n.doubleValue
            return d.isFinite ? NSDecimalNumber(string: "\(d)") : NSNumber(value: 0)
        }
        return value
    }

    /// Serialises any JSON-compatible value to a single line.
    static func line(_ value: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: tidy(value), options: [.withoutEscapingSlashes])) ?? Data("null".utf8)
        return String(data: data, encoding: .utf8) ?? "null"
    }

    static func pretty(_ value: Any) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: tidy(value), options: [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys])) ?? Data("null".utf8)
        return String(data: data, encoding: .utf8) ?? "null"
    }

    /// Writes bytes to a descriptor and ignores a closed pipe. `FileHandle.write(_:)` raises an Objective-C
    /// exception when the reader has gone, which used to end the helper with an abort and a crash report.
    static func write(_ text: String, to fd: Int32) {
        let bytes = Array(text.utf8)
        var offset = 0
        while offset < bytes.count {
            let n = bytes[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if n > 0 { offset += n } else if n < 0 && errno == EINTR { continue } else { return }
        }
    }

    /// Writes one JSON value followed by a newline to stdout and flushes.
    static func emit(_ value: Any) {
        let text = line(value) + "\n"
        lock.lock()
        write(text, to: STDOUT_FILENO)
        lock.unlock()
    }

    static func log(_ message: String) {
        write("[cutaway-native] " + message + "\n", to: STDERR_FILENO)
    }

    static func fail(_ error: CLIError) -> Never {
        emit(["error": ["code": error.code, "message": error.message]])
        log("error \(error.code): \(error.message)")
        exit(1)
    }
}

/// Rounds to microseconds so JSON stays tidy.
func r6(_ x: Double) -> Double {
    guard x.isFinite else { return 0 }
    return (x * 1_000_000).rounded() / 1_000_000
}

func r3(_ x: Double) -> Double {
    guard x.isFinite else { return 0 }
    return (x * 1000).rounded() / 1000
}

func isoNow() -> String { isoString(Date()) }

func isoString(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
}

// MARK: - Arguments

struct Args {
    var positional: [String] = []
    var options: [String: String] = [:]
    var flags: Set<String> = []

    init(_ raw: [String], flagNames: Set<String> = []) {
        var i = 0
        while i < raw.count {
            let a = raw[i]
            if a.hasPrefix("--") {
                let name = String(a.dropFirst(2))
                if flagNames.contains(name) {
                    flags.insert(name)
                } else if i + 1 < raw.count {
                    options[name] = raw[i + 1]
                    i += 1
                } else {
                    flags.insert(name)
                }
            } else {
                positional.append(a)
            }
            i += 1
        }
    }

    func string(_ name: String) -> String? { options[name] }
    func double(_ name: String) -> Double? { options[name].flatMap(Double.init) }
    func int(_ name: String) -> Int? { options[name].flatMap(Int.init) }
    func require(_ name: String) throws -> String {
        guard let v = options[name] else { throw CLIError("usage", "missing --\(name)") }
        return v
    }
}

// MARK: - Async entry

/// Runs an async command, prints its JSON result, and exits. Keeps the main run loop alive
/// so AppKit / AVFoundation callbacks that target the main queue are delivered.
func runCommand(pretty: Bool = false, _ body: @escaping () async throws -> Any) -> Never {
    Task.detached {
        do {
            let result = try await body()
            Out.write((pretty ? Out.pretty(result) : Out.line(result)) + "\n", to: STDOUT_FILENO)
            exit(0)
        } catch let e as CLIError {
            Out.fail(e)
        } catch {
            Out.fail(CLIError("internal", String(describing: error)))
        }
    }
    RunLoop.main.run()
    exit(0)
}

// MARK: - Helpers

func fourCC(_ code: FourCharCode) -> String {
    let bytes: [UInt8] = [
        UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff), UInt8((code >> 8) & 0xff), UInt8(code & 0xff),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? "????"
}

func freeBytes(at url: URL) -> Int64 {
    var probe = url
    // Walk up to an existing ancestor so a not-yet-created directory still resolves.
    while !FileManager.default.fileExists(atPath: probe.path) && probe.path != "/" {
        probe = probe.deletingLastPathComponent()
    }
    if let v = try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
       let cap = v.volumeAvailableCapacityForImportantUsage {
        return cap
    }
    if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: probe.path),
       let free = attrs[.systemFreeSize] as? NSNumber {
        return free.int64Value
    }
    return 0
}

/// True exactly once, from whichever caller gets there first.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

/// Runs an async operation with a timeout so a blocked system call can never hang the helper.
///
/// The operation runs in its own unstructured task. A task group must not be used here: a group waits for
/// every child before it returns, and the ScreenCaptureKit calls this guards do not respond to cancellation,
/// so the "timeout" would wait for ever (that left helpers alive for hours, each one in a reconnect loop with
/// the capture service, until no new recording could start).
func withTimeout<T>(seconds: Double, _ op: @escaping () async throws -> T) async throws -> T {
    let once = OnceFlag()
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
        let work = Task.detached {
            do {
                let value = try await op()
                if once.claim() { cont.resume(returning: value) }
            } catch {
                if once.claim() { cont.resume(throwing: error) }
            }
        }
        Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if once.claim() {
                work.cancel()
                cont.resume(throwing: CLIError("timeout", "operation timed out after \(seconds)s"))
            }
        }
    }
}

// MARK: - Never outlive the app

/// Ends the helper when it can no longer be useful, so a copy is never left running:
///  - the app that started it has gone (the helper is re-parented to launchd), or
///  - a command that should take seconds has run past its deadline.
/// `onParentGone` lets a recording finalise what it has; the helper exits a few seconds later regardless.
enum Watchdog {
    private static var onParentGone: (() -> Void)?
    private static let lock = NSLock()

    static func setParentGoneHandler(_ handler: @escaping () -> Void) {
        lock.lock()
        onParentGone = handler
        lock.unlock()
    }

    static func start(command: String, deadline: Double?) {
        let parent = getppid()
        let began = Date()
        Thread.detachNewThread {
            while true {
                Thread.sleep(forTimeInterval: 1)
                if parent != 1 && getppid() != parent {
                    Out.log("\(command): the app that started this helper has gone, stopping")
                    lock.lock()
                    let handler = onParentGone
                    lock.unlock()
                    handler?()
                    Thread.sleep(forTimeInterval: handler == nil ? 0 : 8)
                    exit(1)
                }
                if let deadline, Date().timeIntervalSince(began) > deadline {
                    Out.fail(CLIError("timeout", "\(command) did not finish within \(Int(deadline)) seconds."))
                }
            }
        }
    }

    /// After a stop was asked for from outside, the helper must end even if a system call never returns.
    static func exitWithin(_ seconds: Double, code: Int32 = 1) {
        Thread.detachNewThread {
            Thread.sleep(forTimeInterval: seconds)
            Out.log("did not stop within \(Int(seconds)) seconds, exiting")
            exit(code)
        }
    }
}

func hostSeconds(_ time: CMTime) -> Double { CMTimeGetSeconds(time) }

func hostNow() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) }
