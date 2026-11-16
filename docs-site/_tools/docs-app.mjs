// Starts Cutaway for the docs: a throwaway profile, the made-up demo footage, and made-up devices.
//
// Privacy: the recorder would otherwise list this Mac's real displays, windows, cameras and microphones, and show the
// real desktop. Here the main process answers those requests with made-up devices, the display "screenshots" are
// frames of the demo footage, and Chromium's fake camera plays the demo presenter. No real camera or screen is opened.
// Native file dialogs are answered from the main process (setOpenFiles / setSaveFile).
import { launch } from '../../apps/desktop/e2e/harness.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { here } from './callouts.mjs';

const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'inherit'] });

/** Copies the demo footage under friendly names (the project and the timeline show these names). */
export function prepareMedia(demo) {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-docs-media-'));
  const f = (n) => path.join(media, n);
  fs.copyFileSync(path.join(demo, 'screen.mp4'), f('Screen recording.mp4'));
  fs.copyFileSync(path.join(demo, 'camera.mp4'), f('Camera.mp4'));
  if (fs.existsSync(path.join(demo, 'camera-b.mp4'))) fs.copyFileSync(path.join(demo, 'camera-b.mp4'), f('iPhone camera.mp4'));
  if (fs.existsSync(path.join(demo, 'screen-browser.mp4'))) fs.copyFileSync(path.join(demo, 'screen-browser.mp4'), f('Browser recording.mp4'));
  fs.copyFileSync(path.join(demo, 'music.mp3'), f('Upbeat acoustic.mp3'));
  sh(`ffmpeg -hide_banner -loglevel error -y -ss 26 -i "${f('Screen recording.mp4')}" -frames:v 1 "${f('frame.png')}"`);
  sh(`ffmpeg -hide_banner -loglevel error -y -ss 26 -i "${f('Screen recording.mp4')}" -frames:v 1 -vf scale=480:-1 -q:v 3 "${f('frame-small.jpg')}"`);
  if (fs.existsSync(f('Browser recording.mp4'))) sh(`ffmpeg -hide_banner -loglevel error -y -ss 26 -i "${f('Browser recording.mp4')}" -frames:v 1 -vf scale=480:-1 -q:v 3 "${f('browser-small.jpg')}"`);
  // the fake camera: Chromium loops this raw video
  sh(`ffmpeg -hide_banner -loglevel error -y -ss 2 -t 14 -i "${f('Camera.mp4')}" -vf "scale=640:360,fps=30" -pix_fmt yuv420p "${f('camera.y4m')}"`);
  // a "studio photo" and a logo for the thumbnail docs (both made up)
  const photo = path.join(here, 'cache', 'presenter.jpg');
  if (fs.existsSync(photo)) fs.copyFileSync(photo, f('Headshot.jpg'));
  return { dir: media, f };
}

/** Renders the made-up Listful logo to a PNG. */
export async function renderLogo(page, file) {
  const svg = fs.readFileSync(path.join(here, 'listful-logo.svg'), 'utf8');
  const png = await page.evaluate(async (s) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(s);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    c.getContext('2d').drawImage(img, 0, 0, 512, 512);
    return c.toDataURL('image/png');
  }, svg);
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
  return file;
}

export async function startApp({ media, settings = {} } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-docs-'));
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${media.f('camera.y4m')}`];
  const ctx = await launch({ profile, args, settings });
  const { app, page } = ctx;
  const S = (fn, arg) => page.evaluate(fn, arg);
  const toUrl = (file) => 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
  const screenShot = toUrl(media.f('frame-small.jpg'));
  const browserShot = fs.existsSync(media.f('browser-small.jpg')) ? toUrl(media.f('browser-small.jpg')) : screenShot;
  await app.evaluate(({ ipcMain, dialog }, { screenShot, browserShot }) => {
    const handlers = ipcMain._invokeHandlers;
    const swap = (channel, fn) => {
      if (!handlers?.has(channel)) return;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, fn);
    };
    const fmt = [{ width: 1920, height: 1080, maxFps: 30 }, { width: 1280, height: 720, maxFps: 60 }];
    globalThis.__docsPerm = {};
    swap('app:permission', async (_e, kind) => globalThis.__docsPerm[kind] ?? 'granted');
    swap('app:requestPermission', async () => 'granted');
    swap('native:devices', async () => ({
      permissions: { screen: 'granted', camera: 'granted', microphone: 'granted', accessibility: 'granted', inputMonitoring: 'granted' },
      displays: [
        { id: 1, name: 'Built-in Retina Display', width: 1920, height: 1080, scale: 2, x: 0, y: 0, main: true },
        { id: 2, name: 'Second display', width: 1920, height: 1080, scale: 1, x: 1920, y: 0, main: false },
      ],
      windows: [{ id: 11, title: 'Listful – My lists', app: 'Safari', bundleId: 'com.apple.Safari', x: 0, y: 0, width: 1920, height: 1200, displayId: 1 }],
      cameras: [
        { id: 'docs-cam-a', name: 'FaceTime HD Camera', kind: 'builtin', formats: fmt },
        { id: 'docs-cam-b', name: 'iPhone Camera', kind: 'iphone', formats: fmt },
      ],
      microphones: [{ id: 'docs-mic', name: 'MacBook Pro Microphone', default: true }],
      externalDevices: [],
      apps: [{ bundleId: 'com.example.listful', name: 'Listful', pid: 4242 }],
    }));
    swap('app:captureThumbnails', async () => [
      { kind: 'display', id: 1, displayId: 1, name: 'Built-in Retina Display', dataUrl: screenShot },
      { kind: 'display', id: 2, displayId: 2, name: 'Second display', dataUrl: screenShot },
      { kind: 'window', id: 11, displayId: 1, name: 'Listful – My lists', dataUrl: browserShot },
    ]);
    swap('native:preflight', async () => ({ ok: true, issues: [], estimatedBytesPerMinute: 229e6, freeBytes: 412e9 }));
    swap('native:browserTabs', async () => ({ accessibility: 'granted', browsers: [] }));
    globalThis.__docsOpen = [];
    globalThis.__docsSave = null;
    dialog.showOpenDialog = async () => ({ canceled: !globalThis.__docsOpen.length, filePaths: globalThis.__docsOpen });
    dialog.showSaveDialog = async () => ({ canceled: !globalThis.__docsSave, filePath: globalThis.__docsSave ?? undefined });
  }, { screenShot, browserShot });
  await patchRenderer(page);
  return { ...ctx, S, profile };
}

/** In the editor window: Chromium's fake camera and microphone get ordinary names, so the recorder's previews match the made-up devices. Re-run after a reload. */
export async function patchRenderer(page) {
  await page.evaluate(() => {
    const md = navigator.mediaDevices;
    if (md.__docs) return;
    const orig = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => {
      const list = await orig();
      const v = list.find((d) => d.kind === 'videoinput');
      const a = list.find((d) => d.kind === 'audioinput');
      const out = [];
      if (v) out.push({ deviceId: v.deviceId, groupId: v.groupId, kind: 'videoinput', label: 'FaceTime HD Camera' }, { deviceId: v.deviceId, groupId: v.groupId, kind: 'videoinput', label: 'iPhone Camera' });
      if (a) out.push({ deviceId: a.deviceId, groupId: a.groupId, kind: 'audioinput', label: 'MacBook Pro Microphone' });
      return out;
    };
    md.__docs = true;
    // Camera B is the same fake camera: show it closer and the other way round, like a second angle.
    const st = document.createElement('style');
    st.textContent = '.cam-bubble.b video, .comp-cam video.docs-b { transform: scale(1.7) translateY(7%) !important; filter: saturate(1.15) brightness(1.03); }';
    document.head.appendChild(st);
  });
}

/** Pretend a permission is not given yet, to show what the recorder says then (e.g. { screen: 'undetermined' }); {} for all granted. */
export const setPermissions = (app, perms) => app.evaluate((_e, perms) => { globalThis.__docsPerm = perms; }, perms);
export const setOpenFiles = (app, files) => app.evaluate((_e, files) => { globalThis.__docsOpen = files; }, files);
export const setSaveFile = (app, file) => app.evaluate((_e, file) => { globalThis.__docsSave = file; }, file);

/** Hides any toasts and replaces the throwaway profile's temp paths with the usual folders. */
export async function tidy(page) {
  await page.evaluate(() => {
    const s = window.__cutaway?.useApp.getState();
    s?.toasts.forEach((t) => s.dismissToast(t.id));
    const fix = (v) => v.replace(/\S*cutaway-docs-[A-Za-z0-9]+\/Library/g, '~/Movies/Cutaway').replace(/\S*cutaway-docs-[A-Za-z0-9]+\/Exports/g, '~/Movies/Cutaway Exports').replace(/\S*cutaway-docs-media-[A-Za-z0-9]+\//g, '~/Movies/');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) if (/cutaway-docs-/.test(n.nodeValue)) n.nodeValue = fix(n.nodeValue);
    for (const i of document.querySelectorAll('input, textarea')) if (/cutaway-docs-/.test(i.value)) i.value = fix(i.value);
    // never show even the last characters of an API key ("Saved (…abcd)")
    const hide = (v) => v.replace(/…[A-Za-z0-9]{4}\b/g, '…••••');
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((n = w2.nextNode())) if (/…[A-Za-z0-9]{4}\b/.test(n.nodeValue)) n.nodeValue = hide(n.nodeValue);
    for (const i of document.querySelectorAll('input, textarea')) if (i.placeholder && /…[A-Za-z0-9]{4}\b/.test(i.placeholder)) i.placeholder = hide(i.placeholder);
  });
}

/** For video captures: keep replacing the throwaway profile's temp paths with the usual folders, as the page changes. */
export async function keepTidy(page) {
  await page.evaluate(() => {
    clearInterval(window.__docsTidy);
    const fix = (v) => v.replace(/\S*cutaway-docs-[A-Za-z0-9]+\/Library/g, '~/Movies/Cutaway').replace(/\S*cutaway-docs-[A-Za-z0-9]+\/Exports/g, '~/Movies/Cutaway Exports').replace(/\S*cutaway-docs-media-[A-Za-z0-9]+\//g, '~/Movies/');
    window.__docsTidy = setInterval(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) if (/cutaway-docs-/.test(n.nodeValue)) n.nodeValue = fix(n.nodeValue);
      for (const el of document.querySelectorAll('[title*="cutaway-docs-"]')) el.title = fix(el.title);
    }, 100);
  });
}
