/**
 * The contract between the Electron main process and the renderer.
 * `window.cutaway` implements CutawayApi (see preload). Nothing else crosses
 * the boundary: the renderer has no Node access.
 */
import type { CorrelationResult, CursorSample, Project, Range, SensitiveHit } from '@cutaway/core';
import type { ImageCredit, LutRef } from '@cutaway/core';

export type Permission = 'granted' | 'denied' | 'undetermined';
export type PermissionKind = 'screen' | 'camera' | 'microphone';
/** Extra permissions some optional features need. Never requested automatically. */
export type ExtraPermission = 'accessibility' | 'inputMonitoring';

export interface DisplayInfo { id: number; name: string; width: number; height: number; scale: number; x: number; y: number; main: boolean }
export interface WindowInfo { id: number; title: string; app: string; bundleId: string; x: number; y: number; width: number; height: number; displayId: number }
export interface CameraInfo { id: string; name: string; /** 'iphone' = Continuity Camera (wireless or USB). */ kind?: 'builtin' | 'external' | 'iphone' | 'deskview'; formats: { width: number; height: number; maxFps: number }[] }
export interface MicInfo { id: string; name: string; default?: boolean }

export interface DeviceList {
  permissions: Record<PermissionKind, Permission> & Partial<Record<ExtraPermission, Permission>>;
  /** USB iPhone / iPad screens that can be recorded as the screen source. */
  externalDevices?: { id: string; name: string; width: number; height: number; kind?: 'iphone' | 'ipad' | null }[];
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
    /** For type 'window': margins in points to leave out, such as a browser's tab strip and toolbar. */
    crop?: WindowInsets;
    /** For type 'device': a connected iPhone or iPad. */
    deviceId?: string;
    rect?: { x: number; y: number; width: number; height: number };
    showCursor: boolean;
    maxHeight?: number;
    /** Leave Finder's desktop icons out of the capture (nothing on the Mac is changed). */
    hideDesktopIcons?: boolean;
    /** Leave notification banners out of the capture. */
    hideNotifications?: boolean;
    /**
     * Recording a demo of Cutaway: its main window, menus and dialogs are in the picture; the recording
     * controls, teleprompter, countdown and camera bubble are not.
     */
    includeCutaway?: boolean;
  } | null;
  cameras: { slot: 'A' | 'B'; deviceId: string; width: number; height: number; fps: number }[];
  microphone?: { deviceId: string } | null;
  /** true = everything the Mac plays; a list = only those apps. */
  systemAudio: boolean | { apps: string[] };
  /** Record pressed shortcuts and typing activity (never the typed characters). Needs Input Monitoring. */
  captureKeys?: boolean;
  /** Test mode: generated pictures and tones, no permissions needed. */
  synthetic?: boolean;
  /** Small live stills of each camera on the preview channel, for the self-view bubble. */
  cameraPreview?: { fps: number; width: number };
}

export interface WindowInsets { top: number; left: number; bottom: number; right: number }

/** One tab of a running browser, as offered in the recorder. Only the title and host name are ever read. */
export interface BrowserTab {
  /** 1-based positions inside the browser, as AppleScript counts them. */
  window: number;
  tab: number;
  active: boolean;
  title: string;
  host: string;
  /** Absent when the window is minimised or on another desktop. */
  windowId?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserInfo {
  bundleId: string;
  name: string;
  pid: number;
  /** Whether Cutaway may ask this browser for its tabs (macOS Automation permission). */
  permission: 'granted' | 'denied' | 'undetermined' | 'not-running' | 'unknown';
  error?: string;
  tabs: BrowserTab[];
}

export interface BrowserTabList { accessibility: 'granted' | 'denied'; browsers: BrowserInfo[] }

/** The page area inside a browser window: measured through Accessibility, or estimated without it. */
export interface PageArea extends WindowInsets { method: 'accessibility' | 'estimate' }

export interface BrowserTabTarget {
  bundleId?: string;
  window?: number;
  tab?: number;
  windowId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  content: PageArea;
  accessibility: 'granted' | 'denied';
}

/** What the countdown overlay shows: a rectangle in global screen points, and the number. */
export interface CountdownState {
  /** The display, window or area about to be recorded. */
  rect: { x: number; y: number; width: number; height: number };
  /** 'display' outlines the whole screen; the others dim everything around the rectangle. */
  kind: 'display' | 'window' | 'region';
  label: string;
  count: number;
}

/** A camera still for the self-view bubble while a take is being recorded. */
export interface PreviewFrame { source: string; width: number; height: number; jpeg: string }

export interface SelfViewPrefs { x?: number; y?: number; size?: number; shape?: CamShape; hidden?: boolean }
/** The camera's shape: the same in the floating bubble, on the record screen and in the video. */
export type CamShape = 'circle' | 'rounded' | 'square';

export interface ControlStatus {
  enabled: boolean;
  running: boolean;
  /** How to start the MCP server: the command and its arguments (this app's own runtime and script). */
  command: string;
  args: string[];
  /** Whether each tool already lists the cutaway server (null = that tool is not installed). */
  claude: boolean | null;
  codex: boolean | null;
}

/** Where the teleprompter window was last put. */
export interface PrompterBounds { x: number; y: number; width: number; height: number }
/** Quick places for the teleprompter. "top" sits just under the built-in camera, for eye contact. */
export type PrompterPlace = 'top' | 'left' | 'right' | 'bottom' | 'camera';

export interface PreflightResult {
  ok: boolean;
  issues: { code: string; source?: string; message: string; alternatives?: string[]; /** false = a warning; recording can still start. */ blocking?: boolean }[];
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
  /** Moments the creator flagged during the take, in take seconds. */
  flags?: number[];
}

export type RecordEvent =
  | { type: 'ready' }
  | { type: 'started'; at: string; sources: { id: string; file: string }[] }
  | { type: 'tick'; elapsed: number; frames: Record<string, number>; dropped: Record<string, number>; freeBytes: number }
  | { type: 'levels'; microphone?: number; system?: number }
  | { type: 'paused'; elapsed: number }
  | { type: 'resumed'; elapsed: number }
  /** The creator flagged this moment (global shortcut or the controller's flag button). */
  | { type: 'flag'; elapsed: number; count: number }
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

/** Result of scanning part of a screen recording for sensitive content. Times are source seconds; boxes are normalised to the frame. */
export interface SensitiveScan {
  interval: number;
  start: number;
  end: number;
  duration: number;
  frames: { t: number; hits: SensitiveHit[] }[];
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
  /** Pixel size of a still image. */
  image?: { width: number; height: number } | null;
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
  /** Let AI tools (Claude Code or Codex, through cutaway-mcp) control Cutaway on this Mac. On unless turned off. */
  aiControl?: boolean;
  libraryDir: string;
  exportDir: string;
  countdownSeconds: number;
  /** Set once macOS has been asked for Screen Recording access (it cannot tell "never asked" from "off"). */
  screenAccessAsked?: boolean;
  /** Where the floating camera bubble sits while recording, and whether it is shown. */
  selfView?: SelfViewPrefs;
  prompter?: PrompterBounds;
  /** null = find `claude` on PATH. */
  claudePath: string | null;
  claudeModel: string;
  /** Which AI app to use. 'auto' (default) = the first one that is signed in, Claude Code first. */
  aiProvider?: 'auto' | AiProviderId;
  /** null = find `codex` on PATH. */
  codexPath?: string | null;
  /** Passed to Codex as --model. Empty = Codex's own default. */
  codexModel?: string;
  transcription: { engine: 'auto' | 'apple' | 'whisper'; whisperModelPath: string | null; locale: string };
  reduceMotion: boolean;
  transcriptTextSize: number;
  importMode: 'copy' | 'reference';
  presets: StylePreset[];
  defaultPresetId: string | null;
  /** Unsplash access key for the background photo search. Kept in settings only; never written to a project. */
  unsplashKey: string | null;
  /** The creator's own notes added to the editing, title and thumbnail playbooks (each capped). */
  playbookNotes?: { editing?: string | null; titles?: string | null; thumbnails?: string | null };
  /** Changed keyboard shortcuts: command id → combo ('' = none). See shared/keymap.ts. */
  shortcuts?: Record<string, string>;
  analytics: false;
}

/** One photo from the background image search. `thumb` is a data URL fetched by the main process. */
export interface ImageSearchPhoto {
  id: string;
  thumb: string;
  width: number;
  height: number;
  color: string;
  description: string;
  author: string;
  authorUrl: string;
  pageUrl: string;
}

export interface ImageSearchResult {
  photos: ImageSearchPhoto[];
  page: number;
  totalPages: number;
}

export type AiProviderId = 'claude' | 'codex';

/**
 * State of one AI command-line app on this Mac. `ai.status()` returns the one
 * Cutaway would use (see `aiProvider` in settings), with `provider` set; the
 * type keeps its first name because the app began with Claude Code only.
 */
export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  /** null = not checked yet. */
  signedIn: boolean | null;
  message: string;
  /** Which app this describes. Absent on values made before a check. */
  provider?: AiProviderId;
}

/** Both providers, the creator's choice and the one that would be used now. */
export interface AiProviders {
  choice: 'auto' | AiProviderId;
  active: AiProviderId;
  claude: ClaudeStatus;
  codex: ClaudeStatus;
}

/** One generated picture for a thumbnail. Codex only. */
export interface AiImageRequest {
  id: string;
  projectPath: string;
  /** The whole instruction, built by `buildArtPrompt`. */
  prompt: string;
  /** Up to two stills for context. Must live inside the project cache dir. */
  referencePaths: string[];
}

export interface AiImageResult {
  ok: boolean;
  /** Project-relative path of the saved picture (media/generated/…). */
  path?: string;
  /** The model's one-line description of what it made. */
  note?: string;
  provider: AiProviderId;
  error?: AiResult['error'];
  durationMs: number;
}

export interface AiRequest {
  id: string;
  /** Short label for progress UI and logs. Never contains project content. */
  purpose: 'first-cut' | 'local-revision' | 'packaging' | 'motion';
  prompt: string;
  /** JSON Schema the reply must satisfy. */
  schema: Record<string, unknown>;
  /** Still frames the model may look at. Must live inside the project cache dir. */
  imagePaths: string[];
  /** Directory the images are in; the only place the model may read. */
  imageDir: string | null;
  /** Send `ai.onProgress` events while the reply is written (Claude only). */
  progress?: boolean;
}

/** How far along a reply is: characters of the answer written so far. */
export interface AiProgress {
  id: string;
  /** Characters of the answer written so far. */
  chars: number;
  /** Characters of thinking so far (0 = not thinking, or a provider that does not say). */
  thinking?: number;
  /** How many of each edit (`cut`, `zoom`, …) the answer has written so far. */
  ops?: Record<string, number>;
}

export interface AiResult {
  ok: boolean;
  data?: unknown;
  error?: { code: 'not-found' | 'not-signed-in' | 'cancelled' | 'timeout' | 'bad-output' | 'failed'; message: string };
  durationMs: number;
  costUsd?: number | null;
  model?: string | null;
  /** The app that answered. */
  provider?: AiProviderId;
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


// ───────────────────────────── animations ─────────────────────────────

export interface MotionRenderRequest {
  /** Project-relative page (media/motion/…html). */
  file: string;
  fields: Record<string, string>;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Echoed in progress events, so the caller can tell its renders apart. */
  tag?: string;
}

export interface MotionRenderResult {
  /** Identifies these frames: same page, fields, size, rate and length give the same key. */
  key: string;
  /** Absolute folder holding f00000.png … */
  dir: string;
  count: number;
  fps: number;
  width: number;
  height: number;
}

export interface MotionCheck {
  ok: boolean;
  /** What is wrong, in sentences that can be handed back to the model to fix. */
  errors: string[];
  meta: import('@cutaway/core').MotionMeta | null;
  /** Three small PNG stills (data URLs): early, middle, end. */
  stills: string[];
}

// ───────────────────────────── media generation ─────────────────────────────

/** Whose account makes it: the creator's own ElevenLabs or fal.ai key. */
export type GenProvider = 'elevenlabs' | 'fal';
export type GenKind = 'voice' | 'music' | 'sound' | 'image' | 'video';
/** The fal.ai model id used for each kind. */
export type GenModels = Record<GenKind, string>;

export interface GenRequest {
  /** Chosen by the caller, so the request can be followed (gen:status) and stopped. */
  jobId: string;
  provider: GenProvider;
  kind: GenKind;
  /** What to say (voice) or a description of what to make. */
  prompt: string;
  /** Voice id (ElevenLabs) or voice name (fal.ai). */
  voiceId?: string;
  /** Wanted length, for music, sound effects and video. */
  seconds?: number;
  /** Music only: no singing. */
  instrumental?: boolean;
  /** Images and video. */
  aspect?: '16:9' | '9:16' | '1:1';
  /** Video only, fal.ai: 360p keeps it cheap. */
  resolution?: '360p' | '540p' | '720p' | '1080p';
  /** fal.ai: a model other than the one chosen in Settings. */
  model?: string;
  /**
   * Images only, fal.ai: pictures to work from (absolute paths inside the project or Cutaway's own folder), such as a
   * photo of the creator. With them the request goes to an image-editing model that keeps faces.
   */
  referencePaths?: string[];
}

export interface GenResult {
  /** Project-relative path of the file that was made (media/generated/…). */
  path: string;
  provider: GenProvider;
  model: string;
}

export interface GenKeyStatus {
  elevenlabs: { set: boolean; hint: string | null };
  fal: { set: boolean; hint: string | null };
  models: GenModels;
  defaults: GenModels;
  can: Record<GenProvider, GenKind[]>;
}

export interface GenVoice {
  id: string;
  name: string;
  description: string | null;
  previewUrl: string | null;
}

export interface CutawayApi {
  app: {
    info(): Promise<{ packaged: boolean; version: string; libraryDir: string; exportDir: string; arch: string; os: string; nativeHelper: boolean }>;
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
    /** Quit and reopen the app (after a permission change macOS only applies on relaunch). */
    relaunch(): Promise<void>;
    /** Thumbnails of displays and windows for the source picker. Empty without screen permission. */
    captureThumbnails(): Promise<{ kind: 'display' | 'window'; id: number; displayId: number | null; name: string; dataUrl: string }[]>;
    /** Minimise the main window and show the floating recording controller (or undo that). `cameras` lists the camera sources of the take, for the self-view bubble. */
    /** `keepWindow`: leave Cutaway's main window up (recording a demo of Cutaway) instead of minimising it. */
    recordingMode(on: boolean, opts?: { cameras?: string[]; keepWindow?: boolean }): Promise<void>;
    /** Show or update the countdown over the thing about to be recorded. */
    countdown(state: CountdownState): Promise<void>;
    /** Take the countdown overlay down. `cancelled` brings the Cutaway window back. Resolves once the overlay is gone. */
    countdownEnd(cancelled: boolean): Promise<void>;
    /** Overlay window only: the state to draw. */
    onCountdown(cb: (state: CountdownState & { bounds: { x: number; y: number; width: number; height: number } }) => void): () => void;
    /** Escape was pressed while the countdown overlay was up. */
    onCountdownCancel(cb: () => void): () => void;
    /** Show, hide or toggle the floating camera bubble during a take. Resolves to whether it is now visible. */
    selfView(show: boolean | 'toggle'): Promise<boolean>;
    /** The camera bubble was shown or hidden (controller and bubble windows). */
    onSelfView(cb: (state: { visible: boolean; cameras: string[] }) => void): () => void;
    /** Put a file on the clipboard so it can be pasted into another app. */
    copyFile(path: string): Promise<void>;
    /** Ask where to save, then copy a finished file there. Resolves to the chosen path, or null if cancelled. */
    saveCopyAs(sourcePath: string, suggestedName: string): Promise<string | null>;
    /** Floating teleprompter window, left out of the recording. `'toggle'` flips it. */
    notesWindow(show: boolean | 'toggle'): Promise<void>;
    /** Move the teleprompter to one of its quick places. False when that place is not available (no camera bubble). */
    prompterPlace(place: PrompterPlace): Promise<boolean>;
    /** The teleprompter was shown or hidden (also sent to the recording controller). */
    onPrompter(cb: (state: { visible: boolean }) => void): () => void;
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
    frames(projectPath: string, file: string, times: number[], width: number, together?: boolean): Promise<{ t: number; path: string }[]>;
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
    /** Tabs of the running browsers. `ask` names one browser to request macOS Automation permission for (shows the system prompt). */
    browserTabs(ask?: string): Promise<BrowserTabList>;
    /** Bring a tab to the front of its window (`raise` also brings the window and browser forward) and measure the page area. */
    selectBrowserTab(bundleId: string, window: number, tab: number, raise: boolean): Promise<BrowserTabTarget>;
    /** Re-measure the page area of a browser window. */
    browserContent(bundleId: string, windowId: number): Promise<BrowserTabTarget>;
    voices(): Promise<VoiceInfo[]>;
    /** Synthesise narration on this Mac into the project's media folder. Returns a project-relative path. */
    speak(projectPath: string, text: string, voiceId: string, rate?: number): Promise<{ path: string; duration: number }>;
    /** Delete one synthesised narration file from the project's voiceover folder. */
    removeVoiceover(projectPath: string, relPath: string): Promise<void>;
    /** Save a voiceover recorded from the microphone (WAV bytes) into the project's voiceover folder. Returns a project-relative path. */
    saveRecording(projectPath: string, wav: Uint8Array): Promise<{ path: string }>;
    /** Look for emails, keys, card numbers, passwords and phone numbers on sampled frames of a screen recording. On this Mac only; the recognised text is discarded, only categories and boxes come back. */
    sensitive(file: string, start: number, end: number, interval: number): Promise<SensitiveScan>;
  };
  record: {
    /** Starts the helper. The take is written inside the project bundle. */
    start(projectPath: string, config: RecordConfig): Promise<{ takeDir: string }>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    /** Mark the current moment of the take. */
    flag(): Promise<void>;
    stop(): Promise<TakeManifest>;
    cancel(): Promise<void>;
    onEvent(cb: (e: RecordEvent) => void): () => void;
    /** Camera stills from the take being recorded (self-view bubble only). */
    onPreview(cb: (frame: PreviewFrame) => void): () => void;
  };
  /** Animations: saved in the project, checked and rendered to transparent frames in a locked-down hidden window. */
  motion: {
    save(projectPath: string, html: string, name: string): Promise<{ file: string; meta: import('@cutaway/core').MotionMeta | null; problems: string[] }>;
    read(projectPath: string, file: string): Promise<string>;
    check(html: string, fields: Record<string, string> | null, width: number, height: number): Promise<MotionCheck>;
    /** A URL (own origin, locked down) of a looping preview of a page. */
    preview(html: string, fields: Record<string, string>, duration: number): Promise<string>;
    /** The creator's own saved templates (kept with the app, for every project). */
    templates(): Promise<{ id: string; html: string }[]>;
    saveTemplate(html: string, name: string): Promise<{ id: string }>;
    removeTemplate(id: string): Promise<void>;
    render(projectPath: string, req: MotionRenderRequest): Promise<MotionRenderResult>;
    onProgress(cb: (p: { key: string; done: number; total: number }) => void): () => void;
  };
  /** Media generation with the creator's own keys. Keys never come back to the window: only whether one is set. */
  /** AI tools controlling Cutaway (cutaway-mcp). */
  control: {
    status(): Promise<ControlStatus>;
    setEnabled(on: boolean): Promise<ControlStatus>;
    /** Register the cutaway MCP server with Claude Code or Codex (runs their own `mcp add` command). */
    connect(tool: 'claude' | 'codex'): Promise<{ ok: boolean; message: string }>;
    /** A command arrived from an AI tool; answer with `respond`. */
    onCall(cb: (call: { id: string; method: string; params: Record<string, unknown> }) => void): () => void;
    respond(r: { id: string; ok: boolean; result?: unknown; error?: string }): void;
  };
  gen: {
    status(): Promise<GenKeyStatus>;
    setKey(provider: GenProvider, key: string | null): Promise<GenKeyStatus>;
    setModels(patch: Partial<GenModels>): Promise<GenKeyStatus>;
    /** Checks a key works without spending credits. */
    testKey(provider: GenProvider): Promise<{ ok: boolean; message: string }>;
    voices(provider: GenProvider): Promise<GenVoice[]>;
    generate(projectPath: string, req: GenRequest): Promise<GenResult>;
    cancel(jobId: string): Promise<void>;
    /** Delete a generated file that was not added to the project. */
    discard(projectPath: string, relPath: string): Promise<void>;
    onStatus(cb: (s: { jobId: string; text: string }) => void): () => void;
  };
  ai: {
    /** The provider Cutaway would use now. */
    status(force?: boolean): Promise<ClaudeStatus>;
    /** Both providers and which one is in use. */
    providers(force?: boolean): Promise<AiProviders>;
    /** Open Terminal on the provider's own sign-in command; the creator signs in there. Default: the provider in use. */
    signIn(provider?: AiProviderId): Promise<{ ok: boolean; message: string }>;
    /** One structured request, sent through the provider in use. */
    run(req: AiRequest): Promise<AiResult>;
    cancel(id: string): Promise<void>;
    /** Hear replies being written, for requests sent with `progress`. */
    onProgress(cb: (p: AiProgress) => void): () => void;
    /** Make one thumbnail picture and save it in the project (Codex only). Cancel with `cancel(id)`. */
    generateImage(req: AiImageRequest): Promise<AiImageResult>;
    /** Delete a generated picture that is no longer used. Only files in media/generated/ are touched. */
    removeImage(projectPath: string, relPath: string): Promise<void>;
    /** The creator's saved photo for thumbnails (absolute path), or null to use frames from the video. */
    photo(): Promise<string | null>;
    /** Save a copy of this photo for thumbnails, or forget it (null). Returns the saved copy's path. */
    setPhoto(from: string | null): Promise<string | null>;
  };
  /** Look assets kept inside the project folder: colour LUTs and downloaded background photos. */
  looks: {
    /** Validate a .cube file and copy it into the project. `file` null opens a file picker; resolves null when cancelled. */
    importLut(projectPath: string, file: string | null): Promise<LutRef | null>;
    /** Search Unsplash with the access key from Settings. Errors carry a code: no-key, bad-key, rate-limit, offline. */
    searchImages(query: string, page: number): Promise<ImageSearchResult>;
    /** Download a photo from a recent search into the project folder. */
    useImage(projectPath: string, id: string): Promise<{ path: string; credit: ImageCredit }>;
    /** Open a photo or photographer page on unsplash.com. */
    openCredit(url: string): Promise<void>;
  };
  export: {
    existingFolders(destDir: string): Promise<string[]>;
    begin(destDir: string, folderName: string): Promise<ExportSession>;
    /** Random-access write into a file of the working folder (video muxer output). */
    write(sessionId: string, name: string, position: number, data: Uint8Array): Promise<void>;
    writeFile(sessionId: string, name: string, data: Uint8Array | string): Promise<{ bytes: number }>;
    /** Mux/tag the final video with the native helper. */
    mux(sessionId: string, video: string, audio: string | null, out: string, codec?: 'h264' | 'prores422'): Promise<{ bytes: number; duration: number }>;
    stat(sessionId: string, name: string): Promise<{ bytes: number } | null>;
    /** Animated GIF from a video already in the session folder. */
    gif(sessionId: string, video: string, out: string, opts: { fps: number; width: number }): Promise<{ bytes: number; frames: number }>;
    /** Moves the working folder into place. Refuses to overwrite. */
    commit(sessionId: string, keep: string[]): Promise<{ folder: string; files: { name: string; bytes: number }[] }>;
    /** Keeps partial files in a clearly marked "-partial" folder, or removes them. */
    abort(sessionId: string, keepPartial: boolean): Promise<{ folder: string | null }>;
    /** Save dialog for a single exported file. `replace` is true when the creator chose an existing file and agreed to replace it. */
    pickFile(defaultDir: string, defaultName: string): Promise<{ path: string; replace: boolean } | null>;
    /** A path in `dir` for `fileName` that is not taken yet (name.mp4, name-2.mp4, …). */
    freeFilePath(dir: string, fileName: string): Promise<string>;
    /** Start an export that ends in one file at `filePath`, assembled in a hidden working folder beside it. */
    beginFile(filePath: string): Promise<ExportSession>;
    /** Moves the finished file to the session's path and removes the working folder. Replaces an existing file only when `replace` is set. */
    commitFile(sessionId: string, name: string, replace?: boolean): Promise<{ path: string; bytes: number }>;
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
