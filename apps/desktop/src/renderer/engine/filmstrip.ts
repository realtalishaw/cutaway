/**
 * Small stills for the video row of the simple timeline. Each still is a frame of whatever picture plays at
 * a recording second (the screen, else camera A), shrunk to the row's height and kept for the session.
 */
import { sourceAt, toSourceTime, type MediaSource, type Project } from '@cutaway/core';
import { loadFrame } from './thumb';

const cache = new Map<string, HTMLCanvasElement | null>();
const pending = new Map<string, Promise<HTMLCanvasElement | null>>();
const MAX = 400;

/** The picture source and the second inside it at a recording second. */
export function pictureAt(project: Pick<Project, 'sources'>, t: number): { source: MediaSource; time: number } | null {
  const s = sourceAt(project, 'screen', t) ?? sourceAt(project, 'cameraA', t);
  if (!s || !s.available || (s.kind !== 'video' && s.kind !== 'image')) return null;
  return { source: s, time: Math.max(0, Math.min(s.duration - 0.05, toSourceTime(s.sync, t))) };
}

export function stillKey(sourceId: string, time: number, height: number): string {
  return `${sourceId}@${time.toFixed(1)}#${height}`;
}

export function cachedStill(key: string): HTMLCanvasElement | null | undefined {
  return cache.get(key);
}

/** A still `height` pixels tall (device pixels). Null when the frame cannot be read. */
export function loadStill(projectPath: string, sources: MediaSource[], source: MediaSource, time: number, height: number): Promise<HTMLCanvasElement | null> {
  const key = stillKey(source.id, time, height);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  const running = pending.get(key);
  if (running) return running;
  const p = loadFrame({ projectPath, sources }, source.id, time)
    .then((d) => {
      const w0 = d?.width ?? 0;
      const h0 = d?.height ?? 0;
      if (!d || !w0 || !h0) return null;
      const c = document.createElement('canvas');
      c.height = height;
      c.width = Math.max(1, Math.round((w0 / h0) * height));
      c.getContext("2d")!.drawImage(d as CanvasImageSource, 0, 0, c.width, c.height);
      return c;
    })
    .catch(() => null)
    .then((c) => {
      if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, c);
      pending.delete(key);
      return c;
    });
  pending.set(key, p);
  return p;
}
