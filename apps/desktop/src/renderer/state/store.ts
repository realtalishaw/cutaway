import { create } from 'zustand';
import { TimeMap, checkpoint, commitEdit, type EditState, type Packaging, type Project, type Range } from '@cutaway/core';
import type { AppSettings, ClaudeStatus } from '@shared/api';
import type { StageState } from '../jobs/types';

export type Route = 'library' | 'record' | 'project' | 'settings';
export type ProjectView = Project['ui']['view'];

export type Selection =
  | { kind: 'cut' | 'speed' | 'layout' | 'zoom' | 'overlay' | 'broll' | 'mask' | 'lock' | 'suggestion'; id: string }
  | { kind: 'range'; range: Range }
  | { kind: 'words'; ids: string[]; range: Range }
  | null;

export type InspectorTab = 'background' | 'cursor' | 'camera' | 'captions' | 'transcript' | 'audio' | 'shortcuts' | 'motion' | 'device' | 'review' | 'history';
export type DrawerTab = 'transcript' | 'review' | 'history';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface Snapshot {
  edit: EditState;
  packaging: Packaging;
  label: string;
}

export interface JobState {
  kind: 'first-cut' | 'packaging' | 'revision' | 'export';
  status: 'running' | 'failed' | 'cancelled' | 'done';
  stages: StageState[];
  error: { stage?: string; code: string; message: string; retryable: boolean } | null;
  startedAt: number;
  abort: AbortController;
}

interface AppState {
  route: Route;
  settings: AppSettings | null;
  info: { packaged?: boolean; version: string; libraryDir: string; exportDir: string; nativeHelper: boolean; os: string } | null;
  claude: ClaudeStatus | null;

  projectPath: string | null;
  project: Project | null;
  past: Snapshot[];
  future: Snapshot[];
  coalesce: { key: string; at: number } | null;
  save: { state: 'saved' | 'dirty' | 'saving' | 'error'; at: string | null; error: string | null };
  selection: Selection;
  job: JobState | null;
  toasts: Toast[];
  /** Local-revision proposal awaiting accept/discard: before/after preview. */
  comparison: { before: Project; after: Project; label: string; range: Range; notes: string[]; showing: 'before' | 'after' } | null;
  /** Editor chrome: right inspector visibility, active inspector tab, left drawer (transcript / review / history). */
  panels: { inspector: boolean; tab: InspectorTab; drawer: DrawerTab | null };
  setPanels(patch: Partial<AppState['panels']>): void;

  go(route: Route): void;
  setSettings(s: AppSettings): void;
  openProject(path: string, project: Project): void;
  closeProject(): void;
  /** Undoable change to the edit. `coalesceKey` merges rapid tweaks (slider drags) into one undo step. */
  edit(fn: (edit: EditState, project: Project) => EditState, label: string, coalesceKey?: string): void;
  /** Undoable change to packaging. */
  pack(fn: (p: Packaging, project: Project) => Packaging, label: string, coalesceKey?: string): void;
  /** Non-undoable change (sources, sync, brief, analysis, ui). */
  patch(fn: (p: Project) => Project): void;
  /** Replace the whole project from a job (already checkpointed), keeping one undo step. */
  replace(next: Project, label: string): void;
  undo(): void;
  redo(): void;
  setView(view: ProjectView): void;
  select(sel: Selection): void;
  setJob(job: JobState | null): void;
  toast(text: string, tone?: Toast['tone'], action?: Toast['action']): void;
  dismissToast(id: number): void;
  setComparison(c: AppState['comparison']): void;
}

let toastId = 1;
const MAX_UNDO = 120;

export const useApp = create<AppState>((set, get) => ({
  route: 'library',
  settings: null,
  info: null,
  claude: null,
  projectPath: null,
  project: null,
  past: [],
  future: [],
  coalesce: null,
  save: { state: 'saved', at: null, error: null },
  selection: null,
  job: null,
  toasts: [],
  comparison: null,
  panels: { inspector: true, tab: 'background', drawer: null },
  // The transcript, review and history panels live in the inspector card; `drawer` is kept as an alias for older callers.
  setPanels: (patch) => {
    const next = { ...get().panels, ...patch };
    if (patch.drawer) {
      next.tab = patch.drawer;
      next.inspector = true;
    }
    next.drawer = null;
    set({ panels: next });
  },

  go: (route) => set({ route }),
  setSettings: (settings) => set({ settings }),

  openProject: (projectPath, project) => {
    set({ projectPath, project, past: [], future: [], selection: null, job: null, comparison: null, route: 'project', save: { state: 'saved', at: project.updatedAt, error: null } });
    usePlayback.getState().reset(project.ui.playhead);
  },

  closeProject: () => {
    usePlayback.getState().setPlaying(false);
    set({ projectPath: null, project: null, past: [], future: [], selection: null, job: null, comparison: null, route: 'library' });
  },

  edit: (fn, label, coalesceKey) => {
    const { project, past, coalesce } = get();
    if (!project) return;
    const nextEdit = fn(project.edit, project);
    if (nextEdit === project.edit) return;
    const now = Date.now();
    const merge = !!coalesceKey && coalesce?.key === coalesceKey && now - coalesce.at < 900;
    const nextPast = merge ? past : [...past, { edit: project.edit, packaging: project.packaging, label }].slice(-MAX_UNDO);
    set({ project: commitEdit(project, nextEdit), past: nextPast, future: [], coalesce: coalesceKey ? { key: coalesceKey, at: now } : null, save: { ...get().save, state: 'dirty' } });
  },

  pack: (fn, label, coalesceKey) => {
    const { project, past, coalesce } = get();
    if (!project) return;
    const next = fn(project.packaging, project);
    if (next === project.packaging) return;
    const now = Date.now();
    const merge = !!coalesceKey && coalesce?.key === coalesceKey && now - coalesce.at < 900;
    const nextPast = merge ? past : [...past, { edit: project.edit, packaging: project.packaging, label }].slice(-MAX_UNDO);
    set({ project: { ...project, packaging: next, updatedAt: new Date().toISOString() }, past: nextPast, future: [], coalesce: coalesceKey ? { key: coalesceKey, at: now } : null, save: { ...get().save, state: 'dirty' } });
  },

  patch: (fn) => {
    const { project } = get();
    if (!project) return;
    const next = fn(project);
    if (next === project) return;
    set({ project: next, save: { ...get().save, state: 'dirty' } });
  },

  replace: (next, label) => {
    const { project, past } = get();
    if (!project) return;
    set({ project: next, past: [...past, { edit: project.edit, packaging: project.packaging, label }].slice(-MAX_UNDO), future: [], coalesce: null, save: { ...get().save, state: 'dirty' } });
  },

  undo: () => {
    const { project, past, future } = get();
    const snap = past[past.length - 1];
    if (!project || !snap) return;
    const redoSnap: Snapshot = { edit: project.edit, packaging: project.packaging, label: snap.label };
    const restored = { ...commitEdit(project, snap.edit), packaging: snap.packaging };
    set({ project: restored, past: past.slice(0, -1), future: [...future, redoSnap], coalesce: null, save: { ...get().save, state: 'dirty' } });
    get().toast(`Undid: ${snap.label}`);
  },

  redo: () => {
    const { project, past, future } = get();
    const snap = future[future.length - 1];
    if (!project || !snap) return;
    const undoSnap: Snapshot = { edit: project.edit, packaging: project.packaging, label: snap.label };
    const restored = { ...commitEdit(project, snap.edit), packaging: snap.packaging };
    set({ project: restored, past: [...past, undoSnap], future: future.slice(0, -1), coalesce: null, save: { ...get().save, state: 'dirty' } });
    get().toast(`Redid: ${snap.label}`);
  },

  setView: (view) => {
    const { project } = get();
    if (!project || project.ui.view === view) return;
    // Navigation keeps the playhead and never touches the edit.
    set({ project: { ...project, ui: { ...project.ui, view, playhead: usePlayback.getState().time } }, save: { ...get().save, state: 'dirty' } });
  },

  select: (selection) => set({ selection }),
  setJob: (job) => set({ job }),

  toast: (text, tone = 'info', action) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, tone, action }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 9000 : 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setComparison: (comparison) => set({ comparison }),
}));

/** Save a named checkpoint (restorable from History). */
export function checkpointNow(label: string) {
  useApp.getState().patch((p) => checkpoint(p, label, 'creator'));
}

// ───────────────────────────── playback ─────────────────────────────

interface PlaybackState {
  /** Output time (seconds in the finished video). */
  time: number;
  playing: boolean;
  /** Bumped on user seeks so the player hard-syncs media elements. */
  seekToken: number;
  volume: number;
  setTime(t: number): void;
  seek(t: number): void;
  setPlaying(p: boolean): void;
  toggle(): void;
  reset(t: number): void;
  setVolume(v: number): void;
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  time: 0,
  playing: false,
  seekToken: 0,
  volume: 1,
  setTime: (time) => set({ time }),
  seek: (time) => set({ time: Math.max(0, time), seekToken: get().seekToken + 1 }),
  setPlaying: (playing) => set({ playing }),
  toggle: () => set({ playing: !get().playing }),
  reset: (time) => set({ time, playing: false, seekToken: get().seekToken + 1 }),
  setVolume: (volume) => set({ volume }),
}));

// ───────────────────────────── derived ─────────────────────────────

let mapCache: { duration: number; cuts: unknown; speeds: unknown; map: TimeMap } | null = null;

/** Time map of a project, memoised on the identity of its cuts and speeds. */
export function timeMapOf(project: Project): TimeMap {
  if (mapCache && mapCache.duration === project.duration && mapCache.cuts === project.edit.cuts && mapCache.speeds === project.edit.speeds) return mapCache.map;
  const map = TimeMap.fromEdit(project.duration, project.edit);
  mapCache = { duration: project.duration, cuts: project.edit.cuts, speeds: project.edit.speeds, map };
  return map;
}

export function useProject(): Project {
  const p = useApp((s) => s.project);
  if (!p) throw new Error('No project is open');
  return p;
}

/** The project the preview should show: a comparison side when one is open, else the live project. */
export function useShownProject(): Project {
  const p = useApp((s) => s.project);
  const c = useApp((s) => s.comparison);
  if (c) return c.showing === 'before' ? c.before : c.after;
  if (!p) throw new Error('No project is open');
  return p;
}

// ───────────────────────────── autosave ─────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let queued = false;

async function flush() {
  const { project, projectPath } = useApp.getState();
  if (!project || !projectPath) return;
  if (saving) {
    queued = true;
    return;
  }
  saving = true;
  useApp.setState({ save: { ...useApp.getState().save, state: 'saving' } });
  try {
    const toSave = { ...project, ui: { ...project.ui, playhead: usePlayback.getState().time } };
    const r = await window.cutaway.library.save(projectPath, toSave);
    // Only report "saved" if nothing changed while the write was in flight.
    const unchanged = useApp.getState().project === project;
    useApp.setState({ save: { state: unchanged ? 'saved' : 'dirty', at: r.savedAt, error: null } });
    if (!unchanged) schedule();
  } catch (e) {
    useApp.setState({ save: { state: 'error', at: useApp.getState().save.at, error: (e as Error).message } });
  } finally {
    saving = false;
    if (queued) {
      queued = false;
      void flush();
    }
  }
}

function schedule() {
  if (saveTimer) clearTimeout(saveTimer);
  // Well inside the two-second autosave target.
  saveTimer = setTimeout(() => void flush(), 900);
}

export function saveNow(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  return flush();
}

export function startAutosave() {
  useApp.subscribe((s, prev) => {
    if (s.project && s.projectPath && s.project !== prev.project && prev.project && s.projectPath === prev.projectPath) schedule();
  });
  window.addEventListener('beforeunload', () => void flush());
}
