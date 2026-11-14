/**
 * Music clips. They live on the OUTPUT timeline (seconds of the finished video), so cutting, speeding
 * up or rearranging footage never makes the music jump or get chopped. The level maths here is the one
 * the preview and the exporter both use.
 */
import type { DecisionMeta, EditState, MediaSource, MusicClip, Project, Range, Seconds, VolumePoint } from './types';
import { clamp, uid, union } from './ranges';

/** How far the music drops while someone is speaking, and how quickly it gets there. */
export const DUCK_LEVEL = 0.22;
export const DUCK_SECONDS = 1 / (0.0004 * 48000);
/** Padding around each spoken word, so the music does not pump between words. */
const SPEECH_LEAD = 0.25;
const SPEECH_TAIL = 0.35;

export const MUSIC_DEFAULTS = { gain: 0.25, fadeIn: 0.5, fadeOut: 1.5, duck: true } as const;
export const MIN_MUSIC_LENGTH = 0.2;
/** Loudest a volume point may make the music: twice the clip's level. */
export const MAX_POINT_LEVEL = 2;
/** The longest a looping clip may run. */
const MAX_LOOP_LENGTH = 6 * 3600;
const LEGACY_ID = 'mus_legacy';
const UNKNOWN_LENGTH = 36000;

/**
 * The project's music clips. A project saved before music clips existed has one piece of music for the
 * whole video in `audio.music`: that is read as one clip from the start, for the length of the file.
 */
export function musicClipsOf(edit: Pick<EditState, 'music' | 'audio'>, sources: MediaSource[]): MusicClip[] {
  if (edit.music) return edit.music;
  const old = edit.audio.music;
  if (!old) return [];
  const file = sources.find((s) => s.id === old.sourceId);
  return [{ id: LEGACY_ID, sourceId: old.sourceId, start: 0, sourceIn: 0, length: file && file.duration > 0 ? file.duration : UNKNOWN_LENGTH, gain: old.gain, fadeIn: 0, fadeOut: 0, duck: old.duck, meta: { origin: 'creator', revision: 0 } }];
}

/** Writes the clip list (sorted by start) and retires the old single-track field. */
export function withMusic(edit: EditState, clips: MusicClip[]): EditState {
  return { ...edit, music: [...clips].sort((a, b) => a.start - b.start), audio: edit.audio.music ? { ...edit.audio, music: null } : edit.audio };
}

/**
 * Keeps a clip inside its file (a looping clip may run past it) and its fades inside the clip.
 * Volume points are kept even when the clip is trimmed short of them, so dragging the edge back brings them back.
 */
export function fitMusicClip(clip: MusicClip, file: MediaSource | undefined): MusicClip {
  const fileLength = file && file.duration > 0 ? file.duration : UNKNOWN_LENGTH;
  // a looping clip may begin on a later pass through the file (the second half of a split): that is the same place in the file
  const wrapped = clip.loop && fileLength < UNKNOWN_LENGTH ? ((clip.sourceIn % fileLength) + fileLength) % fileLength : clip.sourceIn;
  const sourceIn = clamp(wrapped, 0, Math.max(0, fileLength - MIN_MUSIC_LENGTH));
  const length = clamp(clip.length, MIN_MUSIC_LENGTH, Math.max(MIN_MUSIC_LENGTH, clip.loop ? MAX_LOOP_LENGTH : fileLength - sourceIn));
  let fadeIn = clamp(clip.fadeIn, 0, length);
  let fadeOut = clamp(clip.fadeOut, 0, length);
  if (fadeIn + fadeOut > length) {
    const k = length / (fadeIn + fadeOut);
    fadeIn *= k;
    fadeOut *= k;
  }
  const next: MusicClip = { ...clip, start: Math.max(0, clip.start), sourceIn, length, gain: clamp(clip.gain, 0, 1), fadeIn, fadeOut };
  if (clip.volume) {
    const points = clip.volume.filter((v) => Number.isFinite(v.t) && Number.isFinite(v.level)).map((v) => ({ t: v.t, level: clamp(v.level, 0, MAX_POINT_LEVEL) }));
    if (points.length) next.volume = points.sort((a, b) => a.t - b.t);
    else delete next.volume;
  }
  if (!clip.loop) delete next.loop;
  return next;
}

/**
 * A new clip of a music file starting at output second `at`. When the file runs past the end of the
 * video the clip is trimmed to end with it, so the fade-out is heard.
 */
export function newMusicClip(file: MediaSource, at: Seconds, outDuration: Seconds, meta: DecisionMeta): MusicClip {
  const start = clamp(at, 0, Math.max(0, outDuration - MIN_MUSIC_LENGTH));
  const room = Math.max(MIN_MUSIC_LENGTH, outDuration - start);
  const fileLength = file.duration > 0 ? file.duration : room;
  return fitMusicClip({ id: uid('mus'), sourceId: file.id, start, sourceIn: 0, length: Math.min(fileLength, room), gain: MUSIC_DEFAULTS.gain, fadeIn: MUSIC_DEFAULTS.fadeIn, fadeOut: MUSIC_DEFAULTS.fadeOut, duck: MUSIC_DEFAULTS.duck, meta }, file);
}

export function updateMusicClip(edit: EditState, sources: MediaSource[], id: string, patch: Partial<MusicClip>, revision?: number): EditState {
  const clips = musicClipsOf(edit, sources).map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, ...patch, id: c.id };
    return fitMusicClip(revision === undefined ? next : { ...next, meta: { ...next.meta, origin: 'creator' as const, revision } }, sources.find((s) => s.id === next.sourceId));
  });
  return withMusic(edit, clips);
}

export function removeMusicClip(edit: EditState, sources: MediaSource[], id: string): EditState {
  return withMusic(edit, musicClipsOf(edit, sources).filter((c) => c.id !== id));
}

/** Drops every clip and sound that plays a file that has left the project. */
export function withoutSoundSource(edit: EditState, sources: MediaSource[], sourceId: string): EditState {
  const clips = musicClipsOf(edit, sources);
  const usesIt = clips.some((c) => c.sourceId === sourceId) || (edit.sounds ?? []).some((s) => s.sourceId === sourceId) || edit.overlays.some((o) => o.sound?.sourceId === sourceId);
  if (!usesIt) return edit;
  const next = withMusic(edit, clips.filter((c) => c.sourceId !== sourceId));
  return {
    ...next,
    sounds: (next.sounds ?? []).filter((s) => s.sourceId !== sourceId),
    overlays: next.overlays.map((o) => (o.sound?.sourceId === sourceId ? { ...o, sound: undefined } : o)),
  };
}

/**
 * Trim a clip from its left edge: the part that stays keeps playing at the same moment of the video,
 * so the in-point moves with the edge.
 */
export function trimMusicStart(clip: MusicClip, newStart: Seconds): Partial<MusicClip> {
  const end = clip.start + clip.length;
  const earliest = clip.start - clip.sourceIn; // cannot reveal sound from before the file begins
  const start = clamp(newStart, Math.max(0, earliest), end - MIN_MUSIC_LENGTH);
  const shift = start - clip.start;
  return { start, sourceIn: clip.sourceIn + shift, length: end - start, ...(clip.volume ? { volume: clip.volume.map((v) => ({ ...v, t: v.t - shift })) } : {}) };
}

/**
 * The volume points of the part of a clip from `from` to `to` seconds into it, measured from `from`. The level
 * at each end is pinned with a point, so the part sounds exactly as it did inside the whole clip.
 */
export function sliceVolume(points: VolumePoint[] | undefined, from: Seconds, to: Seconds): VolumePoint[] | undefined {
  if (!points?.length) return undefined;
  const inside = points.filter((v) => v.t > from + 1e-4 && v.t < to - 1e-4).map((v) => ({ t: v.t - from, level: v.level }));
  return [{ t: 0, level: volumeAt(points, from) }, ...inside, { t: to - from, level: volumeAt(points, to) }];
}

/**
 * Split a clip at output second `at` into two that play on exactly as one did. Null when either part would
 * be shorter than MIN_MUSIC_LENGTH. The first part keeps the id; neither part fades where they meet.
 */
export function splitMusicClip(clip: MusicClip, at: Seconds): [MusicClip, MusicClip] | null {
  const t = at - clip.start;
  if (t < MIN_MUSIC_LENGTH || clip.length - t < MIN_MUSIC_LENGTH) return null;
  const left: MusicClip = { ...clip, length: t, fadeIn: Math.min(clip.fadeIn, t), fadeOut: 0 };
  const right: MusicClip = { ...clip, id: uid('mus'), start: at, sourceIn: clip.sourceIn + t, length: clip.length - t, fadeIn: 0, fadeOut: Math.min(clip.fadeOut, clip.length - t) };
  const lv = sliceVolume(clip.volume, 0, t);
  const rv = sliceVolume(clip.volume, t, clip.length);
  if (lv) left.volume = lv;
  if (rv) right.volume = rv;
  return [left, right];
}

// ───────────────────────────── level ─────────────────────────────

const shape = (x: number) => x * x;
/** Even a clip with no fades gets a few milliseconds at each end, so it can never start or stop on a click. */
const DECLICK = 0.006;

/** Fade envelope 0…1 at `t` seconds into the clip (0 outside it). */
export function musicFade(clip: Pick<MusicClip, 'length' | 'fadeIn' | 'fadeOut'>, t: Seconds): number {
  if (t < 0 || t >= clip.length) return 0;
  const fi = Math.max(DECLICK, clip.fadeIn);
  const fo = Math.max(DECLICK, clip.fadeOut);
  return shape(clamp(t / fi, 0, 1)) * shape(clamp((clip.length - t) / fo, 0, 1));
}

/** The volume points' multiplier at `t` seconds into a clip (1 when it has none). */
export function volumeAt(points: VolumePoint[] | undefined, t: Seconds): number {
  if (!points?.length) return 1;
  if (t <= points[0]!.t) return points[0]!.level;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (t <= b.t) {
      const a = points[i - 1]!;
      return b.t - a.t < 1e-6 ? b.level : a.level + ((b.level - a.level) * (t - a.t)) / (b.t - a.t);
    }
  }
  return points[points.length - 1]!.level;
}

/** How long one pass through the file lasts when the clip loops, else null. */
export function loopLength(clip: Pick<MusicClip, 'loop'>, fileLength: Seconds | undefined): Seconds | null {
  return clip.loop && fileLength && fileLength > MIN_MUSIC_LENGTH ? fileLength : null;
}

/** 0…1 dip around the points where a looping clip starts its file again, so the join never clicks. */
function loopSeam(clip: Pick<MusicClip, 'loop' | 'sourceIn'>, t: Seconds, fileLength: Seconds | undefined): number {
  const pass = loopLength(clip, fileLength);
  if (!pass) return 1;
  // the joins are where the file has been played through 1, 2, 3… times
  const a = clip.sourceIn + t;
  const pos = a % pass;
  const d = a < pass ? pass - a : Math.min(pos, pass - pos);
  return shape(clamp(d / DECLICK, 0, 1));
}

/** The clip's level at an output time, before ducking: level × fades × volume points (× the dip at a loop's join). */
export function musicGainAt(clip: MusicClip, out: Seconds, fileLength?: Seconds): number {
  const t = out - clip.start;
  return clip.gain * musicFade(clip, t) * volumeAt(clip.volume, t) * loopSeam(clip, t, fileLength);
}

/** Where in the file a clip is at an output time. A looping clip starts the file again each time it runs out. */
export function musicSourceTime(clip: Pick<MusicClip, 'start' | 'sourceIn' | 'loop'>, out: Seconds, fileLength?: Seconds): Seconds {
  const at = clip.sourceIn + (out - clip.start);
  const pass = loopLength(clip, fileLength);
  return pass ? ((at % pass) + pass) % pass : at;
}

/** Session-time stretches in which someone is speaking, merged and sorted. */
export function speechWindows(project: Pick<Project, 'transcript'>): Range[] {
  return union((project.transcript?.words ?? []).map((w) => ({ start: w.start - SPEECH_LEAD, end: w.end + SPEECH_TAIL })));
}

export function speakingAt(windows: Range[], t: Seconds): boolean {
  let lo = 0;
  let hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid]!;
    if (t < w.start) hi = mid - 1;
    else if (t >= w.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** One step of the ducking follower: moves `level` toward its target over `dt` seconds. */
export function duckStep(level: number, speaking: boolean, dt: Seconds): number {
  const target = speaking ? DUCK_LEVEL : 1;
  return level + (target - level) * (1 - Math.exp(-Math.max(0, dt) / DUCK_SECONDS));
}

/** Clips that sound at some point in [from, to) of the output timeline. */
export function musicBetween(clips: MusicClip[], from: Seconds, to: Seconds): MusicClip[] {
  return clips.filter((c) => c.start < to && c.start + c.length > from);
}
