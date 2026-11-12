import Foundation
import Speech

/// Reports which on-device speech engines can run right now, without prompting or downloading.
enum SpeechStatusCommand {
    static func run(_ a: Args) async throws -> Any {
        let localeId = a.string("locale") ?? "en-US"
        let locale = Locale(identifier: localeId)
        var out: [String: Any] = ["locale": localeId]

        if #available(macOS 26.0, *) {
            var analyzer: [String: Any] = ["available": SpeechTranscriber.isAvailable]
            if let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
                let t = SpeechTranscriber(locale: resolved, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
                analyzer["transcriber"] = describe(await AssetInventory.status(forModules: [t]))
            } else {
                analyzer["transcriber"] = "unsupported"
            }
            if let resolved = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
                let d = DictationTranscriber(locale: resolved, preset: .timeIndexedLongDictation)
                analyzer["dictation"] = describe(await AssetInventory.status(forModules: [d]))
            } else {
                analyzer["dictation"] = "unsupported"
            }
            analyzer["installedTranscriberLocales"] = await SpeechTranscriber.installedLocales.map(\.identifier).sorted()
            analyzer["installedDictationLocales"] = await DictationTranscriber.installedLocales.map(\.identifier).sorted()
            out["speechAnalyzer"] = analyzer
        } else {
            out["speechAnalyzer"] = ["available": false]
        }

        let auth: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: auth = "granted"
        case .denied, .restricted: auth = "denied"
        default: auth = "undetermined"
        }
        let recognizer = SFSpeechRecognizer(locale: locale)
        out["sfSpeech"] = [
            "permission": auth,
            "supportsLocale": recognizer != nil,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
            "available": recognizer?.isAvailable ?? false,
        ]
        return out
    }

    @available(macOS 26.0, *)
    private static func describe(_ s: AssetInventory.Status) -> String {
        switch s {
        case .unsupported: return "unsupported"
        case .supported: return "not-installed"
        case .downloading: return "downloading"
        case .installed: return "installed"
        @unknown default: return "unknown"
        }
    }
}
