/**
 * Transitions between clips, and fades on B-roll.
 *
 * A transition sits on the boundary between two neighbouring clips and is
 * centred on it in output time. It never changes the length of the video and
 * nothing on the timeline moves: for its duration the frame is a blend of the
 * clip that is playing and its neighbour.
 *
 * Where the neighbour's picture comes from (cross-dissolve only): while clip A
 * is still playing, clip B is shown from the footage just before its first
 * kept frame when that footage exists (a trimmed start), played in step; when
 * it does not, B's first frame is held. After the boundary the same is done
 * for A with the footage after its last kept frame. A dip needs no second
 * picture: A fades to the colour, then B fades up from it.
 *
 * Everything here is a pure function of the project and a time, so preview
 * and export agree.
 */
import type { BrollInsert, Clip, EditState, Project, Seconds, Transition, TransitionKind } from './types';
import { clipEnd, clipsOf, playingClips } from './clips';
import { clamp, uid } from './ranges';
import type { TimeMap } from './timemap';

export const TRANSITION = { min: 0.2, max: 2, default: 0.5 } as const;
export const TRANSITION_KINDS: { value: TransitionKind; label: string }[] = [
  { value: 'dissolve', label: 'Cross-dissolve' },
  { value: 'dip-black', label: 'Dip to black' },
  { value: 'dip-white', label: 'Dip to white' },
];
export const transitionLabel = (kind: TransitionKind): string => TRANSITION_KINDS.find((k) => k.value === kind)?.label ?? kind;

type Ctx = Pick<Project, 'edit' | 'duration'>;

export const transitionsOf = (edit: Pick<EditState, 'transitions'>): Transition[] => edit.transitions ?? [];

/** Pairs of neighbouring playing clips, in order: every place a transition can sit. */
export function clipPairs(clips: Clip[]): { from: Clip; to: Clip }[] {
  const playing = playingClips(clips);
  return playing.slice(1).map((to, i) => ({ from: playing[i]!, to }));
}

/** The transition between two clips, if they are neighbours and one is set. */
export function transitionBetween(project: Ctx, from: string, to: string): Transition | null {
  if (!clipPairs(clipsOf(project)).some((p) => p.from.id === from && p.to.id === to)) return null;
  return transitionsOf(project.edit).find((t) => t.from === from && t.to === to) ?? null;
}

const cleanDuration = (d: number): Seconds => clamp(Number.isFinite(d) ? d : TRANSITION.default, TRANSITION.min, TRANSITION.max);

/**
 * Set, change or clear (`kind: null`) the transition between two neighbouring clips.
 * Returns the edit unchanged when the two are not neighbours.
 */
export function setTransition(project: Ctx, from: string, to: string, kind: TransitionKind | null, duration?: Seconds): EditState {
  if (!clipPairs(clipsOf(project)).some((p) => p.from.id === from && p.to.id === to)) return project.edit;
  const all = transitionsOf(project.edit);
  const mine = all.find((t) => t.from === from && t.to === to);
  const rest = all.filter((t) => t !== mine);
  if (kind === null) {
    if (!mine) return project.edit;
    const next = { ...project.edit };
    if (rest.length) next.transitions = rest;
    else delete next.transitions;
    return next;
  }
  const d = cleanDuration(duration ?? mine?.duration ?? TRANSITION.default);
  if (mine && mine.kind === kind && Math.abs(mine.duration - d) < 1e-4) return project.edit;
  return { ...project.edit, transitions: [...rest, { id: mine?.id ?? uid('tr'), from, to, kind, duration: d }] };
}

/** The same transition on every clip change (`kind: null` clears them all). One edit, so one undo step. */
export function setAllTransitions(project: Ctx, kind: TransitionKind | null, duration?: Seconds): EditState {
  const pairs = clipPairs(clipsOf(project));
  if (kind === null) {
    if (!project.edit.transitions?.length) return project.edit;
    const next = { ...project.edit };
    delete next.transitions;
    return next;
  }
  if (pairs.length === 0) return project.edit;
  const old = transitionsOf(project.edit);
  const d = cleanDuration(duration ?? TRANSITION.default);
  return { ...project.edit, transitions: pairs.map((p) => ({ id: old.find((t) => t.from === p.from.id && t.to === p.to.id)?.id ?? uid('tr'), from: p.from.id, to: p.to.id, kind, duration: d })) };
}

// ───────────────────────────── where a transition lands ─────────────────────────────

/** A transition placed on the finished video. */
export interface PlacedTransition {
  transition: Transition;
  from: Clip;
  to: Clip;
  /** Output second of the clip change, and the output span the transition covers (centred on it). */
  at: Seconds;
  start: Seconds;
  end: Seconds;
  /** Drawn length: the wanted length, clamped to what the two clips can give. */
  duration: Seconds;
  /** Last session moment of `from` and first session moment of `to` that play. */
  fromEnd: Seconds;
  toStart: Seconds;
}

const outLength = (map: TimeMap, c: Clip): Seconds => map.rangeToOutput({ start: c.start, end: clipEnd(c) }).reduce((n, r) => n + (r.end - r.start), 0);

/**
 * The longest a transition between two clips may be: neither clip gives more than half of what it
 * plays (so the transitions on either side of a short clip never meet), and never more than the limit.
 */
export function maxTransition(map: TimeMap, from: Clip, to: Clip): Seconds {
  return Math.max(0, Math.min(TRANSITION.max, outLength(map, from), outLength(map, to)));
}

const placedCache = new WeakMap<EditState, { map: TimeMap; placed: PlacedTransition[] }>();

/** Every transition that is really drawn: its two clips are neighbours and both still play. */
export function placedTransitions(project: Ctx, map: TimeMap): PlacedTransition[] {
  const all = project.edit.transitions;
  if (!all?.length) return [];
  const hit = placedCache.get(project.edit);
  if (hit && hit.map === map) return hit.placed;
  const placed: PlacedTransition[] = [];
  for (const { from, to } of clipPairs(clipsOf(project))) {
    const t = all.find((x) => x.from === from.id && x.to === to.id);
    if (!t) continue;
    const duration = Math.min(cleanDuration(t.duration), maxTransition(map, from, to));
    if (duration < 0.04) continue;
    const at = map.toOutput(to.start);
    const fromEnd = map.toSource(Math.max(0, at - 1e-4));
    const toStart = map.toSource(Math.min(map.outDuration, at + 1e-4));
    // a clip with nothing left to play has no edge to blend from
    if (fromEnd < from.start - 1e-3 || fromEnd > clipEnd(from) + 1e-3 || toStart < to.start - 1e-3 || toStart > clipEnd(to) + 1e-3) continue;
    placed.push({ transition: t, from, to, at, start: at - duration / 2, end: at + duration / 2, duration, fromEnd, toStart });
  }
  placedCache.set(project.edit, { map, placed });
  return placed;
}

/** Sound levels of the two clips at progress `p` (0 = all of the first clip, 1 = all of the second). */
export function transitionGains(kind: TransitionKind, p: number): { from: number; to: number } {
  const q = clamp(p, 0, 1);
  if (kind === 'dissolve') return { from: Math.cos((q * Math.PI) / 2), to: Math.sin((q * Math.PI) / 2) }; // equal power
  // a dip: the first clip is down by the clip change, the second comes up after it
  return q < 0.5 ? { from: Math.cos(q * Math.PI), to: 0 } : { from: 0, to: -Math.cos(q * Math.PI) };
}

/** What a transition asks of the frame at an output time. */
export interface ActiveTransition {
  kind: TransitionKind;
  /** 0 at the start of the span, 0.5 at the clip change, 1 at the end. */
  progress: number;
  /** Colour laid over the picture (dips). */
  wash: { color: string; alpha: number } | null;
  /** The neighbouring clip's picture, laid over the frame at `alpha` (cross-dissolve). */
  partner: {
    clipId: string;
    /** Output time at which the neighbour's frame is evaluated: its first (or last) playing frame. */
    edgeOut: Seconds;
    /** Session time its picture is taken from. */
    src: Seconds;
    /** True when there is no footage beyond the edge and the edge frame is held. */
    held: boolean;
    alpha: number;
  } | null;
  /** Sound level of the clip that is playing, and of the neighbour (heard only where it has real footage). */
  gain: number;
  partnerGain: number;
  /** Session time of the neighbour's sound, or null where it has none. */
  partnerSound: Seconds | null;
}

/** Session time of the neighbouring clip's material at an output time inside a transition, and whether it is real footage. */
export function partnerTime(t: PlacedTransition, out: Seconds, frame: Seconds): { src: Seconds; held: boolean; real: Seconds | null } {
  if (out < t.at) {
    // the clip that is about to begin: footage before its first kept frame, back to the clip's own start
    const want = t.toStart - (t.at - out);
    const real = want >= t.to.start - 1e-6 ? want : null;
    return { src: Math.max(t.to.start, want), held: real === null, real };
  }
  const want = t.fromEnd + (out - t.at);
  const last = clipEnd(t.from) - frame;
  const real = want <= last + 1e-6 ? want : null;
  return { src: Math.min(Math.max(t.fromEnd, last), want), held: real === null, real };
}

/** The transition in progress at an output time, if any. `fps` sets how close to a clip's end a frame can be taken. */
export function transitionAt(placed: PlacedTransition[], out: Seconds, fps = 30): ActiveTransition | null {
  for (const t of placed) {
    if (out < t.start || out >= t.end) continue;
    const p = clamp((out - t.start) / t.duration, 0, 1);
    const before = out < t.at;
    const g = transitionGains(t.transition.kind, p);
    if (t.transition.kind !== 'dissolve') {
      const alpha = before ? p * 2 : (1 - p) * 2;
      return { kind: t.transition.kind, progress: p, wash: { color: t.transition.kind === 'dip-white' ? '#ffffff' : '#000000', alpha: clamp(alpha, 0, 1) }, partner: null, gain: before ? g.from : g.to, partnerGain: 0, partnerSound: null };
    }
    const frame = 1 / Math.max(1, fps);
    const other = partnerTime(t, out, frame);
    return {
      kind: 'dissolve',
      progress: p,
      wash: null,
      // drawn over the playing clip: the incoming clip at p before the change, the outgoing one at 1 − p after it
      partner: { clipId: before ? t.to.id : t.from.id, edgeOut: before ? t.at + frame / 2 : Math.max(0, t.at - frame / 2), src: other.src, held: other.held, alpha: before ? p : 1 - p },
      gain: before ? g.from : g.to,
      partnerGain: before ? g.to : g.from,
      partnerSound: other.real,
    };
  }
  return null;
}

// ───────────────────────────── B-roll fades ─────────────────────────────

/** Standard B-roll fade when the insert does not say otherwise (what every insert had before fades were adjustable). */
export const BROLL_FADE = { standard: 0.3, max: 2 } as const;

/** Seconds an insert fades in and out, for an insert lasting `length` output seconds. Never more than a third of it each. */
export function brollFades(insert: Pick<BrollInsert, 'fadeIn' | 'fadeOut'>, length: Seconds): { in: Seconds; out: Seconds } {
  const cap = Math.max(0, length / 3);
  const one = (v: number | undefined) => Math.min(cap, clamp(v ?? BROLL_FADE.standard, 0, BROLL_FADE.max));
  return { in: one(insert.fadeIn), out: one(insert.fadeOut) };
}

/** Opacity (before easing) of an insert shown from output second `a` to `b`, at output second `out`. */
export function brollOpacity(insert: Pick<BrollInsert, 'fadeIn' | 'fadeOut'>, a: Seconds, b: Seconds, out: Seconds): number {
  const f = brollFades(insert, b - a);
  const up = f.in > 1e-4 ? (out - a) / f.in : 1;
  const down = f.out > 1e-4 ? (b - out) / f.out : 1;
  return clamp(Math.min(up, down), 0, 1);
}
