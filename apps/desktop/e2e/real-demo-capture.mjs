// Real hardware: record a demo of Cutaway itself ("Record Cutaway too") and check, from the recorded pixels,
// that Cutaway's main window is in the picture while its overlays are not. Needs Screen Recording access.
// Cutaway's window gets a cyan patch (must show), the teleprompter is painted magenta and the recording
// controls yellow (must not show). Mid-take the creator goes to the Library: the take keeps running and
// lands in its own project. The recording is deleted afterwards; only pixel counts are printed.
//   node e2e/real-demo-capture.mjs
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';
const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page } = await launch({ settings: { countdownSeconds: 0 } });
let takeFile = null; let projectDir = null;
const findWin = (hash) => app.evaluate(({ BrowserWindow, screen }, hash) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith(hash)); return w ? { visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds(), display: screen.getDisplayMatching(w.getBounds()).bounds } : null; }, hash);
/** Share of pixels of one colour inside a window's rectangle in a recorded frame (the recording is of that window's display). */
const inRect = (file, t, win, src, test) => {
  const sx = src.width / win.display.width, sy = src.height / win.display.height;
  const r = { x: Math.max(0, Math.round((win.bounds.x - win.display.x) * sx)), y: Math.max(0, Math.round((win.bounds.y - win.display.y) * sy)), w: Math.round(win.bounds.width * sx), h: Math.round(win.bounds.height * sy) };
  const b = execFileSync(FF, ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=200:-2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 });
  let m = 0; for (let i = 0; i < b.length; i += 3) if (test(b[i], b[i + 1], b[i + 2])) m++;
  return +(100 * m / (b.length / 3)).toFixed(2);
};
try {
  const devices = await page.evaluate(() => window.cutaway.native.devices());
  if (devices.permissions?.screen !== 'granted') { console.log('BLOCKED: Screen Recording is not allowed for this app'); process.exit(2); }
  await page.click('button:has-text("New recording")');
  await page.waitForSelector('[data-testid="start-recording"]', { timeout: 30000 });
  projectDir = await page.evaluate(() => window.__cutaway.useApp.getState().projectPath);
  // screen only: the main display, no camera or microphone
  await page.click('[data-testid="options"]');
  await page.click('button[role="switch"][aria-label="Record Cutaway too (for demos)"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="record-demo-note"]', { timeout: 5000 });
  check('“Record Cutaway too” says Cutaway will be in the recording', /Cutaway will be in this recording/.test(await page.locator('[data-testid="record-demo-note"]').innerText()));
  // the teleprompter, painted magenta
  const opened = app.waitForEvent('window', { timeout: 15000 });
  await page.evaluate(() => window.cutaway.app.notesWindow(true));
  const tp = await opened;
  await tp.waitForSelector('[data-testid="prompter"]');
  await page.evaluate(() => window.cutaway.app.prompterPlace('right'));
  await tp.addStyleTag({ content: '.notes-window,.notes-window *{background:#ff00ff !important;color:#ff00ff !important;backdrop-filter:none !important;-webkit-mask-image:none !important}' });
  // a cyan patch on Cutaway's own window
  const patch = '#demo-proof{position:fixed;left:40px;top:120px;width:360px;height:220px;background:#00ffff;z-index:99999}';
  const addPatch = () => page.evaluate((css) => { if (document.getElementById('demo-proof')) return; const s = document.createElement('style'); s.textContent = css; document.head.append(s); const d = document.createElement('div'); d.id = 'demo-proof'; document.body.append(d); }, patch);
  await addPatch();
  await sleep(400);
  const ctlOpened = app.waitForEvent('window', { timeout: 15000 });
  await page.click('[data-testid="start-recording"]');
  const ctl = await ctlOpened;
  await ctl.waitForSelector('.controller-pill', { timeout: 15000 });
  await ctl.addStyleTag({ content: '.controller-pill,.controller-pill *{background:#ffff00 !important;color:#ffff00 !important}' });
  await page.waitForFunction(() => document.querySelector('.rec-live'), null, { timeout: 15000 }).catch(() => {});
  const main = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => /#?$/.test(x.webContents.getURL()) && !/#(notes|controller|countdown|selfview)$/.test(x.webContents.getURL())); return { minimized: w.isMinimized(), visible: w.isVisible() }; });
  check('Cutaway’s window stays up when the take starts (not minimised)', main.visible && !main.minimized, JSON.stringify(main));
  // the app, not the recorder: Cutaway goes back to the Library by itself as soon as the take starts
  const backOnItsOwn = await page.waitForSelector('button:has-text("New recording")', { timeout: 10000 }).then(() => true, () => false);
  const route = await page.evaluate(() => window.__cutaway.useApp.getState().route);
  const toasts = await page.evaluate(() => window.__cutaway.useApp.getState().toasts.map((t) => t.text));
  check('when the take starts, Cutaway shows its projects instead of the recorder, ready to demo', backOnItsOwn && route === 'library', route);
  check('…with no toast on screen (it would be in the video)', !toasts.some((t) => /Recording Cutaway/.test(t)), JSON.stringify(toasts));
  await sleep(1800);
  // move around the app mid-take: open the Library again (still allowed while recording)
  await page.evaluate(() => window.__cutaway.actions.backToLibrary());
  await page.waitForSelector('button:has-text("New recording")', { timeout: 10000 });
  await addPatch();
  await sleep(2200);
  const stillOn = await page.evaluate(() => window.__cutaway.actions.isRecordingActive?.() ?? null);
  check('going to the Library mid-take keeps it recording, and keeps its project', stillOn !== false && fs.existsSync(projectDir), `recording ${stillOn} · project ${fs.existsSync(projectDir) ? 'kept' : 'GONE'}`);
  const tpVisible = await findWin('#notes');
  const ctlVisible = await findWin('#controller');
  const manifest = await page.evaluate(() => window.cutaway.record.stop());
  await page.waitForFunction((p) => window.__cutaway.useApp.getState().projectPath === p && window.__cutaway.useApp.getState().project?.sources.length > 0, projectDir, { timeout: 30000 }).catch(() => {});
  const after = await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); return { path: s.projectPath, route: s.route, sources: s.project?.sources.map((x) => x.role) }; });
  check('when it stops, the take goes into its own project (reopened from the Library)', after.path === projectDir && after.sources?.includes('screen'), JSON.stringify(after));
  const src = manifest.sources.find((s) => s.id === 'screen');
  takeFile = fs.existsSync(src.file) ? src.file : fs.readdirSync(projectDir, { recursive: true }).map((f) => path.join(projectDir, f)).find((f) => f.endsWith(path.basename(src.file)));
  console.log('recorded', JSON.stringify({ w: src.width, h: src.height, duration: manifest.duration, teleprompterOnScreen: tpVisible?.visible, controlsOnScreen: ctlVisible?.visible }));
  const W = 480, H = Math.round((480 * src.height) / src.width / 2) * 2;
  const counts = [];
  for (const t of [0.8, 2.5, 4.2]) {
    if (t > manifest.duration - 0.2) continue;
    const b = execFileSync(FF, ['-loglevel', 'error', '-ss', String(t), '-i', takeFile, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 });
    let cy = 0, mg = 0, ye = 0;
    for (let i = 0; i < b.length; i += 3) {
      const [r, g, bl] = [b[i], b[i + 1], b[i + 2]];
      if (r < 60 && g > 200 && bl > 200) cy++;
      else if (r > 200 && g < 60 && bl > 200) mg++;
      else if (r > 200 && g > 200 && bl < 60) ye++;
    }
    const n = b.length / 3;
    counts.push({ t, cyan: +(100 * cy / n).toFixed(2), magenta: +(100 * mg / n).toFixed(2), yellow: +(100 * ye / n).toFixed(2) });
  }
  console.log('pixels %', JSON.stringify(counts));
  check('Cutaway’s own window is in the recording (its cyan patch shows in every frame)', counts.length > 0 && counts.every((c) => c.cyan > 1), JSON.stringify(counts.map((c) => c.cyan)));
  check('the teleprompter is not (no magenta anywhere in the frame)', counts.every((c) => c.magenta === 0));
  const yellowIn = [0.8, 2.5].map((t) => inRect(takeFile, t, ctlVisible, src, (r, g, b) => r > 200 && g > 200 && b < 60));
  const magentaIn = [0.8, 2.5].map((t) => inRect(takeFile, t, tpVisible, src, (r, g, b) => r > 200 && g < 60 && b > 200));
  check('the recording controls are not (no yellow where they sat)', yellowIn.every((v) => v === 0), `yellow inside the controls’ rectangle: ${yellowIn.join(', ')}%`);
  check('…and where the teleprompter sat there is no magenta either', magentaIn.every((v) => v === 0), `${magentaIn.join(', ')}%`);
} finally {
  await app.close();
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  console.log('recording deleted');
}
console.log(failed ? `${failed} check(s) failed` : 'all demo-capture checks passed');
process.exit(failed ? 1 : 0);
