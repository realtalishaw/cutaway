/**
 * The contract between the Electron main process and the renderer.
 * `window.cutaway` implements CutawayApi (see preload). Nothing else crosses
 * the boundary: the renderer has no Node access.
 */
import type { CorrelationResult, CursorSample, Project, Range } from '@cutaway/core';

export type Permission = 'granted' | 'denied' | 'undetermined';
export type PermissionKind = 'screen' | 'camera' | 'microphone';
/** Extra permissions some optional features need. Never requested automatically. */
export type ExtraPermission = 'accessibility' | 'inputMonitoring';

export interface DisplayInfo { id: number; name: string; width: number; height: number; scale: number; x: number; y: number; main: boolean }
export interface WindowInfo { id: number; title: string; app: string; bundleId: string; x: number; y: number; width: number; height: number; displayId: number }
export interface CameraInfo { id: string; name: string; formats: { width: number; height: number; maxFps: number }[] }
export interface MicInfo { id: string; name: string; default?: boolean }

export interface DeviceList {
  permissions: Record<PermissionKind, Permission> & Partial<Record<ExtraPermission, Permission>>;
  /** USB iPhone / iPad screens that can be recorded as the screen source. */
  externalDevices?: { id: string; name: string; width: number; height: number }[];
  /** Running apps, for recording audio from selected apps only. */
  apps?: { bundleId: string; name: string; pid: number }[];
  displays: DisplayInfo[];
  windows: WindowInfo[];
  cameras: CameraInfo[];
  microphones: MicInfo[];
}

/** Mirrors docs/NATIVE_PROTOCOL.md `record` config, minus outDir (main chooses it). */
export interface RecordConfig {
  fps: number;
  screen?: {
    type: 'display' | 'window' | 'region' | 'device';
    displayId?: number;
    windowId?: number;
    /** For type 'device': a connected iPhone or iPad. */
    deviceId?: string;
    rect?: { x: number; y: number; width: number; height: number };
    showCursor: boolean;
    maxHeight?: number;
    /** Leave Finder's desktop icons out of the capture (nothing on the Mac is changed). */
    hideDesktopIcons?: boolean;
    /** Leave notification banners out of the capture. */
    hideNotifications?: boolean;
  } | null;
  cameras: { slot: 'A' | 'B'; deviceId: string; width: number; height: number; fps: number }[];
  microphone?: { deviceId: string } | null;
  /** true = everything the Mac plays; a list = only those apps. */
  systemAudio: boolean | { apps: string[] };
  /** Record pressed shortcuts and typing activity (never the typed characters). Needs Input Monitoring. */
  captureKeys?: boolean;
  /** Test mode: generated pictures and tones, no permissions needed. */
  synthetic?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  issues: { code: string; source?: string; message: string; alternatives?: string[] }[];
  estimatedBytesPerMinute: number;
  freeBytes: number;
}

export interface TakeSource {
  id: 'screen' | 'cameraA' | 'cameraB' | 'microphone' | 'system';
  role: 'screen' | 'cameraA' | 'cameraB' | 'voice' | 'systemAudio';
  file: string;
  start: number;
  duration: number;
  width?: number;
  height?: number;
  pointWidth?: number;
  pointHeight?: number;
  fps?: number;
  cursorBaked?: boolean;
  deviceKind?: 'iphone' | 'ipad' | null;
  channels?: number;
  sampleRate?: number;
  deviceName?: string;
  gaps: { start: number; end: number; reason: string }[];
}

export interface TakeManifest {
  version: 1;
  takeId: string;
  startedAt: string;
  duration: number;
  fps: number;
  complete: boolean;
  recovered: boolean;
  pauses: { at: number; wallDuration: number }[];
  sources: TakeSource[];
  cursor?: { file: string; samples: number } | null;
  keys?: { file: string; events: number } | null;
}

export type RecordEvent =
  | { type: 'ready' }
  | { type: 'started'; at: string; sources: { id: string; file: string }[] }
  | { type: 'tick'; elapsed: number; frames: Record<string, number>; dropped: Record<string, number>; freeBytes: number }
  | { type: 'levels'; microphone?: number; system?: number }
  | { type: 'paused'; elapsed: number }
  | { type: 'resumed'; elapsed: number }
  | { type: 'checkpoint'; elapsed: number }
  | { type: 'source-lost'; source: string; elapsed: number; reason: string }
  | { type: 'source-restored'; source: string; elapsed: number }
  | { type: 'disk-low'; freeBytes: number }
  | { type: 'error'; code: string; message: string; source?: string; fatal: boolean }
  | { type: 'stopped'; manifest: TakeManifest }
  /** Synthesised by main when the helper process dies without a `stopped` event. */
  | { type: 'crashed'; takeDir: string; message: string };

/** Keyboard telemetry. Typed characters are never recorded: only shortcuts and anonymous typing ticks. */
export type KeyEvent = { t: number; e: 'shortcut'; keys: string[] } | { t: number; e: 'type' };

export interface FaceTrack {
  fps: number;
  samples: ({ t: number; x: number; y: number; w: number; h: number } | { t: number; none: true })[];
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  quality: string;
}

export interface ProbeResult {
  path: string;
  ok: boolean;
  kind?: 'video' | 'audio' | 'image';
  duration?: number;
  sizeBytes?: number;
  video?: { width: number; height: number; fps: number; variableFrameRate: boolean; codec: string; rotation: number; colorPrimaries?: string | null; hdr: boolean } | null;
  audio?: { channels: number; sampleRate: number; codec: string } | null;
  createdAt?: string | null;
  error?: { code: 'corrupt' | 'unsupported-codec' | 'protected' | 'not-found' | string; message: string } | null;
}

export interface TranscribeResult {
  engine: string;
  locale: string;
  onDevice: boolean;
  hasSpeech: boolean;
  words: { text: string; start: number; end: number; confidence?: number }[];
}

export interface VoiceAnalysis {
  silences: Range[];
  waveform: number[];
  waveformHz: number;
  hasSignal: boolean;
  duration: number;
  /** 95th percentile RMS in dBFS; null when the track is silent. */
  levelDb: number | null;
}

export interface ProjectSummary {
  path: string;
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  duration: number;
  outDuration: number;
  sourceRoles: string[];
  hasFirstCut: boolean;
  exported: boolean;
  missingSources: number;
  /** cutaway-media URL of the poster frame, if one was saved. */
  poster: string | null;
  sizeBytes: number;
}

export interface RecoverableTake {
  projectPath: string | null;
  takeDir: string;
  startedAt: string | null;
  sizeBytes: number;
}

export interface StylePreset {
  id: string;
  name: string;
  createdAt: string;
  appearance: Project['edit']['appearance'];
  brief: Pick<Project['brief'], 'pacing' | 'visualIntensity'>;
}

export interface AppSettings {
  libraryDir: string;
  exportDir: string;
  countdownSeconds: number;
  /** null = find `claude` on PATH. */
  claudePath: string | null;
  claudeModel: string;
  transcription: { engine: 'auto' | 'apple' | 'whisper'; whisperModelPath: string | null; locale: string };
  reduceMotion: boolean;
  transcriptTextSize: number;
  importMode: 'copy' | 'reference';
  presets: StylePreset[];
  defaultPresetId: string | null;
  analytics: false;
}

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  /** null = not checked yet. */
  signedIn: boolean | null;
  message: string;
}

export interface AiRequest {
  id: string;
  /** Short label for progress UI and logs. Never contains project content. */
  purpose: 'first-cut' | 'local-revision' | 'packaging';
  prompt: string;
  /** JSON Schema the reply must satisfy. */
  schema: Record<string, unknown>;
  /** Still frames the model may look at. Must live inside the project cache dir. */
  imagePaths: string[];
  /** Directory the images are in; the only place the model may read. */
  imageDir: string | null;
}

export interface AiResult {
  ok: boolean;
  data?: unknown;
  error?: { code: 'not-found' | 'not-signed-in' | 'cancelled' | 'timeout' | 'bad-output' | 'failed'; message: string };
  durationMs: number;
  costUsd?: number | null;
  model?: string | null;
}

export interface ExportSession {
  id: string;
  /** Final folder (does not exist until commit). */
  folder: string;
  /** Hidden working folder next to it; removed on commit/abort. */
  workDir: string;
}

export interface CacheInfo {
  bytes: number;
  files: number;
}

export interface CutawayApi {
  app: {
    info(): Promise<{ version: string; libraryDir: string; exportDir: string; arch: string; os: string; nativeHelper: boolean }>;
    getSettings(): Promise<AppSettings>;
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
    pickFiles(opts: { title: string; kinds: ('video' | 'audio' | 'image' | 'model')[]; multiple: boolean }): Promise<string[]>;
    pickFolder(title: string, defaultPath?: string): Promise<string | null>;
    reveal(path: string): Promise<void>;
    openPath(path: string): Promise<void>;
    freeBytes(path: string): Promise<number | null>;
    permission(kind: PermissionKind): Promise<Permission>;
    requestPermission(kind: PermissionKind): Promise<Permission>;
    openPrivacySettings(kind: PermissionKind): Promise<void>;
    /** Thumbnails of displays and windows for the source picker. Empty without screen permission. */
    captureThumbnails(): Promise<{ kind: 'display' | 'window'; id: number; displayId: number | null; name: string; dataUrl: string }[]>;
    /** Minimise the main window and show the floating recording controller (or undo that). */
    recordingMode(on: boolean): Promise<void>;
    /** Put a file on the clipboard so it can be pasted into another app. */
    copyFile(path: string): Promise<void>;
    /** Floating speaker-notes window, left out of the recording. */
    notesWindow(show: boolean): Promise<void>;
    /** Application menu commands (undo, redo, save, record, import, …). */
    onMenu(cb: (command: string) => void): () => void;
    /** Absolute paths of files dropped onto the window. */
    pathForFile(file: File): string;
  };
  library: {
    list(): Promise<ProjectSummary[]>;
    create(name: string): Promise<{ path: string; project: Project }>;
    open(path: string): Promise<{ path: string; project: Project; missing: string[] }>;
    /** Atomic write; resolves once the file is durably on disk. */
    save(path: string, project: Project): Promise<{ savedAt: string }>;
    rename(path: string, name: string): Promise<{ path: string }>;
    /** Moves the project bundle to the Trash. External originals are never touched. */
    trash(path: string): Promise<void>;
    savePoster(path: string, jpeg: Uint8Array): Promise<void>;
    /** Copy (or reference) files into a project and probe them. */
    importMedia(projectPath: string, files: string[], mode: 'copy' | 'reference'): Promise<ProbeResult[]>;
    recoverable(): Promise<RecoverableTake[]>;
    recover(takeDir: string): Promise<TakeManifest>;
    discardTake(takeDir: string): Promise<void>;
    cacheInfo(projectPath: string): Promise<CacheInfo>;
    clearCache(projectPath: string): Promise<CacheInfo>;
    exists(path: string): Promise<boolean>;
    /** Self-contained copy of a project (with its referenced media gathered inside) as a zip, for handing to someone else. */
    exportBundle(projectPath: string, destDir: string): Promise<{ path: string; bytes: number }>;
  };
  native: {
    devices(): Promise<DeviceList>;
    preflight(config: RecordConfig): Promise<PreflightResult>;
    probe(paths: string[]): Promise<ProbeResult[]>;
    /** Stills written into the project's cache; returns absolute paths. */
    frames(projectPath: string, file: string, times: number[], width: number): Promise<{ t: number; path: string }[]>;
    activity(file: string): Promise<{ fps: number; samples: { t: number; change: number }[] }>;
    transcribe(file: string, locale: string): Promise<TranscribeResult>;
    analyzeVoice(file: string): Promise<VoiceAnalysis>;
    correlate(refFile: string, otherFile: string, maxOffset: number): Promise<CorrelationResult>;
    readCursor(file: string): Promise<CursorSample[]>;
    readKeys(file: string): Promise<KeyEvent[]>;
    /** Largest face per sampled frame (on-device Vision). Cached per file in the project. */
    faces(projectPath: string, file: string): Promise<FaceTrack>;
    /** Person-segmentation matte video for camera cutout, written to the project cache. */
    matte(projectPath: string, file: string): Promise<{ path: string; duration: number; frames: number; width: number; height: number }>;
    resizeWindow(windowId: number, width: number, height: number): Promise<void>;
    voices(): Promise<VoiceInfo[]>;
    /** Synthesise narration on this Mac into the project's media folder. Returns a project-relative path. */
    speak(projectPath: string, text: string, voiceId: string, rate?: number): Promise<{ path: string; duration: number }>;
  };
  record: {
    /** Starts the helper. The take is written inside the project bundle. */
    start(projectPath: string, config: RecordConfig): Promise<{ takeDir: string }>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<TakeManifest>;
    cancel(): Promise<void>;
    onEvent(cb: (e: RecordEvent) => void): () => void;
  };
  ai: {
    status(force?: boolean): Promise<ClaudeStatus>;
    run(req: AiRequest): Promise<AiResult>;
    cancel(id: string): Promise<void>;
  };
  export: {
    existingFolders(destDir: string): Promise<string[]>;
    begin(destDir: string, folderName: string): Promise<ExportSession>;
    /** Random-access write into a file of the working folder (video muxer output). */
    write(sessionId: string, name: string, position: number, data: Uint8Array): Promise<void>;
    writeFile(sessionId: string, name: string, data: Uint8Array | string): Promise<{ bytes: number }>;
    /** Mux/tag the final video with the native helper. */
    mux(sessionId: string, video: string, audio: string | null, out: string): Promise<{ bytes: number; duration: number }>;
    stat(sessionId: string, name: string): Promise<{ bytes: number } | null>;
    /** Animated GIF from a video already in the session folder. */
    gif(sessionId: string, video: string, out: string, opts: { fps: number; width: number }): Promise<{ bytes: number; frames: number }>;
    /** Moves the working folder into place. Refuses to overwrite. */
    commit(sessionId: string, keep: string[]): Promise<{ folder: string; files: { name: string; bytes: number }[] }>;
    /** Keeps partial files in a clearly marked "-partial" folder, or removes them. */
    abort(sessionId: string, keepPartial: boolean): Promise<{ folder: string | null }>;
  };
  media: {
    /** URL the renderer can load for a local file (range requests supported). */
    url(absPath: string): string;
  };
}

export const MEDIA_SCHEME = 'cutaway-media';

export function mediaUrl(absPath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absPath)}`;
}

/** Resolve a source path that may be relative to the project bundle. */
export function resolveSourcePath(projectPath: string, sourcePath: string): string {
  return sourcePath.startsWith('/') ? sourcePath : `${projectPath}/${sourcePath}`;
}

declare global {
  interface Window {
    cutaway: CutawayApi;
  }
}
