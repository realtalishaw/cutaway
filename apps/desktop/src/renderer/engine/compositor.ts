/**
 * The one compositor. Preview and export both call drawFrame with a FrameState
 * from core.evaluateFrame, so what the creator approves is what gets encoded.
 * All geometry is in output pixels (appearance.output); the caller scales the
 * context for smaller preview canvases.
 */
import { DEVICE_BEZEL, DEVICE_COLORS, WALLPAPERS, cameraLookOf, cutoutOf, deviceOf, easeOutBack, gradeActive, gradeOf, lookFilter, lookWarmth, shortcutsOf, type Appearance, type Lut, type CameraCrop, type CameraSlot, type Cue, type CursorKind, type FrameState, type LensState, type Mask, type Overlay, type Placement, type Rect, type ShownShortcut, type ZoomPose } from '@cutaway/core';

import { gradeDrawable } from './glGrade';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Canvas filter lengths are device pixels: they ignore the current transform.
 * The preview draws through a scale, so a blur radius given in output pixels
 * has to be scaled the same way or it comes out too wide (and, for masks,
 * see-through at the edges of its padding).
 */
function blurPx(ctx: Ctx, outputPx: number): string {
  const t = ctx.getTransform();
  return `blur(${Math.max(0.5, outputPx * Math.hypot(t.a, t.b))}px)`;
}

/** Anything that can paint a region of itself: a <video>, an ImageBitmap or a decoded VideoSample. */
export interface Drawable {
  width: number;
  height: number;
  draw(ctx: Ctx, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

export function drawableFromElement(el: HTMLVideoElement | HTMLImageElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Drawable | null {
  const width = el instanceof HTMLVideoElement ? el.videoWidth : el instanceof HTMLImageElement ? el.naturalWidth : el.width;
  const height = el instanceof HTMLVideoElement ? el.videoHeight : el instanceof HTMLImageElement ? el.naturalHeight : el.height;
  if (!width || !height) return null;
  if (el instanceof HTMLVideoElement && el.readyState < 2) return null;
  return { width, height, draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(el, sx, sy, sw, sh, dx, dy, dw, dh) };
}

export interface FrameResources {
  screen: Drawable | null;
  cameraA: Drawable | null;
  cameraB: Drawable | null;
  broll: Drawable | null;
  backgroundImage: Drawable | null;
  /** Person mattes (white = person) for camera cutout, time-aligned with each camera. */
  matteA?: Drawable | null;
  matteB?: Drawable | null;
}

export interface DrawEnv {
  appearance: Appearance;
  /** Logical size of the captured area, for cursor scale. */
  screenPoints: { width: number; height: number } | null;
  /** Burned-in caption for this frame, if captions are enabled. */
  cue: Cue | null;
  /** Generic bezel to draw around the screen picture, when the creator switched it on and the source suits it. */
  device?: 'phone' | 'tablet' | null;
  /** Editor-only decorations (mask outlines). Never set during export. */
  editor?: { selectedMaskId: string | null };
  /** Parsed colour LUTs for appearance.grade (null while a file is loading or when none is set). */
  luts?: { screen: Lut | null; camera: Lut | null };
}

const FONT_SERIF = "'Inter Variable', 'Inter', -apple-system, sans-serif";
const FONT_SANS = "'Inter Variable', 'Inter', -apple-system, sans-serif";

function roundRect(ctx: Ctx, r: Rect, radius: number) {
  const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2));
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, rad);
}

function cover(src: { width: number; height: number }, dst: Rect): { sx: number; sy: number; sw: number; sh: number } {
  const sa = src.width / src.height;
  const da = dst.w / dst.h;
  if (sa > da) {
    const sw = src.height * da;
    return { sx: (src.width - sw) / 2, sy: 0, sw, sh: src.height };
  }
  const sh = src.width / da;
  return { sx: 0, sy: (src.height - sh) / 2, sw: src.width, sh };
}

function drawBackground(ctx: Ctx, ap: Appearance, res: FrameResources) {
  const { width: W, height: H } = ap.output;
  const bg = ap.background;
  if (bg.type === 'solid') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (bg.type === 'wallpaper') {
    const wp = WALLPAPERS.find((w) => w.id === bg.id) ?? WALLPAPERS[0]!;
    ctx.fillStyle = wp.base;
    ctx.fillRect(0, 0, W, H);
    const D = Math.max(W, H);
    for (const b of wp.blobs) {
      // blur widens and softens the colour fields instead of filtering pixels (cheap and identical in export)
      const r = b.r * D * (1 + bg.blur * 0.6);
      const g = ctx.createRadialGradient(b.x * W, b.y * H, 0, b.x * W, b.y * H, r);
      g.addColorStop(0, b.color);
      g.addColorStop(1, `${b.color}00`);
      ctx.globalAlpha = 0.9 - bg.blur * 0.25;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (bg.type === 'image' && res.backgroundImage) {
    const c = cover(res.backgroundImage, { x: 0, y: 0, w: W, h: H });
    ctx.save();
    if (bg.blur > 0) ctx.filter = blurPx(ctx, bg.blur * H * 0.04);
    res.backgroundImage.draw(ctx, c.sx, c.sy, c.sw, c.sh, -W * 0.03, -H * 0.03, W * 1.06, H * 1.06);
    ctx.restore();
    return;
  }
  const colors = bg.type === 'gradient' ? bg.colors : ['#16130f', '#2a221b'];
  const angle = ((bg.type === 'gradient' ? bg.angle : 135) * Math.PI) / 180;
  const cx = W / 2;
  const cy = H / 2;
  const len = (Math.abs(W * Math.sin(angle)) + Math.abs(H * Math.cos(angle))) / 2;
  const g = ctx.createLinearGradient(cx - Math.sin(angle) * len, cy + Math.cos(angle) * len, cx + Math.sin(angle) * len, cy - Math.cos(angle) * len);
  colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // soft light bloom so gradients do not read as flat bands
  const bloom = ctx.createRadialGradient(W * 0.78, H * 0.12, 0, W * 0.78, H * 0.12, H * 0.9);
  bloom.addColorStop(0, 'rgba(255,255,255,0.10)');
  bloom.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, W, H);
}

function shadow(ctx: Ctx, r: Rect, radius: number, strength: number, H: number, opacity: number) {
  if (strength <= 0 || opacity <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.shadowColor = `rgba(0,0,0,${0.55 * strength})`;
  ctx.shadowBlur = H * 0.07 * strength;
  ctx.shadowOffsetY = H * 0.028 * strength;
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  roundRect(ctx, r, radius);
  ctx.fill();
  ctx.restore();
}

/** Visible window of the source after crop and zoom, in source-normalised units. */
function viewport(ap: Appearance, zoom: { scale: number; cx: number; cy: number }): Rect {
  const c = ap.crop;
  const w = c.w / zoom.scale;
  const h = c.h / zoom.scale;
  return { x: c.x + zoom.cx * c.w - w / 2, y: c.y + zoom.cy * c.h - h / 2, w, h };
}

/** Source-normalised rect → output pixels inside `dst`, given the visible viewport. */
function project(view: Rect, dst: Rect, r: Rect): Rect {
  return { x: dst.x + ((r.x - view.x) / view.w) * dst.w, y: dst.y + ((r.y - view.y) / view.h) * dst.h, w: (r.w / view.w) * dst.w, h: (r.h / view.h) * dst.h };
}

function drawMasks(ctx: Ctx, masks: Mask[], src: Drawable, view: Rect, dst: Rect, env: DrawEnv, H: number) {
  if (masks.length === 0) return;
  const highlights = masks.filter((m) => m.style === 'highlight');
  if (highlights.length) {
    // dim everything except the highlighted regions
    ctx.save();
    ctx.beginPath();
    ctx.rect(dst.x, dst.y, dst.w, dst.h);
    for (const m of highlights) {
      const p = project(view, dst, m.rect);
      ctx.roundRect(p.x, p.y, p.w, p.h, H * 0.008);
    }
    ctx.fillStyle = 'rgba(8,6,5,0.62)';
    ctx.fill('evenodd');
    ctx.restore();
  }
  for (const m of masks) {
    const p = project(view, dst, m.rect);
    if (m.style === 'solid') {
      ctx.fillStyle = '#0b0a09';
      ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (m.style === 'blur') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      // Heavy blur of the same pixels, over-drawn so the edges stay opaque.
      const blur = Math.max(10, Math.min(p.w, p.h) * 0.28, H * 0.022);
      ctx.filter = blurPx(ctx, blur);
      const pad = blur * 2;
      const sx = (m.rect.x - (pad / dst.w) * view.w) * src.width;
      const sy = (m.rect.y - (pad / dst.h) * view.h) * src.height;
      const sw = (m.rect.w + ((2 * pad) / dst.w) * view.w) * src.width;
      const sh = (m.rect.h + ((2 * pad) / dst.h) * view.h) * src.height;
      src.draw(ctx, sx, sy, sw, sh, p.x - pad, p.y - pad, p.w + 2 * pad, p.h + 2 * pad);
      ctx.filter = 'none';
      ctx.fillStyle = 'rgba(20,16,13,0.35)';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.restore();
    }
    if (env.editor) {
      ctx.save();
      ctx.strokeStyle = env.editor.selectedMaskId === m.id ? '#ff7a55' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = Math.max(2, H * 0.002);
      ctx.setLineDash([H * 0.008, H * 0.006]);
      ctx.strokeRect(p.x, p.y, p.w, p.h);
      ctx.restore();
    }
  }
}

// ───────────────────────────── cursor ─────────────────────────────

/** Cutaway's own pointer shapes; the hotspot is at (0, 0). */
function cursorShape(ctx: Ctx, kind: CursorKind) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'ibeam') {
    const bar = () => {
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(0, 9);
      ctx.moveTo(-3.6, -9.6);
      ctx.quadraticCurveTo(-1, -9.6, 0, -8.2);
      ctx.quadraticCurveTo(1, -9.6, 3.6, -9.6);
      ctx.moveTo(-3.6, 9.6);
      ctx.quadraticCurveTo(-1, 9.6, 0, 8.2);
      ctx.quadraticCurveTo(1, 9.6, 3.6, 9.6);
    };
    bar();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    bar();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.7;
    ctx.stroke();
    return;
  }
  if (kind === 'pointer') {
    // index finger up, three knuckles, thumb and palm: outline first, then a solid fill over it
    const parts = () => {
      ctx.beginPath();
      ctx.roundRect(-2.4, -0.6, 4.8, 13, 2.4); // index finger
      ctx.roundRect(2.2, 5.6, 4.4, 9, 2.2);
      ctx.roundRect(6.3, 6.6, 4.2, 8.5, 2.1);
      ctx.roundRect(10.1, 8, 3.9, 7.5, 1.95);
      ctx.roundRect(-2.4, 9.5, 16.4, 12, 4.6); // palm
      ctx.moveTo(-1.8, 12.5);
      ctx.lineTo(-6.6, 9.4); // thumb
      ctx.lineTo(-8.2, 11.6);
      ctx.lineTo(-2.2, 18.5);
      ctx.closePath();
    };
    parts();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    parts();
    ctx.fillStyle = '#111';
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17.5);
  ctx.lineTo(4.4, 13.6);
  ctx.lineTo(7.3, 20.2);
  ctx.lineTo(10.1, 19);
  ctx.lineTo(7.2, 12.5);
  ctx.lineTo(12.6, 12.5);
  ctx.closePath();
  ctx.fillStyle = '#111';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function drawCursor(ctx: Ctx, x: number, y: number, size: number, opacity: number, kind: CursorKind = 'arrow', angle = 0, withShadow = true) {
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  ctx.scale(size, size);
  if (withShadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
  }
  cursorShape(ctx, kind);
  ctx.restore();
}

function wrapLines(ctx: Ctx, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[.,;:]?$/, '')}…`;
    return kept;
  }
  return lines;
}

/** Graphics are sized from the short side (U), so they hold up in portrait and square outputs. */
function drawOverlay(ctx: Ctx, o: Overlay, enter: number, exit: number, W: number, H: number) {
  const a = Math.min(enter, exit);
  if (a <= 0) return;
  const U = Math.min(W, H);
  const portrait = H > W * 1.05;
  ctx.save();
  if (o.kind === 'section-card') {
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,9,8,0.82)';
    ctx.fillRect(0, 0, W, H);
    const slide = (1 - easeOutBack(enter)) * U * 0.03;
    const left = W * (portrait ? 0.08 : 0.1);
    const size = U * (portrait ? 0.12 : 0.105);
    ctx.fillStyle = '#ff5a36';
    ctx.fillRect(left, H * 0.5 - size * 1.15 + slide, U * 0.09, U * 0.008);
    ctx.fillStyle = '#f3ece3';
    ctx.font = `650 ${size * 0.86}px ${FONT_SERIF}`;
    ctx.textBaseline = 'alphabetic';
    const lines = wrapLines(ctx, o.text, W - left * 2, portrait ? 3 : 2);
    lines.forEach((l, i) => ctx.fillText(l, left, H * 0.5 + i * size * 1.1 + slide));
    if (o.subtext) {
      ctx.font = `500 ${U * 0.03}px ${FONT_SANS}`;
      ctx.fillStyle = 'rgba(243,236,227,0.7)';
      wrapLines(ctx, o.subtext, W - left * 2, 2).forEach((l, i) => ctx.fillText(l, left, H * 0.5 + lines.length * size * 1.1 - size * 0.3 + i * U * 0.04 + slide));
    }
  } else if (o.kind === 'lower-third') {
    ctx.globalAlpha = a;
    const x = W * 0.05;
    const y = H - U * 0.2;
    const slide = (1 - easeOutBack(enter)) * W * 0.02;
    ctx.font = `680 ${U * 0.04}px ${FONT_SANS}`;
    const tw = ctx.measureText(o.text).width;
    ctx.font = `500 ${U * 0.026}px ${FONT_SANS}`;
    const sw = o.subtext ? ctx.measureText(o.subtext).width : 0;
    const w = Math.min(W * 0.9, Math.max(tw, sw) + U * 0.07);
    const h = o.subtext ? U * 0.115 : U * 0.078;
    ctx.fillStyle = 'rgba(15,12,10,0.86)';
    roundRect(ctx, { x: x - slide, y, w, h }, U * 0.014);
    ctx.fill();
    ctx.fillStyle = '#ff5a36';
    ctx.fillRect(x - slide, y + h * 0.2, U * 0.006, h * 0.6);
    ctx.fillStyle = '#f3ece3';
    ctx.font = `680 ${U * 0.04}px ${FONT_SANS}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(o.text, x - slide + U * 0.035, y + (o.subtext ? h * 0.36 : h * 0.52), w - U * 0.05);
    if (o.subtext) {
      ctx.font = `500 ${U * 0.026}px ${FONT_SANS}`;
      ctx.fillStyle = 'rgba(243,236,227,0.72)';
      ctx.fillText(o.subtext, x - slide + U * 0.035, y + h * 0.72, w - U * 0.05);
    }
  } else {
    // callout pill anchored at (x, y)
    const s = 0.9 + 0.1 * easeOutBack(enter);
    ctx.globalAlpha = a;
    ctx.font = `640 ${U * 0.036}px ${FONT_SANS}`;
    const lines = wrapLines(ctx, o.text, W * (portrait ? 0.8 : 0.5), portrait ? 3 : 2);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const lh = U * 0.046;
    const w = tw + U * 0.06;
    const h = lines.length * lh + U * 0.036;
    const cx = Math.min(W - w / 2 - U * 0.03, Math.max(w / 2 + U * 0.03, o.x * W));
    const cy = Math.min(H - h / 2 - U * 0.03, Math.max(h / 2 + U * 0.03, o.y * H));
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = U * 0.03;
    ctx.shadowOffsetY = U * 0.01;
    ctx.fillStyle = '#f5c84b';
    roundRect(ctx, { x: -w / 2, y: -h / 2, w, h }, U * 0.02);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#17120a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh + U * 0.002));
  }
  ctx.restore();
}

function drawCaption(ctx: Ctx, cue: Cue, ap: Appearance, W: number, H: number) {
  const U = Math.min(W, H);
  const portrait = H > W * 1.05;
  const size = U * 0.04 * ap.captions.size * (portrait ? 1.2 : 1);
  ctx.save();
  ctx.font = `${ap.captions.style === 'bold' ? 800 : 620} ${size}px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, cue.text, W * (portrait ? 0.86 : 0.72), portrait ? 3 : 2);
  const lh = size * 1.28;
  const edge = U * 0.1;
  const cy = ap.captions.position === 'bottom' ? H - edge - ((lines.length - 1) * lh) / 2 : edge + ((lines.length - 1) * lh) / 2;
  if (ap.captions.style === 'pill') {
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = tw + size * 1.4;
    const h = lines.length * lh + size * 0.7;
    ctx.fillStyle = 'rgba(12,10,9,0.78)';
    roundRect(ctx, { x: W / 2 - w / 2, y: cy - h / 2, w, h }, size * 0.45);
    ctx.fill();
  } else {
    ctx.lineWidth = size * 0.22;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(8,6,5,0.9)';
    lines.forEach((l, i) => ctx.strokeText(l, W / 2, cy + (i - (lines.length - 1) / 2) * lh));
  }
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, cy + (i - (lines.length - 1) / 2) * lh));
  ctx.restore();
}

/** Key caps for the shortcut being pressed. */
function drawShortcuts(ctx: Ctx, shown: ShownShortcut[], ap: Appearance, W: number, H: number, captionShown: boolean) {
  const s = shown[shown.length - 1];
  if (!s) return;
  const opt = shortcutsOf(ap);
  const U = Math.min(W, H);
  const size = U * 0.05 * opt.size;
  const gap = size * 0.22;
  ctx.save();
  ctx.globalAlpha = s.alpha;
  ctx.font = `620 ${size * 0.52}px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const widths = s.caps.map((c) => Math.max(size, ctx.measureText(c).width + size * 0.6));
  const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
  const clash = captionShown && ap.captions.burnIn && ap.captions.position === opt.position;
  const edge = U * (clash ? 0.22 : 0.11);
  const cy = opt.position === 'bottom' ? H - edge : edge;
  const lift = (1 - easeOutBack(Math.min(1, s.alpha * 1.4))) * size * 0.25;
  let x = W / 2 - total / 2;
  s.caps.forEach((cap, i) => {
    const w = widths[i]!;
    const r: Rect = { x, y: cy - size / 2 + lift, w, h: size };
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = size * 0.35;
    ctx.shadowOffsetY = size * 0.1;
    ctx.fillStyle = 'rgba(22,22,26,0.9)';
    roundRect(ctx, r, size * 0.24);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, size * 0.03);
    roundRect(ctx, r, size * 0.24);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(cap, x + w / 2, cy + lift + size * 0.02);
    x += w + gap;
  });
  ctx.restore();
}

function slate(ctx: Ctx, r: Rect, radius: number, label: string, H: number) {
  ctx.save();
  roundRect(ctx, r, radius);
  ctx.fillStyle = '#14110f';
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,236,214,0.05)';
  ctx.lineWidth = H * 0.012;
  for (let x = r.x - r.h; x < r.x + r.w; x += H * 0.05) {
    ctx.beginPath();
    ctx.moveTo(x, r.y + r.h);
    ctx.lineTo(x + r.h, r.y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(243,236,227,0.55)';
  ctx.font = `600 ${Math.min(H * 0.03, r.h * 0.12)}px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
  ctx.restore();
}

// ───────────────────────────── screen ─────────────────────────────

const BEZEL = DEVICE_BEZEL;

function screenRadius(p: Placement, env: DrawEnv): number {
  return env.device ? BEZEL[env.device].radius * p.rect.w : p.radius;
}

/** A generic phone/tablet body behind the screen picture. No logos, notches or product likeness. */
function drawDeviceBody(ctx: Ctx, p: Placement, env: DrawEnv, U: number) {
  if (!env.device || p.opacity <= 0.01) return;
  const b = BEZEL[env.device];
  const col = DEVICE_COLORS[deviceOf(env.appearance).color];
  const e = b.edge * p.rect.w;
  const body: Rect = { x: p.rect.x - e, y: p.rect.y - e, w: p.rect.w + 2 * e, h: p.rect.h + 2 * e };
  const radius = screenRadius(p, env) + e;
  shadow(ctx, body, radius, env.appearance.frame.shadow, U, p.opacity);
  ctx.save();
  ctx.globalAlpha = p.opacity;
  const g = ctx.createLinearGradient(body.x, body.y, body.x + body.w, body.y + body.h);
  g.addColorStop(0, col.edge);
  g.addColorStop(0.5, col.body);
  g.addColorStop(1, col.edge);
  ctx.fillStyle = g;
  roundRect(ctx, body, radius);
  ctx.fill();
  // inner lip so the glass reads as inset
  ctx.fillStyle = '#050506';
  roundRect(ctx, { x: p.rect.x - e * 0.28, y: p.rect.y - e * 0.28, w: p.rect.w + e * 0.56, h: p.rect.h + e * 0.56 }, screenRadius(p, env) + e * 0.28);
  ctx.fill();
  ctx.restore();
}

/** One sub-sample of the screen picture (content + masks), clipped to its rounded rect. */
function drawScreenPose(ctx: Ctx, p: Placement & { zoom: ZoomPose }, alpha: number, state: FrameState, res: FrameResources, env: DrawEnv, U: number) {
  if (alpha <= 0.003) return;
  const ap = env.appearance;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, p.rect, screenRadius(p, env));
  ctx.clip();
  if (res.screen) {
    const view = viewport(ap, p.zoom);
    res.screen.draw(ctx, view.x * res.screen.width, view.y * res.screen.height, view.w * res.screen.width, view.h * res.screen.height, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
    // Masks ride on every sub-sample, so motion blur can never smear hidden content into view.
    drawMasks(ctx, state.masks.filter((m) => m.target === 'screen'), res.screen, view, p.rect, env, U);
  } else {
    slate(ctx, p.rect, p.radius, 'Screen source unavailable', U);
  }
  ctx.restore();
}

function drawLens(ctx: Ctx, lens: LensState, s: Placement & { zoom: ZoomPose }, state: FrameState, res: FrameResources, env: DrawEnv, cursorScale: number) {
  if (!res.screen || lens.amount <= 0.01) return;
  const ap = env.appearance;
  const view = viewport(ap, s.zoom);
  const c = project(view, s.rect, { x: lens.x, y: lens.y, w: 0, h: 0 });
  const R = (lens.size * s.rect.h * (0.6 + 0.4 * easeOutBack(lens.amount))) / 2;
  // keep the lens inside the picture
  const cx = Math.min(s.rect.x + s.rect.w - R * 0.4, Math.max(s.rect.x + R * 0.4, c.x));
  const cy = Math.min(s.rect.y + s.rect.h - R * 0.4, Math.max(s.rect.y + R * 0.4, c.y));
  const mag = Math.max(1.1, lens.magnification);
  ctx.save();
  ctx.globalAlpha = s.opacity * lens.amount;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = R * 0.3;
  ctx.shadowOffsetY = R * 0.08;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#0b0b0d';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  // source window under the lens, in source-normalised units
  const sw = ((2 * R) / s.rect.w) * view.w / mag;
  const sh = ((2 * R) / s.rect.h) * view.h / mag;
  res.screen.draw(ctx, (lens.x - sw / 2) * res.screen.width, (lens.y - sh / 2) * res.screen.height, sw * res.screen.width, sh * res.screen.height, cx - R, cy - R, 2 * R, 2 * R);
  const lensView: Rect = { x: lens.x - sw / 2, y: lens.y - sh / 2, w: sw, h: sh };
  drawMasks(ctx, state.masks.filter((m) => m.target === 'screen'), res.screen, lensView, { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }, { ...env, editor: undefined }, Math.min(ap.output.width, ap.output.height));
  if (state.cursor) {
    const p = project(lensView, { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }, { x: state.cursor.x, y: state.cursor.y, w: 0, h: 0 });
    drawCursor(ctx, p.x, p.y, cursorScale * mag, state.cursor.opacity, state.cursor.kind, state.cursor.angle);
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = s.opacity * lens.amount;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = Math.max(2, R * 0.035);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R - Math.max(2, R * 0.035), 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = Math.max(1, R * 0.012);
  ctx.stroke();
  ctx.restore();
}

// ───────────────────────────── camera ─────────────────────────────

const scratch: Record<string, OffscreenCanvas> = {};
function scratchCanvas(key: string, w: number, h: number): OffscreenCanvasRenderingContext2D {
  let c = scratch[key];
  if (!c) c = scratch[key] = new OffscreenCanvas(w, h);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** Source window of the camera for a destination rect: cover-fit, then the face-tracking punch-in. */
function cameraWindow(src: Drawable, dst: Rect, crop: CameraCrop | undefined): { sx: number; sy: number; sw: number; sh: number } {
  const c = cover(src, dst);
  if (!crop || crop.scale <= 1.001 && Math.abs(crop.cx - 0.5) < 1e-3 && Math.abs(crop.cy - 0.5) < 1e-3) return c;
  const sw = c.sw / crop.scale;
  const sh = c.sh / crop.scale;
  const sx = Math.min(src.width - sw, Math.max(0, crop.cx * src.width - sw / 2));
  const sy = Math.min(src.height - sh, Math.max(0, crop.cy * src.height - sh / 2));
  return { sx, sy, sw, sh };
}

/** Camera pixels with the look applied, filling (0,0,w,h) of `ctx`. */
function paintCamera(ctx: Ctx, src: Drawable, win: { sx: number; sy: number; sw: number; sh: number }, x: number, y: number, w: number, h: number, ap: Appearance) {
  const look = cameraLookOf(ap);
  ctx.save();
  if (ap.camera.mirror) {
    ctx.translate(x * 2 + w, 0);
    ctx.scale(-1, 1);
  }
  const f = lookFilter(look);
  if (f !== 'none') ctx.filter = f;
  src.draw(ctx, win.sx, win.sy, win.sw, win.sh, x, y, w, h);
  ctx.filter = 'none';
  const warm = lookWarmth(look);
  if (warm) {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha *= warm.alpha;
    ctx.fillStyle = warm.color;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

/**
 * Camera with its background removed. The matte is luminance (white = person),
 * so the composite is built with multiply/add instead of an alpha channel:
 *   result = camera × matte + backdrop × (1 − matte)
 */
function drawCutout(ctx: Ctx, cam: Placement & { slot: CameraSlot; crop?: CameraCrop }, src: Drawable, matte: Drawable, env: DrawEnv, full: boolean) {
  const ap = env.appearance;
  const opt = cutoutOf(ap);
  const m = ctx.getTransform();
  const dx = Math.round(cam.rect.x * m.a + m.e);
  const dy = Math.round(cam.rect.y * m.d + m.f);
  const w = Math.max(2, Math.round(cam.rect.w * m.a));
  const h = Math.max(2, Math.round(cam.rect.h * m.d));
  const win = cameraWindow(src, cam.rect, cam.crop);
  const mwin = { sx: (win.sx / src.width) * matte.width, sy: (win.sy / src.height) * matte.height, sw: (win.sw / src.width) * matte.width, sh: (win.sh / src.height) * matte.height };
  const drawMatte = (c: Ctx) => {
    c.save();
    if (ap.camera.mirror) {
      c.translate(w, 0);
      c.scale(-1, 1);
    }
    matte.draw(c, mwin.sx, mwin.sy, mwin.sw, mwin.sh, 0, 0, w, h);
    c.restore();
  };
  // person = camera × matte
  const a = scratchCanvas('cutA', w, h);
  paintCamera(a, src, win, 0, 0, w, h, ap);
  a.globalCompositeOperation = 'multiply';
  drawMatte(a);
  // inverse matte
  const inv = scratchCanvas('cutInv', w, h);
  drawMatte(inv);
  inv.globalCompositeOperation = 'difference';
  inv.fillStyle = '#fff';
  inv.fillRect(0, 0, w, h);
  // backdrop × (1 − matte)
  const b = scratchCanvas('cutB', w, h);
  const floating = opt.backdrop === 'none' && !full;
  if (floating) b.drawImage(ctx.canvas as CanvasImageSource, dx, dy, w, h, 0, 0, w, h);
  else if (opt.backdrop === 'color' || opt.backdrop === 'none') {
    b.fillStyle = opt.backdrop === 'color' ? opt.color : '#101114';
    b.fillRect(0, 0, w, h);
  } else {
    b.filter = `blur(${Math.max(6, w * 0.035)}px)`;
    paintCamera(b, src, win, -w * 0.06, -h * 0.06, w * 1.12, h * 1.12, ap);
    b.filter = 'none';
    b.fillStyle = 'rgba(8,8,10,0.25)';
    b.fillRect(0, 0, w, h);
  }
  b.globalCompositeOperation = 'multiply';
  b.drawImage(inv.canvas, 0, 0);
  b.globalCompositeOperation = 'lighter';
  b.drawImage(a.canvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = cam.opacity;
  if (floating) {
    // no bubble: the person stands directly on the picture
    ctx.drawImage(b.canvas, cam.rect.x, cam.rect.y, cam.rect.w, cam.rect.h);
  } else {
    roundRect(ctx, cam.rect, cam.radius);
    ctx.clip();
    ctx.drawImage(b.canvas, cam.rect.x, cam.rect.y, cam.rect.w, cam.rect.h);
  }
  ctx.restore();
}

function drawCamera(ctx: Ctx, cam: Placement & { slot: CameraSlot; crop?: CameraCrop }, state: FrameState, res: FrameResources, env: DrawEnv, U: number, alpha: number, decorate: boolean) {
  const ap = env.appearance;
  const { width: W, height: H } = ap.output;
  const src = cam.slot === 'A' ? res.cameraA : res.cameraB;
  const matte = cam.slot === 'A' ? res.matteA : res.matteB;
  const full = cam.rect.w >= W - 1 && cam.rect.h >= H - 1;
  const cut = cutoutOf(ap);
  const cutout = cut.enabled && !!src && !!matte;
  const floating = cutout && cut.backdrop === 'none' && !full;
  if (decorate && !full && !floating) shadow(ctx, cam.rect, cam.radius, ap.camera.shadow, U, cam.opacity);
  if (cutout) {
    drawCutout(ctx, { ...cam, opacity: alpha }, src!, matte!, env, full);
  } else {
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, cam.rect, cam.radius);
    ctx.clip();
    if (src) {
      const win = cameraWindow(src, cam.rect, cam.crop);
      paintCamera(ctx, src, win, cam.rect.x, cam.rect.y, cam.rect.w, cam.rect.h, ap);
      const target = cam.slot === 'A' ? 'cameraA' : 'cameraB';
      const view: Rect = { x: win.sx / src.width, y: win.sy / src.height, w: win.sw / src.width, h: win.sh / src.height };
      drawMasks(ctx, state.masks.filter((mk) => mk.target === target), src, view, cam.rect, env, U);
    } else {
      slate(ctx, cam.rect, 0, `Camera ${cam.slot} unavailable`, U);
    }
    ctx.restore();
  }
  if (decorate && !full && !floating) {
    ctx.save();
    ctx.globalAlpha = cam.opacity * 0.22;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, U * 0.0015);
    roundRect(ctx, cam.rect, cam.radius);
    ctx.stroke();
    ctx.restore();
  }
}

// ───────────────────────────── grade ─────────────────────────────

/**
 * Sharpening and the colour LUT are applied to the source pictures before
 * anything is composed, so zooms, masks, the lens and the cutout all see the
 * graded pixels. The unsharp radius is one output pixel, expressed in source
 * pixels, which keeps the result the same at any preview size.
 */
function gradeResources(state: FrameState, res: FrameResources, env: DrawEnv): FrameResources {
  const ap = env.appearance;
  if (!ap.grade) return res;
  const g = gradeOf(ap);
  let out = res;
  const screenLut = g.screen.lut ? (env.luts?.screen ?? null) : null;
  if (res.screen && state.screen && state.screen.opacity > 0.01 && gradeActive(g.screen, !!screenLut)) {
    const view = viewport(ap, state.screen.zoom);
    const radius = Math.max(1, (view.w * res.screen.width) / Math.max(1, state.screen.rect.w));
    out = { ...out, screen: gradeDrawable('screen', res.screen, { lut: screenLut, strength: g.screen.strength, sharpen: g.screen.sharpen, radius }) };
  }
  const camLut = g.camera.lut ? (env.luts?.camera ?? null) : null;
  if (gradeActive(g.camera, !!camLut)) {
    for (const cam of state.cameras) {
      const key = cam.slot === 'A' ? 'cameraA' : 'cameraB';
      const src = res[key];
      if (!src || cam.opacity <= 0.01 || out[key] !== res[key]) continue;
      const win = cameraWindow(src, cam.rect, cam.crop);
      const radius = Math.max(1, win.sw / Math.max(1, cam.rect.w));
      out = { ...out, [key]: gradeDrawable(key, src, { lut: camLut, strength: g.camera.strength, sharpen: g.camera.sharpen, radius }) };
    }
  }
  return out;
}

// ───────────────────────────── frame ─────────────────────────────

export function drawFrame(ctx: Ctx, state: FrameState, sources: FrameResources, env: DrawEnv): void {
  const ap = env.appearance;
  const { width: W, height: H } = ap.output;
  const U = Math.min(W, H);
  const res = gradeResources(state, sources, env);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  drawBackground(ctx, ap, res);

  const brollCovers = !!state.broll && state.broll.opacity >= 0.999 && !!res.broll;
  // Motion blur: earlier poses (oldest first) then the current one. Drawing sample i at
  // alpha 1/(i+1) leaves every sample with equal weight, i.e. a box-filter shutter.
  const poses = state.screen ? [...state.blur.map((p) => p.screen), state.screen] : [];

  // ── screen ──
  if (state.screen && state.screen.opacity > 0.01 && !brollCovers) {
    const s = state.screen;
    if (env.device) drawDeviceBody(ctx, s, env, U);
    else shadow(ctx, s.rect, s.radius, ap.frame.shadow, U, s.opacity);
    poses.forEach((p, i) => drawScreenPose(ctx, p, p.opacity * (i === 0 ? 1 : 1 / (i + 1)), state, res, env, U));
    if (res.screen) {
      const view = viewport(ap, s.zoom);
      const scale = (s.rect.w / (env.screenPoints?.width ?? 1440)) * (ap.crop.w > 0 ? 1 / ap.crop.w : 1) * s.zoom.scale;
      ctx.save();
      ctx.globalAlpha = s.opacity;
      roundRect(ctx, s.rect, screenRadius(s, env));
      ctx.clip();
      if (state.cursor) {
        const c = state.cursor;
        for (const r of c.ripples) {
          const p = project(view, s.rect, { x: r.x, y: r.y, w: 0, h: 0 });
          ctx.save();
          ctx.globalAlpha = s.opacity * (1 - r.age) * 0.75;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5 * scale * ap.cursor.size;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (8 + r.age * 26) * scale * ap.cursor.size, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = `rgba(255,255,255,${0.18 * (1 - r.age)})`;
          ctx.fill();
          ctx.restore();
        }
        // smear: fading ghosts along the path travelled during the shutter
        const n = c.trail.length;
        // the faster the pointer travelled during the shutter, the stronger the smear
        const travelled = n ? Math.hypot(c.trail[0]!.x - c.x, c.trail[0]!.y - c.y) : 0;
        const strength = Math.min(1, travelled / 0.02);
        if (strength > 0.05) {
          // many faint copies along the path read as one continuous streak that fades towards its tail
          c.trail.forEach((t, i) => {
            const p = project(view, s.rect, { x: t.x, y: t.y, w: 0, h: 0 });
            drawCursor(ctx, p.x, p.y, scale * ap.cursor.size, c.opacity * strength * ((2.4 * (i + 1)) / (n * n)), c.kind, c.angle, false);
          });
        }
        const p = project(view, s.rect, { x: c.x, y: c.y, w: 0, h: 0 });
        drawCursor(ctx, p.x, p.y, scale * ap.cursor.size, c.opacity * (1 - 0.15 * strength), c.kind, c.angle);
      }
      ctx.restore();
      if (state.lens) drawLens(ctx, state.lens, s, state, res, env, (s.rect.w / (env.screenPoints?.width ?? 1440)) * (ap.crop.w > 0 ? 1 / ap.crop.w : 1) * ap.cursor.size);
    }
    if (!env.device && (ap.frame.inset > 0 || s.radius > 0)) {
      ctx.save();
      ctx.globalAlpha = s.opacity * (0.12 + ap.frame.inset * 0.5);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, U * 0.0012 * (1 + ap.frame.inset * 4));
      roundRect(ctx, s.rect, s.radius);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── cameras ──
  if (!brollCovers) {
    const moving = state.blur.length > 0 && state.blur.every((p) => p.cameras.length === state.cameras.length);
    for (let ci = 0; ci < state.cameras.length; ci++) {
      const cam = state.cameras[ci]!;
      if (moving) {
        // blurred transition: equal-weight sub-samples of the moving camera frame
        const subs = [...state.blur.map((p) => p.cameras[ci]!).filter((c) => c.slot === cam.slot), cam];
        subs.forEach((c, i) => drawCamera(ctx, { ...cam, rect: c.rect, radius: c.radius, opacity: c.opacity }, state, res, env, U, c.opacity * (i === 0 ? 1 : 1 / (i + 1)), i === subs.length - 1 && subs.length === 1));
      } else {
        drawCamera(ctx, cam, state, res, env, U, cam.opacity, true);
      }
    }
  }

  // ── unresolved: never an unmarked blank frame ──
  if (state.unresolved && !state.broll) slate(ctx, { x: W * 0.2, y: H * 0.3, w: W * 0.6, h: H * 0.4 }, U * 0.02, 'No source covers this moment', U);

  // ── B-roll covers the picture, narration continues ──
  if (state.broll && res.broll) {
    ctx.save();
    ctx.globalAlpha = state.broll.opacity;
    const full: Rect = { x: 0, y: 0, w: W, h: H };
    if (state.broll.insert.fit === 'contain') {
      ctx.fillStyle = '#0c0a09';
      ctx.fillRect(0, 0, W, H);
      const a = res.broll.width / res.broll.height;
      const w = Math.min(W, H * a);
      const h = w / a;
      res.broll.draw(ctx, 0, 0, res.broll.width, res.broll.height, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      const c = cover(res.broll, full);
      res.broll.draw(ctx, c.sx, c.sy, c.sw, c.sh, 0, 0, W, H);
    }
    ctx.restore();
  }

  for (const o of state.overlays) drawOverlay(ctx, o.overlay, o.enter, o.exit, W, H);
  const captionShown = !!env.cue && ap.captions.burnIn;
  if (captionShown) drawCaption(ctx, env.cue!, ap, W, H);
  if (state.shortcuts.length) drawShortcuts(ctx, state.shortcuts, ap, W, H, captionShown);
  ctx.restore();
}

/** Which camera slots and whether the screen are needed to draw a frame (lets export skip decoding hidden sources). */
export function neededSources(state: FrameState): { screen: boolean; cameras: CameraSlot[]; broll: string | null } {
  const covered = !!state.broll && state.broll.opacity >= 0.999;
  return {
    screen: !!state.screen && state.screen.opacity > 0.01 && !covered,
    cameras: covered ? [] : state.cameras.map((c) => c.slot),
    broll: state.broll?.insert.assetId ?? null,
  };
}
