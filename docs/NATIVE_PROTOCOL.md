# `cutaway-native` helper protocol

The Electron app never touches capture APIs directly. It spawns one Swift CLI,
`cutaway-native`, built from `native/` (SwiftPM, product `cutaway-native`,
release binary at `native/.build/release/cutaway-native`). Every subcommand
prints **JSON on stdout** and human-readable diagnostics on **stderr**. Exit
code 0 means the JSON is a result; non-zero means stdout carries
`{"error":{"code":"…","message":"…"}}`. (`record` reports failures as `error`
events instead, see below.)

All times are **seconds as doubles**. "Session time" is the shared recording
clock: zero at the first captured sample of the take, with paused intervals
removed, so every source of one take lines up on the same axis.

Permissions belong to the *responsible process*: when the app spawns the helper,
macOS attributes Screen Recording, Camera, Microphone and Speech Recognition to
the app, so the app's `Info.plist` needs `NSCameraUsageDescription`,
`NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`. The
helper embeds the same strings for standalone use. It never changes system
settings and never waits on a permission prompt for more than 60 s.

## One-shot commands

### `devices`
```json
{
  "permissions": { "screen": "granted|undetermined", "camera": "granted|denied|undetermined", "microphone": "…" },
  "displays": [{ "id": 1, "name": "Built-in Retina Display", "width": 1728, "height": 1117, "scale": 2, "x": 0, "y": 0, "main": true }],
  "windows":  [{ "id": 4242, "title": "Docs", "app": "Safari", "bundleId": "com.apple.Safari", "x": 0, "y": 0, "width": 1200, "height": 800, "displayId": 1 }],
  "cameras":  [{ "id": "<AVCaptureDevice.uniqueID>", "name": "FaceTime HD Camera", "formats": [{ "width": 1920, "height": 1080, "maxFps": 30 }] }],
  "microphones": [{ "id": "<uniqueID>", "name": "MacBook Pro Microphone", "default": true }]
}
```
Windows are listed only when screen permission is granted; never prompt from `devices`.
macOS cannot tell "never asked" from "denied" for screen recording, so `screen`
is `granted` or `undetermined`. Display and window coordinates are global
display points with a top-left origin (Core Graphics space). Continuity Camera
devices (an iPhone) appear in `cameras`.

### `preflight --config <file>`
Same config as `record`. Validates without recording or prompting:
`{ "ok": true|false, "issues": [{ "code": "duplicate-camera|unsupported-format|missing-device|permission-denied|low-disk|multicam-unsupported|no-sources", "source": "cameraB"|null, "message": "…", "alternatives": ["1280x720@30"] }], "estimatedBytesPerMinute": 123456789, "freeBytes": 1234567890 }`

`alternatives` lists other camera formats (`unsupported-format`) or other
device names (`duplicate-camera`, `missing-device`). A built-in camera behind a
closed lid is reported as `missing-device` ("suspended").

### `probe <file> [<file>…]`
```json
[{ "path": "…", "ok": true, "kind": "video|audio|image",
   "duration": 12.5, "sizeBytes": 123,
   "video": { "width": 1920, "height": 1080, "fps": 29.97, "variableFrameRate": false, "codec": "avc1", "rotation": 0, "colorPrimaries": "ITU_R_709_2", "hdr": false },
   "audio": { "channels": 2, "sampleRate": 48000, "codec": "aac " },
   "image": { "width": 800, "height": 600 },
   "createdAt": "ISO-8601 or null",
   "error": null }]
```
Unreadable/corrupt/protected files come back with `ok:false` and an
`error: { code: "corrupt|unsupported-codec|protected|not-found", message }`.
`image` is present only for stills (`video` is then null). `colorPrimaries` is
null when the file carries no colour tag.

### `pcm <file> --out <path> [--rate 16000]`
Writes mono little-endian float32 PCM. Prints `{ "path", "sampleRate", "samples", "duration" }`.
Files without audio return error code `no-audio`.

### `frames <file> --times 1.0,2.5,9 --width 640 --out-dir <dir> [--prefix f]`
Exact-time JPEG stills (tolerance zero). Prints `[{ "t": 1.0, "path": "…/f-000001000.jpg", "width": 640, "height": 360 }]`.
Times past the end are clamped to the last frame.

### `activity <video> [--fps 4] [--width 96]`
Cheap visual-change score per sampled frame for silent demos:
`{ "fps": 4, "samples": [{ "t": 0.0, "change": 0.0 }, …] }` where `change` is the
mean absolute luma difference to the previous sample, 0…1. A sample shows the
frame that is on screen at `t`, so variable-rate screen recordings score 0 while
nothing changes.

### `transcribe <audio-or-video> [--locale en-US] [--engine auto|speechanalyzer|sfspeech] [--allow-model-download]`
On-device only. Never sends audio off the Mac.
```json
{ "engine": "apple-speechanalyzer|apple-sfspeech", "locale": "en-US", "onDevice": true,
  "words": [{ "text": "Hello", "start": 0.42, "end": 0.71, "confidence": 0.93 }],
  "hasSpeech": true, "duration": 11.79 }
```
Errors: `speech-permission-denied`, `speech-model-unavailable`, `no-audio`.
A file with audio but no speech returns `hasSpeech:false, words:[]` (not an error).

* Engine order: macOS 26 `SpeechAnalyzer` + `SpeechTranscriber` first (needs no
  Speech Recognition permission), then `SFSpeechRecognizer` with
  `requiresOnDeviceRecognition` (needs the permission).
* A model that is already on the Mac is reserved automatically. A model that is
  not installed is only fetched by macOS when `--allow-model-download` is given.
* Words keep their punctuation ("tutorial."). Each word's range is tightened to
  the audible energy inside it, so gaps between words are real pauses.

### `speech-status [--locale en-US]`
No prompt, no download:
`{ "locale", "speechAnalyzer": { "available", "transcriber": "installed|not-installed|downloading|unsupported", "dictation": "…", "installedTranscriberLocales": [], "installedDictationLocales": [] }, "sfSpeech": { "permission": "granted|denied|undetermined", "supportsLocale", "onDevice", "available" } }`

### `mux --video <mp4> [--audio <wav|m4a>] --out <mp4>`
Copies the H.264 video samples untouched, encodes audio to AAC-LC 48 kHz
stereo if given, tags BT.709 (a `colr`/`nclx` box), moves `moov` to the front.
Prints `{ "path", "duration", "sizeBytes", "bt709Tagged": true }`. Never
overwrites: an existing `--out` returns error code `exists`.

### `recover <takeDir>`
Validates a take left behind by a crash. Fragmented movies are readable up to
the last checkpoint. Rewrites `manifest.json` with real durations and
`"complete": false, "recovered": true`. Prints the manifest. Each source gains
`"readable": true|false`; the manifest gains `"usableSources": n`. A take that
is already complete is returned unchanged.

## `record --config <file> [--duration <seconds>]` (long-running)

Config:
```json
{
  "outDir": "/…/My Project.cutaway/media/take-001",
  "fps": 60,
  "screen": { "type": "display|window|region", "displayId": 1, "windowId": 4242,
              "rect": { "x": 100, "y": 100, "width": 1280, "height": 720 },
              "showCursor": false, "excludeBundleIds": ["studio.cutaway.app"], "maxHeight": 2160 },
  "cameras": [{ "slot": "A", "deviceId": "…", "width": 1920, "height": 1080, "fps": 30 },
              { "slot": "B", "deviceId": "…", "width": 1920, "height": 1080, "fps": 30 }],
  "microphone": { "deviceId": "…" },
  "systemAudio": true,
  "checkpointSeconds": 2,
  "minFreeBytes": 2000000000,
  "waitForStart": false,
  "maxDuration": null,
  "synthetic": false
}
```
`screen`, `cameras`, `microphone` are each optional; at least one source is required.
`rect` is in global display points and applies to `region`. Camera
`width`/`height`/`fps` are optional (default: the largest format up to 1080p at
30 fps). An empty microphone `deviceId` means the system default.

* `waitForStart: true` opens devices, emits `ready`, and waits for a `start`
  command, so the app can spawn the helper during its countdown and begin on
  the beat. Otherwise recording starts right after `ready`.
* `maxDuration` (or `--duration`) stops the take by itself.
* `synthetic: true` is a **test mode**: generated pictures and tones replace the
  devices but run through the same clock, writers, checkpoints, manifest and
  recovery code. It needs no permission. Every video source shows a bar that
  sweeps once per 2 s of host time and every audio source beeps for 100 ms at
  each host-clock second, so alignment can be measured. In this mode the
  commands `simulate-lost <sourceId>` and `simulate-restore <sourceId>` imitate
  an unplugged device.

Control: newline-terminated commands on **stdin**: `start` (only with
`waitForStart`), `pause`, `resume`, `stop`, `cancel`. SIGTERM/SIGINT behave like
`stop` (finalize files). Closing stdin also stops and finalizes (unless a duration is set), so a dead
parent never leaves a recorder running. `cancel` deletes the take.

Events: one JSON object per line on **stdout**.
```
{"type":"ready"}                                    // writers prepared, devices open
{"type":"started","at":"ISO","sources":[{"id":"screen","file":"screen.mov"}, …]}
{"type":"tick","elapsed":3.2,"frames":{"screen":192,"cameraA":96},"dropped":{"screen":0},"freeBytes":…,"paused":false}   // ~4 Hz
{"type":"levels","microphone":-18.2,"system":-41.0}  // dBFS peak, ~10 Hz; -120 is digital silence
{"type":"paused","elapsed":10.0} / {"type":"resumed","elapsed":10.0}
{"type":"checkpoint","elapsed":12.0}                // manifest + cursor flushed; safe point
{"type":"source-lost","source":"cameraB","elapsed":14.2,"reason":"disconnected|stalled|no-data|error|writer-failed|capture-stopped|stopped-by-user"}
{"type":"source-restored","source":"cameraB","elapsed":19.0}
{"type":"disk-low","freeBytes":…}                   // recording stops itself right after
{"type":"error","code":"…","message":"…","source":"…","fatal":true|false}
{"type":"stopped","manifest":{…}}                    // always last on a clean stop
```
* A **fatal** `error` (permission-denied, missing-device, duplicate-camera,
  unsupported-format, low-disk, bad-config, capture-failed, writer-failed) is
  the last line and the process exits 1 without leaving an empty take folder.
* Non-fatal codes: `microphone-silent` (3 s of pure digital silence: muted
  input, closed lid or blocked permission), `writer-failed`, `camera-error`,
  `microphone-error`, `screen-stopped`.
* After `cancel` the last line is `{"type":"stopped","cancelled":true,"manifest":null}`.
* A lost source never stops the others. Its file keeps growing again when it
  comes back; the missing stretch is listed in `gaps`.

Take directory:
```
take-001/
  screen.mov      H.264 High, 8-bit SDR BT.709, no baked cursor when showCursor=false
  camera-a.mov    H.264 High, independent, untouched camera A
  camera-b.mov    H.264 High, independent, untouched camera B
  mic.mov         AAC-LC 48 kHz microphone, own file
  system.mov      AAC-LC 48 kHz stereo system audio, own file
  cursor.jsonl    {"t":1.234,"x":0.51,"y":0.42,"c":"arrow|ibeam|pointer|grab|resize|other","e":"move|down|up|rdown|rup"}
  manifest.json
```
Video is **always H.264** (never HEVC) so the files decode inside Chromium. The
screen is scaled to fit the H.264 hardware limit of 4096×2304 and `maxHeight`.
Key frames come at least every 2 s; frames are not reordered. The screen track
has a variable frame rate: frames are written when the picture changes, plus a
repeat every 0.5 s while it is idle.

While recording, all movies are written with ≤2 s movie fragments, so a killed
process leaves media that plays up to the last fragment. A cleanly stopped take
is consolidated by AVFoundation into a regular movie (`ftyp, wide, mdat, moov`,
no `moof`).

`x`/`y` in `cursor.jsonl` are normalised 0…1 inside the captured rect (top-left
origin); samples outside the rect are still written (values <0 or >1). The
pointer is polled at ~120 Hz; a `move` line is written when it moves, when the
cursor shape changes, and once a second while idle. A captured window is
followed when it moves.

`manifest.json`:
```json
{ "version": 1, "takeId": "take-001", "startedAt": "ISO", "duration": 62.4, "fps": 60,
  "complete": true, "recovered": false,
  "pauses": [{ "at": 10.0, "wallDuration": 4.2 }],
  "sources": [
    { "id": "screen",  "role": "screen",  "file": "screen.mov",  "start": 0.0,   "duration": 62.4, "width": 3456, "height": 2234, "pointWidth": 1728, "pointHeight": 1117, "originX": 0, "originY": 0, "scale": 2, "fps": 60, "codec": "avc1", "captureType": "display", "cursorBaked": false, "frames": 3120, "droppedFrames": 0, "gaps": [] },
    { "id": "cameraA", "role": "cameraA", "file": "camera-a.mov", "start": 0.013, "duration": 62.38, "width": 1920, "height": 1080, "fps": 30, "codec": "avc1", "deviceName": "FaceTime HD Camera", "deviceId": "…", "frames": 1871, "droppedFrames": 0, "gaps": [] },
    { "id": "cameraB", "role": "cameraB", "file": "camera-b.mov", "start": 0.021, "duration": 62.37, "gaps": [{ "start": 14.2, "end": 19.0, "reason": "disconnected" }] },
    { "id": "microphone", "role": "voice", "file": "mic.mov", "start": 0.004, "duration": 62.4, "channels": 1, "sampleRate": 48000, "codec": "aac ", "deviceName": "…", "deviceId": "…", "measuredRate": 1.000004, "gaps": [] },
    { "id": "system", "role": "systemAudio", "file": "system.mov", "start": 0.0, "duration": 62.4, "channels": 2, "sampleRate": 48000, "gaps": [] }
  ],
  "cursor": { "file": "cursor.jsonl", "samples": 7421 },
  "stopReason": "disk-low" }
```
`start` is each file's first-sample position on the session clock, taken from
the capture host-time stamps, so two cameras recorded together are aligned by
construction: file time `t` of a source sits at session time `start + t`.
`gaps` are session-time ranges where the source produced nothing.

* Audio files stay on the session clock sample-accurately: overlap after a
  pause is trimmed and every real gap (pause edge, stall, reconnect) is filled
  with silence, because AVFoundation otherwise packs audio back to back.
* `measuredRate` (audio, takes over 10 s without gaps) is audio seconds written
  per session second. 1.0 means the device clock matches the host clock; use it
  to correct drift on long takes.
* `stopReason` appears when the take did not end with `stop`
  (`max-duration`, `disk-low`, `signal`, `stdin-closed`).
* A source that never produced data has `"empty": true` and no file.
* `manifest.json` is rewritten at every checkpoint with `"complete": false`, so
  `recover` knows each source's `start` after a crash.
