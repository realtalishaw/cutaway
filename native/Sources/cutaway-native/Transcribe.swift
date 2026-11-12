import Foundation
import AVFoundation
import CoreMedia
import Speech

/// On-device transcription. Audio never leaves the Mac: both engines are forced to local models.
enum TranscribeCommand {
    struct Word { var text: String; var start: Double; var end: Double; var confidence: Double }

    static func run(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else { throw CLIError("usage", "transcribe <audio-or-video> [--locale en-US]") }
        guard FileManager.default.fileExists(atPath: input) else { throw CLIError("not-found", "No file exists at \(input)") }
        let localeId = a.string("locale") ?? "en-US"
        let engine = a.string("engine") ?? "auto"          // auto | speechanalyzer | sfspeech
        let allowDownload = a.flags.contains("allow-model-download")

        // Normalise any input (mov/mp4/m4a/wav) to a 16 kHz mono WAV the speech engines accept.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("cutaway-transcribe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let raw = tmp.appendingPathComponent("audio.f32").path
        let pcm = try await PcmCommand.extract(input: input, output: raw, rate: 16000)
        let wav = tmp.appendingPathComponent("audio.wav")
        try writeWav(rawFloatPath: raw, to: wav, sampleRate: 16000)

        var analyzerError: CLIError?
        if engine != "sfspeech", #available(macOS 26.0, *) {
            do {
                let words = try await SpeechAnalyzerEngine.transcribe(url: wav, localeId: localeId, allowDownload: allowDownload)
                return result(engine: "apple-speechanalyzer", locale: localeId, words: refine(words, rawFloatPath: raw), duration: pcm.duration)
            } catch let e as CLIError {
                analyzerError = e
                Out.log("SpeechAnalyzer unavailable (\(e.code): \(e.message)); trying SFSpeechRecognizer")
                if engine == "speechanalyzer" { throw e }
            } catch {
                analyzerError = CLIError("speech-model-unavailable", String(describing: error))
                Out.log("SpeechAnalyzer failed (\(error)); trying SFSpeechRecognizer")
                if engine == "speechanalyzer" { throw analyzerError! }
            }
        }
        do {
            let words = try await sfSpeechInChild(wav: wav, localeId: localeId)
            return result(engine: "apple-sfspeech", locale: localeId, words: refine(words, rawFloatPath: raw), duration: pcm.duration)
        } catch let e as CLIError {
            // Prefer the more informative of the two failures.
            if let ae = analyzerError, e.code == "speech-model-unavailable" { throw ae }
            throw e
        }
    }

    /// SFSpeechRecognizer aborts the whole process when the responsible app lacks a
    /// Speech Recognition usage string, so it runs in a child that is allowed to die.
    private static func sfSpeechInChild(wav: URL, localeId: String) async throws -> [Word] {
        let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let process = Process()
        process.executableURL = URL(fileURLWithPath: exe)
        process.arguments = ["_sfspeech", wav.path, "--locale", localeId]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.standardError
        do { try process.run() } catch {
            throw CLIError("speech-model-unavailable", "Could not start the speech recogniser: \(error.localizedDescription)")
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        if process.terminationReason == .uncaughtSignal {
            throw CLIError("speech-permission-denied",
                           "macOS refused the Speech Recognition request (the host app has no NSSpeechRecognitionUsageDescription, or permission is blocked). Grant Speech Recognition to Cutaway in System Settings › Privacy & Security.")
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw CLIError("speech-model-unavailable", "The speech recogniser returned no result.")
        }
        if let err = json["error"] as? [String: Any] {
            throw CLIError((err["code"] as? String) ?? "speech-model-unavailable", (err["message"] as? String) ?? "Speech recognition failed.")
        }
        return ((json["words"] as? [[String: Any]]) ?? []).compactMap { w in
            guard let text = w["text"] as? String, let start = (w["start"] as? NSNumber)?.doubleValue,
                  let end = (w["end"] as? NSNumber)?.doubleValue else { return nil }
            return Word(text: text, start: start, end: end, confidence: (w["confidence"] as? NSNumber)?.doubleValue ?? 0)
        }
    }

    /// Hidden entry point for the child process.
    static func runSFSpeechChild(_ a: Args) async throws -> Any {
        guard let input = a.positional.first else { throw CLIError("usage", "_sfspeech <wav>") }
        let words = try await SFSpeechEngine.transcribe(url: URL(fileURLWithPath: input), localeId: a.string("locale") ?? "en-US")
        return ["words": words.map { ["text": $0.text, "start": $0.start, "end": $0.end, "confidence": $0.confidence] }]
    }

    /// Speech engines stretch a word's range over the silence before it. Tighten each word to
    /// the audio that is actually there, so pauses between words can be measured and trimmed.
    static func refine(_ words: [Word], rawFloatPath: String, sampleRate: Int = 16000) -> [Word] {
        guard !words.isEmpty, let data = try? Data(contentsOf: URL(fileURLWithPath: rawFloatPath), options: .mappedIfSafe) else { return words }
        let hop = sampleRate / 100          // 10 ms frames
        let count = data.count / 4 / hop
        guard count > 10 else { return words }
        var rms = [Float](repeating: 0, count: count)
        data.withUnsafeBytes { raw in
            let f = raw.bindMemory(to: Float32.self)
            for i in 0..<count {
                var sum: Float = 0
                for j in 0..<hop { let v = f[i * hop + j]; sum += v * v }
                rms[i] = (sum / Float(hop)).squareRoot()
            }
        }
        let sorted = rms.sorted()
        let floor = sorted[sorted.count / 10]
        let loud = sorted[sorted.count * 95 / 100]
        guard loud > 0 else { return words }
        let threshold = max(floor * 3, loud * 0.06, 0.0015)
        var out = words
        for i in out.indices {
            let a = max(0, Int(out[i].start * 100)), b = min(count - 1, Int(out[i].end * 100))
            guard b - a >= 12 else { continue }      // leave words shorter than 120 ms alone
            var first = a, last = b
            while first < b, rms[first] < threshold { first += 1 }
            while last > first, rms[last] < threshold { last -= 1 }
            guard first < last else { continue }     // no audible energy found: keep the engine's range
            let newStart = max(out[i].start, Double(first) / 100 - 0.03)
            let newEnd = min(out[i].end, Double(last + 1) / 100 + 0.05)
            if newEnd - newStart >= 0.06 {
                out[i].start = newStart
                out[i].end = newEnd
            }
        }
        return out
    }

    private static func result(engine: String, locale: String, words: [Word], duration: Double) -> [String: Any] {
        let cleaned = words
            .filter { !$0.text.isEmpty && $0.end >= $0.start }
            .sorted { $0.start < $1.start }
        return [
            "engine": engine, "locale": locale, "onDevice": true,
            "words": cleaned.map { ["text": $0.text, "start": r3($0.start), "end": r3($0.end), "confidence": r3($0.confidence)] },
            "hasSpeech": !cleaned.isEmpty,
            "duration": r3(duration),
        ]
    }

    private static func writeWav(rawFloatPath: String, to url: URL, sampleRate: Int) throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: rawFloatPath), options: .mappedIfSafe)
        let frames = data.count / 4
        var out = Data(capacity: 44 + frames * 2)
        func le32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { out.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { out.append(contentsOf: $0) } }
        out.append(contentsOf: Array("RIFF".utf8)); le32(UInt32(36 + frames * 2))
        out.append(contentsOf: Array("WAVE".utf8))
        out.append(contentsOf: Array("fmt ".utf8)); le32(16); le16(1); le16(1)
        le32(UInt32(sampleRate)); le32(UInt32(sampleRate * 2)); le16(2); le16(16)
        out.append(contentsOf: Array("data".utf8)); le32(UInt32(frames * 2))
        data.withUnsafeBytes { rawPtr in
            let floats = rawPtr.bindMemory(to: Float32.self)
            var pcm = [Int16](repeating: 0, count: frames)
            for i in 0..<frames {
                let v = max(-1, min(1, floats[i]))
                pcm[i] = Int16(v * 32767)
            }
            pcm.withUnsafeBufferPointer { out.append(UnsafeBufferPointer(start: UnsafeRawPointer($0.baseAddress!).assumingMemoryBound(to: UInt8.self), count: frames * 2)) }
        }
        try out.write(to: url)
    }

    /// Splits a recognised token into individual words, sharing its time range evenly by character count.
    static func split(text: String, start: Double, end: Double, confidence: Double) -> [Word] {
        let parts = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).map(String.init)
        guard !parts.isEmpty else { return [] }
        if parts.count == 1 { return [Word(text: parts[0], start: start, end: end, confidence: confidence)] }
        let total = Double(parts.reduce(0) { $0 + $1.count })
        var out: [Word] = []
        var cursor = start
        for p in parts {
            let span = (end - start) * Double(p.count) / max(1, total)
            out.append(Word(text: p, start: cursor, end: cursor + span, confidence: confidence))
            cursor += span
        }
        return out
    }

    /// Attaches punctuation-only tokens to the preceding word.
    static func mergePunctuation(_ words: [Word]) -> [Word] {
        var out: [Word] = []
        for w in words {
            let isPunct = !w.text.isEmpty && w.text.unicodeScalars.allSatisfy { CharacterSet.punctuationCharacters.contains($0) || CharacterSet.symbols.contains($0) }
            if isPunct, var last = out.popLast() {
                last.text += w.text
                last.end = max(last.end, w.end)
                out.append(last)
            } else {
                out.append(w)
            }
        }
        return out
    }
}

// MARK: - SpeechAnalyzer (macOS 26+)

@available(macOS 26.0, *)
enum SpeechAnalyzerEngine {
    static func transcribe(url: URL, localeId: String, allowDownload: Bool) async throws -> [TranscribeCommand.Word] {
        guard SpeechTranscriber.isAvailable else {
            throw CLIError("speech-model-unavailable", "SpeechTranscriber is not available on this Mac.")
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
            throw CLIError("speech-model-unavailable", "On-device transcription does not support the locale \(localeId).")
        }
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence])

        let status = await AssetInventory.status(forModules: [transcriber])
        if status != .installed {
            // "supported" can mean the model is already on this Mac but not yet reserved for this
            // process; reserving it needs no network. A real download only happens with the flag.
            let onDisk = await SpeechTranscriber.installedLocales.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
            guard onDisk || allowDownload else {
                throw CLIError("speech-model-unavailable",
                               "The on-device speech model for \(locale.identifier) is not installed. Re-run with --allow-model-download to let macOS install it.")
            }
            Out.log(onDisk ? "reserving the installed speech model for \(locale.identifier)…" : "asking macOS to install the speech model for \(locale.identifier)…")
            do {
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await request.downloadAndInstall()
                }
            } catch {
                throw CLIError("speech-model-unavailable", "The speech model for \(locale.identifier) could not be prepared: \(error.localizedDescription)")
            }
        }

        let file = try AVAudioFile(forReading: url)
        let analyzer = SpeechAnalyzer(modules: [transcriber])

        let collector = Task { () -> [TranscribeCommand.Word] in
            var words: [TranscribeCommand.Word] = []
            for try await result in transcriber.results {
                guard result.isFinal else { continue }
                let text = result.text
                for run in text.runs {
                    let piece = String(text[run.range].characters)
                    let trimmed = piece.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { continue }
                    let confidence = run.transcriptionConfidence ?? 1.0
                    if let range = run.audioTimeRange {
                        words.append(contentsOf: TranscribeCommand.split(
                            text: trimmed, start: range.start.seconds, end: range.end.seconds, confidence: confidence))
                    } else if var last = words.popLast() {
                        // Untimed fragment (usually punctuation): attach to the previous word.
                        last.text += trimmed
                        words.append(last)
                    } else {
                        let s = result.range.start.seconds
                        words.append(contentsOf: TranscribeCommand.split(text: trimmed, start: s, end: s, confidence: confidence))
                    }
                }
            }
            return words
        }

        do {
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            collector.cancel()
            throw CLIError("speech-model-unavailable", "SpeechAnalyzer failed: \(error.localizedDescription)")
        }
        let words = try await collector.value
        return TranscribeCommand.mergePunctuation(words)
    }
}

// MARK: - SFSpeechRecognizer fallback

enum SFSpeechEngine {
    static func transcribe(url: URL, localeId: String) async throws -> [TranscribeCommand.Word] {
        var status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            status = (try? await withTimeout(seconds: 60) {
                await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
                    SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
                }
            }) ?? .notDetermined
        }
        guard status == .authorized else {
            throw CLIError("speech-permission-denied",
                           "Speech Recognition permission is not granted. Enable it in System Settings › Privacy & Security › Speech Recognition.")
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
            throw CLIError("speech-model-unavailable", "Speech recognition does not support the locale \(localeId).")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw CLIError("speech-model-unavailable", "On-device speech recognition for \(localeId) is not installed on this Mac.")
        }
        guard recognizer.isAvailable else {
            throw CLIError("speech-model-unavailable", "Speech recognition is temporarily unavailable.")
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[TranscribeCommand.Word], Error>) in
            var done = false
            var collected: [TranscribeCommand.Word] = []
            recognizer.recognitionTask(with: request) { result, error in
                if done { return }
                if let result {
                    // On-device recognition can deliver several final chunks for long audio.
                    if result.isFinal {
                        for seg in result.bestTranscription.segments {
                            collected.append(contentsOf: TranscribeCommand.split(
                                text: seg.substring, start: seg.timestamp, end: seg.timestamp + seg.duration,
                                confidence: Double(seg.confidence)))
                        }
                        done = true
                        cont.resume(returning: collected)
                    }
                    return
                }
                if let error {
                    done = true
                    let ns = error as NSError
                    // "No speech detected" is a normal outcome for silent recordings.
                    if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 203) {
                        cont.resume(returning: collected)
                    } else {
                        cont.resume(throwing: CLIError("speech-model-unavailable", "Speech recognition failed: \(ns.localizedDescription) (\(ns.domain) \(ns.code))"))
                    }
                }
            }
        }
    }
}
