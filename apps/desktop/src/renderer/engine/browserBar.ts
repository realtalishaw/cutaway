/**
 * Find a browser's own toolbar (tabs, address bar) and side bars in a screen recording, so they can be cropped away
 * after the fact. Each sampled frame is measured on its own (a browser's bar changes colour with dark pages, and a
 * full-screen video has none), then the most common answer per side wins.
 *
 * The page edge is the first strong colour change met when walking in from that side of the frame: below the
 * toolbar, right of a vertical tab bar, left of a dark strip on the right. At the top, a browser's chrome is often
 * several bands (a tab strip, then a toolbar with an address field, sometimes a bookmarks bar and a hairline), so
 * from the first edge the search walks on through the toolbar to where the page starts (see chromeEnd). It never
 * goes past the rows where the frames differ, since only the page changes.
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

/** Colour distance between two rows of a profile. */
const dist = (prof: Float64Array, a: number, b: number) =>
  Math.abs(prof[a * 3]! - prof[b * 3]!) + Math.abs(prof[a * 3 + 1]! - prof[b * 3 + 1]!) + Math.abs(prof[a * 3 + 2]! - prof[b * 3 + 2]!);

/** Share of the row's columns (across the middle and right of the frame) whose colour differs from `ref`'s. */
function wideness(p: Pixels, row: number, ref: number): number {
  const { data, width: W } = p;
  let diff = 0;
  let n = 0;
  for (let x = Math.floor(W * 0.35); x < Math.ceil(W * 0.95); x += 2) {
    const a = (row * W + x) * 4;
    const b = (ref * W + x) * 4;
    if (Math.abs(data[a]! - data[b]!) + Math.abs(data[a + 1]! - data[b + 1]!) + Math.abs(data[a + 2]! - data[b + 2]!) > 8) diff++;
    n++;
  }
  return n ? diff / n : 0;
}

/**
 * From the first edge of a top bar, the end of the browser's chrome. A browser's toolbar holds an address field: a
 * wide band that comes back to the toolbar's colour. Only once such a field is found does the search go on, to the
 * hairline under the toolbar (a line of one to three rows that comes back to the toolbar's colour) or to a step to
 * a colour that does not come back (the page). Without a field, the first edge already was the end of the chrome:
 * a single toolbar with the page's own header below it. Weak edges count here: after scaling, a hairline is faint.
 */
function chromeEnd(p: Pixels, prof: Float64Array, e: Float64Array, first: number, end: number, H: number): number {
  const WEAK = 15;
  const reach = Math.max(4, Math.round(H * 0.06));
  const field = Math.max(3, Math.round(H * 0.012));
  const returnsTo = (from: number, base: number) => {
    for (let k = from; k <= Math.min(end, from + reach); k++) if (dist(prof, k, base) <= 10) return k;
    return -1;
  };
  let fieldSeen = false;
  let base: number;
  let i: number;
  // The first edge may itself be the top of the address field (no tab strip): the band comes back to what was above.
  const back0 = first - 1 >= 0 ? returnsTo(first + 1, first - 1) : -1;
  if (back0 >= 0 && back0 - first >= field && wideness(p, Math.floor((first + back0) / 2), first - 1) > 0.5) {
    fieldSeen = true;
    base = first - 1;
    i = back0;
  } else {
    let s = first;
    while (s < Math.min(first + 3, end) && e[s]! >= WEAK) s++; // finish the step into the toolbar
    base = s;
    i = s;
    // Or it was the bottom of an address field that starts near the very top (a toolbar without a tab strip):
    // below it is the toolbar's colour again, the same as at the top of the frame.
    const top = Math.max(0, Math.round(H * 0.005));
    if (first - top >= field && dist(prof, base, top) <= 10 && wideness(p, first - 2, base) > 0.5) fieldSeen = true;
  }
  for (; i < end; i++) {
    if (e[i]! < WEAK) continue;
    const back = returnsTo(i + 1, base);
    if (back >= 0) {
      const h = back - (i + 1);
      if (h <= 3) return fieldSeen ? back : first; // the hairline under the toolbar
      if (h >= field && wideness(p, Math.floor((i + 1 + back) / 2), base) > 0.5) fieldSeen = true; // the address field
      else if (!fieldSeen) return first; // buttons or text: this is already the page
      i = back - 1;
      continue;
    }
    return fieldSeen && e[i]! >= EDGE * 0.6 ? i + 1 : first; // the page
  }
  return first;
}

/** One frame's guess, in pixels of that frame (null = no bar on that side). `topLimit`: the page starts by this row. */
export function measureFrame(p: Pixels, topLimit?: number): { top: number | null; left: number | null; right: number | null } {
  const { width: W, height: H } = p;
  // The top bar is looked for across the middle and right of the frame, clear of a vertical tab bar.
  const py = profile(p, 'y', W * 0.35, W * 0.95);
  const ey = edges(py);
  const first = forward(ey, Math.round(H * 0.025), Math.round(H * 0.2));
  const top = first === null ? null : chromeEnd(p, py, ey, first, Math.min(ey.length, Math.round(first + H * 0.1), Math.round(H * 0.2), Math.max(first, topLimit ?? Infinity)), H);
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

/**
 * The first row (from 2.5% down) where the sampled frames clearly differ: the page, since the browser's own bars stay
 * the same: most of the row changes, not just a URL or a tab title. Undefined when the frames are too few, of
 * different sizes, or alike.
 */
function firstChangingRow(frames: Pixels[]): number | undefined {
  if (frames.length < 3) return undefined;
  const { width: W, height: H } = frames[0]!;
  if (frames.some((f) => f.width !== W || f.height !== H)) return undefined;
  for (let y = Math.round(H * 0.025); y < Math.round(H * 0.3); y++) {
    // a changing URL or tab title touches a few columns; a page that scrolls or changes touches most of them
    let changed = 0;
    let n = 0;
    for (let x = 0; x < W; x += 4) {
      let lo = 255;
      let hi = 0;
      for (const f of frames) {
        const k = (y * W + x) * 4;
        const v = (f.data[k]! + f.data[k + 1]! + f.data[k + 2]!) / 3;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > 24) changed++;
      n++;
    }
    if (changed / n > 0.4) return y;
  }
  return undefined;
}

/** The browser bars across sampled frames, as fractions of the frame; null when none was found. */
export function findBrowserBars(frames: Pixels[]): BarInsets | null {
  if (!frames.length) return null;
  const W = frames[0]!.width;
  const H = frames[0]!.height;
  const limit = firstChangingRow(frames);
  const each = frames.map((f) => measureFrame(f, limit));
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
