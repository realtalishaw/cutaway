/**
 * Cutaway project model.
 *
 * Time axes
 *  - session time: the shared clock of a project. Every source is placed on it
 *    through SourceSync, so "12.4s" means the same instant for screen, cameras
 *    and voice. All edit decisions are stored in session time so they stay
 *    attached to content when other cuts change.
 *  - source time: seconds inside one media file.
 *  - output time: seconds in the finished video, derived by TimeMap from cuts
 *    and speed ranges. Never stored.
 */
export type Seconds = number;

export interface Range {
  start: Seconds;
  end: Seconds;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ───────────────────────────── sources ─────────────────────────────

export type SourceRole = 'screen' | 'cameraA' | 'cameraB' | 'voice' | 'systemAudio' | 'broll' | 'music' | 'image';
export type CameraSlot = 'A' | 'B';

export interface SourceSync {
  /** Session time at which this file's first sample plays. */
  offset: Seconds;
  /** Source seconds that elapse per session second. 1 = no drift. */
  rate: number;
  method: 'recorded-clock' | 'audio-correlation' | 'manual' | 'unsynced' | 'reference';
  /** 0…1 for audio correlation, null when not measured. */
  confidence: number | null;
  status: 'aligned' | 'needs-review' | 'unsynced';
  /** Residual error measured at check points across the take. */
  checkpoints: { sessionTime: Seconds; residualMs: number }[];
  /** Manual calibration pairs (session time ↔ source time). */
  calibration: { session: Seconds; source: Seconds }[];
  confirmedByCreator: boolean;
}

export interface MediaSource {
  id: string;
  role: SourceRole;
  name: string;
  /** Absolute path, or project-relative when managed. */
  path: string;
  /** true = lives inside the project bundle; false = referenced in place. */
  managed: boolean;
  origin: 'recording' | 'import';
  kind: 'video' | 'audio' | 'image';
  duration: Seconds;
  width?: number;
  height?: number;
  fps?: number;
  variableFrameRate?: boolean;
  codec?: string;
  hasAudio: boolean;
  audioChannels?: number;
  sampleRate?: number;
  /** Identity used to verify a relinked file is the same media. */
  fingerprint: { sizeBytes: number; duration: Seconds; createdAt?: string | null };
  available: boolean;
  takeId?: string;
  /**
   * true  → the cursor is burned into the pixels (flattened import): no editable cursor path.
   * false → app recording with separate cursor telemetry.
   */
  cursorBaked: boolean;
  cursorFile?: string;
  /** Keyboard telemetry (shortcuts and anonymous typing ticks) of a recording, when it was captured. */
  keysFile?: string;
  /** Set when the screen source is a recorded iPhone or iPad. */
  deviceKind?: 'iphone' | 'ipad' | null;
  /** Logical size of the captured area in points (for cursor scale). */
  pointWidth?: number;
  pointHeight?: number;
  sync: SourceSync;
  /** Session-time ranges where the source has no media (e.g. camera unplugged). */
  gaps: (Range & { reason: string })[];
  license?: string;
  note?: string;
  /** Free-text tags that help B-roll matching. */
  tags?: string[];
}

// ───────────────────────────── transcript ─────────────────────────────

export interface Word {
  id: string;
  /** Recognised text. Display text may be overridden by EditState.wordText. */
  text: string;
  start: Seconds;
  end: Seconds;
  confidence?: number;
  kind: 'word' | 'filler';
}

export interface Transcript {
  engine: string;
  locale: string;
  onDevice: boolean;
  sourceId: string;
  hasSpeech: boolean;
  words: Word[];
  generatedAt: string;
}

// ───────────────────────────── edit decisions ─────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

/** Provenance carried by every decision so AI work stays reviewable and reversible. */
export interface DecisionMeta {
  origin: 'ai' | 'creator';
  /** Edit revision in which this decision was created or last changed. */
  revision: number;
  reason?: string;
  confidence?: Confidence;
  locked?: boolean;
}

export type CutKind = 'trim' | 'silence' | 'filler' | 'retake' | 'transcript' | 'manual' | 'pacing';

export interface Cut extends Range {
  id: string;
  kind: CutKind;
  meta: DecisionMeta;
}

export interface SpeedRange extends Range {
  id: string;
  speed: number;
  meta: DecisionMeta;
}

/** 'presenter' = camera fills the frame with the screen as a small inset. */
export type LayoutMode = 'screen' | 'camera' | 'overlay' | 'split' | 'presenter';

export interface LayoutSegment extends Range {
  id: string;
  mode: LayoutMode;
  camera: CameraSlot;
  transition: 'cut' | 'smooth';
  meta: DecisionMeta;
}

export interface Zoom extends Range {
  id: string;
  scale: number;
  /** Follow the recorded cursor, or hold a fixed target. */
  follow: boolean;
  /** Target in normalised screen-source coordinates. */
  x: number;
  y: number;
  /**
   * 'zoom' (default) scales the whole picture, 'magnifier' keeps the frame at
   * 1× and shows a round lens over the target, 'instant' zooms without animation.
   */
  style?: 'zoom' | 'magnifier' | 'instant';
  /** Magnifier lens diameter as a fraction of the screen picture's height. */
  lensSize?: number;
  meta: DecisionMeta;
}

export type OverlayKind = 'callout' | 'section-card' | 'lower-third';

export interface Overlay extends Range {
  id: string;
  kind: OverlayKind;
  text: string;
  subtext?: string;
  /** Normalised output-frame anchor for callouts. */
  x: number;
  y: number;
  meta: DecisionMeta;
}

export interface BrollInsert extends Range {
  id: string;
  /** MediaSource id with role 'broll' | 'image'. */
  assetId: string;
  /** Where in the asset playback starts. */
  assetIn: Seconds;
  fit: 'cover' | 'contain';
  /** Narration is preserved unless the creator opts into the asset's audio. */
  useAssetAudio: boolean;
  meta: DecisionMeta;
}

export interface Mask extends Range {
  id: string;
  /** Which source the mask is pinned to, so it survives zoom and layout changes. */
  target: 'screen' | 'cameraA' | 'cameraB';
  /** Normalised rect inside the target source frame. */
  rect: Rect;
  style: 'blur' | 'solid' | 'highlight';
  meta: DecisionMeta;
}

export interface RangeLock extends Range {
  id: string;
  note: string;
  createdAt: string;
}

export interface Suggestion extends Range {
  id: string;
  kind: 'retake' | 'reorder' | 'hook' | 'cut' | 'broll' | 'note';
  title: string;
  reason: string;
  confidence: Confidence;
  status: 'open' | 'accepted' | 'dismissed';
  /** Operations applied if the creator accepts. Empty = informational. */
  apply: EditOp[];
  revision: number;
}

export interface AudioSettings {
  /** The one source whose voice is heard. Camera scratch audio stays muted. */
  masterVoiceId: string | null;
  tracks: Record<string, { gain: number; muted: boolean }>;
  voiceCleanup: { enabled: boolean; bypass: boolean };
  music: { sourceId: string; gain: number; duck: boolean } | null;
}

export interface Appearance {
  output: { width: number; height: number; fps: number };
  background:
    | { type: 'gradient'; colors: string[]; angle: number }
    /** One of Cutaway's built-in abstract wallpapers (see WALLPAPERS). */
    | { type: 'wallpaper'; id: string; blur: number }
    | { type: 'solid'; color: string }
    /** `path` is absolute, or relative to the project folder for images Cutaway downloaded into it. */
    | { type: 'image'; path: string; blur: number; credit?: ImageCredit };
  frame: { padding: number; radius: number; shadow: number; inset: number };
  /** Crop of the screen source, normalised. */
  crop: Rect;
  cursor: {
    visible: boolean;
    size: number;
    smoothing: number;
    hideWhenIdle: boolean;
    clickEffect: 'ripple' | 'none';
    /** 'auto' follows the recorded cursor type (arrow, hand, I-beam); 'arrow' always shows the default pointer. */
    style?: 'auto' | 'arrow';
    rotate?: boolean;
    antiShake?: boolean;
    loop?: boolean;
    clickSound?: { enabled: boolean; volume: number };
  };
  camera: {
    shape: 'rounded' | 'circle' | 'square';
    size: number;
    corner: 'tl' | 'tr' | 'bl' | 'br';
    mirror: boolean;
    radius: number;
    shadow: number;
    look?: CameraLook;
    face?: { zoom: boolean; follow: boolean };
    cutout?: { enabled: boolean; backdrop: 'none' | 'blur' | 'color'; color: string };
  };
  /** 0 = off. Applies a shutter-style smear to moving parts. */
  motionBlur?: { amount: number; cursor: boolean; animation: boolean };
  /** Key-cap labels for shortcuts pressed while recording. */
  shortcuts?: { show: boolean; size: number; position: 'bottom' | 'top'; hidden: string[] };
  /** Generic phone/tablet bezel around a portrait or device screen source. */
  device?: { frame: boolean; color: 'graphite' | 'silver' | 'midnight' };
  captions: { burnIn: boolean; size: number; position: 'bottom' | 'top'; style: 'pill' | 'plain' | 'bold' };
  motion: 'calm' | 'balanced' | 'lively';
  /** Colour LUT and sharpening for the screen recording and for the cameras. */
  grade?: { screen?: LayerGrade; camera?: LayerGrade };
  /** Scale a new zoom starts at (by hand or from the automatic pass). Unset = 1.8. */
  zoomLevel?: number;
}

/** A .cube file copied into the project folder. */
export interface LutRef {
  /** Path relative to the project folder. */
  file: string;
  name: string;
  kind: '1d' | '3d';
  size: number;
}

export interface LayerGrade {
  lut: LutRef | null;
  /** 0–1 mix of the LUT over the original picture. */
  strength: number;
  /** 0–1 unsharp-mask amount. */
  sharpen: number;
}

/** Who made a downloaded background image, kept so the credit travels with the project. */
export interface ImageCredit {
  source: 'unsplash';
  id: string;
  author: string;
  authorUrl: string;
  pageUrl: string;
}

export interface CameraLook {
  brightness: number;
  contrast: number;
  saturation: number;
  /** −1 cool … +1 warm. */
  warmth: number;
}

/** Keyboard telemetry. Typed characters are never recorded. */
export type KeyStroke = { t: Seconds; e: 'shortcut'; keys: string[] } | { t: Seconds; e: 'type' };

export interface EditState {
  cuts: Cut[];
  /** Ranges the creator restored or asked to keep; AI cuts may not remove them. */
  keeps: Range[];
  speeds: SpeedRange[];
  layouts: LayoutSegment[];
  /** The view used wherever no layout segment applies. Set from the layout chosen in the recorder; absent = decided by which sources exist. */
  baseLayout?: LayoutMode;
  zooms: Zoom[];
  overlays: Overlay[];
  broll: BrollInsert[];
  masks: Mask[];
  locks: RangeLock[];
  suggestions: Suggestion[];
  /** Caption/transcript spelling corrections keyed by word id. Never cuts footage. */
  wordText: Record<string, string>;
  audio: AudioSettings;
  appearance: Appearance;
}

// ───────────────────────────── operations ─────────────────────────────

/**
 * The only vocabulary an AI proposal may use. Anything else is rejected by
 * validateOps before it can touch a project.
 */
export type EditOp =
  | { op: 'cut'; start: Seconds; end: Seconds; kind: CutKind; reason?: string; confidence?: Confidence }
  | { op: 'speed'; start: Seconds; end: Seconds; speed: number; reason?: string; confidence?: Confidence }
  | { op: 'layout'; start: Seconds; end: Seconds; mode: LayoutMode; camera?: CameraSlot; transition?: 'cut' | 'smooth'; reason?: string; confidence?: Confidence }
  | { op: 'zoom'; start: Seconds; end: Seconds; scale: number; x?: number; y?: number; follow?: boolean; reason?: string; confidence?: Confidence }
  | { op: 'overlay'; kind: OverlayKind; start: Seconds; end: Seconds; text: string; subtext?: string; x?: number; y?: number; reason?: string; confidence?: Confidence }
  | { op: 'broll'; assetId: string; start: Seconds; end: Seconds; assetIn?: Seconds; reason?: string; confidence?: Confidence }
  | { op: 'suggest'; kind: Suggestion['kind']; start: Seconds; end: Seconds; title: string; reason: string; confidence?: Confidence; apply?: EditOp[] };

export interface RejectedOp {
  op: unknown;
  code:
    | 'unknown-op'
    | 'bad-shape'
    | 'out-of-range'
    | 'too-short'
    | 'locked'
    | 'kept-by-creator'
    | 'no-coverage'
    | 'missing-asset'
    | 'bad-value'
    | 'manual-decision'
    | 'unsupported-fact';
  message: string;
}

export interface ValidationResult {
  accepted: EditOp[];
  rejected: RejectedOp[];
  /** Ops that were changed to fit (e.g. clipped at a lock). */
  adjusted: { op: EditOp; note: string }[];
}

// ───────────────────────────── brief, analysis ─────────────────────────────

export interface Brief {
  audience: string;
  /** 'auto' keeps the natural length after cleanup. */
  targetDuration: 'auto' | Seconds;
  pacing: 'relaxed' | 'balanced' | 'energetic';
  visualIntensity: 'calm' | 'balanced' | 'lively';
  allowBroll: boolean;
  notes: string;
}

export interface CursorSample {
  t: Seconds;
  x: number;
  y: number;
  c?: string;
  e: 'move' | 'down' | 'up' | 'rdown' | 'rup';
}

/** Replaceable derived data. Safe to clear and recompute. */
export interface Analysis {
  /** Speech-free ranges from the master voice envelope. */
  silences: Range[];
  /** Visual-change score of the screen source, sampled at activityHz. */
  activity: number[];
  activityHz: number;
  /** Click times (session) and positions from cursor telemetry. */
  clicks: { t: Seconds; x: number; y: number }[];
  /** Loudness envelope (0…1) of the master voice for the waveform lane. */
  waveform: number[];
  waveformHz: number;
  /** Loud-speech level of the master voice in dBFS (95th percentile RMS), used to normalise it. */
  voiceLevelDb?: number | null;
  computedAt: string;
}

// ───────────────────────────── packaging ─────────────────────────────

export type ThumbnailLayer =
  | { id: string; kind: 'frame'; sourceId: string; time: Seconds; x: number; y: number; scale: number; brightness: number; saturation: number; blur: number; mirror: boolean }
  | {
      id: string;
      kind: 'image';
      /** Absolute, or relative to the project folder (generated art lives in media/generated/). */
      path: string;
      x: number;
      y: number;
      scale: number;
      opacity: number;
      /** Set when the picture was made by an AI image model. Shown in the editor and written to the package manifest. */
      generated?: { provider: string; note: string; direction: string; at: string };
    }
  | { id: string; kind: 'scrim'; from: string; to: string; angle: number; opacity: number }
  | { id: string; kind: 'shape'; shape: 'rect' | 'pill' | 'circle'; x: number; y: number; w: number; h: number; color: string; rotation: number; opacity: number }
  | {
      id: string;
      kind: 'text';
      text: string;
      x: number;
      y: number;
      /** Fraction of thumbnail height. */
      size: number;
      maxWidth: number;
      font: 'display' | 'grotesk' | 'serif' | 'mono';
      weight: number;
      color: string;
      stroke: string | null;
      strokeWidth: number;
      background: string | null;
      rotation: number;
      align: 'left' | 'center' | 'right';
      uppercase: boolean;
    };

export interface PackagingConcept {
  id: string;
  title: string;
  layers: ThumbnailLayer[];
  /** Why this concept fits, tied to what is in the video. */
  rationale: string;
  /** Moments in the edit that support the title/thumbnail claim. */
  evidence: { sessionTime: Seconds; quote: string }[];
  origin: 'ai' | 'template';
  /** Which app proposed it, when origin is 'ai'. Absent on older projects (Claude Code). */
  aiProvider?: 'claude' | 'codex';
  /** Pictures an AI image model made for this concept. One may be in use as an image layer; the rest are spare variations. */
  art?: GeneratedArt[];
  editedByCreator: boolean;
}

/** One AI-generated picture kept in the project folder. */
export interface GeneratedArt {
  id: string;
  /** Relative to the project folder: media/generated/…. */
  path: string;
  /** Who made it, as shown to the creator: "OpenAI via local Codex". */
  provider: string;
  /** The model's one-line description of the picture. */
  note: string;
  /** What the creator asked for, if anything. */
  direction: string;
  at: string;
}

export interface Chapter {
  /** Session time of the chapter start; output time is derived. */
  sessionTime: Seconds;
  title: string;
}

export interface Packaging {
  concepts: PackagingConcept[];
  selectedId: string | null;
  description: string;
  chapters: Chapter[];
  /** Edit revision the concepts were grounded in. */
  basedOnRevision: number | null;
  stale: boolean;
  staleReason: string | null;
  reviewed: boolean;
}

// ───────────────────────────── project ─────────────────────────────

export interface RevisionRecord {
  revision: number;
  label: string;
  origin: 'ai' | 'creator';
  createdAt: string;
  summary: string;
  snapshot: EditState;
  /** Where the checkpoint came from, when it was not a plain manual or first-cut one. */
  via?: 'chat';
  /** The chat message whose edits this checkpoint holds. */
  messageId?: string;
}

/** Points at one checkpoint. A revision number identifies one exact edit. */
export interface CheckpointRef {
  revision: number;
  label: string;
}

export type ChatLane = 'cuts' | 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll';

/** One proposed change in a chat reply. Nothing is applied until the creator says so. */
export interface ChatProposalItem {
  id: string;
  /** add = one validated edit operation; remove = take an existing decision out; rules = a request the built-in rules can carry out. */
  kind: 'add' | 'remove' | 'rules';
  op?: EditOp;
  remove?: { lane: ChatLane; id: string };
  /** For kind "rules": the request and section handed to the built-in rules when applied. */
  rules?: { instruction: string; scope: Range };
  /** Session range the change is about (for the jump link). */
  range: Range;
  /** What it does, in plain words. */
  what: string;
  /** Why, as the assistant gave it. */
  why: string;
  status: 'open' | 'applied' | 'dismissed' | 'refused';
  /** Why validation refused it, or a note about how it was adjusted to fit. */
  note?: string;
  /** Set once applied. */
  checkpoint?: CheckpointRef;
}

export interface ChatMessage {
  id: string;
  role: 'creator' | 'assistant';
  text: string;
  at: string;
  /** The section the request was about; null = the whole video. */
  scope: Range | null;
  /** assistant: how the reply was produced. */
  mode?: 'claude' | 'local-rules';
  /** assistant: why the built-in rules answered instead of the AI provider, when they did. */
  modeReason?: string | null;
  /** assistant: moments it pointed at (answers to questions like "where does it drag?"). */
  moments?: (Range & { note: string })[];
  items?: ChatProposalItem[];
  /** assistant: the reply could not be produced. */
  failed?: boolean;
}

export interface ExportRecord {
  id: string;
  revision: number;
  folder: string;
  createdAt: string;
  status: 'complete' | 'partial' | 'failed';
  draft: boolean;
  files: { name: string; bytes: number; ok: boolean; note?: string }[];
  settings: { width: number; height: number; fps: number };
  failedStage?: string;
}

export interface ProcessingConsent {
  /** Destination the creator approved, e.g. "Anthropic via local Claude Code". */
  provider: string;
  scope: ('transcript' | 'frames' | 'edit-metadata')[];
  grantedAt: string;
}

export type JobStage = 'validate' | 'sync' | 'transcribe' | 'visual' | 'assemble' | 'preview' | 'packaging' | 'export';

export interface Project {
  schema: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Length of the session timeline. */
  duration: Seconds;
  sources: MediaSource[];
  transcript: Transcript | null;
  analysis: Analysis | null;
  brief: Brief;
  edit: EditState;
  /** Current edit revision number. */
  revision: number;
  /** Named checkpoints (AI first cut, before local regeneration, …). */
  revisions: RevisionRecord[];
  /** Has an AI (or heuristic) first cut been assembled. */
  /** mode 'claude' = a model made the editorial pass; `provider` says which app (absent on older projects: Claude Code). */
  firstCut: { at: string; mode: 'claude' | 'local-rules'; provider?: 'claude' | 'codex'; summary: string } | null;
  packaging: Packaging;
  exports: ExportRecord[];
  consent: ProcessingConsent | null;
  /**
   * Separate permission to send a concept's title, a few spoken words and up
   * to two stills to an image model for thumbnail pictures. It names its own
   * provider, so it never follows from `consent`.
   */
  artConsent?: { provider: string; grantedAt: string } | null;
  /** Completed stage checkpoints so a retry resumes instead of restarting. */
  stages: Partial<Record<JobStage, { doneAt: string; inputKey: string }>>;
  ui: { playhead: Seconds; view: 'sources' | 'brief' | 'edit' | 'package' | 'export'; expandedTimeline: boolean };
  /** Moments the creator flagged while recording (session time). */
  flags?: Flag[];
  /** The "Ask AI" thread of this project. */
  chat?: ChatMessage[];
}

/** A marker dropped during recording: "look here". */
export interface Flag {
  id: string;
  t: Seconds;
  takeId?: string;
}
