// End-to-end check of the recording and editing UX additions, against the real native helper:
//   A. recording flags (controller button, IPC, global shortcut lifetime) and the quick-share sheet
//   B. flags in the editor (ruler markers, review list, next/previous shortcut) and in the first cut
//   C. editable keyboard shortcuts (rebind, conflict, validation, menu accelerator, reset)
//   D. the crop sheet (drag, numeric fields, aspect lock, reset)
//   E. sensitive-data detection on a generated frame of made-up secrets, offered as masks
//   F. deleting a take from the quick-share sheet
// Usage: node e2e/ux.mjs [outDir for screenshots]
// Uses the helper's synthetic capture mode (no permissions) and never touches real projects,
// the real clipboard or the Trash. Every "secret" below is invented for the test.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-ux'));
fs.mkdirSync(out, { recursive: true });
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-ux-save-'));
const fxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-ux-fx-'));
process.env.CUTAWAY_E2E_SAVE_DIR = saveDir;
process.env.CUTAWAY_E2E_SCREEN = 'granted';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const { app, page, dir, userData, libraryDir } = await launch({ settings: { countdownSeconds: 1 } });
const shot = async (name, target = page) => {
  await target.waitForTimeout(350);
  await target.screenshot({ path: path.join(out, `${name}.png`) }).catch((e) => console.log('shot failed', name, e.message));
};
const state = (fn, arg) => page.evaluate(fn, arg);
const settingsOnDisk = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));

/** Start a take through the recorder UI, fed by the helper's generated sources. */
async function startSyntheticTake() {
  await page.waitForSelector('.record .rec-bar', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.rec-stage .spinner'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    if (window.__realStart) return;
    window.__realStart = window.cutaway.record.start;
    window.cutaway.record.start = (projectPath, config) => window.__realStart(projectPath, { ...config, synthetic: true, screen: { ...(config.screen ?? { type: 'display', displayId: 1, showCursor: false }) }, cameras: [{ slot: 'A', deviceId: 'synthetic-a', width: 1280, height: 720, fps: 30 }], microphone: { deviceId: '' }, systemAudio: false, captureKeys: false });
  });
  await page.click('[data-testid="start-recording"]');
  await page.waitForSelector('.rec-live', { timeout: 30000 });
  await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .rec-state')?.textContent ?? ''), null, { timeout: 30000 });
}

try {
  // ───────────────────────── A. flags while recording + quick share ─────────────────────────
  await page.evaluate(() => {
    // Record what would go to the clipboard and the Trash instead of touching either.
    window.__copied = [];
    window.cutaway.app.copyFile = async (p) => void window.__copied.push(p);
    window.__discarded = [];
    window.cutaway.library.discardTake = async (p) => void window.__discarded.push(p);
  });
  const flagBefore = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+F'));
  await page.click('button:has-text("New recording")');
  await startSyntheticTake();
  await page.waitForTimeout(1200);
  const flagDuring = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+F'));
  const controller = app.windows().find((w) => w.url().includes('#controller'));
  check('the recording controller opens', !!controller);
  if (controller) {
    await controller.waitForSelector('[data-testid="controller-flag"]', { timeout: 8000 });
    await controller.click('[data-testid="controller-flag"]');
    await page.waitForTimeout(900);
    await controller.click('[data-testid="controller-flag"]');
    await page.waitForTimeout(400);
    const pill = await controller.evaluate(() => ({ count: document.querySelector('.ctl.flag .count')?.textContent, title: document.querySelector('.ctl.flag')?.getAttribute('title') }));
    check('the controller flag button counts flags and names the shortcut', pill.count === '2' && /⌃⌥F/.test(pill.title ?? ''), JSON.stringify(pill));
    await shot('01-controller-flagged', controller);
  }
  await page.waitForTimeout(800);
  // two presses at once are one flag
  await page.evaluate(() => Promise.all([window.cutaway.record.flag(), window.cutaway.record.flag()]));
  await page.waitForTimeout(1200);
  const liveFlag = await page.evaluate(() => document.querySelector('[data-testid="rec-flag"]')?.textContent?.trim());
  check('the main window shows the running flag count', /3/.test(liveFlag ?? ''), liveFlag);
  check('the flag shortcut is registered only while a take is running (before / during)', flagBefore === false && flagDuring === true, `${flagBefore} / ${flagDuring}`);
  await page.evaluate(() => window.cutaway.record.stop());
  await page.waitForSelector('[data-testid="quick-share"]', { timeout: 30000 });
  const flagAfter = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+F'));
  check('the flag shortcut is released when the take ends', flagAfter === false);
  await page.waitForFunction(() => document.querySelector('.qs-thumb img')?.naturalWidth > 0, null, { timeout: 15000 }).catch(() => {});
  const bundle = () => path.join(libraryDir, fs.readdirSync(libraryDir).find((n) => n.endsWith('.cutaway')));
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle(), 'media', 'take-001', 'manifest.json'), 'utf8'));
  check('the take manifest stores three flags in take seconds, in order', Array.isArray(manifest.flags) && manifest.flags.length === 3 && manifest.flags.every((t, i, a) => t > 0 && t < manifest.duration && (i === 0 || t > a[i - 1] + 0.25)), JSON.stringify(manifest.flags));
  const sheet = await page.evaluate(() => ({
    thumb: document.querySelector('.qs-thumb img')?.naturalWidth ?? 0,
    duration: document.querySelector('.qs-duration')?.textContent,
    sub: document.querySelector('.qs-sub')?.textContent,
    focused: document.activeElement?.getAttribute('data-testid'),
    buttons: [...document.querySelectorAll('.qs-card button')].map((b) => b.textContent.trim()),
  }));
  check('quick share shows a frame of the take, its length and what was recorded', sheet.thumb > 0 && /0:0\d/.test(sheet.duration ?? '') && /screen/.test(sheet.sub ?? '') && /3 flags/.test(sheet.sub ?? ''), JSON.stringify({ thumb: sheet.thumb, duration: sheet.duration, sub: sheet.sub }));
  check('quick share offers open, copy, save, first cut and delete; Open in editor has focus', ['Open in editor', 'Copy to clipboard', 'Save video as…', 'First cut', 'Delete take'].every((l) => sheet.buttons.includes(l)) && sheet.focused === 'qs-open', sheet.buttons.join(' | '));
  await shot('02-quick-share');

  const t0 = Date.now();
  await page.click('[data-testid="qs-copy"]');
  await page.waitForSelector('[data-testid="qs-progress"]', { timeout: 10000 }).catch(() => {});
  await shot('03-quick-share-rendering');
  await page.waitForSelector('[data-testid="qs-done"]', { timeout: 180000 });
  const copyMs = Date.now() - t0;
  const copied = await page.evaluate(() => window.__copied);
  const probe = (file) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height:format=duration', '-of', 'json', file]).toString());
  const copiedInfo = copied[0] && fs.existsSync(copied[0]) ? probe(copied[0]) : null;
  const v = copiedInfo?.streams.find((s) => s.codec_type === 'video');
  check('Copy renders the take without opening the editor and hands a playable H.264 file to the clipboard', copied.length === 1 && v?.codec_name === 'h264' && Math.abs(Number(copiedInfo.format.duration) - manifest.duration) < 0.6, `${copied[0]?.replace(dir, '…')} ${v?.width}x${v?.height} ${Number(copiedInfo?.format.duration).toFixed(2)}s vs take ${manifest.duration}s, ${copyMs} ms`);
  check('the quick render lives in the project cache, not in the exports folder', (copied[0] ?? '').includes('/cache/quick-share/'));
  const t1 = Date.now();
  await page.click('[data-testid="qs-save"]');
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('[data-testid="qs-done"] .grow')?.textContent ?? ''), null, { timeout: 180000 });
  const saveMs = Date.now() - t1;
  const savedFiles = fs.readdirSync(saveDir);
  const quickFolders = fs.readdirSync(path.join(bundle(), 'cache', 'quick-share')).filter((n) => !n.startsWith('.'));
  check('Save video as… writes the file where the creator chose, reusing the same render', savedFiles.length === 1 && savedFiles[0].endsWith('.mp4') && fs.statSync(path.join(saveDir, savedFiles[0])).size === fs.statSync(copied[0]).size && quickFolders.length === 1, `${savedFiles[0]} in ${saveMs} ms; ${quickFolders.length} render(s)`);
  await shot('04-quick-share-saved');

  // ───────────────────────── B. flags in the editor and the first cut ─────────────────────────
  await page.click('[data-testid="qs-open"]');
  await page.waitForSelector('.editor .timeline', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const projFlags = await state(() => window.__cutaway.useApp.getState().project.flags.map((f) => f.t));
  const markers = await page.evaluate(() => document.querySelectorAll('.tl-flag').length);
  check('Open in editor lands in the editor with the flags on the timeline ruler', markers === 3 && projFlags.length === 3 && projFlags.every((t, i) => Math.abs(t - manifest.flags[i]) < 0.002), `${markers} markers at ${projFlags.join(', ')}`);
  await state(() => window.__cutaway.useApp.getState().setPanels({ inspector: true, tab: 'review' }));
  await page.waitForSelector('[data-testid="review-flags"]', { timeout: 5000 });
  const listed = await page.evaluate(() => document.querySelectorAll('[data-testid="review-flags"] .review-row').length);
  check('the Review card lists the flags', listed === 3, `${listed}`);
  await shot('05-editor-flags');
  const outTime = () => state(() => window.__cutaway.usePlayback.getState().time);
  await state(() => window.__cutaway.usePlayback.getState().seek(0));
  await page.keyboard.press(']');
  const j1 = await outTime();
  await page.keyboard.press(']');
  const j2 = await outTime();
  await page.keyboard.press('[');
  const j3 = await outTime();
  check('] and [ move the playhead between flags', Math.abs(j1 - projFlags[0]) < 0.05 && Math.abs(j2 - projFlags[1]) < 0.05 && Math.abs(j3 - projFlags[0]) < 0.05, `${j1.toFixed(2)} → ${j2.toFixed(2)} → ${j3.toFixed(2)}`);
  await page.click('.tl-flag >> nth=2');
  const j4 = await outTime();
  check('clicking a flag on the ruler goes to it', Math.abs(j4 - projFlags[2]) < 0.05, j4.toFixed(2));

  // The built-in rules must leave flagged moments in the video and say so.
  await state(async () => {
    const { useApp, jobs } = window.__cutaway;
    // Pretend the whole take is dead air around the flags, so the pacing rules have something to remove.
    await jobs.startFirstCut(false);
    void useApp;
  });
  await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return (!s.job || s.job.status !== 'running') && !!s.project.firstCut; }, null, { timeout: 240000 });
  const cut = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { summary: p.firstCut.summary, cuts: p.edit.cuts.map((c) => [+c.start.toFixed(2), +c.end.toFixed(2), c.kind]), flags: p.flags.map((f) => +f.t.toFixed(2)) };
  });
  check('the first cut keeps every flagged moment and says so', cut.flags.every((t) => !cut.cuts.some(([a, b]) => t >= a && t <= b)) && /3 flagged moments/.test(cut.summary), `${cut.cuts.length} cuts ${JSON.stringify(cut.cuts)}; "${cut.summary.slice(0, 160)}…"`);
  const guard = await state(() => {
    const { core } = window.__cutaway;
    const p = window.__cutaway.useApp.getState().project;
    const t = p.flags[1].t;
    const r = core.keepFlaggedMoments([{ op: 'cut', start: t - 2, end: t + 2, kind: 'silence' }, { op: 'cut', start: t - 0.3, end: t + 0.3, kind: 'filler' }], [t]);
    return { n: r.protectedCount, ops: r.ops.map((o) => [+(o.start - t).toFixed(2), +(o.end - t).toFixed(2)]) };
  });
  check('a pause that spans a flag is trimmed around it and a short cut on it is dropped', guard.n === 2 && guard.ops.length === 2 && guard.ops.every(([a, b]) => b <= -0.39 || a >= 0.39), JSON.stringify(guard));

  // ───────────────────────── C. editable shortcuts ─────────────────────────
  await state(() => window.__cutaway.useApp.getState().go('settings'));
  await page.click('.set-nav button:has-text("Shortcuts")');
  await page.waitForSelector('[data-testid="shortcuts-section"]', { timeout: 5000 });
  const key = (id) => page.locator(`[data-command="${id}"] .keymap-key`);
  const rows = await page.evaluate(() => document.querySelectorAll('.keymap-row').length);
  check('Settings lists every command with its shortcut', rows >= 30 && (await key('cut').textContent()) === 'X' && (await key('flag').textContent()) === '⌃⌥F' && (await key('record-toggle').textContent()) === '⌃⌥⌘R', `${rows} commands`);
  await shot('06-shortcuts');
  await key('cut').click();
  check('clicking a shortcut waits for keys', (await key('cut').textContent()) === 'Press keys…');
  await page.keyboard.press('KeyK');
  await page.waitForTimeout(300);
  check('pressing a free key rebinds the command and saves it', (await key('cut').textContent()) === 'K' && settingsOnDisk().shortcuts?.cut === 'K', JSON.stringify(settingsOnDisk().shortcuts));
  await key('keep').click();
  await page.keyboard.press('KeyK');
  await page.waitForSelector('[data-command="keep"] .keymap-warn', { timeout: 3000 });
  const warn = await page.textContent('[data-command="keep"] .keymap-warn');
  check('a key that is already taken is not assigned silently', /already used by “Cut the selected range”/.test(warn) && (settingsOnDisk().shortcuts?.keep === undefined), warn.trim().slice(0, 90));
  await shot('07-shortcut-conflict');
  await page.click('[data-testid="shortcut-replace"]');
  await page.waitForTimeout(300);
  check('"Use it here instead" moves the key and leaves the other command without one', (await key('keep').textContent()) === 'K' && (await key('cut').textContent()) === 'None' && settingsOnDisk().shortcuts.cut === '' && settingsOnDisk().shortcuts.keep === 'K', JSON.stringify(settingsOnDisk().shortcuts));
  await key('palette').click();
  await page.keyboard.press('KeyP');
  await page.waitForSelector('[data-command="palette"] .keymap-warn', { timeout: 3000 });
  const problem = await page.textContent('[data-command="palette"] .keymap-warn');
  check('a menu command refuses a bare letter', /needs ⌘, ⌃ or ⌥/.test(problem) && settingsOnDisk().shortcuts.palette === undefined, problem.trim().slice(0, 80));
  await page.keyboard.press('Meta+Shift+KeyP');
  await page.waitForTimeout(400);
  const accel = await app.evaluate(({ Menu }) => {
    const find = (items, label) => { for (const i of items) { if (i.label === label) return i; const s = i.submenu && find(i.submenu.items, label); if (s) return s; } return null; };
    return find(Menu.getApplicationMenu().items, 'Command Menu…')?.accelerator ?? null;
  });
  check('a rebound menu command changes the application menu accelerator', (await key('palette').textContent()) === '⇧⌘P' && accel === 'Shift+Command+P', `${accel}`);
  await key('flag').click();
  await page.keyboard.press('Alt+KeyG');
  await page.waitForSelector('[data-command="flag"] .keymap-warn', { timeout: 3000 });
  const globalProblem = await page.textContent('[data-command="flag"] .keymap-warn');
  await page.keyboard.press('Control+Alt+KeyG');
  await page.waitForTimeout(300);
  check('a shortcut that works from any app needs two modifiers', /at least two/.test(globalProblem) && (await key('flag').textContent()) === '⌃⌥G', globalProblem.trim().slice(0, 70));
  await key('undo').click();
  await page.keyboard.press('Meta+KeyQ');
  await page.waitForSelector('[data-command="undo"] .keymap-warn', { timeout: 3000 });
  check('system shortcuts cannot be taken', /used by macOS/.test(await page.textContent('[data-command="undo"] .keymap-warn')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc leaves a shortcut as it was', (await key('undo').textContent()) === '⌘Z');
  await shot('08-shortcuts-changed');

  // The editor obeys the changed keys.
  await state(() => { const s = window.__cutaway.useApp.getState(); s.go('project'); s.setView('edit'); });
  await page.waitForSelector('.editor .timeline', { timeout: 10000 });
  const counts = () => state(() => { const e = window.__cutaway.useApp.getState().project.edit; return { cuts: e.cuts.length, locks: e.locks.length }; });
  const selectRange = () => state(() => { const s = window.__cutaway.useApp.getState(); const d = s.project.duration; s.select({ kind: 'range', range: { start: d * 0.55, end: d * 0.55 + 0.4 } }); });
  const c0 = await counts();
  await selectRange();
  await page.keyboard.press('KeyX');
  await page.waitForTimeout(200);
  const c1 = await counts();
  await selectRange();
  await page.keyboard.press('KeyK');
  await page.waitForTimeout(200);
  const c2 = await counts();
  check('in the editor the old key does nothing and the new key runs its command', c1.cuts === c0.cuts && c1.locks === c0.locks && c2.locks === c0.locks + 1 && c2.cuts === c0.cuts, `${JSON.stringify(c0)} → X ${JSON.stringify(c1)} → K ${JSON.stringify(c2)}`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cutaway-palette')));
  await page.waitForSelector('.palette', { timeout: 3000 });
  await page.fill('.palette input', 'flag');
  const hints = await page.evaluate(() => [...document.querySelectorAll('.palette-list button')].map((b) => `${b.querySelector('.grow')?.textContent}=${b.querySelector('.kbd')?.textContent ?? ''}`));
  check('the command menu prints the current shortcuts', hints.some((h) => h === 'Go to the next flag=]') && hints.some((h) => h === 'Go to the previous flag=['), hints.join(' | '));
  await page.keyboard.press('Escape');
  await state(() => window.__cutaway.useApp.getState().go('settings'));
  await page.click('.set-nav button:has-text("Shortcuts")');
  await page.click('[data-testid="shortcuts-reset"]');
  await page.waitForTimeout(400);
  const accel2 = await app.evaluate(({ Menu }) => {
    const find = (items, label) => { for (const i of items) { if (i.label === label) return i; const s = i.submenu && find(i.submenu.items, label); if (s) return s; } return null; };
    return find(Menu.getApplicationMenu().items, 'Command Menu…')?.accelerator ?? null;
  });
  check('Reset all restores every default, in Settings, on disk and in the menu', (await key('cut').textContent()) === 'X' && (await key('keep').textContent()) === 'L' && Object.keys(settingsOnDisk().shortcuts).length === 0 && accel2 === 'Command+K', `${accel2}`);
  await state(() => { const s = window.__cutaway.useApp.getState(); s.go('project'); s.setView('edit'); });
  await page.waitForSelector('.editor .timeline', { timeout: 10000 });
  await selectRange();
  await page.keyboard.press('KeyX');
  await page.waitForTimeout(200);
  const c3 = await counts();
  check('after the reset X cuts again', c3.cuts === c2.cuts + 1, JSON.stringify(c3));
  await state(() => window.__cutaway.useApp.getState().undo());

  // ───────────────────────── D. crop sheet ─────────────────────────
  await page.click('[data-testid="crop-open"]');
  await page.waitForSelector('[data-testid="crop-sheet"]', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('.crop-frame img')?.naturalWidth > 0, null, { timeout: 15000 }).catch(() => {});
  const cropState = () => page.evaluate(() => {
    const f = document.querySelector('.crop-frame').getBoundingClientRect();
    const r = document.querySelector('[data-testid="crop-rect"]').getBoundingClientRect();
    const px = Object.fromEntries(['x', 'y', 'w', 'h'].map((k) => [k, Number(document.querySelector(`[data-testid="crop-${k}"]`).value)]));
    return { frame: { x: f.x, y: f.y, w: f.width, h: f.height }, rect: { x: (r.x - f.x) / f.width, y: (r.y - f.y) / f.height, w: r.width / f.width, h: r.height / f.height }, px, still: document.querySelector('.crop-frame img')?.naturalWidth ?? 0, of: document.querySelector('.crop-fields .mono')?.textContent };
  });
  const s0 = await cropState();
  const [srcW, srcH] = s0.of.match(/\d+/g).map(Number);
  check('the crop sheet shows a still of the frame with the whole frame selected', s0.still > 0 && Math.abs(s0.rect.w - 1) < 0.01 && Math.abs(s0.rect.h - 1) < 0.01 && s0.px.w === srcW && s0.px.h === srcH, `${srcW}×${srcH}, still ${s0.still}px`);
  const drag = async (sel, dx, dy) => {
    const b = await page.locator(sel).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + b.height / 2 + dy / 2, { steps: 4 });
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  await drag('.crop-handle.se', -s0.frame.w * 0.25, -s0.frame.h * 0.3);
  const s1 = await cropState();
  check('dragging a corner resizes the rectangle and the pixel fields follow', Math.abs(s1.rect.w - 0.75) < 0.02 && Math.abs(s1.rect.h - 0.7) < 0.02 && Math.abs(s1.px.w - srcW * 0.75) < srcW * 0.02 && Math.abs(s1.px.h - srcH * 0.7) < srcH * 0.02, JSON.stringify(s1.px));
  await drag('[data-testid="crop-rect"]', s0.frame.w * 0.1, s0.frame.h * 0.1);
  const s2 = await cropState();
  check('dragging inside moves it without changing its size', Math.abs(s2.rect.x - 0.1) < 0.02 && Math.abs(s2.rect.y - 0.1) < 0.02 && Math.abs(s2.rect.w - s1.rect.w) < 0.005, JSON.stringify(s2.px));
  await page.fill('[data-testid="crop-x"]', String(Math.round(srcW * 0.2)));
  await page.fill('[data-testid="crop-w"]', String(Math.round(srcW * 0.5)));
  const s3 = await cropState();
  check('typing pixel values moves and sizes the rectangle', Math.abs(s3.rect.x - 0.2) < 0.005 && Math.abs(s3.rect.w - 0.5) < 0.005, JSON.stringify(s3.px));
  await page.click('.crop-controls .seg button:has-text("1:1")');
  await page.waitForTimeout(150);
  const s4 = await cropState();
  check('the 1:1 shape makes the crop square in pixels', Math.abs(s4.px.w - s4.px.h) <= 2, JSON.stringify(s4.px));
  await drag('.crop-handle.e', -s0.frame.w * 0.08, 0);
  const s5 = await cropState();
  check('a locked shape stays locked while resizing', Math.abs(s5.px.w - s5.px.h) <= 2 && s5.px.w < s4.px.w, JSON.stringify(s5.px));
  await shot('09-crop-sheet');
  await page.click('[data-testid="crop-apply"]');
  await page.waitForTimeout(300);
  const applied = await state(() => window.__cutaway.useApp.getState().project.edit.appearance.crop);
  check('Apply writes the crop to the project as one undoable step', Math.abs(applied.w * srcW - s5.px.w) <= 1.5 && Math.abs(applied.h * srcH - s5.px.h) <= 1.5 && Math.abs(applied.x * srcW - s5.px.x) <= 1.5, JSON.stringify(applied));
  await shot('10-cropped-preview');
  await state(() => window.__cutaway.useApp.getState().undo());
  const undone = await state(() => window.__cutaway.useApp.getState().project.edit.appearance.crop);
  check('undo removes the crop', undone.w === 1 && undone.h === 1 && undone.x === 0);
  await state(() => window.__cutaway.useApp.getState().redo());
  await page.click('[data-testid="crop-open"]');
  await page.waitForSelector('[data-testid="crop-sheet"]');
  await page.click('[data-testid="crop-reset"]');
  await page.click('[data-testid="crop-apply"]');
  await page.waitForTimeout(200);
  const reset = await state(() => window.__cutaway.useApp.getState().project.edit.appearance.crop);
  check('Reset then Apply returns to the whole frame', reset.w === 1 && reset.h === 1 && reset.x === 0 && reset.y === 0, JSON.stringify(reset));
  await page.click('[data-testid="crop-open"]');
  await page.waitForSelector('[data-testid="crop-sheet"]');
  await drag('.crop-handle.nw', 80, 60);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const cancelled = await state(() => window.__cutaway.useApp.getState().project.edit.appearance.crop);
  check('Esc closes the sheet without changing anything', cancelled.w === 1 && !(await page.locator('[data-testid="crop-sheet"]').count()));

  // ───────────────────────── E. sensitive data → suggested masks ─────────────────────────
  // A "screen recording" drawn here: four states of a made-up settings page, two seconds each.
  const SECRETS = { email: 'sam.rivera@example-mail.test', key: 'sk-FAKEfake0000FAKEfake1111FAKE', card: '4242 4242 4242 4242', password: 'Tr0ub4dor-fake-9', phone: '+1 (555) 010-0199' };
  const pngs = await page.evaluate((S) => {
    const base = [[80, 'Account settings', 44], [220, `Contact: ${S.email}`, 30], [420, `Card ${S.card}  exp 12/30`, 30], [620, `Support ${S.phone}`, 30], [720, 'Build 14.2.1 finished at 2026-11-13 10:42', 30], [820, 'Commit 3f2a9c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291 deployed', 30]];
    const key = [320, `OPENAI_API_KEY=${S.key}`, 30];
    const pw = [520, `password: ${S.password}`, 30];
    return [base, [...base, key], [...base, key, pw], [...base, pw]].map((lines) => {
      const c = document.createElement('canvas');
      c.width = 1920;
      c.height = 1080;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#111';
      g.textBaseline = 'top';
      for (const [y, text, size] of lines) {
        g.font = `${size}px Helvetica, Arial, sans-serif`;
        g.fillText(text, 120, y);
      }
      return c.toDataURL('image/png').split(',')[1];
    });
  }, SECRETS);
  pngs.forEach((b64, i) => fs.writeFileSync(path.join(fxDir, `s${i}.png`), Buffer.from(b64, 'base64')));
  fs.writeFileSync(path.join(fxDir, 'list.txt'), `${pngs.map((_, i) => `file '${path.join(fxDir, `s${i}.png`)}'\nduration 2\n`).join('')}file '${path.join(fxDir, `s${pngs.length - 1}.png`)}'\n`);
  const fake = path.join(fxDir, 'screen-settings-demo.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(fxDir, 'list.txt'), '-vf', 'fps=30', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fake]);
  const imported = await state(async (file) => {
    const r = await window.__cutaway.actions.importIntoNewProject([file]);
    const s = window.__cutaway.useApp.getState();
    s.go('project');
    s.setView('edit');
    return r.accepted.map((a) => a.source.role);
  }, fake);
  check('the generated screen recording imports as the screen source', imported[0] === 'screen', imported.join(','));
  await page.waitForSelector('.editor .timeline', { timeout: 15000 });
  await page.click('.ed-tools button[aria-label^="Find sensitive data"]');
  await page.waitForSelector('[data-testid="sensitive-sheet"]', { timeout: 5000 });
  const before = await state(() => window.__cutaway.useApp.getState().project.edit.masks.length);
  await shot('11-sensitive-intro');
  await page.click('[data-testid="sens-scan"]');
  await page.waitForSelector('[data-testid="sens-count"], [data-testid="sens-empty"]', { timeout: 180000 });
  const found = await page.evaluate(() => [...document.querySelectorAll('[data-testid="sens-row"]')].map((r) => ({ category: r.dataset.category, status: r.dataset.status, text: r.querySelector('.grow').textContent })));
  const cats = found.map((f) => f.category).sort();
  check('the scan finds the email, key, card number, password and phone number, and nothing else', JSON.stringify(cats) === JSON.stringify(['api-key', 'card-number', 'email', 'password', 'phone']), cats.join(', '));
  check('nothing is masked by the scan itself', (await state(() => window.__cutaway.useApp.getState().project.edit.masks.length)) === before && found.every((f) => f.status === 'open'));
  const sheetText = await page.textContent('[data-testid="sensitive-sheet"]');
  check('the sheet shows categories and times, never the text it read', Object.values(SECRETS).every((s) => !sheetText.includes(s)) && !/Tr0ub|FAKEfake|4242/.test(sheetText));
  const findings = await state(() => window.__cutaway.core && [...document.querySelectorAll('[data-testid="sens-row"]')].map((r) => r.querySelector('.mono').textContent));
  const keyRow = found.findIndex((f) => f.category === 'api-key');
  const times = (s) => s.match(/(\d+):(\d+\.\d+)/g).map((m) => { const [a, b] = m.split(':'); return Number(a) * 60 + Number(b); });
  const [ks, ke] = times(findings[keyRow]);
  const [ps, pe] = times(findings[found.findIndex((f) => f.category === 'password')]);
  check('each finding covers the time the thing was on screen (key 2–6 s, password 4–8 s)', ks <= 2 && ks >= 0.9 && ke >= 6 && ke <= 7.1 && ps <= 4 && ps >= 2.9 && pe >= 7.9, `key ${ks}–${ke}s, password ${ps}–${pe}s`);
  await shot('12-sensitive-found');
  await page.locator('[data-testid="sens-row"][data-category="email"] [data-testid="sens-hide"]').click();
  await page.waitForTimeout(250);
  const m1 = await state(() => window.__cutaway.useApp.getState().project.edit.masks.map((m) => ({ style: m.style, target: m.target, rect: m.rect, start: m.start, end: m.end, origin: m.meta.origin })));
  // The email was drawn at x 120 + "Contact: " in a 1920-wide frame, baseline row at y 220.
  const er = m1[0]?.rect;
  check('Hide adds one blur mask over that text on the screen source', m1.length === before + 1 && m1[0].style === 'blur' && m1[0].target === 'screen' && m1[0].origin === 'creator' && er.y < 222 / 1080 && er.y + er.h > 250 / 1080 && er.x > 200 / 1920 && er.x < 280 / 1920 && er.x + er.w > 0.3 && er.x + er.w < 0.42, JSON.stringify(er));
  await state(() => window.__cutaway.useApp.getState().undo());
  await page.waitForTimeout(200);
  const afterUndo = await page.evaluate(() => document.querySelector('[data-testid="sens-row"][data-category="email"]').dataset.status);
  check('undo removes the mask and the finding is open again', (await state(() => window.__cutaway.useApp.getState().project.edit.masks.length)) === before && afterUndo === 'open');
  await page.locator('[data-testid="sens-row"][data-category="phone"] [data-testid="sens-dismiss"]').click();
  await page.click('[data-testid="sens-hide-all"]');
  await page.waitForTimeout(300);
  const m2 = await state(() => window.__cutaway.useApp.getState().project.edit.masks.length);
  const statuses = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="sens-row"]')].map((r) => [r.dataset.category, r.dataset.status])));
  const past = await state(() => window.__cutaway.useApp.getState().past.at(-1)?.label);
  check('"Hide all" masks what is still open in one undoable step and leaves the dismissed one', m2 === before + 4 && statuses.phone === 'dismissed' && ['email', 'api-key', 'card-number', 'password'].every((c) => statuses[c] === 'hidden') && /Hide 4 sensitive areas/.test(past ?? ''), `${m2} masks; ${JSON.stringify(statuses)}; undo label "${past}"`);
  await shot('13-sensitive-hidden');
  await page.click('[data-testid="sensitive-sheet"] .modal-foot .btn >> nth=0');
  await state(() => { const s = window.__cutaway.useApp.getState(); s.patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } })); window.__cutaway.usePlayback.getState().seek(5); });
  await page.waitForTimeout(900);
  await shot('14-masks-on-preview');
  await state(() => window.__cutaway.saveNow());
  const secondBundle = fs.readdirSync(libraryDir).filter((n) => n.endsWith('.cutaway')).map((n) => path.join(libraryDir, n)).find((p) => fs.readFileSync(path.join(p, 'project.json'), 'utf8').includes('screen-settings-demo'));
  const texts = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(json|jsonl|txt|log)$/.test(e.name)) texts.push(fs.readFileSync(p, 'utf8')); } };
  walk(secondBundle);
  walk(userData);
  const leaked = Object.values(SECRETS).filter((s) => texts.some((t) => t.includes(s) || t.includes(s.replace(/\s/g, ''))));
  check('none of the recognised text is written to the project or the app data', leaked.length === 0 && texts.length > 0, `${texts.length} text files checked`);

  // ───────────────────────── F. delete a take from quick share ─────────────────────────
  await state(() => window.__cutaway.actions.newRecording());
  await startSyntheticTake();
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.cutaway.record.stop());
  await page.waitForSelector('[data-testid="quick-share"]', { timeout: 30000 });
  const hadSources = await state(() => window.__cutaway.useApp.getState().project.sources.length);
  await page.click('[data-testid="qs-delete"]');
  await page.waitForSelector('[data-testid="qs-delete-confirm"]', { timeout: 3000 });
  check('Delete take asks before doing anything', (await state(() => window.__cutaway.useApp.getState().project.sources.length)) === hadSources && (await page.evaluate(() => window.__discarded.length)) === 0);
  await shot('15-quick-share-delete-confirm');
  await page.click('[data-testid="qs-delete-confirm"]');
  await page.waitForSelector('.record .rec-bar', { timeout: 15000 });
  const afterDelete = await state(() => ({ sources: window.__cutaway.useApp.getState().project?.sources.length, flags: window.__cutaway.useApp.getState().project?.flags?.length ?? 0, discarded: window.__discarded }));
  check('confirming removes the take from the project, discards its folder and returns to the recorder', afterDelete.sources === 0 && afterDelete.discarded.length === 1 && /\/media\/take-001$/.test(afterDelete.discarded[0]), JSON.stringify({ sources: afterDelete.sources, discarded: afterDelete.discarded.map((p) => p.replace(dir, '…')) }));
} catch (e) {
  failed += 1;
  console.log('E2E FAILED:', e.stack ?? e.message);
  await shot('99-failure').catch(() => {});
} finally {
  await app.close().catch(() => {});
  for (const d of [dir, saveDir, fxDir]) fs.rmSync(d, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exitCode = failed ? 1 : 0;
}
