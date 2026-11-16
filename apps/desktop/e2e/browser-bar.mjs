// Hide browser bar on a Chrome-style recording (tab strip, then a toolbar with an address field): the crop must start
// below the whole toolbar, not just below the tabs. Uses the docs' made-up browser footage when it is around.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { launch } from './harness.mjs';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
// A 1920×1080 "screen recording": a Chrome-style top (tab strip, toolbar with an address field, hairline) over a page
// that scrolls. Drawn with ffmpeg so the test needs nothing else.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-bb-'));
const file = path.join(dir, 'Browser screen recording.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=6', '-vf',
  'drawbox=x=0:y=0:w=1920:h=46:color=0xdee1e6:t=fill,drawbox=x=0:y=46:w=1920:h=74:color=white:t=fill,drawbox=x=150:y=62:w=1600:h=42:color=0xf1f3f4:t=fill,drawbox=x=0:y=119:w=1920:h=1:color=0xdadce0:t=fill',
  '-pix_fmt', 'yuv420p', file]);

const { app, page } = await launch();
try {
  await page.evaluate((f) => window.__cutaway.actions.importIntoNewProject([f]), file);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  await page.evaluate(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="crop-open"]').first().click();
  await page.locator('[data-testid="crop-browser-bar"]').click();
  await page.waitForFunction(() => { const n = document.querySelector('[data-testid="crop-browser-note"]'); return !!n && !/Looking/.test(n.textContent ?? ''); }, null, { timeout: 60000 });
  const note = await page.locator('[data-testid="crop-browser-note"]').innerText();
  const y = Number(await page.locator('[data-testid="crop-y"]').inputValue());
  check('Hide browser bar finds the bar', /Found/.test(note), note);
  check('the crop starts below the whole toolbar (120 px), not below the tabs (46 px)', y >= 116 && y <= 128, `top ${y} px`);
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
