# cutaway-native

Swift helper for the Cutaway desktop app: capture (ScreenCaptureKit + AVFoundation),
media probing, exact frames, PCM extraction, on-device transcription, MP4 finishing
and crash recovery. The contract is `docs/NATIVE_PROTOCOL.md`.

```bash
swift build -c release --product cutaway-native
.build/release/cutaway-native devices
```

## Testing without capture permission

`"synthetic": true` in a record config replaces the devices with generated
pictures and tones that run through the same clock, writers, checkpoints and
manifest code. `scripts/synccheck.py <takeDir> <binary>` then measures
audio/video alignment of the take from the bar position in each frame and the
beep at each host-clock second (needs `ffmpeg`/`ffprobe` on PATH).

```bash
cat > /tmp/syn.json <<'JSON'
{ "outDir": "/tmp/cutaway-syn-take", "fps": 60, "synthetic": true,
  "screen": { "type": "display" },
  "cameras": [{ "slot": "A", "deviceId": "a" }, { "slot": "B", "deviceId": "b" }],
  "microphone": {}, "systemAudio": true }
JSON
.build/release/cutaway-native record --config /tmp/syn.json --duration 6 < /dev/null
python3 scripts/synccheck.py /tmp/cutaway-syn-take .build/release/cutaway-native
```

Real capture needs Screen Recording, Camera and Microphone permission for the
app that launches the helper.

## Parity additions (0.2.0)

`devices` now also reports Accessibility / Input Monitoring status, connected
iPhones and iPads (`externalDevices`) and running apps. `record` accepts
`screen.type: "device"`, `screen.hideDesktopIcons`, `screen.hideNotifications`,
`systemAudio: { "apps": [...] }` and `captureKeys`. New one-shot commands:
`resize-window`, `faces`, `matte`, `gif`, `voices`, `speak`. Shapes are in
`../docs/NATIVE_PROTOCOL.md`.

Key capture never stores what is typed: only shortcut names from a fixed
key-code table, and character-free "typed" ticks.

```bash
B=.build/release/cutaway-native
$B gif --video clip.mp4 --out clip.gif --fps 12 --width 640 --start 8 --duration 5
$B voices | head -c 300
$B speak --text-file script.txt --out voice.wav
$B faces camera.mov --fps 5
$B matte camera.mov --out matte.mov          # progress on stderr
```

Measured on the reference Mac: a 36.6 s 1280×720 clip mattes in 27.8 s
(balanced) with frame timestamps identical to the source (max 0.017 ms apart);
a 5 s, 60-frame GIF writes in about 3 s. No footage with a person or face was
available, so matte and face quality are unverified beyond running, decoding
and timing. iPhone/iPad capture, the real key tap and window resizing need
hardware or permissions that were not available.
