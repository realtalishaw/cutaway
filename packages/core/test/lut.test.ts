import { describe, expect, it } from 'vitest';
import {
  LUT_MAX_3D,
  LutError,
  ZOOM_LEVEL_DEFAULT,
  defaultAppearance,
  gradeActive,
  gradeOf,
  gradePixels,
  parseCube,
  portableAppearance,
  proposeZooms,
  sampleLut,
  zoomLevelOf,
  type Appearance,
  type Lut,
} from '../src';

/** A 3D .cube whose output is fn(r, g, b), red fastest as the format requires. */
function cube3(n: number, fn: (r: number, g: number, b: number) => [number, number, number], header = ''): string {
  const rows: string[] = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
  return `${header}LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`;
}

const close = (a: number[], b: number[], eps = 1e-4) => a.every((v, i) => Math.abs(v - b[i]!) <= eps);

describe('.cube parser', () => {
  it('reads a 3D table with title, comments, blank lines and CRLF', () => {
    const text = `# made by a test\r\nTITLE "Warm print"\r\n\r\nDOMAIN_MIN 0 0 0\r\nDOMAIN_MAX 1 1 1\r\n${cube3(2, (r, g, b) => [r, g, b]).replace(/\n/g, '\r\n')}`;
    const lut = parseCube(text);
    expect(lut).toMatchObject({ title: 'Warm print', kind: '3d', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });
    expect(lut.data.length).toBe(8 * 3);
    // second row is red = 1 (red varies fastest)
    expect([...lut.data.slice(3, 6)]).toEqual([1, 0, 0]);
  });

  it('reads a 1D table and Resolve input ranges', () => {
    const lut = parseCube('LUT_1D_SIZE 3\nLUT_1D_INPUT_RANGE 0.0 2.0\n0 0 0\n0.25 0.5 0.75\n1 1 1\n');
    expect(lut).toMatchObject({ kind: '1d', size: 3, domainMin: [0, 0, 0], domainMax: [2, 2, 2] });
    expect(close(sampleLut(lut, 1, 1, 1), [0.25, 0.5, 0.75])).toBe(true);
    expect(close(sampleLut(lut, 0.5, 0.5, 0.5), [0.125, 0.25, 0.375])).toBe(true);
  });

  it('accepts the largest supported 3D size and refuses anything bigger', () => {
    const big = parseCube(cube3(LUT_MAX_3D, (r, g, b) => [r, g, b]));
    expect(big.size).toBe(65);
    expect(big.data.length).toBe(65 ** 3 * 3);
    expect(() => parseCube('LUT_3D_SIZE 66\n')).toThrow(/largest Cutaway reads is 65/);
  });

  it('explains what is wrong with a broken file', () => {
    expect(() => parseCube('hello world\n')).toThrow(LutError);
    expect(() => parseCube('0 0 0\n')).toThrow(/before LUT_1D_SIZE or LUT_3D_SIZE/);
    expect(() => parseCube('# nothing\n')).toThrow(/Is this a \.cube file/);
    expect(() => parseCube(cube3(3, (r, g, b) => [r, g, b]).split('\n').slice(0, 20).join('\n'))).toThrow(/has 19 rows but its size calls for 27/);
    expect(() => parseCube(`${cube3(2, (r, g, b) => [r, g, b])}0 0 0\n`)).toThrow(/more than the 8 rows/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0\n')).toThrow(/Line 2: a table row needs three numbers/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 abc\n')).toThrow(/three numbers/);
    expect(() => parseCube('LUT_1D_SIZE 4\nLUT_3D_SIZE 2\n')).toThrow(/combines a 1D and a 3D/);
    expect(() => parseCube('LUT_3D_SIZE 1\n')).toThrow(/2 or more/);
    expect(() => parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n' + cube3(2, (r, g, b) => [r, g, b]).split('\n').slice(1).join('\n'))).toThrow(/DOMAIN_MAX must be greater/);
    expect(() => parseCube('LUT_3D_SIZE 2\0\n')).toThrow(/not a text/);
    const e = (() => { try { parseCube(''); } catch (x) { return x as LutError; } })();
    expect(e?.code).toBe('bad-lut');
  });
});

describe('LUT sampling', () => {
  const identity = parseCube(cube3(5, (r, g, b) => [r, g, b]));
  const swap = parseCube(cube3(9, (r, g, b) => [b, g, r])); // red ↔ blue
  const gamma = parseCube(cube3(17, (r, g, b) => [r * r, g * g, b * b]));

  it('an identity table returns the input, on and between grid points', () => {
    for (const c of [[0, 0, 0], [1, 1, 1], [0.25, 0.5, 0.75], [0.1, 0.37, 0.93], [0.999, 0.001, 0.5]] as const) expect(close(sampleLut(identity, c[0], c[1], c[2]), [...c])).toBe(true);
  });

  it('follows the table (channel swap) and interpolates between entries', () => {
    expect(close(sampleLut(swap, 1, 0, 0), [0, 0, 1])).toBe(true);
    expect(close(sampleLut(swap, 0.2, 0.6, 0.9), [0.9, 0.6, 0.2])).toBe(true);
    // a curved table is approximated between its 17 entries, within interpolation error
    const o = sampleLut(gamma, 0.5, 0.3, 0.8);
    expect(close(o, [0.25, 0.09, 0.64], 0.002)).toBe(true);
  });

  it('clamps colours outside the domain instead of reading past the table', () => {
    expect(close(sampleLut(swap, 2, -1, 0.5), [0.5, 0, 1])).toBe(true);
  });
});

describe('gradePixels', () => {
  const swap = parseCube(cube3(9, (r, g, b) => [b, g, r]));
  const solid = (w: number, h: number, rgb: [number, number, number]) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([...rgb, 255], i * 4);
    return px;
  };

  it('applies the LUT at full strength and mixes at partial strength', () => {
    const px = solid(4, 4, [200, 100, 50]);
    gradePixels(px, 4, 4, { lut: swap, strength: 1, sharpen: 0, radius: 1 });
    expect([...px.slice(0, 4)]).toEqual([50, 100, 200, 255]);
    const half = solid(4, 4, [200, 100, 50]);
    gradePixels(half, 4, 4, { lut: swap, strength: 0.5, sharpen: 0, radius: 1 });
    expect([...half.slice(0, 4)]).toEqual([125, 100, 125, 255]);
  });

  it('does nothing when there is nothing to apply', () => {
    const px = solid(3, 3, [10, 20, 30]);
    gradePixels(px, 3, 3, { lut: swap, strength: 0, sharpen: 0, radius: 1 });
    expect([...px.slice(0, 3)]).toEqual([10, 20, 30]);
    gradePixels(px, 3, 3, { lut: null, strength: 1, sharpen: 0, radius: 1 });
    expect([...px.slice(0, 3)]).toEqual([10, 20, 30]);
  });

  it('sharpening raises contrast across an edge and leaves flat areas alone', () => {
    const w = 8;
    const h = 4;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(x < 4 ? [100, 100, 100, 255] : [160, 160, 160, 255], (y * w + x) * 4);
    gradePixels(px, w, h, { lut: null, strength: 1, sharpen: 0.6, radius: 1 });
    const at = (x: number) => px[(1 * w + x) * 4]!;
    expect(at(0)).toBe(100); // flat
    expect(at(7)).toBe(160); // flat
    expect(at(3)).toBeLessThan(100); // dark side of the edge gets darker
    expect(at(4)).toBeGreaterThan(160); // bright side gets brighter
    expect(at(4) - at(3)).toBeGreaterThan(60 + 20);
  });
});

describe('grade settings', () => {
  it('defaults to no LUT and no sharpening, and is inactive', () => {
    const g = gradeOf(defaultAppearance());
    expect(g.screen).toEqual({ lut: null, strength: 1, sharpen: 0 });
    expect(gradeActive(g.screen, false)).toBe(false);
    expect(gradeActive({ ...g.screen, sharpen: 0.3 }, false)).toBe(true);
    expect(gradeActive({ ...g.screen, strength: 0 }, true)).toBe(false);
    expect(gradeActive(g.camera, true)).toBe(true);
  });

  it('a preset drops project-folder files but keeps the rest of the look', () => {
    const ref = { file: 'media/luts/Warm.cube', name: 'Warm', kind: '3d' as const, size: 33 };
    const ap: Appearance = { ...defaultAppearance(), grade: { screen: { lut: ref, strength: 0.7, sharpen: 0.4 }, camera: { lut: ref, strength: 1, sharpen: 0 } }, background: { type: 'image', path: 'media/backgrounds/unsplash-abc.jpg', blur: 0.2, credit: { source: 'unsplash', id: 'abc', author: 'A', authorUrl: '', pageUrl: '' } } };
    const p = portableAppearance(ap);
    expect(p.grade!.screen).toEqual({ lut: null, strength: 0.7, sharpen: 0.4 });
    expect(p.grade!.camera!.lut).toBeNull();
    expect(p.background.type).toBe('wallpaper');
    const abs: Appearance = { ...defaultAppearance(), background: { type: 'image', path: '/Users/someone/pic.jpg', blur: 0 } };
    expect(portableAppearance(abs).background).toEqual(abs.background);
    expect(portableAppearance(defaultAppearance())).toEqual(defaultAppearance());
  });
});

describe('default zoom level', () => {
  it('is 1.8 unless the project sets one, and stays inside 1.1–4', () => {
    expect(ZOOM_LEVEL_DEFAULT).toBe(1.8);
    expect(zoomLevelOf(defaultAppearance())).toBe(1.8);
    expect(zoomLevelOf({ zoomLevel: 2.4 })).toBe(2.4);
    expect(zoomLevelOf({ zoomLevel: 9 })).toBe(4);
    expect(zoomLevelOf({ zoomLevel: 0.5 })).toBe(1.1);
    expect(zoomLevelOf({ zoomLevel: Number.NaN })).toBe(1.8);
  });

  it('automatic zooms use the given level, and the intensity scale without one', () => {
    const clicks = [{ t: 5, x: 0.3, y: 0.4 }, { t: 6, x: 0.32, y: 0.42 }, { t: 30, x: 0.7, y: 0.6 }, { t: 31, x: 0.7, y: 0.62 }];
    const withLevel = proposeZooms(clicks, 60, 'balanced', 2.6);
    expect(withLevel.length).toBe(2);
    expect(withLevel.every((o) => o.op === 'zoom' && o.scale === 2.6)).toBe(true);
    const legacy = proposeZooms(clicks, 60, 'calm');
    expect(legacy.every((o) => o.op === 'zoom' && o.scale === 1.45)).toBe(true);
    // density still follows the intensity
    expect(proposeZooms([{ t: 5, x: 0.3, y: 0.4 }], 60, 'calm', 2.6).length).toBe(0);
  });
});

// keep the helper type referenced for editors that flag unused imports
export type { Lut };
