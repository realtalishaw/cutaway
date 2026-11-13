// End-to-end check of the capture-side UI against the real native helper.
//   node e2e/capture-ui.mjs [outDir] [--record]
// Generates fixtures (a "screen" MP4, a "camera" MOV that starts 1.5 s late with the
// same narration, and a corrupt file), drives Record → Sources → sync review, and
// writes screenshots. With --record it also makes a take through the UI: a real screen
// + microphone recording by default (needs Screen Recording and Microphone access), or,
// with --synthetic, the helper's generated test sources (two cameras, keys; no permissions).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, root } from './harness.mjs';

const args = process.argv.slice(2);
const doRecord = args.includes('--record');
const synthetic = args.includes('--synthetic');
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
  await page.click('button:has-text("New recording")');
  await page.waitForSelector('.record .rec-bar', { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.rec-stage .spinner'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const menu = async (id) => {
    await page.click(`[data-testid="${id}"]`);
    await page.waitForSelector('.rb-pop', { timeout: 5000 });
    await page.waitForTimeout(150);
  };
  const closeMenu = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };
  await menu('camera-a');
  const cameraRows = await page.evaluate(() => [...document.querySelectorAll('.rb-pop [role="menuitemradio"]')].map((b) => ({ text: b.textContent.trim(), checked: b.getAttribute('aria-checked') === 'true', disabled: b.disabled })));
  await closeMenu();
  await menu('microphone');
  const micRows = await page.evaluate(() => [...document.querySelectorAll('.rb-pop [role="menuitemradio"]')].map((b) => b.textContent.trim()));
  await shot(page, '01b-microphone-menu');
  await closeMenu();
  results.record = await page.evaluate(() => ({
    startLabel: document.querySelector('[data-testid="start-recording"]')?.textContent?.trim(),
    startDisabled: document.querySelector('[data-testid="start-recording"]')?.disabled,
    target: document.querySelector('.target-name')?.textContent,
    dims: document.querySelector('.target-dims')?.textContent,
    modes: [...document.querySelectorAll('.rb-mode')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`),
    displays: document.querySelectorAll('.picker .pick').length,
    pills: [...document.querySelectorAll('.rec-bar .rb-pill-label')].map((l) => l.textContent),
    summary: document.querySelector('.rec-status')?.textContent?.trim(),
  }));
  results.record.cameras = cameraRows.length - 1;
  results.record.microphones = micRows.length - 1;
  await shot(page, '01-record-setup');
  // duplicate-device guard: whatever is chosen for A is disabled in B's menu
  await menu('camera-b');
  results.duplicateGuard = await page.evaluate((a) => {
    const chosen = a.find((r) => r.checked && !/Don.t record/.test(r.text));
    if (a.length <= 1) return 'no camera connected';
    if (!chosen) return 'Camera A is off (camera permission not granted here), so nothing is reserved';
    const row = [...document.querySelectorAll('.rb-pop [role="menuitemradio"]')].find((b) => b.textContent.includes(chosen.text));
    return { cameraA: chosen.text, disabledInB: !!row?.disabled };
  }, cameraRows);
  await shot(page, '01c-camera-b-menu');
  await closeMenu();
  // system audio: all apps / selected apps
  await menu('system-audio');
  await page.click('.rb-pop [role="menuitemradio"]:has-text("selected apps")');
  await page.waitForTimeout(250);
  results.systemAudioApps = await page.evaluate(() => [...document.querySelectorAll('.rb-apps label')].map((l) => l.textContent.trim()));
  if (results.systemAudioApps.length) await page.click('.rb-apps label >> nth=0');
  await page.waitForTimeout(200);
  await shot(page, '01d-system-audio-apps');
  await page.click('.rb-pop [role="menuitemradio"]:has-text("No system audio")');
  // options: the new capture toggles
  await menu('options');
  results.options = await page.evaluate(() => [...document.querySelectorAll('.rb-options [role="switch"]')].map((t) => `${t.getAttribute('aria-label')}=${t.getAttribute('aria-checked')}`));
  results.keysHint = await page.evaluate(() => [...document.querySelectorAll('.rb-options .tiny')].map((t) => t.textContent).find((t) => /Input Monitoring|never stored/.test(t)) ?? null);
  await shot(page, '01e-options');
  await closeMenu();
  await page.click('.rb-mode[data-mode="window"]');
  await page.waitForTimeout(500);
  const firstWindow = page.locator('.picker .pick').first();
  if (await firstWindow.count()) {
    await firstWindow.click();
    await page.waitForTimeout(300);
    await menu('resize-menu');
    results.windowSizes = await page.evaluate(() => [...document.querySelectorAll('.rb-pop [role="menuitemradio"]')].map((b) => b.textContent.trim()));
    await shot(page, '02a-record-window-resize');
    await closeMenu();
  } else results.windowSizes = 'no windows listed';
  await page.click('.rb-mode[data-mode="region"]');
  await page.waitForTimeout(400);
  await shot(page, '02-record-area');
  await page.click('.rb-mode[data-mode="device"]');
  await page.waitForTimeout(400);
  results.device = await page.evaluate(() => document.querySelector('.rec-stage .stage-title')?.textContent ?? `${document.querySelectorAll('.picker .pick').length} device(s) listed`);
  await shot(page, '02b-record-device');
  await page.click('.rb-mode[data-mode="none"]');
  await page.waitForTimeout(400);
  await shot(page, '03-record-camera-only');
  await page.click('.rb-mode[data-mode="display"]');
  await page.waitForTimeout(300);

  if (doRecord) {
    // 1b ── a real, short screen + microphone take through the UI
    const perms = await page.evaluate(async () => ({ screen: await window.cutaway.app.permission('screen'), microphone: await window.cutaway.app.permission('microphone'), camera: await window.cutaway.app.permission('camera') }));
    results.permissions = perms;
    if (!synthetic && perms.screen !== 'granted') {
      results.recording = `skipped: screen permission is ${perms.screen}`;
    } else {
      if (synthetic) {
        // Same recorder UI and event handling, fed by the helper's generated sources
        // (screen + two cameras + microphone + system audio + keyboard data). No permissions needed.
        await page.evaluate(() => {
          const real = window.cutaway.record.start;
          window.cutaway.record.start = (projectPath, config) => real(projectPath, { ...config, synthetic: true, screen: { ...(config.screen ?? { type: 'display', displayId: 1, showCursor: false }) }, cameras: [{ slot: 'A', deviceId: 'synthetic-a', width: 1280, height: 720, fps: 30 }, { slot: 'B', deviceId: 'synthetic-b', width: 1280, height: 720, fps: 30 }], microphone: { deviceId: '' }, systemAudio: true, captureKeys: true });
        });
      }
      await page.click('[data-testid="start-recording"]');
      await page.waitForSelector('.countdown', { timeout: 15000 });
      await shot(page, '04-countdown');
      await page.waitForSelector('.rec-live', { timeout: 30000 });
      await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .rec-state')?.textContent ?? ''), null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      const controller = app.windows().find((w) => w.url().includes('#controller'));
      if (controller) {
        await controller.waitForSelector('.controller-pill', { timeout: 5000 }).catch(() => {});
        await controller.screenshot({ path: path.join(out, '05-controller.png'), omitBackground: true }).then(() => console.log('shot', path.join(out, '05-controller.png'))).catch((e) => console.log('controller shot failed', e.message));
        results.controller = await controller.evaluate(() => ({ time: document.querySelector('.controller-pill .time')?.textContent, chips: [...document.querySelectorAll('.controller-pill .chip')].map((c) => c.getAttribute('title')), order: [...document.querySelector('.controller-pill').children].map((c) => c.className.split(' ')[0]) })).catch(() => null);
        // flag a moment from the controller, then pause and resume
        await controller.click('[data-testid="controller-flag"]').catch(() => {});
        await page.waitForTimeout(400);
        results.controller = { ...results.controller, flags: await controller.evaluate(() => document.querySelector('.ctl.flag .count')?.textContent ?? '0').catch(() => null) };
        await controller.click('button[aria-label="Pause recording"]').catch(() => {});
        await page.waitForTimeout(1200);
        await controller.click('button[aria-label="Resume recording"]').catch(() => {});
        await page.waitForTimeout(1500);
      } else results.controller = 'controller window not found';
      await shot(page, '06-recording-main');
      await page.evaluate(() => window.cutaway.record.stop());
      // A finished take lands on the quick-share sheet; carry on to Sources from there.
      await page.waitForSelector('[data-testid="quick-share"]', { timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('.qs-thumb img')?.naturalWidth > 0, null, { timeout: 15000 }).catch(() => {});
      results.quickShare = await page.evaluate(() => ({ title: document.querySelector('.qs-title')?.textContent, sub: document.querySelector('.qs-sub')?.textContent, thumb: document.querySelector('.qs-thumb img')?.naturalWidth ?? 0, actions: [...document.querySelectorAll('.qs-card button')].map((b) => b.textContent.trim()) }));
      await shot(page, '06b-quick-share');
      await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.setView('sources'); s.go('project'); });
      await page.waitForSelector('.source-row', { timeout: 30000 });
      await page.waitForTimeout(800);
      await shot(page, '07-sources-after-recording');
      await page.waitForTimeout(1800);
      {
        const bundle = fs.readdirSync(libraryDir).find((n) => n.endsWith('.cutaway'));
        const saved = JSON.parse(fs.readFileSync(path.join(libraryDir, bundle, 'project.json'), 'utf8'));
        const takeDir = path.join(libraryDir, bundle, 'media', 'take-001');
        results.take = { flags: fs.existsSync(path.join(takeDir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(takeDir, 'manifest.json'), 'utf8')).flags ?? null : null, projectFlags: (saved.flags ?? []).length, files: fs.existsSync(takeDir) ? fs.readdirSync(takeDir).sort() : null, manifestKeys: fs.existsSync(path.join(takeDir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(takeDir, 'manifest.json'), 'utf8')).keys ?? null : null, sources: saved.sources.map((x) => ({ role: x.role, keysFile: x.keysFile ?? null, cursorFile: x.cursorFile ?? null, deviceKind: x.deviceKind ?? null })) };
      }
      results.recording = await page.evaluate(() => [...document.querySelectorAll('.source-row')].map((r) => ({ name: r.querySelector('.source-name')?.textContent, badges: [...r.querySelectorAll('.source-name ~ .pill')].map((p) => p.textContent.trim()), meta: [...r.querySelectorAll('.mono span')].map((s) => s.textContent).join(' | '), sync: r.querySelector('.cov + .row .pill')?.textContent?.trim() })));
    }
  } else {
    await page.click('[data-testid="import-instead"]');
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

  // 4b ── speaker notes window (opened by the app's own IPC, as the recorder's toggle does)
  {
    const notesOpened = app.waitForEvent('window', { timeout: 15000 }).catch(() => null);
    await page.evaluate(() => window.cutaway.app.notesWindow(true));
    const notes = await notesOpened;
    if (notes) {
      await notes.waitForSelector('.notes-window', { timeout: 10000 }).catch(() => {});
      results.notes = await notes.evaluate(() => ({ rendered: !!document.querySelector('.notes-window'), badge: document.querySelector('.notes-badge')?.textContent?.trim(), transparentBody: document.body.classList.contains('controller-body') })).catch((e) => ({ error: e.message }));
      if (results.notes.rendered) {
        await notes.fill('.notes-text', 'Intro: what we are building today.\nStep 1: open the export panel.\nStep 2: choose the format.\nDo not forget the frame rate.');
        await notes.click('button[aria-label="Notes settings"]');
        await notes.waitForTimeout(300);
        await notes.screenshot({ path: path.join(out, '14-speaker-notes.png'), omitBackground: true });
        console.log('shot', path.join(out, '14-speaker-notes.png'));
        results.notes.persisted = await notes.evaluate(() => new Promise((r) => setTimeout(() => r(localStorage.getItem('cutaway.notes.text')?.startsWith('Intro')), 500)));
      }
      await page.evaluate(() => window.cutaway.app.notesWindow(false));
    } else results.notes = 'notes window did not open';
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
