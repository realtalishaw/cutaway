// Draws numbered boxes over a screenshot. Usage: node _tools/annotate.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const jobs = [
  { src: 'images/screens/editor.png', out: 'images/annotated/editor-tour.png', marks: [
    [1, [0, 2, 1478, 56], [52, 29]],
    [2, [76, 129, 948, 535], [104, 158]],
    [3, [12, 129, 54, 422], [39, 578]],
    [4, [392, 676, 262, 36], [370, 694]],
    [5, [6, 726, 1466, 196], [1444, 772]],
    [6, [1058, 74, 414, 650], [1058, 74]],
  ] },
];
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
for (const j of jobs) {
  const img = 'data:image/png;base64,' + fs.readFileSync(path.join(here, '..', j.src)).toString('base64');
  const marks = j.marks.map(([n, [x, y, w, h], [bx, by]]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="none" stroke="#ffcf3f" stroke-width="3"/><circle cx="${bx}" cy="${by}" r="17" fill="#ffcf3f" stroke="#14151c" stroke-width="3"/><text x="${bx}" y="${by + 7}" text-anchor="middle" font: font-family="-apple-system, Helvetica, Arial" font-size="20" font-weight="800" fill="#14151c">${n}</text>`).join('');
  await page.setContent(`<body style="margin:0"><div style="position:relative;width:1480px;height:940px"><img src="${img}" style="position:absolute;inset:0"><svg width="1480" height="940" style="position:absolute;inset:0">${marks}</svg></div></body>`);
  await page.screenshot({ path: path.join(here, '..', j.out) });
}
await browser.close();
