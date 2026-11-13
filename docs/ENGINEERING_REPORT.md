# Cutaway engineering report

Date: November 12, 2026. Reference machine: MacBook Pro, Apple M1 Pro, 16 GB,
macOS 26.5.1, two external 1920×1080 displays, lid closed.

This is the plan that was followed, what was built, what was measured on real
runs, and what is not done. Nothing here is a UI mock: every result below came
from the built app driving the real native helper.

## 1. Architecture

| Layer | Choice | Why |
| --- | --- | --- |
| Capture | Swift CLI `cutaway-native` (ScreenCaptureKit, AVFoundation) spawned by the app | Host-clock timestamps for every source, cursor excluded from pixels, fragmented movies for crash recovery. See `NATIVE_PROTOCOL.md`. |
| App shell | Electron 45, sandboxed renderer, typed preload bridge | Fast, inspectable UI; the renderer has no Node access. |
| Edit model | `@cutaway/core`, pure TypeScript | One time map (cuts + speed) used by captions, chapters, review, preview and export, so they cannot disagree. |
| Compositor | One Canvas 2D renderer (`engine/compositor.ts`) | Preview and export call the same `evaluateFrame` + `drawFrame`; a frame is a pure function of project and time. |
| Export | WebCodecs via mediabunny (H.264), custom audio mixer, native mux to AAC-LC with BT.709 tags and fast start | Frame-accurate decode per source, hardware encode, no ffmpeg dependency at runtime. |
| Transcription | Apple SpeechAnalyzer on-device (fallback: whisper.cpp if a model file is chosen) | No audio leaves the Mac; needs no permission prompt. |
| AI | Local Claude Code CLI in headless mode (`claude -p --json-schema …`) | No API key. Output is treated as untrusted JSON and must pass `validateOps`. |

Decisions are stored in session time (the shared recording clock) with origin
(AI or creator), revision, reason, confidence and lock, so they stay attached
to content when other cuts change. The AI can only express seven operations
(cut, speed, layout, zoom, overlay, broll, suggest); anything else is rejected
before it can touch a project.

## 2. What was verified, with numbers

Unit tests: 91 passing (core 47, AI layer 31, jobs 13).

| Journey (real app + real helper) | Result |
| --- | --- |
| Two live cameras + screen + mic + system audio, pause/resume, first cut, packaging, export, reopen (`e2e/journey.mjs`, helper synthetic capture mode) | 19/19 checks. Paused 1.5 s absent from the 8.00 s take; all sources start within 0 ms on the shared clock; manual camera-B decision survived the AI pass; package exported; project reopened with same revision, packaging and export history. |
| Recorder killed with SIGKILL at about 6.5 s | Reported as a crash; recovery returned 6.00 s on all five sources (checkpoint tolerance 2 s) and the sources opened in the editor. |
| Import MP4 + MOV + corrupt file, audio sync, first cut, manual zoom/mask/callout, local revision, export (`e2e/firstcut.mjs`) | Corrupt file rejected with a reason. Camera started 1.5 s late: found at +1.5014 s, drift 8 ppm, residual ≤ 0.04 ms at five check points. 59 words transcribed on-device. Cut removed 7 pauses and 1 filler, offered the retake as a suggestion, kept "Do not delete this file". Local "no zooms in this section" changed only that section; locked range and manual zoom untouched; undo restored it. |
| Export of that edit | 772 frames, 1920×1080, 30 fps, H.264 High, AAC-LC 48 kHz stereo, 25.74 s, written in 5.2 s (about 4.9× real time). |
| Package and export UI (`e2e/package-ui.mjs`) | 21/21 checks: three template concepts from real stills, thumbnail edits, title limit, chapter rules, complete folder, `-rev` naming on re-export, cancel leaves nothing, missing media blocks with a relink action, unwritable folder gives a failed state. |
| Real hardware capture (`e2e/real-capture.mjs`) | Main display 1920×1080 at 60 fps nominal (399 frames in 7.02 s on a mostly static screen), 228 cursor samples recorded separately from the pixels, system audio captured on its own track, edited with a cursor-following zoom and exported. |
| Packaged `Cutaway.app` (`e2e/packaged.mjs`) | Boots, finds its bundled helper, probes, analyses and imports media. |

Core behaviours covered by unit tests: time map through cuts and speed;
captions after trim and 2× speed; spelling correction never cuts footage;
negations become suggestions, never silent cuts; locks and restored footage
are carved out of AI operations; camera B is never shown outside coverage;
audio sync with 600 ppm drift stays within one frame; unrelated recordings are
not reported as synced; a wait followed by a visible result is kept; a silent
demo is edited from screen activity; masks stay active through zoom and layout
changes; packaging is marked stale after a material cut; chapters obey YouTube
rules; export folders are never reused; missing media or low disk blocks a
complete export.

## 3. Not verified, and why

| Item | Status |
| --- | --- |
| **Claude editorial pass and AI thumbnail/title concepts** | Code and prompts are written and tested against a fake CLI. No real model call was possible: neither `claude` install on this Mac is signed in. Until `/login`, cuts use built-in rules and say so. |
| **Camera capture and camera previews** | Code-complete. Camera permission on this Mac is undetermined and granting it is the owner's action. |
| **Two physical cameras at once** | Verified only through the helper's synthetic mode (same clock, writers, manifest and recovery code). One camera is attached here. |
| Microphone content | The mic delivered digital silence (lid closed). The helper warns about it; capture structure was verified. |
| Window capture, real device unplug, real disk-full | Written; only the simulated paths ran. |
| 4K and 60 fps export, 30-minute and 10-minute 4K envelopes | Not run. Only 1080p30 was measured. |
| VoiceOver, keyboard-only pass, 1280×800 layout | Labels, focus styles and reduced motion exist; not audited. |
| One renderer crash | Seen once in an early run (before a fix to the voice-track choice), not reproduced in any later run. Crash logging is now in place. |

## 4. Known gaps against the product package

* **Colour tag.** Primaries and matrix are BT.709; the transfer characteristic
  in the H.264 stream is tagged sRGB (IEC 61966-2-1) because the frames come
  from an sRGB canvas. Players treat both as SDR; strict BT.709 transfer
  tagging needs an SPS rewrite in the mux step.
* **Speed changes shift voice pitch.** There is no time-stretch; above about
  1.5× voices sound higher.
* **Voice cleanup is modest.** An 85 Hz high-pass and level normalisation,
  identical in preview and export. It is not noise reduction.
* **Reordering and opening hooks** are offered as notes only; the edit model
  is chronological.
* **Retry after a failed export** starts a fresh export rather than resuming.
* **Remote deletion.** Cutaway cannot delete what Claude Code sent; the
  consent sheet says so.
* **Analytics and diagnostics sharing** do not exist (nothing is collected).

## 5. Screen Studio parity

**Design.** The interface follows Screen Studio 4's editor, from values measured
on its public screenshots (see the research notes summarised in the commit
history): one flat `#08090d` surface, 59 px top bar with folder, trash,
centred title, command menu, undo/redo, Presets and an indigo Export; shape and
crop above the preview; a floating tool pill; transport under the preview; a
60 px icon rail beside a 360 px inspector card; a dotted ruler, amber clip
track and indigo zoom track with two-line block labels; contextual editors
that replace the card ("Close Zoom editor"); a glass recorder bar; and an
export sheet with Format, Frame rate, Resolution, Compression and Export to.
Names, icons, wallpapers and device bezels are Cutaway's own.

**Built in the first pass:** display, window and area capture; camera,
microphone and system audio as separate tracks; pause, resume, countdown,
global shortcut; crash recovery; MP4/MOV import; cuts and segment speed;
transcript cuts; filler and pause cleanup; crop; manual and click-based zooms;
cursor smoothing, size, idle hiding and click ripple; four layouts with
animated transitions; camera shape, size, corner and mirror; backgrounds;
padding, corners, inset and shadow; masks; presets; music and levels; captions
and SRT; MP4 export; autosave and backups.

**Added in the parity pass** (each verified in exported pixels or files by
`e2e/render-parity.mjs` 23/23 and `e2e/package-ui.mjs` 27/27 unless noted):
motion blur; magnifier (loupe) and instant zoom styles; cursor types, rotate
while moving, shake removal, loop position, click sound; keyboard-shortcut key
caps (shortcuts only: typed characters are never recorded); typing speed-up;
camera looks; face framing and background removal (render path verified with
seeded data only: no footage with a person was available); generic device
frames; Vertical, Square, Classic and Tall output shapes; iPhone/iPad capture
(code only: no device attached); per-app system audio; hide desktop icons and
notifications; window size presets (needs Accessibility; not exercised);
speaker notes with prompter; GIF export; copy to clipboard; compression tiers;
project sharing as a zip; on-device voiceover with system voices; ⌘K command
menu; ⌘1–8 tab shortcuts; "Remove N filler words" and "Tighten N pauses".

**Still not built:** hosted shareable links and view analytics (there is no
Cutaway server), Unsplash backgrounds (needs an API account), LUT import,
sharpening, automatic sensitive-data detection for masks, ProRes export, the
quick-share widget after recording, flags during recording, a standalone
crop window, and editable shortcut bindings. Screen Studio's own wallpapers,
cursor art, click sounds and device artwork were not copied.

No Screen Studio binary was inspected: the app is not installed on this Mac
and it was not downloaded. Evidence used: the public site and guides, the
three reference screenshots supplied by the owner, and the leftover
preferences file on this Mac.

## 6. Decisions that are yours

1. **Name and identity.** "Cutaway" is a working choice; no trademark search
   was done beyond a quick web check.
2. **Sign in to Claude Code** so the editorial pass can be evaluated on real
   footage. Prompt quality is untested until then.
3. **Reverse engineering Screen Studio.** If you want binary inspection for
   the remaining parity items, the app has to be installed first; check its
   licence terms before doing so.
4. **Distribution.** The package is ad-hoc signed for this Mac. Sharing it
   needs a Developer ID, hardened runtime entitlements and notarisation.
5. **Support floor and envelopes.** Qualify 4K, 60 fps, long takes and real
   two-camera hardware before promising them.
6. **Whisper fallback.** Optional; only used if you pick a model file in
   Settings.
