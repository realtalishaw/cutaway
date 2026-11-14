/**
 * Punch-in on jump cuts.
 *
 * A cut inside one continuous camera shot is a visible jump: the speaker's
 * head snaps to a new position. Editors hide it by changing the framing at
 * the cut, so it reads as a change of shot. With the setting on, every such
 * cut alternates between the normal framing and a slight punch-in.
 *
 * Nothing is stored per cut. Where the punch-in applies is worked out from
 * the edit each time (`punchJoins`), so it follows every later cut, restore,
 * clip move and view change by construction. The only stored things are the
 * setting itself and the ids of cuts the creator excluded.
 *
 * It applies at a cut only when the picture on both sides is the same camera,
 * full frame, in the same clip and the same view segment, with no zoom
 * active. Anything else (a clip change, a view change) resets the framing to
 * normal.
 */
import type { CameraSlot, EditState, Project, PunchIn, Seconds } from './types';
import { clipAt } from './clips';
import { resolveLayout } from './frame';
import type { CameraCrop, FaceTrackSmooth } from './parity';
import { clamp } from './ranges';
import type { TimeMap } from './timemap';

export const PUNCH = { default: 1.12, min: 1.05, max: 1.3 } as const;

export function punchInOf(edit: Pick<EditState, 'punchIn'>): Required<PunchIn> {
  const p = edit.punchIn;
  return { enabled: !!p?.enabled, scale: clamp(p?.scale ?? PUNCH.default, PUNCH.min, PUNCH.max), skip: p?.skip ?? [] };
}

type PProject = Pick<Project, 'sources' | 'edit' | 'duration'>;

/** A place where the finished video jumps over removed footage. */
export interface PunchJoin {
  /** Output second of the join, and the session moments just before and after it. */
  at: Seconds;
  before: Seconds;
  after: Seconds;
  /** The cuts that make this join. */
  cutIds: string[];
  /** Same camera, full frame, same clip and view on both sides, no zoom. */
  qualifies: boolean;
  /** Why it does not qualify (for the editor). */
  why?: 'clip' | 'view' | 'zoom';
  /** The creator excluded this cut: the framing stays as it was. */
  skipped: boolean;
  camera?: CameraSlot;
  /** Framing after the join. */
  punched: boolean;
}

interface Derived {
  map: TimeMap;
  joins: PunchJoin[];
  /** Framing of each time-map segment. */
  punched: boolean[];
}

const cache = new WeakMap<EditState, Derived>();

function derive(project: PProject, map: TimeMap): Derived {
  const hit = cache.get(project.edit);
  if (hit && hit.map === map) return hit;
  const { edit } = project;
  const skip = new Set(punchInOf(edit).skip);
  const joins: PunchJoin[] = [];
  const punched: boolean[] = [];
  let state = false;
  const segs = map.segments;
  for (let i = 0; i < segs.length; i++) {
    if (i > 0) {
      const prev = segs[i - 1]!;
      const seg = segs[i]!;
      // a change of speed is a new segment but not a jump: the framing carries on
      if (seg.srcStart - prev.srcEnd > 1e-3) {
        const before = prev.srcEnd - 1e-3;
        const after = seg.srcStart + 1e-3;
        const cutIds = edit.cuts.filter((c) => c.start < seg.srcStart - 1e-6 && c.end > prev.srcEnd + 1e-6).map((c) => c.id);
        const a = resolveLayout(project, before);
        const b = resolveLayout(project, after);
        let why: PunchJoin['why'];
        if (edit.clips && clipAt(edit.clips, before)?.id !== clipAt(edit.clips, after)?.id) why = 'clip';
        else if (a.mode !== 'camera' || b.mode !== 'camera' || a.camera !== b.camera || a.unresolved || b.unresolved || (a.segment?.id ?? null) !== (b.segment?.id ?? null)) why = 'view';
        else if (edit.zooms.some((z) => (before >= z.start && before < z.end) || (after >= z.start && after < z.end))) why = 'zoom';
        const qualifies = !why;
        const skipped = qualifies && cutIds.some((id) => skip.has(id));
        if (!qualifies) state = false;
        else if (!skipped) state = !state;
        const join: PunchJoin = { at: seg.outStart, before, after, cutIds, qualifies, skipped, punched: state };
        if (why) join.why = why;
        if (qualifies) join.camera = a.camera;
        joins.push(join);
      }
    }
    punched.push(state);
  }
  const d = { map, joins, punched };
  cache.set(project.edit, d);
  return d;
}

/** Every join of the finished video, with whether the punch-in applies there. Independent of the setting being on. */
export function punchJoins(project: PProject, map: TimeMap): PunchJoin[] {
  return derive(project, map).joins;
}

/** Magnification the punch-in adds at an output time: the setting's scale in a punched-in shot, otherwise 1. */
export function punchScaleAt(project: PProject, map: TimeMap, out: Seconds): number {
  const p = punchInOf(project.edit);
  if (!p.enabled) return 1;
  const i = map.segmentAtOut(out);
  return i >= 0 && derive(project, map).punched[i] ? p.scale : 1;
}

/**
 * The punch-in as a factor on whatever framing the camera already has: an existing crop (face framing,
 * or a short's reframe) keeps its centre and is magnified; with no crop the window closes in on the
 * usual face position when a face track is known (leaving headroom), else on the centre of the frame.
 */
export function punchCrop(crop: CameraCrop | undefined, scale: number, track?: FaceTrackSmooth | null): CameraCrop | undefined {
  if (scale <= 1.0005) return crop;
  if (crop) return { ...crop, scale: crop.scale * scale };
  const half = 0.5 / scale;
  if (!track) return { cx: 0.5, cy: 0.5, scale };
  const m = track.median;
  return { cx: clamp(m.cx, half, 1 - half), cy: clamp(m.cy + m.size * 0.08, half, 1 - half), scale };
}

export function setPunchIn(edit: EditState, patch: Partial<Pick<PunchIn, 'enabled' | 'scale'>>): EditState {
  const now = punchInOf(edit);
  const next: PunchIn = { enabled: patch.enabled ?? now.enabled, scale: clamp(patch.scale ?? now.scale, PUNCH.min, PUNCH.max) };
  if (now.skip.length) next.skip = now.skip;
  if (next.enabled === now.enabled && Math.abs(next.scale - now.scale) < 1e-4) return edit;
  return { ...edit, punchIn: next };
}

/** Exclude the cuts of one join from the punch-in, or include them again. */
export function setPunchSkipped(edit: EditState, cutIds: string[], skipped: boolean): EditState {
  const now = punchInOf(edit);
  const live = new Set(edit.cuts.map((c) => c.id));
  const set = new Set(now.skip.filter((id) => live.has(id))); // forget cuts that no longer exist
  for (const id of cutIds) {
    if (skipped) set.add(id);
    else set.delete(id);
  }
  const skip = [...set];
  if (skip.length === now.skip.length && skip.every((id) => now.skip.includes(id))) return edit;
  const next: PunchIn = { enabled: now.enabled, scale: now.scale };
  if (skip.length) next.skip = skip;
  return { ...edit, punchIn: next };
}
