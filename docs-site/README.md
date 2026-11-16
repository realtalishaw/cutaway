# Cutaway docs

Beginner-friendly user docs and tutorials for Cutaway, built with [Mintlify](https://mintlify.com) (works on the free Hobby plan).

## Preview locally

```bash
npx mint dev
```

Then open http://localhost:3000.

## Publish (Mintlify free plan)

1. Push this repository to GitHub.
2. Sign up at mintlify.com and connect the repository.
3. In the Mintlify dashboard, set the docs folder to `docs-site` (this is a monorepo).
4. Every push to the default branch redeploys the site.

## Layout

```
docs.json            site settings and the sidebar
index.mdx            welcome page
quickstart.mdx       the 5-minute quickstart
record/ edit/ ai/ share/ help/   feature pages
tutorials/           tutorial pages (each embeds a video)
images/screens/      screenshots taken from the real app
images/annotated/    screenshots with numbered labels
videos/              tutorial videos (MP4) and their poster frames
_tools/              scripts that make the screenshots and videos (ignored by Mintlify)
```

## Remake the screenshots and videos

Everything is made from the real app, with made-up demo footage, in a throwaway profile (your own projects are never touched). Build the app first (`pnpm build` in `apps/desktop`).

The demo footage and tutorial voiceovers use **ElevenLabs** (narration and music) and **fal.ai** (a realistic presenter photo with Flux, her lip-synced talking video with Kling AI Avatar, and the AI thumbnails in the screenshots). The scripts read the keys from `ELEVENLABS_API_KEY` / `FAL_KEY` (or `~/.cutaway-test/elevenlabs.key` and `~/.cutaway-test/fal.key`); the app itself gets the fal.ai key only through `CUTAWAY_TEST_FAL_KEY`, which is never written to disk. Without an ElevenLabs key, narration goes through fal.ai's ElevenLabs models with the same voice (or set `DOCS_TTS=fal`). Everything generated is cached in `_tools/cache/`, so re-running the scripts costs nothing unless a line changes. The presenter video is the main cost (about $0.06 per second of narration); each AI thumbnail is about $0.15.

Then, from the repo root:

```bash
node docs-site/_tools/make-footage.mjs /tmp/cutaway-demo                     # demo screen, a browser version of it, two camera angles, narration, music
node docs-site/_tools/shots.mjs /tmp/cutaway-demo docs-site/images/screens   # every screenshot, and where its buttons are
CUTAWAY_TEST_FAL_KEY="$(cat ~/.cutaway-test/fal.key)" \
  node docs-site/_tools/shots.mjs /tmp/cutaway-demo docs-site/images/screens 'package|library'   # the AI thumbnail screenshots
node docs-site/_tools/annotate.mjs                                           # numbered callouts → images/annotated/
node docs-site/_tools/hero.mjs                                               # the home page picture
node docs-site/_tools/walkthroughs.mjs /tmp/cutaway-demo docs-site/videos    # tutorial videos
```

Run `shots.mjs` without `CUTAWAY_TEST_FAL_KEY` once too: that run shows the "connect an image generator" question (`art-gate.png`). A last argument picks sections (`shots.mjs`) or tutorials (`walkthroughs.mjs`) by name, for example `'recorder|editor'`.

### How the pieces fit

- `docs-app.mjs` starts the app for the docs. The recorder would otherwise list this Mac's real displays, windows, cameras and microphones and show the real desktop, so the main process answers with made-up devices, the "screens" are frames of the demo footage, and Chromium's fake camera plays the demo presenter (camera B is the same picture, shown closer). Native file dialogs are answered from the main process.
- `callouts.mjs` + `annotate.mjs`: `shots.mjs` measures the buttons each picture talks about (from selectors) and saves the boxes in `_tools/marks.json`. `annotate.mjs` draws a yellow ring and a numbered badge around each one, optionally cropped to the marked area, into `images/annotated/`. The numbers match the numbered lists in the pages. Restyle every callout by changing `markSvg` and re-running `annotate.mjs`; no app needed.
- `walkthroughs.mjs` drives the app with a visible pointer and captures the window, then builds each tutorial **in Cutaway**: it imports the capture into a Cutaway project, adds the step labels, zooms, title cards and cuts with Cutaway's edit model, and exports with Cutaway's own exporter. Long waits (like AI thumbnails being made) are cut out.
- Screenshots over 400 KB are reduced to a 256-colour palette automatically.
