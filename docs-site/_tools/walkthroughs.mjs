// Tutorial videos, made with Cutaway itself.
//  1. Drives the real app (throwaway profile) with a visible pointer and captures smooth frames of each walkthrough.
//  2. Imports each capture into a new Cutaway project, adds step captions, zooms, title/end cards and cuts
//     with Cutaway's own edit model, and exports the MP4 with Cutaway's own exporter.
// Usage: node docs-site/_tools/walkthroughs.mjs <footageDir> <outDir> [only-regex]
import { launch } from '../../apps/desktop/e2e/harness.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { speak, VOICES } from './gen.mjs';

// What the narrator says at each step (ElevenLabs). Each step waits until its sentence is finished.
const NARRATION = {
  'your-first-video': {
    intro: "Let's make your first video. It only takes a minute.",
    s1: 'Open Cutaway and press New recording.',
    s2: 'Choose Display to record your whole screen.',
    s3: 'Pick a layout. Screen plus bubble puts your face in the corner.',
    s4: 'Choose your camera, and your microphone.',
    s5: "Then press Start recording. When you're done, press Stop.",
    afterStop: "Next, Cutaway asks how your first cut should feel. The choices already set work well.",
    s6: 'So just press Create first cut.',
    editor: 'Cutaway took out the pauses and the ums for you. Press Play to watch it.',
    s8: 'Happy with it? Press Export, then Export to file.',
    done: "And that's it. You made a video!",
  },
  'cut-out-mistakes': {
    intro: "Here's the easiest way to cut out a mistake.",
    s1: "Open the Transcript. It's everything you said, written out.",
    s2: "Find the mistake. Here, let's call it, is said twice.",
    s3: "Drag across the words you don't want.",
    s4: 'Then press Cut.',
    s5: 'Play it back. The mistake is gone.',
    done: "That's it. Cut the words, and you cut the video.",
  },
  'zoom-in-on-a-detail': {
    intro: "Let's zoom in, so viewers can see the detail.",
    s1: 'Click the timeline where the zoom should start.',
    s2: 'Click the magnifying glass.',
    s3: 'Press, click the preview to set the target. Then click what you want to zoom into.',
    s4: 'Drag the slider to zoom in more, or less.',
    s5: 'Now play it.',
    done: 'Nice. Now everyone can see the detail.',
  },
  'captions-and-music': {
    intro: "Let's add captions, and some music.",
    s1: 'Open the Captions panel.',
    s2: 'Switch off Hide transcript. Now your words show on the video.',
    s3: 'Pick a style you like.',
    s4: 'To add music, press plus on the audio row, and pick your music file.',
    s5: 'Play it. The music gets quieter while you talk.',
    done: 'Captions and music. Done!',
  },
};
const narrDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'cache');
fs.mkdirSync(narrDir, { recursive: true });
const NFILE = {}, NDUR = {};
for (const [slug, lines] of Object.entries(NARRATION)) {
  NFILE[slug] = {}; NDUR[slug] = {};
  for (const [k, text] of Object.entries(lines)) {
    const file = path.join(narrDir, `narr-${slug}-${k}-${text.replace(/[^a-z]+/gi, '-').slice(0, 32)}.mp3`);
    await speak(text, file, VOICES.narrator, { stability: 0.55, style: 0.2 });
    NFILE[slug][k] = file;
    NDUR[slug][k] = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).toString());
  }
}

const demo = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3] ?? 'videos');
const only = process.argv[4] ? new RegExp(process.argv[4]) : null;
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-walk-'));
const f = (n) => path.join(work, n);
fs.copyFileSync(path.join(demo, 'screen.mp4'), f('Screen recording.mp4'));
fs.copyFileSync(path.join(demo, 'camera.mp4'), f('Camera.mp4'));
execSync(`ffmpeg -hide_banner -loglevel error -y -ss 26 -i "${path.join(demo, 'screen.mp4')}" -frames:v 1 "${f('frame.png')}"`);
fs.copyFileSync(path.join(demo, 'music.mp3'), f('Upbeat acoustic.mp3'));

const { app, page, exportDir } = await launch({ profile: fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-docs-walk-')) });
const S = (fn, arg) => page.evaluate(fn, arg);
const W = 1480, H = 940;
const sleep = (ms) => page.waitForTimeout(ms);

// Native file dialogs would block a scripted run: answer them from the main process.
await app.evaluate(({ dialog }, { music, saveTo }) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [music] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
}, { music: f('Upbeat acoustic.mp3'), saveTo: path.join(exportDir, 'my-first-video.mp4') });

// ── visible pointer ──
async function pointer() {
  await S(() => {
    if (document.getElementById('__fc')) return;
    const c = document.createElement('div');
    c.id = '__fc';
    c.innerHTML = '<svg width="26" height="34" viewBox="0 0 34 44"><path d="M4 3 L4 35 L12 27 L18 41 L24 38 L18 25 L29 25 Z" fill="#111" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0px', top: '0px', zIndex: 2147483647, pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))', transformOrigin: '3px 3px' });
    document.body.appendChild(c);
    const r = document.createElement('div');
    r.id = '__fr';
    Object.assign(r.style, { position: 'fixed', left: '0px', top: '0px', width: '46px', height: '46px', borderRadius: '50%', border: '3px solid #ffcf3f', zIndex: 2147483646, pointerEvents: 'none', opacity: 0 });
    document.body.appendChild(r);
    window.__fcPos = window.__fcPos ?? { x: 740, y: 470 };
    const p = window.__fcPos;
    c.style.transform = `translate(${p.x - 3}px, ${p.y - 3}px)`;
  });
}
async function moveTo(x, y, ms = 650) {
  await pointer();
  await S(({ x, y, ms }) => new Promise((done) => {
    const c = document.getElementById('__fc');
    const from = { ...window.__fcPos };
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = ease(k);
      const px = from.x + (x - from.x) * e, py = from.y + (y - from.y) * e;
      c.style.transform = `translate(${px - 3}px, ${py - 3}px)`;
      window.__fcPos = { x: px, y: py };
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  }), { x, y, ms });
  await page.mouse.move(x, y);
}
async function ripple() {
  await S(() => {
    const r = document.getElementById('__fr');
    const { x, y } = window.__fcPos;
    r.animate([{ transform: `translate(${x - 23}px, ${y - 23}px) scale(.3)`, opacity: 1 }, { transform: `translate(${x - 23}px, ${y - 23}px) scale(1.2)`, opacity: 0 }], { duration: 450, easing: 'ease-out' });
    document.getElementById('__fc').animate([{ scale: 1 }, { scale: 0.82 }, { scale: 1 }], { duration: 220 });
  });
}
async function boxOf(sel) {
  const loc = typeof sel === 'string' ? page.locator(sel).first() : sel;
  await loc.waitFor({ state: 'visible', timeout: 15000 });
  return loc.boundingBox();
}
async function hover(sel, ms) {
  const b = await boxOf(sel);
  await moveTo(b.x + b.width / 2, b.y + b.height / 2, ms);
  return b;
}
async function click(sel, { ms, pause = 250 } = {}) {
  const b = await hover(sel, ms);
  await sleep(pause);
  await ripple();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  return b;
}

// ── frame capture (Chrome DevTools screencast of the app window) ──
async function capture(name, script) {
  const dir = path.join(work, `frames-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let t0 = null;
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    if (t0 === null) t0 = metadata.timestamp;
    const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp - t0 });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const wall0 = Date.now() / 1000;
  const marks = {};
  // frame timestamps and Date.now() share the wall clock: measure both from the first frame
  const now = () => Date.now() / 1000 - (t0 ?? wall0);
  const mark = (k, extra = {}) => (marks[k] = { t: now(), ...extra });
  const norm = (b) => ({ x: (b.x + b.width / 2) / W, y: (b.y + b.height / 2) / H });
  const slug = name.replace(/-[ab]$/, '');
  let gate = 0;
  // mark a step, after the previous step's narration has finished
  const step = async (k, extra) => {
    const wait = gate - now();
    if (wait > 0) await sleep(wait * 1000);
    mark(k, extra);
    const d = NDUR[slug]?.[k];
    gate = now() + (d ? d + 0.35 : 0);
  };
  await pointer();
  // Cutaway's preview briefly draws a "source unavailable" slate while a video seeks during playback.
  // Note when that happens, so those frames can be replaced by the last good one.
  await S(() => {
    window.__slates = [];
    for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
      if (!C || C.prototype.fillText.__docs) continue;
      const orig = C.prototype.fillText;
      const wrapped = function (text, ...rest) { if (typeof text === 'string' && /unavailable/.test(text)) window.__slates.push(Date.now() / 1000); return orig.call(this, text, ...rest); };
      wrapped.__docs = true;
      C.prototype.fillText = wrapped;
    }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await sleep(400);
  // nudge one repaint so the first frame exists
  await S(() => { const c = document.getElementById('__fc'); if (c) c.style.opacity = '0.999'; });
  await script({ mark, now, norm, step });
  await sleep(600);
  const end = now();
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  const slates = (await S(() => window.__slates ?? [])).map((x) => x - (t0 ?? wall0));
  // frames → constant 30 fps video (events can arrive out of order)
  frames.sort((a, b) => a.t - b.t);
  let held = 0;
  for (let i = 1; i < frames.length; i++) {
    const t = frames[i].t;
    if (slates.some((x) => t >= x - 0.03 && t <= x + 0.12)) { frames[i].file = frames[i - 1].file; held++; }
  }
  if (held) console.log('held', held, 'frames over a seeking slate in', name);
  const list = frames.map((fr, i) => `file '${fr.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - fr.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  const raw = path.join(work, `screen-${name}.mp4`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "${dir}/list.txt" -vf "scale=${W * 2}:${H * 2}:flags=bicubic,format=yuv420p" -fps_mode cfr -r 30 -c:v libx264 -crf 16 -preset medium "${raw}"`);
  console.log('captured', name, frames.length, 'frames', end.toFixed(1) + 's');
  return { raw, marks, duration: end };
}

// ── helpers in the app ──
const panel = (tab) => S((t) => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setView('edit'); s.setPanels({ inspector: true, tab: t }); }, tab);
const seekOut = (t) => S((x) => window.__cutaway.usePlayback.getState().seek(x), t);
const outOf = (t) => S((x) => { const { useApp, timeMapOf } = window.__cutaway; return timeMapOf(useApp.getState().project).toOutput(x); }, t);
const clearToasts = () => S(() => { const s = window.__cutaway.useApp.getState(); s.toasts.forEach((t) => s.dismissToast(t.id)); });
async function coverRecorderPreviews(on) {
  const frame = 'data:image/png;base64,' + fs.readFileSync(f('frame.png')).toString('base64');
  await S(({ src, on }) => {
    clearInterval(window.__covers);
    document.querySelectorAll('.docs-cover').forEach((e) => e.remove());
    if (!on) return;
    const place = () => {
      document.querySelectorAll('.docs-cover').forEach((e) => e.remove());
      for (const el of document.querySelectorAll('video, img:not(.docs-cover), canvas')) {
        const r = el.getBoundingClientRect();
        if (r.width < 60 || el.closest('#__fc')) continue;
        const c = document.createElement('img');
        c.src = src; c.className = 'docs-cover';
        // sit right on top of the live picture, but under anything drawn over it (like the Start recording card)
        Object.assign(c.style, { position: 'absolute', left: el.offsetLeft + 'px', top: el.offsetTop + 'px', width: el.offsetWidth + 'px', height: el.offsetHeight + 'px', objectFit: 'contain', background: '#000', pointerEvents: 'none', zIndex: getComputedStyle(el).zIndex === 'auto' ? 0 : getComputedStyle(el).zIndex, borderRadius: getComputedStyle(el).borderRadius });
        el.insertAdjacentElement('afterend', c);
      }
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) if (/\b(HP|LG|Dell|BenQ|ASUS|Samsung)\b/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\b(HP|LG|Dell|BenQ|ASUS|Samsung)\b[^()]*/, 'Second display ');
    };
    place();
    window.__covers = setInterval(place, 250);
  }, { src: frame, on });
}

const results = {};
const want = (k) => !only || only.test(k);

// ════════ 1. Your first video ════════
// Part A: the recorder. Its live previews hold the Mac's video decoders, so the page is reloaded before part B.
let firstA = null;
if (want('your-first-video')) firstA = await capture('your-first-video-a', async ({ mark, norm, step }) => {
  await step('intro');
  await sleep(2600);
  await step('s1'); const b1 = await click('button:has-text("New recording")', { ms: 900 }); mark('z1', norm(b1));
  await page.waitForSelector('[aria-label="What to record"]', { timeout: 20000 });
  await coverRecorderPreviews(true);
  await sleep(4500);
  await step('s2'); const b2 = await click(page.getByRole('button', { name: 'Display', exact: true }), { ms: 800 }); mark('z2', norm(b2));
  await sleep(1400);
  await step('s3'); await click('button:has-text("Screen + bubble")', { ms: 800 });
  await sleep(1400);
  await step('s4'); const b4 = await hover('button[title="Camera A"]', 800); mark('z4', norm(b4)); await sleep(900);
  await hover('button[title="Microphone"]', 700); await sleep(1300);
  await step('s5'); const b5 = await hover('button:has-text("Start recording")', 900); mark('z5', norm(b5)); await sleep(2400);
  await step('cutA');
});
if (firstA) {
  await coverRecorderPreviews(false);
  await S(() => window.__cutaway.actions.backToLibrary());
  await page.reload();
  await page.waitForFunction(() => !!window.__cutaway, null, { timeout: 20000 });
  await sleep(1500);
  await S((files) => window.__cutaway.actions.importIntoNewProject(files), [f('Screen recording.mp4'), f('Camera.mp4')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  await S(() => { const s = window.__cutaway.useApp.getState(); s.patch((p) => ({ ...p, name: 'My first video' })); s.setView('brief'); });
  await sleep(1500); await clearToasts();
  const firstB = await capture('your-first-video-b', async ({ mark, norm, step }) => {
  await step('afterStop');
  await sleep(2000);
  await step('s6'); const b6 = await click('button:has-text("Create first cut")', { ms: 900 }); mark('z6', norm(b6));
  await sleep(1200);
  await step('cutB');
  await page.waitForFunction(() => !window.__cutaway.useApp.getState().job, null, { timeout: 300000 });
  await S(() => { const s = window.__cutaway.useApp.getState(); s.setView('edit'); s.select(null); s.setPanels({ inspector: true, tab: 'background' }); window.__cutaway.usePlayback.getState().seek(0); });
  await sleep(1200); await clearToasts(); await pointer();
  await step('editor');
  await sleep(1500);
  mark('s7'); await click('button[aria-label="Play"]', { ms: 900 });
  await sleep(6000);
  await click('button[aria-label="Pause"]', { ms: 500 });
  await sleep(800);
  await step('s8'); const b8 = await click('button:has-text("Export")', { ms: 900 }); mark('z8', norm(b8));
  await sleep(1800);
  const b9 = await click('button:has-text("Export to file")', { ms: 900 }); mark('z9', norm(b9));
  await sleep(1500);
  await step('cutC');
  await page.waitForFunction(() => /Video exported/.test(document.body.innerText), null, { timeout: 300000 }).catch(() => {});
  await sleep(500);
  await step('done');
  await step('end');
  await sleep(700);
  mark('end');
  });
  // join the two parts into one capture
  const joined = path.join(work, 'screen-your-first-video.mp4');
  fs.writeFileSync(path.join(work, 'join.txt'), `file '${firstA.raw}'\nfile '${firstB.raw}'\n`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "${path.join(work, 'join.txt')}" -c copy "${joined}"`);
  const da = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${firstA.raw}"`).toString());
  const marks = { ...firstA.marks };
  for (const [k, v] of Object.entries(firstB.marks)) marks[k] = { ...v, t: v.t + da };
  results['your-first-video'] = { raw: joined, marks, duration: da + firstB.duration };
}

// Make sure a first-cut project exists for the other walkthroughs.
const hasProject = await S(() => !!window.__cutaway.useApp.getState().project);
if (!hasProject) {
  await S((files) => window.__cutaway.actions.importIntoNewProject(files), [f('Screen recording.mp4'), f('Camera.mp4')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  await S(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, name: 'My first video' })));
  await S(() => window.__cutaway.jobs.startFirstCut(false));
  await page.waitForFunction(() => !window.__cutaway.useApp.getState().job, null, { timeout: 300000 });
}

// ════════ 2. Cut out mistakes ════════
if (want('cut-out-mistakes')) {
  await panel('background'); await seekOut(0); await sleep(800); await clearToasts();
  results['cut-out-mistakes'] = await capture('cut-out-mistakes', async ({ mark, norm, step }) => {
    await step('intro'); await sleep(2600);
    await step('s1'); await click('button[aria-label="Transcript"]', { ms: 900 }); await sleep(1500);
    const words = page.locator('.transcript-body p span');
    const all = await words.allInnerTexts();
    let i = all.findIndex((w, k) => /^let'?s$/i.test(w.trim()) && /^call$/i.test(all[k + 1]?.trim()) && /^it,?$/i.test(all[k + 2]?.trim()) && /^let'?s$/i.test(all[k + 3]?.trim()));
    if (i < 0) i = all.findIndex((w) => /^let'?s$/i.test(w.trim()));
    const a = await words.nth(i).boundingBox(), b = await words.nth(i + 2).boundingBox();
    await step('s2', { x: (a.x + b.x + b.width) / 2 / W, y: (a.y + a.height / 2) / H });
    await moveTo(a.x + a.width / 2, a.y + a.height / 2, 900); await sleep(2200);
    await step('s3');
    await moveTo(a.x + 3, a.y + a.height / 2, 300);
    await page.mouse.down();
    await moveTo(b.x + b.width - 3, b.y + b.height / 2, 900);
    await page.mouse.up();
    await sleep(1500);
    await step('s4'); await click('.transcript button:has-text("Cut")', { ms: 800 }); await sleep(2000);
    await step('s5');
    await S(() => { const { useApp, usePlayback, timeMapOf } = window.__cutaway; usePlayback.getState().seek(Math.max(0, timeMapOf(useApp.getState().project).toOutput(9.6))); });
    await click('button[aria-label="Play"]', { ms: 900 });
    await sleep(5200);
    await click('button[aria-label="Pause"]', { ms: 400 });
    await step('done'); await step('end'); await sleep(700); mark('end');
  });
}

// ════════ 3. Zoom in on a detail ════════
if (want('zoom-in-on-a-detail')) {
  await panel('background'); await seekOut(0); await sleep(800); await clearToasts();
  results['zoom-in-on-a-detail'] = await capture('zoom-in-on-a-detail', async ({ mark, norm, step }) => {
    await step('intro'); await sleep(2600);
    // where the items get added (source ~19.4s) on the timeline; show the screen there
    await S(() => { const { useApp, core } = window.__cutaway; useApp.getState().edit((e, p) => core.applyOps(e, [{ op: 'layout', start: 15.5, end: 27, mode: 'screen', transition: 'smooth' }], 'creator', p.revision + 1), 'Screen view'); });
    await sleep(400);
    const tOut = await outOf(19.4);
    const dur = await S(() => { const { useApp, timeMapOf } = window.__cutaway; return timeMapOf(useApp.getState().project).outDuration; });
    const clip = await boxOf('.tl-clip');
    await step('s1');
    await moveTo(clip.x + clip.width * (tOut / dur), clip.y - 40, 1000); await sleep(300); await ripple();
    await seekOut(tOut);
    await sleep(1600);
    await step('s2'); const z = await click('[aria-label="Add zoom at the playhead"]', { ms: 900 }); mark('z2', norm(z)); await sleep(1800);
    await step('s3'); const t = await click('button:has-text("Click the preview to set the target")', { ms: 900 }); mark('z3', norm(t)); await sleep(1000);
    const prev = await boxOf('.stage canvas, .preview canvas, canvas');
    // the list items sit at about 40% across and 50% down the preview
    await moveTo(prev.x + prev.width * 0.42, prev.y + prev.height * 0.45, 1000); await sleep(400); await ripple();
    await page.mouse.click(prev.x + prev.width * 0.42, prev.y + prev.height * 0.45);
    await sleep(1800);
    await step('s4');
    const slider = page.locator('.insp-card input[type="range"]').first();
    const sb = await slider.boundingBox();
    if (sb) { await moveTo(sb.x + sb.width * 0.3, sb.y + sb.height / 2, 800); await page.mouse.down(); await moveTo(sb.x + sb.width * 0.5, sb.y + sb.height / 2, 900); await page.mouse.up(); }
    await sleep(1400);
    await step('s5');
    await S((x) => { window.__cutaway.useApp.getState().select(null); window.__cutaway.usePlayback.getState().seek(Math.max(0, x - 1)); }, tOut);
    await click('button[aria-label="Play"]', { ms: 900 });
    await sleep(5000);
    await click('button[aria-label="Pause"]', { ms: 400 });
    await step('done'); await step('end'); await sleep(700); mark('end');
  });
}

// ════════ 4. Captions and music ════════
if (want('captions-and-music')) {
  await panel('background'); await seekOut(0); await sleep(800); await clearToasts();
  results['captions-and-music'] = await capture('captions-and-music', async ({ mark, norm, step }) => {
    await step('intro'); await sleep(2600);
    await step('s1'); await click('button[aria-label="Captions"]', { ms: 900 }); await sleep(1500);
    await step('s2'); const sw = await click('[role="switch"][aria-label="Hide transcript"]', { ms: 900 }); mark('z2', norm(sw)); await sleep(1800);
    await step('s3'); await click('.insp-card button:has-text("Bold")', { ms: 800 }); await sleep(1800);
    await step('s4'); const add = await click('[data-testid="audio-add"]', { ms: 1000 }); mark('z4', norm(add)); await sleep(1300);
    await click('text=Music or sound from my files', { ms: 800 }); await sleep(2500);
    await S(() => window.__cutaway.useApp.getState().select(null));
    await step('s5');
    await seekOut(0.2);
    await click('button[aria-label="Play"]', { ms: 900 });
    await sleep(6500);
    await click('button[aria-label="Pause"]', { ms: 400 });
    await step('done'); await step('end'); await sleep(700); mark('end');
  });
}

// ════════ assemble each walkthrough in Cutaway ════════
const PLAN = {
  'your-first-video': {
    title: ['Your first video', 'Tutorial · 1 minute'],
    steps: [['s1', 's2', '1. Press New recording'], ['s2', 's3', '2. Choose Display to record your whole screen'], ['s3', 's4', '3. Pick a layout'], ['s4', 's5', '4. Choose your camera and microphone'], ['s5', 'cutA', '5. Press Start recording. Press Stop when you’re done'], ['afterStop+1.6', 'cutB', '6. Press Create first cut'], ['editor', 's8', '7. Press Play to watch it'], ['s8', 'done', '8. Press Export, then Export to file']],
    zooms: [['s1', 2.2, 'z1', 1.8], ['s2', 2.0, 'z2', 1.6], ['s5', 2.4, 'z5', 1.7], ['s6', 1.6, 'z6', 1.5], ['z9-1.4', 2.2, 'z9', 1.5]],
    cuts: [['cutA+0.2', 'afterStop'], ['cutB+0.8', 'editor-0.5'], ['cutC+1', 'done-0.4']],
    cards: [['afterStop', 1.8, '…you record', 'Then press Stop']],
    end: ['You made a video!', 'Now upload it anywhere'],
  },
  'cut-out-mistakes': {
    title: ['Cut out mistakes', 'Tutorial · 30 seconds'],
    steps: [['s1', 's2', '1. Open the Transcript'], ['s2', 's3', '2. Find the mistake. Here, “Let’s call it” is said twice'], ['s3', 's4', '3. Drag across the words you don’t want'], ['s4', 's5', '4. Press Cut'], ['s5', 'done', '5. Play it. The mistake is gone']],
    zooms: [['s2', 4.6, 's2', 1.7]],
    cuts: [],
    end: ['That’s it!', 'Cut words, cut video'],
  },
  'zoom-in-on-a-detail': {
    title: ['Zoom in on a detail', 'Tutorial · 30 seconds'],
    steps: [['s1', 's2', '1. Click the timeline where the zoom should start'], ['s2', 's3', '2. Click the magnifying glass'], ['s3', 's4', '3. Click the button, then click what to zoom into'], ['s4', 's5', '4. Drag to zoom in more or less'], ['s5', 'done', '5. Play it']],
    zooms: [['s2', 2.2, 'z2', 1.7], ['s3', 2.0, 'z3', 1.5]],
    cuts: [],
    end: ['Nice zoom!', 'Viewers can see the detail now'],
  },
  'captions-and-music': {
    title: ['Add captions and music', 'Tutorial · 30 seconds'],
    steps: [['s1', 's2', '1. Open Captions'], ['s2', 's3', '2. Switch off Hide transcript'], ['s3', 's4', '3. Pick a style'], ['s4', 's5', '4. Press + on the audio row, then pick your music'], ['s5', 'done', '5. Play it']],
    zooms: [['s2', 2.4, 'z2', 1.7], ['s4', 2.4, 'z4', 1.5]],
    cuts: [],
    end: ['Sounds great!', 'Captions and music, done'],
  },
};

for (const [slug, cap] of Object.entries(results)) {
  const plan = PLAN[slug];
  const at = (k) => { const m = /^([a-z0-9]+)([+-][\d.]+)?$/i.exec(k); return cap.marks[m[1]].t + Number(m[2] ?? 0); };
  const pt = (k) => cap.marks[k];
  await S(() => window.__cutaway.actions.backToLibrary());
  await S((p) => window.__cutaway.actions.importIntoNewProject([p]), cap.raw);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  const spec = {
    duration: cap.duration,
    name: plan.title[0],
    cuts: plan.cuts.map(([a, b]) => [at(a), at(b)]),
    zooms: plan.zooms.map(([s, len, p, scale]) => ({ start: at(s) - 0.15, end: at(s) + len, x: pt(p.replace(/[+-].*/, '')).x, y: pt(p.replace(/[+-].*/, '')).y, scale })),
    steps: plan.steps.map(([a, b, text]) => ({ start: at(a), end: at(b) - 0.05, text })),
    cards: [[0.05, 2.5, ...plan.title], ...(plan.cards ?? []).map(([k, len, t, s]) => [at(k), len, t, s]), [at('done') + 0.2, Math.max(2, cap.duration - at('done') - 0.3), ...plan.end]],
  };
  await S(async ({ spec }) => {
    const { useApp, core, exporter } = window.__cutaway;
    const st = useApp.getState();
    st.patch((p) => ({ ...p, name: spec.name }));
    st.edit((e, p) => {
      let next = core.applyOps(e, [
        ...spec.cuts.map(([start, end]) => ({ op: 'cut', start, end, kind: 'manual' })),
        ...spec.zooms.map((z) => ({ op: 'zoom', start: Math.max(0, z.start), end: Math.min(spec.duration, z.end), scale: z.scale, x: z.x, y: z.y, follow: false })),
      ], 'creator', p.revision + 1);
      const pill = core.TEXT_TEMPLATES.find((t) => t.id === 'label-pill').parts[0].style;
      const chapter = core.TEXT_TEMPLATES.find((t) => t.id === 'chapter').parts[0].style;
      const ov = [];
      for (const s of spec.steps) ov.push({ id: 'step' + ov.length, kind: 'text', start: s.start, end: s.end, text: s.text, x: 0.5, y: 0.9, style: { ...pill, size: 0.04, width: 0.9, background: { shape: 'pill', color: '#ffffff', opacity: 1 }, color: '#14151c', in: { type: 'pop', duration: 0.3 }, out: { type: 'fade', duration: 0.2 } }, meta: core.meta('creator', p.revision + 1) });
      for (const [start, len, text, sub] of spec.cards) ov.push({ id: 'card' + ov.length, kind: 'text', start, end: start + len, text, subtext: sub, x: 0.5, y: 0.5, style: { ...chapter, size: 0.12 }, meta: core.meta('creator', p.revision + 1) });
      return { ...next, overlays: [...next.overlays, ...ov].sort((a, b) => a.start - b.start) };
    }, 'Tutorial edit');
    await window.__cutaway.saveNow();
    return { ok: true };
  }, { spec });
  // voiceover: each line placed at its step's moment in the finished (cut) video, mixed into one track
  const outTimes = await S((ks) => { const { useApp, timeMapOf } = window.__cutaway; const map = timeMapOf(useApp.getState().project); return { dur: map.outDuration, at: Object.fromEntries(ks.map(([k, t]) => [k, map.toOutput(t)])) }; }, Object.keys(NFILE[slug]).filter((k) => cap.marks[k]).map((k) => [k, cap.marks[k].t]));
  const keys = Object.keys(outTimes.at);
  const voFile = path.join(work, `Voiceover ${slug}.wav`);
  execSync(`ffmpeg -hide_banner -loglevel error -y ${keys.map((k) => `-i "${NFILE[slug][k]}"`).join(' ')} -filter_complex "${keys.map((k, i) => `[${i}:a]aresample=48000,adelay=${Math.round((outTimes.at[k] + (k === 'intro' ? 0.3 : 0.05)) * 1000)}:all=1[a${i}]`).join(';')};${keys.map((_, i) => `[a${i}]`).join('')}amix=inputs=${keys.length}:normalize=0,apad,atrim=0:${outTimes.dur.toFixed(2)}[o]" -map "[o]" -ac 2 -ar 48000 "${voFile}"`);
  const rendered = await S(async ({ files, dest }) => {
    const { useApp, core, exporter, actions } = window.__cutaway;
    // Add the voiceover and the music as audio clips on Cutaway's audio row.
    const report = await actions.importFiles(files, { audioAsMusic: true });
    const ids = (report?.accepted ?? []).map((a) => a.source.id);
    useApp.getState().edit((e, p) => {
      const map = window.__cutaway.timeMapOf(p);
      const meta = core.meta('creator', p.revision + 1);
      const src = (id) => p.sources.find((x) => x.id === id);
      const vo = { ...core.newMusicClip(src(ids[0]), 0, map.outDuration, meta), gain: 1, duck: false, fadeIn: 0, fadeOut: 0 };
      const bed = { ...core.newMusicClip(src(ids[1]), 0, map.outDuration, meta), gain: 0.12, duck: false, fadeIn: 1, fadeOut: 1.5, loop: true, length: map.outDuration };
      return core.withMusic(e, [vo, bed]);
    }, 'Voiceover and music');
    await window.__cutaway.saveNow();
    const s2 = useApp.getState();
    const session = await window.cutaway.export.begin(dest, 'tutorial-' + Date.now());
    try {
      const r = await exporter.renderVideo({ project: s2.project, projectPath: s2.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
      const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
      return { ok: true, folder: done.folder };
    } catch (e) {
      await window.cutaway.export.abort(session.id, false);
      return { ok: false, error: String(e.message ?? e) };
    }
  }, { files: [voFile, f('Upbeat acoustic.mp3')], dest: exportDir });
  if (!rendered.ok) { console.log('render failed', slug, rendered.error); continue; }
  const mp4 = path.join(outDir, `${slug}.mp4`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -i "${path.join(rendered.folder, 'video.mp4')}" -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "${mp4}"`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -ss 1.2 -i "${mp4}" -frames:v 1 -q:v 3 "${path.join(outDir, `${slug}.jpg`)}"`);
  console.log('video', slug, mp4);
}
await app.close();
console.log('done');
