// Teleprompter: opened from the Record screen, a script typed in, shown as a prompter, scrolled at a
// words-per-minute pace, sped up, moved to its quick places, left out of capture (content protection on the
// window, and the app is excluded from every display capture), following a take's start / pause / resume /
// stop, remembered where it was put, and shown/hidden from the recording controls' toggle.
//   node e2e/teleprompter.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-teleprompter'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const SCRIPT = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. Today I will show you how to record a clean screen video, cut the pauses out, and export it for YouTube without fuss.`).join('\n\n');

const { app, page } = await launch();
/** The teleprompter window's bounds, visibility and capture protection, from the main process. */
const win = () => app.evaluate(({ BrowserWindow, screen }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().endsWith('#notes'));
  if (!w) return null;
  return { bounds: w.getBounds(), visible: w.isVisible(), onTop: w.isAlwaysOnTop(), protected: typeof w.isContentProtected === 'function' ? w.isContentProtected() : 'n/a', area: screen.getDisplayMatching(w.getBounds()).workArea };
});
const send = (e) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send('record:event', e)), e);
try {
  await page.click('button:has-text("New recording")');
  await page.waitForSelector('.record .rec-bar', { timeout: 15000 });
  await page.waitForSelector('[data-testid="record-prompter"]', { timeout: 30000 });
  check('the Record screen has a Teleprompter button next to Start recording', /Teleprompter/.test(await page.locator('[data-testid="record-prompter"]').innerText()));
  const opened = app.waitForEvent('window', { timeout: 15000 });
  await page.click('[data-testid="record-prompter"]');
  const tp = await opened;
  await tp.waitForSelector('[data-testid="prompter"]');
  await page.waitForFunction(() => /Hide teleprompter/.test(document.querySelector('[data-testid="record-prompter"]')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  check('it opens its own window, and the button says Hide teleprompter', /Hide teleprompter/.test(await page.locator('[data-testid="record-prompter"]').innerText()));
  let w = await win();
  check('the window floats on top and is protected from screen capture', !!w && w.visible && w.onTop && w.protected === true, JSON.stringify(w));
  check('it starts under the camera: top centre of the screen', !!w && Math.abs(w.bounds.x + w.bounds.width / 2 - (w.area.x + w.area.width / 2)) < 4 && w.bounds.y - w.area.y < 20, JSON.stringify(w?.bounds));
  check('with no script yet it opens on the script editor, and says it is not recorded', (await tp.locator('[data-testid="prompter-script"]').count()) === 1 && /Not recorded/.test(await tp.locator('.notes-badge').innerText()));

  await tp.fill('[data-testid="prompter-script"]', SCRIPT);
  const counts = await tp.locator('.tp-bar.edit').innerText();
  check('while editing it counts the words and how long they take to read', /150 words · about 1:04 at 140 words\/min/.test(counts), counts);
  await tp.click('[data-testid="prompter-edit"]');
  await tp.waitForSelector('[data-testid="prompter-stage"]');
  await tp.waitForTimeout(300);
  const ty = () => tp.evaluate(() => { const m = /translateY\((-?[\d.]+)px\)/.exec(document.querySelector('[data-testid="prompter-text"]').style.transform); return m ? -Number(m[1]) : 0; });
  const left = () => tp.locator('[data-testid="prompter-left"]').innerText();
  const left0 = await left();
  check('done: the script shows as a prompter, starting at the reading line, with the time left', (await ty()) === 0 && /0:5\d left|1:0\d left/.test(left0), left0);
  await tp.screenshot({ path: path.join(out, '1-prompter.png') });

  await tp.click('[data-testid="prompter-play"]');
  await tp.waitForTimeout(2000);
  const moved = await ty();
  check('play scrolls it steadily', moved > 10, `${moved.toFixed(1)} px in 2 s`);
  await tp.click('[data-testid="prompter-play"]');
  const a = await ty();
  await tp.waitForTimeout(600);
  check('pause stops it', Math.abs((await ty()) - a) < 0.5);
  await tp.click('[data-testid="prompter-faster"]');
  await tp.click('[data-testid="prompter-faster"]');
  check('faster raises the pace in words per minute', (await tp.locator('[data-testid="prompter-wpm"]').innerText()) === '160 wpm');
  await tp.click('[data-testid="prompter-play"]');
  await tp.waitForTimeout(2000);
  await tp.click('[data-testid="prompter-play"]');
  const fast = (await ty()) - a;
  check('and it then scrolls faster (160 vs 140 words/min)', fast > moved * 1.05, `${moved.toFixed(1)} → ${fast.toFixed(1)} px in 2 s`);
  await tp.keyboard.press('Home');
  check('Home goes back to the start', (await ty()) === 0);

  // quick places
  await tp.click('[data-testid="prompter-place"]');
  await tp.click('[data-testid="prompter-place-right"]');
  await tp.waitForTimeout(500);
  w = await win();
  check('“Right side” makes it a tall column at the right edge', w.bounds.x + w.bounds.width > w.area.x + w.area.width - 40 && w.bounds.height > w.area.height * 0.5, JSON.stringify(w.bounds));
  await tp.screenshot({ path: path.join(out, '2-right.png') });
  await tp.click('[data-testid="prompter-place"]');
  await tp.click('[data-testid="prompter-place-camera"]');
  await tp.waitForTimeout(300);
  check('“Over my camera bubble” says so when the bubble is not showing', /camera bubble is not showing/.test(await tp.locator('.tp-note').innerText().catch(() => '')));

  // following the take
  await send({ type: 'started', at: new Date().toISOString(), sources: [] });
  await tp.waitForTimeout(1200);
  const p1 = await ty();
  check('when the recording starts, it starts scrolling by itself and shows the recording dot', p1 > 3 && (await tp.locator('.tp-rec.on').count()) === 1, `${p1.toFixed(1)} px`);
  await send({ type: 'paused', elapsed: 2 });
  await tp.waitForTimeout(200);
  const p2 = await ty();
  await tp.waitForTimeout(800);
  check('pausing the recording pauses it', Math.abs((await ty()) - p2) < 0.5 && (await tp.locator('.tp-rec.paused').count()) === 1);
  await send({ type: 'resumed', elapsed: 2 });
  await tp.waitForTimeout(900);
  check('resuming carries on', (await ty()) > p2 + 3);
  await send({ type: 'stopped', manifest: {} });
  await tp.waitForTimeout(200);
  const p3 = await ty();
  await tp.waitForTimeout(700);
  check('stopping the recording stops it', Math.abs((await ty()) - p3) < 0.5 && (await tp.locator('.tp-rec').count()) === 0);
  await tp.click('[data-testid="prompter-settings"]');
  await tp.click('[data-testid="prompter-follow"]');
  const p4 = await ty();
  await send({ type: 'started', at: new Date().toISOString(), sources: [] });
  await tp.waitForTimeout(800);
  check('with “Start, pause and stop with the recording” off, a take leaves it alone', Math.abs((await ty()) - p4) < 0.5);
  await send({ type: 'stopped', manifest: {} });

  // remembered where it was put
  const placed = (await win()).bounds;
  await page.evaluate(() => window.cutaway.app.notesWindow(false));
  await page.waitForTimeout(800);
  check('closing it updates the Record screen button', /^\s*Teleprompter/.test(await page.locator('[data-testid="record-prompter"]').innerText()) && (await win()) === null);
  const again = app.waitForEvent('window', { timeout: 15000 });
  await page.evaluate(() => window.cutaway.app.notesWindow('toggle'));
  const tp2 = await again;
  await tp2.waitForSelector('[data-testid="prompter-stage"]');
  const back = (await win()).bounds;
  check('it opens again where it was left, already showing the script', JSON.stringify(back) === JSON.stringify(placed), `${JSON.stringify(placed)} → ${JSON.stringify(back)}`);
  await page.evaluate(() => window.cutaway.app.notesWindow('toggle'));
  await page.waitForTimeout(600);
  check('the toggle the recording controls use hides it again', (await win()) === null);
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all teleprompter checks passed');
process.exit(failed ? 1 : 0);
