# Cutaway

**Record once. Get the first cut.**

Cutaway is a free, open-source Mac app for making YouTube videos. Record your
screen and camera (or import footage you already have), let AI assemble a first
cut, fix anything by editing the transcript, the timeline or just asking, then
export the video with its captions, thumbnail, title and chapters.

- Apple silicon Mac, macOS 14 or later
- Everything runs on your Mac. The optional AI features use **your own** Claude
  Code or Codex sign-in, and generation (voice, music, images, video) uses
  **your own** ElevenLabs or fal.ai key. Cutaway has no account and no server.
- MIT licensed. See [LICENSE](LICENSE).

**New to video editing?** Start with the beginner guides and short video tutorials at
**[cutaway-docs.mintlify.site](https://cutaway-docs.mintlify.site)**. A short list of everything Cutaway does is in
**[docs/features](docs/features/README.md)**.

---

## Install

1. Download **Cutaway.dmg** from the
   [latest release](https://github.com/realtalishaw/cutaway/releases/latest).
2. Open the DMG and drag **Cutaway** into **Applications**.
3. Open Cutaway from Applications.

**The first time you open it**, macOS says *"Apple could not verify Cutaway is
free of malware"*. This build is signed but not yet notarized by Apple, so macOS
asks you to confirm once:

1. Click **Done** on that message.
2. Open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to "Cutaway was blocked".
3. Confirm with **Open Anyway** (and your password or Touch ID).

After that it opens normally.

**Permissions.** The first recording asks for Screen Recording, Camera and
Microphone, only for the sources you switch on. For Screen Recording, macOS
sends you to **System Settings → Privacy & Security → Screen & System Audio
Recording**: switch Cutaway on there and come back. Cutaway notices without a
restart.

## How to use it

### 1. Record, or bring footage

Click **New recording** in the Library.

- Pick **what to record**: a display, one window, an area, one browser tab, an
  iPhone or iPad screen, or just the camera.
- Turn on up to **two cameras**, your **microphone** and **system audio** from
  the bar at the bottom.
- Optional: open the **Teleprompter** for your script. It floats over your
  screen, scrolls as you record, and is never in the video.
- Press **Start recording**. A countdown appears, then a small floating control
  lets you pause, flag a moment, or stop. Your camera shows in a bubble only you
  can see.

Already have footage? Click **Import** (⌘I) in the Library, or drop video files on
the Library window. Cutaway works just as well as an ordinary editor.

### 2. Get a first cut

Open the project and choose **Create first cut**. Tell it the pace and style
you want. Cutaway removes pauses, filler words and retakes, picks camera
layouts, adds zooms where you click, and places your B-roll. Every decision is
listed in **Review** with the reason for it, and each one stays editable.

### 3. Edit

- **Timeline**: the simple timeline at the bottom shows your video, text and
  effects, and audio as rows. Click footage to select its clip, press **Split**
  (or ⌘B) at the playhead, drag clip edges to trim, drag clips to reorder.
  **+** buttons add videos, photos, music, text, zooms and animations. Switch on
  **Advanced** for every track.
- **Transcript**: delete words in the transcript to cut them from the video.
- **Ask AI** (⌘9): describe a change ("tighten the intro", "add a subscribe
  button when I say subscribe") and apply the proposed changes one card at a
  time. Every applied change is saved as a version you can go back to.
- **Animations**: add a ready-made animation (subscribe button, name tag,
  counter, title card, arrow, circle, highlighter, checklist), describe your
  own, or accept the ideas Review finds in what you say.
- **Undo** with ⌘Z, and see every saved version under **History**.

### 4. Package and export

The **Package** screen suggests three title and thumbnail pairs from your
video. Pick one and change anything. **Export** writes one folder with the
video, thumbnail, title, description, captions and chapters to
`~/Movies/Cutaway Exports`. The **Shorts** tab finds 30–60 second moments and
exports them as vertical videos.

### Set up the AI (optional)

AI features use a command-line tool already on your Mac, with your existing
sign-in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
or the [Codex CLI](https://github.com/openai/codex) (`codex`). Choose one in
**Settings → Processing**. If it isn't signed in, choose **Sign in…** there.

Before anything is sent, Cutaway asks you in a sheet. It sends the transcript
text, edit details and a few still frames, never your video or audio files.
Decline, and Cutaway assembles the cut with its built-in rules instead.

For generated voiceovers, music, sound effects, images and video, add your own
**ElevenLabs** or **fal.ai** key in **Settings → AI generation**. Keys are stored
encrypted in your Mac's keychain-backed storage and only sent to that service.

### Make videos from Claude Code or Codex

Cutaway includes an MCP server, so the AI tool you already use can make a whole
video here from a text request ("cut this down, add a title and captions, and
export it"). Open **Settings → AI tools** and click **Connect** next to Claude
Code or Codex. You watch every change happen in Cutaway, and you can keep
editing by hand afterwards. Details and the full tool list:
**[docs/mcp.md](docs/mcp.md)**, or the step-by-step guide in the
[docs](https://cutaway-docs.mintlify.site/ai/make-videos-from-claude-or-codex).

### Where your work lives

Projects are folders in `~/Movies/Cutaway/<name>.cutaway`. Exports go to
`~/Movies/Cutaway Exports`. Nothing is uploaded anywhere unless you ask an AI or
generation service to do something.

---

## Build from source

Requirements: Apple silicon Mac, macOS 14+, Xcode command line tools (Swift 6),
Node 22 and pnpm 9.

```bash
pnpm install
pnpm dev          # builds the native helper, then starts the app with hot reload
```

```bash
pnpm package      # → apps/desktop/release/mac-arm64/Cutaway.app
```

`pnpm package` signs the app with the identity named in
`CUTAWAY_SIGN_IDENTITY` or `apps/desktop/.signing.local.json`
(`{"identity": "<name or SHA-1>"}`, ignored by git). With an identity, macOS
keeps the app's permissions across rebuilds; without one the build is ad-hoc
signed.

### Repository

```
apps/desktop      Electron app: main process, preload bridge, React renderer
  src/main          project library, native bridge, export, AI and generation bridges
  src/renderer      screens, editor, compositor, preview player, exporter, jobs
  e2e               end-to-end scripts that drive the real app (Playwright + Electron)
packages/core     project model, time mapping, sync maths, edit validation, captions
packages/ai       prompts, playbooks, schemas, and the Claude Code and Codex runners
native            Swift helper `cutaway-native`: capture, probe, stills, on-device speech, mux
fixtures          script that generates test footage (nothing is checked in)
docs              features, engineering report, native protocol, product docs
docs-site         the user docs and tutorials (Mintlify), published on every push to main
```

[docs/ENGINEERING_REPORT.md](docs/ENGINEERING_REPORT.md) explains how it is
built and what was measured.

### Tests

```bash
pnpm test                               # unit tests (core, AI layer, desktop)
./fixtures/make.sh                      # generate test footage (needs ffmpeg + say)
pnpm --filter @cutaway/desktop build
pnpm --filter @cutaway/desktop e2e      # end-to-end journeys through the real app
```

End-to-end runs launch the built app against a throwaway profile and never call
an AI model. A few scripts are opt-in because they use real hardware or your
own accounts: `e2e:real` and `e2e/real-demo-capture.mjs` record your screen, and
`e2e/claude-real.mjs`, `codex-real.mjs` and `chat-real.mjs` use your AI sign-in.

## Contributing

Bug reports, ideas and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Cutaway is an independent project with its own name, icons,
artwork and code. Its editor layout follows common screen-recording editors,
studied from public documentation; it contains no third-party app's code or
assets.
