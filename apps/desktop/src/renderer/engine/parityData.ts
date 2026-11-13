/**
 * Derived data the parity features need: keyboard telemetry, face tracks and
 * person mattes. Everything is computed on this Mac by the native helper,
 * cached per file, and exposed with an honest status for the UI.
 */
import { useSyncExternalStore } from 'react';
import { buildFaceTrack, type FaceTrackSmooth, type KeyStroke, type MediaSource } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';

export type DataStatus = 'idle' | 'computing' | 'ready' | 'failed';

export interface DataEntry<T> {
  status: DataStatus;
  value: T | null;
  error: string | null;
}

const IDLE: DataEntry<never> = { status: 'idle', value: null, error: null };
const entries = new Map<string, DataEntry<unknown>>();
const pending = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let version = 0;

function set<T>(key: string, e: DataEntry<T>) {
  entries.set(key, e);
  version++;
  listeners.forEach((l) => l());
}

function peek<T>(key: string): DataEntry<T> {
  return (entries.get(key) as DataEntry<T> | undefined) ?? (IDLE as DataEntry<T>);
}

function ensure<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  const have = entries.get(key) as DataEntry<T> | undefined;
  if (have?.status === 'ready') return Promise.resolve(have.value);
  let p = pending.get(key) as Promise<T | null> | undefined;
  if (!p) {
    set<T>(key, { status: 'computing', value: null, error: null });
    p = run()
      .then((value) => {
        set(key, { status: 'ready', value, error: null });
        return value;
      })
      .catch((e: unknown) => {
        set<T>(key, { status: 'failed', value: null, error: e instanceof Error ? e.message : String(e) });
        return null;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** Forget a failed attempt so the next ensure() tries again. */
export function retry(key: string) {
  if (entries.get(key)?.status === 'failed') {
    entries.delete(key);
    version++;
    listeners.forEach((l) => l());
  }
}

const abs = (projectPath: string, p: string) => resolveSourcePath(projectPath, p);

// ── keys ──
export const keysKey = (projectPath: string, s: MediaSource) => `keys|${abs(projectPath, s.keysFile ?? '')}`;
/** Shortcut and typing telemetry on the session clock. Empty when the take has none. */
export function ensureKeys(projectPath: string, screen: MediaSource | undefined): Promise<KeyStroke[]> {
  if (!screen?.keysFile) return Promise.resolve([]);
  return ensure(keysKey(projectPath, screen), async () => (await window.cutaway.native.readKeys(abs(projectPath, screen.keysFile!))) as KeyStroke[]).then((v) => v ?? []);
}
export const peekKeys = (projectPath: string, screen: MediaSource | undefined): KeyStroke[] => (screen?.keysFile ? (peek<KeyStroke[]>(keysKey(projectPath, screen)).value ?? []) : []);

// ── faces ──
export const facesKey = (projectPath: string, s: MediaSource) => `faces|${abs(projectPath, s.path)}`;
export function ensureFaces(projectPath: string, cam: MediaSource): Promise<FaceTrackSmooth | null> {
  return ensure(facesKey(projectPath, cam), async () => {
    const raw = await window.cutaway.native.faces(projectPath, abs(projectPath, cam.path));
    const track = buildFaceTrack(raw.samples, raw.fps);
    if (!track) throw new Error('No face was found in this camera recording.');
    return track;
  });
}
export const peekFaces = (projectPath: string, cam: MediaSource) => peek<FaceTrackSmooth>(facesKey(projectPath, cam));

// ── matte ──
export const matteKey = (projectPath: string, s: MediaSource) => `matte|${abs(projectPath, s.path)}`;
/** Absolute path of the person matte video for a camera (computed once, then cached in the project). */
export function ensureMatte(projectPath: string, cam: MediaSource): Promise<string | null> {
  return ensure(matteKey(projectPath, cam), async () => (await window.cutaway.native.matte(projectPath, abs(projectPath, cam.path))).path);
}
export const peekMatte = (projectPath: string, cam: MediaSource) => peek<string>(matteKey(projectPath, cam));

/** React view of one entry. */
export function useData<T>(key: string | null): DataEntry<T> {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
  return key ? peek<T>(key) : (IDLE as DataEntry<T>);
}
