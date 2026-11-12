import type { Range } from './types';

let counter = 0;
/** Short unique id. Stable enough for local projects; no crypto dependency. */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const EPS = 1e-6;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function len(r: Range): number {
  return Math.max(0, r.end - r.start);
}

export function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS;
}

export function contains(r: Range, t: number): boolean {
  return t >= r.start - EPS && t < r.end - EPS;
}

export function intersect(a: Range, b: Range): Range | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end - start > EPS ? { start, end } : null;
}

/** Sorted, merged union. */
export function union(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter((r) => r.end - r.start > EPS)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** Parts of `r` not covered by any of `holes`. */
export function subtract(r: Range, holes: Range[]): Range[] {
  let parts: Range[] = [{ start: r.start, end: r.end }];
  for (const h of union(holes)) {
    const next: Range[] = [];
    for (const p of parts) {
      if (!overlaps(p, h)) {
        next.push(p);
        continue;
      }
      if (h.start - p.start > EPS) next.push({ start: p.start, end: h.start });
      if (p.end - h.end > EPS) next.push({ start: h.end, end: p.end });
    }
    parts = next;
  }
  return parts;
}

export function subtractAll(ranges: Range[], holes: Range[]): Range[] {
  return union(ranges.flatMap((r) => subtract(r, holes)));
}

export function totalLength(ranges: Range[]): number {
  return union(ranges).reduce((s, r) => s + len(r), 0);
}

export function intersectAll(ranges: Range[], within: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of ranges) for (const w of within) {
    const i = intersect(r, w);
    if (i) out.push(i);
  }
  return union(out);
}

/** Item active at time t in a list of non-overlapping ranges. */
export function at<T extends Range>(items: T[], t: number): T | undefined {
  for (const it of items) if (contains(it, t)) return it;
  return undefined;
}

export function fmtTime(t: number, withMs = false): string {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  if (!withMs) return base;
  const ms = Math.floor((s - Math.floor(s)) * 100);
  return `${base}.${String(ms).padStart(2, '0')}`;
}
