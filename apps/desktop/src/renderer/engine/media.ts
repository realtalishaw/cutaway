import type { CursorSample, KeyStroke, MediaSource, Project } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';

const cursorCache = new Map<string, Promise<CursorSample[]>>();

/**
 * Cursor telemetry of a recorded screen source, on the session clock.
 * Imported (flattened) files have none: their cursor is part of the picture.
 */
export function loadCursor(projectPath: string, screen: MediaSource): Promise<CursorSample[]> {
  if (!screen.cursorFile || screen.cursorBaked) return Promise.resolve([]);
  const file = resolveSourcePath(projectPath, screen.cursorFile);
  let p = cursorCache.get(file);
  if (!p) {
    p = window.cutaway.native.readCursor(file).catch(() => []);
    cursorCache.set(file, p);
  }
  // cursor.jsonl is written on the take's session clock, which starts where the screen source starts
  return p;
}

/**
 * Cursor telemetry placed on the project's session timeline. A take's own clock starts at zero; with
 * several clips the screen source is moved along the timeline (`shift`) and used only inside its clip.
 */
export async function loadCursorOnSession(projectPath: string, screen: MediaSource): Promise<CursorSample[]> {
  const samples = await loadCursor(projectPath, screen);
  return onSession(samples, screen);
}

const shifted = new WeakMap<object, Map<string, unknown[]>>();

/** Telemetry samples (cursor or keys) of a screen source, moved onto the session timeline and kept to its clip. */
export function onSession<T extends { t: number }>(samples: T[], screen: Pick<MediaSource, 'shift' | 'window'> | undefined): T[] {
  const shift = screen?.shift ?? 0;
  const w = screen?.window;
  if (!screen || (!shift && !w) || samples.length === 0) return samples;
  const key = `${shift}|${w?.start ?? ''}|${w?.end ?? ''}`;
  let byKey = shifted.get(samples);
  if (!byKey) shifted.set(samples, (byKey = new Map()));
  let out = byKey.get(key) as T[] | undefined;
  if (!out) {
    out = samples.map((s) => ({ ...s, t: s.t + shift })).filter((s) => !w || (s.t >= w.start - 0.5 && s.t < w.end + 0.5));
    byKey.set(key, out);
  }
  return out;
}

/** Keyboard telemetry of a screen source on the session timeline. */
export const keysOnSession = (keys: KeyStroke[], screen: MediaSource | undefined): KeyStroke[] => onSession(keys, screen);

/** Gain that brings loud speech to about −18 dBFS. 1 when the level was never measured. */
export function voiceGain(project: Pick<Project, 'analysis'>): number {
  const db = project.analysis?.voiceLevelDb;
  if (db === undefined || db === null) return 1;
  return Math.max(0.5, Math.min(4, Math.pow(10, (-18 - db) / 20)));
}

export function sourceUrl(projectPath: string, s: MediaSource): string {
  return window.cutaway.media.url(resolveSourcePath(projectPath, s.path));
}
