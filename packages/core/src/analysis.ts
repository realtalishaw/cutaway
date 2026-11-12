import type { Brief, CameraSlot, EditOp, MediaSource, Range, Seconds, Word } from './types';
import { subtract, union } from './ranges';
import { coverage } from './sync';
import { isFillerWord, normalizeWord } from './validate';

// ───────────────────────────── audio ─────────────────────────────

/** Linear RMS envelope. */
export function rmsEnvelope(pcm: Float32Array, sampleRate: number, hz = 50): number[] {
  const hop = Math.max(1, Math.round(sampleRate / hz));
  const n = Math.floor(pcm.length / hop);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * hop;
    for (let j = 0; j < hop; j++) {
      const v = pcm[o + j]!;
      s += v * v;
    }
    out[i] = Math.sqrt(s / hop);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

/** Speech-free stretches, with a threshold adapted to the take's own noise floor. */
export function detectSilences(env: number[], hz: number, minDuration = 0.3): { silences: Range[]; hasSignal: boolean } {
  const db = env.map((v) => 20 * Math.log10(v + 1e-6));
  const sorted = [...db].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.1);
  const loud = percentile(sorted, 0.95);
  const hasSignal = loud > -50 && loud - floor > 6;
  const thr = hasSignal ? Math.max(floor + 8, loud - 28) : Infinity;
  const silences: Range[] = [];
  let start = -1;
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i]! < thr;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      const r = { start: start / hz, end: i / hz };
      if (r.end - r.start >= minDuration) silences.push(r);
      start = -1;
    }
  }
  return { silences, hasSignal };
}

/** Normalised display waveform (0…1). */
export function waveform(env: number[], hzIn: number, hzOut = 20): number[] {
  const step = Math.max(1, Math.round(hzIn / hzOut));
  const out: number[] = [];
  let peak = 1e-6;
  for (let i = 0; i < env.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(env.length, i + step); j++) m = Math.max(m, env[j]!);
    out.push(m);
    peak = Math.max(peak, m);
  }
  return out.map((v) => Math.min(1, Math.sqrt(v / peak)));
}

// ───────────────────────────── words ─────────────────────────────

export function markFillers(words: Word[]): Word[] {
  return words.map((w) => (isFillerWord(w.text) ? { ...w, kind: 'filler' as const } : w));
}

export interface Sentence extends Range {
  index: number;
  text: string;
  wordIds: string[];
}

export function sentences(words: Word[], pause = 0.75): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ index: out.length, start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.text).join(' '), wordIds: cur.map((w) => w.id) });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > pause || /[.!?]$/.test(prev.text) || cur.length >= 40)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

// ───────────────────────────── visual activity ─────────────────────────────

export interface ActivityInput {
  activity: number[];
  activityHz: number;
  clicks: { t: Seconds; x: number; y: number }[];
}

const ACTIVE = 0.006;

/** Session ranges where something visibly happens on the screen. */
export function activeRanges(a: ActivityInput, margin = 0.5): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < a.activity.length; i++) {
    if (a.activity[i]! > ACTIVE) out.push({ start: i / a.activityHz - margin, end: (i + 1) / a.activityHz + margin });
  }
  for (const c of a.clicks) out.push({ start: c.t - margin, end: c.t + margin + 0.4 });
  return union(out.map((r) => ({ start: Math.max(0, r.start), end: r.end })));
}

// ───────────────────────────── pacing ─────────────────────────────

const PACING = {
  relaxed: { minGap: 1.6, keep: 0.7, staticHold: 3.5 },
  balanced: { minGap: 1.0, keep: 0.45, staticHold: 2.2 },
  energetic: { minGap: 0.65, keep: 0.3, staticHold: 1.4 },
} as const;

export interface PacingInput extends ActivityInput {
  duration: Seconds;
  words: Word[];
  hasSpeech: boolean;
  brief: Pick<Brief, 'pacing'>;
  /**
   * Quiet stretches measured from the audio itself. When given, pauses are only
   * shortened inside them, so speech the recogniser missed is never removed.
   */
  silences?: Range[];
}

/**
 * Conservative, explainable cleanup that never needs a model:
 *  - shortens pauses only where nothing happens on screen, so a silent
 *    demonstration or a loading wait followed by its result survives;
 *  - removes filler words that stand alone between pauses;
 *  - trims dead air before the first and after the last word.
 * It never removes real words, so it cannot change what was said.
 */
export function proposePacing(input: PacingInput): EditOp[] {
  const p = PACING[input.brief.pacing];
  const ops: EditOp[] = [];
  const busy = activeRanges(input);
  const quiet = input.silences ? union(input.silences.map((q) => ({ start: q.start + 0.05, end: q.end - 0.05 }))) : null;
  const push = (r: Range, kind: 'silence' | 'trim', reason: string) => {
    const candidates = quiet ? quiet.map((q) => ({ start: Math.max(q.start, r.start), end: Math.min(q.end, r.end) })).filter((q) => q.end - q.start > 0.2) : [r];
    for (const piece of candidates.flatMap((c) => subtract(c, busy))) {
      if (piece.end - piece.start >= 0.25) ops.push({ op: 'cut', start: piece.start, end: piece.end, kind, reason, confidence: 'high' });
    }
  };

  if (!input.hasSpeech || input.words.length === 0) {
    // Silent demo: only tighten long stretches where the screen is frozen.
    for (const idle of subtract({ start: 0, end: input.duration }, busy)) {
      const length = idle.end - idle.start;
      if (length > p.staticHold + 0.5) {
        push({ start: idle.start + p.staticHold / 2, end: idle.end - p.staticHold / 2 }, 'silence', `${length.toFixed(1)}s with nothing changing on screen`);
      }
    }
    return ops;
  }

  const words = input.words;
  const first = words[0]!;
  const last = words[words.length - 1]!;
  if (first.start > 1.2) push({ start: 0, end: first.start - 0.5 }, 'trim', 'Dead air before the first word');
  if (input.duration - last.end > 1.5) push({ start: last.end + 0.8, end: input.duration }, 'trim', 'Dead air after the last word');

  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i]!;
    const b = words[i + 1]!;
    const gap = b.start - a.end;
    if (gap >= p.minGap) {
      push({ start: a.end + p.keep * 0.45, end: b.start - p.keep * 0.55 }, 'silence', `${gap.toFixed(1)}s pause with nothing happening on screen`);
    }
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.kind !== 'filler' && !isFillerWord(w.text)) continue;
    const prev = words[i - 1];
    const next = words[i + 1];
    const before = prev ? w.start - prev.end : 1;
    const after = next ? next.start - w.end : 1;
    if (before < 0.04 || after < 0.04) continue; // glued to a neighbour: cutting would clip a real word
    ops.push({ op: 'cut', start: w.start - Math.min(0.12, before / 2), end: w.end + Math.min(0.12, after / 2), kind: 'filler', reason: `Filler word "${w.text}"`, confidence: 'high' });
  }
  return ops;
}

/** Repeated sentence openings usually mean a restart. Offered, never auto-applied. */
export function proposeRetakes(words: Word[]): EditOp[] {
  const ss = sentences(words.filter((w) => w.kind !== 'filler'));
  const ops: EditOp[] = [];
  const norm = (s: Sentence) => s.text.split(/\s+/).map(normalizeWord).filter(Boolean);
  for (let i = 0; i < ss.length - 1; i++) {
    const a = norm(ss[i]!);
    const b = norm(ss[i + 1]!);
    if (a.length < 3 || b.length < 3) continue;
    const head = Math.min(4, a.length, b.length);
    const sameHead = a.slice(0, head).join(' ') === b.slice(0, head).join(' ');
    const setB = new Set(b);
    const shared = a.filter((w) => setB.has(w)).length / a.length;
    if ((sameHead && head >= 3) || (shared >= 0.8 && a.length >= 5 && b.length >= a.length)) {
      const s = ss[i]!;
      ops.push({
        op: 'suggest',
        kind: 'retake',
        start: s.start,
        end: ss[i + 1]!.start,
        title: 'Possible retake',
        reason: `"${s.text.slice(0, 80)}" is followed by a similar sentence. Keep both if the repeat is deliberate.`,
        confidence: 'medium',
        apply: [{ op: 'cut', start: s.start, end: ss[i + 1]!.start, kind: 'retake', reason: 'Earlier attempt of a repeated sentence' }],
      });
    }
  }
  return ops;
}

// ───────────────────────────── zooms ─────────────────────────────

const ZOOM = {
  calm: { scale: 1.45, minClicks: 2, spacing: 12 },
  balanced: { scale: 1.7, minClicks: 1, spacing: 7 },
  lively: { scale: 2.0, minClicks: 1, spacing: 4 },
} as const;

/**
 * Click clusters become candidate zooms. A click is a hint, not proof, so
 * density is capped and calmer styles require a cluster of clicks.
 */
export function proposeZooms(clicks: { t: Seconds; x: number; y: number }[], duration: Seconds, intensity: Brief['visualIntensity']): EditOp[] {
  const z = ZOOM[intensity];
  const sorted = [...clicks].filter((c) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1).sort((a, b) => a.t - b.t);
  const clusters: (typeof sorted)[] = [];
  for (const c of sorted) {
    const cur = clusters[clusters.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && c.t - prev.t <= 3 && Math.hypot(c.x - prev.x, c.y - prev.y) < 0.35) cur.push(c);
    else clusters.push([c]);
  }
  const ops: EditOp[] = [];
  let lastEnd = -Infinity;
  for (const cl of clusters) {
    if (cl.length < z.minClicks) continue;
    const start = Math.max(0, cl[0]!.t - 0.6);
    const end = Math.min(duration, cl[cl.length - 1]!.t + 1.8);
    if (end - start < 1.6) continue;
    if (start - lastEnd < z.spacing && start > lastEnd) continue;
    if (start < lastEnd) continue;
    const x = cl.reduce((s, c) => s + c.x, 0) / cl.length;
    const y = cl.reduce((s, c) => s + c.y, 0) / cl.length;
    ops.push({ op: 'zoom', start, end, scale: z.scale, x, y, follow: true, reason: cl.length > 1 ? `${cl.length} clicks in the same area` : 'Click on a detail', confidence: cl.length > 1 ? 'high' : 'medium' });
    lastEnd = end;
  }
  return ops;
}

// ───────────────────────────── views ─────────────────────────────

export interface LayoutInput extends ActivityInput {
  duration: Seconds;
  words: Word[];
  sources: MediaSource[];
  brief: Pick<Brief, 'pacing' | 'visualIntensity'>;
}

/**
 * Rule-based view selection used when no model is available:
 * screen while something is demonstrated, camera while the creator explains
 * with a still screen, picture-in-picture otherwise. No fixed-interval
 * switching, and no shot shorter than three seconds.
 */
export function proposeLayouts(input: LayoutInput): EditOp[] {
  const screen = input.sources.find((s) => s.role === 'screen');
  const camA = input.sources.find((s) => s.role === 'cameraA');
  const camB = input.sources.find((s) => s.role === 'cameraB');
  const cams = [camA, camB].filter(Boolean) as MediaSource[];
  if (cams.length === 0) return [];
  const minShot = input.brief.visualIntensity === 'calm' ? 5 : input.brief.visualIntensity === 'lively' ? 3 : 4;
  const speech = union(input.words.map((w) => ({ start: w.start - 0.3, end: w.end + 0.3 })));
  const ops: EditOp[] = [];
  const inCoverage = (cam: MediaSource, r: Range) => coverage(cam).some((c) => r.start >= c.start && r.end <= c.end);

  if (!screen) {
    // Camera-only: stay on A, use B for an occasional longer thought.
    if (!camA || !camB) return [];
    const ss = sentences(input.words);
    let lastB = -30;
    for (const s of ss) {
      const length = s.end - s.start;
      if (length >= 6 && s.start - lastB > 25) {
        const r = { start: s.start, end: Math.min(input.duration, s.end + 0.3) };
        if (inCoverage(camB, r)) {
          ops.push({ op: 'layout', ...r, mode: 'camera', camera: 'B', transition: 'cut', reason: 'Second angle for a longer thought', confidence: 'medium' });
          lastB = s.end;
        }
      }
    }
    return ops;
  }

  const busy = activeRanges(input, 1.2);
  // Explaining with a still screen → show the person.
  const explain = speech.flatMap((sp) => subtract(sp, busy)).filter((r) => r.end - r.start >= Math.max(minShot, 4.5));
  let useB = false;
  for (const r of explain) {
    let slot: CameraSlot = 'A';
    if (camB && (!camA || (useB && r.end - r.start >= 8)) && inCoverage(camB, r)) slot = 'B';
    const cam = slot === 'A' ? camA : camB;
    if (!cam || !inCoverage(cam, r)) continue;
    ops.push({ op: 'layout', start: r.start, end: r.end, mode: 'camera', camera: slot, transition: 'smooth', reason: 'Explaining while the screen is still', confidence: 'medium' });
    useB = !useB;
  }
  // Demonstrating without talking → give the screen the whole frame.
  const silentDemo = busy.flatMap((b) => subtract(b, speech)).filter((r) => r.end - r.start >= minShot);
  for (const r of silentDemo) ops.push({ op: 'layout', start: r.start, end: r.end, mode: 'screen', transition: 'smooth', reason: 'Demonstration without narration', confidence: 'medium' });
  return ops;
}
