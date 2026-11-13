import { describe, expect, it } from 'vitest';
import {
  TimeMap,
  activeShortcuts,
  applyOps,
  buildCursorTrack,
  buildFaceTrack,
  cameraLookOf,
  clickTick,
  createProject,
  cursorAt,
  defaultAppearance,
  defaultSync,
  detectTyping,
  deviceKindFor,
  evaluateFrame,
  faceAt,
  faceCrop,
  layoutGeometry,
  lookFilter,
  lookWarmth,
  motionBlurOf,
  shortcutCaps,
  shortcutId,
  shortcutsOf,
  suppressShake,
  typingSpeedOps,
  type CursorSample,
  type KeyStroke,
  type MediaSource,
  type Project,
} from '../src';

function src(role: MediaSource['role'], duration: number, extra: Partial<MediaSource> = {}): MediaSource {
  return { id: `src_${role}`, role, name: role, path: `/tmp/${role}.mov`, managed: false, origin: 'recording', kind: 'video', duration, width: 1920, height: 1080, fps: 30, hasAudio: false, fingerprint: { sizeBytes: 1, duration }, available: true, cursorBaked: false, sync: defaultSync('reference'), gaps: [], ...extra };
}
const project = (): Project => createProject('p', [src('screen', 60), src('cameraA', 60)]);
const ctxOf = (p: Project, extra: object = {}) => ({ project: p, map: TimeMap.fromEdit(p.duration, p.edit), cursor: null, follow: null, screenAspect: 16 / 9, ...extra });
const sweep = (): CursorSample[] => Array.from({ length: 600 }, (_, i) => ({ t: i / 60, x: 0.1 + (0.8 * i) / 600, y: 0.5, e: 'move' as const, c: i > 300 ? 'pointer' : 'arrow' }));

describe('old projects keep loading', () => {
  it('applies defaults for every optional parity field', () => {
    const ap = defaultAppearance();
    expect(motionBlurOf(ap)).toEqual({ amount: 0, cursor: true, animation: true });
    expect(shortcutsOf(ap).show).toBe(false);
    expect(lookFilter(cameraLookOf(ap))).toBe('none');
    expect(lookWarmth(cameraLookOf(ap))).toBeNull();
    const f = evaluateFrame(ctxOf(project()), 5);
    expect(f.blur).toEqual([]);
    expect(f.lens).toBeNull();
    expect(f.shortcuts).toEqual([]);
  });
});

describe('motion blur', () => {
  const withZoom = (amount: number) => {
    let p = project();
    p = { ...p, edit: applyOps(p.edit, [{ op: 'zoom', start: 10, end: 16, scale: 2, x: 0.8, y: 0.2, follow: false }], 'creator', 2) };
    p = { ...p, edit: { ...p.edit, appearance: { ...p.edit.appearance, motionBlur: { amount, cursor: true, animation: true } } } };
    return p;
  };
  it('samples earlier poses only while something moves', () => {
    const p = withZoom(1);
    const moving = evaluateFrame(ctxOf(p, { quality: 'export' }), 10.3);
    expect(moving.blur.length).toBe(9);
    expect(moving.blur[0]!.screen.zoom.scale).toBeLessThan(moving.screen!.zoom.scale);
    for (let i = 1; i < moving.blur.length; i++) expect(moving.blur[i]!.screen.zoom.scale).toBeGreaterThanOrEqual(moving.blur[i - 1]!.screen.zoom.scale);
    expect(evaluateFrame(ctxOf(p, { quality: 'export' }), 13).blur).toEqual([]); // fully zoomed, holding still
    expect(evaluateFrame(ctxOf(p, { quality: 'preview' }), 10.3).blur.length).toBe(4);
  });
  it('is off at amount 0 and is deterministic', () => {
    expect(evaluateFrame(ctxOf(withZoom(0), { quality: 'export' }), 10.3).blur).toEqual([]);
    const c = ctxOf(withZoom(0.6), { quality: 'export' });
    expect(evaluateFrame(c, 10.31)).toEqual(evaluateFrame(c, 10.31));
  });
  it('smears a moving cursor and leaves a resting one alone', () => {
    let p = withZoom(1);
    const track = buildCursorTrack(sweep(), 0.2);
    const moving = evaluateFrame(ctxOf(p, { cursor: track, quality: 'export' }), 4);
    expect(moving.cursor!.trail.length).toBe(24);
    expect(moving.cursor!.trail[0]!.x).toBeLessThan(moving.cursor!.x);
    const still = buildCursorTrack([{ t: 0, x: 0.5, y: 0.5, e: 'move' }, { t: 10, x: 0.5, y: 0.5, e: 'move' }], 0.2);
    expect(evaluateFrame(ctxOf(p, { cursor: still, quality: 'export' }), 4).cursor!.trail).toEqual([]);
    p = { ...p, edit: { ...p.edit, appearance: { ...p.edit.appearance, motionBlur: { amount: 1, cursor: false, animation: true } } } };
    expect(evaluateFrame(ctxOf(p, { cursor: track, quality: 'export' }), 4).cursor!.trail).toEqual([]);
  });
});

describe('zoom styles', () => {
  const zoomed = (style: 'zoom' | 'magnifier' | 'instant') => {
    let p = project();
    p = { ...p, edit: applyOps(p.edit, [{ op: 'zoom', start: 10, end: 16, scale: 2.5, x: 0.3, y: 0.6, follow: false }], 'creator', 2) };
    return { ...p, edit: { ...p.edit, zooms: p.edit.zooms.map((z) => ({ ...z, style, lensSize: 0.4 })) } };
  };
  it('magnifier keeps the frame at 1× and exposes a lens', () => {
    const f = evaluateFrame(ctxOf(zoomed('magnifier')), 13);
    expect(f.screen!.zoom.scale).toBe(1);
    expect(f.lens).toMatchObject({ x: 0.3, y: 0.6, size: 0.4, magnification: 2.5, amount: 1 });
    expect(evaluateFrame(ctxOf(zoomed('magnifier')), 20).lens).toBeNull();
  });
  it('instant jumps without animation, zoom eases', () => {
    expect(evaluateFrame(ctxOf(zoomed('instant')), 10.02).screen!.zoom.scale).toBe(2.5);
    expect(evaluateFrame(ctxOf(zoomed('instant')), 9.98).screen!.zoom.scale).toBe(1);
    const eased = evaluateFrame(ctxOf(zoomed('zoom')), 10.1).screen!.zoom.scale;
    expect(eased).toBeGreaterThan(1);
    expect(eased).toBeLessThan(2.5);
  });
});

describe('cursor options', () => {
  it('reports the recorded cursor type and leans into movement', () => {
    const track = buildCursorTrack(sweep(), 0.2);
    expect(cursorAt(track, 2)!.kind).toBe('arrow');
    expect(cursorAt(track, 8)!.kind).toBe('pointer');
    expect(cursorAt(track, 5)!.vx).toBeGreaterThan(0);
    let p = project();
    p = { ...p, edit: { ...p.edit, appearance: { ...p.edit.appearance, cursor: { ...p.edit.appearance.cursor, rotate: true, style: 'arrow' } } } };
    const f = evaluateFrame(ctxOf(p, { cursor: track }), 8);
    expect(f.cursor!.kind).toBe('arrow'); // "always use default pointer"
    expect(f.cursor!.angle).toBeGreaterThan(0);
    expect(Math.abs(f.cursor!.angle)).toBeLessThanOrEqual(0.25);
  });
  it('suppresses tremor but keeps real movement and clicks', () => {
    const jitter: CursorSample[] = Array.from({ length: 100 }, (_, i) => ({ t: i / 60, x: 0.5 + (i % 2 ? 0.001 : -0.001), y: 0.5, e: 'move' as const }));
    const calm = suppressShake(jitter);
    expect(new Set(calm.map((s) => s.x)).size).toBe(1);
    const moved = suppressShake([...jitter, { t: 2, x: 0.7, y: 0.5, e: 'move' }, { t: 2.1, x: 0.7005, y: 0.5, e: 'down' }]);
    expect(moved[moved.length - 2]!.x).toBe(0.7);
    expect(moved[moved.length - 1]!.x).toBe(0.7005);
  });
  it('loops back to the starting position', () => {
    const track = buildCursorTrack(sweep(), 0.2, 120, { loop: true });
    const end = cursorAt(track, 10)!;
    const start = cursorAt(track, 0)!;
    expect(end.x).toBeCloseTo(start.x, 3);
    expect(cursorAt(buildCursorTrack(sweep(), 0.2), 10)!.x).toBeGreaterThan(0.8);
  });
});

describe('shortcut overlay', () => {
  const keys: KeyStroke[] = [
    { t: 1, e: 'shortcut', keys: ['k', 'cmd'] },
    { t: 1.1, e: 'type' },
    { t: 5, e: 'shortcut', keys: ['shift', 'cmd', '4'] },
  ];
  it('orders caps the macOS way and never shows typing', () => {
    expect(shortcutCaps(['4', 'cmd', 'shift'])).toEqual(['⇧', '⌘', '4']);
    expect(shortcutCaps(['escape'])).toEqual(['esc']);
    expect(activeShortcuts(keys, 1.3).map((s) => s.caps)).toEqual([['⌘', 'K']]);
    expect(activeShortcuts(keys, 3)).toEqual([]);
    expect(activeShortcuts(keys, 5.5, [shortcutId(keys[2] as { t: number; keys: string[] })])).toEqual([]);
  });
  it('reaches the frame only when switched on', () => {
    let p = project();
    expect(evaluateFrame(ctxOf(p, { keys }), 1.3).shortcuts).toEqual([]);
    p = { ...p, edit: { ...p.edit, appearance: { ...p.edit.appearance, shortcuts: { show: true, size: 1, position: 'bottom', hidden: [] } } } };
    expect(evaluateFrame(ctxOf(p, { keys }), 1.3).shortcuts[0]!.caps).toEqual(['⌘', 'K']);
  });
});

describe('typing speed-up', () => {
  const ticks = (from: number, to: number, step = 0.2): KeyStroke[] => Array.from({ length: Math.floor((to - from) / step) }, (_, i) => ({ t: from + i * step, e: 'type' as const }));
  it('finds dense stretches and ignores scattered keys', () => {
    const r = detectTyping([...ticks(5, 12), { t: 20, e: 'type' }, { t: 26, e: 'type' }, ...ticks(40, 41)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.start).toBeCloseTo(4.85, 2);
    expect(r[0]!.end).toBeGreaterThan(11.5);
  });
  it('never speeds up inside a lock or an existing speed change', () => {
    const ops = typingSpeedOps([{ start: 5, end: 12 }], [{ start: 7, end: 9 }], 2);
    expect(ops.map((o) => [o.start, o.end])).toEqual([[5, 7], [9, 12]]);
    expect(ops.every((o) => o.op === 'speed' && o.speed === 2)).toBe(true);
    expect(typingSpeedOps([{ start: 5, end: 12 }], [{ start: 4, end: 13 }])).toEqual([]);
  });
});

describe('click sound', () => {
  it('is a short deterministic tick', () => {
    const a = clickTick(48000);
    expect(a.length).toBe(1440);
    expect(Array.from(a)).toEqual(Array.from(clickTick(48000)));
    const peak = a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(1);
    expect(Math.abs(a[a.length - 1]!)).toBeLessThan(0.01);
  });
});

describe('face tracking', () => {
  it('smooths a jittery track, holds through gaps and keeps the crop inside the frame', () => {
    const samples = Array.from({ length: 50 }, (_, i) => (i === 20 || i === 21 ? { t: i / 5, none: true as const } : { t: i / 5, x: 0.4 + (i % 2 ? 0.01 : -0.01) + (i > 30 ? 0.2 : 0), y: 0.2, w: 0.16, h: 0.22 }));
    const track = buildFaceTrack(samples, 5)!;
    expect(track).not.toBeNull();
    const early = faceAt(track, 3);
    expect(early.cx).toBeGreaterThan(0.45);
    expect(early.cx).toBeLessThan(0.51);
    expect(faceAt(track, 9.5).cx).toBeGreaterThan(0.62); // followed the move to the right
    const crop = faceCrop(faceAt(track, 9.5), { zoom: true, follow: true }, track.median);
    expect(crop.scale).toBeGreaterThan(1);
    expect(crop.cx - 0.5 / crop.scale).toBeGreaterThanOrEqual(0);
    expect(crop.cx + 0.5 / crop.scale).toBeLessThanOrEqual(1);
    expect(crop.cy - 0.5 / crop.scale).toBeGreaterThanOrEqual(0);
    expect(faceCrop(faceAt(track, 9.5), { zoom: true, follow: false }, track.median).cx).toBeCloseTo(faceCrop(faceAt(track, 1), { zoom: true, follow: false }, track.median).cx);
    expect(buildFaceTrack([{ t: 0, none: true }, { t: 1, none: true }], 5)).toBeNull();
  });
  it('gives the frame a camera crop only when a track exists', () => {
    let p = project();
    p = { ...p, edit: { ...p.edit, appearance: { ...p.edit.appearance, camera: { ...p.edit.appearance.camera, face: { zoom: true, follow: true } } } } };
    expect(evaluateFrame(ctxOf(p), 5).cameras[0]!.crop).toBeUndefined();
    const track = buildFaceTrack([{ t: 0, x: 0.3, y: 0.2, w: 0.15, h: 0.2 }, { t: 60, x: 0.3, y: 0.2, w: 0.15, h: 0.2 }], 5);
    expect(evaluateFrame(ctxOf(p, { faces: { A: track } }), 5).cameras[0]!.crop!.scale).toBeGreaterThan(1.5);
  });
});

describe('device frame', () => {
  it('shrinks the picture so the bezel fits inside the frame', () => {
    const ap = { ...defaultAppearance(), output: { width: 1920, height: 1080, fps: 30 } };
    const plain = layoutGeometry('screen', ap, 9 / 19.5).screen.rect;
    const framed = layoutGeometry('screen', ap, 9 / 19.5, 'phone').screen.rect;
    const e = 0.045 * framed.w;
    expect(framed.w).toBeLessThan(plain.w);
    expect(framed.y - e).toBeGreaterThanOrEqual(plain.y - 0.5);
    expect(framed.y + framed.h + e).toBeLessThanOrEqual(plain.y + plain.h + 0.5);
    const wide = layoutGeometry('screen', ap, 16 / 9, 'tablet').screen.rect;
    expect(wide.y - 0.035 * wide.w).toBeGreaterThanOrEqual(0);
    expect(wide.x - 0.035 * wide.w).toBeGreaterThanOrEqual(0);
  });
  it('is offered for device recordings and portrait screens only', () => {
    expect(deviceKindFor({ width: 1170, height: 2532 })).toBe('phone');
    expect(deviceKindFor({ width: 1640, height: 2360 })).toBe('tablet');
    expect(deviceKindFor({ width: 1920, height: 1080 })).toBeNull();
    expect(deviceKindFor({ width: 2360, height: 1640, deviceKind: 'ipad' })).toBe('tablet');
    expect(deviceKindFor(undefined)).toBeNull();
  });
});

describe('output shapes', () => {
  const shapes: [string, number, number][] = [['wide', 1920, 1080], ['vertical', 1080, 1920], ['square', 1080, 1080], ['classic', 1440, 1080], ['tall', 1080, 1350]];
  const inside = (r: { x: number; y: number; w: number; h: number }, W: number, H: number) => r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= W + 0.5 && r.y + r.h <= H + 0.5 && r.w > 0 && r.h > 0;
  it('keeps every layout inside the frame for every shape', () => {
    for (const [, W, H] of shapes) {
      const ap = { ...defaultAppearance(), output: { width: W, height: H, fps: 30 } };
      for (const mode of ['screen', 'overlay', 'camera', 'split'] as const) {
        const g = layoutGeometry(mode, ap, 16 / 9);
        if (mode !== 'camera') expect(inside(g.screen.rect, W, H)).toBe(true);
        if (mode !== 'screen') expect(inside(g.camera.rect, W, H)).toBe(true);
        // the screen picture keeps its own aspect
        if (mode !== 'camera') expect(g.screen.rect.w / g.screen.rect.h).toBeCloseTo(16 / 9, 2);
      }
    }
  });
  it('is unchanged for 16:9 and stacks the split in portrait', () => {
    const wide = { ...defaultAppearance(), output: { width: 1920, height: 1080, fps: 30 } };
    const o = layoutGeometry('overlay', wide, 16 / 9);
    expect(o.camera.rect.w).toBeCloseTo(wide.camera.size * 1080);
    const sWide = layoutGeometry('split', wide, 16 / 9);
    expect(sWide.camera.rect.x).toBeGreaterThan(sWide.screen.rect.x + sWide.screen.rect.w);
    const vert = { ...defaultAppearance(), output: { width: 1080, height: 1920, fps: 30 } };
    const sVert = layoutGeometry('split', vert, 16 / 9);
    expect(sVert.camera.rect.y).toBeGreaterThan(sVert.screen.rect.y + sVert.screen.rect.h);
    expect(sVert.camera.rect.w).toBeGreaterThan(sVert.camera.rect.h * 0.9);
    // the bubble is sized from the short side, so it is not tiny in portrait
    expect(layoutGeometry('overlay', vert, 16 / 9).camera.rect.w).toBeGreaterThan(wide.camera.size * 1080);
  });
});
