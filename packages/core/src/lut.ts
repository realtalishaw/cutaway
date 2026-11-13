/**
 * Colour lookup tables (.cube) and the per-layer "grade": an unsharp mask
 * followed by the LUT. Pure: the parser validates a file, `gradePixels` is the
 * reference implementation the GPU pass in the app has to match.
 */
import type { Appearance, LayerGrade } from './types';

export interface Lut {
  title: string;
  kind: '1d' | '3d';
  /** Entries per axis. */
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** RGB triplets. 3D tables are ordered red fastest, then green, then blue (the .cube order). */
  data: Float32Array;
}

export class LutError extends Error {
  code = 'bad-lut';
}

export const LUT_MAX_3D = 65;
export const LUT_MAX_1D = 65536;

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function triple(parts: string[], line: number, what: string): [number, number, number] {
  if (parts.length < 3 || !parts.slice(0, 3).every((p) => NUM.test(p))) throw new LutError(`Line ${line}: ${what} needs three numbers.`);
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Parse an Adobe/Resolve .cube file. Throws LutError with a message a person can act on. */
export function parseCube(text: string): Lut {
  if (text.indexOf('\0') >= 0) throw new LutError('This is not a text .cube file.');
  let title = '';
  let kind: Lut['kind'] | null = null;
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let data: Float32Array | null = null;
  let filled = 0;
  let expected = 0;
  let lineNo = 0;
  let start = 0;
  const len = text.length;
  while (start <= len) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = len;
    lineNo++;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line || line.charCodeAt(0) === 35 /* # */) continue;
    const c = line.charCodeAt(0);
    const numeric = (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43;
    if (!numeric) {
      const sp = line.search(/\s/);
      const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
      if (key === 'TITLE') title = rest.replace(/^"(.*)"$/, '$1').slice(0, 120);
      else if (key === 'LUT_1D_SIZE' || key === 'LUT_3D_SIZE') {
        if (kind) throw new LutError(key.includes(kind.toUpperCase()) ? `Line ${lineNo}: the table size is declared twice.` : 'This file combines a 1D and a 3D table, which Cutaway does not support. Export it as a single 3D LUT.');
        if (filled) throw new LutError(`Line ${lineNo}: the table size must come before the table.`);
        kind = key === 'LUT_1D_SIZE' ? '1d' : '3d';
        size = /^\d+$/.test(rest) ? Number(rest) : NaN;
        const max = kind === '1d' ? LUT_MAX_1D : LUT_MAX_3D;
        if (!Number.isInteger(size) || size < 2) throw new LutError(`Line ${lineNo}: the table size must be a whole number of 2 or more.`);
        if (size > max) throw new LutError(kind === '3d' ? `This 3D LUT is ${size}×${size}×${size}; the largest Cutaway reads is ${LUT_MAX_3D}.` : `This 1D LUT has ${size} entries; the largest Cutaway reads is ${LUT_MAX_1D}.`);
        expected = kind === '1d' ? size : size * size * size;
        data = new Float32Array(expected * 3);
      } else if (key === 'DOMAIN_MIN') domainMin = triple(rest.split(/\s+/), lineNo, 'DOMAIN_MIN');
      else if (key === 'DOMAIN_MAX') domainMax = triple(rest.split(/\s+/), lineNo, 'DOMAIN_MAX');
      else if (key === 'LUT_1D_INPUT_RANGE' || key === 'LUT_3D_INPUT_RANGE') {
        const p = rest.split(/\s+/);
        if (p.length < 2 || !NUM.test(p[0]!) || !NUM.test(p[1]!)) throw new LutError(`Line ${lineNo}: ${key} needs two numbers.`);
        domainMin = [Number(p[0]), Number(p[0]), Number(p[0])];
        domainMax = [Number(p[1]), Number(p[1]), Number(p[1])];
      } else throw new LutError(`Line ${lineNo}: "${key.slice(0, 40)}" is not part of the .cube format.`);
      continue;
    }
    if (!data) throw new LutError('The file has colour values before LUT_1D_SIZE or LUT_3D_SIZE.');
    if (filled >= expected) throw new LutError(`The table has more than the ${expected} rows its size calls for.`);
    const [r, g, b] = triple(line.split(/\s+/), lineNo, 'a table row');
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) throw new LutError(`Line ${lineNo}: a value is not a finite number.`);
    data[filled * 3] = r;
    data[filled * 3 + 1] = g;
    data[filled * 3 + 2] = b;
    filled++;
  }
  if (!kind || !data) throw new LutError('No LUT_1D_SIZE or LUT_3D_SIZE line was found. Is this a .cube file?');
  if (filled !== expected) throw new LutError(`The table has ${filled} rows but its size calls for ${expected}. The file may be cut short.`);
  for (let i = 0; i < 3; i++) if (!(domainMax[i]! > domainMin[i]!)) throw new LutError('DOMAIN_MAX must be greater than DOMAIN_MIN.');
  return { title, kind, size, domainMin, domainMax, data };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Look one colour (0–1 per channel) up in the table: linear for 1D, trilinear for 3D. */
export function sampleLut(lut: Lut, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const d = lut.data;
  const pr = clamp01((r - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0])) * (n - 1);
  const pg = clamp01((g - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1])) * (n - 1);
  const pb = clamp01((b - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2])) * (n - 1);
  const r0 = Math.min(n - 2, Math.floor(pr));
  const g0 = Math.min(n - 2, Math.floor(pg));
  const b0 = Math.min(n - 2, Math.floor(pb));
  const fr = pr - r0;
  const fg = pg - g0;
  const fb = pb - b0;
  if (lut.kind === '1d') {
    return [d[r0 * 3]! * (1 - fr) + d[(r0 + 1) * 3]! * fr, d[g0 * 3 + 1]! * (1 - fg) + d[(g0 + 1) * 3 + 1]! * fg, d[b0 * 3 + 2]! * (1 - fb) + d[(b0 + 1) * 3 + 2]! * fb];
  }
  const out: [number, number, number] = [0, 0, 0];
  const n2 = n * n;
  for (let k = 0; k < 2; k++) {
    const wb = k ? fb : 1 - fb;
    if (wb === 0) continue;
    for (let j = 0; j < 2; j++) {
      const wg = j ? fg : 1 - fg;
      if (wg === 0) continue;
      const base = ((b0 + k) * n2 + (g0 + j) * n + r0) * 3;
      const w0 = wb * wg * (1 - fr);
      const w1 = wb * wg * fr;
      out[0] += d[base]! * w0 + d[base + 3]! * w1;
      out[1] += d[base + 1]! * w0 + d[base + 4]! * w1;
      out[2] += d[base + 2]! * w0 + d[base + 5]! * w1;
    }
  }
  return out;
}

// ───────────────────────────── grade ─────────────────────────────

export const GRADE_DEFAULT: LayerGrade = { lut: null, strength: 1, sharpen: 0 };
/** How much of the removed blur an unsharp mask at full strength adds back. */
export const SHARPEN_GAIN = 2.5;

export function gradeOf(ap: Appearance): { screen: LayerGrade; camera: LayerGrade } {
  return { screen: { ...GRADE_DEFAULT, ...ap.grade?.screen }, camera: { ...GRADE_DEFAULT, ...ap.grade?.camera } };
}

/** Does this layer need the grade pass at all? */
export function gradeActive(g: LayerGrade, lutLoaded: boolean): boolean {
  return g.sharpen > 0.005 || (lutLoaded && g.strength > 0.005);
}

export interface GradeParams {
  lut: Lut | null;
  /** 0–1 mix between the original and the LUT result. */
  strength: number;
  /** 0–1 unsharp-mask amount. */
  sharpen: number;
  /** Unsharp radius in pixels of the image being processed (≥ 1). */
  radius: number;
}

/**
 * Reference grade on RGBA bytes, in place: 3×3 Gaussian unsharp mask at
 * `radius`, then the LUT mixed in by `strength`. Alpha is left alone.
 */
export function gradePixels(px: Uint8ClampedArray, width: number, height: number, p: GradeParams): void {
  const useLut = !!p.lut && p.strength > 0.005;
  const amount = p.sharpen > 0.005 ? p.sharpen * SHARPEN_GAIN : 0;
  if (!useLut && !amount) return;
  const src = amount ? new Uint8ClampedArray(px) : px;
  const rad = Math.max(1, Math.round(p.radius));
  const s = p.strength;
  for (let y = 0; y < height; y++) {
    const yu = Math.max(0, y - rad) * width;
    const yd = Math.min(height - 1, y + rad) * width;
    const yc = y * width;
    for (let x = 0; x < width; x++) {
      const i = (yc + x) * 4;
      let r = src[i]! / 255;
      let g = src[i + 1]! / 255;
      let b = src[i + 2]! / 255;
      if (amount) {
        const xl = Math.max(0, x - rad);
        const xr = Math.min(width - 1, x + rad);
        for (let c = 0; c < 3; c++) {
          const at = (row: number, col: number) => src[(row + col) * 4 + c]!;
          const blur = (4 * at(yc, x) + 2 * (at(yc, xl) + at(yc, xr) + at(yu, x) + at(yd, x)) + at(yu, xl) + at(yu, xr) + at(yd, xl) + at(yd, xr)) / (16 * 255);
          const v = src[i + c]! / 255;
          const sharp = clamp01(v + (v - blur) * amount);
          if (c === 0) r = sharp;
          else if (c === 1) g = sharp;
          else b = sharp;
        }
      }
      if (useLut) {
        const o = sampleLut(p.lut!, r, g, b);
        r += (clamp01(o[0]) - r) * s;
        g += (clamp01(o[1]) - g) * s;
        b += (clamp01(o[2]) - b) * s;
      }
      px[i] = Math.round(r * 255);
      px[i + 1] = Math.round(g * 255);
      px[i + 2] = Math.round(b * 255);
    }
  }
}

/**
 * An appearance that can be saved as a preset and applied to another project:
 * references to files inside this project's folder are dropped.
 */
export function portableAppearance(ap: Appearance): Appearance {
  let out = ap;
  if (ap.grade) {
    const strip = (g: LayerGrade | undefined) => (g ? { ...g, lut: null } : g);
    out = { ...out, grade: { screen: strip(ap.grade.screen), camera: strip(ap.grade.camera) } };
  }
  if (ap.background.type === 'image' && !ap.background.path.startsWith('/')) out = { ...out, background: { type: 'wallpaper', id: 'dusk-1', blur: 0 } };
  return out;
}

// ───────────────────────────── default zoom ─────────────────────────────

export const ZOOM_LEVEL_DEFAULT = 1.8;
export const ZOOM_LEVEL_MIN = 1.1;
export const ZOOM_LEVEL_MAX = 4;

/** The project's default zoom: what a new zoom starts at, by hand or from the automatic pass. */
export function zoomLevelOf(ap: Pick<Appearance, 'zoomLevel'>): number {
  const z = ap.zoomLevel;
  return typeof z === 'number' && Number.isFinite(z) ? Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, z)) : ZOOM_LEVEL_DEFAULT;
}
