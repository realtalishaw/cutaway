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

Everything is made from the real app, with made-up demo footage, in a throwaway profile (your own projects are never touched). Build the app first (`pnpm build` at the repo root).

The demo footage and tutorial voiceovers use **ElevenLabs** (narration and music) and **fal.ai** (a realistic presenter photo with Flux, and her lip-synced talking video with Kling AI Avatar). The scripts read the keys from `~/.cutaway-test/elevenlabs.key` and `~/.cutaway-test/fal.key` (or `ELEVENLABS_API_KEY` / `FAL_KEY`). Everything generated is cached in `_tools/cache/`, so re-running the scripts costs nothing unless a script line changes. The presenter video is the only real cost: about $0.06 per second of narration.

Then, from the repo root:

```bash
node docs-site/_tools/make-footage.mjs /tmp/cutaway-demo                     # demo screen, talking presenter, narration, music
node docs-site/_tools/shots.mjs /tmp/cutaway-demo docs-site/images/screens   # every screenshot
node docs-site/_tools/annotate.mjs                                           # numbered editor tour
node docs-site/_tools/walkthroughs.mjs /tmp/cutaway-demo docs-site/videos    # tutorial videos
```

`walkthroughs.mjs` drives the app with a visible pointer and captures the window, then builds each tutorial **in Cutaway**: it imports the capture into a Cutaway project, adds the step labels, zooms, title cards and cuts with Cutaway's edit model, and exports with Cutaway's own exporter.

The recorder's live preview would show your real desktop, so the scripts cover it with a frame of the demo footage and rename attached displays before capturing.
