import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { MEDIA_SCHEME } from '../shared/api';
import type { AiProgress, CutawayApi, RecordEvent } from '../shared/api';

/**
 * contextBridge drops custom properties from thrown errors, so machine-readable
 * codes would be lost. Calls therefore resolve to an envelope; the renderer's
 * bridge.ts turns failures back into real Errors with `.code`.
 */
type Envelope = { __ok: true; value: unknown } | { __ok: false; code: string; message: string };

async function invoke(channel: string, ...args: unknown[]): Promise<Envelope> {
  try {
    return { __ok: true, value: await ipcRenderer.invoke(channel, ...args) };
  } catch (e) {
    const raw = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    try {
      const parsed = JSON.parse(raw) as { code: string; message: string };
      return { __ok: false, code: parsed.code ?? 'error', message: parsed.message ?? raw };
    } catch {
      return { __ok: false, code: 'error', message: raw };
    }
  }
}

function ns<T extends object>(name: string, methods: (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const m of methods) out[m] = (...args: unknown[]) => invoke(`${name}:${m}`, ...args);
  return out as T;
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: CutawayApi = {
  app: {
    ...ns<CutawayApi['app']>('app', ['info', 'getSettings', 'setSettings', 'pickFiles', 'pickFolder', 'reveal', 'openPath', 'freeBytes', 'permission', 'requestPermission', 'openPrivacySettings', 'relaunch', 'captureThumbnails', 'recordingMode', 'countdown', 'countdownEnd', 'selfView', 'copyFile', 'saveCopyAs', 'notesWindow', 'prompterPlace']),
    onMenu: (cb) => on<string>('menu', cb),
    onCountdown: (cb) => on('countdown:state', cb),
    onCountdownCancel: (cb) => on<void>('countdown:cancel', () => cb()),
    onSelfView: (cb) => on('selfview:state', cb),
    onPrompter: (cb) => on('prompter:state', cb),
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  library: ns<CutawayApi['library']>('library', ['list', 'create', 'open', 'save', 'rename', 'trash', 'savePoster', 'importMedia', 'recoverable', 'recover', 'discardTake', 'cacheInfo', 'clearCache', 'exists', 'exportBundle']),
  native: ns<CutawayApi['native']>('native', ['devices', 'preflight', 'probe', 'frames', 'activity', 'transcribe', 'analyzeVoice', 'correlate', 'readCursor', 'readKeys', 'faces', 'matte', 'resizeWindow', 'browserTabs', 'selectBrowserTab', 'browserContent', 'voices', 'speak', 'removeVoiceover', 'saveRecording', 'sensitive']),
  record: {
    ...ns<CutawayApi['record']>('record', ['start', 'pause', 'resume', 'flag', 'stop', 'cancel']),
    onEvent: (cb) => on<RecordEvent>('record:event', cb),
    onPreview: (cb) => on('record:preview', cb),
  },
  ai: {
    ...ns<Omit<CutawayApi['ai'], 'onProgress'>>('ai', ['status', 'providers', 'signIn', 'run', 'cancel', 'generateImage', 'removeImage']),
    onProgress: (cb) => on<AiProgress>('ai:progress', cb),
  },
  motion: {
    ...ns<Omit<CutawayApi['motion'], 'onProgress'>>('motion', ['save', 'read', 'check', 'render', 'preview', 'templates', 'saveTemplate', 'removeTemplate']),
    onProgress: (cb) => on<{ key: string; done: number; total: number }>('motion:progress', cb),
  },
  control: {
    ...ns<Pick<CutawayApi['control'], 'status' | 'setEnabled' | 'connect'>>('control', ['status', 'setEnabled', 'connect']),
    onCall: (cb) => on<{ id: string; method: string; params: Record<string, unknown> }>('control:call', cb),
    respond: (r) => ipcRenderer.send('control:result', r),
  },
  gen: {
    ...ns<Omit<CutawayApi['gen'], 'onStatus'>>('gen', ['status', 'setKey', 'setModels', 'testKey', 'voices', 'generate', 'cancel', 'discard']),
    onStatus: (cb) => on<{ jobId: string; text: string }>('gen:status', cb),
  },
  export: ns<CutawayApi['export']>('export', ['existingFolders', 'begin', 'write', 'writeFile', 'mux', 'stat', 'gif', 'commit', 'abort', 'pickFile', 'freeFilePath', 'beginFile', 'commitFile']),
  looks: ns<CutawayApi['looks']>('looks', ['importLut', 'searchImages', 'useImage', 'openCredit']),
  media: { url: (absPath) => `${MEDIA_SCHEME}://local/${encodeURIComponent(absPath)}` },
};

contextBridge.exposeInMainWorld('cutawayBridge', api);
