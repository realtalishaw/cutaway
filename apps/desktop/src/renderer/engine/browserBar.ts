/**
 * Find a browser's own toolbar (tabs, address bar) and side bars in a screen recording, so they can be cropped away
 * after the fact. Each sampled frame is measured on its own (a browser's bar changes colour with dark pages, and a
 * full-screen video has none), then the most common answer per side wins.
 *
 * The page edge is the first strong colour change met when walking in from that side of the frame: below the
 * toolbar, right of a vertical tab bar, left of a dark strip on the right.
 */

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Fractions of the frame to leave out on each side. */
export interface BarInsets {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Sum of channel differences between neighbouring averaged rows/columns that counts as a hard edge. */
const EDGE = 40;

/** Average colour of a run of rows (axis 'y': one value per row) or columns (axis 'x'), over part of the other axis. */
function profile(p: Pixels, axis: 'y' | 'x', from: number, to: number): Float64Array {
  const { data, width, height } = p;
  const len = axis === 'y' ? height : width;
  const out = new Float64Array(len * 3);
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(axis === 'y' ? width : height, Math.ceil(to));
  const span = Math.max(1, b - a);
  for (let i = 0; i < len; i++) {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (let j = a; j < b; j++) {
      const k = (axis === 'y' ? i * width + j : j * width + i) * 4;
      r += data[k]!;
      g += data[k + 1]!;
      bl += data[k + 2]!;
    }
    out[i * 3] = r / span;
    out[i * 3 + 1] = g / span;
    out[i * 3 + 2] = bl / span;
  }
  return out;
}

/** Edge strength between position i and i + 1. */
function edges(prof: Float64Array): Float64Array {
  const n = prof.length / 3;
  const e = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) e[i] = Math.abs(prof[(i + 1) * 3]! - prof[i * 3]!) + Math.abs(prof[(i + 1) * 3 + 1]! - prof[i * 3 + 1]!) + Math.abs(prof[(i + 1) * 3 + 2]! - prof[i * 3 + 2]!);
  return e;
}

/** Walking forward from `lo`, the first position after a hard edge (riding the edge to its strongest step). */
function forward(e: Float64Array, lo: number, hi: number): number | null {
  for (let i = Math.max(0, lo); i < Math.min(hi, e.length); i++) {
    if (e[i]! >= EDGE) {
      while (i + 1 < Math.min(hi, e.length) && e[i + 1]! > e[i]!) i++;
      return i + 1;
    }
  }
  return null;
}

/** Walking back from the far end, the last position before a hard edge. */
function backward(e: Float64Array, hi: number, lo: number): number | null {
  for (let i = Math.min(hi, e.length - 1); i > lo; i--) {
    if (e[i]! >= EDGE) {
      while (i - 1 > lo && e[i - 1]! > e[i]!) i--;
      return i;
    }
  }
  return null;
}

/** One frame's guess, in pixels of that frame (null = no bar on that side). */
export function measureFrame(p: Pixels): { top: number | null; left: number | null; right: number | null } {
  const { width: W, height: H } = p;
  // The top bar is looked for across the middle and right of the frame, clear of a vertical tab bar.
  const ey = edges(profile(p, 'y', W * 0.35, W * 0.95));
  const top = forward(ey, Math.round(H * 0.025), Math.round(H * 0.2));
  const below = (top ?? 0) + H * 0.1;
  const ex = edges(profile(p, 'x', below, H * 0.9));
  const left = forward(ex, Math.round(W * 0.02), Math.round(W * 0.25));
  const lastPage = backward(ex, W - 2, Math.round(W * 0.75));
  return { top, left, right: lastPage === null ? null : W - 1 - lastPage };
}

/** The value most frames agree on (within `tol`), when at least half of them found one; else 0. */
function consensus(values: (number | null)[], tol: number): number {
  const found = values.filter((v): v is number => v !== null);
  if (found.length * 2 < values.length || !found.length) return 0;
  let best = 0;
  let bestCount = 0;
  for (const v of found) {
    const near = found.filter((w) => Math.abs(w - v) <= tol);
    if (near.length > bestCount) {
      bestCount = near.length;
      best = Math.max(...near);
    }
  }
  return bestCount * 2 >= values.length ? best : 0;
}

/** The browser bars across sampled frames, as fractions of the frame; null when none was found. */
export function findBrowserBars(frames: Pixels[]): BarInsets | null {
  if (!frames.length) return null;
  const W = frames[0]!.width;
  const H = frames[0]!.height;
  const each = frames.map(measureFrame);
  const tol = Math.max(1, Math.round(H * 0.006));
  const top = consensus(each.map((m) => m.top), tol) / H;
  const left = consensus(each.map((m) => m.left), tol) / W;
  const right = consensus(each.map((m) => m.right), tol) / W;
  if (top <= 0 && left <= 0 && right <= 0) return null;
  return { top, left, right, bottom: 0 };
}

async function load(url: string, width: number): Promise<Pixels> {
  const img = new Image();
  // Media is served from Cutaway's own scheme with CORS; without this the canvas is tainted and its pixels unreadable.
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const height = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** Sample frames across the recording and find its browser bars. `frameUrls` are still frames of the screen. */
export async function detectBrowserBars(frameUrls: string[]): Promise<BarInsets | null> {
  const frames = await Promise.all(frameUrls.map((u) => load(u, 640).catch(() => null)));
  return findBrowserBars(frames.filter((f): f is Pixels => !!f));
}
