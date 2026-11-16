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

/**
 * A Chrome-style top: a tab strip, then a toolbar with an address field holding some text (light theme: a white
 * toolbar and a hairline under it; dark theme: no hairline, the field barely darker than the toolbar), then the page
 * with its own header. 640×360, chrome 40 px tall. `scroll` moves the page body, as a recording would.
 */
function chrome(theme: 'light' | 'dark', scroll = 0): Pixels {
  const width = 640;
  const height = 360;
  const data = new Uint8ClampedArray(width * height * 4);
  const T = theme === 'light'
    ? { strip: [222, 225, 230], tool: [255, 255, 255], field: [241, 243, 244], text: [60, 64, 67], line: [218, 220, 224] }
    : { strip: [32, 33, 36], tool: [53, 54, 58], field: [45, 46, 50], text: [236, 238, 242], line: null };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let c: number[];
      if (y < 17) c = x > 37 && x < 120 && y > 4 ? T.tool : T.strip; // the tab strip, with the active tab
      else if (y < 40) {
        c = T.tool;
        if (y >= 24 && y < 38 && x > 50 && x < 600) c = T.field; // the address field
        if (y >= 29 && y < 33 && x > 60 && x < 300 && x % 3 === 0) c = T.text; // its URL text
        if (y === 39 && T.line) c = T.line; // the hairline
      } else if (y < 60) c = y === 59 ? [229, 229, 229] : [255, 255, 255]; // the page's own header
      else c = ((x + y + scroll) % 41 < 3) ? [120, 120, 130] : [246, 246, 248]; // the page body
      const k = (y * width + x) * 4;
      data[k] = c[0]!;
      data[k + 1] = c[1]!;
      data[k + 2] = c[2]!;
      data[k + 3] = 255;
    }
  return { data, width, height };
}

describe('Chrome-style tabs and address bar', () => {
  it('crops the whole chrome, not just the tab strip (light, with a hairline)', () => {
    const r = findBrowserBars([chrome('light', 0), chrome('light', 9), chrome('light', 20)])!;
    expect(r.top * 360).toBeGreaterThanOrEqual(39);
    expect(r.top * 360).toBeLessThanOrEqual(41);
  });
  it('crops the whole chrome (dark, the address field barely darker than the toolbar)', () => {
    const r = findBrowserBars([chrome('dark', 0), chrome('dark', 9), chrome('dark', 20)])!;
    expect(r.top * 360).toBeGreaterThanOrEqual(39);
    expect(r.top * 360).toBeLessThanOrEqual(41);
  });
  it('stops at the chrome even when the page never changes', () => {
    const r = findBrowserBars([chrome('dark'), chrome('dark'), chrome('dark')])!;
    expect(r.top * 360).toBeGreaterThanOrEqual(39);
    expect(r.top * 360).toBeLessThanOrEqual(41);
  });
});

/** Paint helper: a 640×360 frame from a function of (x, y) to a colour. */
function paint(fn: (x: number, y: number) => number[]): Pixels {
  const width = 640;
  const height = 360;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = fn(x, y);
      const k = (y * width + x) * 4;
      data[k] = c[0]!;
      data[k + 1] = c[1]!;
      data[k + 2] = c[2]!;
      data[k + 3] = 255;
    }
  return { data, width, height };
}

describe('toolbars without a tab strip', () => {
  it('a single toolbar over a website with its own header and buttons: stops at the toolbar', () => {
    const f = paint((x, y) => {
      if (y < 15) return y > 3 && y < 12 && x > 60 && x < 560 ? [250, 228, 226] : [244, 214, 212]; // toolbar with its field
      if (y < 36) return x > 560 && x < 600 && y > 20 && y < 30 ? [77, 46, 245] : [246, 244, 239]; // the site's header, a button
      if (y === 36) return [225, 222, 216]; // the header's bottom border
      return (x + y) % 37 < 2 ? [90, 90, 100] : [246, 244, 239];
    });
    const r = findBrowserBars([f, f, f])!;
    expect(r.top * 360).toBeCloseTo(15, 0);
  });
  it('a Safari-style toolbar whose first edge is the top of the address field: crops the whole toolbar', () => {
    const f = paint((x, y) => {
      if (y < 30) {
        if (y >= 8 && y < 22 && x > 40 && x < 610) return y >= 13 && y < 17 && x % 3 === 0 && x < 300 ? [40, 40, 40] : [228, 228, 230]; // the field
        return y === 29 ? [200, 200, 204] : [246, 246, 246]; // toolbar, hairline
      }
      return (x * 3 + y) % 53 < 2 ? [60, 60, 70] : [255, 255, 255];
    });
    const r = findBrowserBars([f, f, f])!;
    expect(r.top * 360).toBeGreaterThanOrEqual(29);
    expect(r.top * 360).toBeLessThanOrEqual(31);
  });
});
