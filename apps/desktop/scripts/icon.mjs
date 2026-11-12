// Renders build/icon.svg to build/icon.icns using the app's own Chromium (keeps transparency).
import { launch, root } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
const { app, page } = await launch();
const set = path.join(root, 'build/icon.iconset');
fs.rmSync(set, { recursive: true, force: true });
fs.mkdirSync(set, { recursive: true });
for (const [size, name] of [[16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'], [128, '128x128'], [256, '128x128@2x'], [256, '256x256'], [512, '256x256@2x'], [512, '512x512'], [1024, '512x512@2x']]) {
  const b64 = await page.evaluate(async ({ svg, size }) => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png').split(',')[1];
  }, { svg, size });
  fs.writeFileSync(path.join(set, `icon_${name}.png`), Buffer.from(b64, 'base64'));
}
await app.close();
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'build/icon.icns')]);
fs.rmSync(set, { recursive: true, force: true });
console.log('wrote build/icon.icns');
