/**
 * Sound effects. The built-in sounds are synthesised here, sample by sample, from sine waves and
 * seeded noise: there are no audio files and nobody else's recordings. The same samples are played by
 * the preview and mixed by the exporter.
 */
import type { DecisionMeta, EditState, MediaSource, Overlay, Project, Seconds, SoundCue, SoundEffect } from './types';
import { clamp, uid } from './ranges';
import type { TimeMap } from './timemap';

export interface BuiltinSound {
  id: string;
  name: string;
  description: string;
  duration: Seconds;
  /** Seconds into the sound that land on the chosen moment: a riser ends on it, a whoosh peaks on it. */
  hit: Seconds;
}

export const BUILTIN_SOUNDS: BuiltinSound[] = [
  { id: 'whoosh', name: 'Whoosh', description: 'A soft rush of air. Good on a change of view.', duration: 0.6, hit: 0.3 },
  { id: 'swish', name: 'Swish', description: 'A quick, light pass. Good as text arrives.', duration: 0.28, hit: 0.1 },
  { id: 'pop', name: 'Pop', description: 'A small rounded pop.', duration: 0.16, hit: 0 },
  { id: 'click', name: 'Click', description: 'A crisp tick.', duration: 0.06, hit: 0 },
  { id: 'ding', name: 'Ding', description: 'A bright bell note.', duration: 1.1, hit: 0 },
  { id: 'thud', name: 'Thud', description: 'A low, soft hit. Good under a big title.', duration: 0.45, hit: 0 },
  { id: 'riser', name: 'Riser', description: 'Builds up and stops on the moment.', duration: 1.6, hit: 1.5 },
];

export const DEFAULT_SOUND_GAIN = 0.6;

export function builtinSound(id: string | null | undefined): BuiltinSound | null {
  return BUILTIN_SOUNDS.find((s) => s.id === id) ?? null;
}

/** Deterministic white noise in −1…1. */
function noiseSource(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** Noise through a resonant band-pass whose centre moves with `freq(p)`; shaped by `env(p)`. p = 0…1 through the sound. */
function sweptNoise(out: Float32Array, rate: number, seed: number, freq: (p: number) => number, env: (p: number) => number, q: number, level: number) {
  const noise = noiseSource(seed);
  let low = 0;
  let band = 0;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    // Chamberlin state-variable filter; stable while f stays well under rate / 6
    const f = 2 * Math.sin((Math.PI * Math.min(freq(p), rate / 7)) / rate);
    low += f * band;
    const high = noise() - low - q * band;
    band += f * high;
    out[i] = out[i]! + band * env(p) * level;
  }
}

const TWO_PI = Math.PI * 2;

function render(id: string, rate: number): Float32Array {
  const spec = builtinSound(id) ?? BUILTIN_SOUNDS[0]!;
  const n = Math.max(8, Math.round(spec.duration * rate));
  const out = new Float32Array(n);
  const bell = (p: number) => Math.pow(Math.sin(Math.PI * clamp(p, 0, 1)), 2);
  switch (spec.id) {
    case 'whoosh':
      sweptNoise(out, rate, 0x51f15e, (p) => 350 + 2600 * Math.pow(Math.sin(Math.PI * p), 1.4), bell, 0.9, 1);
      sweptNoise(out, rate, 0x9e3779, (p) => 900 + 4200 * Math.pow(Math.sin(Math.PI * p), 2), (p) => bell(p) * 0.5, 1.2, 0.5);
      break;
    case 'swish':
      sweptNoise(out, rate, 0x2545f4, (p) => 1500 + 4500 * Math.sin(Math.PI * Math.pow(p, 0.7)), (p) => Math.pow(Math.sin(Math.PI * Math.pow(p, 0.8)), 1.6), 1.1, 1);
      break;
    case 'pop': {
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const f = 180 + 380 * Math.exp(-t * 34);
        phase += (TWO_PI * f) / rate;
        out[i] = Math.sin(phase) * Math.min(1, t / 0.002) * Math.exp(-t * 36);
      }
      break;
    }
    case 'click': {
      const noise = noiseSource(0x1234567);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        out[i] = Math.sin(TWO_PI * 2300 * t) * Math.exp(-t * 170) * 0.7 + noise() * Math.exp(-t * 1100) * 0.4;
      }
      break;
    }
    case 'ding': {
      const f0 = 1174.66; // D6
      const partials: [ratio: number, level: number, decay: number][] = [[1, 1, 4.2], [2.0, 0.42, 6.5], [3.01, 0.22, 9], [4.17, 0.1, 13]];
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        let v = 0;
        for (const [ratio, level, decay] of partials) v += Math.sin(TWO_PI * f0 * ratio * t) * level * Math.exp(-t * decay);
        out[i] = v * Math.min(1, t / 0.003);
      }
      break;
    }
    case 'thud': {
      const noise = noiseSource(0x7f4a7c);
      let phase = 0;
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const f = 42 + 70 * Math.exp(-t * 22);
        phase += (TWO_PI * f) / rate;
        lp += (noise() - lp) * 0.08;
        out[i] = Math.sin(phase) * Math.min(1, t / 0.004) * Math.exp(-t * 9) + lp * Math.exp(-t * 140) * 0.8;
      }
      break;
    }
    case 'riser': {
      // builds for `hit` seconds, then lets go quickly
      const rise = spec.hit / spec.duration;
      const env = (p: number) => (p < rise ? Math.pow(p / rise, 2.2) : Math.exp(-((p - rise) / (1 - rise)) * 5));
      sweptNoise(out, rate, 0x6d2b79, (p) => 300 * Math.pow(20, Math.min(1, p / rise)), env, 0.7, 1);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const f = 220 * Math.pow(4, Math.min(1, p / rise));
        phase += (TWO_PI * f) / rate;
        out[i] = out[i]! + Math.sin(phase) * env(p) * 0.25;
      }
      break;
    }
  }
  // a couple of milliseconds at each end so a sound can never start or stop on a step
  const edge = Math.min(Math.round(rate * 0.002), n >> 1);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    if (i < edge) out[i] = out[i]! * (i / edge);
    if (n - 1 - i < edge) out[i] = out[i]! * ((n - 1 - i) / edge);
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  if (peak > 0) {
    const k = 0.8 / peak;
    for (let i = 0; i < n; i++) out[i] = out[i]! * k;
  }
  return out;
}

const cache = new Map<string, Float32Array>();

/** Mono samples of a built-in sound, peak 0.8. The same call always returns the same samples. */
export function synthSound(id: string, sampleRate: number): Float32Array {
  const key = `${id}@${sampleRate}`;
  let data = cache.get(key);
  if (!data) {
    data = render(id, sampleRate);
    cache.set(key, data);
  }
  return data;
}

// ───────────────────────────── the sound lane ─────────────────────────────

export function soundsOf(edit: Pick<EditState, 'sounds'>): SoundEffect[] {
  return edit.sounds ?? [];
}

/** How long a cue sounds, and how far into it the moment sits. */
export function cueTiming(cue: SoundCue, sources: MediaSource[]): { duration: Seconds; hit: Seconds } {
  const b = builtinSound(cue.builtin);
  if (b) return { duration: b.duration, hit: b.hit };
  const file = sources.find((s) => s.id === cue.sourceId);
  // a creator's file is a sound effect, not a song: it is never played for longer than this
  return { duration: file ? Math.min(file.duration, MAX_FILE_SOUND) : 0, hit: 0 };
}

export const MAX_FILE_SOUND = 12;

export function cleanCue(raw: Partial<SoundCue> | null | undefined, sources: MediaSource[]): SoundCue | null {
  if (!raw) return null;
  const gain = typeof raw.gain === 'number' && Number.isFinite(raw.gain) ? clamp(raw.gain, 0, 1) : DEFAULT_SOUND_GAIN;
  if (builtinSound(raw.builtin)) return { builtin: raw.builtin!, gain };
  if (raw.sourceId && sources.some((s) => s.id === raw.sourceId && s.hasAudio)) return { builtin: null, sourceId: raw.sourceId, gain };
  return null;
}

export function makeSound(at: Seconds, cue: SoundCue, sources: MediaSource[], meta: DecisionMeta): SoundEffect {
  const { duration, hit } = cueTiming(cue, sources);
  const start = Math.max(0, at);
  return { id: uid('sfx'), start, end: start + Math.max(0.1, duration - hit), builtin: cue.builtin, sourceId: cue.builtin ? undefined : cue.sourceId, gain: cue.gain, meta };
}

/** Adds sounds at the given moments, skipping any moment that already has one within 50 ms. */
export function addSounds(edit: EditState, moments: Seconds[], cue: SoundCue, sources: MediaSource[], meta: DecisionMeta): { edit: EditState; added: SoundEffect[] } {
  const existing = soundsOf(edit);
  const added: SoundEffect[] = [];
  for (const t of [...moments].sort((a, b) => a - b)) {
    if ([...existing, ...added].some((s) => Math.abs(s.start - t) < 0.05)) continue;
    added.push(makeSound(t, cue, sources, { ...meta }));
  }
  if (!added.length) return { edit, added };
  return { edit: { ...edit, sounds: [...existing, ...added].sort((a, b) => a.start - b.start) }, added };
}

/** Session moments at which the view changes (a layout decision begins, or ends without another taking over). */
export function viewChangeMoments(edit: Pick<EditState, 'layouts'>, duration: Seconds): Seconds[] {
  const starts = edit.layouts.map((l) => l.start);
  const ends = edit.layouts.map((l) => l.end).filter((e) => !starts.some((s) => Math.abs(s - e) < 0.05));
  return [...starts, ...ends].filter((t) => t > 0.05 && t < duration - 0.05).sort((a, b) => a - b);
}

/** Session moments just after each cut: where the picture jumps in the finished video. */
export function cutMoments(map: TimeMap): Seconds[] {
  const out: Seconds[] = [];
  for (let i = 1; i < map.segments.length; i++) {
    const prev = map.segments[i - 1]!;
    const seg = map.segments[i]!;
    if (seg.srcStart - prev.srcEnd > 1e-3) out.push(seg.srcStart);
  }
  return out;
}

/** Gives every on-screen text and graphic that has no entry sound this one. */
export function soundOnEveryText(edit: EditState, cue: SoundCue): { edit: EditState; changed: number } {
  let changed = 0;
  const overlays = edit.overlays.map((o) => {
    if (o.sound) return o;
    changed += 1;
    return { ...o, sound: { ...cue } };
  });
  return changed ? { edit: { ...edit, overlays }, changed } : { edit, changed };
}

// ───────────────────────────── what is heard, and when ─────────────────────────────

export interface SoundEvent {
  /** Stable for a given decision, so a player can tell which events it has already started. */
  key: string;
  cue: SoundCue;
  /** Output time at which playback of the sound starts. */
  at: Seconds;
  /** Seconds of the sound to skip (when its lead-in would start before the video does). */
  skip: Seconds;
  /** Output time of the moment the sound belongs to. */
  moment: Seconds;
  duration: Seconds;
}

function event(key: string, cue: SoundCue, moment: Seconds, sources: MediaSource[]): SoundEvent | null {
  const { duration, hit } = cueTiming(cue, sources);
  if (duration <= 0 || cue.gain <= 0) return null;
  const at = moment - hit;
  return { key, cue, at: Math.max(0, at), skip: Math.max(0, -at), moment, duration };
}

/** When a text or graphic first shows in the finished video, or null when all of it was cut. */
export function overlayEntry(o: Pick<Overlay, 'start' | 'end'>, map: TimeMap): Seconds | null {
  return map.rangeToOutput(o)[0]?.start ?? null;
}

/**
 * Every sound in the finished video, in output time, sorted. A sound effect whose moment was cut is
 * dropped; a text's entry sound plays when the text first appears.
 */
export function soundEvents(project: Pick<Project, 'edit' | 'sources'>, map: TimeMap): SoundEvent[] {
  const out: SoundEvent[] = [];
  for (const s of soundsOf(project.edit)) {
    if (!map.isKept(s.start)) continue;
    const e = event(s.id, s, map.toOutput(s.start), project.sources);
    if (e) out.push(e);
  }
  for (const o of project.edit.overlays) {
    if (!o.sound) continue;
    const entry = overlayEntry(o, map);
    if (entry === null) continue;
    const e = event(`${o.id}:in`, o.sound, entry, project.sources);
    if (e) out.push(e);
  }
  // an animation's own sounds (a click, a pop), each at its moment while the block plays
  for (const o of project.edit.overlays) {
    if (o.kind !== 'motion' || !o.motion?.sounds.length) continue;
    const entry = overlayEntry(o, map);
    if (entry === null) continue;
    const shown = map.rangeToOutput(o).reduce((n, r) => n + (r.end - r.start), 0);
    o.motion.sounds.forEach((c, i) => {
      if (c.t >= shown) return;
      const e = event(`${o.id}:motion:${i}`, { builtin: c.sound, gain: c.gain ?? 0.7 }, entry + c.t, project.sources);
      if (e) out.push(e);
    });
  }
  return out.filter((e) => e.at < map.outDuration).sort((a, b) => a.at - b.at);
}

/** Ids of the creator's own files used as sound effects (for credits and for "is this file in use"). */
export function soundFilesUsed(project: Pick<Project, 'edit'>): string[] {
  const ids = new Set<string>();
  for (const s of soundsOf(project.edit)) if (!s.builtin && s.sourceId) ids.add(s.sourceId);
  for (const o of project.edit.overlays) if (o.sound && !o.sound.builtin && o.sound.sourceId) ids.add(o.sound.sourceId);
  return [...ids];
}
