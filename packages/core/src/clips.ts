/**
 * Clips: several pieces of footage on one timeline.
 *
 * The session timeline is the playing clips laid end to end, in order. A clip
 * plays a window of a "take" (a recorded take, or files imported together and
 * synced to one another). Everything the editor stores in session time
 * therefore belongs to exactly one clip, and moving a clip means moving that
 * stretch of session time with everything on it.
 *
 * Two layers move, and they move at different moments:
 *
 *  1. The edit (`EditState`): clip order plus every session-time lane. The
 *     clip operations below (`moveClip`, `splitClip`, `removeClip`, …) return
 *     a new edit with the lanes already carried along. Undo, checkpoints and
 *     version viewing all hold whole edits, so they keep order and decisions
 *     together for free.
 *
 *  2. Everything outside the edit that is also in session time: where each
 *     source file sits, the transcript, the analysis, flags, chapters, the
 *     chat thread. `projectWithEdit` re-lays those to match whichever clip
 *     order the incoming edit has. It is the one place an edit is put on a
 *     project (`commitEdit`, undo, restore and version viewing all go through
 *     it), so the two layers can never disagree.
 *
 * A removed clip is not deleted. It moves behind the last playing clip, past
 * `project.duration`, where nothing reads it, and its decisions are parked on
 * the clip. So any two orders hold the same footage and one can always be
 * re-laid into the other without losing anything.
 *
 * SESSION_LANES is the single list of session-time lanes. A lane added to the
 * edit later is carried by every clip operation once its key is listed there.
 */
import type { Analysis, ChatMessage, Clip, EditOp, EditState, Flag, LayoutMode, MediaSource, Packaging, Project, Range, Seconds, SourceRole, Transcript, Word } from './types';
import { EPS, uid } from './ranges';
import { relayShorts } from './shorts';

export const MAIN_TAKE = 'main';

/** Roles that sit on the timeline (as opposed to supporting media: B-roll, music, images). */
export const TIMELINE_ROLES: readonly SourceRole[] = ['screen', 'cameraA', 'cameraB', 'voice', 'systemAudio'];
export const isTimelineSource = (s: Pick<MediaSource, 'role'>): boolean => TIMELINE_ROLES.includes(s.role);
export const takeOf = (s: Pick<MediaSource, 'take'>): string => s.take ?? MAIN_TAKE;
/** The source a placement was made from (itself, unless it is a second placement of the same file). */
export const baseIdOf = (s: Pick<MediaSource, 'id' | 'instanceOf'>): string => s.instanceOf ?? s.id;

/**
 * Every lane of the edit whose items are ranges in session time. Each clip
 * operation carries all of them. `keeps` holds bare ranges; the others hold
 * items with an id. `sounds` are sound effects (absent in older projects).
 */
export const SESSION_LANES = ['cuts', 'keeps', 'speeds', 'layouts', 'zooms', 'overlays', 'broll', 'masks', 'locks', 'suggestions', 'sounds'] as const;
export type SessionLane = (typeof SESSION_LANES)[number];

type LaneItem = Range & { id?: string; apply?: EditOp[] };
const lane = (edit: EditState, key: string): LaneItem[] | null => {
  const v = (edit as unknown as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as LaneItem[]) : null;
};

// ───────────────────────────── geometry ─────────────────────────────

export const clipLength = (c: Pick<Clip, 'in' | 'out'>): Seconds => Math.max(0, c.out - c.in);
export const clipEnd = (c: Pick<Clip, 'start' | 'in' | 'out'>): Seconds => c.start + clipLength(c);
export const clipRange = (c: Pick<Clip, 'start' | 'in' | 'out'>): Range => ({ start: c.start, end: clipEnd(c) });
export const playingClips = (clips: Clip[]): Clip[] => clips.filter((c) => !c.removed);
/** Length of the session timeline: the playing clips end to end. */
export const clipsDuration = (clips: Clip[]): Seconds => playingClips(clips).reduce((n, c) => n + clipLength(c), 0);

/** Playing clips first, in order, then removed ones; every clip starts where the one before it ends. */
export function layoutClips(clips: Clip[]): Clip[] {
  const ordered = [...clips.filter((c) => !c.removed), ...clips.filter((c) => c.removed)];
  let t = 0;
  let changed = false;
  const out = ordered.map((c, i) => {
    const placed = Math.abs(c.start - t) < EPS ? c : { ...c, start: t };
    if (placed !== clips[i]) changed = true;
    t += clipLength(c);
    return placed;
  });
  return changed ? out : clips;
}

const legacy = new WeakMap<EditState, { duration: number; clips: Clip[] }>();

/** The clips of a project. A project saved before clips existed is one clip holding the whole recording. */
export function clipsOf(project: Pick<Project, 'edit' | 'duration'>): Clip[] {
  if (project.edit.clips) return project.edit.clips;
  const hit = legacy.get(project.edit);
  if (hit && hit.duration === project.duration) return hit.clips;
  const clips: Clip[] = [{ id: MAIN_TAKE, take: MAIN_TAKE, name: 'Clip 1', start: 0, in: 0, out: project.duration, ...(project.edit.baseLayout ? { baseLayout: project.edit.baseLayout } : {}) }];
  legacy.set(project.edit, { duration: project.duration, clips });
  return clips;
}

/** True once a project has more than one piece of footage on (or parked off) its timeline. */
export const hasSeveralClips = (project: Pick<Project, 'edit' | 'duration'>): boolean => clipsOf(project).length > 1;

/** The playing clip at a session time (the last clip also owns its own end). */
export function clipAt(clips: Clip[], t: Seconds): Clip | null {
  let last: Clip | null = null;
  for (const c of clips) {
    if (c.removed) continue;
    if (t >= c.start - EPS && t < clipEnd(c) - EPS) return c;
    last = c;
  }
  return last && Math.abs(t - clipEnd(last)) < 1e-3 ? last : null;
}

/** Session times where one playing clip ends and the next begins. */
export function clipBoundaries(clips: Clip[]): Seconds[] {
  return playingClips(clips)
    .slice(1)
    .map((c) => c.start);
}

/** The view used where no layout segment applies at a session time: the clip's own, else the project's. */
export function baseLayoutAt(project: Pick<Project, 'edit' | 'duration'>, t: Seconds): LayoutMode | undefined {
  if (!project.edit.clips) return project.edit.baseLayout;
  return clipAt(project.edit.clips, t)?.baseLayout ?? project.edit.baseLayout;
}

/**
 * A run is a stretch of neighbouring clips that continue one another in the
 * same take (what a split leaves behind). One placement of each source file
 * serves a whole run, so playback does not hiccup at a split.
 */
export interface Run {
  /** Id of the run's first clip. */
  key: string;
  take: string;
  start: Seconds;
  end: Seconds;
  /** session = take time + shift, anywhere inside the run. */
  shift: Seconds;
  /** Holds the take's first clip: this run uses the source records themselves, not second placements. */
  primary: boolean;
  removed: boolean;
}

export function clipRuns(clips: Clip[]): Run[] {
  const runs: Run[] = [];
  let prev: Clip | null = null;
  for (const c of clips) {
    const run = runs[runs.length - 1];
    if (run && prev && prev.take === c.take && !!prev.removed === !!c.removed && Math.abs(prev.out - c.in) < 1e-6 && Math.abs(clipEnd(prev) - c.start) < 1e-6) {
      run.end = clipEnd(c);
      run.primary ||= c.id === c.take;
    } else {
      runs.push({ key: c.id, take: c.take, start: c.start, end: clipEnd(c), shift: c.start - c.in, primary: c.id === c.take, removed: !!c.removed });
    }
    prev = c;
  }
  // exactly one run per take uses the source records themselves
  for (const take of new Set(runs.map((r) => r.take))) {
    const mine = runs.filter((r) => r.take === take);
    if (!mine.some((r) => r.primary)) mine[0]!.primary = true;
    else mine.filter((r) => r.primary).slice(1).forEach((r) => (r.primary = false));
  }
  return runs;
}

// ───────────────────────────── moving session time ─────────────────────────────

/** How one clip order re-lays into another: stretches of the old session timeline and how far each moves. */
export interface SessionMap {
  pieces: { start: Seconds; end: Seconds; delta: Seconds }[];
}

export function sessionMap(from: Clip[], to: Clip[]): SessionMap {
  const pieces: SessionMap['pieces'] = [];
  for (const f of from) {
    for (const g of to) {
      if (g.take !== f.take) continue;
      const a = Math.max(f.in, g.in);
      const b = Math.min(f.out, g.out);
      if (b - a <= EPS) continue;
      const start = f.start + (a - f.in);
      pieces.push({ start, end: f.start + (b - f.in), delta: g.start + (a - g.in) - start });
    }
  }
  pieces.sort((x, y) => x.start - y.start);
  return { pieces };
}

export const isIdentityMap = (map: SessionMap): boolean => map.pieces.every((p) => Math.abs(p.delta) < EPS);

/** Where a session time lands. null when no clip of the new order holds that footage. */
export function mapTime(map: SessionMap, t: Seconds): Seconds | null {
  let closing: number | null = null;
  for (const p of map.pieces) {
    if (t >= p.start - EPS && t < p.end - EPS) return t + p.delta;
    if (Math.abs(t - p.end) <= EPS * 10) closing = t + p.delta;
  }
  return closing;
}

/**
 * Where a session range lands. A range that crosses from one stretch into another is split, and the
 * parts are joined again when they still touch afterwards. Empty when its footage is in no clip.
 */
export function mapRange(map: SessionMap, r: Range): Range[] {
  const out: Range[] = [];
  for (const p of map.pieces) {
    const a = Math.max(r.start, p.start);
    const b = Math.min(r.end, p.end);
    if (b - a <= 1e-4) continue;
    const next = { start: a + p.delta, end: b + p.delta };
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - next.start) < 1e-6) last.end = next.end;
    else out.push(next);
  }
  return out;
}

function mapOps(map: SessionMap, ops: EditOp[]): EditOp[] {
  return ops.flatMap((op) => {
    const nested = 'apply' in op && op.apply ? { apply: mapOps(map, op.apply) } : {};
    return mapRange(map, op).map((r) => ({ ...op, ...nested, start: r.start, end: r.end }) as EditOp);
  });
}

/** Carry every session-time lane of an edit through a re-lay. Clip order itself is not touched here. */
export function remapEdit(edit: EditState, map: SessionMap): EditState {
  if (isIdentityMap(map)) return edit;
  const next = { ...edit } as unknown as Record<string, unknown>;
  for (const key of SESSION_LANES) {
    const items = lane(edit, key);
    if (!items) continue;
    const moved: LaneItem[] = [];
    for (const it of items) {
      mapRange(map, it).forEach((r, i) => {
        const piece: LaneItem = { ...it, start: r.start, end: r.end };
        if (i > 0 && it.id !== undefined) piece.id = `${it.id}~${i + 1}`;
        if (it.apply) piece.apply = mapOps(map, it.apply);
        moved.push(piece);
      });
    }
    next[key] = moved.sort((a, b) => a.start - b.start);
  }
  return next as unknown as EditState;
}

/** Take the decisions inside a session range out of the lanes; their times become offsets from the range's start. */
function parkLanes(edit: EditState, range: Range): { edit: EditState; parked: Record<string, unknown[]> } {
  const next = { ...edit } as unknown as Record<string, unknown>;
  const parked: Record<string, unknown[]> = {};
  for (const key of SESSION_LANES) {
    const items = lane(edit, key);
    if (!items) continue;
    const stay: LaneItem[] = [];
    const go: LaneItem[] = [];
    for (const it of items) {
      const a = Math.max(it.start, range.start);
      const b = Math.min(it.end, range.end);
      if (b - a <= 1e-4) {
        stay.push(it);
        continue;
      }
      // the part inside leaves with the clip; anything outside stays where it is
      go.push({ ...it, start: a - range.start, end: b - range.start });
      if (it.start < range.start - 1e-4) stay.push({ ...it, end: range.start });
      if (it.end > range.end + 1e-4) stay.push({ ...it, ...(it.id !== undefined ? { id: `${it.id}~t` } : {}), start: range.end });
    }
    next[key] = stay;
    if (go.length) parked[key] = go;
  }
  return { edit: next as unknown as EditState, parked };
}

function unparkLanes(edit: EditState, parked: Record<string, unknown[]> | undefined, at: Seconds): EditState {
  if (!parked) return edit;
  const next = { ...edit } as unknown as Record<string, unknown>;
  for (const key of SESSION_LANES) {
    const back = parked[key] as LaneItem[] | undefined;
    if (!back?.length) continue;
    const shift: SessionMap = { pieces: [{ start: -1e9, end: 1e9, delta: at }] };
    const items = back.map((it) => ({ ...it, start: it.start + at, end: it.end + at, ...(it.apply ? { apply: mapOps(shift, it.apply) } : {}) }));
    next[key] = [...(lane(edit, key) ?? []), ...items].sort((a, b) => a.start - b.start);
  }
  return next as unknown as EditState;
}

// ───────────────────────────── clip operations (the edit) ─────────────────────────────

type Ctx = Pick<Project, 'edit' | 'duration'>;

/**
 * A transition belongs to two neighbouring clips. Once a clip operation leaves them no longer
 * neighbours (one moved away, was removed, or another clip came between) the transition is dropped,
 * so none is ever left pointing at a boundary that does not exist.
 */
export function keepTransitions(edit: EditState, clips: Clip[]): EditState {
  if (!edit.transitions?.length) return edit;
  const playing = playingClips(clips);
  const kept = edit.transitions.filter((t) => {
    const i = playing.findIndex((c) => c.id === t.from);
    return i >= 0 && playing[i + 1]?.id === t.to;
  });
  if (kept.length === edit.transitions.length) return edit;
  const next = { ...edit };
  if (kept.length) next.transitions = kept;
  else delete next.transitions;
  return next;
}

function relay(edit: EditState, from: Clip[], order: Clip[]): EditState {
  const to = layoutClips(order);
  return keepTransitions({ ...remapEdit(edit, sessionMap(from, to)), clips: to }, to);
}

/** Move a playing clip to a position among the playing clips. Everything on it moves with it. */
export function moveClip(project: Ctx, id: string, toIndex: number): EditState {
  const clips = clipsOf(project);
  const playing = playingClips(clips);
  const from = playing.findIndex((c) => c.id === id);
  if (from < 0) return project.edit;
  const index = Math.max(0, Math.min(playing.length - 1, toIndex));
  if (index === from) return project.edit;
  const order = [...playing];
  const [moved] = order.splice(from, 1);
  order.splice(index, 0, moved!);
  return relay(project.edit, clips, [...order, ...clips.filter((c) => c.removed)]);
}

/** Smallest piece a split may leave. */
export const MIN_CLIP = 0.2;

/** Split the clip under a session time into two. Nothing moves; the two halves can then be moved or removed apart. */
export function splitClip(project: Ctx, t: Seconds): EditState | null {
  const clips = clipsOf(project);
  const c = clipAt(clips, t);
  if (!c || t - c.start < MIN_CLIP || clipEnd(c) - t < MIN_CLIP) return null;
  const cut = c.in + (t - c.start);
  const taken = new Set(clips.map((x) => x.name));
  const base = c.name.replace(/ \(\d+\)$/, '');
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  const first: Clip = { ...c, out: cut };
  const second: Clip = { ...c, id: uid('clip'), name: `${base} (${n})`, start: t, in: cut };
  const next: EditState = { ...project.edit, clips: layoutClips(clips.flatMap((x) => (x.id === c.id ? [first, second] : [x]))) };
  // the transition out of the clip now leaves from its second half
  if (next.transitions?.some((x) => x.from === c.id)) next.transitions = next.transitions.map((x) => (x.from === c.id ? { ...x, from: second.id } : x));
  return next;
}

/** Take a clip off the timeline. Its footage stays in the project and its decisions are parked on it. */
export function removeClip(project: Ctx, id: string): EditState {
  const clips = clipsOf(project);
  const c = clips.find((x) => x.id === id && !x.removed);
  if (!c || playingClips(clips).length < 2) return project.edit;
  const { edit, parked } = parkLanes(project.edit, clipRange(c));
  const order = [...clips.filter((x) => x.id !== id), { ...c, removed: true, parked }];
  return relay(edit, clips, order);
}

/** Put a removed clip back on the timeline (at the end unless a position is given), with its decisions. */
export function putBackClip(project: Ctx, id: string, toIndex?: number): EditState {
  const clips = clipsOf(project);
  const c = clips.find((x) => x.id === id && x.removed);
  if (!c) return project.edit;
  const playing = playingClips(clips);
  const index = Math.max(0, Math.min(playing.length, toIndex ?? playing.length));
  const back: Clip = { ...c };
  delete back.removed;
  delete back.parked;
  const order = [...playing.slice(0, index), back, ...playing.slice(index), ...clips.filter((x) => x.removed && x.id !== id)];
  const next = relay(project.edit, clips, order);
  const placed = next.clips!.find((x) => x.id === id)!;
  return unparkLanes(next, c.parked, placed.start);
}

export function renameClip(project: Ctx, id: string, name: string): EditState {
  const clean = name.trim().slice(0, 80);
  const clips = clipsOf(project);
  if (!clean || !clips.some((c) => c.id === id && c.name !== clean)) return project.edit;
  return { ...project.edit, clips: clips.map((c) => (c.id === id ? { ...c, name: clean } : c)) };
}

export function setClipLayout(project: Ctx, id: string, mode: LayoutMode | undefined): EditState {
  const clips = clipsOf(project);
  return {
    ...project.edit,
    clips: clips.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c };
      if (mode) next.baseLayout = mode;
      else delete next.baseLayout;
      return next;
    }),
  };
}

function edgeCuts(edit: Pick<EditState, 'cuts'>, clip: Clip): { head: EditState['cuts'][number] | null; tail: EditState['cuts'][number] | null } {
  const end = clipEnd(clip);
  const head = edit.cuts.find((c) => c.kind === 'trim' && Math.abs(c.start - clip.start) < 1e-3 && c.end <= end + 1e-3) ?? null;
  const tail = edit.cuts.find((c) => c.kind === 'trim' && c !== head && Math.abs(c.end - end) < 1e-3 && c.start >= clip.start - 1e-3) ?? null;
  return { head, tail };
}

/** How much of a clip's start and end is trimmed away (trim cuts sitting on its edges). */
export function clipTrim(edit: Pick<EditState, 'cuts'>, clip: Clip): { head: Seconds; tail: Seconds } {
  const { head, tail } = edgeCuts(edit, clip);
  return { head: head ? head.end - head.start : 0, tail: tail ? tail.end - tail.start : 0 };
}

/** The part of a clip that still plays after its trims, in session time. */
export function clipKept(edit: Pick<EditState, 'cuts'>, clip: Clip): Range {
  const t = clipTrim(edit, clip);
  return { start: clip.start + t.head, end: clipEnd(clip) - t.tail };
}

/**
 * Trim a clip's start or end to `seconds` (0 restores it). A trim is a cut on the clip's edge, so
 * nothing else moves in session time and dragging the handle back brings the footage back.
 */
export function trimClip(project: Ctx & Pick<Project, 'revision'>, id: string, side: 'head' | 'tail', seconds: Seconds): EditState {
  const clips = clipsOf(project);
  const c = clips.find((x) => x.id === id && !x.removed);
  if (!c) return project.edit;
  const end = clipEnd(c);
  const edges = edgeCuts(project.edit, c);
  const mine = side === 'head' ? edges.head : edges.tail;
  const other = side === 'head' ? edges.tail : edges.head;
  const amount = Math.max(0, Math.min(seconds, clipLength(c) - (other ? other.end - other.start : 0) - MIN_CLIP));
  if (Math.abs(amount - (mine ? mine.end - mine.start : 0)) < 1e-4) return project.edit;
  const cuts = project.edit.cuts.filter((cut) => cut !== mine);
  if (amount > 0.01) {
    const range = side === 'head' ? { start: c.start, end: c.start + amount } : { start: end - amount, end };
    cuts.push({ id: mine?.id ?? uid('cut'), ...range, kind: 'trim', meta: { origin: 'creator', revision: project.revision + 1, reason: side === 'head' ? 'Clip start trimmed' : 'Clip end trimmed' } });
    cuts.sort((x, y) => x.start - y.start);
  }
  return { ...project.edit, cuts };
}

/** Add clips after the last playing one (new footage). The clips' `start` is assigned here. */
export function appendClips(project: Ctx, fresh: Omit<Clip, 'start'>[]): EditState {
  const clips = clipsOf(project);
  const order = [...playingClips(clips), ...fresh.map((c) => ({ ...c, start: 0 })), ...clips.filter((c) => c.removed)];
  return relay(project.edit, clips, order);
}

// ───────────────────────────── sources on the timeline ─────────────────────────────

/** Length of a take: how far its lead source (screen, else camera A, else the first) reaches on the take's own clock. */
export function takeDuration(sources: MediaSource[], take: string): Seconds {
  const mine = sources.filter((s) => !s.instanceOf && takeOf(s) === take && ['screen', 'cameraA', 'cameraB', 'voice'].includes(s.role) && s.sync.status !== 'unsynced');
  const lead = mine.find((s) => s.role === 'screen') ?? mine.find((s) => s.role === 'cameraA') ?? mine[0];
  if (!lead) return 0;
  return lead.sync.offset - (lead.shift ?? 0) + lead.duration / lead.sync.rate;
}

function place(s: MediaSource, run: Run, asInstance: boolean): MediaSource {
  const d = run.shift - (s.shift ?? 0);
  const id = asInstance ? `${s.id}~${run.key}` : s.id;
  if (!asInstance && Math.abs(d) < EPS && s.window && Math.abs(s.window.start - run.start) < EPS && Math.abs(s.window.end - run.end) < EPS) return s;
  const placed: MediaSource = {
    ...s,
    id,
    shift: run.shift,
    window: { start: run.start, end: run.end },
    sync: {
      ...s.sync,
      offset: s.sync.offset + d,
      checkpoints: s.sync.checkpoints.map((c) => ({ ...c, sessionTime: c.sessionTime + d })),
      calibration: s.sync.calibration.map((c) => ({ ...c, session: c.session + d })),
    },
    gaps: s.gaps.map((g) => ({ ...g, start: g.start + d, end: g.end + d })),
  };
  if (asInstance) placed.instanceOf = s.id;
  return placed;
}

/**
 * Put every timeline source where the clips say it plays. A take whose clips sit apart on the
 * timeline gets one extra placement of each of its files per separate stretch.
 */
export function placeSources(sources: MediaSource[], clips: Clip[]): MediaSource[] {
  const runs = clipRuns(clips);
  const out: MediaSource[] = [];
  let changed = false;
  for (const s of sources) {
    if (s.instanceOf) {
      changed = true;
      continue;
    }
    const mine = isTimelineSource(s) ? runs.filter((r) => r.take === takeOf(s)) : [];
    if (mine.length === 0) {
      out.push(s);
      continue;
    }
    for (const r of [...mine].sort((a, b) => Number(b.primary) - Number(a.primary))) {
      const p = place(s, r, !r.primary);
      if (p !== s) changed = true;
      out.push(p);
    }
  }
  if (!changed && out.length === sources.length) return sources;
  // an unchanged set of placements keeps its identity so nothing downstream recomputes
  if (out.length === sources.length && out.every((p, i) => same(p, sources[i]!))) return sources;
  return out;
}

function same(a: MediaSource, b: MediaSource): boolean {
  if (a === b) return true;
  return a.id === b.id && a.duration === b.duration && a.sync.rate === b.sync.rate && a.sync.status === b.sync.status && a.gaps.length === b.gaps.length && Math.abs((a.shift ?? 0) - (b.shift ?? 0)) < EPS && Math.abs(a.sync.offset - b.sync.offset) < EPS && !!a.window === !!b.window && (!a.window || (Math.abs(a.window.start - b.window!.start) < EPS && Math.abs(a.window.end - b.window!.end) < EPS)) && a.path === b.path && a.available === b.available && a.role === b.role && a.name === b.name;
}

/** Re-derive second placements after the source records changed (relink, rename, sync), keeping the clip order. */
export function refreshPlacements<P extends Pick<Project, 'sources' | 'edit'>>(project: P): P {
  if (!project.edit.clips) return project;
  const sources = placeSources(project.sources, project.edit.clips);
  return sources === project.sources ? project : { ...project, sources };
}

// ───────────────────────────── re-laying a project ─────────────────────────────

function mapWords(words: Word[], map: SessionMap): Word[] {
  return words.map((w) => {
    const start = mapTime(map, w.start);
    return start === null || Math.abs(start - w.start) < EPS ? w : { ...w, start, end: start + (w.end - w.start) };
  });
}

function relayTranscript(t: Transcript | null, map: SessionMap, duration: Seconds): Transcript | null {
  if (!t) return t;
  const all = mapWords([...t.words, ...(t.parked ?? [])], map).sort((a, b) => a.start - b.start);
  const words = all.filter((w) => w.start < duration - EPS);
  const parked = all.filter((w) => w.start >= duration - EPS);
  const next: Transcript = { ...t, words };
  if (parked.length) next.parked = parked;
  else delete next.parked;
  return next;
}

function resample(values: number[], hz: number, back: SessionMap, total: Seconds): number[] {
  if (values.length === 0 || hz <= 0) return values;
  const n = Math.max(values.length, Math.ceil(total * hz) + 1);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    // the closing sample (exactly at the end of all footage) belongs to no clip: it stays where it is
    const from = t >= total - 1e-6 ? t : mapTime(back, t);
    out[i] = values[Math.round((from ?? t) * hz)] ?? 0;
  }
  return out;
}

function relayAnalysis(a: Analysis | null, map: SessionMap, back: SessionMap, duration: Seconds, total: Seconds): Analysis | null {
  if (!a) return a;
  const silences = [...a.silences, ...(a.parked?.silences ?? [])].flatMap((r) => mapRange(map, r)).sort((x, y) => x.start - y.start);
  const clicks = [...a.clicks, ...(a.parked?.clicks ?? [])].map((c) => ({ ...c, t: mapTime(map, c.t) ?? c.t })).sort((x, y) => x.t - y.t);
  const next: Analysis = {
    ...a,
    silences: silences.filter((r) => r.start < duration - EPS),
    clicks: clicks.filter((c) => c.t < duration - EPS),
    activity: resample(a.activity, a.activityHz, back, total),
    waveform: resample(a.waveform, a.waveformHz, back, total),
  };
  const parked = { silences: silences.filter((r) => r.start >= duration - EPS), clicks: clicks.filter((c) => c.t >= duration - EPS) };
  if (parked.silences.length || parked.clicks.length) next.parked = parked;
  else delete next.parked;
  return next;
}

function relayPackaging(p: Packaging, map: SessionMap, sources: MediaSource[]): Packaging {
  const known = new Set(sources.map((s) => s.id));
  return {
    ...p,
    chapters: p.chapters.map((c) => ({ ...c, sessionTime: mapTime(map, c.sessionTime) ?? c.sessionTime })),
    concepts: p.concepts.map((c) => ({
      ...c,
      evidence: c.evidence.map((e) => ({ ...e, sessionTime: mapTime(map, e.sessionTime) ?? e.sessionTime })),
      // a still taken from a second placement falls back to the file's own record when that placement is gone
      layers: c.layers.map((l) => (l.kind === 'frame' && !known.has(l.sourceId) && l.sourceId.includes('~') ? { ...l, sourceId: l.sourceId.split('~')[0]! } : l)),
    })),
  };
}

function relayRange<R extends Range>(r: R, map: SessionMap): R {
  const start = mapTime(map, r.start);
  return start === null ? r : { ...r, start, end: start + (r.end - r.start) };
}

function relayChat(chat: ChatMessage[] | undefined, map: SessionMap): ChatMessage[] | undefined {
  if (!chat?.length) return chat;
  return chat.map((m) => ({
    ...m,
    scope: m.scope ? relayRange(m.scope, map) : m.scope,
    ...(m.moments ? { moments: m.moments.map((x) => relayRange(x, map)) } : {}),
    ...(m.items
      ? {
          items: m.items.map((it) => ({
            ...it,
            range: relayRange(it.range, map),
            // an applied change is history; an open one must still land on the same footage
            ...(it.op && it.status !== 'applied' ? { op: mapOps(map, [it.op])[0] ?? it.op } : {}),
            ...(it.rules ? { rules: { ...it.rules, scope: relayRange(it.rules.scope, map) } } : {}),
          })),
        }
      : {}),
  }));
}

/** Clips for footage the incoming order does not mention (added after that version was saved): appended, playing. */
function withMissingTakes(to: Clip[], from: Clip[], sources: MediaSource[]): Clip[] {
  const have = new Set(to.map((c) => c.take));
  const extra: Clip[] = [];
  const alive = new Set(sources.filter((s) => isTimelineSource(s)).map(takeOf));
  for (const c of from) {
    // footage that has left the project altogether is not brought back
    if (have.has(c.take) || !alive.has(c.take)) continue;
    const back: Clip = { ...c };
    delete back.removed;
    delete back.parked;
    extra.push(back);
  }
  for (const take of new Set(sources.filter((s) => isTimelineSource(s) && !s.instanceOf).map(takeOf))) {
    if (have.has(take) || extra.some((c) => c.take === take)) continue;
    const length = takeDuration(sources, take);
    if (length > EPS) extra.push({ id: take, take, name: `Clip ${to.length + extra.length + 1}`, start: 0, in: 0, out: length });
  }
  if (extra.length === 0) return to;
  return layoutClips([...playingClips(to), ...extra, ...to.filter((c) => c.removed)]);
}

/**
 * The project with `edit` as its edit, and everything outside the edit re-laid to that edit's clip
 * order. No revision bump: this is also how an earlier version is shown without changing anything.
 */
export function projectWithEdit(project: Project, edit: EditState): Project {
  if (edit === project.edit) return project;
  // Same clip order (or neither edit has clips): nothing outside the edit moves.
  if (edit.clips === project.edit.clips) return { ...project, edit };
  let to = edit.clips;
  const current = clipsOf(project);
  // An edit saved before clips existed is the first take as one clip, in recording order.
  to ??= [{ id: MAIN_TAKE, take: MAIN_TAKE, name: current.find((c) => c.id === MAIN_TAKE)?.name ?? 'Clip 1', start: 0, in: 0, out: takeDuration(project.sources, MAIN_TAKE) || current.filter((c) => c.take === MAIN_TAKE).reduce((n, c) => Math.max(n, c.out), 0), ...(edit.baseLayout ? { baseLayout: edit.baseLayout } : {}) }];
  to = withMissingTakes(layoutClips(to), current, project.sources);
  const withClips = to === edit.clips ? edit : { ...edit, clips: to };
  const map = sessionMap(current, to);
  const duration = clipsDuration(to);
  const sources = placeSources(project.sources, to);
  if (isIdentityMap(map) && sources === project.sources && Math.abs(duration - project.duration) < EPS) return { ...project, edit: withClips };
  const total = to.reduce((n, c) => n + clipLength(c), 0);
  const flags: Flag[] | undefined = project.flags?.map((f) => {
    const t = mapTime(map, f.t) ?? f.t;
    const next: Flag = { ...f, t };
    if (t >= duration - EPS) next.parked = true;
    else delete next.parked;
    return next;
  });
  return {
    ...project,
    edit: withClips,
    duration,
    sources,
    transcript: relayTranscript(project.transcript, map, duration),
    analysis: relayAnalysis(project.analysis, map, sessionMap(to, current), duration, total),
    packaging: relayPackaging(project.packaging, map, sources),
    ...(flags ? { flags } : {}),
    ...(project.chat ? { chat: relayChat(project.chat, map) } : {}),
    ...(project.shorts ? { shorts: relayShorts(project.shorts, (r) => relayRange(r, map)) } : {}),
  };
}

// ───────────────────────────── naming ─────────────────────────────

/** Name for the next clip: "Clip N", counting every clip the project has had on its timeline. */
export function nextClipName(project: Pick<Project, 'edit' | 'duration'>): string {
  const clips = clipsOf(project);
  const taken = new Set(clips.map((c) => c.name));
  let n = clips.length + 1;
  while (taken.has(`Clip ${n}`)) n += 1;
  return `Clip ${n}`;
}

// ───────────────────────────── reading by time ─────────────────────────────

/** What the AI and the timeline say about each playing clip. */
export interface ClipInfo {
  id: string;
  index: number;
  name: string;
  start: Seconds;
  end: Seconds;
  roles: SourceRole[];
}

export function clipInfos(project: Pick<Project, 'edit' | 'duration' | 'sources'>): ClipInfo[] {
  return playingClips(clipsOf(project)).map((c, i) => ({
    id: c.id,
    index: i + 1,
    name: c.name,
    start: c.start,
    end: clipEnd(c),
    roles: [...new Set(project.sources.filter((s) => isTimelineSource(s) && takeOf(s) === c.take && s.sync.status !== 'unsynced').map((s) => s.role))],
  }));
}

/**
 * Keep a range inside one clip: the clip holding most of it. Returns the range unchanged when the
 * project is a single clip or the range already fits.
 */
export function withinOneClip(clips: Clip[], r: Range): { range: Range; clipped: boolean } {
  const playing = playingClips(clips);
  if (playing.length < 2) return { range: r, clipped: false };
  let best: Range | null = null;
  for (const c of playing) {
    const a = Math.max(r.start, c.start);
    const b = Math.min(r.end, clipEnd(c));
    if (b - a > (best ? best.end - best.start : 0)) best = { start: a, end: b };
  }
  if (!best) return { range: r, clipped: false };
  return { range: best, clipped: best.start > r.start + 1e-4 || best.end < r.end - 1e-4 };
}

/** Cut a range at clip boundaries: one piece per clip it touches. */
export function splitAtClips(clips: Clip[], r: Range): Range[] {
  const playing = playingClips(clips);
  if (playing.length < 2) return [r];
  const out: Range[] = [];
  for (const c of playing) {
    const a = Math.max(r.start, c.start);
    const b = Math.min(r.end, clipEnd(c));
    if (b - a > 1e-4) out.push({ start: a, end: b });
  }
  return out.length ? out : [r];
}
