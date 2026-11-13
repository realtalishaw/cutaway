/**
 * The one compositor. Preview and export both call drawFrame with a FrameState
 * from core.evaluateFrame, so what the creator approves is what gets encoded.
 * All geometry is in output pixels (appearance.output); the caller scales the
 * context for smaller preview canvases.
 */
import { WALLPAPERS, easeOutBack, type Appearance, type CameraSlot, type Cue, type FrameState, type Mask, type Overlay, type Rect } from '@cutaway/core';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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
}

export interface DrawEnv {
  appearance: Appearance;
  /** Logical size of the captured area, for cursor scale. */
  screenPoints: { width: number; height: number } | null;
  /** Burned-in caption for this frame, if captions are enabled. */
  cue: Cue | null;
  /** Editor-only decorations (mask outlines). Never set during export. */
  editor?: { selectedMaskId: string | null };
}

const FONT_SERIF = "'Instrument Serif', Georgia, serif";
const FONT_SANS = "'Hanken Grotesk Variable', 'Hanken Grotesk', -apple-system, sans-serif";

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
    if (bg.blur > 0) ctx.filter = `blur(${bg.blur * H * 0.04}px)`;
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
      ctx.filter = `blur(${blur}px)`;
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

function drawCursor(ctx: Ctx, x: number, y: number, size: number, opacity: number) {
  // arrow pointer, tip at (x, y)
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
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
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#fff';
  ctx.stroke();
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

function drawOverlay(ctx: Ctx, o: Overlay, enter: number, exit: number, W: number, H: number) {
  const a = Math.min(enter, exit);
  if (a <= 0) return;
  ctx.save();
  if (o.kind === 'section-card') {
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,9,8,0.82)';
    ctx.fillRect(0, 0, W, H);
    const slide = (1 - easeOutBack(enter)) * H * 0.03;
    ctx.fillStyle = '#ff5a36';
    ctx.fillRect(W * 0.1, H * 0.5 - H * 0.12 + slide, W * 0.05, H * 0.008);
    ctx.fillStyle = '#f3ece3';
    ctx.font = `400 ${H * 0.105}px ${FONT_SERIF}`;
    ctx.textBaseline = 'alphabetic';
    const lines = wrapLines(ctx, o.text, W * 0.78, 2);
    lines.forEach((l, i) => ctx.fillText(l, W * 0.1, H * 0.5 + i * H * 0.115 + slide));
    if (o.subtext) {
      ctx.font = `500 ${H * 0.03}px ${FONT_SANS}`;
      ctx.fillStyle = 'rgba(243,236,227,0.7)';
      ctx.fillText(o.subtext, W * 0.1, H * 0.5 + lines.length * H * 0.115 - H * 0.03 + slide);
    }
  } else if (o.kind === 'lower-third') {
    ctx.globalAlpha = a;
    const x = W * 0.05;
    const y = H * 0.8;
    const slide = (1 - easeOutBack(enter)) * W * 0.02;
    ctx.font = `680 ${H * 0.04}px ${FONT_SANS}`;
    const tw = ctx.measureText(o.text).width;
    ctx.font = `500 ${H * 0.026}px ${FONT_SANS}`;
    const sw = o.subtext ? ctx.measureText(o.subtext).width : 0;
    const w = Math.max(tw, sw) + H * 0.07;
    const h = o.subtext ? H * 0.115 : H * 0.078;
    ctx.fillStyle = 'rgba(15,12,10,0.86)';
    roundRect(ctx, { x: x - slide, y, w, h }, H * 0.014);
    ctx.fill();
    ctx.fillStyle = '#ff5a36';
    ctx.fillRect(x - slide, y + h * 0.2, H * 0.006, h * 0.6);
    ctx.fillStyle = '#f3ece3';
    ctx.font = `680 ${H * 0.04}px ${FONT_SANS}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(o.text, x - slide + H * 0.035, y + (o.subtext ? h * 0.36 : h * 0.52));
    if (o.subtext) {
      ctx.font = `500 ${H * 0.026}px ${FONT_SANS}`;
      ctx.fillStyle = 'rgba(243,236,227,0.72)';
      ctx.fillText(o.subtext, x - slide + H * 0.035, y + h * 0.72);
    }
  } else {
    // callout pill anchored at (x, y)
    const s = 0.9 + 0.1 * easeOutBack(enter);
    ctx.globalAlpha = a;
    ctx.font = `640 ${H * 0.036}px ${FONT_SANS}`;
    const lines = wrapLines(ctx, o.text, W * 0.5, 2);
    const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const lh = H * 0.046;
    const w = tw + H * 0.06;
    const h = lines.length * lh + H * 0.036;
    const cx = Math.min(W - w / 2 - H * 0.03, Math.max(w / 2 + H * 0.03, o.x * W));
    const cy = Math.min(H - h / 2 - H * 0.03, Math.max(h / 2 + H * 0.03, o.y * H));
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = H * 0.03;
    ctx.shadowOffsetY = H * 0.01;
    ctx.fillStyle = '#f5c84b';
    roundRect(ctx, { x: -w / 2, y: -h / 2, w, h }, H * 0.02);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#17120a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * lh + H * 0.002));
  }
  ctx.restore();
}

function drawCaption(ctx: Ctx, cue: Cue, ap: Appearance, W: number, H: number) {
  const size = H * 0.04 * ap.captions.size;
  ctx.save();
  ctx.font = `${ap.captions.style === 'bold' ? 800 : 620} ${size}px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, cue.text, W * 0.72, 2);
  const lh = size * 1.28;
  const cy = ap.captions.position === 'bottom' ? H * 0.9 - ((lines.length - 1) * lh) / 2 : H * 0.1 + ((lines.length - 1) * lh) / 2;
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

export function drawFrame(ctx: Ctx, state: FrameState, res: FrameResources, env: DrawEnv): void {
  const ap = env.appearance;
  const { width: W, height: H } = ap.output;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  drawBackground(ctx, ap, res);

  const brollCovers = !!state.broll && state.broll.opacity >= 0.999 && !!res.broll;

  // ── screen ──
  if (state.screen && state.screen.opacity > 0.01 && !brollCovers) {
    const s = state.screen;
    shadow(ctx, s.rect, s.radius, ap.frame.shadow, H, s.opacity);
    ctx.save();
    ctx.globalAlpha = s.opacity;
    roundRect(ctx, s.rect, s.radius);
    ctx.clip();
    if (res.screen) {
      const view = viewport(ap, s.zoom);
      res.screen.draw(ctx, view.x * res.screen.width, view.y * res.screen.height, view.w * res.screen.width, view.h * res.screen.height, s.rect.x, s.rect.y, s.rect.w, s.rect.h);
      drawMasks(ctx, state.masks.filter((m) => m.target === 'screen'), res.screen, view, s.rect, env, H);
      if (state.cursor) {
        const c = state.cursor;
        const scale = (s.rect.w / (env.screenPoints?.width ?? 1440)) * (ap.crop.w > 0 ? 1 / ap.crop.w : 1) * s.zoom.scale;
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
        const p = project(view, s.rect, { x: c.x, y: c.y, w: 0, h: 0 });
        drawCursor(ctx, p.x, p.y, scale * ap.cursor.size, c.opacity);
      }
    } else {
      slate(ctx, s.rect, s.radius, 'Screen source unavailable', H);
    }
    ctx.restore();
    if (ap.frame.inset > 0 || s.radius > 0) {
      ctx.save();
      ctx.globalAlpha = s.opacity * (0.12 + ap.frame.inset * 0.5);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, H * 0.0012 * (1 + ap.frame.inset * 4));
      roundRect(ctx, s.rect, s.radius);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ── cameras ──
  if (!brollCovers) {
    for (const cam of state.cameras) {
      const src = cam.slot === 'A' ? res.cameraA : res.cameraB;
      const full = cam.rect.w >= W - 1 && cam.rect.h >= H - 1;
      if (!full) shadow(ctx, cam.rect, cam.radius, ap.camera.shadow, H, cam.opacity);
      ctx.save();
      ctx.globalAlpha = cam.opacity;
      roundRect(ctx, cam.rect, cam.radius);
      ctx.clip();
      if (src) {
        const c = cover(src, cam.rect);
        if (ap.camera.mirror) {
          ctx.translate(cam.rect.x * 2 + cam.rect.w, 0);
          ctx.scale(-1, 1);
        }
        src.draw(ctx, c.sx, c.sy, c.sw, c.sh, cam.rect.x, cam.rect.y, cam.rect.w, cam.rect.h);
        const target = cam.slot === 'A' ? 'cameraA' : 'cameraB';
        const view: Rect = { x: c.sx / src.width, y: c.sy / src.height, w: c.sw / src.width, h: c.sh / src.height };
        drawMasks(ctx, state.masks.filter((m) => m.target === target), src, view, cam.rect, env, H);
      } else {
        slate(ctx, cam.rect, 0, `Camera ${cam.slot} unavailable`, H);
      }
      ctx.restore();
      if (!full) {
        ctx.save();
        ctx.globalAlpha = cam.opacity * 0.22;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, H * 0.0015);
        roundRect(ctx, cam.rect, cam.radius);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // ── unresolved: never an unmarked blank frame ──
  if (state.unresolved && !state.broll) slate(ctx, { x: W * 0.2, y: H * 0.3, w: W * 0.6, h: H * 0.4 }, H * 0.02, 'No source covers this moment', H);

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
  if (env.cue && ap.captions.burnIn) drawCaption(ctx, env.cue, ap, W, H);
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
