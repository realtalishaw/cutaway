// The picture at the top of the home page: the editor, an AI thumbnail and a Short, cut from the docs screenshots.
// Run after shots.mjs. Usage: node docs-site/_tools/hero.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { here } from './callouts.mjs';

const img = (n) => 'data:image/png;base64,' + fs.readFileSync(path.join(here, '..', 'images', 'screens', `${n}.png`)).toString('base64');
const W = 1600, H = 900;
// [x, y, w, h] of each piece inside its 1480x940 screenshot
const THUMB = [345, 114, 797, 448];
const SHORT = [517, 97, 432, 766];
const crop = (src, [x, y, w, h], scale, style) => `<div style="position:absolute;overflow:hidden;width:${w * scale}px;height:${h * scale}px;${style}"><img src="${src}" style="position:absolute;left:${-x * scale}px;top:${-y * scale}px;width:${1480 * scale}px"></div>`;
const html = `<body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:-apple-system,Helvetica,sans-serif">
<div style="position:absolute;inset:0;background:radial-gradient(1200px 700px at 20% 10%, #7b5cff 0%, transparent 60%),radial-gradient(900px 700px at 90% 90%, #ff7ab6 0%, transparent 55%),linear-gradient(135deg,#2a1a8f,#4D2EF5 55%,#9b3fd1)"></div>
<div style="position:absolute;left:70px;top:70px;width:1160px;height:737px;border-radius:18px;overflow:hidden;box-shadow:0 40px 90px rgba(10,5,40,.55),0 0 0 1px rgba(255,255,255,.12)"><img src="${img('editor')}" style="width:1160px"></div>
${crop(img('package-chosen'), THUMB, 0.58, 'left:840px;top:585px;border-radius:14px;box-shadow:0 30px 70px rgba(10,5,40,.6),0 0 0 4px #fff')}
${crop(img('shorts-found'), SHORT, 0.6, 'left:1288px;top:96px;border-radius:30px;box-shadow:0 30px 70px rgba(10,5,40,.6),0 0 0 8px #14151c')}
</body>`;
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(200);
const out = path.join(here, '..', 'images', 'hero.jpg');
await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
await browser.close();
console.log('hero', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
