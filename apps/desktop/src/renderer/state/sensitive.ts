/**
 * "Find sensitive data": scan the screen recording on this Mac and offer what
 * was found as masks. Findings are suggestions only: nothing is hidden until
 * the creator accepts it, and each accept is one undoable step.
 *
 * Only a category, a time range and a rectangle are kept here. The recognised
 * text never reaches the renderer.
 */
import { create } from 'zustand';
import { groupSensitive, meta, sourceByRole, toSessionTime, uid, type Mask, type Project, type SensitiveFinding, type SensitiveHit } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';
import { timeMapOf, useApp } from './store';

export interface Finding extends SensitiveFinding {
  id: string;
  status: 'open' | 'hidden' | 'dismissed';
  /** The mask created when it was accepted. */
  maskId?: string;
}

export interface SensitiveState {
  /** Project and screen source the results belong to. */
  key: string | null;
  status: 'idle' | 'scanning' | 'done' | 'failed' | 'cancelled';
  progress: number;
  scannedSeconds: number;
  totalSeconds: number;
  findings: Finding[];
  error: string | null;
  cancel: (() => void) | null;
}

const CHUNK = 20;
const INTERVAL = 1;

export const useSensitive = create<SensitiveState>(() => ({ key: null, status: 'idle', progress: 0, scannedSeconds: 0, totalSeconds: 0, findings: [], error: null, cancel: null }));

const keyOf = (p: Project, screenId: string) => `${p.id}:${screenId}`;

/** Is a finding already covered by a mask the project has? */
function covered(f: SensitiveFinding, masks: Mask[]): Mask | null {
  return (
    masks.find((m) => {
      if (m.target !== 'screen' || m.end <= f.start + 0.05 || m.start >= f.end - 0.05) return false;
      const w = Math.min(m.rect.x + m.rect.w, f.rect.x + f.rect.w) - Math.max(m.rect.x, f.rect.x);
      const h = Math.min(m.rect.y + m.rect.h, f.rect.y + f.rect.h) - Math.max(m.rect.y, f.rect.y);
      return w > 0 && h > 0 && (w * h) / Math.max(1e-9, f.rect.w * f.rect.h) > 0.8;
    }) ?? null
  );
}

/** Turn per-frame hits (source time) into findings on the session clock that are visible in the edit. */
export function findingsFrom(project: Project, frames: { t: number; hits: SensitiveHit[] }[], sourceDuration: number): SensitiveFinding[] {
  const screen = sourceByRole(project, 'screen');
  if (!screen) return [];
  const map = timeMapOf(project);
  return groupSensitive(frames, { interval: INTERVAL, duration: sourceDuration })
    .map((f) => ({ ...f, start: Math.max(0, toSessionTime(screen.sync, f.start)), end: Math.min(project.duration, toSessionTime(screen.sync, f.end)) }))
    // Footage that is cut from the video cannot leak anything.
    .filter((f) => f.end - f.start > 0.05 && map.toOutput(f.end) - map.toOutput(f.start) > 0.05);
}

export async function scanSensitive(): Promise<void> {
  const app = useApp.getState();
  const { project, projectPath } = app;
  const screen = project ? sourceByRole(project, 'screen') : undefined;
  if (!project || !projectPath || !screen) return;
  if (useSensitive.getState().status === 'scanning') return;
  let cancelled = false;
  const file = resolveSourcePath(projectPath, screen.path);
  const total = Math.max(0.1, screen.duration);
  useSensitive.setState({ key: keyOf(project, screen.id), status: 'scanning', progress: 0, scannedSeconds: 0, totalSeconds: total, findings: [], error: null, cancel: () => (cancelled = true) });
  const frames: { t: number; hits: SensitiveHit[] }[] = [];
  try {
    for (let start = 0; start < total; start += CHUNK) {
      if (cancelled) break;
      const end = Math.min(total, start + CHUNK);
      const r = await window.cutaway.native.sensitive(file, start, end, INTERVAL);
      frames.push(...r.frames);
      useSensitive.setState({ progress: end / total, scannedSeconds: end });
    }
    const now = useApp.getState().project;
    if (!now || now.id !== project.id) return useSensitive.setState({ status: 'idle', cancel: null });
    const findings: Finding[] = findingsFrom(now, frames, total).map((f) => {
      const mask = covered(f, now.edit.masks);
      return { ...f, id: uid('sens'), status: mask ? ('hidden' as const) : ('open' as const), maskId: mask?.id };
    });
    useSensitive.setState({ status: cancelled ? 'cancelled' : 'done', findings, cancel: null, progress: cancelled ? useSensitive.getState().progress : 1 });
  } catch (e) {
    useSensitive.setState({ status: 'failed', error: e instanceof Error ? e.message : String(e), cancel: null });
  }
}

/** Accept findings: one blur mask each, added as a single undoable step. */
export function hideFindings(ids: string[]): number {
  const project = useApp.getState().project;
  if (!project) return 0;
  // Start from what is true now: a mask that was undone leaves its finding open again.
  const current = findingsFor(project);
  const picked = current.filter((f) => ids.includes(f.id) && f.status === 'open');
  if (!picked.length) return 0;
  const made = new Map<string, string>();
  useApp.getState().edit((e, p) => {
    const masks = [...e.masks];
    for (const f of picked) {
      const id = uid('mask');
      made.set(f.id, id);
      masks.push({ id, start: f.start, end: f.end, target: 'screen', rect: f.rect, style: 'blur', meta: { ...meta('creator', p.revision + 1), reason: 'Sensitive data found on screen' } });
    }
    return { ...e, masks };
  }, picked.length === 1 ? 'Hide sensitive data' : `Hide ${picked.length} sensitive areas`);
  useSensitive.setState({ findings: current.map((f) => (made.has(f.id) ? { ...f, status: 'hidden' as const, maskId: made.get(f.id) } : f)) });
  return picked.length;
}

export function dismissFinding(id: string): void {
  const project = useApp.getState().project;
  const current = project ? findingsFor(project) : useSensitive.getState().findings;
  useSensitive.setState({ findings: current.map((f) => (f.id === id && f.status === 'open' ? { ...f, status: 'dismissed' as const } : f)) });
}

/** Results only make sense for the project and recording they were found in; an undone mask reopens its finding. */
export function findingsFor(project: Project): Finding[] {
  const st = useSensitive.getState();
  const screen = sourceByRole(project, 'screen');
  if (!screen || st.key !== keyOf(project, screen.id)) return [];
  return st.findings.map((f) => (f.status === 'hidden' && f.maskId && !project.edit.masks.some((m) => m.id === f.maskId) ? { ...f, status: 'open' as const, maskId: undefined } : f));
}
