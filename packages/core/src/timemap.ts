import type { Cut, Range, Seconds, SpeedRange } from './types';
import { EPS, subtract, union } from './ranges';

/** One continuous stretch of the finished video. */
export interface Segment {
  /** Session-time interval that plays. */
  srcStart: Seconds;
  srcEnd: Seconds;
  speed: number;
  /** Output-time interval it occupies. */
  outStart: Seconds;
  outEnd: Seconds;
}

/**
 * Maps session time ↔ output time for a set of cuts and speed changes.
 * Captions, chapters, review items, preview and export all read the same map,
 * so they cannot disagree about where something lands in the finished video.
 */
export class TimeMap {
  readonly segments: Segment[];
  readonly outDuration: Seconds;
  readonly srcDuration: Seconds;

  constructor(srcDuration: Seconds, cuts: Range[], speeds: Pick<SpeedRange, 'start' | 'end' | 'speed'>[] = []) {
    this.srcDuration = srcDuration;
    const kept = subtract({ start: 0, end: srcDuration }, cuts);
    const speedSorted = [...speeds].filter((s) => s.end - s.start > EPS && s.speed > 0).sort((a, b) => a.start - b.start);
    const segs: Segment[] = [];
    let out = 0;
    for (const k of kept) {
      // split the kept range at speed boundaries
      const bounds = new Set<number>([k.start, k.end]);
      for (const s of speedSorted) {
        if (s.start > k.start + EPS && s.start < k.end - EPS) bounds.add(s.start);
        if (s.end > k.start + EPS && s.end < k.end - EPS) bounds.add(s.end);
      }
      const pts = [...bounds].sort((a, b) => a - b);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (b - a <= EPS) continue;
        const mid = (a + b) / 2;
        const sp = speedSorted.find((s) => mid >= s.start && mid < s.end)?.speed ?? 1;
        const dur = (b - a) / sp;
        segs.push({ srcStart: a, srcEnd: b, speed: sp, outStart: out, outEnd: out + dur });
        out += dur;
      }
    }
    this.segments = segs;
    this.outDuration = out;
  }

  static fromEdit(srcDuration: Seconds, edit: { cuts: Cut[]; speeds: SpeedRange[] }): TimeMap {
    return new TimeMap(srcDuration, edit.cuts, edit.speeds);
  }

  /** Segment index containing an output time (clamped). */
  segmentAtOut(out: Seconds): number {
    const segs = this.segments;
    if (segs.length === 0) return -1;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (out >= segs[mid]!.outEnd - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Output → session time. Clamped to the edit. */
  toSource(out: Seconds): Seconds {
    const i = this.segmentAtOut(out);
    if (i < 0) return 0;
    const s = this.segments[i]!;
    const o = Math.min(Math.max(out, s.outStart), s.outEnd);
    return s.srcStart + (o - s.outStart) * s.speed;
  }

  /** True when the session time survives into the finished video. */
  isKept(src: Seconds): boolean {
    return this.segments.some((s) => src >= s.srcStart - EPS && src < s.srcEnd - EPS);
  }

  /**
   * Session → output time. A time inside a cut snaps to where the cut lands
   * (the next surviving frame), which is what a viewer would see.
   */
  toOutput(src: Seconds): Seconds {
    const segs = this.segments;
    if (segs.length === 0) return 0;
    for (const s of segs) {
      if (src < s.srcStart) return s.outStart;
      if (src <= s.srcEnd) return s.outStart + (src - s.srcStart) / s.speed;
    }
    return this.outDuration;
  }

  /**
   * Maps a session range to the output ranges it occupies (it may be split by
   * cuts). Empty when the whole range was removed.
   */
  rangeToOutput(r: Range): Range[] {
    const out: Range[] = [];
    for (const s of this.segments) {
      const a = Math.max(r.start, s.srcStart);
      const b = Math.min(r.end, s.srcEnd);
      if (b - a > EPS) out.push({ start: s.outStart + (a - s.srcStart) / s.speed, end: s.outStart + (b - s.srcStart) / s.speed });
    }
    return union(out);
  }

  /** Kept session ranges (ignoring speed). */
  keptRanges(): Range[] {
    return union(this.segments.map((s) => ({ start: s.srcStart, end: s.srcEnd })));
  }
}
