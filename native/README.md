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
