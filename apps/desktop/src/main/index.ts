import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, protocol, screen, session, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MEDIA_SCHEME, type Permission, type PermissionKind, type RecordConfig } from '../shared/api';
import * as native from './native';
import * as library from './library';
import * as exporter from './exporter';
import { registerAi } from './ai';

const DEV_URL = process.env.CUTAWAY_DEV_URL;
// Tests point the app at a throwaway profile so they never touch real projects.
if (process.env.CUTAWAY_USER_DATA) app.setPath('userData', process.env.CUTAWAY_USER_DATA);
app.setName('Cutaway');

protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }]);

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
  const w = 420;
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
  controller.on('closed', () => (controller = null));
  load(controller, 'controller');
}

function hideController() {
  if (controller && !controller.isDestroyed()) controller.close();
  controller = null;
}

function sendMenu(cmd: string) {
  (BrowserWindow.getFocusedWindow() ?? mainWindow)?.webContents.send('menu', cmd);
}

function buildMenu() {
  const item = (label: string, cmd: string, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => sendMenu(cmd) });
  const template: MenuItemConstructorOptions[] = [
    { label: 'Cutaway', submenu: [{ role: 'about' }, { type: 'separator' }, item('Settings…', 'settings', 'Cmd+,'), { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [item('New Recording', 'record', 'Cmd+N'), item('Import Media…', 'import', 'Cmd+I'), { type: 'separator' }, item('Project Library', 'library', 'Cmd+Shift+L'), item('Save', 'save', 'Cmd+S'), { type: 'separator' }, item('Export YouTube Package…', 'export', 'Cmd+E'), { type: 'separator' }, { role: 'close' }] },
    { label: 'Edit', submenu: [item('Undo', 'undo', 'Cmd+Z'), item('Redo', 'redo', 'Shift+Cmd+Z'), { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, item('Split at Playhead', 'split', 'Cmd+B'), item('Lock Selection', 'lock', 'Cmd+L')] },
    { label: 'View', submenu: [item('Edit', 'view-edit', 'Cmd+1'), item('Package', 'view-package', 'Cmd+2'), item('Export', 'view-export', 'Cmd+3'), { type: 'separator' }, item('Expanded Timeline', 'toggle-timeline', 'Cmd+T'), { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : ([{ role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────────── permissions ─────────────────────────────

function permission(kind: PermissionKind): Permission {
  const s = systemPreferences.getMediaAccessStatus(kind);
  if (s === 'granted') return 'granted';
  if (s === 'not-determined') return 'undetermined';
  return 'denied';
}

async function requestPermission(kind: PermissionKind): Promise<Permission> {
  if (kind === 'screen') {
    // macOS only shows its screen-recording prompt when capture is attempted.
    if (permission('screen') === 'undetermined') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } }).catch(() => {});
    return permission('screen');
  }
  if (permission(kind) === 'undetermined') await systemPreferences.askForMediaAccess(kind);
  return permission(kind);
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
    info: () => ({ version: app.getVersion(), libraryDir: library.getSettings().libraryDir, exportDir: library.getSettings().exportDir, arch: process.arch, os: `macOS ${process.getSystemVersion()}`, nativeHelper: native.helperAvailable() }),
    getSettings: () => library.getSettings(),
    setSettings: (patch: Parameters<typeof library.setSettings>[0]) => library.setSettings(patch),
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
    openPrivacySettings: (kind: PermissionKind) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANE[kind]}`),
    captureThumbnails: async () => {
      if (permission('screen') !== 'granted') return [];
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: false });
      return sources
        .filter((s) => !s.thumbnail.isEmpty())
        .map((s) => ({ kind: s.id.startsWith('screen') ? ('display' as const) : ('window' as const), id: Number(s.id.split(':')[1]), displayId: s.display_id ? Number(s.display_id) : null, name: s.name, dataUrl: s.thumbnail.toDataURL() }));
    },
    recordingMode: (on: boolean) => {
      if (on) {
        showController();
        mainWindow?.minimize();
      } else {
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
  });

  handle('record', {
    start: native.startRecording,
    pause: native.pauseRecording,
    resume: native.resumeRecording,
    stop: native.stopRecording,
    cancel: native.cancelRecording,
  });

  handle('export', {
    existingFolders: exporter.existingFolders,
    begin: exporter.begin,
    write: exporter.write,
    writeFile: exporter.writeFile,
    mux: exporter.mux,
    stat: exporter.stat,
    commit: exporter.commit,
    abort: exporter.abort,
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

void app.whenReady().then(() => {
  registerMediaProtocol();
  registerIpc();
  buildMenu();
  // Camera and microphone previews in the recorder setup.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  createMainWindow();
  globalShortcut.register('Control+Alt+Command+R', () => {
    if (native.isRecording()) void native.stopRecording().catch(() => {});
    else sendMenu('record');
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow?.show();
  });
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

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
