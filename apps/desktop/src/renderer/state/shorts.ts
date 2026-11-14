/**
 * Shorts: the actions behind the Shorts screen. A short lives in
 * `project.shorts`; adding, changing or exporting one never touches the edit
 * of the long video, so none of this is an undo step of the edit.
 */
import { create } from 'zustand';
import { SHORT_LIMITS, addShorts, hookLine, newShort, removeShort, shortProject, shortsOf, snapShortRange, titleFromLine, updateShort, type Project, type Range, type Short, type ShortCandidate } from '@cutaway/core';
import { startFileExport, useExportJob, type PackageExportResult } from '../engine/packageExport';
import { findShorts, type FoundShorts } from '../jobs/shorts';
import { JobError } from '../jobs/types';
import { jobContext } from './jobs';
import { useApp } from './store';

export interface ShortsUi {
  /** Candidates from the last "Find shorts", not yet kept. */
  found: (ShortCandidate & { key: string; origin: 'ai' | 'rules'; provider?: 'claude' | 'codex' })[];
  note: string | null;
  status: 'idle' | 'finding' | 'failed';
  error: string | null;
  abort: AbortController | null;
  /** The short whose file is being written, and how the last export of each one ended. */
  exporting: string | null;
  results: Record<string, { status: PackageExportResult['status']; message: string; path: string | null }>;
  set(patch: Partial<ShortsUi>): void;
}

export const useShorts = create<ShortsUi>((set) => ({
  found: [],
  note: null,
  status: 'idle',
  error: null,
  abort: null,
  exporting: null,
  results: {},
  set: (patch) => set(patch),
}));

const project = (): Project => useApp.getState().project!;

/** Look for candidates. `useAi` false = built-in rules only; nothing leaves this Mac. */
export async function runFindShorts(useAi: boolean, count = 4): Promise<FoundShorts | null> {
  const ui = useShorts.getState();
  if (ui.status === 'finding') return null;
  const abort = new AbortController();
  ui.set({ status: 'finding', error: null, note: null, abort });
  try {
    const r = await findShorts(jobContext(abort.signal, useAi), count);
    const origin = r.ai.mode === 'claude' ? ('ai' as const) : ('rules' as const);
    useShorts.getState().set({
      status: 'idle',
      abort: null,
      note: r.note,
      found: r.candidates.map((c, i) => ({ ...c, key: `${Date.now().toString(36)}-${i}`, origin, ...(origin === 'ai' && r.ai.provider ? { provider: r.ai.provider } : {}) })),
    });
    return r;
  } catch (e) {
    const cancelled = (e instanceof JobError && e.code === 'cancelled') || abort.signal.aborted;
    useShorts.getState().set({ status: cancelled ? 'idle' : 'failed', abort: null, error: cancelled ? null : e instanceof Error ? e.message : String(e), note: cancelled ? 'Cancelled. Nothing was changed.' : null });
    return null;
  }
}

export function cancelFindShorts() {
  useShorts.getState().abort?.abort();
}

/** Keep a candidate: it becomes a saved short. Returns its id. */
export function keepCandidate(key: string): string | null {
  const ui = useShorts.getState();
  const cand = ui.found.find((c) => c.key === key);
  if (!cand) return null;
  const short = newShort(project(), cand, cand.origin, cand.provider);
  useApp.getState().patch((p) => addShorts(p, [short]));
  ui.set({ found: ui.found.filter((c) => c.key !== key) });
  return short.id;
}

export function dismissCandidate(key: string) {
  const ui = useShorts.getState();
  ui.set({ found: ui.found.filter((c) => c.key !== key) });
}

/** A short made by hand from a session range. It is fitted to whole sentences; by hand it may be as short as three seconds. */
export function makeShortFromRange(range: Range, title?: string): { id: string; notes: string[] } | { error: string } {
  const p = project();
  const snapped = snapShortRange(p, range, { min: SHORT_LIMITS.handMin, max: SHORT_LIMITS.max });
  if (!snapped.ok) return { error: snapped.reason };
  const hook = hookLine(p, snapped.range);
  const short = newShort(p, { ...snapped.range, title: title?.trim() || titleFromLine(hook || 'Short'), hook }, 'creator');
  useApp.getState().patch((q) => addShorts(q, [short]));
  return { id: short.id, notes: snapped.notes };
}

export const patchShort = (id: string, patch: Partial<Omit<Short, 'id'>>) => useApp.getState().patch((p) => updateShort(p, id, patch));
export const deleteShort = (id: string) => useApp.getState().patch((p) => removeShort(p, id));

/**
 * Export one short as its own MP4 into the export folder. Uses the ordinary
 * single-file export (working folder, validation, cancel, failure states) on
 * the project derived for the short. Resolves when it has finished.
 */
export function exportShort(id: string, destDir: string): Promise<PackageExportResult | null> {
  const app = useApp.getState();
  const p = app.project;
  const short = p ? shortsOf(p).find((s) => s.id === id) : null;
  if (!p || !short || !app.projectPath) return Promise.resolve(null);
  if (useExportJob.getState().job?.status === 'running') {
    app.toast('Another export is still running. Wait for it to finish, or cancel it on the Export screen.', 'error');
    return Promise.resolve(null);
  }
  const derived = shortProject(p, short);
  useShorts.getState().set({ exporting: id });
  return new Promise((resolve) => {
    startFileExport({ project: derived, projectPath: app.projectPath!, destDir, format: 'mp4', target: 'file', gif: { fps: 15, short: 480 } }, (result) => {
      const path = result.status === 'complete' && result.folder ? `${result.folder}/${result.folderName}` : null;
      const message = result.status === 'complete' ? `Saved ${result.folderName}` : result.status === 'cancelled' ? 'Cancelled. No file was left behind.' : (result.error?.message ?? 'The export failed.');
      const ui = useShorts.getState();
      ui.set({ exporting: null, results: { ...ui.results, [id]: { status: result.status, message, path } } });
      const bytes = result.files[0]?.bytes ?? 0;
      if (path) useApp.getState().patch((q) => (q.id === p.id ? updateShort(q, id, { exported: { path, at: new Date().toISOString(), bytes, revision: q.revision } }) : q));
      // The job belongs to this screen, not to the Export screen's own panel.
      const job = useExportJob.getState().job;
      if (job?.status === 'done') useExportJob.getState().set(null);
      resolve(result);
    });
  });
}

export function cancelShortExport() {
  const job = useExportJob.getState().job;
  if (job?.status === 'running' && useShorts.getState().exporting) job.abort.abort();
}
