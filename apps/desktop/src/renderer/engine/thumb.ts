/**
 * Thumbnail compositor.
 *
 * A thumbnail is a stack of editable layers (core ThumbnailLayer). Every
 * position and size is a fraction of the canvas, so the same layers render
 * identically at editor size, at the 1920×1080 upload variant and at the
 * 3840×2160 master. Frame layers are real stills grabbed from the source file.
 */
import type { MediaSource, ThumbnailLayer } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';

export interface ThumbOpts {
  width: number;
  height: number;
  projectPath: string;
  sources: MediaSource[];
}

type Drawable = HTMLCanvasElement | HTMLImageElement;
type TextLayer = Extract<ThumbnailLayer, { kind: 'text' }>;
type FrameLayer = Extract<ThumbnailLayer, { kind: 'frame' }>;

const FONTS: Record<TextLayer['font'], string> = {
  display: "'Anton', 'Impact', sans-serif",
  grotesk: "'Hanken Grotesk Variable', 'Hanken Grotesk', 'Helvetica Neue', sans-serif",
  serif: "'Instrument Serif', Georgia, serif",
  mono: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
};

/** Anton and Instrument Serif ship a single weight; asking for another makes Chromium synthesise an ugly faux bold. */
function fontWeight(l: TextLayer): number {
  return l.font === 'display' || l.font === 'serif' ? 400 : l.weight;
}

export function fontOf(l: TextLayer, H: number): string {
  return `${fontWeight(l)} ${Math.max(4, l.size * H)}px ${FONTS[l.font]}`;
}

// ───────────────────────────── resources ─────────────────────────────

const cache = new Map<string, Drawable>();
const pending = new Map<string, Promise<Drawable | null>>();
const failed = new Set<string>();
/** One decoder per file at a time: seeks are queued instead of spawning a video element per still. */
const videoQueues = new Map<string, Promise<unknown>>();
const videos = new Map<string, HTMLVideoElement>();
const MAX_CACHE = 48;

function remember(key: string, d: Drawable) {
  cache.set(key, d);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

function frameKey(sourceId: string, time: number): string {
  return `frame:${sourceId}@${time.toFixed(2)}`;
}

export function layerResourceKey(l: ThumbnailLayer): string | null {
  if (l.kind === 'frame') return frameKey(l.sourceId, l.time);
  if (l.kind === 'image') return `image:${l.path}`;
  return null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = url;
  });
}

function videoFor(url: string): Promise<HTMLVideoElement> {
  const existing = videos.get(url);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    const fail = () => reject(new Error('The video could not be decoded.'));
    v.addEventListener('error', fail, { once: true });
    v.addEventListener(
      'loadeddata',
      () => {
        v.removeEventListener('error', fail);
        videos.set(url, v);
        resolve(v);
      },
      { once: true },
    );
    v.src = url;
  });
}

async function grabVideoFrame(url: string, time: number): Promise<HTMLCanvasElement> {
  const v = await videoFor(url);
  const target = Math.max(0, Math.min(time, Math.max(0, (Number.isFinite(v.duration) ? v.duration : time) - 0.05)));
  if (Math.abs(v.currentTime - target) > 0.001 || v.readyState < 2) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out reading a frame.')), 8000);
      v.addEventListener(
        'seeked',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
      v.currentTime = target;
    });
  }
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d')!.drawImage(v, 0, 0);
  return c;
}

/** An actual still of a source at `time` (seconds inside the file). Cached per source and time. */
export function loadFrame(opts: Pick<ThumbOpts, 'projectPath' | 'sources'>, sourceId: string, time: number): Promise<Drawable | null> {
  const key = frameKey(sourceId, time);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const src = opts.sources.find((s) => s.id === sourceId);
  if (!src || !src.available || src.kind === 'audio') {
    failed.add(key);
    return Promise.resolve(null);
  }
  const url = window.cutaway.media.url(resolveSourcePath(opts.projectPath, src.path));
  const work = async (): Promise<Drawable | null> => {
    try {
      const d = src.kind === 'image' ? await loadImage(url) : await grabVideoFrame(url, time);
      remember(key, d);
      failed.delete(key);
      return d;
    } catch {
      failed.add(key);
      return null;
    } finally {
      pending.delete(key);
    }
  };
  // Serialise seeks on the same file.
  const prev = videoQueues.get(url) ?? Promise.resolve();
  const p = prev.then(work, work);
  videoQueues.set(url, p);
  pending.set(key, p);
  return p;
}

function loadImageLayer(path: string): Promise<Drawable | null> {
  const key = `image:${path}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const p = loadImage(window.cutaway.media.url(path))
    .then((img) => {
      remember(key, img);
      return img as Drawable;
    })
    .catch(() => {
      failed.add(key);
      return null;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Load every still, image and font the layers need. Resolves when a draw would be complete. */
export async function prepareThumbnail(layers: ThumbnailLayer[], opts: Pick<ThumbOpts, 'projectPath' | 'sources'>): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const fonts = new Set<string>();
  for (const l of layers) {
    if (l.kind === 'frame') jobs.push(loadFrame(opts, l.sourceId, l.time));
    else if (l.kind === 'image') jobs.push(loadImageLayer(l.path));
    else if (l.kind === 'text') fonts.add(`${fontWeight(l)} 48px ${FONTS[l.font]}`);
  }
  for (const f of fonts) jobs.push(document.fonts.load(f).catch(() => null));
  await Promise.all(jobs);
}

/** True when a frame/image layer could not be loaded (missing source, undecodable file). */
export function layerFailed(l: ThumbnailLayer): boolean {
  const k = layerResourceKey(l);
  return !!k && failed.has(k) && !cache.has(k);
}

// ───────────────────────────── drawing ─────────────────────────────

function rgba(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

export interface TextBlock {
  lines: string[];
  lineHeight: number;
  /** Bounding box of the laid-out text before rotation, in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Wrap and measure a text layer. Shared by drawing and hit-testing so the selection box always matches the pixels. */
export function layoutText(ctx: CanvasRenderingContext2D, l: TextLayer, W: number, H: number): TextBlock {
  ctx.save();
  ctx.font = fontOf(l, H);
  const raw = l.uppercase ? l.text.toUpperCase() : l.text;
  const max = Math.max(0.05, l.maxWidth) * W;
  const lines: string[] = [];
  for (const para of raw.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > max) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    lines.push(line);
  }
  const width = Math.max(1, ...lines.map((s) => ctx.measureText(s).width));
  ctx.restore();
  const px = l.size * H;
  const lineHeight = px * (l.font === 'display' ? 1.08 : l.font === 'serif' ? 1.04 : 1.14);
  const h = lineHeight * lines.length;
  const ax = l.x * W;
  const x = l.align === 'left' ? ax : l.align === 'right' ? ax - width : ax - width / 2;
  return { lines, lineHeight, x, y: l.y * H - h / 2, w: width, h };
}

/**
 * Where a frame layer lands. The still always covers the whole canvas: its
 * centre is clamped so moving or scaling it can never expose an empty edge.
 */
function coverRect(l: FrameLayer, iw: number, ih: number, W: number, H: number): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
  const s = Math.max(W / iw, H / ih) * Math.max(1, l.scale);
  const w = iw * s;
  const h = ih * s;
  const cx = Math.min(w / 2, Math.max(W - w / 2, l.x * W));
  const cy = Math.min(h / 2, Math.max(H - h / 2, l.y * H));
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

function drawCover(ctx: CanvasRenderingContext2D, img: Drawable, l: FrameLayer, W: number, H: number) {
  const iw = img.width;
  const ih = img.height;
  if (!iw || !ih) return;
  const r = coverRect(l, iw, ih, W, H);
  ctx.save();
  const filters = [`brightness(${l.brightness})`, `saturate(${l.saturation})`];
  if (l.blur > 0) filters.push(`blur(${(l.blur * H).toFixed(2)}px)`);
  ctx.filter = filters.join(' ');
  ctx.translate(r.cx, r.cy);
  if (l.mirror) ctx.scale(-1, 1);
  ctx.drawImage(img, -r.w / 2, -r.h / 2, r.w, r.h);
  ctx.restore();
}

function drawMissing(ctx: CanvasRenderingContext2D, W: number, H: number, loading: boolean) {
  ctx.save();
  ctx.fillStyle = '#17130f';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255, 236, 214, 0.05)';
  ctx.lineWidth = Math.max(1, H / 90);
  const step = H / 7;
  for (let x = -H; x < W; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x + H, 0);
    ctx.stroke();
  }
  if (!loading) {
    ctx.fillStyle = 'rgba(255, 236, 214, 0.35)';
    ctx.font = `500 ${H * 0.04}px ${FONTS.grotesk}`;
    ctx.textAlign = 'right';
    ctx.fillText('Frame unavailable', W - H * 0.04, H - H * 0.04);
  }
  ctx.restore();
}

/**
 * Draw the layers with whatever resources are already loaded. Returns false
 * when a still or image was not ready, so the caller can redraw after
 * prepareThumbnail resolves.
 */
export function drawThumbnail(ctx: CanvasRenderingContext2D, layers: ThumbnailLayer[], W: number, H: number): boolean {
  let complete = true;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d0b0a';
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  for (const l of layers) {
    switch (l.kind) {
      case 'frame': {
        const img = cache.get(frameKey(l.sourceId, l.time));
        if (img) drawCover(ctx, img, l, W, H);
        else {
          const isFailed = layerFailed(l);
          if (!isFailed) complete = false;
          drawMissing(ctx, W, H, !isFailed);
        }
        break;
      }
      case 'image': {
        const img = cache.get(`image:${l.path}`);
        if (!img) {
          if (!layerFailed(l)) complete = false;
          break;
        }
        const w = l.scale * W;
        const h = (w * img.height) / Math.max(1, img.width);
        ctx.save();
        ctx.globalAlpha = l.opacity;
        ctx.drawImage(img, l.x * W - w / 2, l.y * H - h / 2, w, h);
        ctx.restore();
        break;
      }
      case 'scrim': {
        // angle: direction the gradient travels, CSS-style (90 = left→right, 180 = top→bottom)
        const a = ((l.angle - 90) * Math.PI) / 180;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
        const g = ctx.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
        // "transparent" fades the *other* colour out, so there is no grey halo mid-gradient
        const from = l.from === 'transparent' ? rgba(l.to, 0) : l.from;
        const to = l.to === 'transparent' ? rgba(l.from, 0) : l.to;
        g.addColorStop(0, from);
        g.addColorStop(l.from === 'transparent' ? 0.35 : 0.3, l.from === 'transparent' ? from : rgba(l.from, 0.86));
        g.addColorStop(1, to);
        ctx.save();
        ctx.globalAlpha = l.opacity;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        break;
      }
      case 'shape': {
        const x = l.x * W;
        const y = l.y * H;
        const w = l.w * W;
        const h = l.h * H;
        ctx.save();
        ctx.globalAlpha = l.opacity;
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((l.rotation * Math.PI) / 180);
        ctx.fillStyle = l.color;
        if (l.shape === 'circle') {
          ctx.beginPath();
          ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else roundRect(ctx, -w / 2, -h / 2, w, h, l.shape === 'pill' ? Math.min(w, h) / 2 : 0);
        ctx.fill();
        ctx.restore();
        break;
      }
      case 'text': {
        if (!l.text.trim()) break;
        const b = layoutText(ctx, l, W, H);
        ctx.save();
        ctx.translate(l.x * W, l.y * H);
        ctx.rotate((l.rotation * Math.PI) / 180);
        ctx.translate(-l.x * W, -l.y * H);
        if (l.background) {
          const padX = l.size * H * 0.28;
          const padY = l.size * H * 0.14;
          ctx.fillStyle = l.background;
          roundRect(ctx, b.x - padX, b.y - padY, b.w + padX * 2, b.h + padY * 2, l.size * H * 0.12);
          ctx.fill();
        }
        ctx.font = fontOf(l, H);
        ctx.textBaseline = 'middle';
        ctx.textAlign = l.align;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        b.lines.forEach((line, i) => {
          const y = b.y + b.lineHeight * (i + 0.5);
          if (l.stroke && l.strokeWidth > 0) {
            ctx.strokeStyle = l.stroke;
            ctx.lineWidth = l.strokeWidth * H * 2;
            ctx.strokeText(line, l.x * W, y);
          }
          ctx.fillStyle = l.color;
          ctx.fillText(line, l.x * W, y);
        });
        ctx.restore();
        break;
      }
    }
  }
  ctx.restore();
  return complete;
}

/** Render the layers to a new canvas once every still, image and font is loaded. */
export async function renderThumbnail(layers: ThumbnailLayer[], opts: ThumbOpts): Promise<HTMLCanvasElement> {
  await prepareThumbnail(layers, opts);
  const c = document.createElement('canvas');
  c.width = opts.width;
  c.height = opts.height;
  drawThumbnail(c.getContext('2d')!, layers, opts.width, opts.height);
  return c;
}

function toJpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('The thumbnail could not be encoded.'));
        void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

/** JPEG at the requested size, lowering quality until it fits under maxBytes. */
export async function thumbnailJpeg(layers: ThumbnailLayer[], opts: Pick<ThumbOpts, 'projectPath' | 'sources'>, out: { width: number; height: number; maxBytes: number }): Promise<{ data: Uint8Array; quality: number; width: number; height: number }> {
  const c = await renderThumbnail(layers, { ...opts, width: out.width, height: out.height });
  let quality = 0.92;
  let data = await toJpeg(c, quality);
  while (data.byteLength > out.maxBytes && quality > 0.42) {
    quality = Math.round((quality - 0.07) * 100) / 100;
    data = await toJpeg(c, quality);
  }
  if (data.byteLength > out.maxBytes) throw new Error(`The thumbnail is ${(data.byteLength / 1e6).toFixed(1)} MB even at low quality; the limit is ${(out.maxBytes / 1e6).toFixed(1)} MB.`);
  return { data, quality, width: out.width, height: out.height };
}

// ───────────────────────────── hit testing ─────────────────────────────

export interface LayerBox {
  /** Unrotated box in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, about (cx, cy). */
  rotation: number;
  cx: number;
  cy: number;
  /** Covers the whole canvas (frame, scrim): selectable from the layer list, not by clicking through. */
  full: boolean;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  return measureCtx;
}

export function layerBox(l: ThumbnailLayer, W: number, H: number): LayerBox {
  switch (l.kind) {
    case 'frame': {
      const img = cache.get(frameKey(l.sourceId, l.time));
      const r = coverRect(l, img?.width || 16, img?.height || 9, W, H);
      return { x: r.x, y: r.y, w: r.w, h: r.h, rotation: 0, cx: r.cx, cy: r.cy, full: true };
    }
    case 'image': {
      const img = cache.get(`image:${l.path}`);
      const w = l.scale * W;
      const h = img ? (w * img.height) / Math.max(1, img.width) : w * 0.5625;
      return { x: l.x * W - w / 2, y: l.y * H - h / 2, w, h, rotation: 0, cx: l.x * W, cy: l.y * H, full: false };
    }
    case 'scrim':
      return { x: 0, y: 0, w: W, h: H, rotation: 0, cx: W / 2, cy: H / 2, full: true };
    case 'shape': {
      const w = l.w * W;
      const h = l.h * H;
      return { x: l.x * W, y: l.y * H, w, h, rotation: l.rotation, cx: l.x * W + w / 2, cy: l.y * H + h / 2, full: false };
    }
    case 'text': {
      const b = layoutText(measurer(), l, W, H);
      return { x: b.x, y: b.y, w: b.w, h: b.h, rotation: l.rotation, cx: l.x * W, cy: l.y * H, full: false };
    }
  }
}

function inBox(b: LayerBox, px: number, py: number, pad = 0): boolean {
  const a = (-b.rotation * Math.PI) / 180;
  const dx = px - b.cx;
  const dy = py - b.cy;
  const rx = b.cx + dx * Math.cos(a) - dy * Math.sin(a);
  const ry = b.cy + dx * Math.sin(a) + dy * Math.cos(a);
  return rx >= b.x - pad && rx <= b.x + b.w + pad && ry >= b.y - pad && ry <= b.y + b.h + pad;
}

/**
 * Topmost layer under a point. Text, shapes and images win over the
 * full-canvas frame; a scrim is never picked by clicking (use the layer list).
 */
export function hitTest(layers: ThumbnailLayer[], px: number, py: number, W: number, H: number): string | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (l.kind === 'frame' || l.kind === 'scrim') continue;
    if (inBox(layerBox(l, W, H), px, py, H * 0.012)) return l.id;
  }
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (l.kind === 'frame' && inBox(layerBox(l, W, H), px, py)) return l.id;
  }
  return null;
}

export function layerLabel(l: ThumbnailLayer, sources: MediaSource[]): string {
  switch (l.kind) {
    case 'frame':
      return `Frame · ${sources.find((s) => s.id === l.sourceId)?.name ?? 'missing source'}`;
    case 'image':
      return `Image · ${l.path.split('/').pop()}`;
    case 'scrim':
      return 'Shade';
    case 'shape':
      return l.shape === 'pill' ? 'Pill' : l.shape === 'circle' ? 'Circle' : 'Block';
    case 'text':
      return l.text.trim() ? `“${l.text.trim().slice(0, 28)}”` : 'Empty text';
  }
}
