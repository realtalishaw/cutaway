/** Creator actions for free text, music clips and sound effects. Every one is a single undoable step through the store. */
import {
  MAX_POINT_LEVEL,
  splitMusicClip,
  fitMusicClip,
  volumeAt,
  DEFAULT_SOUND_GAIN,
  addSounds,
  cleanCue,
  cutMoments,
  duplicateOverlay,
  makeSound,
  meta,
  musicClipsOf,
  newMusicClip,
  normalizeTextStyle,
  overlaysFromTemplate,
  soundOnEveryText,
  soundsOf,
  textStyleOf,
  textTemplate,
  trimMusicStart,
  updateMusicClip,
  viewChangeMoments,
  withMusic,
  type MusicClip,
  type VolumePoint,
  type Overlay,
  type Project,
  type SoundCue,
  type SoundEffect,
  type TextStyle,
} from '@cutaway/core';
import { timeMapOf, useApp, usePlayback } from '../../state/store';
import { patchItem, playheadSource, seekSource } from './ops';

const app = () => useApp.getState();

// ───────────────────────────── text ─────────────────────────────

/** Adds a text template at the playhead and opens it for editing. */
export function addText(templateId = 'plain'): string | null {
  const project = app().project;
  if (!project) return null;
  const t = playheadSource(project);
  let ids: string[] = [];
  app().edit((e, p) => {
    const made = overlaysFromTemplate(templateId, t, p.duration, meta('creator', p.revision + 1));
    ids = made.map((o) => o.id);
    return { ...e, overlays: [...e.overlays, ...made].sort((a, b) => a.start - b.start) };
  }, `Add ${textTemplate(templateId).name.toLowerCase()}`);
  if (ids[0]) app().select({ kind: 'overlay', id: ids[0] });
  // Step past its arrival, so what is on screen is the text settled in place (at its first frame a fade or pop shows nothing).
  const made = app().project?.edit.overlays.find((o) => o.id === ids[0]);
  if (made) {
    const s = textStyleOf(made);
    seekSource(app().project!, Math.min(made.end - 0.05, made.start + (s.in.type === 'none' ? 0 : s.in.duration) + 0.05));
  }
  // show the timeline rows that hold it
  if (!project.ui.expandedTimeline) app().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } }));
  return ids[0] ?? null;
}

type StylePatch = Partial<Omit<TextStyle, 'background' | 'outline' | 'sub' | 'in' | 'out'>> & {
  background?: Partial<TextStyle['background']>;
  outline?: Partial<TextStyle['outline']>;
  sub?: Partial<TextStyle['sub']>;
  in?: Partial<TextStyle['in']>;
  out?: Partial<TextStyle['out']>;
};

/** Changes part of a text overlay's style. Dragging a slider is one undo step. */
export function patchTextStyle(o: Overlay, patch: StylePatch, label: string, coalesce = true) {
  const cur = textStyleOf(o);
  const next = normalizeTextStyle({
    ...cur,
    ...patch,
    background: { ...cur.background, ...(patch.background ?? {}) },
    outline: { ...cur.outline, ...(patch.outline ?? {}) },
    sub: { ...cur.sub, ...(patch.sub ?? {}) },
    in: { ...cur.in, ...(patch.in ?? {}) },
    out: { ...cur.out, ...(patch.out ?? {}) },
  });
  const key = Object.entries(patch)
    .map(([k, v]) => (v && typeof v === 'object' ? `${k}.${Object.keys(v).join('+')}` : k))
    .join(',');
  app().edit((e, p) => ({ ...e, overlays: e.overlays.map((x) => (x.id === o.id ? { ...x, style: next, meta: { ...x.meta, origin: 'creator' as const, revision: p.revision + 1 } } : x)) }), label, coalesce ? `text:${o.id}:${key}` : undefined);
}

/** Gives a text the look of a template, keeping its words, place and timing. */
export function applyTextLook(o: Overlay, templateId: string) {
  const look = textTemplate(templateId).parts[0]!;
  patchItem('overlays', o.id, { style: look.style, kind: 'text' }, `Use the ${textTemplate(templateId).name.toLowerCase()} look`, false);
}

export function duplicateText(id: string) {
  let copy = '';
  app().edit((e, p) => {
    const o = e.overlays.find((x) => x.id === id);
    if (!o) return e;
    const made = duplicateOverlay(o, p.duration, meta('creator', p.revision + 1));
    copy = made.id;
    return { ...e, overlays: [...e.overlays, made].sort((a, b) => a.start - b.start) };
  }, 'Duplicate text');
  if (copy) app().select({ kind: 'overlay', id: copy });
}

/** The sound a text or graphic makes as it appears; null removes it. */
export function setOverlaySound(id: string, cue: SoundCue | null, coalesce = false) {
  app().edit((e, p) => ({ ...e, overlays: e.overlays.map((x) => (x.id === id ? { ...x, sound: cue ? (cleanCue(cue, p.sources) ?? undefined) : undefined } : x)) }), cue ? 'Text sound' : 'Remove text sound', coalesce ? `text:${id}:sound` : undefined);
}

// ───────────────────────────── music ─────────────────────────────

/** Adds a music file as a clip starting at the playhead (output time). */
export function addMusic(sourceId: string): string | null {
  const project = app().project;
  const file = project?.sources.find((s) => s.id === sourceId);
  if (!project || !file) return null;
  const out = usePlayback.getState().time;
  let id = '';
  app().edit((e, p) => {
    const clips = musicClipsOf(e, p.sources);
    // the first piece of music starts with the video; later ones start where the playhead is
    const clip = newMusicClip(file, clips.length ? out : 0, timeMapOf(p).outDuration, meta('creator', p.revision + 1));
    id = clip.id;
    return withMusic(e, [...clips, clip]);
  }, 'Add music');
  if (id) app().select({ kind: 'music', id });
  return id || null;
}

export function patchMusic(id: string, patch: Partial<MusicClip>, label: string, coalesceKey?: string) {
  app().edit((e, p) => updateMusicClip(e, p.sources, id, patch, p.revision + 1), label, coalesceKey ? `music:${id}:${coalesceKey}` : undefined);
}

/** Drag on the timeline: `mode` says which part of the block moved; times are output seconds. */
export function retimeMusic(id: string, mode: 'move' | 'l' | 'r', start: number, end: number) {
  app().edit((e, p) => {
    const clip = musicClipsOf(e, p.sources).find((c) => c.id === id);
    if (!clip) return e;
    const patch = mode === 'move' ? { start: Math.max(0, start) } : mode === 'l' ? trimMusicStart(clip, start) : { length: end - clip.start };
    return updateMusicClip(e, p.sources, id, patch, p.revision + 1);
  }, mode === 'move' ? 'Move music' : 'Trim music', `music:${id}:${mode}`);
}

/** Split the music clip at the playhead (output time). The new second part is selected. False when the playhead is not inside it, or too near an edge. */
export function splitMusicAtPlayhead(id: string): boolean {
  const at = usePlayback.getState().time;
  let right = '';
  app().edit((e, p) => {
    const clips = musicClipsOf(e, p.sources);
    const clip = clips.find((c) => c.id === id);
    const parts = clip ? splitMusicClip(clip, at) : null;
    if (!clip || !parts) return e;
    const file = p.sources.find((s) => s.id === clip.sourceId);
    const [a, b] = parts.map((x) => fitMusicClip({ ...x, meta: { ...x.meta, origin: 'creator', revision: p.revision + 1 } }, file));
    right = b!.id;
    return withMusic(e, clips.flatMap((c) => (c.id === id ? [a!, b!] : [c])));
  }, 'Split music');
  if (right) app().select({ kind: 'music', id: right });
  return !!right;
}

/** Volume points of a clip, changed through `fn`. Points are seconds into the clip; levels are multiples of the clip's level. */
function editVolume(id: string, fn: (points: VolumePoint[], clip: MusicClip) => VolumePoint[], label: string, coalesceKey?: string) {
  app().edit((e, p) => {
    const clip = musicClipsOf(e, p.sources).find((c) => c.id === id);
    if (!clip) return e;
    const next = fn([...(clip.volume ?? [])], clip);
    return updateMusicClip(e, p.sources, id, { volume: next.length ? next : undefined }, p.revision + 1);
  }, label, coalesceKey ? `music:${id}:${coalesceKey}` : undefined);
}

/** Adds a volume point `t` seconds into the clip, at the level the music already has there unless one is given. Returns its index. */
export function addVolumePoint(id: string, t: number, level?: number): number {
  let index = -1;
  editVolume(id, (points, clip) => {
    const at = Math.max(0, Math.min(clip.length, t));
    if (points.some((v) => Math.abs(v.t - at) < 0.02)) return points;
    const next = [...points, { t: at, level: level ?? volumeAt(points, at) }].sort((a, b) => a.t - b.t);
    index = next.findIndex((v) => v.t === at);
    return next;
  }, 'Add volume point');
  return index;
}

/** Drag of one volume point: keeps it between its neighbours. Drags coalesce into one undo step. */
export function moveVolumePoint(id: string, index: number, t: number, level: number) {
  editVolume(id, (points, clip) => {
    if (!points[index]) return points;
    const lo = index > 0 ? points[index - 1]!.t + 0.01 : 0;
    const hi = index < points.length - 1 ? points[index + 1]!.t - 0.01 : clip.length;
    points[index] = { t: Math.max(lo, Math.min(hi, t)), level: Math.max(0, Math.min(MAX_POINT_LEVEL, level)) };
    return points;
  }, 'Move volume point', `volume:${index}`);
}

export function removeVolumePoint(id: string, index: number) {
  editVolume(id, (points) => points.filter((_, i) => i !== index), 'Remove volume point');
}

export function clearVolumePoints(id: string) {
  editVolume(id, () => [], 'Flatten music volume');
}

/** Ends the clip with the video and fades it out there. */
export function fitMusicToVideo(id: string) {
  app().edit((e, p) => {
    const clip = musicClipsOf(e, p.sources).find((c) => c.id === id);
    const end = timeMapOf(p).outDuration;
    if (!clip || end - clip.start < 0.3) return e;
    return updateMusicClip(e, p.sources, id, { length: end - clip.start, fadeOut: Math.max(clip.fadeOut, Math.min(2, (end - clip.start) / 3)) }, p.revision + 1);
  }, 'End music with the video');
}

// ───────────────────────────── sound effects ─────────────────────────────

/** Adds a sound at the playhead and selects it. */
export function addSoundAtPlayhead(cue: SoundCue): string | null {
  const project = app().project;
  if (!project) return null;
  const t = playheadSource(project);
  let id = '';
  app().edit((e, p) => {
    const clean = cleanCue(cue, p.sources);
    if (!clean) return e;
    const s = makeSound(t, clean, p.sources, meta('creator', p.revision + 1));
    id = s.id;
    return { ...e, sounds: [...soundsOf(e), s].sort((a, b) => a.start - b.start) };
  }, 'Add sound');
  if (id) app().select({ kind: 'sound', id });
  if (id && !project.ui.expandedTimeline) app().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } }));
  return id || null;
}

export function patchSound(id: string, patch: Partial<Pick<SoundEffect, 'start' | 'gain'>> & { cue?: SoundCue }, label: string, coalesceKey?: string) {
  app().edit((e, p) => ({
    ...e,
    sounds: soundsOf(e)
      .map((s) => {
        if (s.id !== id) return s;
        const cue = cleanCue(patch.cue ?? { builtin: s.builtin, sourceId: s.sourceId, gain: patch.gain ?? s.gain }, p.sources);
        if (!cue) return s;
        // re-made so its length follows the sound it now plays
        return { ...makeSound(Math.min(Math.max(0, patch.start ?? s.start), p.duration), { ...cue, gain: patch.gain ?? cue.gain }, p.sources, { ...s.meta, origin: 'creator' as const, revision: p.revision + 1 }), id: s.id };
      })
      .sort((a, b) => a.start - b.start),
  }), label, coalesceKey ? `sound:${id}:${coalesceKey}` : undefined);
}

export type SoundPlacement = 'views' | 'cuts' | 'texts';

/** One step: a sound on every view change, every cut, or every text. Returns how many were added. */
export function addSoundsEverywhere(where: SoundPlacement, cue: SoundCue): number {
  let count = 0;
  let moments = 0;
  const label = where === 'views' ? 'Sound on every view change' : where === 'cuts' ? 'Sound on every cut' : 'Sound on every text';
  app().edit((e, p) => {
    const clean = cleanCue(cue, p.sources);
    if (!clean) return e;
    if (where === 'texts') {
      const r = soundOnEveryText(e, clean);
      count = r.changed;
      moments = e.overlays.length;
      return r.edit;
    }
    const map = timeMapOf(p);
    const at = (where === 'views' ? viewChangeMoments(e, p.duration) : cutMoments(map)).filter((t) => map.isKept(t));
    const r = addSounds(e, at, clean, p.sources, meta('creator', p.revision + 1));
    moments = at.length;
    count = r.added.length;
    return r.edit;
  }, label);
  const what = where === 'views' ? 'view change' : where === 'cuts' ? 'cut' : 'text';
  app().toast(count ? `Added a sound to ${count} ${what}${count === 1 ? '' : 's'} — ⌘Z to undo` : moments ? `Every ${what} already has a sound.` : `There are no ${what}s to put a sound on yet.`);
  return count;
}

export const defaultCue = (builtin = 'pop'): SoundCue => ({ builtin, gain: DEFAULT_SOUND_GAIN });

/** How many of each kind of moment exist, for the buttons' labels. */
export function soundPlacementCounts(project: Project): Record<SoundPlacement, number> {
  const map = timeMapOf(project);
  return {
    views: viewChangeMoments(project.edit, project.duration).filter((t) => map.isKept(t)).length,
    cuts: cutMoments(map).length,
    texts: project.edit.overlays.length,
  };
}
