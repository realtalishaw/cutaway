// End-to-end check of the capture-side UI against the real native helper.
//   node e2e/capture-ui.mjs [outDir] [--record]
// Generates fixtures (a "screen" MP4, a "camera" MOV that starts 1.5 s late with the
// same narration, and a corrupt file), drives Record → Sources → sync review, and
// writes screenshots. With --record it also makes a short real screen + microphone
// recording through the UI (needs Screen Recording and Microphone access).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, root } from './harness.mjs';

const args = process.argv.slice(2);
const doRecord = args.includes('--record');
const out = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(os.tmpdir(), 'cutaway-capture-ui'));
fs.mkdirSync(out, { recursive: true });
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const CAMERA_STARTS_LATE = 1.5;

function fixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-fixtures-'));
  const narration = path.join(dir, 'narration.aiff');
  const text = 'Welcome back. Today I will show how to set up the project. First, open the settings panel. Then choose the export folder, and press save. Do not close the window until the progress bar finishes. That is the whole setup.';
  execFileSync('say', ['-o', narration, text]);
  const ff = (a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
  const screen = path.join(dir, 'screen-demo.mp4');
  const camera = path.join(dir, 'camera-desk.mov');
  // "Screen": moving test pattern, narration from 0 s.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', narration, '-filter_complex', '[1:a]apad,aresample=48000[a]', '-map', '0:v', '-map', '[a]', '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', screen]);
  // "Camera": started 1.5 s after the screen, heard the same narration through a noisier mic.
  ff(['-f', 'lavfi', '-i', 'smptebars=size=1280x720:rate=30', '-i', narration, '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.01:sample_rate=48000', '-filter_complex', `[1:a]apad,aresample=48000,atrim=start=${CAMERA_STARTS_LATE},asetpts=PTS-STARTPTS,volume=0.6[n];[n][2:a]amix=inputs=2:duration=first:normalize=0[a]`, '-map', '0:v', '-map', '[a]', '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', camera]);
  const corrupt = path.join(dir, 'broken-export.mp4');
  fs.writeFileSync(corrupt, Buffer.from(Array.from({ length: 40000 }, (_, i) => (i * 7919) % 251)));
  return { dir, screen, camera, corrupt };
}

const shot = async (page, name) => {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('shot', file);
};

const fx = fixtures();
const { app, page, dir, libraryDir } = await launch({ settings: { countdownSeconds: 1 } });
const results = {};
try {
  // 1 ── recorder setup
  await page.click('.action.record');
  await page.waitForSelector('.record', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.stage .spinner'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  results.record = await page.evaluate(() => ({
    startLabel: document.querySelector('.record-bar .btn.primary')?.textContent?.trim(),
    displays: document.querySelectorAll('.picker .pick').length,
    cameras: document.querySelectorAll('select[aria-label="Camera A"] option').length - 1,
    microphones: document.querySelectorAll('select[aria-label="Microphone"] option').length - 1,
    summary: document.querySelector('.record-bar .tiny')?.textContent?.trim(),
  }));
  await shot(page, '01-record-setup');
  // duplicate-device guard: the device chosen for A is disabled in B
  results.duplicateGuard = await page.evaluate(() => {
    const a = document.querySelector('select[aria-label="Camera A"]');
    const b = document.querySelector('select[aria-label="Camera B"]');
    const first = a?.options[1]?.value;
    if (!first) return 'no camera connected';
    return { cameraA: a.value || '(off)', optionDisabledInB: a.value ? [...b.options].find((o) => o.value === a.value)?.disabled : 'A is off' };
  });
  await page.click('button[aria-pressed="false"]:has-text("Area")');
  await page.waitForTimeout(400);
  await shot(page, '02-record-area');
  await page.click('button:has-text("Camera only")');
  await page.waitForTimeout(400);
  await shot(page, '03-record-camera-only');
  await page.click('button:has-text("Display")');

  if (doRecord) {
    // 1b ── a real, short screen + microphone take through the UI
    const perms = await page.evaluate(async () => ({ screen: await window.cutaway.app.permission('screen'), microphone: await window.cutaway.app.permission('microphone'), camera: await window.cutaway.app.permission('camera') }));
    results.permissions = perms;
    if (perms.screen !== 'granted') {
      results.recording = `skipped: screen permission is ${perms.screen}`;
    } else {
      await page.click('.record-bar .btn.primary');
      await page.waitForSelector('.countdown', { timeout: 15000 });
      await shot(page, '04-countdown');
      await page.waitForSelector('.rec-live', { timeout: 30000 });
      await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .eyebrow')?.textContent ?? ''), null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      const controller = app.windows().find((w) => w.url().includes('#controller'));
      if (controller) {
        await controller.waitForSelector('.controller-pill', { timeout: 5000 }).catch(() => {});
        await controller.screenshot({ path: path.join(out, '05-controller.png'), omitBackground: true }).then(() => console.log('shot', path.join(out, '05-controller.png'))).catch((e) => console.log('controller shot failed', e.message));
        results.controller = await controller.evaluate(() => ({ time: document.querySelector('.controller-pill .time')?.textContent, chips: [...document.querySelectorAll('.controller-pill .chip')].map((c) => c.getAttribute('title')) })).catch(() => null);
        await controller.click('button[aria-label="Pause recording"]').catch(() => {});
        await page.waitForTimeout(1200);
        await controller.click('button[aria-label="Resume recording"]').catch(() => {});
        await page.waitForTimeout(1500);
      } else results.controller = 'controller window not found';
      await shot(page, '06-recording-main');
      await page.evaluate(() => window.cutaway.record.stop());
      await page.waitForSelector('.source-row', { timeout: 30000 });
      await page.waitForTimeout(800);
      await shot(page, '07-sources-after-recording');
      results.recording = await page.evaluate(() => [...document.querySelectorAll('.source-row')].map((r) => ({ name: r.querySelector('.source-name')?.textContent, meta: [...r.querySelectorAll('.mono span')].map((s) => s.textContent).join(' | '), sync: r.querySelector('.cov + .row .pill')?.textContent?.trim() })));
    }
  } else {
    await page.click('button:has-text("Import instead")');
    await page.waitForSelector('.sources', { timeout: 10000 });
    await shot(page, '04-sources-empty');
  }

  // 2 ── import inspection
  await page.setInputFiles('[data-testid="import-input"]', [fx.screen, fx.camera, fx.corrupt]);
  await page.waitForSelector('.reject', { timeout: 60000 });
  await page.waitForTimeout(600);
  results.inspection = await page.evaluate(() => ({
    summary: document.querySelector('.inspection b')?.textContent?.trim(),
    rejected: [...document.querySelectorAll('.reject')].map((r) => r.textContent?.trim()),
    rows: [...document.querySelectorAll('.source-row')].map((r) => ({ name: r.querySelector('.source-name')?.textContent, role: r.querySelector('select.role-select')?.value, sync: r.querySelector('.cov + .row .pill')?.textContent?.trim() ?? null })),
    footer: document.querySelector('.sources-bar .grow')?.textContent?.trim(),
  }));
  await shot(page, '08-sources-inspection');

  if (!doRecord) {
    // 3 ── audio sync of the late-starting camera
    await page.click('.sources-bar .btn.primary');
    await page.waitForSelector('.modal .sync-players', { timeout: 10000 });
    await page.waitForTimeout(800);
    await shot(page, '09-sync-before');
    await page.click('button:has-text("Find sync from audio")');
    await page.waitForFunction(() => /Found a match|No shared audio|no audio track/i.test(document.querySelector('.sync-tools')?.textContent ?? ''), null, { timeout: 120000 });
    await page.waitForTimeout(400);
    results.sync = await page.evaluate(() => ({
      stats: [...document.querySelectorAll('.sync-stats > div')].map((d) => d.textContent?.trim()),
      checkpoints: [...document.querySelectorAll('.modal .pill')].map((p) => p.textContent?.trim()),
      message: document.querySelector('.sync-tool .tiny')?.textContent?.trim(),
    }));
    await shot(page, '10-sync-found');
    await page.click('.modal-foot .btn.primary');
    await page.waitForTimeout(700);
    await shot(page, '11-sources-synced');
    // what was actually saved
    await page.waitForTimeout(1800);
    const bundle = fs.readdirSync(libraryDir).find((n) => n.endsWith('.cutaway'));
    const saved = JSON.parse(fs.readFileSync(path.join(libraryDir, bundle, 'project.json'), 'utf8'));
    results.saved = saved.sources.map((s) => ({ role: s.role, offset: +s.sync.offset.toFixed(4), rate: +s.sync.rate.toFixed(6), method: s.sync.method, status: s.sync.status, confirmed: s.sync.confirmedByCreator, managed: s.managed, path: s.path }));
    results.duration = saved.duration;
    results.expectedCameraOffset = CAMERA_STARTS_LATE;
    results.originalsUntouched = fs.existsSync(fx.screen) && fs.existsSync(fx.camera);

    // 4 ── a file with no shared audio must not be called synchronized
    const lonely = path.join(fx.dir, 'voice-other-room.wav');
    execFileSync('say', ['-o', path.join(fx.dir, 'other.aiff'), 'A completely different recording about gardening, tomatoes, compost and watering schedules for the summer months.']);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(fx.dir, 'other.aiff'), '-t', '9', '-ar', '48000', lonely]);
    await page.setInputFiles('[data-testid="import-input"]', [lonely]);
    await page.waitForFunction(() => document.querySelectorAll('.source-row').length >= 3, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const role = await page.evaluate(() => [...document.querySelectorAll('.source-row')].at(-1)?.querySelector('select.role-select')?.value);
    results.unrelated = { suggestedRole: role };
    if (role !== 'voice') await page.locator('.source-row').last().locator('select.role-select').selectOption('voice');
    await page.waitForTimeout(400);
    const review = page.locator('.source-row button:has-text("Review sync")').first();
    if (await review.count()) {
      await review.click();
      await page.waitForSelector('.modal .sync-players');
      await page.click('button:has-text("Find sync from audio")');
      await page.waitForFunction(() => /Found a match|No shared audio|no audio track/i.test(document.querySelector('.sync-tools')?.textContent ?? ''), null, { timeout: 120000 });
      results.unrelated.message = await page.evaluate(() => document.querySelector('.sync-tool .tiny')?.textContent?.trim());
      results.unrelated.method = await page.evaluate(() => document.querySelector('.sync-stats > div b')?.textContent);
      results.unrelated.confirmDisabled = await page.evaluate(() => document.querySelector('.modal-foot .btn.primary')?.disabled);
      await shot(page, '12-sync-no-shared-audio');
      await page.keyboard.press('Escape');
    } else results.unrelated.note = 'no Review sync button was offered';
  }

  // 5 ── controller window on its own (layout check only; no recorder events arrive)
  const opened = app.waitForEvent('window', { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }, preload) => {
    const main = BrowserWindow.getAllWindows()[0];
    const w = new BrowserWindow({ width: 420, height: 76, frame: false, transparent: true, hasShadow: false, show: true, webPreferences: { preload, contextIsolation: true, sandbox: true } });
    const url = new URL(main.webContents.getURL());
    url.hash = 'controller';
    void w.loadURL(url.toString());
  }, path.join(root, 'dist/preload/index.cjs'));
  const pill = await opened;
  await pill.waitForSelector('.controller-pill', { timeout: 15000 });
  await pill.waitForTimeout(400);
  await pill.screenshot({ path: path.join(out, '13-controller-idle.png'), omitBackground: true });
  console.log('shot', path.join(out, '13-controller-idle.png'));
} catch (e) {
  console.log('E2E FAILED:', e.message);
  await shot(page, '99-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(results, null, 2));
  await app.close().catch(() => {});
  fs.rmSync(fx.dir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
