import type { CameraSlot, MediaSource, Project, Range, Seconds, SourceSync } from './types';
import { subtract, union } from './ranges';

export function defaultSync(method: SourceSync['method'] = 'reference', offset = 0): SourceSync {
  return {
    offset,
    rate: 1,
    method,
    confidence: null,
    status: method === 'unsynced' ? 'unsynced' : 'aligned',
    checkpoints: [],
    calibration: [],
    confirmedByCreator: method === 'recorded-clock' || method === 'reference',
  };
}

/** Session time → time inside the source file. */
export function toSourceTime(sync: Pick<SourceSync, 'offset' | 'rate'>, session: Seconds): Seconds {
  return (session - sync.offset) * sync.rate;
}

/** Time inside the source file → session time. */
export function toSessionTime(sync: Pick<SourceSync, 'offset' | 'rate'>, source: Seconds): Seconds {
  return source / sync.rate + sync.offset;
}

/** Session-time ranges where the source really has media. */
export function coverage(src: MediaSource): Range[] {
  if (!src.available || src.sync.status === 'unsynced') return [];
  const full: Range = { start: src.sync.offset, end: src.sync.offset + src.duration / src.sync.rate };
  return subtract(full, src.gaps);
}

export function covers(src: MediaSource | undefined, t: Seconds): boolean {
  if (!src) return false;
  return coverage(src).some((r) => t >= r.start && t < r.end);
}

export function coversRange(src: MediaSource | undefined, r: Range): boolean {
  if (!src) return false;
  return coverage(src).some((c) => r.start >= c.start - 1e-3 && r.end <= c.end + 1e-3);
}

export function sourceByRole(project: Pick<Project, 'sources'>, role: MediaSource['role']): MediaSource | undefined {
  return project.sources.find((s) => s.role === role);
}

export function cameraSource(project: Pick<Project, 'sources'>, slot: CameraSlot): MediaSource | undefined {
  return sourceByRole(project, slot === 'A' ? 'cameraA' : 'cameraB');
}

/** Session duration implied by the primary (timeline-defining) sources. */
export function sessionDuration(sources: MediaSource[]): Seconds {
  const primary = sources.filter((s) => ['screen', 'cameraA', 'cameraB', 'voice'].includes(s.role) && s.sync.status !== 'unsynced');
  const screen = primary.find((s) => s.role === 'screen');
  const lead = screen ?? primary.find((s) => s.role === 'cameraA') ?? primary[0];
  if (!lead) return 0;
  // The lead source defines the timeline; others may start late or stop early.
  return lead.sync.offset + lead.duration / lead.sync.rate;
}

// ───────────────────────────── calibration ─────────────────────────────

/**
 * Derive offset (and drift rate, with two points) from manual calibration
 * pairs. One point fixes the offset; a second point far away fixes drift.
 */
export function syncFromCalibration(points: { session: Seconds; source: Seconds }[], previous?: SourceSync): SourceSync {
  const pts = [...points].sort((a, b) => a.session - b.session);
  const base = previous ?? defaultSync('manual');
  if (pts.length === 0) return { ...base, method: 'unsynced', status: 'unsynced', calibration: [], confirmedByCreator: false };
  const a = pts[0]!;
  let rate = 1;
  if (pts.length >= 2) {
    const b = pts[pts.length - 1]!;
    const ds = b.session - a.session;
    if (Math.abs(ds) > 1) rate = (b.source - a.source) / ds;
    if (!(rate > 0.9 && rate < 1.1)) rate = 1; // implausible drift → ignore, keep offset
  }
  const offset = a.session - a.source / rate;
  return {
    offset,
    rate,
    method: 'manual',
    confidence: null,
    status: 'aligned',
    checkpoints: pts.map((p) => ({ sessionTime: p.session, residualMs: Math.abs(toSourceTime({ offset, rate }, p.session) - p.source) * 1000 })),
    calibration: pts,
    confirmedByCreator: true,
  };
}

// ───────────────────────────── audio correlation ─────────────────────────────

export interface CorrelationResult {
  /** Seconds to add to `other` time to land on `ref` time (other starts `offset` after ref starts). */
  offset: Seconds;
  rate: number;
  /** 0…1. Below ~0.35 there is no trustworthy shared audio. */
  confidence: number;
  checkpoints: { sessionTime: Seconds; residualMs: number }[];
  reliable: boolean;
}

/** Log-energy onset envelope: robust to different mics hearing the same room. */
export function envelope(pcm: Float32Array, sampleRate: number, hz = 200, onset = true): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / hz));
  const n = Math.floor(pcm.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * hop;
    for (let j = 0; j < hop; j++) {
      const v = pcm[o + j]!;
      s += v * v;
    }
    env[i] = Math.log10(1e-7 + s / hop);
  }
  if (!onset) return env;
  // onset emphasis: positive first difference, then mean removal
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 1; i < n; i++) {
    const d = env[i]! - env[i - 1]!;
    out[i] = d > 0 ? d : 0;
    mean += out[i]!;
  }
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) out[i] = out[i]! - mean;
  return out;
}

/**
 * Normalised cross-correlation of b against a over lags in [minLag, maxLag]
 * (in samples of the envelope). Returns best lag where b[i] ≈ a[i + lag].
 */
function bestLag(a: Float32Array, b: Float32Array, minLag: number, maxLag: number): { lag: number; score: number; second: number } {
  let best = -Infinity;
  let bestL = 0;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let na = 0;
    let nb = 0;
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(b.length, a.length - lag);
    if (i1 - i0 < 50) {
      scores.push(-1);
      continue;
    }
    for (let i = i0; i < i1; i++) {
      const x = a[i + lag]!;
      const y = b[i]!;
      sum += x * y;
      na += x * x;
      nb += y * y;
    }
    const score = na > 0 && nb > 0 ? sum / Math.sqrt(na * nb) : -1;
    scores.push(score);
    if (score > best) {
      best = score;
      bestL = lag;
    }
  }
  // second-best peak outside the main lobe → peak prominence
  let second = -Infinity;
  const guard = 8;
  for (let k = 0; k < scores.length; k++) {
    const lag = minLag + k;
    if (Math.abs(lag - bestL) <= guard) continue;
    if (scores[k]! > second) second = scores[k]!;
  }
  return { lag: bestLag_refine(a, b, bestL), score: best, second: second === -Infinity ? 0 : second };
}

/** Parabolic sub-sample refinement of the correlation peak. */
function bestLag_refine(a: Float32Array, b: Float32Array, lag: number): number {
  const c = (l: number) => {
    let sum = 0;
    const i0 = Math.max(0, -l);
    const i1 = Math.min(b.length, a.length - l);
    for (let i = i0; i < i1; i++) sum += a[i + l]! * b[i]!;
    return sum;
  };
  const y0 = c(lag - 1);
  const y1 = c(lag);
  const y2 = c(lag + 1);
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-12) return lag;
  const delta = (0.5 * (y0 - y2)) / denom;
  return lag + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Align `other` to `ref` using audio both recordings heard, and measure drift
 * by re-correlating windows at the start, middle and end of the overlap.
 *
 * Both inputs are mono PCM at the same sample rate. `maxOffset` bounds the
 * search. When nothing correlates, `reliable` is false and the caller must ask
 * for manual alignment instead of claiming a sync.
 */
export function correlateAudio(ref: Float32Array, other: Float32Array, sampleRate: number, maxOffset = 600): CorrelationResult {
  const coarseHz = 20;
  const ea = envelope(ref, sampleRate, coarseHz);
  const eb = envelope(other, sampleRate, coarseHz);
  const maxLag = Math.min(Math.round(maxOffset * coarseHz), Math.max(ea.length, eb.length));
  const coarse = bestLag(ea, eb, -maxLag, maxLag);
  const coarseOffset = coarse.lag / coarseHz;
  const prominence = coarse.score - Math.max(0, coarse.second);
  const confidence = Math.max(0, Math.min(1, coarse.score * 0.6 + prominence * 1.2));

  // Fine pass in windows across the overlap to get sub-frame offsets and drift.
  // Plain log-energy at 4 ms resolution; parabolic refinement takes it below 1 ms.
  const fineHz = 250;
  const fa = envelope(ref, sampleRate, fineHz, false);
  const fb = envelope(other, sampleRate, fineHz, false);
  const centered = (x: Float32Array): Float32Array => {
    let m = 0;
    for (let i = 0; i < x.length; i++) m += x[i]!;
    m /= Math.max(1, x.length);
    const o = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) o[i] = x[i]! - m;
    return o;
  };
  const overlapStart = Math.max(0, -coarseOffset); // in other-time
  const overlapEnd = Math.min(other.length / sampleRate, ref.length / sampleRate - coarseOffset);
  const overlap = overlapEnd - overlapStart;
  const points: { tOther: number; offset: number; score: number }[] = [];
  if (overlap > 4) {
    const win = Math.min(8, Math.max(4, overlap / 4)); // short windows so drift does not smear the peak
    const fractions = overlap > 30 ? [0.02, 0.25, 0.5, 0.75, 0.98] : [0.05, 0.5, 0.95];
    for (const f of fractions) {
      const t0 = overlapStart + (overlap - win) * f;
      const bSlice = fb.subarray(Math.floor(t0 * fineHz), Math.floor((t0 + win) * fineHz));
      const aStart = Math.floor((t0 + coarseOffset - 0.25) * fineHz);
      const aEnd = Math.floor((t0 + coarseOffset + win + 0.25) * fineHz);
      if (aStart < 0 || aEnd > fa.length || bSlice.length < fineHz * 2) continue;
      const aSlice = fa.subarray(aStart, aEnd);
      const r = bestLag(centered(aSlice), centered(bSlice), 0, Math.round(0.5 * fineHz));
      if (r.score > 0.3) points.push({ tOther: t0 + win / 2, offset: coarseOffset - 0.25 + r.lag / fineHz, score: r.score });
    }
  }

  let offset = coarseOffset;
  let rate = 1;
  if (points.length >= 2) {
    // least squares: offset(tOther) = o0 + k * tOther  →  ref = tOther + offset
    const n = points.length;
    const mx = points.reduce((s, p) => s + p.tOther, 0) / n;
    const my = points.reduce((s, p) => s + p.offset, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const p of points) {
      sxx += (p.tOther - mx) ** 2;
      sxy += (p.tOther - mx) * (p.offset - my);
    }
    const k = sxx > 1 ? sxy / sxx : 0;
    const o0 = my - k * mx;
    // ref = tOther * (1 + k) + o0  →  session = source / rate + offset
    const r = 1 / (1 + k);
    if (r > 0.98 && r < 1.02 && overlap > 20) rate = r;
    offset = rate === 1 ? my : o0;
  } else if (points.length === 1) {
    offset = points[0]!.offset;
  }

  const checkpoints = points.map((p) => {
    const predicted = p.tOther / rate + offset;
    const measured = p.tOther + p.offset;
    return { sessionTime: measured, residualMs: Math.abs(predicted - measured) * 1000 };
  });
  const reliable = confidence >= 0.35 && points.length >= 1;
  return { offset, rate, confidence, checkpoints, reliable };
}

/** Largest stretch during which both cameras and the screen can all be used. */
export function commonCoverage(sources: MediaSource[]): Range[] {
  let acc: Range[] | null = null;
  for (const s of sources) {
    const c = coverage(s);
    acc = acc === null ? c : union(acc.flatMap((r) => c.map((x) => ({ start: Math.max(r.start, x.start), end: Math.min(r.end, x.end) })).filter((x) => x.end > x.start)));
  }
  return acc ?? [];
}
