/**
 * LUT files of the open project: read from the project folder, parsed once,
 * and handed to the compositor. The UI gets an honest status per file
 * (loading, ready, or why it could not be used).
 */
import { useSyncExternalStore } from 'react';
import { gradeOf, parseCube, type Appearance, type Lut, type LutRef } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';

export interface LutEntry {
  status: 'loading' | 'ready' | 'failed';
  lut: Lut | null;
  error: string | null;
}

const entries = new Map<string, LutEntry>();
const pending = new Map<string, Promise<Lut | null>>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (projectPath: string, ref: LutRef) => resolveSourcePath(projectPath, ref.file);

function set(key: string, e: LutEntry) {
  entries.set(key, e);
  version++;
  listeners.forEach((l) => l());
}

/** Load and parse a project's LUT file (cached). Resolves null when it cannot be used. */
export function ensureLut(projectPath: string, ref: LutRef | null | undefined): Promise<Lut | null> {
  if (!ref) return Promise.resolve(null);
  const key = keyOf(projectPath, ref);
  const have = entries.get(key);
  if (have && have.status !== 'loading') return Promise.resolve(have.lut);
  let p = pending.get(key);
  if (!p) {
    set(key, { status: 'loading', lut: null, error: null });
    p = (async () => {
      try {
        const r = await fetch(window.cutaway.media.url(key));
        if (!r.ok) throw new Error(r.status === 404 ? 'The LUT file is no longer in the project folder. Choose it again.' : `The LUT file could not be read (${r.status}).`);
        const lut = parseCube(await r.text());
        set(key, { status: 'ready', lut, error: null });
        return lut;
      } catch (e) {
        set(key, { status: 'failed', lut: null, error: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, p);
  }
  return p;
}

export function peekLut(projectPath: string, ref: LutRef | null | undefined): Lut | null {
  if (!ref) return null;
  return entries.get(keyOf(projectPath, ref))?.lut ?? null;
}

/** Forget a file (after it was replaced on disk, or to retry a failed read). */
export function forgetLut(projectPath: string, ref: LutRef): void {
  if (entries.delete(keyOf(projectPath, ref))) {
    version++;
    listeners.forEach((l) => l());
  }
}

/** Everything the compositor needs before an export starts. */
export async function ensureGrade(projectPath: string, ap: Appearance): Promise<void> {
  const g = gradeOf(ap);
  await Promise.all([ensureLut(projectPath, g.screen.lut), ensureLut(projectPath, g.camera.lut)]);
}

/** The parsed LUTs for this frame; a file still loading is requested and reads as "none yet". */
export function gradeLuts(projectPath: string, ap: Appearance): { screen: Lut | null; camera: Lut | null } | undefined {
  if (!ap.grade) return undefined;
  const g = gradeOf(ap);
  if (!g.screen.lut && !g.camera.lut) return undefined;
  if (g.screen.lut && !entries.has(keyOf(projectPath, g.screen.lut))) void ensureLut(projectPath, g.screen.lut);
  if (g.camera.lut && !entries.has(keyOf(projectPath, g.camera.lut))) void ensureLut(projectPath, g.camera.lut);
  return { screen: peekLut(projectPath, g.screen.lut), camera: peekLut(projectPath, g.camera.lut) };
}

/** React view of one LUT file's status. */
export function useLut(projectPath: string, ref: LutRef | null | undefined): LutEntry | null {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  return ref ? (entries.get(keyOf(projectPath, ref)) ?? null) : null;
}
