import type { Appearance, BrollInsert, CameraSlot, CursorSample, KeyStroke, LayoutMode, LayoutSegment, Mask, Overlay, Project, Rect, Seconds, Zoom } from './types';
import { at, clamp } from './ranges';
import { cameraSourceAt, covers, sourceAt, sourcesAt, toSourceTime } from './sync';
import { baseLayoutAt } from './clips';
import { DEVICE_BEZEL, activeShortcuts, cursorExtrasOf, faceAt, faceCrop, faceOf, motionBlurOf, shortcutsOf, type CameraCrop, type FaceTrackSmooth, type ShownShortcut } from './parity';
import { shortFaceCrop } from './shorts';
import { defaultLayoutMode } from './edit';
import type { TimeMap } from './timemap';
import { brollOpacity, placedTransitions, transitionAt, type ActiveTransition } from './transitions';
import { punchCrop, punchScaleAt } from './punch';

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
  /** Cursor type per sample: 0 arrow, 1 pointing hand, 2 I-beam. */
  kinds: Uint8Array;
}

export type CursorKind = 'arrow' | 'pointer' | 'ibeam';
const KIND_CODE: Record<string, number> = { pointer: 1, ibeam: 2 };
const KIND_NAME: CursorKind[] = ['arrow', 'pointer', 'ibeam'];

export interface CursorTrackOptions {
  /** Ignore tiny hand tremor: the pointer only follows once it has really moved. */
  antiShake?: boolean;
  /** Ease back to the starting position over the last second, so a looping video is seamless. */
  loop?: boolean;
}

/** Dead-zone filter: positions within `radius` of the last accepted one are treated as no movement. */
export function suppressShake(samples: CursorSample[], radius = 0.004): CursorSample[] {
  if (samples.length === 0) return samples;
  let ax = samples[0]!.x;
  let ay = samples[0]!.y;
  return samples.map((s) => {
    if (s.e !== 'move' || Math.hypot(s.x - ax, s.y - ay) > radius) {
      ax = s.x;
      ay = s.y;
      return s;
    }
    return { ...s, x: ax, y: ay };
  });
}

/**
 * Precompute a spring-smoothed cursor path. Being a pure function of the
 * recorded samples, preview and export draw the identical cursor.
 */
export function buildCursorTrack(raw: CursorSample[], smoothing: number, hz = 120, opts: CursorTrackOptions = {}): CursorTrack {
  const clicks = raw.filter((s) => s.e === 'down').map((s) => ({ t: s.t, x: s.x, y: s.y }));
  const samples = opts.antiShake ? suppressShake(raw) : raw;
  if (samples.length === 0) return { hz, t0: 0, xs: new Float32Array(0), ys: new Float32Array(0), clicks, lastMove: new Float32Array(0), kinds: new Uint8Array(0) };
  const t0 = samples[0]!.t;
  const t1 = samples[samples.length - 1]!.t;
  const n = Math.max(1, Math.ceil((t1 - t0) * hz) + 1);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const lastMove = new Float32Array(n);
  const kinds = new Uint8Array(n);
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
    kinds[i] = KIND_CODE[a.c ?? ''] ?? 0;
  }
  if (opts.loop && n > 2) {
    const span = Math.min(n - 1, Math.round(hz));
    for (let i = n - span; i < n; i++) {
      const p = ease((i - (n - span)) / span);
      xs[i] = lerp(xs[i]!, xs[0]!, p);
      ys[i] = lerp(ys[i]!, ys[0]!, p);
    }
  }
  return { hz, t0, xs, ys, clicks, lastMove, kinds };
}

export function cursorAt(track: CursorTrack, t: Seconds): { x: number; y: number; idleFor: Seconds; kind: CursorKind; vx: number; vy: number } | null {
  const n = track.xs.length;
  if (n === 0) return null;
  const f = clamp((t - track.t0) * track.hz, 0, n - 1);
  const i = Math.floor(f);
  const k = Math.min(n - 1, i + 1);
  const u = f - i;
  // velocity over a short window, in normalised units per second
  const a = Math.max(0, i - 3);
  const b = Math.min(n - 1, i + 3);
  const dt = Math.max(1, b - a) / track.hz;
  return {
    x: lerp(track.xs[i]!, track.xs[k]!, u),
    y: lerp(track.ys[i]!, track.ys[k]!, u),
    idleFor: Math.max(0, t - track.lastMove[i]!),
    kind: KIND_NAME[track.kinds[i] ?? 0] ?? 'arrow',
    vx: (track.xs[b]! - track.xs[a]!) / dt,
    vy: (track.ys[b]! - track.ys[a]!) / dt,
  };
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
export function layoutGeometry(mode: LayoutMode, ap: Appearance, screenAspect: number | null, device: 'phone' | 'tablet' | null = null): LayoutGeometry {
  const W = ap.output.width;
  const H = ap.output.height;
  // Sizes follow the short side, so portrait and square outputs keep sensible proportions (equal to H for 16:9).
  const M = Math.min(W, H);
  const portrait = H > W * 1.05;
  const pad = ap.frame.padding * M;
  // With a device frame the picture is drawn smaller, so the bezel around it stays inside its box.
  const bezel = device ? DEVICE_BEZEL[device].edge : 0;
  const fit = (box: Rect, aspect: number): Rect => {
    let w = box.w;
    let h = w / aspect;
    if (h > box.h) {
      h = box.h;
      w = h * aspect;
    }
    if (bezel) {
      const k = 1 / (1 + 2 * bezel * Math.max(1, aspect));
      w *= k;
      h *= k;
    }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  };
  const aspect = screenAspect ?? W / H;
  const screenFull = fit({ x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad }, aspect);
  const screenRadius = pad > 0 ? ap.frame.radius * M : 0;

  const side = ap.camera.size * M * (portrait ? 1.25 : 1);
  const margin = Math.max(pad * 0.55, 0.035 * M);
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
    case 'presenter': {
      // Camera fills the frame; the screen is a small picture in the camera's usual corner.
      const box = portrait ? { w: W * 0.62, h: H * 0.3 } : { w: W * 0.36, h: H * 0.36 };
      const small = fit({ x: 0, y: 0, w: box.w, h: box.h }, aspect);
      const x = ap.camera.corner.endsWith('r') ? W - margin - small.w : margin;
      const y = ap.camera.corner.startsWith('b') ? H - margin - small.h : margin;
      return { screen: { rect: { x, y, w: small.w, h: small.h }, opacity: 1, radius: Math.max(ap.frame.radius, 0.012) * M * 0.6 }, camera: { rect: { x: 0, y: 0, w: W, h: H }, opacity: 1, radius: 0 } };
    }
    case 'split': {
      const outer = Math.max(pad, 0.045 * M);
      if (portrait || W / H < 1.2) {
        // stacked: screen on top, camera below
        const gap = 0.022 * H;
        const camH = (H - 2 * outer - gap) * (portrait ? 0.42 : 0.4);
        const camBox: Rect = { x: outer, y: H - outer - camH, w: W - 2 * outer, h: camH };
        const screenBox: Rect = { x: outer, y: outer, w: W - 2 * outer, h: H - 2 * outer - camH - gap };
        return { screen: { rect: fit(screenBox, aspect), opacity: 1, radius: ap.frame.radius * M }, camera: { rect: camBox, opacity: 1, radius: 0.03 * M } };
      }
      const gap = 0.022 * W;
      const camW = W * 0.3;
      const camBox: Rect = { x: W - outer - camW, y: outer, w: camW, h: H - 2 * outer };
      const screenBox: Rect = { x: outer, y: outer, w: W - 2 * outer - camW - gap, h: H - 2 * outer };
      return { screen: { rect: fit(screenBox, aspect), opacity: 1, radius: ap.frame.radius * M }, camera: { rect: camBox, opacity: 1, radius: 0.03 * M } };
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
  // With several clips each one has its own sources and its own base view.
  let mode: LayoutMode = seg?.mode ?? baseLayoutAt(project, t) ?? defaultLayoutMode(sourcesAt(project, t));
  let camera: CameraSlot = seg?.camera ?? (cameraSourceAt(project, 'A', t) ? 'A' : 'B');
  const screen = sourceAt(project, 'screen', t);
  const screenOk = covers(screen, t);
  const camOk = (slot: CameraSlot) => covers(cameraSourceAt(project, slot, t), t);
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

/** `ax`/`ay` (≤ 1) narrow the visible window on one axis, so a wide screen can fill a tall frame (shorts). */
export type ZoomPose = { scale: number; cx: number; cy: number; ax?: number; ay?: number };

export interface LensState {
  /** Centre in screen-source coordinates. */
  x: number;
  y: number;
  /** Diameter as a fraction of the screen picture's height. */
  size: number;
  magnification: number;
  /** 0…1 appear/disappear. */
  amount: number;
}

/** One instant of the moving parts; several of these inside the shutter window make motion blur. */
export interface Pose {
  screen: Placement & { zoom: ZoomPose };
  cameras: (Placement & { slot: CameraSlot })[];
}

export interface FrameState {
  out: Seconds;
  src: Seconds;
  layout: ResolvedLayout;
  screen: (Placement & { zoom: ZoomPose }) | null;
  cameras: (Placement & { slot: CameraSlot; crop?: CameraCrop })[];
  broll: { insert: BrollInsert; opacity: number; assetTime: Seconds } | null;
  /** enter/exit: 0…1 progress of the fixed animation of the ready-made graphics. sinceIn/untilOut: output seconds since it appeared and until it goes (free text animates from these). */
  overlays: { overlay: Overlay; enter: number; exit: number; sinceIn: Seconds; untilOut: Seconds }[];
  masks: Mask[];
  cursor: {
    x: number;
    y: number;
    opacity: number;
    ripples: { x: number; y: number; age: number }[];
    kind: CursorKind;
    /** Tilt in radians from sideways movement. */
    angle: number;
    /** Earlier positions inside the shutter window, oldest first (motion blur). */
    trail: { x: number; y: number }[];
  } | null;
  /** Magnifier lens over the screen picture. */
  lens: LensState | null;
  /** Key-cap labels to show. */
  shortcuts: ShownShortcut[];
  /** Earlier poses inside the shutter window, oldest first; empty when nothing is moving or blur is off. */
  blur: Pose[];
  unresolved: boolean;
  /** A transition between two clips in progress: a colour wash, or the neighbouring clip's picture to lay over this one. */
  transition: ActiveTransition | null;
  /** Magnification the punch-in on jump cuts adds to the camera in this frame (1 = none). Already applied to `cameras[].crop`. */
  punch: number;
}

export interface FrameContext {
  project: PLayout;
  map: TimeMap;
  /** Smoothed pointer for drawing. */
  cursor: CursorTrack | null;
  /** Heavily smoothed pointer the zoom viewport follows. */
  follow: CursorTrack | null;
  screenAspect: number | null;
  /** Shortcut telemetry on the session clock. */
  keys?: KeyStroke[] | null;
  /** Smoothed face tracks per camera slot (camera-source time). */
  faces?: Partial<Record<CameraSlot, FaceTrackSmooth | null>>;
  /** Export uses more motion-blur sub-samples than the live preview. */
  quality?: 'preview' | 'export';
  /** Device frame drawn around the screen picture (leaves room for the bezel). */
  device?: 'phone' | 'tablet' | null;
}

function zoomAmount(z: Zoom, out: Seconds, map: TimeMap, tIn: number, tOut: number): number {
  const a = map.toOutput(z.start);
  const b = map.toOutput(z.end);
  if (b - a < 0.05) return 0;
  if (z.style === 'instant') return out >= a && out < b ? 1 : 0;
  const half = (b - a) / 2;
  const pin = (out - a) / Math.min(tIn, half);
  const pout = (b - out) / Math.min(tOut, half);
  return ease(Math.min(pin, pout));
}

function zoomTarget(ctx: FrameContext, z: Zoom, src: Seconds): { x: number; y: number } {
  if (z.follow && ctx.follow) {
    const c = cursorAt(ctx.follow, clamp(src, z.start, z.end));
    if (c) return { x: c.x, y: c.y };
  }
  return { x: z.x, y: z.y };
}

/** The pointer the view follows, averaged over a moment either side so the picture glides instead of chasing it. */
function followPoint(track: CursorTrack | null, t: Seconds): { x: number; y: number } | null {
  if (!track) return null;
  let x = 0;
  let y = 0;
  let n = 0;
  for (const d of [-0.6, -0.3, 0, 0.3, 0.6]) {
    const c = cursorAt(track, Math.max(0, t + d));
    if (!c) continue;
    x += c.x;
    y += c.y;
    n++;
  }
  return n ? { x: x / n, y: y / n } : null;
}

/** Layout placement and zoom at one output time. */
function poseAt(ctx: FrameContext, out: Seconds): { src: Seconds; layout: ResolvedLayout; pose: Pose; lens: LensState | null } {
  const { project, map } = ctx;
  const ap = project.edit.appearance;
  const mo = MOTION[ap.motion];
  const src = map.toSource(out);
  const layout = resolveLayout(project, src);
  // In a short, a screen shown on its own fills the whole frame (the window onto it is narrowed below).
  const fill = !!project.edit.reframe?.fillScreen;
  const frameAspect = ap.output.width / ap.output.height;
  const geometry = (mode: LayoutMode) => (fill && mode === 'screen' ? layoutGeometry(mode, ap, frameAspect, null) : layoutGeometry(mode, ap, ctx.screenAspect, ctx.device ?? null));
  const geo = geometry(layout.mode);

  // Blend from the layout the viewer saw just before this decision started.
  let screenP: Placement = geo.screen;
  let cams: (Placement & { slot: CameraSlot })[] = [{ ...geo.camera, slot: layout.camera }];
  const startOut = map.toOutput(layout.start);
  const sinceStart = out - startOut;
  // A view that begins where a clip begins has nothing to blend from: the clip change is a hard cut.
  const atClipStart = !!project.edit.clips && project.edit.clips.some((c) => !c.removed && Math.abs(c.start - layout.start) < 1e-3);
  if (layout.segment && layout.transition === 'smooth' && startOut > 1e-3 && sinceStart < mo.layout && !atClipStart) {
    const prevSrc = map.toSource(Math.max(0, startOut - 1 / ap.output.fps));
    const prev = resolveLayout(project, Math.min(prevSrc, layout.start - 1e-3));
    if (prev.mode !== layout.mode || prev.camera !== layout.camera) {
      const pg = geometry(prev.mode);
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
  let zoom: ZoomPose = { scale: 1, cx: 0.5, cy: 0.5 };
  let lens: LensState | null = null;
  let best = 0;
  for (const z of project.edit.zooms) {
    if (src < z.start - 2 || src > z.end + 2) continue;
    if (z.style === 'magnifier') {
      const amt = zoomAmount(z, out, map, 0.3, 0.3);
      if (amt > (lens?.amount ?? 0)) {
        const t = zoomTarget(ctx, z, src);
        lens = { x: t.x, y: t.y, size: clamp(z.lensSize ?? 0.34, 0.12, 0.8), magnification: z.scale, amount: amt };
      }
      continue;
    }
    const amt = zoomAmount(z, out, map, mo.zoomIn, mo.zoomOut);
    if (amt <= best) continue;
    best = amt;
    const t = zoomTarget(ctx, z, src);
    const scale = 1 + (z.scale - 1) * amt;
    const half = 0.5 / scale;
    zoom = { scale, cx: lerp(0.5, clamp(t.x, half, 1 - half), amt), cy: lerp(0.5, clamp(t.y, half, 1 - half), amt) };
  }
  if (fill && layout.mode === 'screen' && ctx.screenAspect) {
    // The frame is taller (or wider) than the screen: show the part the pointer is in, unless a zoom is aiming the view.
    const ax = Math.min(1, frameAspect / ctx.screenAspect);
    const ay = Math.min(1, ctx.screenAspect / frameAspect);
    const f = followPoint(ctx.follow, src);
    const hx = (0.5 * ax) / zoom.scale;
    const hy = (0.5 * ay) / zoom.scale;
    zoom = {
      scale: zoom.scale,
      cx: clamp(zoom.cx + ((f?.x ?? 0.5) - 0.5) * (1 - best), hx, 1 - hx),
      cy: ay < 1 ? clamp(zoom.cy + ((f?.y ?? 0.5) - 0.5) * (1 - best), hy, 1 - hy) : zoom.cy,
      ax,
      ay,
    };
  }
  return { src, layout, pose: { screen: { ...screenP, zoom }, cameras: cams }, lens };
}

function poseMoved(a: Pose, b: Pose, W: number): boolean {
  const r = (x: Rect, y: Rect) => Math.abs(x.x - y.x) + Math.abs(x.y - y.y) + Math.abs(x.w - y.w) + Math.abs(x.h - y.h);
  if (r(a.screen.rect, b.screen.rect) > W * 0.0015) return true;
  const za = a.screen.zoom;
  const zb = b.screen.zoom;
  if (Math.abs(za.scale - zb.scale) > 0.004 || Math.abs(za.cx - zb.cx) + Math.abs(za.cy - zb.cy) > 0.0015) return true;
  if (a.cameras.length !== b.cameras.length) return true;
  return a.cameras.some((c, i) => r(c.rect, b.cameras[i]!.rect) > W * 0.0015);
}

/** Longest shutter (seconds) at motion-blur amount 1. */
export const MAX_SHUTTER = 0.045;

/**
 * Everything the compositor needs for one output frame. Pure: the same
 * project and output time always produce the same frame, which is what keeps
 * the preview and the export identical.
 */
export function evaluateFrame(ctx: FrameContext, out: Seconds): FrameState {
  const { project, map } = ctx;
  const ap = project.edit.appearance;
  const { src, layout, pose, lens } = poseAt(ctx, out);
  const mb = motionBlurOf(ap);
  const subs = mb.amount > 0.01 ? (ctx.quality === 'export' ? 9 : 4) : 0;
  const shutter = mb.amount * MAX_SHUTTER;

  // motion blur of layout/zoom: earlier poses within the shutter window
  let blur: Pose[] = [];
  if (subs && mb.animation) {
    const oldest = poseAt(ctx, Math.max(0, out - shutter)).pose;
    if (poseMoved(oldest, pose, ap.output.width)) {
      blur = [oldest];
      for (let i = 1; i < subs; i++) blur.push(poseAt(ctx, Math.max(0, out - shutter * (1 - i / subs))).pose);
    }
  }

  // B-roll covers the frame while narration continues underneath.
  let broll: FrameState['broll'] = null;
  const ins = at(project.edit.broll, src);
  if (ins) {
    const a = map.toOutput(ins.start);
    const b = map.toOutput(ins.end);
    broll = { insert: ins, opacity: ease(brollOpacity(ins, a, b, out)), assetTime: ins.assetIn + (src - ins.start) };
  }

  const overlays: FrameState['overlays'] = [];
  for (const o of project.edit.overlays) {
    if (src < o.start || src >= o.end) continue;
    const a = map.toOutput(o.start);
    const b = map.toOutput(o.end);
    overlays.push({ overlay: o, enter: clamp((out - a) / 0.45, 0, 1), exit: clamp((b - out) / 0.3, 0, 1), sinceIn: out - a, untilOut: b - out });
  }

  const masks = project.edit.masks.filter((m) => src >= m.start && src < m.end);

  let cursor: FrameState['cursor'] = null;
  if (ctx.cursor && ap.cursor.visible && pose.screen.opacity > 0.01) {
    const c = cursorAt(ctx.cursor, src);
    if (c) {
      const extra = cursorExtrasOf(ap);
      const idleFade = ap.cursor.hideWhenIdle ? clamp(1 - (c.idleFor - 2.5) / 0.5, 0, 1) : 1;
      const ripples =
        ap.cursor.clickEffect === 'ripple'
          ? ctx.cursor.clicks.filter((k) => src >= k.t && src - k.t < 0.6).map((k) => ({ x: k.x, y: k.y, age: (src - k.t) / 0.6 }))
          : [];
      const trail: { x: number; y: number }[] = [];
      if (subs && mb.cursor) {
        // the pointer is cheap to draw, so its smear gets many more samples than the picture
        const n = ctx.quality === 'export' ? 24 : 10;
        for (let i = 0; i < n; i++) {
          const p = cursorAt(ctx.cursor, map.toSource(Math.max(0, out - shutter * (1 - i / n))));
          if (p) trail.push({ x: p.x, y: p.y });
        }
        // a still cursor needs no smear
        const first = trail[0];
        if (!first || Math.hypot(first.x - c.x, first.y - c.y) < 0.0012) trail.length = 0;
      }
      cursor = {
        x: c.x,
        y: c.y,
        opacity: idleFade,
        ripples,
        kind: extra.style === 'arrow' ? 'arrow' : c.kind,
        // lean into horizontal movement, up to about 14°
        angle: extra.rotate ? clamp(c.vx * 0.28, -0.25, 0.25) : 0,
        trail,
      };
    }
  }

  // camera framing from face tracking
  const face = faceOf(ap);
  // Punch-in on jump cuts: a factor on top of whatever framing the camera has, only in a full-frame camera view.
  const punch = layout.mode === 'camera' ? punchScaleAt(project, map, out) : 1;
  const framed: FrameState['cameras'] = pose.cameras
    .filter((c) => c.opacity > 0.003 && !!cameraSourceAt(project, c.slot, src))
    .map((c) => {
      const track = face.zoom || face.follow ? ctx.faces?.[c.slot] : null;
      if (!track) return c;
      const camSrc = cameraSourceAt(project, c.slot, src)!;
      // A short reframes the camera for a box of another shape, with headroom.
      const reframe = project.edit.reframe;
      if (reframe && reframe.framing !== 'original' && camSrc.width && camSrc.height && c.rect.w > 1 && c.rect.h > 1) {
        return { ...c, crop: shortFaceCrop(track, Math.max(0, toSourceTime(camSrc.sync, src)), camSrc.width / camSrc.height, c.rect.w / c.rect.h) };
      }
      const f = faceAt(track, Math.max(0, toSourceTime(camSrc.sync, src)));
      return { ...c, crop: faceCrop(f, face, track.median) };
    });
  const cameras: FrameState['cameras'] = punch > 1.0005 ? framed.map((c) => ({ ...c, crop: punchCrop(c.crop, punch, ctx.faces?.[c.slot]) })) : framed;

  const sc = shortcutsOf(ap);
  const shortcuts = sc.show && ctx.keys?.length ? activeShortcuts(ctx.keys, src, sc.hidden) : [];

  const hasScreen = !!sourceAt(project, 'screen', src);
  return {
    out,
    src,
    layout,
    screen: hasScreen ? pose.screen : null,
    cameras,
    broll,
    overlays,
    masks,
    cursor,
    lens: hasScreen && lens && pose.screen.opacity > 0.5 ? lens : null,
    shortcuts,
    blur: hasScreen || blur.length === 0 ? blur : blur,
    unresolved: layout.unresolved,
    transition: project.edit.transitions?.length ? transitionAt(placedTransitions(project, map), out, ap.output.fps) : null,
    punch,
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
