import { describe, expect, it } from 'vitest';
import { findBrowserBars, type Pixels } from './browserBar';

/** A 640×360 frame: a toolbar band on top, a tab bar on the left, a dark strip on the right, and a page of `page` colour. */
function frame(opts: { top: number; left: number; right: number; bar: [number, number, number]; page: [number, number, number]; noise?: number }): Pixels {
  const width = 640;
  const height = 360;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const inBar = y < opts.top || x < opts.left;
      const inStrip = x >= width - opts.right;
      const c = inStrip ? [0, 0, 0] : inBar ? opts.bar : opts.page;
      // a little page detail, so the page is not one flat colour
      const d = !inBar && !inStrip && opts.noise && (x * 7 + y * 13) % 97 === 0 ? opts.noise : 0;
      data[k] = c[0]! - d;
      data[k + 1] = c[1]! - d;
      data[k + 2] = c[2]! - d;
      data[k + 3] = 255;
    }
  return { data, width, height };
}

describe('findBrowserBars', () => {
  it('finds the toolbar, side bar and right strip that most frames agree on', () => {
    const light = frame({ top: 16, left: 18, right: 28, bar: [230, 200, 196], page: [246, 244, 239], noise: 30 });
    const dark = frame({ top: 16, left: 18, right: 28, bar: [40, 40, 44], page: [20, 20, 24], noise: 0 });
    const fullscreen = frame({ top: 0, left: 0, right: 0, bar: [0, 0, 0], page: [90, 60, 160] });
    const r = findBrowserBars([light, light, dark, light, fullscreen])!;
    expect(r.top * 360).toBeCloseTo(16, 0);
    expect(r.left * 640).toBeCloseTo(18, 0);
    expect(r.right * 640).toBeCloseTo(28, 0);
    expect(r.bottom).toBe(0);
  });

  it('finds nothing in a recording without browser bars', () => {
    const plain = frame({ top: 0, left: 0, right: 0, bar: [0, 0, 0], page: [120, 120, 120], noise: 20 });
    expect(findBrowserBars([plain, plain, plain])).toBeNull();
  });
});
