// Smoke test of the packaged Cutaway.app: boots, finds its bundled helper, probes and analyses media.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './harness.mjs';

const exe = path.join(root, 'release/mac-arm64/Cutaway.app/Contents/MacOS/Cutaway');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-pkg-'));
fs.mkdirSync(path.join(dir, 'userData'), { recursive: true });
fs.writeFileSync(path.join(dir, 'userData/settings.json'), JSON.stringify({ libraryDir: path.join(dir, 'Library'), exportDir: path.join(dir, 'Exports') }));
const env = { ...process.env, CUTAWAY_USER_DATA: path.join(dir, 'userData'), CUTAWAY_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: exe, env });
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 20000 });
await page.waitForFunction(() => !!window.__cutaway, null, { timeout: 10000 });
const fx = path.resolve(root, '../../fixtures/generated/screen.mp4');
const r = await page.evaluate(async (file) => {
  const info = await window.cutaway.app.info();
  const probe = await window.cutaway.native.probe([file]);
  const voice = await window.cutaway.native.analyzeVoice(file);
  const rep = await window.__cutaway.actions.importIntoNewProject([file]);
  return { info, probe: probe[0] && { ok: probe[0].ok, duration: probe[0].duration, codec: probe[0].video?.codec }, voice: { silences: voice.silences.length, levelDb: voice.levelDb }, imported: rep?.accepted.length };
}, fx);
console.log(JSON.stringify(r));
await page.waitForTimeout(800);
await page.screenshot({ path: process.argv[2] ?? '/tmp/cutaway-packaged.png' });
await app.close();
process.exit(r.info.nativeHelper && r.probe?.ok && r.imported === 1 ? 0 : 1);
