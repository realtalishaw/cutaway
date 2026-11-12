# Build Prompt for the AI Recording and YouTube Editing App

Use this prompt with the companion files after founder scope approval. The package is currently Draft; saving this prompt does not authorize an implementation pass.

```text
Build a macOS desktop recording and editing application for solo YouTube creators. Read prd.md, feature-research.md, user-stories.json, scenarios.feature and screens.json first. Use the PRD as the behavior contract and identify any remaining assumptions before committing to architecture.

OUTCOME
A creator records/imports raw footage, receives an AI-assembled first cut, makes focused corrections, and exports a finished video, selected thumbnail, suggested titles and applicable captions/description/chapters. The first cut must be an actual playable edit of the supplied footage. A chat panel or collection of suggestions does not fulfill this outcome.

CONFIRMED SCOPE
- macOS first; export files ready for manual YouTube upload.
- Camera-only, screen-only, screen plus one camera, and screen plus two cameras.
- BOTH simultaneous capture from two qualified connected cameras and import/synchronization of an independent camera recording.
- AI cleanup, editorial view selection, zooms/pans, transitions, simple motion graphics, relevant B-roll, and coordinated thumbnail/title generation.
- Independently build the useful Screen Studio functional baseline using the launch/later parity map. Use an original identity and design.

CORE REQUIREMENTS
1. Build a real project library and recording flow with source previews, audio meters, permission recovery, countdown, pause/resume/stop, disk checks and recoverable capture. Keep screen, camera A/B, microphone and system audio independently editable. Prevent duplicate device assignment and preflight format/device combinations. Preserve working sources if a camera disconnects.
2. Validate imported media and assign screen/camera/voice/B-roll roles. Preserve originals. Flattened imports do not acquire editable original cursor paths or separable camera tracks. Support relinking moved media.
3. Synchronize independent footage using actual shared audio/timing when available. Show confidence and coverage, manual offset controls and drift calibration. With no reliable reference, require manual alignment. Choose one master voice to avoid doubled audio. Never select a camera outside valid coverage.
4. Create the first cut from defaults or a brief. Analyze audible speech AND visible screen actions. Preserve meaning, negation, quantities, demonstration order, useful waits and locked ranges. Suggest uncertain retake/reordering choices rather than silently discarding content. Support silent demonstrations too.
5. Choose screen/A/B/overlay/split views for a reason. Keep demonstrations visible, use cameras for useful explanation/emphasis, and avoid arbitrary rapid switches. Make transitions and angle choices editable.
6. Add editable zooms, pans, captured cursor/click emphasis, callouts and section cards. Insert relevant supplied/project-derived B-roll while preserving narration. Track asset origin. If no useful asset exists, keep a clean shot. Do not fabricate statistics, UI states, endorsements or outcomes.
7. Expose preview, transcript, timeline and inspector. Support trim/split, transcript cuts, speed, audio levels, user music, captions, manual masks, angle overrides, asset replacement and undo/redo. Distinguish correcting transcript spelling from cutting words. Recompute subtitle/chapter timing after all edits.
8. Represent AI decisions as reversible edits with source/output ranges, revision, origin and locks. Preserve manual work through regeneration. Local requests offer a before/after preview and alter only the intended range. Save/reopen with complete project state.
9. Create three thumbnail/title pairs grounded in the finished edit. Generate actual editable thumbnail compositions using real frames/supplied images and typography; optional permitted generation is additive. Allow text/framing/color/layout changes. No unsupported claims or identity alterations. Mark packaging stale after material edits.
10. Preflight and export a revision-consistent folder with video.mp4, thumbnail.jpg, title.txt, title-options.txt, and applicable captions.srt, description.txt, chapters.txt, credits.txt and package.json. Keep the editable project saved separately. Qualify 1080p and 4K SDR output, including 30/60 fps profiles. Never silently overwrite exports. Expose partial results and safe retry when a stage fails.
11. Keep originals/projects local. Before remote processing, identify the actual destination, data, purpose, cost and supported retention terms. Do not claim all AI is local or transmit to an unapproved provider. Store credentials outside projects/logs. Recording/manual editing survive provider outages. Validate AI proposals as allowed edit operations, never arbitrary executable instructions.

EXECUTION AFTER SCOPE APPROVAL
Inspect the repository and its instructions, then write an engineering plan. Choose capture, media timing, rendering and model tools based on feasibility; no stack or vendor is mandated here. Identify the exact supported device/format combinations before making compatibility claims.

Begin with real separate-source screen/two-camera/audio capture, drift correction, source-to-output time mapping and preview/export consistency. Use hardware and real footage. UI mocks and stock clips do not prove a recorder works.

Build complete vertical journeys: capture/import and reopen; sync/review; AI first cut; local correction/recovery; thumbnails/titles; validated export. Internal milestones may stage this work, but the first complete beta includes every Must requirement and both second-camera workflows. Preserve the later parity roadmap.

Use the stories/scenarios as acceptance behavior. Add meaningful tests for timing, coverage, locks, edit validation, export consistency and recovery. Validate camera-only, screen-only, one-camera, simultaneous two-camera, drifting imported camera, silent demo, flattened import, moved source, camera disconnect, disk full, denied permission and provider outage cases. Human-review meaning preservation and screen legibility.

Report actual media/device results, measured performance, supported formats, incomplete requirements and product decisions needed. Do not call a UI prototype a working recorder/editor. Do not upload or publish to YouTube or add unrelated integrations.
```
