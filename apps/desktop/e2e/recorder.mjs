// End-to-end check of the recorder rework, against the real native helper:
//   A. layout choice (diagrams, what is recorded, the stage preview)
//   B. countdown over the target: overlay window lifecycle, Escape, gone before the recorder starts
//   C. self-view bubble during a take: frames from the recorder, hide/show, gone afterwards
//   D. the chosen layout becomes the project's base layout
//   E. browser tabs: listing without prompting, the Allow… path, iPhone camera hint
//   F. real captures (only when Screen Recording is already allowed for the test process):
//        window capture cropped to its "page area", kept right through a resize;
//        an overlay window kept on screen during a take never appears in the recorded frames
// Usage: node e2e/recorder.mjs [outDir for screenshots]
// A–E use the helper's synthetic mode. F records a test window this script opens itself and a
// small corner of the display into a throwaway folder that is deleted at the end. Nothing here
// asks macOS for a permission or answers a prompt.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-recorder'));
fs.mkdirSync(out, { recursive: true });
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';

let failed = 0;
const notes = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { app, page, dir, userData, libraryDir } = await launch({ settings: { countdownSeconds: 2 } });
const shot = async (name, target = page) => {
  await target.waitForTimeout(300);
  await target.screenshot({ path: path.join(out, `${name}.png`) }).catch((e) => console.log('shot failed', name, e.message));
};
const overlays = (fn) => app.evaluate(fn);
const settingsOnDisk = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));

/** One decoded frame of a recording, as raw RGB. */
function frameAt(file, t) {
  const [w, h] = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  const rgb = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const px = (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 3; return [rgb[i], rgb[i + 1], rgb[i + 2]]; };
  return { w, h, px, rgb };
}
const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

/** Recorder calls the app makes, with the config it really sent. */
async function spyOnStart({ synthetic, cameras }) {
  await page.evaluate(({ synthetic, cameras }) => {
    window.__real ??= window.cutaway.record.start;
    window.__startCalls = [];
    window.cutaway.record.start = (projectPath, config) => {
      window.__startCalls.push(JSON.parse(JSON.stringify(config)));
      if (!synthetic) return window.__real(projectPath, config);
      // Generated pictures instead of devices; what the recorder was asked for is kept as it was sent.
      const cams = cameras ?? config.cameras;
      return window.__real(projectPath, { ...config, synthetic: true, screen: config.screen ? { ...config.screen } : null, cameras: cams, microphone: null, systemAudio: false, captureKeys: false });
    };
  }, { synthetic, cameras });
}
const SYN_A = [{ slot: 'A', deviceId: 'synthetic-a', width: 1280, height: 720, fps: 30 }];

async function openRecorder() {
  await page.evaluate(() => window.__cutaway.actions.newRecording());
  await page.waitForSelector('.record .rec-bar', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.rec-stage .spinner'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
}
async function finishTake() {
  await page.evaluate(() => window.cutaway.record.stop());
  await page.waitForSelector('[data-testid="quick-share"]', { timeout: 30000 });
  await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.setView('sources'); s.go('project'); });
  await page.waitForTimeout(700);
}

try {
  const perms = await page.evaluate(async () => ({ screen: await window.cutaway.app.permission('screen'), camera: await window.cutaway.app.permission('camera') }));
  console.log('permissions', JSON.stringify(perms));
  const screenOk = perms.screen === 'granted';

  // ───────────────────────── A. layout choice ─────────────────────────
  await openRecorder();
  if (!screenOk) notes.push('Screen Recording is not allowed for the test process: the recorder shows its permission card, so layout, countdown and real-capture checks that need a screen target were limited.');
  const layouts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="layout-picker"] .lay')].map((b) => ({ id: b.dataset.layout, label: b.textContent.trim(), on: b.getAttribute('aria-checked') === 'true', svg: !!b.querySelector('svg') })));
  check('five layouts are offered as diagrams', layouts.length === 5 && layouts.every((l) => l.svg), layouts.map((l) => l.label).join(' | '));
  check('the default is screen with a camera bubble', layouts.find((l) => l.on)?.id === 'overlay');
  check('a layout that needs a camera says so while none is chosen', /needs a camera/.test((await page.locator('[data-testid="layout-note"]').textContent().catch(() => '')) ?? ''));
  check('what will be recorded is named on the stage', /\d+ × \d+/.test((await page.locator('[data-testid="target-chip"]').textContent().catch(() => '')) ?? ''), (await page.locator('[data-testid="target-chip"]').textContent().catch(() => '')) ?? '');
  await shot('01-layout-overlay');
  await page.click('.lay[data-layout="split"]');
  check('side by side shows a camera panel beside the screen', (await page.getAttribute('[data-testid="stage-comp"]', 'data-layout')) === 'split' && (await page.locator('[data-testid="comp-cam"]').isVisible()));
  await shot('02-layout-split');
  await page.click('.lay[data-layout="presenter"]');
  check('camera + screen puts the screen in a small inset', (await page.getAttribute('[data-testid="stage-comp"]', 'data-layout')) === 'presenter');
  await shot('03-layout-presenter');
  await page.click('.lay[data-layout="camera"]');
  check('camera only switches the target to Camera', (await page.getAttribute('.rb-mode[data-mode="none"]', 'aria-pressed')) === 'true' && (await page.getAttribute('.lay[data-layout="camera"]', 'aria-checked')) === 'true');
  await page.click('.lay[data-layout="screen"]');
  check('choosing a screen layout again returns to the previous target', (await page.getAttribute('.rb-mode[data-mode="display"]', 'aria-pressed')) === 'true' && (await page.getAttribute('.lay[data-layout="screen"]', 'aria-checked')) === 'true');
  check('the choice is remembered', JSON.parse(await page.evaluate(() => localStorage.getItem('cutaway.recorder'))).layout === 'screen');

  // camera menu: how to get an iPhone camera
  await page.click('[data-testid="camera-b"]');
  const hint = (await page.locator('[data-testid="iphone-hint"]').first().textContent().catch(() => '')) ?? '';
  const cams = await page.evaluate(() => window.cutaway.native.devices().then((d) => d.cameras.map((c) => c.kind)));
  check('cameras report their kind', cams.every((k) => ['builtin', 'external', 'iphone', 'deskview'].includes(k)), JSON.stringify(cams));
  check('the camera menu explains how to use an iPhone when none is connected', cams.includes('iphone') || /iPhone as a camera/.test(hint), hint.slice(0, 70));
  await shot('04-camera-menu');
  await page.keyboard.press('Escape');

  // ───────────────────────── B. countdown over the target ─────────────────────────
  await page.click('.lay[data-layout="split"]');
  await spyOnStart({ synthetic: true, cameras: SYN_A });
  const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => d.bounds));
  await page.click('[data-testid="start-recording"]');
  await page.waitForFunction(() => document.querySelector('.countdown'), null, { timeout: 20000 });
  await sleep(450);
  const up = await overlays(() => {
    const o = globalThis.__recorderOverlays;
    const w = o.countdown();
    return w && !w.isDestroyed() ? { bounds: w.getBounds(), visible: w.isVisible(), focusable: w.isFocusable(), top: w.isAlwaysOnTop(), state: o.countdownState() } : null;
  });
  check('a countdown overlay window opens', !!up && up.visible, JSON.stringify(up?.bounds));
  check('it covers the display that holds the target', !!up && displays.some((d) => d.x === up.bounds.x && d.y === up.bounds.y && Math.abs(d.width - up.bounds.width) <= 2 && Math.abs(d.height - up.bounds.height) <= 2), `${JSON.stringify(up?.bounds)} of ${JSON.stringify(displays)}`);
  check('it floats above everything and takes no focus', !!up && up.top && !up.focusable);
  check('it is told what is being recorded', !!up?.state && up.state.kind === 'display' && up.state.rect.width > 0 && !!up.state.label, JSON.stringify(up?.state));
  const overlayPage = app.windows().find((w) => w.url().includes('#countdown'));
  check('the overlay page exists', !!overlayPage);
  if (overlayPage) {
    await overlayPage.waitForSelector('[data-testid="countdown-number"]', { timeout: 5000 }).catch(() => {});
    const drawn = await overlayPage.evaluate(() => { const t = document.querySelector('[data-testid="countdown-target"]').getBoundingClientRect(); return { n: document.querySelector('[data-testid="countdown-number"]')?.textContent, label: document.querySelector('.cd-label')?.textContent, t: [t.x, t.y, t.width, t.height], win: [innerWidth, innerHeight], bg: getComputedStyle(document.body).backgroundColor }; });
    check('it shows the number over the target with its name', /^[12]$/.test(drawn.n ?? '') && /Recording/.test(drawn.label ?? ''), JSON.stringify(drawn));
    check('the page behind the number is transparent', /rgba\(0, 0, 0, 0\)|transparent/.test(drawn.bg), drawn.bg);
    await shot('05-countdown-overlay', overlayPage);
  }
  const minimised = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isMinimized()));
  check('Cutaway steps aside when it covers the target', minimised);
  // Escape (caught globally while the overlay is up) cancels and brings Cutaway back.
  check('Escape is caught globally during the countdown', await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape')));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#'))?.webContents.send('countdown:cancel'));
  await page.waitForFunction(() => !document.querySelector('.countdown'), null, { timeout: 8000 });
  await sleep(900);
  const afterCancel = await overlays(() => ({ gone: !globalThis.__recorderOverlays.countdown(), state: globalThis.__recorderOverlays.countdownState() }));
  check('cancelling removes the overlay', afterCancel.gone && afterCancel.state === null);
  check('and releases Escape', !(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape'))));
  check('and brings Cutaway back', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isMinimized())));
  check('nothing was recorded', (await page.evaluate(() => window.__startCalls.length)) === 0 && (await page.locator('[data-testid="start-recording"]').isVisible()));

  // ───────────────────────── C. a take: overlay gone first, self-view during ─────────────────────────
  await page.click('[data-testid="start-recording"]');
  await page.waitForSelector('.rec-live', { timeout: 30000 });
  await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .rec-state')?.textContent ?? ''), null, { timeout: 30000 });
  check('the overlay was gone before the recorder was started', (await app.evaluate(() => globalThis.__overlayAtStart)) === false);
  check('no overlay window is left during the take', await overlays(() => !globalThis.__recorderOverlays.countdown()));
  const sent = await page.evaluate(() => window.__startCalls[0]);
  check('the recorder is asked for camera stills for the self-view', sent?.cameraPreview?.fps > 0 && sent.cameraPreview.width >= 240, JSON.stringify(sent?.cameraPreview));
  await sleep(1600);
  const bubble = await overlays(() => { const w = globalThis.__recorderOverlays.selfView(); return w && !w.isDestroyed() ? { b: w.getBounds(), top: w.isAlwaysOnTop(), visible: w.isVisible() } : null; });
  check('a self-view bubble opens while recording with a camera', !!bubble && bubble.visible && bubble.top, JSON.stringify(bubble?.b));
  check('the bubble is square and small', !!bubble && bubble.b.width === bubble.b.height && bubble.b.width >= 120 && bubble.b.width <= 560);
  const bubblePage = app.windows().find((w) => w.url().includes('#selfview'));
  if (bubblePage) {
    await bubblePage.waitForFunction(() => document.querySelector('[data-testid="self-view"]')?.dataset.live === '1', null, { timeout: 8000 }).catch(() => {});
    const live = await bubblePage.evaluate(() => {
      const c = document.querySelector('.sv-picture');
      const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return { live: document.querySelector('[data-testid="self-view"]').dataset.live, slot: document.querySelector('[data-testid="self-view"]').dataset.slot, w: c.width, h: c.height, px: [d[0], d[1], d[2]] };
    });
    // The synthetic camera A is a green field with a white bar sweeping across.
    check('it shows the camera being recorded, from the recorder itself', live.live === '1' && live.slot === 'cameraA' && live.w >= 240 && (near(live.px, [40, 110, 40], 40) || near(live.px, [255, 255, 255], 30)), JSON.stringify(live));
    await shot('06-self-view', bubblePage);
    const a = await bubblePage.evaluate(() => document.querySelector('.sv-picture').toDataURL().length);
    await sleep(700);
    const b = await bubblePage.evaluate(() => document.querySelector('.sv-picture').toDataURL().length);
    check('the picture keeps updating', a > 1000 && b > 1000);
  } else check('the self-view page exists', false);
  const controller = app.windows().find((w) => w.url().includes('#controller'));
  if (controller) {
    await controller.waitForSelector('[data-testid="controller-selfview"]', { timeout: 6000 });
    await shot('07-controller', controller);
    await controller.click('[data-testid="controller-selfview"]');
    await sleep(600);
    check('the controller hides the bubble', await overlays(() => !globalThis.__recorderOverlays.selfView()));
    check('hiding is remembered', settingsOnDisk().selfView?.hidden === true);
    check('the take carries on without the bubble', (await page.evaluate(() => window.__cutaway.useApp.getState() && document.querySelector('.rec-live .rec-state')?.textContent)) === 'Recording');
    await controller.click('[data-testid="controller-selfview"]');
    await sleep(900);
    check('and brings it back', await overlays(() => { const w = globalThis.__recorderOverlays.selfView(); return !!w && !w.isDestroyed(); }) && settingsOnDisk().selfView?.hidden === false);
  } else check('the controller has a self-view toggle', false);
  await finishTake();
  await sleep(500);
  check('the bubble closes when the take ends', await overlays(() => !globalThis.__recorderOverlays.selfView()));

  // ───────────────────────── D. layout → project ─────────────────────────
  const proj = await page.evaluate(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return { base: p.edit.baseLayout ?? null, roles: p.sources.map((s) => s.role), at1: core.resolveLayout(p, 1).mode, segments: p.edit.layouts.length }; });
  check('the take was recorded with a screen and camera A', proj.roles.includes('screen') && proj.roles.includes('cameraA'), proj.roles.join(','));
  check('side by side became the project base layout', proj.base === 'split' && proj.at1 === 'split' && proj.segments === 0, JSON.stringify(proj));

  // presenter and screen-only takes in fresh projects
  await openRecorder();
  await page.click('.lay[data-layout="presenter"]');
  await page.evaluate(() => window.cutaway.app.setSettings({ countdownSeconds: 0 }).then((s) => window.__cutaway.useApp.getState().setSettings(s)));
  await spyOnStart({ synthetic: true, cameras: SYN_A });
  await page.click('[data-testid="start-recording"]');
  await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .rec-state')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(1200);
  await finishTake();
  const pres = await page.evaluate(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; const g = core.layoutGeometry('presenter', p.edit.appearance, 16 / 9); return { base: p.edit.baseLayout, at: core.resolveLayout(p, 0.8).mode, cam: g.camera.rect, scr: g.screen.rect, out: p.edit.appearance.output }; });
  check('camera + screen is kept as "presenter"', pres.base === 'presenter' && pres.at === 'presenter');
  check('in it the camera fills the frame and the screen is a small inset', pres.cam.w === pres.out.width && pres.cam.h === pres.out.height && pres.scr.w < pres.out.width * 0.45 && pres.scr.x > pres.out.width * 0.5, JSON.stringify(pres.scr));
  await page.evaluate(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForTimeout(1500);
  await shot('08-editor-presenter');

  await openRecorder();
  await page.click('.lay[data-layout="screen"]');
  await spyOnStart({ synthetic: true });
  await page.click('[data-testid="start-recording"]');
  await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .rec-state')?.textContent ?? ''), null, { timeout: 30000 });
  await sleep(900);
  const screenOnly = await page.evaluate(() => window.__startCalls[0]);
  check('screen only records no camera', Array.isArray(screenOnly.cameras) && screenOnly.cameras.length === 0 && !!screenOnly.screen);
  check('and opens no self-view bubble', await overlays(() => !globalThis.__recorderOverlays.selfView()));
  await finishTake();
  check('screen only is the base layout of that take', (await page.evaluate(() => window.__cutaway.useApp.getState().project.edit.baseLayout)) === 'screen');

  // Camera only. No camera can be chosen here without macOS asking for Camera access, so the
  // recorder UI is checked for holding Start back, and the take itself is made through the API.
  await openRecorder();
  await page.click('.lay[data-layout="camera"]');
  const noCam = await page.evaluate(() => ({ disabled: document.querySelector('[data-testid="start-recording"]').disabled, why: document.querySelector('.rec-status')?.textContent ?? '' }));
  check('camera only with no camera chosen holds Start back and says why', noCam.disabled && /Turn on at least one source|Choose a screen or a camera/.test(noCam.why), noCam.why.slice(0, 80));
  const camTake = await page.evaluate(async (cams) => {
    const { useApp, recording } = window.__cutaway;
    const start = window.__real ?? window.cutaway.record.start;
    const { takeDir } = await start(useApp.getState().projectPath, { fps: 30, screen: null, cameras: cams, microphone: null, systemAudio: false, synthetic: true });
    await new Promise((r) => setTimeout(r, 1500));
    const manifest = await window.cutaway.record.stop();
    await recording.addTakeToProject(manifest, takeDir, { layout: 'camera' });
    const p = useApp.getState().project;
    return { roles: p.sources.map((s) => s.role), base: p.edit.baseLayout ?? null, both: recording.baseLayoutFor('split', ['screen']) ?? null, none: recording.baseLayoutFor('camera', ['screen']) ?? null };
  }, SYN_A);
  check('a camera-only take has no screen and "camera" as its base layout', !camTake.roles.includes('screen') && camTake.roles.includes('cameraA') && camTake.base === 'camera', JSON.stringify(camTake));
  check('a layout that needs both pictures is not kept when the take has only one', camTake.both === null && camTake.none === null);

  // ───────────────────────── E. browser tabs ─────────────────────────
  await openRecorder();
  const tabs = await page.evaluate(() => window.cutaway.native.browserTabs());
  console.log('browsers', JSON.stringify(tabs.browsers.map((b) => ({ name: b.name, permission: b.permission, tabs: b.tabs.length })), null, 0), 'accessibility', tabs.accessibility);
  check('browsers are listed with a permission state, without asking', Array.isArray(tabs.browsers) && tabs.browsers.every((b) => ['granted', 'denied', 'undetermined', 'not-running', 'unknown'].includes(b.permission)));
  check('no tab is returned for a browser that has not allowed it', tabs.browsers.filter((b) => b.permission !== 'granted').every((b) => b.tabs.length === 0));
  check('tabs carry a title and host only', tabs.browsers.flatMap((b) => b.tabs).every((t) => typeof t.title === 'string' && typeof t.host === 'string' && !/[/?#]/.test(t.host) && !('url' in t)));
  if (screenOk) {
    await page.click('.rb-mode[data-mode="tab"]');
    await page.waitForSelector('[data-testid="tab-picker"]', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="tab-picker"] .spinner'), null, { timeout: 20000 }).catch(() => {});
    const pickerText = (await page.locator('[data-testid="tab-picker"]').textContent()) ?? '';
    const pending = tabs.browsers.filter((b) => b.permission === 'undetermined');
    if (tabs.browsers.length === 0) check('with no browser open the picker says how to continue', /No browser is open/.test(pickerText));
    else if (pending.length) {
      check('a browser that has not been asked gets an Allow… button and an explanation', (await page.locator(`[data-testid="tab-allow-${pending[0].bundleId}"]`).isVisible()) && /macOS will ask once/.test(pickerText));
      notes.push(`Automation permission for ${pending.map((b) => b.name).join(', ')} is undecided for the test process: macOS would have prompted, so listing, selecting and cropping a real tab was not exercised.`);
    }
    check('Start is held back until a tab is chosen', /Choose a browser tab/.test((await page.locator('.rec-status').textContent()) ?? '') || tabs.browsers.some((b) => b.tabs.length));
    await shot('09-tab-picker');
    await page.click('.rb-mode[data-mode="display"]');
  }

  // ───────────────────────── F. real captures ─────────────────────────
  if (!screenOk) {
    notes.push('Real captures (window crop, overlay exclusion) were skipped: Screen Recording is not allowed for the test process.');
  } else {
    await page.evaluate(() => { window.cutaway.record.start = window.__real ?? window.cutaway.record.start; });
    const scratch = path.join(dir, 'real');
    fs.mkdirSync(scratch, { recursive: true });

    // F1. A window this test opens: an 80 pt red "toolbar" over a green "page".
    const TOOLBAR = 80;
    const opened = await app.evaluate(async ({ BrowserWindow }, toolbar) => {
      const w = new BrowserWindow({ width: 640, height: 480, x: 120, y: 120, show: true, frame: false, title: 'cutaway-crop-test', backgroundColor: '#00c040' });
      await w.loadURL(`data:text/html,<body style="margin:0;background:rgb(0,192,64)"><div style="height:${toolbar}px;background:rgb(230,20,20)"></div></body>`);
      globalThis.__cropWin = w;
      return { id: Number(w.getMediaSourceId().split(':')[1]), bounds: w.getBounds() };
    }, TOOLBAR);
    await sleep(900);
    const cropProject = path.join(scratch, 'crop.cutaway');
    fs.mkdirSync(cropProject, { recursive: true });
    let cropTake = null;
    try {
      const started = await page.evaluate(({ project, id, top }) => window.cutaway.record.start(project, { fps: 30, screen: { type: 'window', windowId: id, crop: { top, left: 0, bottom: 0, right: 0 }, showCursor: false }, cameras: [], microphone: null, systemAudio: false }), { project: cropProject, id: opened.id, top: TOOLBAR });
      await sleep(1800);
      await app.evaluate(() => globalThis.__cropWin.setBounds({ x: 160, y: 140, width: 800, height: 600 }));
      await sleep(2600);
      const manifest = await page.evaluate(() => window.cutaway.record.stop());
      cropTake = { dir: started.takeDir, manifest };
    } catch (e) {
      check('a window can be recorded with a crop', false, e.message);
    }
    await app.evaluate(() => { globalThis.__cropWin?.destroy(); globalThis.__cropWin = null; });
    if (cropTake) {
      const src = cropTake.manifest.sources.find((s) => s.id === 'screen');
      const file = path.join(cropTake.dir, src.file);
      check('the cropped take has the size of the page area', src.pointWidth === 640 && src.pointHeight === 480 - TOOLBAR, `${src.pointWidth} × ${src.pointHeight} points, ${src.width} × ${src.height} px`);
      const early = frameAt(file, 0.8);
      const green = [0, 192, 64], red = [230, 20, 20];
      const rowIs = (f, y, c) => [0.2, 0.5, 0.8].every((x) => near(f.px(f.w * x, y), c, 60));
      check('the first rows are page, not toolbar', rowIs(early, 2, green) && rowIs(early, early.h * 0.5, green) && !rowIs(early, 2, red), JSON.stringify([early.px(early.w / 2, 2), early.px(early.w / 2, early.h / 2)]));
      const late = frameAt(file, Math.max(1, cropTake.manifest.duration - 0.5));
      // After the resize the page is 800 × 520 in a 640 × 400 frame: scaled to fit, so still no toolbar anywhere.
      let reds = 0;
      for (let y = 0; y < late.h; y += 4) for (let x = 0; x < late.w; x += 8) if (near(late.px(x, y), red, 60)) reds += 1;
      check('after the window is resized mid-take the toolbar still stays out', reds === 0 && near(late.px(late.w / 2, late.h / 2), green, 60), `${reds} toolbar-coloured samples; centre ${JSON.stringify(late.px(late.w / 2, late.h / 2))}`);
    }

    // F2. An overlay window kept on screen during a take must not be in the recording.
    const d0 = await page.evaluate(() => window.cutaway.native.devices().then((d) => d.displays.find((x) => x.main) ?? d.displays[0]));
    const rect = { x: d0.x + 40, y: d0.y + 60, width: 420, height: 300 };
    const regionProject = path.join(scratch, 'region.cutaway');
    fs.mkdirSync(regionProject, { recursive: true });
    let regionTake = null;
    try {
      const started = await page.evaluate(({ project, rect, displayId }) => window.cutaway.record.start(project, { fps: 30, screen: { type: 'region', displayId, rect, showCursor: false }, cameras: [], microphone: null, systemAudio: false }), { project: regionProject, rect, displayId: d0.id });
      await sleep(900);
      // The same overlay the countdown uses, drawn exactly over the recorded area (violet outline, dimmed surround, big number).
      await page.evaluate((rect) => window.cutaway.app.countdown({ rect, kind: 'region', label: 'exclusion test', count: 3 }), rect);
      await sleep(1900);
      const visible = await overlays(() => { const w = globalThis.__recorderOverlays.countdown(); return !!w && !w.isDestroyed() && w.isVisible(); });
      const manifest = await page.evaluate(() => window.cutaway.record.stop());
      await page.evaluate(() => window.cutaway.app.countdownEnd(false));
      regionTake = { dir: started.takeDir, manifest, visible };
    } catch (e) {
      check('a region can be recorded with the overlay up', false, e.message);
      await page.evaluate(() => window.cutaway.app.countdownEnd(false)).catch(() => {});
    }
    if (regionTake) {
      const src = regionTake.manifest.sources.find((s) => s.id === 'screen');
      const f = frameAt(path.join(regionTake.dir, src.file), Math.max(1.2, regionTake.manifest.duration - 0.4));
      // The overlay's outline is a 3 pt violet line just inside the recorded rectangle.
      const violet = [123, 108, 246];
      let hits = 0, samples = 0;
      const inset = Math.max(1, Math.round((f.w / rect.width) * 1.5));
      for (let x = 4; x < f.w - 4; x += 3) for (const y of [inset, f.h - 1 - inset]) { samples += 1; if (near(f.px(x, y), violet, 28)) hits += 1; }
      for (let y = 4; y < f.h - 4; y += 3) for (const x of [inset, f.w - 1 - inset]) { samples += 1; if (near(f.px(x, y), violet, 28)) hits += 1; }
      check('the overlay was on screen during the take', regionTake.visible);
      check('and is not in the recorded frames', hits < samples * 0.05, `${hits} of ${samples} edge samples match the overlay outline`);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    check('scratch captures were deleted', !fs.existsSync(scratch));
  }
} catch (e) {
  failed += 1;
  console.log('ERROR', e.stack ?? e.message);
  await shot('zz-error');
} finally {
  await app.close().catch(() => {});
  fs.rmSync(path.join(dir, 'real'), { recursive: true, force: true });
  fs.rmSync(libraryDir, { recursive: true, force: true });
}
for (const n of notes) console.log(`NOTE  ${n}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
