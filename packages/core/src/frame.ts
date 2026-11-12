import type { Appearance, BrollInsert, CameraSlot, CursorSample, LayoutMode, LayoutSegment, Mask, Overlay, Project, Rect, Seconds, Zoom } from './types';
import { at, clamp } from './ranges';
import { cameraSource, covers, sourceByRole } from './sync';
import { defaultLayoutMode } from './edit';
import type { TimeMap } from './timemap';

export const ease = (p: number): number => {
  const t = clamp(p, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
/** Slight overshoot for graphics entering. */
export const easeOutBack = (p: number): number => {
  const t = clamp(p, 0, 1);
  const c1 = 1.2;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

export const MOTION = {
  calm: { layout: 0.75, zoomIn: 0.9, zoomOut: 0.9 },
  balanced: { layout: 0.55, zoomIn: 0.65, zoomOut: 0.7 },
  lively: { layout: 0.4, zoomIn: 0.45, zoomOut: 0.5 },
} as const;

// ───────────────────────────── cursor ─────────────────────────────

export interface CursorTrack {
  hz: number;
  t0: Seconds;
  xs: Float32Array;
  ys: Float32Array;
  clicks: { t: Seconds; x: number; y: number }[];
  lastMove: Float32Array;
}

/**
 * Precompute a spring-smoothed cursor path. Being a pure function of the
 * recorded samples, preview and export draw the identical cursor.
 */
export function buildCursorTrack(samples: CursorSample[], smoothing: number, hz = 120): CursorTrack {
  const clicks = samples.filter((s) => s.e === 'down').map((s) => ({ t: s.t, x: s.x, y: s.y }));
  if (samples.length === 0) return { hz, t0: 0, xs: new Float32Array(0), ys: new Float32Array(0), clicks, lastMove: new Float32Array(0) };
  const t0 = samples[0]!.t;
  const t1 = samples[samples.length - 1]!.t;
  const n = Math.max(1, Math.ceil((t1 - t0) * hz) + 1);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const lastMove = new Float32Array(n);
  const omega = lerp(90, 9, clamp(smoothing, 0, 1)); // rad/s, critically damped
  let px = samples[0]!.x;
  let py = samples[0]!.y;
  let vx = 0;
  let vy = 0;
  let j = 0;
  let lastMoveT = t0;
  let prevRawX = px;
  let prevRawY = py;
  const dt = 1 / hz;
  const sub = 4;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    while (j < samples.length - 2 && samples[j + 1]!.t <= t) j++;
    const a = samples[j]!;
    const b = samples[Math.min(j + 1, samples.length - 1)]!;
    const span = b.t - a.t;
    const f = span > 1e-6 ? clamp((t - a.t) / span, 0, 1) : 0;
    const rx = lerp(a.x, b.x, f);
    const ry = lerp(a.y, b.y, f);
    if (Math.abs(rx - prevRawX) + Math.abs(ry - prevRawY) > 0.0015) lastMoveT = t;
    prevRawX = rx;
    prevRawY = ry;
    for (let s = 0; s < sub; s++) {
      const h = dt / sub;
      const ax = omega * omega * (rx - px) - 2 * omega * vx;
      const ay = omega * omega * (ry - py) - 2 * omega * vy;
      vx += ax * h;
      vy += ay * h;
      px += vx * h;
      py += vy * h;
    }
    xs[i] = px;
    ys[i] = py;
    lastMove[i] = lastMoveT;
  }
  return { hz, t0, xs, ys, clicks, lastMove };
}

export function cursorAt(track: CursorTrack, t: Seconds): { x: number; y: number; idleFor: Seconds } | null {
  const n = track.xs.length;
  if (n === 0) return null;
  const f = clamp((t - track.t0) * track.hz, 0, n - 1);
  const i = Math.floor(f);
  const k = Math.min(n - 1, i + 1);
  const u = f - i;
  return { x: lerp(track.xs[i]!, track.xs[k]!, u), y: lerp(track.ys[i]!, track.ys[k]!, u), idleFor: Math.max(0, t - track.lastMove[i]!) };
}

// ───────────────────────────── layout geometry ─────────────────────────────

export interface Placement {
  rect: Rect;
  opacity: number;
  radius: number;
}

export interface LayoutGeometry {
  screen: Placement;
  camera: Placement;
}

/** Where screen and camera sit, in output pixels, for one layout mode. */
export function layoutGeometry(mode: LayoutMode, ap: Appearance, screenAspect: number | null): LayoutGeometry {
  const W = ap.output.width;
  const H = ap.output.height;
  const pad = ap.frame.padding * H;
  const fit = (box: Rect, aspect: number): Rect => {
    let w = box.w;
    let h = w / aspect;
    if (h > box.h) {
      h = box.h;
      w = h * aspect;
    }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  };
  const aspect = screenAspect ?? W / H;
  const screenFull = fit({ x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad }, aspect);
  const screenRadius = pad > 0 ? ap.frame.radius * H : 0;

  const side = ap.camera.size * H;
  const margin = Math.max(pad * 0.55, 0.035 * H);
  const cx = ap.camera.corner.endsWith('r') ? W - margin - side : margin;
  const cy = ap.camera.corner.startsWith('b') ? H - margin - side : margin;
  const camOverlay: Rect = { x: cx, y: cy, w: side, h: side };
  const camRadius = ap.camera.shape === 'circle' ? side / 2 : ap.camera.shape === 'rounded' ? ap.camera.radius * side : 0.03 * side;
  const shrink = (r: Rect, s: number): Rect => ({ x: r.x + (r.w * (1 - s)) / 2, y: r.y + (r.h * (1 - s)) / 2, w: r.w * s, h: r.h * s });

  switch (mode) {
    case 'screen':
      return { screen: { rect: screenFull, opacity: 1, radius: screenRadius }, camera: { rect: shrink(camOverlay, 0.7), opacity: 0, radius: camRadius * 0.7 } };
    case 'overlay':
      return { screen: { rect: screenFull, opacity: 1, radius: screenRadius }, camera: { rect: camOverlay, opacity: 1, radius: camRadius } };
    case 'camera':
      return { screen: { rect: shrink(screenFull, 1.06), opacity: 0, radius: screenRadius }, camera: { rect: { x: 0, y: 0, w: W, h: H }, opacity: 1, radius: 0 } };
    case 'split': {
      const outer = Math.max(pad, 0.045 * H);
      const gap = 0.022 * W;
      const camW = W * 0.3;
      const camBox: Rect = { x: W - outer - camW, y: outer, w: camW, h: H - 2 * outer };
      const screenBox: Rect = { x: outer, y: outer, w: W - 2 * outer - camW - gap, h: H - 2 * outer };
      return { screen: { rect: fit(screenBox, aspect), opacity: 1, radius: ap.frame.radius * H }, camera: { rect: camBox, opacity: 1, radius: 0.03 * H } };
    }
  }
}

// ───────────────────────────── frame evaluation ─────────────────────────────

export interface ResolvedLayout {
  mode: LayoutMode;
  camera: CameraSlot;
  transition: 'cut' | 'smooth';
  /** Start of this layout decision in session time. */
  start: Seconds;
  /** A requested source had no footage here and nothing could replace it. */
  unresolved: boolean;
  /** The request was changed because a source had no coverage. */
  fellBack: boolean;
  segment: LayoutSegment | null;
}

type PLayout = Pick<Project, 'sources' | 'edit' | 'duration'>;

/**
 * Layout really used at a session time. A camera outside its usable coverage
 * is never shown: fall back to the other camera, then the screen, and only
 * then report an unresolved gap.
 */
export function resolveLayout(project: PLayout, t: Seconds): ResolvedLayout {
  const seg = at(project.edit.layouts, t) ?? null;
  let mode: LayoutMode = seg?.mode ?? defaultLayoutMode(project.sources);
  let camera: CameraSlot = seg?.camera ?? (cameraSource(project, 'A') ? 'A' : 'B');
  const screen = sourceByRole(project, 'screen');
  const screenOk = covers(screen, t);
  const camOk = (slot: CameraSlot) => covers(cameraSource(project, slot), t);
  let fellBack = false;
  let unresolved = false;
  if (mode !== 'screen' && !camOk(camera)) {
    const other: CameraSlot = camera === 'A' ? 'B' : 'A';
    if (camOk(other)) {
      camera = other;
      fellBack = true;
    } else if (screenOk) {
      mode = 'screen';
      fellBack = true;
    } else unresolved = true;
  }
  if (mode !== 'camera' && !screenOk) {
    if (camOk(camera)) {
      mode = 'camera';
      fellBack = true;
    } else if (camOk(camera === 'A' ? 'B' : 'A')) {
      mode = 'camera';
      camera = camera === 'A' ? 'B' : 'A';
      fellBack = true;
    } else unresolved = true;
  }
  return { mode, camera, transition: seg?.transition ?? 'smooth', start: seg?.start ?? 0, unresolved, fellBack, segment: seg };
}

export interface FrameState {
  out: Seconds;
  src: Seconds;
  layout: ResolvedLayout;
  screen: (Placement & { zoom: { scale: number; cx: number; cy: number } }) | null;
  cameras: (Placement & { slot: CameraSlot })[];
  broll: { insert: BrollInsert; opacity: number; assetTime: Seconds } | null;
  overlays: { overlay: Overlay; enter: number; exit: number }[];
  masks: Mask[];
  cursor: { x: number; y: number; opacity: number; ripples: { x: number; y: number; age: number }[] } | null;
  unresolved: boolean;
}

export interface FrameContext {
  project: PLayout;
  map: TimeMap;
  /** Smoothed pointer for drawing. */
  cursor: CursorTrack | null;
  /** Heavily smoothed pointer the zoom viewport follows. */
  follow: CursorTrack | null;
  screenAspect: number | null;
}

function zoomAmount(z: Zoom, out: Seconds, map: TimeMap, tIn: number, tOut: number): number {
  const a = map.toOutput(z.start);
  const b = map.toOutput(z.end);
  if (b - a < 0.05) return 0;
  const half = (b - a) / 2;
  const pin = (out - a) / Math.min(tIn, half);
  const pout = (b - out) / Math.min(tOut, half);
  return ease(Math.min(pin, pout));
}

/**
 * Everything the compositor needs for one output frame. Pure: the same
 * project and output time always produce the same frame, which is what keeps
 * the preview and the export identical.
 */
export function evaluateFrame(ctx: FrameContext, out: Seconds): FrameState {
  const { project, map } = ctx;
  const ap = project.edit.appearance;
  const mo = MOTION[ap.motion];
  const src = map.toSource(out);
  const layout = resolveLayout(project, src);
  const geo = layoutGeometry(layout.mode, ap, ctx.screenAspect);

  // Blend from the layout the viewer saw just before this decision started.
  let screenP: Placement = geo.screen;
  let cams: (Placement & { slot: CameraSlot })[] = [{ ...geo.camera, slot: layout.camera }];
  const startOut = map.toOutput(layout.start);
  const sinceStart = out - startOut;
  if (layout.segment && layout.transition === 'smooth' && startOut > 1e-3 && sinceStart < mo.layout) {
    const prevSrc = map.toSource(Math.max(0, startOut - 1 / ap.output.fps));
    const prev = resolveLayout(project, Math.min(prevSrc, layout.start - 1e-3));
    if (prev.mode !== layout.mode || prev.camera !== layout.camera) {
      const pg = layoutGeometry(prev.mode, ap, ctx.screenAspect);
      const p = ease(sinceStart / mo.layout);
      screenP = { rect: lerpRect(pg.screen.rect, geo.screen.rect, p), opacity: lerp(pg.screen.opacity, geo.screen.opacity, p), radius: lerp(pg.screen.radius, geo.screen.radius, p) };
      const camRect = lerpRect(pg.camera.rect, geo.camera.rect, p);
      const camRadius = lerp(pg.camera.radius, geo.camera.radius, p);
      if (prev.camera === layout.camera) {
        cams = [{ rect: camRect, radius: camRadius, opacity: lerp(pg.camera.opacity, geo.camera.opacity, p), slot: layout.camera }];
      } else {
        // angle change: cross-dissolve the two cameras in the moving frame
        cams = [
          { rect: camRect, radius: camRadius, opacity: pg.camera.opacity, slot: prev.camera },
          { rect: camRect, radius: camRadius, opacity: geo.camera.opacity * p, slot: layout.camera },
        ];
      }
    }
  }

  // Zoom: strongest active zoom wins; the viewport stays inside the source.
  let zoom = { scale: 1, cx: 0.5, cy: 0.5 };
  let best = 0;
  for (const z of project.edit.zooms) {
    if (src < z.start - 2 || src > z.end + 2) continue;
    const amt = zoomAmount(z, out, map, mo.zoomIn, mo.zoomOut);
    if (amt <= best) continue;
    best = amt;
    let tx = z.x;
    let ty = z.y;
    if (z.follow && ctx.follow) {
      const c = cursorAt(ctx.follow, clamp(src, z.start, z.end));
      if (c) {
        tx = c.x;
        ty = c.y;
      }
    }
    const scale = 1 + (z.scale - 1) * amt;
    const half = 0.5 / scale;
    zoom = { scale, cx: lerp(0.5, clamp(tx, half, 1 - half), amt), cy: lerp(0.5, clamp(ty, half, 1 - half), amt) };
  }

  // B-roll covers the frame while narration continues underneath.
  let broll: FrameState['broll'] = null;
  const ins = at(project.edit.broll, src);
  if (ins) {
    const a = map.toOutput(ins.start);
    const b = map.toOutput(ins.end);
    const fade = Math.min(0.3, (b - a) / 3);
    const opacity = clamp(Math.min((out - a) / fade, (b - out) / fade), 0, 1);
    broll = { insert: ins, opacity: ease(opacity), assetTime: ins.assetIn + (src - ins.start) };
  }

  const overlays: FrameState['overlays'] = [];
  for (const o of project.edit.overlays) {
    if (src < o.start || src >= o.end) continue;
    const a = map.toOutput(o.start);
    const b = map.toOutput(o.end);
    overlays.push({ overlay: o, enter: clamp((out - a) / 0.45, 0, 1), exit: clamp((b - out) / 0.3, 0, 1) });
  }

  const masks = project.edit.masks.filter((m) => src >= m.start && src < m.end);

  let cursor: FrameState['cursor'] = null;
  if (ctx.cursor && ap.cursor.visible && screenP.opacity > 0.01) {
    const c = cursorAt(ctx.cursor, src);
    if (c) {
      const idleFade = ap.cursor.hideWhenIdle ? clamp(1 - (c.idleFor - 2.5) / 0.5, 0, 1) : 1;
      const ripples =
        ap.cursor.clickEffect === 'ripple'
          ? ctx.cursor.clicks.filter((k) => src >= k.t && src - k.t < 0.6).map((k) => ({ x: k.x, y: k.y, age: (src - k.t) / 0.6 }))
          : [];
      cursor = { x: c.x, y: c.y, opacity: idleFade, ripples };
    }
  }

  const hasScreen = !!sourceByRole(project, 'screen');
  return {
    out,
    src,
    layout,
    screen: hasScreen ? { ...screenP, zoom } : null,
    cameras: cams.filter((c) => c.opacity > 0.003 && !!cameraSource(project, c.slot)),
    broll,
    overlays,
    masks,
    cursor,
    unresolved: layout.unresolved,
  };
}

/** Session ranges where the requested layout cannot be shown by any source. */
export function unresolvedGaps(project: PLayout, map: TimeMap, step = 0.25): { start: Seconds; end: Seconds }[] {
  const gaps: { start: Seconds; end: Seconds }[] = [];
  for (const seg of map.segments) {
    for (let t = seg.srcStart; t < seg.srcEnd; t += step) {
      if (resolveLayout(project, t).unresolved) {
        const last = gaps[gaps.length - 1];
        if (last && t - last.end <= step + 1e-6) last.end = t + step;
        else gaps.push({ start: t, end: t + step });
      }
    }
  }
  return gaps;
}
