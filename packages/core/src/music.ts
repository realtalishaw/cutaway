/**
 * Music clips. They live on the OUTPUT timeline (seconds of the finished video), so cutting, speeding
 * up or rearranging footage never makes the music jump or get chopped. The level maths here is the one
 * the preview and the exporter both use.
 */
import type { DecisionMeta, EditState, MediaSource, MusicClip, Project, Range, Seconds } from './types';
import { clamp, uid, union } from './ranges';

/** How far the music drops while someone is speaking, and how quickly it gets there. */
export const DUCK_LEVEL = 0.22;
export const DUCK_SECONDS = 1 / (0.0004 * 48000);
/** Padding around each spoken word, so the music does not pump between words. */
const SPEECH_LEAD = 0.25;
const SPEECH_TAIL = 0.35;

export const MUSIC_DEFAULTS = { gain: 0.25, fadeIn: 0.5, fadeOut: 1.5, duck: true } as const;
export const MIN_MUSIC_LENGTH = 0.2;
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

/** Keeps a clip inside its file and its fades inside the clip. */
export function fitMusicClip(clip: MusicClip, file: MediaSource | undefined): MusicClip {
  const fileLength = file && file.duration > 0 ? file.duration : UNKNOWN_LENGTH;
  const sourceIn = clamp(clip.sourceIn, 0, Math.max(0, fileLength - MIN_MUSIC_LENGTH));
  const length = clamp(clip.length, MIN_MUSIC_LENGTH, Math.max(MIN_MUSIC_LENGTH, fileLength - sourceIn));
  let fadeIn = clamp(clip.fadeIn, 0, length);
  let fadeOut = clamp(clip.fadeOut, 0, length);
  if (fadeIn + fadeOut > length) {
    const k = length / (fadeIn + fadeOut);
    fadeIn *= k;
    fadeOut *= k;
  }
  return { ...clip, start: Math.max(0, clip.start), sourceIn, length, gain: clamp(clip.gain, 0, 1), fadeIn, fadeOut };
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
  return { start, sourceIn: clip.sourceIn + (start - clip.start), length: end - start };
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

/** The clip's level at an output time, before ducking. */
export function musicGainAt(clip: MusicClip, out: Seconds): number {
  return clip.gain * musicFade(clip, out - clip.start);
}

/** Where in the file a clip is at an output time. */
export function musicSourceTime(clip: Pick<MusicClip, 'start' | 'sourceIn'>, out: Seconds): Seconds {
  return clip.sourceIn + (out - clip.start);
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
