// Draws numbered callouts (a yellow ring around each button, with a numbered badge) on copies of the screenshots.
// The boxes come from _tools/marks.json, written by shots.mjs while it drives the app (see callouts.mjs).
// Each entry: { src: 'editor' (images/screens/<src>.png), marks: [...], crop?: [x, y, w, h], dim?: true }.
// Usage: node docs-site/_tools/annotate.mjs [only-regex]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { here, loadMarks, markSvg, shrinkPng } from './callouts.mjs';

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const root = path.join(here, '..');
const outDir = path.join(root, 'images', 'annotated');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
let made = 0;
for (const [name, j] of Object.entries(loadMarks())) {
  if (only && !only.test(name)) continue;
  const src = path.join(root, 'images', 'screens', `${j.src}.png`);
  if (!fs.existsSync(src)) {
    console.log('missing screenshot', j.src, 'for', name);
    continue;
  }
  const img = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
  const { width: W, height: H } = await page.evaluate((s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok({ width: i.naturalWidth, height: i.naturalHeight }); i.src = s; }), img);
  const [cx, cy, cw, ch] = j.crop ?? [0, 0, W, H];
  const svg = markSvg(j.marks, cw, ch, { dx: cx, dy: cy, dim: !!j.dim });
  await page.setViewportSize({ width: cw, height: ch });
  await page.setContent(`<body style="margin:0;overflow:hidden"><div style="position:relative;width:${cw}px;height:${ch}px;overflow:hidden"><img src="${img}" style="position:absolute;left:${-cx}px;top:${-cy}px"><div style="position:absolute;inset:0">${svg}</div></div></body>`);
  await page.waitForTimeout(50);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shrinkPng(file);
  made++;
  console.log('annotated', name);
}
await browser.close();
console.log('done', made);
