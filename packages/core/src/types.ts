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
  /**
   * Which footage group (a recorded take, or files imported together) this timeline source belongs to.
   * Absent = the project's first group ("main"). Clips are cut from a group; see `Clip.take`.
   */
  take?: string;
  /**
   * How far this placement's own clock is moved onto the session timeline: session = take time + shift.
   * `sync.offset` and `gaps` already include it. Absent = 0.
   */
  shift?: Seconds;
  /** Session range this placement is used in (its clip, or run of clips). Absent = wherever it has media. */
  window?: Range;
  /**
   * Set on a second placement of the same file, made when clips cut from one take sit apart on the
   * timeline. Derived from the source it names; never edited on its own.
   */
  instanceOf?: string;
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
  /** Words of clips that were removed from the timeline, kept so the clip can be put back. */
  parked?: Word[];
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

/** The three ready-made graphics. These are the only overlay kinds an AI proposal may use. */
export type GraphicKind = 'callout' | 'section-card' | 'lower-third';
/** 'text' is the free text tool: its look comes from `Overlay.style`. 'motion' is an animation (see `MotionSpec`). */
export type OverlayKind = GraphicKind | 'text' | 'motion';

/** One value an animation lets the creator change without touching its code: a word, a colour, a number. */
export interface MotionField {
  id: string;
  label: string;
  type: 'text' | 'color' | 'number';
  value: string;
}

/** A sound the animation makes, `t` seconds after it appears: one of the built-in sounds (BUILTIN_SOUNDS). */
export interface MotionCue {
  t: Seconds;
  sound: string;
  gain?: number;
}

/**
 * An animation: a small HTML page whose motion is CSS keyframes or the Web Animations API, plus an optional
 * `__render(t)` drawing hook, so any moment of it can be drawn exactly. It is rendered once into transparent
 * frames that the preview and the export both draw, on top of the picture and under the captions.
 */
export interface MotionSpec {
  /** Project-relative path of the page (media/motion/…html). A change is saved as a new file, so undo brings the old one back. */
  file: string;
  name: string;
  /** Its natural length. A shorter block cuts the end off; a longer one holds the last frame. */
  duration: Seconds;
  fields: MotionField[];
  sounds: MotionCue[];
  /**
   * Where it is drawn, as a fraction of the output frame. Absent = the whole frame. A boxed animation (a circle
   * around a button, a highlighter under words) is rendered at the box's size and drawn into it.
   */
  box?: Rect;
  /** How it was made: from a built-in template, or described to Claude or Codex. */
  origin: { kind: 'template'; template: string } | { kind: 'ai'; provider: string; prompt: string };
}

export type TextFont = 'inter' | 'anton' | 'serif' | 'grotesk' | 'mono';
export type TextAnimation = 'none' | 'fade' | 'slide-up' | 'pop' | 'typewriter';

/**
 * Look of a free text overlay. Lengths are fractions of the output's short side unless noted,
 * so the same style holds up on wide, square and vertical outputs.
 */
export interface TextStyle {
  font: TextFont;
  /** Font size as a fraction of the output's short side. */
  size: number;
  weight: number;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Width the text wraps at, as a fraction of the output width. */
  width: number;
  uppercase: boolean;
  /** Extra letter spacing in em. */
  tracking: number;
  /** Line height as a multiple of the font size. */
  leading: number;
  background: { shape: 'none' | 'box' | 'pill'; color: string; opacity: number };
  /** Outline width as a fraction of the font size; 0 = none. */
  outline: { width: number; color: string };
  /** 0 = none … 1 = heavy drop shadow. */
  shadow: number;
  /** A thin bar beside (or, for centred text, under) the first line. null = none. */
  accent: string | null;
  /** Dims the whole frame behind the text (title cards, end cards). */
  scrim: { color: string; opacity: number } | null;
  /** How the second line (`Overlay.subtext`) differs from the first. */
  sub: { scale: number; weight: number; color: string; font: TextFont; uppercase: boolean; tracking: number };
  in: { type: TextAnimation; duration: Seconds };
  out: { type: TextAnimation; duration: Seconds };
}

/** A sound that plays once: one of the built-in synthesised sounds, or the creator's own file. */
export interface SoundCue {
  /** Built-in sound id (see BUILTIN_SOUNDS), or null when `sourceId` names a file. */
  builtin: string | null;
  sourceId?: string;
  gain: number;
}

export interface Overlay extends Range {
  id: string;
  kind: OverlayKind;
  text: string;
  subtext?: string;
  /** Normalised output-frame anchor: for callouts the centre; for free text the block's anchor point. */
  x: number;
  y: number;
  /** kind 'text' only. */
  style?: TextStyle;
  /** kind 'motion' only. */
  motion?: MotionSpec;
  /** Played as the overlay appears. */
  sound?: SoundCue;
  meta: DecisionMeta;
}

/**
 * A sound effect tied to a moment of the content (session time). If that moment is cut, the sound is
 * dropped. `start` is the moment; `end` is where the sound has died away.
 */
export interface SoundEffect extends Range, SoundCue {
  id: string;
  meta: DecisionMeta;
}

/**
 * A piece of music on the OUTPUT timeline: it starts at a second of the finished video and plays
 * straight through, so cutting or moving footage never makes the music jump.
 */
export interface MusicClip {
  id: string;
  sourceId: string;
  /** Output-time second at which the clip starts. */
  start: Seconds;
  /** Where in the file playback starts. */
  sourceIn: Seconds;
  length: Seconds;
  gain: number;
  fadeIn: Seconds;
  fadeOut: Seconds;
  /** Lower the music while someone is speaking. */
  duck: boolean;
  /** Start the file again from its beginning when it runs out, so a short piece can fill a long clip. */
  loop?: boolean;
  /**
   * Volume points drawn on the clip: `t` seconds into the clip, `level` a multiple of `gain` (1 = the clip's level).
   * Between points the level moves in a straight line; before the first and after the last it holds. Absent = flat.
   */
  volume?: VolumePoint[];
  meta: DecisionMeta;
}

export interface VolumePoint {
  t: Seconds;
  level: number;
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
  /** Seconds the insert takes to fade in and out. Absent = the standard short fade (see `brollOpacity`); 0 = a hard cut. */
  fadeIn?: Seconds;
  fadeOut?: Seconds;
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

/**
 * One piece of footage on the timeline. The session timeline is the playing clips laid end to end in
 * array order; removed clips follow the last playing one, so everything keeps a place and can come back.
 */
export interface Clip {
  id: string;
  /** Footage group the clip plays (see `MediaSource.take`). The first clip of a group has `id === take`. */
  take: string;
  name: string;
  /** Session time at which the clip starts. Kept in step with the order by `layoutClips`. */
  start: Seconds;
  /** The part of the take this clip plays, on the take's own clock. */
  in: Seconds;
  out: Seconds;
  /** The view used wherever no layout segment applies inside this clip. */
  baseLayout?: LayoutMode;
  /** Taken off the timeline. Its footage stays on disk and its decisions are parked here. */
  removed?: boolean;
  /** Decisions of a removed clip, by lane, with times measured from the clip's start. */
  parked?: Record<string, unknown[]>;
}

export type TransitionKind = 'dissolve' | 'dip-black' | 'dip-white';

/**
 * How one clip gives way to the next. It belongs to that pair of clips: it is drawn only while
 * `from` is immediately followed by `to` on the timeline, and the clip operations drop it once
 * they are no longer neighbours. A transition never changes the length of the video.
 */
export interface Transition {
  id: string;
  /** Clip ids: the clip that ends and the clip that begins. */
  from: string;
  to: string;
  kind: TransitionKind;
  /** Wanted length in output seconds; what is drawn is clamped to what the two clips can give. */
  duration: Seconds;
}

/** Hide jump cuts in a full-frame camera shot by alternating between normal framing and a slight punch-in. */
export interface PunchIn {
  enabled: boolean;
  /** Magnification of the punched-in shots (1.05 … 1.3). */
  scale: number;
  /** Ids of cuts at which the framing is left as it was. */
  skip?: string[];
}

export interface RangeLock extends Range {
  id: string;
  note: string;
  createdAt: string;
}

export interface Suggestion extends Range {
  id: string;
  kind: 'retake' | 'reorder' | 'hook' | 'cut' | 'broll' | 'note' | 'animation';
  title: string;
  reason: string;
  confidence: Confidence;
  status: 'open' | 'accepted' | 'dismissed';
  /** Operations applied if the creator accepts. Empty = informational. */
  apply: EditOp[];
  revision: number;
  /** kind "animation": the built-in template and its words, added at `start` when accepted. */
  motion?: { template: string; fields: Record<string, string> };
}

export interface AudioSettings {
  /** The one source whose voice is heard. Camera scratch audio stays muted. */
  masterVoiceId: string | null;
  /** The audible voice of every footage group after the first, by `MediaSource.take`. */
  takeVoices?: Record<string, string>;
  tracks: Record<string, { gain: number; muted: boolean }>;
  voiceCleanup: { enabled: boolean; bypass: boolean };
  /** Superseded by EditState.music. Still read from older projects: see `musicClipsOf`. */
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
    /** With two cameras: the one shown outside view blocks. Absent = A. */
    main?: 'A' | 'B';
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
  captions: { burnIn: boolean; size: number; position: 'bottom' | 'top'; style: 'pill' | 'plain' | 'bold'; /** Word-by-word captions of a short (set only on the project a short is rendered from). */ short?: ShortCaptions };
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
  /** The clips in playing order. Absent = one clip holding the whole recording (read through `clipsOf`). */
  clips?: Clip[];
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
  /** Music clips on the output timeline. Absent in projects saved before music clips existed: read through `musicClipsOf`. */
  music?: MusicClip[];
  /** Sound effects in session time. Read through `soundsOf`. */
  sounds?: SoundEffect[];
  /** Transitions between neighbouring clips, keyed by the two clips' ids (not by time). Read through `transitionsOf`. */
  transitions?: Transition[];
  /** Punch-in on jump cuts. Absent = off. Read through `punchInOf`. */
  punchIn?: PunchIn;
  /** Caption/transcript spelling corrections keyed by word id. Never cuts footage. */
  wordText: Record<string, string>;
  audio: AudioSettings;
  appearance: Appearance;
  /** How a short fills its frame. Never saved: present only on the project a short is rendered from (`shortProject`). */
  reframe?: ShortReframe;
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
  | { op: 'overlay'; kind: GraphicKind; start: Seconds; end: Seconds; text: string; subtext?: string; x?: number; y?: number; reason?: string; confidence?: Confidence }
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
  /** Silences and clicks of clips that were removed from the timeline. */
  parked?: { silences: Range[]; clicks: { t: Seconds; x: number; y: number }[] };
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
  kind: 'add' | 'remove' | 'rules' | 'motion';
  op?: EditOp;
  remove?: { lane: ChatLane; id: string };
  /** For kind "rules": the request and section handed to the built-in rules when applied. */
  rules?: { instruction: string; scope: Range };
  /** For kind "motion": an animation to add. A built-in template with its words, or (template null) one the AI writes from `request`. `at` is session time; null = at the playhead. */
  motion?: { template: string | null; fields: Record<string, string>; request: string; at: number | null };
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
  ui: { playhead: Seconds; view: 'sources' | 'brief' | 'edit' | 'package' | 'shorts' | 'export'; expandedTimeline: boolean; /** Show every detailed lane (layouts, masks, speed, sound effects) instead of the three simple rows. */ advancedTimeline?: boolean };
  /** Moments the creator flagged while recording (session time). */
  flags?: Flag[];
  /** The "Ask AI" thread of this project. */
  chat?: ChatMessage[];
  /** Vertical shorts cut from this video. Each is a range of the session timeline plus framing and captions; the edit is not copied. */
  shorts?: Short[];
}

/** A marker dropped during recording: "look here". */
export interface Flag {
  id: string;
  t: Seconds;
  takeId?: string;
  /** The flag sits in a clip that was removed from the timeline. */
  parked?: boolean;
}

// ───────────────────────────── shorts ─────────────────────────────

export type ShortShape = 'vertical' | 'square';
/**
 * How the picture fills a short's frame:
 * face = the camera fills the frame and follows the speaker;
 * stack = the whole screen on top, the camera below;
 * screen = the screen fills the frame and the visible part follows the pointer;
 * original = the views of the long video, fitted into the new shape.
 */
export type ShortFraming = 'face' | 'stack' | 'screen' | 'original';
export type ShortCaptionPreset = 'pop' | 'clean' | 'boxed' | 'editorial';

export interface ShortCaptions {
  /** 'off' = no burned-in captions. */
  preset: ShortCaptionPreset | 'off';
  /** Where the lines sit. All three keep clear of the short-video apps' own buttons and text. */
  position: 'high' | 'middle' | 'low';
  /** 0.7…1.4 of the preset's size. */
  size: number;
}

export interface Short extends Range {
  id: string;
  title: string;
  shape: ShortShape;
  framing: ShortFraming;
  captions: ShortCaptions;
  /** The line the short opens on, as spoken. */
  hook?: string;
  /** Why this stretch was proposed. */
  reason?: string;
  /** Who picked the range. */
  origin: 'ai' | 'rules' | 'creator';
  provider?: 'claude' | 'codex';
  createdAt: string;
  /** The last file exported from this short. */
  exported?: { path: string; at: string; bytes: number; revision: number };
}

/** Carried by the project a short is rendered from; read by frame evaluation. */
export interface ShortReframe {
  framing: ShortFraming;
  /** A screen shown on its own fills the whole frame, and the window onto it follows the pointer. */
  fillScreen: boolean;
}
