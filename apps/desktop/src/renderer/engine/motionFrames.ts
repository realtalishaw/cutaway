/**
 * Frames of animations, for the preview and the export. The main process renders an animation once into
 * transparent PNGs (keyed by page, fields, size, rate and length); here they are asked for, loaded and
 * kept for drawing. A frame that is not loaded yet is simply not drawn this time round: the preview
 * catches up a moment later, and the export waits for every frame it needs.
 */
import { motionPixels, motionValues, type MotionSpec, type Overlay } from '@cutaway/core';
import type { MotionRenderResult } from '@shared/api';

/** The output being made: frames are rendered at the animation's own size within it (its box, or the frame). */
export interface MotionTarget {
  width: number;
  height: number;
  fps: number;
}

const sizeOf = (spec: MotionSpec, t: MotionTarget) => motionPixels(spec, t.width, t.height);

type Entry = { state: 'rendering'; done: number; total: number; promise: Promise<MotionRenderResult | null> } | { state: 'ready'; result: MotionRenderResult } | { state: 'failed'; error: string };

const renders = new Map<string, Entry>();
const frames = new Map<string, ImageBitmap | 'loading' | 'failed'>();
const order: string[] = [];
const MAX_FRAMES = 360;
const listeners = new Set<() => void>();
let progressHooked = false;

/** How long an animation block plays its frames for: the block's length, but never past its own end. */
const lengthOf = (spec: MotionSpec) => spec.duration;
const keyOf = (spec: MotionSpec, t: MotionTarget) => {
  const px = sizeOf(spec, t);
  return JSON.stringify([spec.file, motionValues(spec), px.width, px.height, t.fps, lengthOf(spec)]);
};

export function onMotionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const changed = () => listeners.forEach((l) => l());

/** Start (or reuse) the render of an animation's frames at a size and rate. */
export function ensureMotion(projectPath: string, spec: MotionSpec, target: MotionTarget): Entry {
  if (!progressHooked) {
    progressHooked = true;
    window.cutaway.motion.onProgress((p) => {
      const e = renders.get(p.key);
      if (e?.state === 'rendering') Object.assign(e, { done: p.done, total: p.total });
      changed();
    });
  }
  const k = keyOf(spec, target);
  const hit = renders.get(k);
  if (hit) return hit;
  const promise = window.cutaway.motion
    .render(projectPath, { file: spec.file, fields: motionValues(spec), width: sizeOf(spec, target).width, height: sizeOf(spec, target).height, fps: target.fps, duration: lengthOf(spec), tag: k })
    .then((result) => {
      renders.set(k, { state: 'ready', result });
      changed();
      return result;
    })
    .catch((e: unknown) => {
      renders.set(k, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
      changed();
      return null;
    });
  const entry: Entry = { state: 'rendering', done: 0, total: Math.ceil(lengthOf(spec) * target.fps), promise };
  renders.set(k, entry);
  changed();
  return entry;
}

export function motionStatus(projectPath: string, spec: MotionSpec, target: MotionTarget): Entry {
  return renders.get(keyOf(spec, target)) ?? ensureMotion(projectPath, spec, target);
}

const frameUrl = (r: MotionRenderResult, i: number) => window.cutaway.media.url(`${r.dir}/f${String(i).padStart(5, '0')}.png`);
const frameIndex = (r: MotionRenderResult, local: number) => Math.max(0, Math.min(r.count - 1, Math.floor(local * r.fps + 1e-6)));

async function load(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`frame ${res.status}`);
  return createImageBitmap(await res.blob(), { premultiplyAlpha: 'premultiply' });
}

function remember(url: string, v: ImageBitmap | 'loading' | 'failed') {
  if (!frames.has(url)) order.push(url);
  frames.set(url, v);
  while (order.length > MAX_FRAMES) {
    const old = order.shift()!;
    const f = frames.get(old);
    if (f instanceof ImageBitmap) f.close();
    frames.delete(old);
  }
}

/**
 * The frame to draw `local` seconds into an animation, if it is ready (preview). Asks for the render and for
 * the next frames as needed; `changed` listeners hear when more is ready.
 */
export function motionFrameNow(projectPath: string, o: Overlay, local: number, target: MotionTarget): ImageBitmap | null {
  if (!o.motion) return null;
  const e = motionStatus(projectPath, o.motion, target);
  if (e.state !== 'ready') return null;
  const i = frameIndex(e.result, local);
  for (let k = i; k < Math.min(e.result.count, i + 8); k++) {
    const url = frameUrl(e.result, k);
    if (frames.has(url)) continue;
    remember(url, 'loading');
    void load(url).then(
      (b) => (remember(url, b), changed()),
      () => remember(url, 'failed'),
    );
  }
  const f = frames.get(frameUrl(e.result, i));
  if (f instanceof ImageBitmap) return f;
  // while the exact frame loads, the nearest earlier one keeps the picture steady
  for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
    const g = frames.get(frameUrl(e.result, k));
    if (g instanceof ImageBitmap) return g;
  }
  return null;
}

/** Export: render every animation first, then hand out each frame as it is needed. */
export async function prepareMotionForExport(projectPath: string, overlays: Overlay[], target: MotionTarget): Promise<(o: Overlay, local: number) => Promise<ImageBitmap | null>> {
  const results = new Map<string, MotionRenderResult>();
  for (const o of overlays) {
    if (o.kind !== 'motion' || !o.motion) continue;
    const px = sizeOf(o.motion, target);
    const r = await window.cutaway.motion.render(projectPath, { file: o.motion.file, fields: motionValues(o.motion), width: px.width, height: px.height, fps: target.fps, duration: lengthOf(o.motion) });
    results.set(o.id, r);
  }
  const cache = new Map<string, ImageBitmap>();
  return async (o, local) => {
    const r = results.get(o.id);
    if (!r) return null;
    const url = frameUrl(r, frameIndex(r, local));
    let b = cache.get(url);
    if (!b) {
      b = await load(url);
      cache.set(url, b);
      // an export walks forward in time: keep only the last few
      if (cache.size > 24) {
        const first = cache.keys().next().value!;
        cache.get(first)?.close();
        cache.delete(first);
      }
    }
    return b;
  };
}
