# AI Recording and YouTube Editing Desktop App PRD

Product: Working name to be decided  
Company: To be decided  
Owner: Talisha White  
Version: 0.1  
Date: November 12, 2026  
Status: Draft  
Approval record: Founder review pending. macOS first, local export package, imported second-camera footage, and simultaneous two-camera recording are confirmed.  
Source artifacts: Founder brief in this chat; Screen Studio official site and guides; YouTube Help; `feature-research.md`; `user-stories.json`; `scenarios.feature`; `screens.json`.

## 1 Executive summary

Build a macOS desktop application that records or imports raw footage and turns it into a polished YouTube video, an editable thumbnail, and suggested titles. Preserve the recording quality, automatic zooms, cursor polish, framing controls, and approachable editing experience that make Screen Studio useful. Add an AI editor that understands what the creator is saying and demonstrating, chooses between available views, cleans up the take, and adds relevant visual support.

The central promise is: **Record naturally, receive a complete first cut, review what matters, and export a YouTube package from one app.** The creator should not have to assemble every cut or write a detailed editing prompt before seeing a useful result.

The first complete release includes recording up to two connected cameras, importing an additional camera angle, synchronization, AI cleanup and shot selection, animated zooms, transitions, simple motion graphics, B-roll from supplied assets, manual corrections, thumbnail creation, title suggestions, and export. An internal prototype may prove these in stages, but a recorder with an AI chat sidebar does not meet the product promise.

Confirmed founder decisions: macOS first; export files ready for the creator to upload; both imported second-camera footage and simultaneous two-camera recording. No YouTube account connection is needed in the first version. Proposed defaults in this draft: Apple silicon qualification first, a local project without mandatory signup, English quality qualification first, and a balanced editing style. These defaults are open for review.

## 2 Product context

Creators can capture polished demonstrations in Screen Studio, but this product is intended to carry the job through the editorial and packaging work needed for YouTube: selecting takes and views, shaping pacing, inserting relevant supporting footage, and preparing the title and thumbnail together. This workflow gap is a product hypothesis to validate with creators, rather than a claim that every competitor lacks these capabilities.

Screen Studio already documents automatic and manual zooms, transcript editing, filler and pause cleanup, dynamic camera layouts, captions, voice enhancement, masks, background styling, project storage, and export. The version 4 page adds important context, including cloud transcription requirements for filler detection and hardware requirements for microphone enhancement. Use the current version page where older guides conflict. See the cited inventory in `feature-research.md`.

The audience is initially solo creators making tutorials, explainers, walkthroughs, product demonstrations, and camera-led educational videos. Existing alternatives include combining a screen recorder, a general video editor, and separate thumbnail and writing tools. Broader market demand, pricing, and willingness to pay remain untested.

Functional inspiration should produce an independently built application with its own identity and interaction design. The PRD does not depend on Screen Studio source code, binary contents, proprietary assets, or project compatibility. Native app inspection remains pending because the application could not be opened or found in the standard Applications folders during this session. Public web demonstrations were inspected.

## 3 Full product vision

The complete product supports screen capture, camera A, optional camera B, microphone, system audio, and imported footage in a single project. A creator can also start with camera-only or screen-only footage. An AI editor turns these materials into an intentional story while maintaining the creator's meaning and demonstrated sequence.

The creator can define a channel style, provide example videos as references, request a target duration, and refine the result in plain language or with transcript and timeline controls. The editor can choose takes, arrange supported story sections, switch camera angles, frame the screen, insert licensed or generated supporting material, create restrained motion graphics, clean audio, caption the edit, and propose coordinated thumbnail/title concepts.

Later capabilities include broader asset sourcing and optional generation, advanced color and camera treatment, multilingual qualification, short-form derivatives, optional publishing, and collaboration. Each expands the same promise: less assembly work between raw recording and a video the creator is comfortable posting.

## 4 First coherent frontend experience

Launch with a camera video, screen plus camera A, and screen plus cameras A/B. The two-camera path supports both simultaneous connected-camera capture and importing independently recorded footage. Screen-only projects are also valid; missing cameras must never be a blocking error. A camera-only project may also use two supported cameras.

The initial creator workflow is:

1. Choose Record or Import in the project library.
2. Capture screen, zero to two cameras, microphone, and optional system audio, or import supported files.
3. Identify source roles, choose the master audio, and review synchronization for additional camera files.
4. Set the audience, desired duration, and editing style; optionally add brand assets and B-roll.
5. Choose Create first cut. The app analyzes the actual footage and shows progress by stage.
6. Review a playable edit, an aligned transcript, and a short list of consequential or uncertain choices. The AI has already assembled the candidate edit.
7. Make local changes through the timeline, transcript, inspector, or plain-language instructions.
8. Choose among thumbnail/title pairs, adjust the selected thumbnail, and review the video.
9. Export the video and publishing materials into one named folder.

The product can be useful without supplied B-roll: it may reuse relevant moments from the creator's material, insert accurate graphics, or leave a clean shot. It must not claim to have added B-roll when none was appropriate or available.

## 5 Goals learning goals and non goals

### Customer outcomes

Reduce the hands-on time between finishing a take and obtaining a publishable package. Keep tutorials understandable, speech natural, and screen details readable. Make corrections faster than rebuilding the video manually. Preserve all original media and allow every editorial change to be reversed.

### Learning goals

Validate whether creators accept the first cut with limited corrections, whether AI angle selection adds value, whether supporting visuals improve clarity, and whether coordinated packaging saves meaningful work. Measure analysis cost and turnaround on the actual supported Macs and project sizes before setting commercial limits.

### Exclusions from the first release

Windows and mobile apps; public video hosting; live streaming; team collaboration; mandatory cloud media storage; YouTube uploads or scheduling; channel analytics; automatic public posting; voice cloning; invented speech or demonstrations; unrestricted web scraping for B-roll; unlimited track counts; comprehensive professional color grading; Screen Studio project import. Full Screen Studio parity is a roadmap, with the complete researched baseline explicitly mapped in the companion inventory.

## 6 Actors and jobs

| Actor | Job and authority |
| --- | --- |
| Solo creator and buyer | Records or imports, sets intent, reviews the edit, selects packaging, exports, and decides what to publish. |
| AI editor | Proposes and applies reversible project edits within the creator's brief and locked regions. Never publishes. |
| Product operator | Supports failures through creator-approved diagnostics that exclude footage and transcript by default. No unrestricted access to local projects. |

Qualification must include different speech rates, accents, glasses and skin tones for any face framing, camera-only content, software tutorials with tiny UI text, screen-only content, noise, silent demonstrations, and imperfect recordings. These are evaluation dimensions, not promises of universal model accuracy.

## 7 End to end journeys

### Record and edit

The creator starts a project and chooses display, window, or region capture, or camera-only recording. The recorder shows distinct camera A/B selectors and previews, audio meters, disk-space status, and the requested permissions. Prevent assigning the same device twice. Preflight the selected format and camera combination; explain unsupported combinations before recording. Camera and microphone are optional; permission is requested only for enabled sources. When permission is denied, explain which source is unavailable and offer import or recording with the remaining sources.

A countdown leads to recording. The compact controller provides pause, resume, elapsed time, source health, and stop. Notes and controls must not appear in the captured result when the capture mechanism allows exclusion. The app saves recoverable recording segments continuously. Stopping opens the project with the actual tracks and does not silently upload them.

The creator adds camera B if available. The source review shows recording durations, offsets, coverage, frame rates, and one selected master voice track. The creator reviews synchronization before starting the AI edit. After the first cut is ready, playback works without waiting for all thumbnail candidates. The creator can continue working while optional assets finish.

### Import and synchronize existing material

The creator drags one or more files into the library or project. Inspect and show each file before assigning it as screen, camera A, camera B, voice, or B-roll. Initial required formats are MP4/MOV with a documented supported codec subset, plus WAV/M4A audio and JPG/PNG assets. Probe unsupported, corrupt, or protected media and explain conversion or exclusion options before promising an edit.

Use shared audio or recorded timing to suggest synchronization where available. Show confidence and several check points across the take. A file with no common audio or time reference requires manual alignment; do not label it synchronized. Support manual offset adjustment, late starts, early stops, and a second calibration point for drift. Transcode variable frame-rate media into a stable editing representation when needed without changing the original. A camera outside its usable coverage is never selected; use another valid source or show an unresolved gap.

For a flattened video, allow cuts, audio cleanup, captions, crop, and visual reframing. Do not promise editable original cursor paths or independent extraction of a baked-in camera overlay. Mark the difference from an app recording, which retains separate sources and interaction metadata.

### Create and review the first cut

The creator may accept defaults or enter a brief such as: "Make a clear eight-minute walkthrough. Use the screen while I demonstrate steps, show me when I explain the idea, and use the second camera sparingly."

Analysis identifies speech, source quality, demonstrative screen events, scene changes, and usable supporting assets. The app produces a playable candidate edit plus a concise summary: removed pauses, proposed retake choices, view switches, zooms, inserted assets, and uncertain decisions. Show source and output times for review items. High-confidence changes are already applied to the candidate; uncertain destructive choices remain suggestions or retain the original passage.

The creator can restore a sentence, change an angle, remove a zoom, replace an asset, or lock a range. A request such as "keep this explanation intact" locks that content against later cleanup. A local request such as "less movement in this section" changes that section, preserves unrelated manual work, and offers an undoable before/after preview.

### Package and export

The package screen uses the current edit to propose three distinct thumbnail/title concepts. Each includes a short rationale tied to what is actually in the video. Choose one, edit the text and layout, and preview the pair at a small browsing size. If image generation is unavailable, provide editable compositions made from actual frames, supplied assets, and typography.

Export preflight checks asset availability, missing source ranges, unresolved sync issues, caption timing, video settings, packaging selection, and disk space. The creator may export a clearly labeled draft with acknowledged editorial issues, but corrupt or missing required media blocks a complete export. A successful export reveals the destination folder, lists its contents, and opens the final video for verification on request. Failed exports preserve the project and identify which stage can be retried.

## 8 Frontend surfaces and behavior

The desktop library contains recent projects, recoverable work, Record, and Import. Recording setup contains source selection and previews. Source review contains track roles, sync confidence, coverage, and audio choices. The editing brief contains audience, desired duration, pacing, visual intensity, and optional brand assets. Processing shows stage, completed work, available actions, and whether remote processing is involved.

The editor has a central preview, transcript, timeline, change review, and a context inspector. Timeline lanes expose source cuts, camera layouts, zooms, graphics/B-roll, captions, and audio. Simple view prioritizes preview, transcript, and key corrections; expanded view reveals detailed lanes. The creator does not need to manipulate every lane to finish a video. Navigation between Edit, Packaging, and Export preserves playhead and changes.

Required overlays include recording permissions, media-processing disclosure, source relink, manual sync, edit comparison, source replacement, thumbnail editing, and export preflight. Settings contain storage, processing choices, shortcuts, and reusable style presets. No unrelated billing, team, or admin interface is required for the first experience. A later public marketing site should show a real before/after example and explain the record-to-package outcome; it is outside desktop acceptance.

Design for resizable Mac windows with an initial qualification target of 1280 x 800 logical pixels; adapt panels or offer a compact mode below this size. Provide keyboard operation, visible focus, labeled controls, accessible transcript text, non-color status indicators, adjustable transcript text, and a reduced-motion mode for the application UI. Any reduced-motion setting for the exported video is a separate creative choice.

Every major operation needs base, empty, processing, slow, error, recovery, and completed behavior where relevant. The screen inventory enumerates meaningful states without prescribing visual layouts.

## 9 Feature scope and acceptance behavior

All requirements below are proposed unless the Origin column identifies a founder instruction. Must means required for the first complete release, rather than the first internal prototype.

| Requirement | Priority | Behavior and value | Origin |
| --- | --- | --- | --- |
| R01 Record and preserve sources | Must | Display/window/area, camera A, microphone and optional system sound remain independently editable. Pause/resume and recovery prevent a take being needlessly lost. | Founder; research; inference |
| R02 Import and assign media | Must | Camera-only, screen-only, and combined inputs work; unsupported media is identified before analysis. | Founder; inference |
| R03 Synchronize camera B | Must | Additional footage can be aligned, corrected for drift, and reviewed; shot selection respects coverage. | Founder; inference |
| R04 Create an editorial brief | Must | Sensible defaults produce a first cut without requiring a prompt; audience, duration, pacing, and visual intensity remain editable. | Inference |
| R05 Clean speech and pacing | Must | Shorten safe pauses and fillers, suggest retakes, preserve breaths and meaning, clean voice noise, and preserve waiting time needed to understand a demonstration. | Founder; research; inference |
| R06 Direct the available views | Must | Choose screen, camera A, camera B, overlay, or split view based on relevant action and narration. Manual angle overrides and locks win. | Founder; research |
| R07 Frame and animate | Must | Add animated zooms and pans, simple cursor treatment for recordings, click emphasis, camera-layout transitions, text callouts, chapter cards, and restrained transitions. Each remains editable. | Founder; research |
| R08 Insert relevant B-roll | Must | Select and trim supplied or project-derived supporting footage, retain narration, record provenance, and support replace/remove. Leave the shot clean when no suitable asset exists. | Founder; inference |
| R09 Edit and caption | Must | Transcript corrections, transcript cuts, trim/split, speed changes, visual controls, captions and timed subtitle export agree with the edited timeline. Undo and restore work. | Founder; research; inference |
| R10 Preserve and revise decisions | Must | Versioned candidate edits, range locks, local regeneration, source-time mapping, autosave, and source relink prevent AI changes from destroying work. | Inference |
| R11 Create YouTube packaging | Must | Generate actual editable thumbnail compositions and title suggestions grounded in the finished video; choose and edit a pair. | Founder |
| R12 Export one complete package | Must | Export playable MP4, selected thumbnail, selected title plus alternatives, and caption file when speech exists. Include optional description and valid chapters. | Founder; inference |
| R13 Control media processing | Must | Disclose outbound data and destination before remote AI processing; recording and manual editing remain local and usable without a remote service. | Inference informed by research |
| R14 Protect visible information | Must | Creator can place time-bounded masks and preview them in the final crop and camera layouts. Automated sensitive-data detection is later work. | Research; inference |
| R15 Capture two live cameras | Must | Independent camera A/B recording with preflight resource checks, shared timing, disconnect recovery, and preserved working sources. Qualify supported combinations before promising universal device support. | Founder confirmed; inference for recovery |
| R16 Reuse creator style | Should | Save brand colors, fonts, framing, intro/outro, caption style, motion level, and packaging layout as a reusable preset. | Research; inference |
| R17 Match advanced Screen Studio polish | Later parity | Loupe optics, advanced cursor controls, cutout, face tracking, LUTs, device capture/frames, shareable projects and links, and GIFs follow the detailed parity map. | Research |
| R18 Source and generate external assets | Later | Search licensed catalogs or generate images/video with explicit cost, provenance, and replacement controls. No placeholder downloads presented as finished B-roll. | Full-vision inference |

### AI editorial rules

The AI must use both audible content and visible actions. Transcript-only cuts can remove necessary demonstrations or select a view that does not show the described step. Preserve cause and effect, negation, quantities, quoted statements, disclosures, and the result of each demonstration. Retake detection must not assume that a repeated sentence is always redundant. With no speech, use screen events and supplied intent rather than blocking the project.

Choose views for a purpose: screen during a demonstrated action, camera during explanation or reaction, camera B when it improves emphasis or covers a permitted cut, and a combined layout when both are useful. Retain a usable shot rather than switching at a fixed interval. As an initial tunable rule, avoid view changes more frequently than roughly three seconds unless the content calls for it. "Energetic" increases intentional movement; it does not authorize arbitrary effects.

Zoom to important UI details when they appear, allow enough context to orient viewers, and return to an overview when useful. Prevent overlays from hiding the demonstrated target. A click is a candidate attention signal, not proof that a zoom is useful. Missing interaction metadata requires visual/manual inference with lower confidence.

B-roll must relate to the spoken concept or demonstrated result. Preserve narration unless the creator chooses the asset's audio. Protect critical screen steps from being covered. Show why an inserted asset was selected and its origin. Simple motion graphics use accurate words and numbers from the project; do not invent statistics, interface states, endorsements, or products.

Default cleanup preserves the chronological story. Opening hooks and substantial reordering are suggested separately because they can change context. Never synthesize missing claims, clone a voice, or imply that generated material is authentic source footage. AI titles and thumbnails must reflect the final content without invented outcomes or guaranteed performance claims.

## 10 Backend and system implications

This section defines needed behavior, without selecting a database, framework, rendering library, model vendor, or hosting provider.

Maintain a local project with source references, source identity, track roles and timing, capture metadata when available, transcripts, edit decisions, assets and rights notes, thumbnail layers, packaging text, and export history. Retain original sources unchanged. Each output interval must map to the source interval or inserted asset that produced it, including speed changes. This mapping drives captions, chapters, undo, sync, and review.

Processing jobs need named stages: media validation, sync, transcription, visual analysis, edit assembly, preview preparation, packaging, and export. Show actual progress where measurable and an indeterminate stage otherwise. Cancel safely, checkpoint completed work, and retry only the failed stage when inputs have not changed. After sleep, app restart, network failure, or provider rejection, distinguish resumable work from a stage that must restart. Do not repeat a paid generation just because the UI lost its connection; reconcile job status before retrying.

Keep capture and export independent of an AI provider's availability. A model failure offers a retry, another permitted processing mode, or manual editing using the preserved sources. Generative output cannot execute arbitrary commands, access unrelated files, alter settings, or publish. Validate every proposed edit against actual source ranges, asset availability, locks, duration, and allowed operation types before applying it.

Cloud use requires an explicit processing choice stating which media or derived data leaves the Mac, the named provider/destination, the purpose, expected cost if any, and retention terms supported by that provider. Do not claim all AI runs locally or that a provider deletes data immediately without verification. If the approved provider or data scope changes, ask again. First release does not require a YouTube login. If a provider requires identity or keys, keep credentials in OS-protected storage and out of project files and logs.

The creator controls project storage and can remove a project to Trash, relink a moved file, or clear derived caches independently. Warn before clearing files needed for unfinished jobs. Never delete a source outside the project as a side effect of removing the project. Uploaded temporary media needs an observable deletion request and provider confirmation where supported; show incomplete remote cleanup honestly.

## 11 Data and content requirements

### Source and project records

Capture media and imported media need identity, path or managed-copy location, duration, dimensions, frame timing, color interpretation, audio channels, origin, role, availability, and source license where relevant. The creator chooses whether imported sources are referenced or copied; explain the storage and relinking consequences. Derived previews, transcription, and AI suggestions are replaceable; original media and manual decisions are not disposable caches.

An edit decision records its affected range, source mapping, operation, settings, origin as AI or creator, revision, reason, confidence category, and locked state. Preserve manual changes across regeneration. A packaging set records its source edit revision, selected title, alternative titles, thumbnail layers, chosen image, and review status. If the edit changes materially, mark packaging and captions stale and update only the derived material that needs updating.

### Exported folder

```text
project-name-youtube/
  video.mp4
  thumbnail.jpg
  title.txt
  title-options.txt
  description.txt
  chapters.txt
  captions.srt
  credits.txt
  package.json
```

The required result is the video, selected thumbnail, and selected title. Include captions when speech has been transcribed; omit captions for silent projects with a clear reason. Descriptions, chapters, credits, and alternatives are useful default extras and may be empty or omitted only with an explicit package status. Avoid invented chapters when a short video cannot meet chapter rules. The editable project remains saved separately and can be included as an optional portable copy when sources are available.

`package.json` records the project/edit revision, export settings, file list and validation outcome, selected title, thumbnail variant, caption language, and creation time. Do not bundle unselected personal photos or original raw media into the YouTube folder by default. Keep exports from different revisions identifiable and never overwrite an existing export silently.

### YouTube output profile

For the first release, qualify 16:9 SDR exports at 1080p and 4K, with 30 or 60 fps as appropriate to the project. Use MP4 with H.264 video, AAC-LC audio, progressive frames, and BT.709 tagging. Preserve the selected project rate and explain conversions for mixed footage. The product's mixed-source timeline policy needs implementation qualification; it cannot preserve every source rate simultaneously. These choices follow [YouTube's encoding guidance](https://support.google.com/youtube/answer/1722171?hl=en).

Offer a 3840 x 2160 thumbnail master and a smaller compressed upload variant, with JPG/PNG validation. A proposed conservative default is a selected JPG below 2 MB for easier handoff across devices. YouTube's retrieved desktop guidance recommends a 4K thumbnail and permits a larger desktop file; the smaller default is a product choice, not a statement of the desktop limit. See [current thumbnail guidance](https://support.google.com/youtube/answer/72431?co=GENIE.Platform%3DDesktop&hl=en).

Validate titles within 100 characters and descriptions within 5,000 characters, following [YouTube's upload documentation](https://support.google.com/youtube/answer/57407?hl=en). When exporting YouTube chapters, start at 00:00, include at least three ascending entries, and ensure each chapter lasts at least ten seconds; otherwise offer ordinary section notes. Recompute all times after edits. See [chapter rules](https://support.google.com/youtube/answer/9884579?hl=en).

## 12 Non functional requirements

The first qualification target is Apple silicon Macs with 16 GB memory and macOS 14 or later, subject to capture/render feasibility results. This is a proposed support floor for this app, not Screen Studio's requirements. Intel, lower-memory machines, and other macOS versions remain open qualification decisions. Recording permissions and device features must be tested on every OS version claimed as supported.

Proposed test envelopes are a 30-minute 1080p60 project with screen, two camera sources and master audio, and a ten-minute 4K30 project. The UI remains usable on longer projects or explains the qualified limit before processing. Do not assume a web-sharing limit from Screen Studio is a local recording limit for this app.

Measure responsiveness on a named reference Mac, OS, asset set, and local/remote mode. Initial targets to validate: recording control feedback within 500 ms; ordinary editor controls respond within 200 ms excluding media decoding; 1080p proxy playback at the selected project rate on the reference device; manual edits autosaved within two seconds of quiescence; and recoverable recording checkpoints no more than two seconds apart. These are release targets, not measured results.

Measure first-cut and export times for each test envelope. Do not advertise a processing multiplier before benchmarks. Show the current stage immediately, show a continuing-work explanation if a stage has no progress update for 30 seconds, and provide safe navigation away from an in-progress job. Avoid false percentage completion.

Require no lost original media in interruption tests, no unmarked missing-source frames, and audio/video alignment within one output frame at tested start, middle, and end checkpoints after calibration. Handle device disconnection, low disk space, sleep, application crash, moved media, variable frame rate, and provider outages. Preserve remaining usable recording sources on a camera failure and prominently mark the affected time.

Analytics, if enabled, contain operational events and durations rather than footage, transcript, window titles, or file paths. Support opt out. Diagnostics are previewed before sharing. Qualify keyboard access, VoiceOver labels, readable contrast, and a transcript navigation alternative to precision timeline dragging.

## 13 Success metrics

No demand or performance baseline has been established. Pilot targets below are hypotheses for an initial group of ten creators working on their own material.

| Metric | Proposed validation signal |
| --- | --- |
| Activation | At least eight of ten finish one complete package without a facilitator editing the project for them. |
| Editing effort | Median creator hands-on time falls at least 50% against that creator's comparable previous workflow. Measure waiting separately. |
| First cut usefulness | At least seven of ten rate the candidate usable after localized revisions rather than a full rebuild. |
| Meaning preservation | Zero critical meaning reversals in a curated annotated evaluation set before beta release. |
| Synchronization | Every qualified test project stays within the stated sync tolerance across its usable range. |
| Packaging | At least seven of ten choose a supplied thumbnail/title pair or make localized edits to one. No CTR or ranking guarantees. |
| Reliability and trust | No lost original files; all test outbound processing matches consent; interrupted projects reopen with recoverable state. |
| Repeat use | Observe whether creators return for another project in the next 30 days; establish the baseline before setting a retention threshold. |
| Cost | Track cost per analyzed minute and accepted edit, including retries; pricing depends on this measurement. |

Suggested events include project_created, capture_completed, sync_confirmed, first_cut_requested, first_cut_ready, edit_restored, local_regeneration_applied, packaging_selected, export_completed, and recovery_completed. These describe actions, not recording content.

## 14 Outcome based release phases

| Phase | Outcome and included scope | Readiness evidence |
| --- | --- | --- |
| Feasibility qualification | Prove separate-source capture, imported camera sync/drift handling, source-to-output timing, editable AI decisions, and matching preview/export. No commercial launch claim. | Real recordings across camera-only, screen-only, one-camera, and two-angle cases; interruption and export evidence. |
| Internal complete workflow | Capture/import through first cut and basic thumbnail/title export using supplied assets. Validate the entire promise on a small supported format set. | Golden-path package with playable media, actual selected thumbnail, matching captions, and reversible edits. |
| Creator beta | All Must requirements R01-R15, including both second-camera input paths, source recovery, masks, local corrections, packaging revision tracking, and cloud disclosures. | User stories and failure scenarios pass on the reference devices; ten-creator pilot begins. |
| Recording and visual parity expansion | R16-R17: richer cursor/zoom/camera styling, reusable presets, and additional Screen Studio baseline features. | Per-feature acceptance and performance qualification; do not advertise complete parity until the matrix is satisfied. |
| Expanded production workflow | Licensed catalog search, optional generation, multilingual support, derivatives, publishing or collaboration according to validated demand. | Separate product and provider decisions; no implied scope commitment for first launch. |

Phase labels state outcomes, not estimates of calendar time. A subsequent engineering plan should identify dependencies, owners, test fixtures, and delivery estimates after the founder approves this scope.

## 15 Risks assumptions open questions and kill criteria

The central technical risk is editorial quality, rather than the presence of editing controls. A transcript-only model may remove the wait that makes a demonstration understandable. Multi-camera sync can drift, layout switches can obscure the action, and automated motion can reduce legibility. Build a small annotated footage set that exposes these errors before relying on automated quality scores.

Recording and rendering several high-resolution sources can exceed a Mac's thermal, bandwidth, or memory budget. Qualify formats and simultaneous-camera combinations. Use lower-resolution editing previews where appropriate, but verify the full-resolution export against the same approved edit. Provider costs, licenses for supporting assets, cloud-media privacy, and uncertain demand can invalidate commercial assumptions.

Open decisions: product name and identity; minimum Mac and OS; offline AI coverage versus approved cloud services; maximum launch duration; initial languages; preferred creator editing examples; stock/generated asset sources and budget; local-only personal app versus commercial distribution. Proceed with the stated draft assumptions for product definition; do not treat them as founder approvals or select vendors silently.

Stop and reassess the proposed release if a real two-angle recording cannot be aligned reliably, if the editor repeatedly changes the creator's meaning, if first cuts require full manual rebuilds in most pilot sessions, if the minimum supported machine cannot record stably, or if processing costs cannot support a viable customer offer. Such findings may narrow the supported input envelope, but must not be hidden behind a functioning UI demonstration.

## 16 Approval and decisions log

| Date | Decision | Status and source |
| --- | --- | --- |
| November 12, 2026 | Build a desktop recorder with AI editing across camera/screen footage, motion, B-roll, and YouTube thumbnail/title packaging. | Founder brief |
| November 12, 2026 | macOS first. | Founder confirmed |
| November 12, 2026 | Export a ready-to-upload package. | Founder confirmed |
| November 12, 2026 | Support both imported second-camera footage and simultaneous two-camera recording. | Founder confirmed |
| November 12, 2026 | Finish research without the deleted native app. | Founder confirmed; official documentation and web demonstrations used |
| November 12, 2026 | Local projects, provider-neutral remote-processing controls, and initial device/test envelopes. | Proposed requirements |
| November 12, 2026 | Full PRD, priorities, baseline parity phases, and acceptance targets. | Awaiting founder review |

This package defines the product and its observable system requirements. The companion prompt can be used for an engineering planning pass after scope approval. Visual design, implementation architecture, and code have not been approved by this draft.
