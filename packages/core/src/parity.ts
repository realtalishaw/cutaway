/**
 * Pure helpers for the Screen Studio-parity rendering features. Every option
 * they read is optional on the project, so older project files load unchanged;
 * the *Of() functions apply the defaults at read time.
 */
import type { Appearance, CameraLook, EditOp, KeyStroke, MediaSource, Range, Seconds } from './types';
import { clamp, subtractAll, union } from './ranges';

// ───────────────────────────── defaults ─────────────────────────────

export const MOTION_BLUR_DEFAULT = { amount: 0, cursor: true, animation: true } as const;
export const SHORTCUTS_DEFAULT = { show: false, size: 1, position: 'bottom', hidden: [] as string[] } as const;
export const LOOK_DEFAULT: CameraLook = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };
export const CUTOUT_DEFAULT = { enabled: false, backdrop: 'none', color: '#1c1d21' } as const;
export const DEVICE_DEFAULT = { frame: false, color: 'graphite' } as const;
export const CLICK_SOUND_DEFAULT = { enabled: false, volume: 0.5 } as const;

export const motionBlurOf = (ap: Appearance) => ({ ...MOTION_BLUR_DEFAULT, ...ap.motionBlur });
export const shortcutsOf = (ap: Appearance) => ({ ...SHORTCUTS_DEFAULT, ...ap.shortcuts, hidden: ap.shortcuts?.hidden ?? [] });
export const cameraLookOf = (ap: Appearance): CameraLook => ({ ...LOOK_DEFAULT, ...ap.camera.look });
export const faceOf = (ap: Appearance) => ({ zoom: false, follow: false, ...ap.camera.face });
export const cutoutOf = (ap: Appearance) => ({ ...CUTOUT_DEFAULT, ...ap.camera.cutout });
export const deviceOf = (ap: Appearance) => ({ ...DEVICE_DEFAULT, ...ap.device });
export const clickSoundOf = (ap: Appearance) => ({ ...CLICK_SOUND_DEFAULT, ...ap.cursor.clickSound });
export const cursorExtrasOf = (ap: Appearance) => ({ style: ap.cursor.style ?? 'auto', rotate: !!ap.cursor.rotate, antiShake: !!ap.cursor.antiShake, loop: !!ap.cursor.loop });

// ───────────────────────────── camera looks ─────────────────────────────

export const CAMERA_LOOKS: { id: string; name: string; look: CameraLook }[] = [
  { id: 'natural', name: 'Natural', look: { ...LOOK_DEFAULT } },
  { id: 'studio', name: 'Studio', look: { brightness: 1.06, contrast: 1.1, saturation: 1.08, warmth: 0.12 } },
  { id: 'golden', name: 'Golden', look: { brightness: 1.04, contrast: 1.04, saturation: 1.15, warmth: 0.45 } },
  { id: 'cool', name: 'Cool', look: { brightness: 1.02, contrast: 1.08, saturation: 0.95, warmth: -0.4 } },
  { id: 'mono', name: 'Mono', look: { brightness: 1.03, contrast: 1.15, saturation: 0, warmth: 0 } },
];

export function isNeutralLook(l: CameraLook): boolean {
  return Math.abs(l.brightness - 1) < 1e-3 && Math.abs(l.contrast - 1) < 1e-3 && Math.abs(l.saturation - 1) < 1e-3 && Math.abs(l.warmth) < 1e-3;
}

/** Canvas/CSS filter string for the tonal part of a look. Warmth is a separate overlay (see lookWarmth). */
export function lookFilter(l: CameraLook): string {
  if (isNeutralLook({ ...l, warmth: 0 })) return 'none';
  return `brightness(${l.brightness.toFixed(3)}) contrast(${l.contrast.toFixed(3)}) saturate(${l.saturation.toFixed(3)})`;
}

/** Colour and opacity of the soft-light overlay that warms or cools the picture. */
export function lookWarmth(l: CameraLook): { color: string; alpha: number } | null {
  if (Math.abs(l.warmth) < 1e-3) return null;
  return { color: l.warmth > 0 ? '#ff9a3c' : '#3c8cff', alpha: clamp(Math.abs(l.warmth), 0, 1) * 0.28 };
}

// ───────────────────────────── shortcuts ─────────────────────────────

const KEY_SYMBOL: Record<string, string> = {
  cmd: '⌘', command: '⌘', meta: '⌘', shift: '⇧', alt: '⌥', option: '⌥', opt: '⌥', ctrl: '⌃', control: '⌃', fn: 'fn',
  return: '↩', enter: '↩', escape: 'esc', esc: 'esc', tab: '⇥', delete: '⌫', backspace: '⌫', forwarddelete: '⌦', space: 'Space',
  up: '↑', down: '↓', left: '←', right: '→', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
};
const MOD_ORDER = ['ctrl', 'control', 'alt', 'option', 'opt', 'shift', 'cmd', 'command', 'meta'];

export function keyLabel(key: string): string {
  const k = key.toLowerCase();
  return KEY_SYMBOL[k] ?? (key.length === 1 ? key.toUpperCase() : key.length <= 3 ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1));
}

/** Key caps in the conventional macOS order (⌃ ⌥ ⇧ ⌘ then the key). */
export function shortcutCaps(keys: string[]): string[] {
  const rank = (k: string) => {
    const i = MOD_ORDER.indexOf(k.toLowerCase());
    return i < 0 ? 100 : i;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b)).map(keyLabel);
}

export function shortcutId(k: { t: Seconds; keys: string[] }): string {
  return `${k.t.toFixed(2)}:${k.keys.join('+').toLowerCase()}`;
}

export const SHORTCUT_HOLD = 1.2;

export interface ShownShortcut {
  id: string;
  caps: string[];
  /** 0…1 fade. */
  alpha: number;
}

/** Shortcuts visible at session time `src` (most recent last). Only shortcut events are ever shown. */
export function activeShortcuts(keys: KeyStroke[], src: Seconds, hidden: string[] = [], hold = SHORTCUT_HOLD): ShownShortcut[] {
  const out: ShownShortcut[] = [];
  for (const k of keys) {
    if (k.e !== 'shortcut' || k.keys.length === 0) continue;
    const age = src - k.t;
    if (age < 0 || age >= hold) continue;
    const id = shortcutId(k);
    if (hidden.includes(id)) continue;
    out.push({ id, caps: shortcutCaps(k.keys), alpha: clamp(Math.min(age / 0.08, (hold - age) / 0.25), 0, 1) });
  }
  return out.slice(-2);
}

// ───────────────────────────── typing ─────────────────────────────

export interface TypingOptions {
  /** Ticks closer than this belong to one stretch. */
  maxGap: Seconds;
  /** Stretches shorter than this are not worth speeding up. */
  minLength: Seconds;
  minTicks: number;
}

export const TYPING_DEFAULTS: TypingOptions = { maxGap: 1.2, minLength: 3, minTicks: 12 };

/** Dense typing stretches from anonymous typing ticks. */
export function detectTyping(keys: KeyStroke[], opts: Partial<TypingOptions> = {}): Range[] {
  const o = { ...TYPING_DEFAULTS, ...opts };
  const ticks = keys.filter((k) => k.e === 'type').map((k) => k.t).sort((a, b) => a - b);
  const out: Range[] = [];
  let start = -1;
  let last = -1;
  let n = 0;
  const flush = () => {
    if (start >= 0 && last - start >= o.minLength && n >= o.minTicks) out.push({ start: Math.max(0, start - 0.15), end: last + 0.25 });
  };
  for (const t of ticks) {
    if (start < 0 || t - last > o.maxGap) {
      flush();
      start = t;
      n = 0;
    }
    last = t;
    n++;
  }
  flush();
  return union(out);
}

/** Speed operations over typing stretches, carved around locked ranges and existing speed changes. */
export function typingSpeedOps(stretches: Range[], avoid: Range[], speed = 2): EditOp[] {
  return subtractAll(stretches, avoid)
    .filter((r) => r.end - r.start >= 1.5)
    .map((r) => ({ op: 'speed' as const, start: r.start, end: r.end, speed, reason: 'Typing' }));
}

// ───────────────────────────── click sound ─────────────────────────────

/** A short, soft mouse-click tick, synthesised deterministically (no audio file). */
export function clickTick(sampleRate: number): Float32Array {
  const n = Math.round(sampleRate * 0.03);
  const out = new Float32Array(n);
  let seed = 1234567;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const env = Math.exp(-t * 260);
    const body = Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 180);
    out[i] = (noise * 0.35 * Math.exp(-t * 900) + body * 0.65) * env * 0.6;
  }
  return out;
}

// ───────────────────────────── face tracking ─────────────────────────────

export type FaceSample = { t: Seconds; x: number; y: number; w: number; h: number } | { t: Seconds; none: true };

export interface FaceTrackSmooth {
  hz: number;
  cx: Float32Array;
  cy: Float32Array;
  size: Float32Array;
  /** Typical face position, used when "follow" is off. */
  median: { cx: number; cy: number; size: number };
}

/**
 * Smooth a detected-face track into a steady camera target: gaps are held,
 * then a slow critically damped follower removes detector jitter.
 */
export function buildFaceTrack(samples: FaceSample[], fps: number): FaceTrackSmooth | null {
  const found = samples.filter((s): s is Extract<FaceSample, { x: number }> => !('none' in s));
  if (found.length < 2 || fps <= 0) return null;
  const last = samples[samples.length - 1]!.t;
  const n = Math.max(2, Math.round(last * fps) + 1);
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const size = new Float32Array(n);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const median = { cx: med(found.map((f) => f.x + f.w / 2)), cy: med(found.map((f) => f.y + f.h / 2)), size: med(found.map((f) => f.h)) };
  let j = 0;
  let cur = found[0]!;
  let px = cur.x + cur.w / 2;
  let py = cur.y + cur.h / 2;
  let ps = cur.h;
  let vx = 0;
  let vy = 0;
  let vs = 0;
  const omega = 3.2;
  const dt = 1 / fps;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (j < found.length - 1 && found[j + 1]!.t <= t) j++;
    cur = found[j]!;
    const tx = cur.x + cur.w / 2;
    const ty = cur.y + cur.h / 2;
    for (let k = 0; k < 4; k++) {
      const h = dt / 4;
      vx += (omega * omega * (tx - px) - 2 * omega * vx) * h;
      vy += (omega * omega * (ty - py) - 2 * omega * vy) * h;
      vs += (omega * omega * (cur.h - ps) - 2 * omega * vs) * h;
      px += vx * h;
      py += vy * h;
      ps += vs * h;
    }
    cx[i] = px;
    cy[i] = py;
    size[i] = ps;
  }
  return { hz: fps, cx, cy, size, median };
}

export function faceAt(track: FaceTrackSmooth, t: Seconds): { cx: number; cy: number; size: number } {
  const n = track.cx.length;
  const f = clamp(t * track.hz, 0, n - 1);
  const i = Math.floor(f);
  const k = Math.min(n - 1, i + 1);
  const u = f - i;
  return { cx: track.cx[i]! + (track.cx[k]! - track.cx[i]!) * u, cy: track.cy[i]! + (track.cy[k]! - track.cy[i]!) * u, size: track.size[i]! + (track.size[k]! - track.size[i]!) * u };
}

export interface CameraCrop {
  /** Centre of the visible window in camera-source coordinates (0…1). */
  cx: number;
  cy: number;
  /** ≥ 1: how much the camera picture is magnified. */
  scale: number;
}

/** Where to point and how far to punch in so the face sits comfortably in frame. */
export function faceCrop(face: { cx: number; cy: number; size: number }, opts: { zoom: boolean; follow: boolean }, median: { cx: number; cy: number; size: number }): CameraCrop {
  const f = opts.follow ? face : median;
  // a face about 45% of the frame height reads as a well-framed head-and-shoulders shot
  const scale = opts.zoom ? clamp(0.45 / Math.max(0.05, median.size), 1, 2.6) : opts.follow ? 1.15 : 1;
  const half = 0.5 / scale;
  return { cx: clamp(f.cx, half, 1 - half), cy: clamp(f.cy + (opts.zoom ? f.size * 0.08 : 0), half, 1 - half), scale };
}

// ───────────────────────────── device frame ─────────────────────────────

/** Which generic bezel suits a screen source, or null when a device frame makes no sense. */
export function deviceKindFor(source: Pick<MediaSource, 'width' | 'height' | 'deviceKind'> | undefined): 'phone' | 'tablet' | null {
  if (!source) return null;
  if (source.deviceKind === 'iphone') return 'phone';
  if (source.deviceKind === 'ipad') return 'tablet';
  const w = source.width ?? 0;
  const h = source.height ?? 0;
  if (!w || !h || h <= w) return null;
  return h / w >= 1.6 ? 'phone' : 'tablet';
}

/** Bezel thickness and screen corner radius, as fractions of the screen picture's width. */
export const DEVICE_BEZEL = { phone: { edge: 0.045, radius: 0.13 }, tablet: { edge: 0.035, radius: 0.05 } } as const;

export const DEVICE_COLORS: Record<'graphite' | 'silver' | 'midnight', { body: string; edge: string }> = {
  graphite: { body: '#2b2c30', edge: '#4a4c53' },
  silver: { body: '#d9dade', edge: '#f4f5f7' },
  midnight: { body: '#141a2b', edge: '#2c3856' },
};
