import type { CursorSample, MediaSource, Project } from '@cutaway/core';
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

/** Gain that brings loud speech to about −18 dBFS. 1 when the level was never measured. */
export function voiceGain(project: Pick<Project, 'analysis'>): number {
  const db = project.analysis?.voiceLevelDb;
  if (db === undefined || db === null) return 1;
  return Math.max(0.5, Math.min(4, Math.pow(10, (-18 - db) / 20)));
}

export function sourceUrl(projectPath: string, s: MediaSource): string {
  return window.cutaway.media.url(resolveSourcePath(projectPath, s.path));
}
