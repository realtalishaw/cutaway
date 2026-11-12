# Screen Studio Features and Product Scope Research

Research date: November 12, 2026. This inventory maps documented Screen Studio behavior to the proposed application. It establishes a functional baseline, rather than installed-app testing or implementation parity.

## Findings that shape the product

Screen Studio's current site describes more than recording and zooms: it includes transcript editing, cleanup suggestions, several camera layouts, captions, audio enhancement, masks and local camera processing. The proposed app adds editorial selection across independent camera sources, relevant B-roll assembly, and coordinated YouTube packaging. [Product overview](https://screen.studio/), [Screen Studio 4](https://screen.studio/4).

Animated layouts are different from two independent camera sources. The reviewed pages describe arranging a webcam and screen; they do not establish simultaneous recording of two cameras, AI editorial switching between independent angles, or complete thumbnail/title packaging. These are proposed additions. An undocumented feature should not be described categorically as unavailable.

## Evidence and inspection limits

Exa returned 21 search-result slots across three angles: core product/version coverage, detailed recording/editing guides, and YouTube handoff requirements. Duplicate results were not treated as independent evidence. Specific official pages were fetched to establish behavior. The live browser site also showed the current version 4 language and interactive demonstrations of zoom editing and camera layouts.

Native inspection could not proceed: Screen Studio did not open by name and was absent from the standard system and user Applications folders. The founder confirmed it had likely been deleted and authorized completing the research without it. No native recording, editor, export, or performance was tested. REA was researched but not run against Screen Studio because there was no local application target.

The [guide index](https://screen.studio/guide) and [machine-readable index](https://screen.studio/llms.txt) helped discover topics. The latter identifies an older update date and is used as an index. Some guides retain older behavior; explicit changes on the current version page take precedence. The fetched [changelog](https://screen.studio/changelog) did not expose substantive entries, so no release date is inferred from it.

## Functional parity map

Launch means proposed requirements for the first complete release. Later parity means preserved in the roadmap. Each capability still needs implementation and verification.

| Area | Screen Studio documented behavior | Proposed scope | Official evidence |
| --- | --- | --- | --- |
| Capture selection | Display, window, or region | Launch | [Overview](https://screen.studio/) |
| Sources | Webcam, microphone, system sound | Launch; add camera B | [Sources](https://screen.studio/guide/webcam-microphone) |
| Sound routing | All or selected apps | System audio launch; app routing later | [System audio](https://screen.studio/guide/recording-system-audio) |
| Recording controls | Pause/resume, countdown, global shortcut | Launch | [Overview](https://screen.studio/) |
| Recording utilities | Window resizing and speaker notes | Later parity | [Overview](https://screen.studio/) |
| Capture safety | Frequent disk saves and crash recovery | Launch | [Overview](https://screen.studio/) |
| Desktop cleanup | Icon and notification utilities indexed | Later; verify current controls | [Index](https://screen.studio/llms.txt) |
| Devices | USB iPhone/iPad recording and frames | Later parity | [Devices](https://screen.studio/guide/recording-iphone-ipad) |
| Import | Existing MP4 with capture-specific limitations | Launch; also qualify MOV/audio | [Import](https://screen.studio/guide/creating-project-from-existing-video) |
| Basic editing | Trim, middle cuts, segment speed | Launch | [Overview](https://screen.studio/) |
| Transcript editing | Selected words can become cuts | Launch | [Version 4](https://screen.studio/4) |
| Cleanup | Fillers and pauses; provider conditions apply | Launch after qualification | [Version 4](https://screen.studio/4) |
| Typing | Detect stretches for faster playback | Later; manual speed launch | [Overview](https://screen.studio/) |
| Crop and aspect | Crop separately from output shape | Crop/16:9 launch; other shapes later | [Crop](https://screen.studio/guide/cropping-the-recording) |
| Zoom | Click-based or manual target, timeline duration | Launch | [Zoom](https://screen.studio/guide/adding-editing-zooms) |
| Magnification | Classic zoom, loupe and upscaling | Classic launch; loupe/upscaling later | [Version 4](https://screen.studio/4) |
| Zoom timing | Automatic animation and early start | Launch | [Version 4](https://screen.studio/4) |
| Cursor basics | Smooth movement, size/style, idle hiding | Launch for captured metadata | [Cursor](https://screen.studio/guide/cursor) |
| Cursor details | Loop, rotation, shake removal, cursor-type optimization | Later parity | [Cursor](https://screen.studio/guide/cursor) |
| Clicks | Ripple and optional click sounds | Visual emphasis launch; sound later | [Overview](https://screen.studio/) |
| Motion | Motion blur | Later parity | [Overview](https://screen.studio/) |
| Shortcuts | Recorded labels with timeline controls | Later parity | [Shortcut overlay](https://screen.studio/guide/shortcuts) |
| Layouts | Camera full frame, split, overlay, screen only, cutout | First four launch; cutout later | [Version 4](https://screen.studio/4) |
| Camera framing | Position, mirror, shape, size and crop | Basic controls launch | [Camera](https://screen.studio/guide/camera) |
| Camera intelligence | Face tracking and silence behavior | Later; editorial shot choice separate | [Version 4](https://screen.studio/4) |
| Camera appearance | Looks, LUTs, sharpening | Later parity | [Version 4](https://screen.studio/4), [Overview](https://screen.studio/) |
| Canvas | Wallpaper, gradients, solid/custom images | Solid/gradient/custom launch | [Background](https://screen.studio/guide/background) |
| Frame styling | Padding, corners, inset, shadow | Launch | [Background](https://screen.studio/guide/background) |
| Background catalog | Unsplash | Later parity | [Version 4](https://screen.studio/4) |
| Masks | Conceal regions or highlight content | Manual masks/callouts launch | [Version 4](https://screen.studio/4), [Overview](https://screen.studio/) |
| Presets | Save, apply, share | Basic reuse should-have; sharing later | [Index](https://screen.studio/llms.txt) |
| Voice enhancement | Noise reduction and Podcast treatment | Basic cleanup launch; advanced later | [Version 4](https://screen.studio/4) |
| Other audio | Music, levels, AI voiceover | User music/levels launch; generated narration later | [Overview](https://screen.studio/) |
| Captions | Local/optional cloud paths and styling | Launch with language/provider qualification | [Captions](https://screen.studio/guide/captions) |
| Subtitle export | Edited SRT | Launch | [Version 4](https://screen.studio/4) |
| Video export | MP4 through 4K/60, GIF, clipboard | Qualified MP4 launch; GIF/clipboard later | [Export](https://screen.studio/guide/exporting-the-video), [Overview](https://screen.studio/) |
| Project lifecycle | Local files, backups, recent projects, saved position, previews | Save/recovery/recent launch; Finder preview later | [Version 4](https://screen.studio/4) |
| Raw media | Extract original tracks | Preserve sources launch; extraction UI later | [Raw media](https://screen.studio/guide/extracting-raw-recording-files) |
| Editable transfer | Shared project | Later parity | [Version 4](https://screen.studio/4) |
| Hosted sharing | Browser watching, access, comments, counts | Later parity | [Share guide](https://screen.studio/guide/shareable-links), [Overview](https://screen.studio/) |
| App navigation | Custom shortcuts and command menu | Basic shortcuts launch; command palette later | [Shortcuts](https://screen.studio/guide/screen-studio-shortcuts) |
| Privacy | Many local functions; chosen cloud features | Local originals and explicit remote choice launch | [Overview](https://screen.studio/) |

## Version and input caveats

Version 4 conditions filler detection on cloud transcription and identifies hardware/OS requirements for microphone enhancement. Local transcripts do not imply all AI works offline. The captions guide and version page differ on Whisper availability on newer macOS; qualify the chosen configuration. Several older settings were explicitly removed in version 4. [Version 4](https://screen.studio/4), [Captions](https://screen.studio/guide/captions).

The import guide specifies MP4 and excludes capture-only cursor/selfie-camera behavior on imports, whereas the homepage uses broader language. MOV support in the new app is a proposed qualification requirement. A baked-in camera cannot be treated as an independent original track. [Import guide](https://screen.studio/guide/creating-project-from-existing-video).

USB device capture lacks desktop-style touch/cursor metadata for automatic zoom. Do not promise equivalent captured interaction data. [Device guide](https://screen.studio/guide/recording-iphone-ipad).

## Additions for the proposed product

Both camera B workflows are founder-confirmed: simultaneous connected-device recording and independent-file import. The new editorial system must create a playable cut using speech, visible action, source quality, and intent; choose screen/A/B/combined layouts; preserve demonstrated steps; add relevant supplied B-roll and accurate graphics; and respect manual revisions and locks.

Packaging is part of the product outcome: create real editable thumbnail compositions and title alternatives grounded in the finished video, then export the chosen pair with the video and matching metadata. These additions are requirements from the founder brief or proposed acceptance behavior, rather than verified Screen Studio capabilities.

## YouTube requirements

The proposed profile follows [encoding guidance](https://support.google.com/youtube/answer/1722171?hl=en) for MP4, H.264, AAC-LC and SDR BT.709, with a documented mixed-source frame-rate policy.

The fetched [desktop thumbnail guide](https://support.google.com/youtube/answer/72431?co=GENIE.Platform%3DDesktop&hl=en) recommends 3840 x 2160, JPG/PNG, and 16:9 for videos. Search also returned an older version of the same article with 1280 x 720 language; the fetched desktop version governs this draft. Provide a master and compressed upload variant rather than hardcoding an outdated desktop size limit.

Use the [upload guide](https://support.google.com/youtube/answer/57407?hl=en) for title/description limits and the [chapter guide](https://support.google.com/youtube/answer/9884579?hl=en) for exported timestamps. Exporting files does not establish channel eligibility for these features.

## REA and future verification

[REA's official repository](https://github.com/morluto/rea) describes local desktop, native and JavaScript inspection. It can investigate concrete implementation questions when a local target exists. The local default Node version was below the fetched README's supported floor and no rea command was on PATH. No REA setup was changed for this PRD.

Future native verification should use a disposable project and record the exact version, Mac and macOS. Verify source selectors, camera availability, timeline behavior, import constraints, export, shortcuts and recovery. Static REA results can establish implementation evidence; they cannot alone prove that a user workflow works. Do not infer vendor architecture from visual similarity.
