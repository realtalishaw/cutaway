import { create } from 'zustand';
import { clipsOf, mapTime, sessionMap, TimeMap, checkpoint, commitEdit, findCheckpoint, projectAtCheckpoint, restoreRevision, type EditState, type Packaging, type Project, type Range } from '@cutaway/core';
import type { AppSettings, ClaudeStatus } from '@shared/api';
import type { StageState } from '../jobs/types';

export type Route = 'library' | 'record' | 'project' | 'settings';
export type ProjectView = Project['ui']['view'];

export type Selection =
  | { kind: 'cut' | 'speed' | 'layout' | 'zoom' | 'overlay' | 'broll' | 'mask' | 'lock' | 'suggestion' | 'music' | 'sound' | 'clip'; id: string }
  | { kind: 'range'; range: Range }
  | { kind: 'words'; ids: string[]; range: Range }
  | null;

/** One block on the timeline. */
export type ItemRef = { kind: 'speed' | 'layout' | 'zoom' | 'overlay' | 'broll' | 'mask' | 'music' | 'sound'; id: string };
/** Blocks that can be selected together, copied, pasted and nudged. */
export const MULTI_KINDS = new Set<string>(['speed', 'layout', 'zoom', 'overlay', 'broll', 'mask', 'music', 'sound']);
export const isItemRef = (s: Selection | ItemRef): s is ItemRef => !!s && 'id' in s && MULTI_KINDS.has(s.kind);
const sameRef = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind === b.kind && a.id === b.id;

/** Every selected block: the main selection (the one the inspector shows) first, then the ones added with ⇧ or ⌘. */
export function selectedItems(s: Pick<AppState, 'selection' | 'also'>): ItemRef[] {
  return isItemRef(s.selection) ? [s.selection, ...s.also.filter((r) => !sameRef(r, s.selection as ItemRef))] : [];
}

export type InspectorTab = 'background' | 'cursor' | 'camera' | 'captions' | 'transcript' | 'audio' | 'text' | 'shortcuts' | 'motion' | 'device' | 'chat' | 'review' | 'history';
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
  /** Blocks selected together with `selection` (⇧- or ⌘-click). Only counts while `selection` is a block too. */
  also: ItemRef[];
  job: JobState | null;
  toasts: Toast[];
  /** Local-revision proposal awaiting accept/discard: before/after preview. */
  comparison: { before: Project; after: Project; label: string; range: Range; notes: string[]; showing: 'before' | 'after' } | null;
  /**
   * An earlier checkpoint being looked at. The editor shows that version
   * read-only; `project` is untouched (and is the only thing ever saved).
   */
  viewing: { revision: number; label: string; showing: 'version' | 'latest' } | null;
  /** Look at a checkpoint without changing anything. Returns false when it no longer exists. */
  viewVersion(ref: { revision: number; label?: string }): boolean;
  /** Flip between the viewed version and the latest edit. */
  showViewing(side: 'version' | 'latest'): void;
  /** Back to the latest edit. */
  exitViewing(): void;
  /** Make the viewed version the current edit: one undoable step, with what was there checkpointed first. */
  restoreViewed(): void;
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
  /** Select several blocks at once; the first is the one the inspector shows. */
  selectMany(items: ItemRef[]): void;
  /** ⇧- or ⌘-click: add a block to the selection, or take it out. */
  toggleSelect(ref: ItemRef): void;
  setJob(job: JobState | null): void;
  toast(text: string, tone?: Toast['tone'], action?: Toast['action']): void;
  dismissToast(id: number): void;
  setComparison(c: AppState['comparison']): void;
}

let toastId = 1;
const MAX_UNDO = 120;

const VIEWING_NOTE = 'You are looking at an earlier version. Go back to the latest, or restore this one, to make changes.';
let viewingNoteAt = 0;

/** The project a session-time position belongs to right now (viewed version or latest). */
function shownOf(s: Pick<AppState, 'project' | 'viewing' | 'comparison'>): Project | null {
  if (s.comparison) return s.comparison.showing === 'before' ? s.comparison.before : s.comparison.after;
  return viewedProject(s) ?? s.project;
}

/** Keep the playhead on the same moment of the recording when the shown edit changes. */
function keepMoment(from: Project | null, to: Project | null) {
  if (!from || !to || from.edit === to.edit) return;
  const play = usePlayback.getState();
  play.setPlaying(false);
  const src = TimeMap.fromEdit(from.duration, from.edit).toSource(play.time);
  // the two edits may play the clips in a different order: follow the footage, not the number
  const there = from.edit.clips !== to.edit.clips ? (mapTime(sessionMap(clipsOf(from), clipsOf(to)), src) ?? src) : src;
  play.seek(TimeMap.fromEdit(to.duration, to.edit).toOutput(Math.min(there, to.duration)));
}

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
  also: [],
  job: null,
  toasts: [],
  comparison: null,
  viewing: null,
  viewVersion: (ref) => {
    const { project, viewing } = get();
    if (!project) return false;
    const rec = findCheckpoint(project, ref);
    if (!rec) {
      get().toast('That version is no longer in the history.');
      return false;
    }
    if (get().comparison) {
      get().toast('Accept or discard the proposed change first.');
      return false;
    }
    if (viewing?.revision === rec.revision && viewing.showing === 'version') return true;
    const before = shownOf(get());
    usePlayback.getState().setPlaying(false);
    set({ viewing: { revision: rec.revision, label: rec.label, showing: 'version' }, selection: null });
    keepMoment(before, shownOf(get()));
    return true;
  },
  showViewing: (side) => {
    const { viewing } = get();
    if (!viewing || viewing.showing === side) return;
    const before = shownOf(get());
    set({ viewing: { ...viewing, showing: side }, selection: null });
    keepMoment(before, shownOf(get()));
  },
  exitViewing: () => {
    if (!get().viewing) return;
    const before = shownOf(get());
    set({ viewing: null, selection: null });
    keepMoment(before, shownOf(get()));
  },
  restoreViewed: () => {
    const { project, viewing } = get();
    if (!project || !viewing) return;
    const before = shownOf(get());
    const label = viewing.label;
    set({ viewing: null, selection: null });
    const next = restoreRevision(project, viewing.revision);
    if (next !== project) {
      get().replace(next, `Restore “${label}”`);
      get().toast(`Restored “${label}”. Undo brings back what you had.`);
    }
    keepMoment(before, get().project);
  },
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

  go: (route) => {
    if (route !== get().route) get().exitViewing();
    set({ route });
  },
  setSettings: (settings) => set({ settings }),

  openProject: (projectPath, project) => {
    set({ projectPath, project, past: [], future: [], selection: null, job: null, comparison: null, viewing: null, route: 'project', save: { state: 'saved', at: project.updatedAt, error: null } });
    usePlayback.getState().reset(project.ui.playhead);
  },

  closeProject: () => {
    usePlayback.getState().setPlaying(false);
    set({ projectPath: null, project: null, past: [], future: [], selection: null, job: null, comparison: null, viewing: null, route: 'library' });
  },

  edit: (fn, label, coalesceKey) => {
    const { project, past, coalesce } = get();
    if (!project || blockedByViewing()) return;
    const nextEdit = fn(project.edit, project);
    if (nextEdit === project.edit) return;
    const now = Date.now();
    const merge = !!coalesceKey && coalesce?.key === coalesceKey && now - coalesce.at < 900;
    const nextPast = merge ? past : [...past, { edit: project.edit, packaging: project.packaging, label }].slice(-MAX_UNDO);
    set({ project: commitEdit(project, nextEdit), past: nextPast, future: [], coalesce: coalesceKey ? { key: coalesceKey, at: now } : null, save: { ...get().save, state: 'dirty' } });
  },

  pack: (fn, label, coalesceKey) => {
    const { project, past, coalesce } = get();
    if (!project || blockedByViewing()) return;
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
    if (!project || blockedByViewing()) return;
    set({ project: next, past: [...past, { edit: project.edit, packaging: project.packaging, label }].slice(-MAX_UNDO), future: [], coalesce: null, save: { ...get().save, state: 'dirty' } });
  },

  undo: () => {
    const { project, past, future } = get();
    const snap = past[past.length - 1];
    if (!project || !snap || blockedByViewing()) return;
    const redoSnap: Snapshot = { edit: project.edit, packaging: project.packaging, label: snap.label };
    const restored = { ...commitEdit(project, snap.edit), packaging: snap.packaging };
    set({ project: restored, past: past.slice(0, -1), future: [...future, redoSnap], coalesce: null, save: { ...get().save, state: 'dirty' } });
    get().toast(`Undid: ${snap.label}`);
  },

  redo: () => {
    const { project, past, future } = get();
    const snap = future[future.length - 1];
    if (!project || !snap || blockedByViewing()) return;
    const undoSnap: Snapshot = { edit: project.edit, packaging: project.packaging, label: snap.label };
    const restored = { ...commitEdit(project, snap.edit), packaging: snap.packaging };
    set({ project: restored, past: [...past, undoSnap], future: future.slice(0, -1), coalesce: null, save: { ...get().save, state: 'dirty' } });
    get().toast(`Redid: ${snap.label}`);
  },

  setView: (view) => {
    const { project } = get();
    if (!project || project.ui.view === view) return;
    // Versions are looked at in the editor only.
    get().exitViewing();
    // Navigation keeps the playhead and never touches the edit.
    set({ project: { ...project, ui: { ...project.ui, view, playhead: usePlayback.getState().time } }, save: { ...get().save, state: 'dirty' } });
  },

  select: (selection) => set({ selection, also: [] }),
  selectMany: (items) => set({ selection: items[0] ?? null, also: items.slice(1) }),
  toggleSelect: (ref) => {
    const now = selectedItems(get());
    // a click with ⇧ or ⌘ next to something that is not a block starts a new selection
    if (!now.length) return set({ selection: ref, also: [] });
    const rest = now.filter((r) => !sameRef(r, ref));
    if (rest.length === now.length) return set({ selection: ref, also: now });
    set({ selection: rest[0] ?? null, also: rest.slice(1) });
  },
  setJob: (job) => set({ job }),

  toast: (text, tone = 'info', action) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, tone, action }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 9000 : 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setComparison: (comparison) => set({ comparison }),
}));

/**
 * While an earlier version is on screen every change to the edit is refused:
 * what is shown is not what would be changed. Says so once, not per keystroke.
 */
function blockedByViewing(): boolean {
  const s = useApp.getState();
  if (!s.viewing) return false;
  if (Date.now() - viewingNoteAt > 2500) {
    viewingNoteAt = Date.now();
    s.toast(VIEWING_NOTE);
  }
  return true;
}

let viewCache: { project: Project; revision: number; view: Project } | null = null;

/** The viewed checkpoint as a project (that version's edit over the current footage), or null when the latest is shown. */
export function viewedProject(s: Pick<AppState, 'project' | 'viewing'>): Project | null {
  if (!s.project || !s.viewing || s.viewing.showing !== 'version') return null;
  if (viewCache && viewCache.project === s.project && viewCache.revision === s.viewing.revision) return viewCache.view;
  const view = projectAtCheckpoint(s.project, s.viewing.revision);
  if (!view) return null;
  viewCache = { project: s.project, revision: s.viewing.revision, view };
  return view;
}

/** True while the editor shows something that must not be edited: a proposed change or an earlier version. */
export const readOnly = (s: Pick<AppState, 'comparison' | 'viewing'>): boolean => !!s.comparison || !!s.viewing;

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

/** The open project. While an earlier version is being looked at, that version (so every panel reflects it). */
export function useProject(): Project {
  const p = useApp((s) => viewedProject(s) ?? s.project);
  if (!p) throw new Error('No project is open');
  return p;
}

/** The project the preview should show: a comparison side when one is open, else the live project. */
export function useShownProject(): Project {
  const p = useApp((s) => viewedProject(s) ?? s.project);
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
  // Always the live project: a version that is only being looked at is never written to disk.
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
