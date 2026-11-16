// Screenshots for the docs, taken from the real app driven by Playwright, plus the callout boxes for annotate.mjs.
// Needs the footage from make-footage.mjs. Never touches your real projects (throwaway profile) or real devices
// (see docs-app.mjs).
//
// Usage: node docs-site/_tools/shots.mjs <footageDir> <outDir> [section-regex]
// Sections: start recorder firstcut editor twocams browser package shorts export library settings
// The package section makes real AI thumbnails with fal.ai when CUTAWAY_TEST_FAL_KEY is set (about $0.15 each);
// without it, it shows the "connect an image generator" question instead.
import fs from 'node:fs';
import path from 'node:path';
import { measure, saveMarks, shrinkPng } from './callouts.mjs';
import { prepareMedia, renderLogo, setOpenFiles, setPermissions, startApp, tidy } from './docs-app.mjs';

const demo = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] ?? 'images/screens');
const only = process.argv[4] ? new RegExp(process.argv[4]) : null;
fs.mkdirSync(out, { recursive: true });
const media = prepareMedia(demo);
const { f } = media;
const hasFal = !!process.env.CUTAWAY_TEST_FAL_KEY;

const { app, page } = await startApp({ media });
const S = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
await renderLogo(page, f('listful-logo.png'));

/**
 * Take a screenshot. `marks` (see callouts.mjs) are measured now and saved for annotate.mjs under `note` (default: the
 * same name). `crop` = [x, y, w, h], or 'marks' to frame the marked buttons with `margin` around them.
 */
async function shot(name, { wait = 700, marks, note, crop, margin = 40, dim, clip, minW = 0, minH = 0, hover = false } = {}) {
  if (!hover) await page.mouse.move(2, 470);
  await sleep(wait);
  await tidy(page);
  await sleep(150);
  const file = path.join(out, `${name}.png`);
  if (marks) {
    const m = await measure(page, marks);
    let c = crop;
    if (crop === 'marks' && m.length) {
      const x0 = Math.min(...m.map((b) => b.x)), y0 = Math.min(...m.map((b) => b.y));
      const x1 = Math.max(...m.map((b) => b.x + b.w)), y1 = Math.max(...m.map((b) => b.y + b.h));
      let w = Math.max(minW, x1 - x0 + margin * 2), h = Math.max(minH, y1 - y0 + margin * 2);
      let x = Math.round((x0 + x1) / 2 - w / 2), y = Math.round((y0 + y1) / 2 - h / 2);
      x = Math.max(0, Math.min(1480 - w, x)); y = Math.max(0, Math.min(940 - h, y));
      c = [x, y, Math.min(1480, Math.round(w)), Math.min(940, Math.round(h))];
    }
    saveMarks(note ?? name, { src: name, marks: m, ...(c ? { crop: c } : {}), ...(dim ? { dim: true } : {}) });
  }
  await page.screenshot({ path: file, clip });
  shrinkPng(file);
  console.log('shot', name);
}
const want = (section) => !only || only.test(section);
const clearToasts = () => S(() => { const s = window.__cutaway.useApp.getState(); s.toasts.forEach((t) => s.dismissToast(t.id)); });
const panel = (tab) => S((t) => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setView('edit'); s.setPanels({ inspector: true, tab: t }); }, tab);
const seek = (t) => S((x) => { const { useApp, usePlayback, timeMapOf } = window.__cutaway; usePlayback.getState().seek(timeMapOf(useApp.getState().project).toOutput(x)); }, t);
const ui = (patch) => S((pt) => window.__cutaway.useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, ...pt } })), patch);
const click = async (sel, opts) => { await (typeof sel === 'string' ? page.locator(sel).first() : sel).click({ timeout: 6000, ...opts }); await sleep(450); };
const esc = () => page.keyboard.press('Escape').catch(() => {});
const closeMenus = async () => { await esc(); for (let i = 0; i < 3; i++) { const v = page.locator('.rb-veil').first(); if (!(await v.count())) break; await v.click({ force: true }).catch(() => {}); await sleep(200); } };
const tryStep = async (label, fn) => { try { await fn(); } catch (e) { console.log('skip', label, String(e.message).split('\n')[0]); } await closeMenus(); };

async function newProject(files, name, { firstCut = true, roles } = {}) {
  await S(() => window.__cutaway.actions.backToLibrary());
  await sleep(600);
  await S((fs) => window.__cutaway.actions.importIntoNewProject(fs), files);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  await sleep(1200);
  await S(({ name, roles }) => window.__cutaway.useApp.getState().patch((p) => {
    let sources = p.sources;
    if (roles) sources = sources.map((s) => { const r = roles[s.name] ?? roles[s.path?.split('/').pop()]; return r ? { ...s, role: r, sync: { ...s.sync, method: 'recorded-clock', status: 'aligned', offset: 0, confirmedByCreator: true } } : s; });
    return { ...p, name, sources };
  }), { name, roles });
  if (firstCut) {
    await S(() => window.__cutaway.jobs.startFirstCut(false));
    await page.waitForFunction(() => !window.__cutaway.useApp.getState().job, null, { timeout: 300000 });
    await S(() => window.__cutaway.saveNow());
  }
}

try {
  // ════════ Projects screen, empty ════════
  if (want('start')) {
    await shot('library-empty', { wait: 1200, marks: [{ sel: 'button:has-text("New recording")', at: 'bl' }, { sel: 'button:has-text("Import")', at: 'bl' }], note: 'library-empty' });
  }

  // ════════ Recorder ════════
  if (want('recorder')) {
    // what a first recording looks like before macOS lets Cutaway record the screen
    await setPermissions(app, { screen: 'undetermined' });
    await S(() => window.__cutaway.actions.newRecording());
    await page.waitForSelector('[aria-label="What to record"]', { timeout: 20000 });
    await shot('record-permission', { wait: 3500, marks: [{ sel: '[data-testid="perm-allow-screen"]', at: 'l' }] });
    await setPermissions(app, {});
    await S(() => window.__cutaway.actions.backToLibrary());
    await sleep(800);
    await S(() => window.__cutaway.actions.newRecording());
    await page.waitForSelector('[aria-label="What to record"]', { timeout: 20000 });
    await sleep(4000);
    // the camera menus start empty in a new profile: pick Camera A and the microphone
    if (/No camera/.test(await page.locator('[data-testid="camera-a"]').innerText())) { await click('[data-testid="camera-a"]'); await click('.rb-pop [role="menuitemradio"]:has-text("FaceTime HD Camera")'); }
    await click('button:has-text("Screen + bubble")');
    await sleep(2500);
    await shot('record', { marks: [
      { sel: '[aria-label="What to record"]', at: 'l' },
      { sel: '[data-testid="layout-picker"]', at: 'l' },
      { sel: '[data-testid="camera-a"]', at: 'b' },
      { sel: '[data-testid="camera-b"]', at: 'b' },
      { sel: '[data-testid="microphone"]', at: 'b' },
      { sel: '[data-testid="system-audio"]', at: 'b' },
      { sel: '[data-testid="options"]', at: 'b' },
      { sel: '[data-testid="start-recording"]', at: 'r' },
    ] });
    // the camera bubble: move it and change its shape
    await page.locator('[data-testid="cam-bubble-a"]').hover();
    await shot('record-bubble', { wait: 500, hover: true, marks: [{ sel: '[data-testid="cam-bubble-a"]', n: 1, at: 'l' }, { sel: '[data-testid="cam-shape"]', n: 2, at: 'b', pad: 3 }], crop: 'marks', margin: 120, minW: 640, minH: 380 });
    // two cameras: pick the iPhone as camera B
    await click('[data-testid="camera-b"]');
    await shot('record-camera-b-menu', { wait: 500, marks: [{ sel: '[data-testid="camera-b"]', n: 1, at: 'b' }, { sel: '.rb-pop [role="menuitemradio"]:has-text("iPhone Camera")', n: 2, at: 'l' }] });
    await click('.rb-pop [role="menuitemradio"]:has-text("iPhone Camera")');
    await esc();
    await sleep(2500);
    await shot('record-two-cameras', { marks: [{ sel: '[data-testid="camera-a"]', at: 'b' }, { sel: '[data-testid="camera-b"]', at: 'b' }, { sel: '[data-testid="cam-bubble-a"]', at: 'l' }, { sel: '[data-testid="cam-bubble-b"]', at: 'r' }] });
    await click('[data-testid="camera-b"]'); await click('.rb-pop [role="menuitemradio"]:has-text("record a second camera")'); await esc();
    // recording options
    await click('[data-testid="options"]');
    await shot('record-options', { wait: 500, marks: [{ sel: '[data-testid="options"]', n: 1, at: 'l' }, { sel: '.rb-pop div.row.between:has(> button[role="switch"][aria-label="Record Cutaway too (for demos)"])', n: 2, at: 'l' }, { sel: '.rb-pop div.row.between:has(> button[role="switch"][aria-label="Teleprompter"])', n: 3, at: 'l' }, { sel: '.rb-pop div.row.between:has(> button[role="switch"][aria-label="Show my camera while recording"])', n: 4, at: 'l' }] });
    await esc();
    // the teleprompter button under Start recording
    await shot('record-start', { wait: 300, marks: [{ sel: '[data-testid="start-recording"]', n: 1, at: 'l' }, { sel: '[data-testid="record-prompter"]', n: 2, at: 'l' }], crop: 'marks', margin: 90, minW: 620, minH: 360 });
    await S(() => window.__cutaway.actions.backToLibrary());
    await sleep(800);
  }

  // ════════ Teleprompter (its own floating window) ════════
  if (want('teleprompter')) {
    await S(() => window.__cutaway.actions.newRecording());
    await page.waitForSelector('[data-testid="record-prompter"]', { timeout: 30000 });
    await sleep(2500);
    const opened = app.waitForEvent('window', { timeout: 15000 });
    await click('[data-testid="record-prompter"]');
    const tp = await opened;
    await tp.waitForSelector('[data-testid="prompter"]');
    await tp.setViewportSize({ width: 760, height: 420 }).catch(() => {});
    const tpShot = async (name, marks) => {
      await tp.waitForTimeout(600);
      const file = path.join(out, `${name}.png`);
      saveMarks(name, { src: name, marks: await measure(tp, marks) });
      await tp.screenshot({ path: file });
      shrinkPng(file);
      console.log('shot', name);
    };
    await tp.fill('[data-testid="prompter-script"]', "Hi! Today I'll show you how to make a shared shopping list in Listful.\n\nFirst, click New list, and give it a name. Let's call it Weekend groceries.\n\nNow type each item and press Enter. Eggs. Milk. And some strawberries.\n\nTo share it, click the Share button at the top, and pick a friend.\n\nAnd that's it. Your list is ready to use.");
    await tpShot('teleprompter-edit', [{ sel: '[data-testid="prompter-script"]', at: 'tl' }, { sel: '.tp-bar.edit', at: 'tl' }, { sel: '[data-testid="prompter-edit"]', at: 'b' }]);
    await tp.click('[data-testid="prompter-edit"]');
    await tp.waitForSelector('[data-testid="prompter-stage"]');
    await tpShot('teleprompter', [{ sel: '[data-testid="prompter-play"]', at: 'b' }, { sel: '[data-testid="prompter-left"]', at: 'b' }, { sel: '[data-testid="prompter-edit"]', at: 'b' }, { sel: '[data-testid="prompter-place"]', at: 'b' }, { sel: '[data-testid="prompter-settings"]', at: 'b' }, { sel: '[data-testid="prompter-wpm"]', at: 't' }]);
    await tp.click('[data-testid="prompter-place"]');
    await tpShot('teleprompter-places', [{ sel: '[data-testid="prompter-places"]', at: 'l' }]);
    await tp.click('[data-testid="prompter-place"]');
    await tp.click('[data-testid="prompter-settings"]');
    await tpShot('teleprompter-settings', [{ sel: '[data-testid="prompter-follow"]', at: 'l' }]);
    await S(() => window.cutaway.app.notesWindow(false)).catch(() => {});
    await S(() => window.__cutaway.actions.backToLibrary());
    await sleep(800);
  }

  // ════════ Import → first cut ════════
  await newProject([f('Screen recording.mp4'), f('Camera.mp4')], 'My first video', { firstCut: false });
  if (want('firstcut')) {
    await S(() => window.__cutaway.useApp.getState().setView('sources'));
    await shot('sources', { wait: 2500, marks: [{ sel: page.locator('button').filter({ hasText: /^Review sync/ }).first(), at: 'l' }] });
    await S(() => window.__cutaway.useApp.getState().setView('brief'));
    await shot('first-cut-brief', { wait: 1200, marks: [{ sel: 'button:has-text("Create first cut")', at: 'l' }] });
  }
  await S(() => window.__cutaway.jobs.startFirstCut(false));
  await page.waitForFunction(() => (window.__cutaway.useApp.getState().job?.stages?.length ?? 0) > 2, null, { timeout: 60000 }).catch(() => {});
  // the first cut's stages, as in jobs/shared.ts
  const stages = [['validate', 'Check media'], ['sync', 'Align sources'], ['transcribe', 'Transcribe on this Mac'], ['visual', 'Watch the screen'], ['assemble', 'Assemble the cut'], ['preview', 'Prepare preview']].map(([id, label]) => ({ id, label }));
  await page.waitForFunction(() => !window.__cutaway.useApp.getState().job, null, { timeout: 300000 });
  await S(() => window.__cutaway.saveNow());
  if (want('firstcut') && stages.length) {
    // What the assembling step says while Claude writes the edit (the same words the app shows; numbers are an example).
    await S((stages) => {
      const now = Date.now();
      const st = stages.map((s, i) => {
        const assemble = s.id === 'assemble';
        const before = i < stages.findIndex((x) => x.id === 'assemble');
        return { ...s, status: assemble ? 'running' : before ? 'done' : 'pending', detail: assemble ? 'Claude is writing the edit: 9 cuts, 2 view changes, 3 zooms so far · 1:12. Video and audio stay on this Mac.' : '', startedAt: assemble ? now - 72000 : before ? now - 90000 + i * 3000 : null, endedAt: before ? now - 87000 + i * 3000 : null, progress: null, remote: assemble };
      });
      const s = window.__cutaway.useApp.getState();
      s.setView('brief');
      s.setJob({ kind: 'first-cut', status: 'running', stages: st, error: null, startedAt: now - 95000, abort: new AbortController() });
    }, stages);
    await shot('first-cut-working', { wait: 900, marks: [{ sel: '.stage-row.running', at: 'l' }], crop: [360, 90, 760, 620] });
    await S(() => { const s = window.__cutaway.useApp.getState(); s.setJob(null); s.setView('edit'); });
  }

  // ════════ Editor ════════
  await S((p) => window.__cutaway.actions.importAudioToTimeline(p), [f('Upbeat acoustic.mp3')]);
  await sleep(1500);
  if (want('editor')) {
    await panel('background');
    await ui({ expandedTimeline: false, advancedTimeline: false });
    await seek(27);
    await shot('editor', { wait: 2500, marks: [
      { sel: 'header.titlebar', at: 'b', pad: -2 },
      { sel: '.stage-preview canvas', at: 'tl' },
      { sel: '.ed-tools', at: 'b' },
      { sel: '.ed-controls .tbtn.play', at: 'l', pad: 10 },
      { sel: '.editor-timeline', at: 'tl', pad: -3 },
      { sel: '.inspector', at: 'tl', pad: -2 },
    ], note: 'editor-tour' });
    // the Add bar, close up
    await shot('add-bar', { wait: 300, marks: [
      { sel: '.ed-tools button[aria-label="Add zoom at the playhead"]', at: 'r' },
      { sel: '[data-testid="tools-view"]', at: 'r' },
      { sel: '[data-testid="tools-hide"]', at: 'r' },
      { sel: '.ed-tools button[aria-label="Add a callout at the playhead"]', at: 'r' },
      { sel: '.ed-tools button[aria-label^="Add text at the playhead"]', at: 'r' },
    ], crop: 'marks', margin: 70, minW: 560, minH: 520 });
    // words to know: the parts of the editor that have names
    await shot('editor-words', { wait: 200, marks: [
      { sel: '.stage-preview canvas', at: 'tl' },
      { sel: '[data-testid="playhead-split"]', at: 'r', pad: 5 },
      { sel: '.tl-clip', at: 'tl' },
      { sel: '.editor-timeline', at: 'tr', n: 4 },
      { sel: '.inspector', at: 'tl', n: 5 },
    ] });
    for (const tab of ['background', 'cursor', 'camera', 'audio', 'text', 'motion', 'chat', 'review', 'history']) {
      await panel(tab);
      await shot(`tab-${tab}`, { wait: 700 });
    }
    // captions: the switch and the styles
    await panel('captions');
    await tryStep('captions-on', async () => {
      await click('[role="switch"][aria-label="Hide transcript"]');
      await click('.insp-card button:has-text("Bold")');
      await seek(21);
      await shot('captions-on', { wait: 1200, marks: [{ sel: 'button[aria-label="Captions"]', at: 'l' }, { sel: '[role="switch"][aria-label="Hide transcript"]', at: 'l' }, { sel: '.insp-card button:has-text("Bold")', at: 'b' }] });
      await click('[role="switch"][aria-label="Hide transcript"]');
    });
    // transcript: select words, then Cut
    await panel('transcript');
    await tryStep('transcript-select', async () => {
      const words = page.locator('.transcript-body p span');
      const all = await words.allInnerTexts();
      let i = all.findIndex((w, k) => /^let'?s$/i.test(w.trim()) && /^call$/i.test(all[k + 1]?.trim()) && /^it,?$/i.test(all[k + 2]?.trim()) && /^let'?s$/i.test(all[k + 3]?.trim()));
      if (i < 0) i = 5;
      const a = await words.nth(i).boundingBox(), b = await words.nth(i + 2).boundingBox();
      await page.mouse.move(a.x + 3, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move(b.x + b.width - 3, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
      await sleep(600);
      await shot('transcript-select', { wait: 300, marks: [{ sel: 'button[aria-label="Transcript"]', at: 'l' }, { box: [a.x - 4, a.y - 4, b.x + b.width - a.x + 8, a.height + 8], at: 'l' }, { sel: '.transcript button:has-text("Cut")', at: 'b' }] });
    });
    // things you add
    await panel('background'); await seek(24.6);
    await tryStep('add-zoom', async () => {
      await click('[aria-label="Add zoom at the playhead"]');
      await shot('add-zoom', { marks: [{ sel: '.ed-tools button[aria-label="Add zoom at the playhead"]', at: 'r' }, { sel: '.tl-zoom, .zoom-block, [data-kind="zoom"]', at: 'tl' }, { sel: 'button:has-text("Click the preview to set the target")', at: 'l' }, { sel: '.insp-card input[type="range"]', at: 'l' }] });
    });
    await panel('background'); await seek(4);
    await tryStep('add-text', async () => { await click('[aria-label^="Add text at the playhead"]'); await shot('add-text'); });
    await panel('background'); await seek(29.5);
    await tryStep('add-callout', async () => {
      await click('[aria-label="Add a callout at the playhead"]');
      await shot('add-callout', { marks: [{ sel: '.ed-tools button[aria-label="Add a callout at the playhead"]', at: 'r' }, { sel: page.locator('.editor-timeline').getByText('Callout', { exact: true }).filter({ visible: true }).last(), at: 'tl' }, { sel: '.inspector input:not([type="range"]):not([type="checkbox"])', at: 'l' }, { sel: 'button:has-text("Click the preview to place it")', at: 'l' }] });
    });
    await panel('background');
    await tryStep('crop', async () => { await click('[data-testid="crop-open"]'); await shot('crop', { marks: [{ sel: '[data-testid="crop-rect"]', at: 'tl' }, { sel: '[aria-label="Crop shape"], .crop-controls [role="radiogroup"]', at: 'l' }, { sel: '[data-testid="crop-browser-bar"]', at: 'l' }, { sel: '[data-testid="crop-apply"]', at: 'l' }] }); });
    await panel('background');
    await tryStep('output-shape', async () => { await click('button[title="Output shape"]'); await shot('output-shape', { marks: [{ sel: 'button[title="Output shape"]', at: 'r' }] }); });
    await page.mouse.click(700, 900).catch(() => {});
    await panel('background');
    await tryStep('add-menu-fx', async () => { await click('[data-testid="fx-add"]'); await shot('add-menu-fx', { marks: [{ sel: '[data-testid="fx-add"]', at: 'l' }] }); });
    // B-roll: a picture over the footage
    await panel('background'); await seek(6);
    await tryStep('b-roll', async () => {
      await setOpenFiles(app, [f('listful-logo.png')]);
      await click('[data-testid="fx-add"]');
      await shot('b-roll-menu', { wait: 300, marks: [{ sel: '[data-testid="fx-add"]', at: 'l' }, { sel: page.getByText(/Photo or video over the footage/).first(), at: 'l' }] });
      await click(page.getByText(/Photo or video over the footage/).first());
      await sleep(1500);
      await seek(7);
      await shot('b-roll', { wait: 1200, marks: [{ sel: '.stage-preview canvas', at: 'tl' }, { sel: page.locator('.editor-timeline').getByText(/listful-logo/).filter({ visible: true }).first(), at: 'tl' }, { sel: '.inspector', at: 'tl' }] });
    });
    await panel('background');
    await tryStep('add-menu-video', async () => { await click('[data-testid="video-add"]'); await shot('add-menu-video', { marks: [{ sel: '[data-testid="video-add"]', at: 'l' }] }); });
    await tryStep('add-menu-audio', async () => { await click('[data-testid="audio-add"]'); await shot('add-menu-audio', { marks: [{ sel: '[data-testid="audio-add"]', at: 'l' }] }); });
    await panel('background'); await seek(10);
    await tryStep('clip-selected', async () => { await page.locator('.tl-clip').first().click({ force: true, position: { x: 200, y: 20 } }); await shot('clip-selected'); });
    // the View and Hide menus
    await panel('background'); await seek(12);
    await tryStep('view-menu', async () => { await click('[data-testid="tools-view"]'); await shot('view-menu', { marks: [{ sel: '[data-testid="tools-view"]', at: 'l' }, { sel: '[data-testid="tools-view-menu"]', at: 'tr' }] }); });
    await tryStep('hide-menu', async () => { await click('[data-testid="tools-hide"]'); await shot('hide-menu', { marks: [{ sel: '[data-testid="tools-hide"]', at: 'l' }, { sel: '[data-testid="tools-hide-menu"] >> text=Blur an area', at: 'r' }, { sel: '[data-testid="tools-hide-menu"] >> text=Find private info', at: 'r' }] }); });
    await panel('background'); await seek(12);
    await tryStep('mask', async () => { await click('[data-testid="tools-hide"]'); await click('[data-testid="tools-hide-menu"] >> text=Blur an area'); await shot('mask'); });
    await panel('background');
    await tryStep('find-sensitive', async () => { await click('[data-testid="tools-hide"]'); await click('[data-testid="tools-hide-menu"] >> text=Find private info'); await shot('find-sensitive', { wait: 2500 }); });
    await panel('background');
    await ui({ advancedTimeline: true });
    await shot('timeline-advanced', { wait: 900, marks: [{ sel: '[data-testid="timeline-advanced"]', at: 'l' }] });
    await ui({ advancedTimeline: false });
    // the command menu (⌘K)
    await panel('background');
    await tryStep('command-menu', async () => {
      await S(() => window.dispatchEvent(new CustomEvent('cutaway-palette')));
      await sleep(500);
      await page.keyboard.type('caption', { delay: 40 });
      await shot('command-menu', { wait: 600, marks: [{ sel: 'button[aria-label="Command menu"]', at: 'b' }, { sel: '.palette input, [role="dialog"] input', at: 'l' }] });
    });
    // rename from the title bar
    await panel('background');
    await tryStep('rename-title', async () => {
      await page.locator('[data-testid="project-rename"]').hover();
      await shot('rename-title', { wait: 400, hover: true, marks: [{ sel: '[data-testid="project-rename"]', at: 'l' }], crop: [430, 0, 620, 64] });
    });
    await S(() => window.__cutaway.saveNow());
  }

  // ════════ Two cameras ════════
  if (want('twocams')) {
    await newProject([f('Screen recording.mp4'), f('Camera.mp4'), f('iPhone camera.mp4')], 'Two cameras', { roles: { 'Camera.mp4': 'cameraA', 'iPhone camera.mp4': 'cameraB' } });
    await panel('camera'); await seek(3);
    await tryStep('two-cameras-tab', async () => {
      await page.locator('[data-testid="two-cameras-note"]').waitFor({ timeout: 8000 });
      await shot('two-cameras-tab', { marks: [{ sel: 'button[aria-label="Camera"]', at: 'l' }, { sel: '[data-testid="two-cameras-note"]', at: 'l' }, { sel: page.locator('.inspector button', { hasText: /^Camera B$/ }).first(), at: 'b' }] });
      await click(page.locator('.inspector button', { hasText: /^Camera B$/ }).first());
      await seek(20); await sleep(1500); await seek(20.5);
      await shot('two-cameras-b', { wait: 1500, marks: [{ sel: '.stage-preview canvas', at: 'tl' }, { sel: page.locator('.inspector button', { hasText: /^Camera B$/ }).first(), at: 'b' }] });
      await click(page.locator('.inspector button', { hasText: /^Camera A$/ }).first());
    });
    await panel('background'); await seek(9);
    await tryStep('two-cameras-switch', async () => {
      await click('[data-testid="tools-view"]');
      await shot('two-cameras-switch', { wait: 400, marks: [{ sel: '[data-testid="tools-view"]', at: 'l' }, { sel: '[data-testid="tools-view-menu"] >> text=Other camera', at: 'r' }] });
      await click('[data-testid="tools-view-menu"] >> text=Other camera');
      await ui({ advancedTimeline: true, expandedTimeline: true });
      await sleep(800);
      await shot('two-cameras-timeline', { wait: 900, marks: [{ sel: '[data-testid="timeline-advanced"]', at: 'l' }, { sel: 'button[title^="Show or hide the layout"]', at: 'b' }, { sel: '.tl-layout.selected, .tl-layout.on, [data-kind="layout"].selected', at: 't' }] });
      await ui({ advancedTimeline: false, expandedTimeline: false });
    });
    await S(() => window.__cutaway.saveNow());
  }

  // ════════ Browser recording → Hide browser bar ════════
  if (want('browser')) {
    await newProject([f('Browser recording.mp4'), f('Camera.mp4')], 'Weekend groceries in Listful');
    await panel('background'); await seek(26);
    await shot('browser-before', { wait: 1800 });
    await tryStep('crop-browser-bar', async () => {
      await click('[data-testid="crop-open"]');
      await sleep(1200);
      await click('[data-testid="crop-browser-bar"]');
      await page.waitForSelector('[data-testid="crop-browser-note"]:has-text("Found"), [data-testid="crop-browser-note"]:has-text("No browser")', { timeout: 30000 });
      await shot('crop-browser-bar', { wait: 600, marks: [{ sel: '[data-testid="crop-browser-bar"]', at: 'l' }, { sel: '[data-testid="crop-rect"]', at: 'tl' }, { sel: '[data-testid="crop-apply"]', at: 'b' }] });
      await click('[data-testid="crop-apply"]');
      await shot('browser-after', { wait: 1800, marks: [{ sel: '[data-testid="crop-open"]', at: 'r' }, { sel: '.stage-preview canvas', at: 'tl', n: 2 }] });
    });
    await S(() => window.__cutaway.saveNow());
  }

  // ════════ Package: thumbnail and title ════════
  const openFirst = async (view) => {
    const list = await S(() => window.cutaway.library.list());
    const p = list.find((x) => /My first video/.test(x.name)) ?? list[0];
    await S(async (p) => { await window.__cutaway.actions.openProjectAt(p); }, p.path);
    await sleep(800);
    await S((v) => window.__cutaway.useApp.getState().setView(v), view);
  };
  if (want('package')) {
    await openFirst('package');
    await shot('package', { wait: 1800, marks: [{ sel: 'button:has-text("Create three concepts")', at: 'l' }] });
    await click('button:has-text("Create three concepts")');
    if (!hasFal) {
      await page.waitForSelector('[data-testid="art-gate"]', { timeout: 15000 });
      await shot('art-gate', { wait: 600, marks: [{ sel: '[data-testid="art-gate-fal"]', at: 'b' }, { sel: '[data-testid="art-gate-continue"]', at: 'b' }] });
      await click('[data-testid="art-gate-continue"]');
      await page.waitForSelector('.pkg', { timeout: 30000 });
      await shot('package-concepts', { wait: 1500 });
    } else {
      // the consent question, then three whole AI thumbnails (fal.ai, about $0.15 each)
      await page.waitForSelector('[data-testid="consent-allow"]', { timeout: 30000 });
      await shot('art-consent', { wait: 500, marks: [{ sel: '[data-testid="consent-allow"]', at: 'l' }] });
      await click('[data-testid="consent-allow"]');
      await page.waitForSelector('[data-testid="pictures-progress"]', { timeout: 30000 });
      await shot('art-making', { wait: 1500, marks: [{ sel: '[data-testid="pictures-progress"]', at: 'tl' }] });
      await page.waitForSelector('[data-testid="pictures-progress"]', { state: 'detached', timeout: 400000 });
      await shot('package-concepts', { wait: 2500, marks: [
        { sel: '.pkg-left', at: 'tr' },
        { sel: '.pkg-left button:has-text("Choose this pair")', at: 'r' },
        { sel: '.pkg-center .thumb-editor, .pkg-center .thumb, .pkg-center canvas, .pkg-center img', at: 'tl' },
        { sel: '[data-testid="art-panel"]', at: 'tl' },
      ], note: 'package-tour' });
      // your photo and your logo
      await setOpenFiles(app, [f('Headshot.jpg')]);
      await click('[data-testid="thumb-photo-choose"]');
      await setOpenFiles(app, [f('listful-logo.png')]);
      await click('[data-testid="thumb-logo-add"]');
      await page.locator('[data-testid="thumb-logo-name"]').first().fill('Listful');
      await page.keyboard.press('Enter');
      await page.locator('[data-testid="art-direction"]').fill('Show the Listful logo on a phone in my hand');
      await clearToasts();
      await page.locator('[data-testid="art-panel"]').scrollIntoViewIfNeeded();
      await shot('art-panel', { wait: 600, marks: [
        { sel: '[data-testid="thumb-photo"]', at: 'l' },
        { sel: '[data-testid="thumb-logos"]', at: 'l' },
        { sel: '[data-testid="art-direction"]', at: 'l' },
        { sel: '[data-testid="art-generate"]', at: 'l' },
      ], crop: 'marks', margin: 50, minW: 620, minH: 560 });
      await click('[data-testid="art-generate"]');
      await page.waitForSelector('[data-testid="art-note"]', { timeout: 400000 });
      await clearToasts();
      await page.locator('[data-testid="art-variations"]').scrollIntoViewIfNeeded();
      await shot('art-variations', { wait: 1500, marks: [
        { sel: '.pkg-center .thumb-editor, .pkg-center .thumb, .pkg-center canvas, .pkg-center img', at: 'tl' },
        { sel: '[data-testid="art-variations"]', at: 'l' },
        { sel: '[data-testid="thumb-back"]', at: 'l' },
      ] });
      await click(page.locator('.pkg-left button:has-text("Choose this pair")').first());
      await sleep(3000);
      await shot('package-chosen', { wait: 1000, marks: [{ sel: '.pkg-left button:has-text("Chosen pair")', at: 'r' }, { sel: '.pkg-center .pill.accent', at: 'r' }] });
    }
  }

  // ════════ Shorts ════════
  if (want('shorts')) {
    await openFirst('shorts');
    await shot('shorts', { wait: 1800, marks: [{ sel: '[data-testid="shorts-find"]', at: 'b' }, { sel: '[data-testid="shorts-by-hand"]', at: 'b' }] });
    await tryStep('shorts-found', async () => {
      await click('[data-testid="shorts-find"]');
      await page.waitForSelector('[data-testid="short-candidate"]', { timeout: 60000 });
      await click(page.locator('[data-testid="short-keep"]').first());
      await sleep(1500);
      await page.locator('[data-testid="short-title"]').fill('Share a list in 20 seconds');
      await page.keyboard.press('Tab');
      await shot('shorts-found', { wait: 800, marks: [
        { sel: '[data-testid="short-saved"], [data-testid="short-candidate"]', at: 'tr' },
        { sel: '[data-testid="short-preview"]', at: 'tl' },
        { sel: '[data-testid="short-title"]', at: 'l' },
        { sel: '[data-testid="short-start-earlier"]', at: 'l' },
        { sel: page.getByText('Frame', { exact: true }).first(), at: 'l' },
        { sel: page.getByText('Captions', { exact: true }).last(), at: 'l' },
      ] });
    });
  }

  // ════════ Export ════════
  if (want('export')) {
    await openFirst('export');
    await shot('export', { wait: 1800, marks: [{ sel: 'text=Format', at: 'l' }, { sel: 'text=Export to', at: 'l' }, { sel: page.locator('button').filter({ hasText: /^Export to file/ }).last(), at: 'l' }] });
    await tryStep('export-youtube', async () => {
      await click(page.getByText('YouTube package', { exact: true }).first());
      await shot('export-youtube', { wait: 800, marks: [{ sel: page.getByText('YouTube package', { exact: true }).first(), at: 'b' }, { sel: page.locator('button').filter({ hasText: /package/ }).last(), at: 'l' }] });
    });
  }

  // ════════ Projects list ════════
  if (want('library')) {
    await S(() => window.__cutaway.actions.backToLibrary());
    await shot('library', { wait: 2500 });
    await tryStep('library-rename', async () => {
      const card = page.locator('.project-card').first();
      await card.hover();
      await click(card.locator('button[aria-label="Project actions"]'));
      await shot('library-menu', { wait: 400, marks: [{ sel: '.project-card button[aria-label="Project actions"]', at: 'l' }, { sel: '[data-testid="card-rename"]', at: 'r' }] });

    });
  }

  // ════════ Settings ════════
  if (want('settings')) {
    await S(() => window.__cutaway.useApp.getState().go('settings'));
    await shot('settings', { wait: 1200 });
    // (Processing, AI generation and AI tools show test-run notes or key hints in this throwaway profile: not shot here.)
    for (const [label, name] of [['Shortcuts', 'settings-shortcuts']]) {
      await tryStep(name, async () => {
        await click(page.locator('nav button, .settings-nav button, [role="tab"]').filter({ hasText: new RegExp(`^${label}$`) }).first());
        // never show even the last four characters of a key
        await S(() => {
          const hide = (v) => v.replace(/…[A-Za-z0-9]{4}\b/g, '…••••');
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (/…[A-Za-z0-9]{4}\b/.test(n.nodeValue)) n.nodeValue = hide(n.nodeValue);
          for (const i of document.querySelectorAll('input, textarea')) { if (i.placeholder) i.placeholder = hide(i.placeholder); if (i.value) i.value = hide(i.value); }
        });
        await shot(name, { wait: 900 });
      });
    }
  }
} finally {
  await app.close();
}
console.log('done', out);
