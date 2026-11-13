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

### `devices [--wait-external 0.4]`
```json
{
  "permissions": { "screen": "granted|undetermined", "camera": "granted|denied|undetermined", "microphone": "…",
                   "accessibility": "granted|undetermined", "inputMonitoring": "granted|denied|undetermined" },
  "displays": [{ "id": 1, "name": "Built-in Retina Display", "width": 1728, "height": 1117, "scale": 2, "x": 0, "y": 0, "main": true }],
  "windows":  [{ "id": 4242, "title": "Docs", "app": "Safari", "bundleId": "com.apple.Safari", "x": 0, "y": 0, "width": 1200, "height": 800, "displayId": 1 }],
  "cameras":  [{ "id": "<AVCaptureDevice.uniqueID>", "name": "FaceTime HD Camera", "formats": [{ "width": 1920, "height": 1080, "maxFps": 30 }] }],
  "microphones": [{ "id": "<uniqueID>", "name": "MacBook Pro Microphone", "default": true }],
  "externalDevices": [{ "id": "<uniqueID>", "name": "Talisha's iPhone", "width": 1170, "height": 2532, "kind": "iphone|ipad|null" }],
  "apps": [{ "bundleId": "com.google.Chrome", "name": "Google Chrome", "pid": 812 }]
}
```
`accessibility` and `inputMonitoring` are read without prompting; macOS cannot
tell "never asked" from "denied" for Accessibility. `externalDevices` are
iPhones and iPads connected by cable (unlocked and trusted) that can be
recorded as the screen source; they appear a moment after the helper opts in,
so `--wait-external <seconds>` (default 0.4, max 10) sets how long to wait.
`apps` are the running regular apps, for per-app audio.
Windows are listed only when screen permission is granted; never prompt from `devices`.
macOS cannot tell "never asked" from "denied" for screen recording, so `screen`
is `granted` or `undetermined`. Display and window coordinates are global
display points with a top-left origin (Core Graphics space). Continuity Camera
devices (an iPhone) appear in `cameras`.

### `request-screen [--check]`

Screen Recording access as this process sees it: `{"screen": "granted"|"undetermined", "asked": bool}`.
Without `--check` it calls `CGRequestScreenCaptureAccess()`, which shows the macOS prompt the first
time and adds the responsible app (Cutaway, or the terminal that started a development build) to
System Settings → Privacy & Security → Screen & System Audio Recording. macOS cannot tell "never
asked" from "switched off", so the app remembers that it asked (`screenAccessAsked` in settings).
The app always checks through the helper rather than Electron, because a new process sees a grant
at once while the running app keeps the answer it got at launch.

### `preflight --config <file>`
Same config as `record`. Validates without recording or prompting:
`{ "ok": true|false, "issues": [{ "code": "duplicate-camera|unsupported-format|missing-device|permission-denied|low-disk|multicam-unsupported|no-sources|keys-unavailable|app-audio-unavailable", "source": "cameraB"|null, "message": "…", "alternatives": ["1280x720@30"], "blocking": true|false }], "estimatedBytesPerMinute": 123456789, "freeBytes": 1234567890 }`

`blocking: false` marks a warning (`keys-unavailable`, `app-audio-unavailable`):
the take can still be recorded, and `ok` only reflects blocking issues.

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

### `mux --video <mp4> [--audio <wav|m4a>] --out <mp4|mov> [--codec h264|prores422]`
`h264` (default): copies the H.264 video samples untouched, encodes audio to
AAC-LC 48 kHz stereo if given, moves `moov` to the front, and makes the colour
description BT.709 in both places players look: the stream (the SPS VUI inside
`avcC` is rewritten to primaries/transfer/matrix 1/1/1, every other bit kept)
and the container (a `colr`/`nclx` box). Pixel values are not changed.
`prores422`: decodes the video and writes Apple ProRes 422 in a QuickTime
movie (`--out` should end in `.mov`) with 16-bit PCM 48 kHz stereo sound,
tagged BT.709. Frames are labelled BT.709 before encoding, so no transfer
conversion is applied.
Prints `{ "path", "duration", "sizeBytes", "bt709Tagged": true, "codec" }`
(`"frames"` too for ProRes). Never overwrites: an existing `--out` returns
error code `exists`.

### `recover <takeDir>`
Validates a take left behind by a crash. Fragmented movies are readable up to
the last checkpoint. Rewrites `manifest.json` with real durations and
`"complete": false, "recovered": true`. Prints the manifest. Each source gains
`"readable": true|false`; the manifest gains `"usableSources": n`. A take that
is already complete is returned unchanged. A torn last line of `keys.jsonl` is
trimmed the same way as `cursor.jsonl`, and `keys.events` is recounted.

### `resize-window --window-id <id> --width <w> --height <h> [--x <x> --y <y>]`
Resizes (and optionally moves) another app's window through the Accessibility
API, in global display points. Prints
`{ "windowId": 4242, "x": 0, "y": 25, "width": 1280, "height": 720, "exact": true }`
with the size the app actually accepted (`exact:false` when it clamped it).
Errors: `permission-denied` (Accessibility is not granted; never prompts),
`not-found`, `resize-failed`.

### `faces <video> [--fps 5]`
Largest face per sampled frame (Vision), for keeping a camera crop on the
speaker. Rects are normalised to the upright picture with a top-left origin.
```json
{ "fps": 5, "found": 2,
  "samples": [{ "t": 0.0, "x": 0.41, "y": 0.22, "w": 0.2, "h": 0.3 }, { "t": 0.2, "none": true }] }
```

### `matte <video> --out <mov> [--fps 30] [--quality fast|balanced|accurate]`
Person-segmentation matte (white = person) as a greyscale, full-range H.264
`.mov` in the upright orientation, long side at most 720 px. Frames keep the
input's own timestamps and the file has the input's duration; `--fps` only
caps how many frames are analysed (skipped frames hold the previous matte).
Progress lines (`progress 0.35`) go to stderr. Prints
`{ "path": "…", "duration": 36.634, "frames": 1099, "width": 720, "height": 404, "quality": "balanced", "framesWithPerson": 0 }`.
Refuses to overwrite (`exists`).

### `gif --video <mp4> --out <gif> [--fps 15] [--width 800] [--start s --duration s]`
Looping GIF with per-frame delays (ImageIO). Prints
`{ "path": "…", "frames": 60, "sizeBytes": 9845, "width": 640, "height": 360, "fps": 12, "duration": 5 }`.
Errors: `too-long` (more than 3000 frames), `exists`, `no-video`.

### `voices`
On-device system voices:
`[{ "id": "com.apple.voice.compact.en-US.Samantha", "name": "Samantha", "language": "en-US", "quality": "default|enhanced|premium" }]`

### `speak --text-file <txt> --out <wav> [--voice <id>] [--rate 0.5]`
Synthesises speech on this Mac (AVSpeechSynthesizer) into a 16-bit WAV. `rate`
is 0…1 (0.5 is normal). Prints
`{ "path": "…", "duration": 3.912, "sampleRate": 22050, "channels": 1, "voice": "<id>", "marks": [{ "word": "Cutaway", "start": 0.0, "end": 0.54 }] }`.
`marks` is present only when the voice reports word positions; the system
voices tested do not, so run `transcribe` on the WAV when word timings are needed.
Errors: `voice-unavailable`, `exists`, `speak-failed`.

### `version`
`{ "version": "0.2.0", "protocol": 1, "features": ["device-screen", "hide-desktop-icons", "hide-notifications", "app-audio", "keys", "resize-window", "faces", "matte", "gif", "voices", "speak"] }`

## `record --config <file> [--duration <seconds>]` (long-running)

Config:
```json
{
  "outDir": "/…/My Project.cutaway/media/take-001",
  "fps": 60,
  "screen": { "type": "display|window|region|device", "displayId": 1, "windowId": 4242, "deviceId": "<externalDevices id>",
              "rect": { "x": 100, "y": 100, "width": 1280, "height": 720 },
              "showCursor": false, "excludeBundleIds": ["studio.cutaway.app"], "maxHeight": 2160,
              "hideDesktopIcons": false, "hideNotifications": false },
  "cameras": [{ "slot": "A", "deviceId": "…", "width": 1920, "height": 1080, "fps": 30 },
              { "slot": "B", "deviceId": "…", "width": 1920, "height": 1080, "fps": 30 }],
  "microphone": { "deviceId": "…" },
  "systemAudio": true,
  "captureKeys": false,
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

* `screen.type: "device"` records a connected iPhone or iPad (`deviceId` from
  `devices.externalDevices`) as `screen.mov`. macOS guards it with Camera
  permission. There is no pointer to record, so no `cursor.jsonl` is written and
  the manifest source has `"cursorBaked": true, "captureType": "device",
  "deviceKind": "iphone"|"ipad"|null`. Device audio is not recorded.
* `screen.hideDesktopIcons` leaves Finder's desktop-icon windows out of a display
  or region capture; `screen.hideNotifications` leaves Notification Centre
  banners out. Both only change what is captured: nothing on the desktop or in
  System Settings is touched. With icons hidden, a Finder window opened during
  the take is re-admitted within about a second.
* `systemAudio` is `true`, `false`, or `{ "apps": ["bundle.id", …] }` to record
  sound from those apps only (a second audio-only stream; the manifest's system
  source lists `"apps"`). If none of them is running the take continues without
  a system track and a non-fatal `app-audio-unavailable` error is emitted.
* `captureKeys: true` writes `keys.jsonl` from a listen-only event tap, for the
  shortcut overlay and typing detection. **Typed characters are never read or
  stored.** Only two kinds of line exist:
  `{"t":1.2,"e":"shortcut","keys":["cmd","shift","4"]}` when ⌘, ⌃ or ⌥ is held or
  the key is return/enter/tab/escape/delete/an arrow/home/end/page/F-key (names
  come from a fixed key-code table, modifiers first in the order cmd, ctrl,
  alt, shift), and `{"t":1.3,"e":"type"}` for any other key press, with no key.
  Without Input Monitoring permission nothing is tapped (macOS is never made to
  prompt), a non-fatal `keys-unavailable` error is emitted and the take
  continues with `"keys": null`.
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
  an unplugged device. Synthetic mode also honours `captureKeys` (a made-up
  repeating pattern of shortcuts and typing ticks) and `screen.type: "device"`
  (a 590×1280 portrait picture, `deviceKind: "iphone"`, no cursor file).

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
  `microphone-error`, `screen-stopped`, `device-error`, `keys-unavailable`,
  `app-audio-unavailable`.
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
  keys.jsonl      only with captureKeys: {"t":1.2,"e":"shortcut","keys":["cmd","k"]} | {"t":1.3,"e":"type"}
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
  "keys": { "file": "keys.jsonl", "events": 212 },
  "stopReason": "disk-low" }
```
`cursor` is `null` when no pointer is recorded (camera-only takes, device
screens). `keys` is `null` unless `captureKeys` was on and Input Monitoring was
granted. The screen source also carries `hideDesktopIcons` / `hideNotifications`
as recorded, and for device screens `deviceKind`, `deviceName`, `deviceId`. The
system source carries `"apps": […]` when it was limited to selected apps.
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

## Recording flags (added)

`record` accepts one more stdin command while a take is running or paused:

| Command | Effect |
| --- | --- |
| `flag` | Marks the current moment. Emits `{"type":"flag","elapsed":<take seconds>,"count":<n>}`. Two presses within 0.25 s are one flag. |

Flags are written to `manifest.json` as `"flags": [<take seconds>, …]`, in order. The manifest is rewritten
immediately on every flag, so a crash keeps them; `recover` drops any flag past the recovered duration.
The app registers the global shortcut (⌃⌥F by default, editable) only while a take is running, and copies
the flags onto the project (`Project.flags`, session time) when the take is added.

## `screen-text` (added)

```
cutaway-native screen-text <video> [--interval 1] [--start S] [--end S] [--width 2560]
```

Recognises text on sampled frames of a screen recording with Vision, on this Mac, for the editor's
"Find sensitive data". Output:

```json
{ "interval": 1, "start": 0, "end": 8, "duration": 8, "width": 1920, "height": 1080, "recognised": 4,
  "frames": [ { "t": 2.0, "lines": [ { "text": "…", "box": {"x":0.06,"y":0.29,"w":0.42,"h":0.04},
                                         "tokens": [ {"start":0,"end":8,"box":{…}} ] } ] } ] }
```

- Boxes are normalised to the frame with the origin at the top-left. `tokens` are the whitespace-separated
  pieces of the line; `start`/`end` are UTF-16 offsets into `text`.
- A frame whose picture has not changed reuses the previous result (`recognised` counts real passes); it is
  still re-read every fifth sample.
- Language correction is off, so keys, addresses and numbers come back as written.
- Privacy: the command writes nothing to disk and logs no text. The app's main process classifies each line
  in memory (`findSensitive` in `packages/core/src/sensitive.ts`) and passes on only a category and a box;
  the recognised text never reaches the renderer, the project file or a log.
