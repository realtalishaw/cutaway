import Foundation

// cutaway-native — capture, media and on-device speech helper for the Cutaway desktop app.
// Protocol: docs/NATIVE_PROTOCOL.md. JSON on stdout, diagnostics on stderr.

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
    Out.fail(CLIError("usage", "cutaway-native <devices|preflight|probe|pcm|frames|activity|transcribe|mux|recover|record> …"))
}
let rest = Array(argv.dropFirst())

switch command {
case "devices":
    runCommand { try await DevicesCommand.run() }
case "preflight":
    let a = Args(rest)
    runCommand { try await PreflightCommand.run(configPath: try a.require("config")) }
case "probe":
    runCommand { try await ProbeCommand.run(Args(rest).positional) }
case "pcm":
    runCommand { try await PcmCommand.run(Args(rest)) }
case "frames":
    runCommand { try await FramesCommand.run(Args(rest)) }
case "activity":
    runCommand { try await ActivityCommand.run(Args(rest)) }
case "transcribe":
    runCommand { try await TranscribeCommand.run(Args(rest, flagNames: ["allow-model-download"])) }
case "_sfspeech":
    runCommand { try await TranscribeCommand.runSFSpeechChild(Args(rest)) }
case "speech-status":
    runCommand { try await SpeechStatusCommand.run(Args(rest)) }
case "mux":
    runCommand { try await MuxCommand.run(Args(rest)) }
case "recover":
    runCommand { try await RecoverCommand.run(Args(rest)) }
case "record":
    RecordCommand.run(Args(rest))
case "version", "--version":
    print(Out.line(["version": "0.1.0", "protocol": 1]))
    exit(0)
default:
    Out.fail(CLIError("usage", "unknown command '\(command)'"))
}
