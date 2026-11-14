import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, protocol, screen, session, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MEDIA_SCHEME, type CountdownState, type GenModels, type GenProvider, type GenRequest, type MotionRenderRequest, type Permission, type PermissionKind, type PrompterPlace, type RecordConfig } from '../shared/api';
import * as native from './native';
import * as library from './library';
import * as exporter from './exporter';
import * as looks from './looks';
import { registerAi } from './ai';
import * as gen from './gen';
import * as motion from './motion';
import { bindingOf, toAccelerator } from '../shared/keymap';

const DEV_URL = process.env.CUTAWAY_DEV_URL;
// Tests point the app at a throwaway profile so they never touch real projects.
if (process.env.CUTAWAY_USER_DATA) app.setPath('userData', process.env.CUTAWAY_USER_DATA);
app.setName('Cutaway');

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
  // live animation previews: their own origin, so they never inherit (or loosen) the editor's policy
  { scheme: motion.PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
]);

let mainWindow: BrowserWindow | null = null;
let controller: BrowserWindow | null = null;

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.caf': 'audio/x-caf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.json': 'application/json',
};

function fileStream(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  const node = fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 });
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      node.on('data', (chunk) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk as Buffer));
        if ((controller.desiredSize ?? 1) <= 0) node.pause();
      });
      node.on('end', () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
      node.on('error', (e) => {
        if (!closed) {
          closed = true;
          controller.error(e);
        }
      });
    },
    pull() {
      node.resume();
    },
    cancel() {
      closed = true;
      node.destroy();
    },
  });
}

/** Local media for <video>, fetch and WebCodecs, with byte ranges so seeking works. */
function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = decodeURIComponent(url.pathname.slice(1));
    const cors = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (!path.isAbsolute(file)) return new Response('bad path', { status: 400, headers: cors });
    let size: number;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      return new Response('not found', { status: 404, headers: cors });
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('range');
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m && size > 0) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (!m[1] && m[2]) {
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${size}` } });
      return new Response(request.method === 'HEAD' ? null : fileStream(file, start, end), {
        status: 206,
        headers: { ...cors, 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
      });
    }
    return new Response(request.method === 'HEAD' || size === 0 ? null : fileStream(file, 0, size - 1), { status: 200, headers: { ...cors, 'Content-Type': type, 'Content-Length': String(size) } });
  });
}

function webPreferences(): Electron.WebPreferences {
  return { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
}

const E2E = process.env.CUTAWAY_E2E === '1';

function load(win: BrowserWindow, hash = '') {
  if (DEV_URL) void win.loadURL(`${DEV_URL}${E2E ? '?e2e=1' : ''}${hash ? `#${hash}` : ''}`);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: hash || undefined, query: E2E ? { e2e: '1' } : undefined });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f0d0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    title: 'Cutaway',
    webPreferences: webPreferences(),
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  load(mainWindow);
}

function showController() {
  if (controller && !controller.isDestroyed()) return controller.showInactive();
  const d = screen.getPrimaryDisplay().workArea;
  const w = 500;
  const h = 76;
  controller = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(d.x + (d.width - w) / 2),
    y: Math.round(d.y + d.height - h - 28),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: webPreferences(),
  });
  controller.setAlwaysOnTop(true, 'screen-saver');
  controller.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Belt and braces: the helper also excludes this app's windows from capture.
  controller.setContentProtection(true);
  controller.once('ready-to-show', () => controller?.showInactive());
  controller.webContents.once('did-finish-load', () => (pushSelfView(), pushPrompter()));
  controller.on('closed', () => (controller = null));
  load(controller, 'controller');
}

let notes: BrowserWindow | null = null;
let prompterSave: ReturnType<typeof setTimeout> | null = null;

/** Tell the recording controller (and the app) whether the teleprompter is up. */
function pushPrompter() {
  const state = { visible: !!notes && !notes.isDestroyed() };
  for (const w of [controller, mainWindow]) if (w && !w.isDestroyed()) w.webContents.send('prompter:state', state);
}

/** The bounds of one of the teleprompter's quick places, on the display it is on now. */
function prompterBounds(place: PrompterPlace): Electron.Rectangle | null {
  const ref = notes && !notes.isDestroyed() ? notes.getBounds() : null;
  const area = (ref ? screen.getDisplayMatching(ref) : screen.getPrimaryDisplay()).workArea;
  const w = Math.min(640, Math.round(area.width * 0.46));
  switch (place) {
    case 'top':
      // just under the built-in camera, so the eyes stay near the lens while reading
      return { x: Math.round(area.x + (area.width - w) / 2), y: area.y + 6, width: w, height: 230 };
    case 'bottom':
      return { x: Math.round(area.x + (area.width - w) / 2), y: area.y + area.height - 230 - 120, width: w, height: 230 };
    case 'left':
    case 'right': {
      const sw = 400;
      const h = Math.round(area.height * 0.62);
      return { x: place === 'left' ? area.x + 16 : area.x + area.width - sw - 16, y: Math.round(area.y + (area.height - h) / 2), width: sw, height: h };
    }
    case 'camera': {
      if (!selfViewWin || selfViewWin.isDestroyed()) return null;
      const b = selfViewWin.getBounds();
      // over the camera bubble, a little wider than it so a few words fit on a line
      const width = Math.max(320, b.width + 120);
      const height = Math.max(200, b.height);
      return { x: Math.round(b.x + b.width / 2 - width / 2), y: b.y, width, height };
    }
  }
}

/** The teleprompter: an always-on-top window that the recorder leaves out of the picture. */
function showNotes() {
  if (notes && !notes.isDestroyed()) return notes.show();
  const saved = library.getSettings().prompter;
  const fits = saved && screen.getAllDisplays().some((d) => intersects(d.workArea, saved));
  const b = fits ? saved! : prompterBounds('top')!;
  const win = new BrowserWindow({ ...b, frame: false, transparent: true, resizable: true, minWidth: 260, minHeight: 140, alwaysOnTop: true, skipTaskbar: true, hasShadow: true, show: false, fullscreenable: false, maximizable: false, minimizable: false, webPreferences: webPreferences() });
  notes = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Belt and braces: the recorder already leaves every Cutaway window out of the capture.
  win.setContentProtection(true);
  const remember = () => {
    if (prompterSave) clearTimeout(prompterSave);
    prompterSave = setTimeout(() => {
      if (win.isDestroyed()) return;
      void library.setSettings({ prompter: win.getBounds() }).catch(() => {});
    }, 400);
  };
  win.on('moved', remember);
  win.on('resized', remember);
  // shown without taking focus while a take runs, so keystrokes keep going to what is being recorded
  win.once('ready-to-show', () => (native.isRecording() ? win.showInactive() : win.show()));
  win.on('closed', () => {
    if (notes === win) notes = null;
    pushPrompter();
  });
  load(win, 'notes');
  pushPrompter();
}

function hideNotes() {
  if (notes && !notes.isDestroyed()) notes.close();
  notes = null;
  pushPrompter();
}

function placePrompter(place: PrompterPlace): boolean {
  if (!notes || notes.isDestroyed()) showNotes();
  const b = prompterBounds(place);
  if (!b || !notes) return false;
  notes.setBounds(b, true);
  return true;
}

function hideController() {
  if (controller && !controller.isDestroyed()) controller.close();
  controller = null;
}

// ───────────────────────────── recorder overlays ─────────────────────────────
// Two small windows that sit on top of whatever is being recorded and are never part of it:
// the countdown over the target, and the creator's own camera while a take runs. Both belong
// to this app, which the recorder leaves out of every display capture; content protection is
// a second guard, and a window capture never contains other windows at all.

type Rect = { x: number; y: number; width: number; height: number };
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

let countdownWin: BrowserWindow | null = null;
let countdownState: (CountdownState & { bounds: Rect }) | null = null;
let countdownMovedMain = false;

function pushCountdown() {
  if (countdownWin && !countdownWin.isDestroyed() && countdownState) countdownWin.webContents.send('countdown:state', countdownState);
}

async function showCountdown(state: CountdownState): Promise<void> {
  const r = state.rect;
  const display = screen.getDisplayNearestPoint({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  countdownState = { ...state, bounds: display.bounds };
  if (countdownWin && !countdownWin.isDestroyed()) return pushCountdown();
  // Cutaway steps aside when it would cover what is about to be recorded.
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized() && intersects(mainWindow.getBounds(), r)) {
    countdownMovedMain = true;
    mainWindow.minimize();
  }
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: webPreferences(),
  });
  countdownWin = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  win.setBounds(display.bounds);
  win.on('closed', () => {
    if (countdownWin === win) countdownWin = null;
  });
  // The overlay takes no keyboard focus, so Escape is caught globally for these few seconds.
  globalShortcut.register('Escape', () => mainWindow?.webContents.send('countdown:cancel'));
  await new Promise<void>((done) => {
    win.webContents.once('did-finish-load', () => {
      pushCountdown();
      win.showInactive();
      done();
    });
    setTimeout(done, 1500);
    load(win, 'countdown');
  });
}

async function endCountdown(cancelled: boolean): Promise<void> {
  if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
  countdownState = null;
  const win = countdownWin;
  countdownWin = null;
  if (win && !win.isDestroyed()) {
    await new Promise<void>((done) => {
      win.once('closed', () => done());
      win.destroy();
      setTimeout(done, 400);
    });
    // One frame for the window server to take it off the screen before a capture can start.
    await new Promise((done) => setTimeout(done, 60));
  }
  if (cancelled && countdownMovedMain && mainWindow) {
    mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  countdownMovedMain = false;
}

let selfViewWin: BrowserWindow | null = null;
let selfViewCameras: string[] = [];
let selfViewSave: ReturnType<typeof setTimeout> | null = null;

function pushSelfView() {
  const state = { visible: !!selfViewWin && !selfViewWin.isDestroyed(), cameras: selfViewCameras };
  for (const w of [controller, selfViewWin, mainWindow]) if (w && !w.isDestroyed()) w.webContents.send('selfview:state', state);
}

function showSelfView() {
  if (selfViewWin && !selfViewWin.isDestroyed()) return selfViewWin.showInactive();
  if (!selfViewCameras.length) return;
  const prefs = library.getSettings().selfView ?? {};
  const size = Math.max(120, Math.min(560, Math.round(prefs.size ?? 220)));
  const area = screen.getPrimaryDisplay().workArea;
  let x = Math.round(area.x + 28);
  let y = Math.round(area.y + area.height - size - 28);
  // A remembered position is only used while it is still on a connected display.
  if (typeof prefs.x === 'number' && typeof prefs.y === 'number' && screen.getAllDisplays().some((d) => intersects(d.workArea, { x: prefs.x!, y: prefs.y!, width: size, height: size }))) {
    x = Math.round(prefs.x);
    y = Math.round(prefs.y);
  }
  const win = new BrowserWindow({ width: size, height: size, x, y, minWidth: 120, minHeight: 120, maxWidth: 560, maxHeight: 560, frame: false, transparent: true, resizable: true, maximizable: false, minimizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, webPreferences: webPreferences() });
  selfViewWin = win;
  win.setAspectRatio(1);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The camera is its own track; the bubble on screen is only for the creator to see.
  win.setContentProtection(true);
  const remember = () => {
    if (selfViewSave) clearTimeout(selfViewSave);
    selfViewSave = setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      void library.setSettings({ selfView: { ...(library.getSettings().selfView ?? {}), x: b.x, y: b.y, size: b.width } }).catch(() => {});
    }, 400);
  };
  win.on('moved', remember);
  win.on('resized', remember);
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.once('did-finish-load', pushSelfView);
  win.on('closed', () => {
    if (selfViewWin === win) selfViewWin = null;
    native.setPreview(false);
    pushSelfView();
  });
  native.setPreview(true);
  load(win, 'selfview');
  pushSelfView();
}

function hideSelfView() {
  const win = selfViewWin;
  selfViewWin = null;
  if (win && !win.isDestroyed()) win.destroy();
  native.setPreview(false);
  pushSelfView();
}

native.onPreview((frame) => {
  if (selfViewWin && !selfViewWin.isDestroyed()) selfViewWin.webContents.send('record:preview', frame);
});

if (E2E) (globalThis as { __recorderOverlays?: unknown }).__recorderOverlays = { countdown: () => countdownWin, countdownState: () => countdownState, selfView: () => selfViewWin, controller: () => controller };

function sendMenu(cmd: string) {
  (BrowserWindow.getFocusedWindow() ?? mainWindow)?.webContents.send('menu', cmd);
}

/** Electron accelerator for a keymap command, honouring the creator's changes. */
function accelerator(id: string): string | undefined {
  return toAccelerator(bindingOf(id, library.getSettings().shortcuts));
}

let globalAccelerators: string[] = [];

/** Shortcuts that work from any app: start/stop always, the flag only while a take is running. */
function applyGlobalShortcuts() {
  for (const a of globalAccelerators) globalShortcut.unregister(a);
  globalAccelerators = [];
  const register = (id: string, run: () => void) => {
    const a = accelerator(id);
    if (!a) return;
    try {
      if (globalShortcut.register(a, run)) globalAccelerators.push(a);
    } catch {
      /* a combination macOS refuses is simply not registered */
    }
  };
  register('record-toggle', () => {
    if (native.isRecording()) void native.stopRecording().catch(() => {});
    else sendMenu('record');
  });
  if (native.isRecording()) register('flag', () => void native.flagRecording().catch(() => {}));
}

function buildMenu() {
  // Accelerators come from the keymap, so shortcuts changed in Settings apply to the menu too.
  const item = (label: string, cmd: string, _default?: string): MenuItemConstructorOptions => ({ label, accelerator: accelerator(cmd), click: () => sendMenu(cmd) });
  const template: MenuItemConstructorOptions[] = [
    { label: 'Cutaway', submenu: [{ role: 'about' }, { type: 'separator' }, item('Settings…', 'settings', 'Cmd+,'), { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [item('New Recording', 'record', 'Cmd+N'), item('Import Media…', 'import', 'Cmd+I'), { type: 'separator' }, item('Project Library', 'library', 'Cmd+Shift+L'), item('Save', 'save', 'Cmd+S'), { type: 'separator' }, item('Export…', 'export', 'Shift+Cmd+E'), { type: 'separator' }, { role: 'close' }] },
    { label: 'Edit', submenu: [item('Undo', 'undo', 'Cmd+Z'), item('Redo', 'redo', 'Shift+Cmd+Z'), { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, item('Duplicate', 'duplicate', 'Cmd+D'), item('Split at Playhead', 'split', 'Cmd+B'), item('Lock Selection', 'lock', 'Cmd+L')] },
    {
      label: 'View',
      submenu: [
        item('Command Menu…', 'palette', 'Cmd+K'),
        { type: 'separator' },
        item('Background', 'tab:background', 'Cmd+1'),
        item('Cursor', 'tab:cursor', 'Cmd+2'),
        item('Camera', 'tab:camera', 'Cmd+3'),
        item('Captions', 'tab:captions', 'Cmd+4'),
        item('Transcript', 'tab:transcript', 'Cmd+5'),
        item('Audio', 'tab:audio', 'Cmd+6'),
        item('Keyboard Shortcuts', 'tab:shortcuts', 'Cmd+7'),
        item('Animations', 'tab:motion', 'Cmd+8'),
        item('Ask AI', 'tab:chat', 'Cmd+9'),
        { type: 'separator' },
        item('Sources', 'view-sources'),
        item('Edit', 'view-edit'),
        item('Package', 'view-package'),
        item('Show or Hide Sidebar', 'toggle-sidebar', 'Cmd+\\'),
        item('More Timelines', 'toggle-timeline', 'Cmd+T'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────────── permissions ─────────────────────────────

function mediaPermission(kind: PermissionKind): Permission {
  const s = systemPreferences.getMediaAccessStatus(kind);
  if (s === 'granted') return 'granted';
  if (s === 'not-determined') return 'undetermined';
  return 'denied';
}

/**
 * Screen Recording is checked through the helper: it is the process that
 * captures, and a new process sees a grant at once, while this one keeps the
 * answer it got at launch. macOS cannot tell "never asked" from "off", so that
 * part is remembered in settings.
 */
async function permission(kind: PermissionKind): Promise<Permission> {
  if (kind !== 'screen') return mediaPermission(kind);
  if (process.platform !== 'darwin') return 'granted';
  // Test runs can pin the state, so the permission screens are exercised without touching macOS privacy settings.
  const pinned = E2E ? process.env.CUTAWAY_E2E_SCREEN : undefined;
  if (pinned === 'granted') return 'granted';
  if (pinned === 'off') return library.getSettings().screenAccessAsked ? 'denied' : 'undetermined';
  try {
    const r = await native.screenAccess(false);
    if (r.screen === 'granted') return 'granted';
  } catch {
    if (mediaPermission('screen') === 'granted') return 'granted';
  }
  return library.getSettings().screenAccessAsked ? 'denied' : 'undetermined';
}

async function requestPermission(kind: PermissionKind): Promise<Permission> {
  if (kind === 'screen') {
    if ((await permission('screen')) === 'granted') return 'granted';
    if (E2E && process.env.CUTAWAY_E2E_SCREEN === 'off') {
      await library.setSettings({ screenAccessAsked: true });
      return 'denied';
    }
    // Shows the macOS prompt the first time and adds the app to the Screen & System Audio Recording list.
    const r = await native.screenAccess(true).catch(() => null);
    // The same from this process, so the app's own window previews are covered too.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } }).catch(() => {});
    if (!library.getSettings().screenAccessAsked) await library.setSettings({ screenAccessAsked: true });
    return r?.screen === 'granted' ? 'granted' : permission('screen');
  }
  if (mediaPermission(kind) === 'undetermined') await systemPreferences.askForMediaAccess(kind);
  return mediaPermission(kind);
}

const PRIVACY_PANE: Record<PermissionKind, string> = { screen: 'Privacy_ScreenCapture', camera: 'Privacy_Camera', microphone: 'Privacy_Microphone' };

// ───────────────────────────── IPC ─────────────────────────────

function handle(ns: string, impl: Record<string, (...args: never[]) => unknown>) {
  for (const [name, fn] of Object.entries(impl)) {
    ipcMain.handle(`${ns}:${name}`, async (_e, ...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        // Preserve machine-readable codes across the IPC boundary.
        const err = e as Error & { code?: string };
        throw new Error(JSON.stringify({ code: err.code ?? 'error', message: err.message }));
      }
    });
  }
}

const FILTERS = {
  video: { name: 'Video', extensions: ['mp4', 'mov', 'm4v'] },
  audio: { name: 'Audio', extensions: ['wav', 'm4a', 'mp3', 'aac'] },
  image: { name: 'Images', extensions: ['jpg', 'jpeg', 'png'] },
  model: { name: 'Whisper model', extensions: ['bin'] },
};

function registerIpc() {
  handle('app', {
    info: () => ({ packaged: app.isPackaged, version: app.getVersion(), libraryDir: library.getSettings().libraryDir, exportDir: library.getSettings().exportDir, arch: process.arch, os: `macOS ${process.getSystemVersion()}`, nativeHelper: native.helperAvailable() }),
    getSettings: () => library.getSettings(),
    setSettings: async (patch: Parameters<typeof library.setSettings>[0]) => {
      const next = await library.setSettings(patch);
      if ('shortcuts' in patch) {
        buildMenu();
        applyGlobalShortcuts();
      }
      return next;
    },
    pickFiles: async (opts: { title: string; kinds: (keyof typeof FILTERS)[]; multiple: boolean }) => {
      const all = opts.kinds.flatMap((k) => FILTERS[k].extensions);
      const r = await dialog.showOpenDialog(mainWindow!, { title: opts.title, properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: 'Supported media', extensions: all }, ...opts.kinds.map((k) => FILTERS[k])] });
      return r.canceled ? [] : r.filePaths;
    },
    pickFolder: async (title: string, defaultPath?: string) => {
      const r = await dialog.showOpenDialog(mainWindow!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    reveal: (p: string) => shell.showItemInFolder(p),
    openPath: async (p: string) => {
      await shell.openPath(p);
    },
    freeBytes: (p: string) => library.freeBytes(p),
    permission: (kind: PermissionKind) => permission(kind),
    requestPermission: (kind: PermissionKind) => requestPermission(kind),
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    openPrivacySettings: async (kind: PermissionKind) => {
      // Test runs record the request instead of opening System Settings on the machine.
      if (E2E) return void ((globalThis as { __openedPrivacy?: string[] }).__openedPrivacy ??= []).push(kind);
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANE[kind]}`);
    },
    captureThumbnails: async () => {
      if ((await permission('screen')) !== 'granted') return [];
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: false });
      return sources
        .filter((s) => !s.thumbnail.isEmpty())
        .map((s) => ({ kind: s.id.startsWith('screen') ? ('display' as const) : ('window' as const), id: Number(s.id.split(':')[1]), displayId: s.display_id ? Number(s.display_id) : null, name: s.name, dataUrl: s.thumbnail.toDataURL() }));
    },
    copyFile: async (p: string) => {
      // Finder-style file copy through NSPasteboard: pasteable into Slack, Mail, Messages, Finder…
      const { execFile } = await import('node:child_process');
      const script = 'function run(argv){ObjC.import("AppKit");var pb=$.NSPasteboard.generalPasteboard;pb.clearContents;return pb.writeObjects($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(argv[0])))}';
      const out = await new Promise<string>((res, rej) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, p], (err, stdout) => (err ? rej(err) : res(stdout.trim()))));
      if (out !== 'true') throw new Error('The file could not be placed on the clipboard.');
    },
    saveCopyAs: async (source: string, suggestedName: string) => {
      // Test runs name the folder up front instead of answering a dialog.
      const pinned = E2E ? process.env.CUTAWAY_E2E_SAVE_DIR : undefined;
      let dest: string;
      if (pinned) dest = path.join(pinned, suggestedName);
      else {
        const r = await dialog.showSaveDialog(mainWindow!, { title: 'Save video as', defaultPath: suggestedName, buttonLabel: 'Save' });
        if (r.canceled || !r.filePath) return null;
        dest = r.filePath;
      }
      await fsp.copyFile(source, dest);
      return dest;
    },
    notesWindow: (show: boolean | 'toggle') => ((show === 'toggle' ? !(notes && !notes.isDestroyed()) : show) ? showNotes() : hideNotes()),
    prompterPlace: (place: PrompterPlace) => placePrompter(place),
    countdown: (state: CountdownState) => showCountdown(state),
    countdownEnd: (cancelled: boolean) => endCountdown(cancelled),
    selfView: async (show: boolean | 'toggle') => {
      const visible = !!selfViewWin && !selfViewWin.isDestroyed();
      const want = show === 'toggle' ? !visible : show;
      if (want) showSelfView();
      else hideSelfView();
      // Remembered across takes: someone who hides the bubble does not want it back uninvited.
      await library.setSettings({ selfView: { ...(library.getSettings().selfView ?? {}), hidden: !want } }).catch(() => {});
      return !!selfViewWin && !selfViewWin.isDestroyed();
    },
    recordingMode: (on: boolean, opts?: { cameras?: string[]; keepWindow?: boolean }) => {
      if (on) {
        selfViewCameras = (opts?.cameras ?? []).filter((c) => c === 'cameraA' || c === 'cameraB');
        showController();
        if (selfViewCameras.length && !library.getSettings().selfView?.hidden) showSelfView();
        else pushSelfView();
        // a demo of Cutaway keeps its window up; otherwise it gets out of the way of what is being recorded
        if (!opts?.keepWindow) mainWindow?.minimize();
      } else {
        selfViewCameras = [];
        hideSelfView();
        hideController();
        if (mainWindow) {
          mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
  });

  handle('library', {
    list: library.list,
    create: library.create,
    open: library.open,
    save: library.save,
    rename: library.rename,
    trash: library.trash,
    savePoster: library.savePoster,
    importMedia: library.importMedia,
    recoverable: library.recoverable,
    recover: native.recover,
    discardTake: library.discardTake,
    cacheInfo: library.cacheInfo,
    clearCache: library.clearCache,
    exists: library.exists,
    exportBundle: library.exportBundle,
  });

  handle('native', {
    devices: native.devices,
    preflight: (config: RecordConfig) => native.preflight(config, library.getSettings().libraryDir),
    probe: native.probe,
    frames: native.frames,
    activity: native.activity,
    transcribe: (file: string, locale: string) => native.transcribe(file, locale, library.getSettings()),
    analyzeVoice: native.analyzeVoice,
    correlate: native.correlate,
    readCursor: native.readCursor,
    readKeys: native.readKeys,
    faces: native.faces,
    matte: native.matte,
    resizeWindow: native.resizeWindow,
    browserTabs: native.browserTabs,
    selectBrowserTab: native.selectBrowserTab,
    browserContent: native.browserContent,
    voices: native.voices,
    speak: native.speak,
    removeVoiceover: native.removeVoiceover,
    saveRecording: native.saveRecording,
    sensitive: native.sensitive,
  });

  handle('record', {
    start: async (projectPath: string, config: RecordConfig) => {
      // Test runs note whether the countdown overlay was still up when the recorder was asked to start.
      if (E2E) (globalThis as { __overlayAtStart?: boolean }).__overlayAtStart = !!countdownWin && !countdownWin.isDestroyed();
      const r = await native.startRecording(projectPath, config);
      applyGlobalShortcuts();
      return r;
    },
    pause: native.pauseRecording,
    resume: native.resumeRecording,
    flag: native.flagRecording,
    stop: native.stopRecording,
    cancel: native.cancelRecording,
  });

  handle('motion', {
    save: (projectPath: string, html: string, name: string) => motion.saveMotion(projectPath, html, name),
    read: (projectPath: string, file: string) => motion.readMotion(projectPath, file),
    check: (html: string, fields: Record<string, string> | null, width: number, height: number) => motion.checkMotion(html, fields, width, height),
    preview: (html: string, fields: Record<string, string>, duration: number) => motion.previewUrl(html, fields, duration),
    templates: () => motion.listTemplates(),
    saveTemplate: (html: string, name: string) => motion.saveTemplate(html, name),
    removeTemplate: (id: string) => motion.removeTemplate(id),
    render: (projectPath: string, req: MotionRenderRequest) => motion.renderMotion(projectPath, req, (done, total, key) => mainWindow?.webContents.send('motion:progress', { key: req.tag ?? key, done, total })),
  });

  // media generation with the creator's own ElevenLabs or fal.ai key; the keys stay in this process
  handle('gen', {
    status: () => gen.keyStatus(),
    setKey: (provider: GenProvider, key: string | null) => gen.setKey(provider, key),
    setModels: (patch: Partial<GenModels>) => gen.setModels(patch),
    testKey: (provider: GenProvider) => gen.testKey(provider),
    voices: (provider: GenProvider) => gen.listVoices(provider),
    generate: (projectPath: string, req: GenRequest) => gen.generate(projectPath, req, (text) => mainWindow?.webContents.send('gen:status', { jobId: req.jobId, text })),
    cancel: (jobId: string) => gen.cancel(jobId),
    discard: (projectPath: string, relPath: string) => gen.discard(projectPath, relPath),
  });

  handle('export', {
    existingFolders: exporter.existingFolders,
    begin: exporter.begin,
    write: exporter.write,
    writeFile: exporter.writeFile,
    mux: exporter.mux,
    stat: exporter.stat,
    gif: exporter.gif,
    commit: exporter.commit,
    abort: exporter.abort,
    pickFile: async (defaultDir: string, defaultName: string) => {
      const ext = defaultName.split('.').pop() ?? 'mp4';
      const r = await dialog.showSaveDialog(mainWindow!, { title: 'Export', buttonLabel: 'Export', defaultPath: await exporter.freeFilePath(defaultDir, defaultName), filters: [{ name: ext.toUpperCase(), extensions: [ext] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (r.canceled || !r.filePath) return null;
      const chosen = r.filePath.toLowerCase().endsWith(`.${ext}`) ? r.filePath : `${r.filePath}.${ext}`;
      return { path: chosen, replace: fs.existsSync(chosen) };
    },
    freeFilePath: exporter.freeFilePath,
    beginFile: exporter.beginFile,
    commitFile: exporter.commitFile,
  });

  handle('looks', {
    importLut: looks.importLut,
    searchImages: looks.searchImages,
    useImage: looks.useImage,
    openCredit: looks.openCredit,
  });

  registerAi(ipcMain, () => library.getSettings());
}

// ───────────────────────────── lifecycle ─────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.restore();
    mainWindow.focus();
  }
});

void app.whenReady().then(async () => {
  await gen.initGen(app.getPath('userData'));
  motion.initMotionTemplates(app.getPath('userData'));
  registerMediaProtocol();
  motion.registerPreviewProtocol();
  registerIpc();
  buildMenu();
  // Camera and microphone previews in the recorder setup.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  createMainWindow();
  applyGlobalShortcuts();
  // The flag shortcut exists only while a take is running.
  native.onSessionEnded(() => applyGlobalShortcuts());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow?.show();
  });
});

// A helper process (recorder, Claude Code, Codex) can exit while a command is on its way to it. That is a
// normal race, never a reason to interrupt the creator with an error box; anything else is still shown.
const PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ECONNRESET']);
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err && PIPE_CODES.has(err.code ?? '')) {
    console.error('[pipe-closed]', err.code, (err.stack ?? '').split('\n').slice(1, 4).join(' | '));
    return;
  }
  console.error('[uncaught]', err?.stack ?? err);
  if (process.env.CUTAWAY_E2E !== '1') dialog.showErrorBox('Cutaway hit an unexpected error', `${err?.message ?? err}\n\nYour project is saved. If something looks wrong, quit and reopen Cutaway.`);
});

app.on('render-process-gone', (_e, wc, details) => console.error('[render-process-gone]', wc.getURL().slice(-40), JSON.stringify(details)));
app.on('child-process-gone', (_e, details) => console.error('[child-process-gone]', JSON.stringify(details)));

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !native.isRecording()) return;
  // Finalize the take instead of dropping it.
  e.preventDefault();
  quitting = true;
  void native.shutdownRecording().finally(() => app.quit());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  native.killHelpers();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
