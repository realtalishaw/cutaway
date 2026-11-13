// The Screen Recording permission flow, without touching macOS privacy settings:
//   node e2e/permissions.mjs [outDir]
// CUTAWAY_E2E_SCREEN=off pins the state to "not allowed", so the recorder must
// (1) offer Allow…, (2) after a refused request explain where the switch is and
// open System Settings (recorded, not opened, in test runs), and (3) never start
// in camera-only mode without saying why.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-permissions'));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

process.env.CUTAWAY_E2E_SCREEN = 'off';
const { app, page, userData } = await launch();
try {
  await page.evaluate(() => window.__cutaway.actions.newRecording());
  await page.waitForSelector('[data-testid="perm-screen"]', { timeout: 15000 });
  check('recorder says the screen cannot be recorded yet', await page.getByText('The screen cannot be recorded yet').isVisible());
  check('first visit offers Allow…', await page.locator('[data-testid="perm-allow-screen"]').isVisible());
  await page.screenshot({ path: path.join(out, '1-allow.png') });

  await page.locator('[data-testid="perm-allow-screen"]').click();
  await page.waitForSelector('[data-testid="perm-screen"].denied', { timeout: 10000 });
  const text = await page.locator('[data-testid="perm-screen"]').innerText();
  check('after a refused request the card names the settings pane', /Screen & System Audio Recording/.test(text), text.slice(0, 90));
  check('it explains the + button and the off/on fix', /Press \+/.test(text) && /off and on again/.test(text));
  check('Open settings and Relaunch are offered', (await page.getByRole('button', { name: 'Open settings' }).isVisible()) && (await page.getByRole('button', { name: 'Relaunch Cutaway' }).isVisible()));
  const opened = await app.evaluate(() => globalThis.__openedPrivacy ?? []);
  check('System Settings was opened on the Screen Recording pane', opened.includes('screen'), JSON.stringify(opened));
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  check('the request is remembered across launches', saved.screenAccessAsked === true);
  await page.screenshot({ path: path.join(out, '2-off.png') });

  check('camera-only and import stay available', (await page.getByRole('button', { name: 'Record camera only' }).isVisible()) && (await page.getByRole('button', { name: 'Import footage instead' }).isVisible()));
  const real = await page.evaluate(() => window.cutaway.app.permission('camera'));
  check('camera state still comes from macOS', ['granted', 'denied', 'undetermined'].includes(real), real);
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll permission checks passed');
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
