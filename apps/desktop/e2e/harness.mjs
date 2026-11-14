// Launches the built app against a throwaway profile + library so tests never touch real projects.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `args`: extra command-line switches for the app (for example Chromium's fake microphone). */
export async function launch({ profile, settings = {}, args = [] } = {}) {
  const dir = profile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-e2e-'));
  const userData = path.join(dir, 'userData');
  const libraryDir = path.join(dir, 'Library');
  const exportDir = path.join(dir, 'Exports');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(libraryDir, { recursive: true });
  const settingsFile = path.join(userData, 'settings.json');
  const prev = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ ...prev, libraryDir, exportDir, ...settings }));
  const env = { ...process.env, CUTAWAY_USER_DATA: userData, CUTAWAY_E2E: '1', CUTAWAY_CLAUDE: process.env.CUTAWAY_CLAUDE ?? 'off', CUTAWAY_CODEX: process.env.CUTAWAY_CODEX ?? 'off' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root, ...args], cwd: root, env });
  app.process().stderr?.on('data', (d) => { const t = d.toString(); if (/gone|Error|error/.test(t)) process.stdout.write(`[main] ${t}`); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1480, height: 940 }).catch(() => {});
  page.on('console', (m) => (m.type() === 'error' ? console.log('[renderer error]', m.text()) : null));
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.waitForSelector('.app, .controller', { timeout: 20000 });
  await page.waitForFunction(() => !!window.__cutaway, null, { timeout: 10000 }).catch(() => {});
  return { app, page, dir, userData, libraryDir, exportDir };
}
