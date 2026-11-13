# Cutaway engineering report

Date: November 13, 2026. Reference machine: MacBook Pro, Apple M1 Pro, 16 GB,
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
| AI | Local Claude Code CLI (`claude -p --json-schema …`) or local Codex CLI (`codex exec`, read-only sandbox), chosen in Settings | No API key. Output is treated as untrusted JSON and must pass `validateOps`. Generated pictures come from Codex's image tool only. |

Decisions are stored in session time (the shared recording clock) with origin
(AI or creator), revision, reason, confidence and lock, so they stay attached
to content when other cuts change. The AI can only express seven operations
(cut, speed, layout, zoom, overlay, broll, suggest); anything else is rejected
before it can touch a project.

## 2. What was verified, with numbers

Unit tests: 211 passing (core 87, AI layer 75, desktop 49).

| Journey (real app + real helper) | Result |
| --- | --- |
| Two live cameras + screen + mic + system audio, pause/resume, first cut, packaging, export, reopen (`e2e/journey.mjs`, helper synthetic capture mode) | 19/19 checks. Paused 1.5 s absent from the 8.00 s take; all sources start within 0 ms on the shared clock; manual camera-B decision survived the AI pass; package exported; project reopened with same revision, packaging and export history. |
| Recorder killed with SIGKILL at about 6.5 s | Reported as a crash; recovery returned 6.00 s on all five sources (checkpoint tolerance 2 s) and the sources opened in the editor. |
| Import MP4 + MOV + corrupt file, audio sync, first cut, manual zoom/mask/callout, local revision, export (`e2e/firstcut.mjs`) | Corrupt file rejected with a reason. Camera started 1.5 s late: found at +1.5014 s, drift 8 ppm, residual ≤ 0.04 ms at five check points. 59 words transcribed on-device. Cut removed 7 pauses and 1 filler, offered the retake as a suggestion, kept "Do not delete this file". Local "no zooms in this section" changed only that section; locked range and manual zoom untouched; undo restored it. |
| Export of that edit | 772 frames, 1920×1080, 30 fps, H.264 High, AAC-LC 48 kHz stereo, 25.74 s, written in 5.2 s (about 4.9× real time). |
| Package and export UI (`e2e/package-ui.mjs`) | 43/43 checks, including a bare file at the chosen path, ProRes 422 (`prores, yuv422p10le, pcm_s16le`), BT.709 tags on stream and container, a 2× section keeping a 330 Hz tone at 330 Hz, and voiceover delete. Earlier checks: three template concepts from real stills, thumbnail edits, title limit, chapter rules, complete folder, `-rev` naming on re-export, cancel leaves nothing, missing media blocks with a relink action, unwritable folder gives a failed state. |
| Real hardware capture (`e2e/real-capture.mjs`) | Main display 1920×1080 at 60 fps nominal (399 frames in 7.02 s on a mostly static screen), 228 cursor samples recorded separately from the pixels, system audio captured on its own track, edited with a cursor-following zoom and exported. |
| Recording and editing UX (`e2e/ux.mjs`) | 52/52: quick share after a take, flags during recording (survive `kill -9`), crop sheet, shortcut rebinding with conflict handling, sensitive-data scan on a frame of made-up secrets with no recognised text written to disk. |
| Looks (`e2e/render-parity.mjs`) | 56/56: a red↔blue 3D LUT swaps the exported pixel, 50% strength lands halfway, identity LUT 58 dB PSNR, GPU and CPU paths agree, sharpening raises edge contrast only, graded 1080p30 export at 106 fps, image search end to end against a local mock. |
| Screen Recording permission screens (`e2e/permissions.mjs`) | 9/9 with the state pinned to "not allowed": Allow…, then the settings card, System Settings request recorded, state remembered. |
| **AI pass through the real Claude Code CLI** (`e2e/claude-real.mjs`, CLI 2.1.193, signed in) | 9/9. First cut in "claude" mode on the 38.1 s fixture: 9 cuts, 3 view changes, 4 zooms at the project's 1.8×, 2 graphics, 1 suggestion left for review, 22.6 s out; 339 s end to end including transcription and stills. A section revision ("no zooms, screen only") came back from Claude as a comparison and changed only that section. Three thumbnail/title concepts came from Claude. Re-run on November 13 with the playbooks in the prompts: 9/9 again, 9 cuts, 2 view changes, 2 zooms, 1 graphic, 22.7 s out, 443 s end to end. Claude's first cut has taken 318 to 443 s across three runs on this 38 s fixture; a prompt change asking for all stills in one step did not make it faster and was not kept. |
| Recorder (`e2e/recorder.mjs`) | 57/57. Five layouts and what each records; countdown overlay covers the target's display, takes no focus and is gone before the recorder starts; self-view bubble fed by the recorder's own frames (synthetic camera), hide and restore; Tab mode states; **a real window recorded with a crop**: the first rows are page, not toolbar, also after the window is resized mid-take; an overlay left on screen is absent from the recorded frames. |
| **Codex** (`e2e/codex-ui.mjs` canned, `e2e/codex-real.mjs` real, CLI 0.160.0) | 37/37 canned. Real, run once: 10/10. First cut 34 s, section revision 10 s, three concepts 16 s, one generated picture 38 s (1672×941 PNG) placed in a thumbnail. |
| **Ask AI chat and versions** (`e2e/chat.mjs` canned, `e2e/chat-real.mjs` real Claude Code) | 53/53 canned: cards, refusals, apply one/all, undo, follow-up digest, section scope, moments, history rows, viewing a version read-only (nothing is saved while viewing), compare, restore, fallback, consent, persistence. Real, run once: "Remove the zooms in the first ten seconds" returned exactly the two removals in 7 s; a follow-up returned one zoom plus the removal that makes room for it in 47 s. |
| Helper lifetime (direct runs of the helper) | A 2 s display take and a 2 s window take start and stop cleanly. A helper whose parent exits mid-take ends by itself 0.3 s later and leaves a recoverable manifest. |
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
| Claude on real footage beyond the fixture | The fixture runs passed. Prompt quality on long, real recordings is the owner's to judge. One real 124 s take needed about 6.6 minutes in the assemble stage with Claude; Codex took 34 s on the fixture. |
| **iPhone as a camera (Continuity Camera)** | Discovery, labels and the Info.plist key are in place. No iPhone was attached, so nothing was recorded from one. |
| **Self-view with a real camera** | Verified with the helper's synthetic camera only: Camera permission on this Mac is undetermined. |
| **Browser tab listing and selection** | The permission states and the window crop are verified. Listing real tabs needs the Automation prompt for each browser, which is the owner's to answer; Safari, Arc, Edge and Brave scripts are untested and Arc's is the least certain. The measured page area needs Accessibility, which is not granted here, so only the per-browser estimate ran. |
| Chat through Codex; chat stills with a real model; long threads | The chat uses the same provider gate as the first cut. Only Claude and the canned provider were exercised. |
| Chat wording rule added after the real run | Real replies named internal handles ("D1"). A prompt rule now asks for times and descriptions instead; it has a unit test but no second real run. |
| Generated-picture rules | Prompt-only. One sample showed a generic play triangle on a document. |
| Codex sign-in button, live Unsplash API, physical ⌃⌥F and Escape presses | Written; not pressed. |
| The real macOS Screen Recording prompt | The owner allowed it on November 13 and a real capture from the packaged app followed (1920×1080, 103 frames in 3.5 s). The signed build has a new identity, so the toggle has to be switched on once more. |
| **Camera capture and camera previews** | Code-complete. Camera permission on this Mac is undetermined and granting it is the owner's action. |
| **Two physical cameras at once** | Verified only through the helper's synthetic mode (same clock, writers, manifest and recovery code). One camera is attached here. |
| Microphone content | The mic delivered digital silence (lid closed). The helper warns about it; capture structure was verified. |
| Real device unplug, real disk-full | Written; only the simulated paths ran. |
| 4K and 60 fps export, 30-minute and 10-minute 4K envelopes | Not run. Only 1080p30 was measured. |
| VoiceOver, keyboard-only pass, 1280×800 layout | Labels, focus styles and reduced motion exist; not audited. |
| One renderer crash | Seen once in an early run (before a fix to the voice-track choice), not reproduced in any later run. Crash logging is now in place. |

## 4. Known gaps against the product package

* **Colour.** Stream and container are now both tagged BT.709 (primaries,
  transfer, matrix, limited range). Pixel values are not re-encoded from the
  sRGB curve to the BT.709 curve; browsers and YouTube treat the two alike.
* **ProRes** is transcoded from a high-bitrate 8-bit H.264 render, not from
  raw frames.
* **Voice cleanup** is a high-pass, a gentle expander and a limiter. It is not
  spectral noise reduction.
* **Sensitive-data masks are fixed rectangles.** They do not follow text that
  scrolls; the scan samples frames, so something on screen for under a second
  can be missed. Nothing is hidden without the creator pressing Hide.
* **Signature.** `pnpm package` signs with the identity named in
  `CUTAWAY_SIGN_IDENTITY` or `apps/desktop/.signing.local.json`; permissions
  then survive rebuilds. Without one the build is ad-hoc signed and each
  repackage needs the toggle switched off and on again. Either way the build
  is for this Mac: sharing it needs a Developer ID and notarisation.
* **Tab mode records the browser window**, cropped to the page. The tab has to
  stay in front; a tab hidden behind another cannot be recorded.
* **Pictures need Codex.** Claude Code has no image tool, so generated
  thumbnail pictures always go through Codex, with their own consent.
  Discarding a generated picture deletes the file and cannot be undone.
* **`firstCut.mode` reads "claude" for any model cut**; `firstCut.provider`
  says which tool made it.
* **A read-only version does not grey out the inspector controls.** Changes
  are refused at the store with one explanatory message.
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

**Added in the completion pass:** LUT import (.cube, 1D and 3D) and
sharpening per layer; online background images through the creator's own
Unsplash key (live API not exercised: no key); a project default zoom level;
ProRes 422 export; export to a single file via a save dialog; pitch-preserving
speed changes; voiceover delete; the quick-share sheet after recording; flags
during recording (⌃⌥F) shown on the ruler and fed to the first cut; a crop
sheet with a draggable rectangle; editable shortcut bindings for 38 commands;
and a sensitive-data scan that proposes blur masks.

**Added on November 13** (verified by the suites named in section 2 unless
listed under "Not verified"): Codex as a second AI tool and generated thumbnail
pictures; written playbooks for editing, titles and thumbnails with warnings
on the Package screen; the Ask AI chat with one named version per applied
change; viewing any version read-only before restoring it; a countdown over
the recording target; a self-view bubble; five recording layouts including the
new "Camera + screen" (`presenter`); iPhone cameras labelled in the camera
menus; a browser Tab target that leaves the toolbar out; signing with a local
certificate.

**Failures found and fixed on November 13.**

* *"The take could not be added to the project."* The recorder failed to start
  just after a permission prompt (macOS restarts its capture service), the
  empty take was removed, and the app then tried to recover it. Start is now
  retried and a take that never started is reported as "Nothing was recorded".
* *"A JavaScript error occurred in the main process: write EPIPE."* A command
  was written to a recorder that had already exited. Every command now goes
  through one writer that tolerates a closed pipe, and a closed pipe can no
  longer raise an error box.
* *Recording that never starts ("application connection being interrupted").*
  The helper's timeout wrapper did not time out: it was built on a task group,
  which waits for a child that ScreenCaptureKit never lets finish. Stuck
  helpers stayed alive (one for seven hours), each reconnecting to the capture
  service in a loop, and with two of them present every new stream was
  dropped. The wrapper now returns on time, the helper ends when its parent
  has gone or a quick command overruns, a dropped stream is rebuilt once, and
  a stream lost before the take begins ends the attempt at once with the
  reason. See "Process lifetime" in `NATIVE_PROTOCOL.md`.
* The helper could abort with a crash report when writing to a closed pipe.
  Its output now ignores a closed pipe.

**Still not built:** hosted shareable links and view analytics. They need a
server and storage account, which Cutaway does not have. Screen Studio's own
wallpapers, cursor art, click sounds and device artwork were not copied.

No Screen Studio binary was inspected: the app is not installed on this Mac
and it was not downloaded. Evidence used: the public site and guides, the
three reference screenshots supplied by the owner, and the leftover
preferences file on this Mac.

## 6. Decisions that are yours

1. **Name and identity.** "Cutaway" is a working choice; no trademark search
   was done beyond a quick web check.
2. **Judge the AI cut on your own footage.** The pass works end to end on the
   test fixture; whether its choices suit your videos is yours to decide.
3. **Reverse engineering Screen Studio.** If you want binary inspection for
   the remaining parity items, the app has to be installed first; check its
   licence terms before doing so.
4. **Signing.** The owner chose to sign with the certificate in the keychain
   (November 13). Sharing the app with other people still needs a Developer
   ID, hardened runtime entitlements and notarisation.
5. **Support floor and envelopes.** Qualify 4K, 60 fps, long takes and real
   two-camera hardware before promising them.
6. **Whisper fallback.** Optional; only used if you pick a model file in
   Settings.
7. **Which tool edits.** Claude Code and Codex both work. On the fixture Codex
   was about ten times faster; whose cuts you prefer is yours to judge.
8. **Pictures always through Codex**, with separate consent, even when Claude
   edits. Say so if you would rather have no generated pictures at all.
