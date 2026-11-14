/**
 * Putting a generated file (voice, music, sound effect, picture, video) into the project. Used by the Generate
 * sheet and by AI tools controlling Cutaway, so both place things the same way.
 */
import { meta, musicClipsOf, newMusicClip, sourceFromProbe, uid, withMusic, withSources, type MediaSource, type SourceRole } from '@cutaway/core';
import type { GenKind } from '@shared/api';
import { placeOverlays } from '../screens/editor/addMenus';
import { photosToClips, sourceToClip } from './actions';
import { timeMapOf, useApp, usePlayback } from './store';

export const GEN_NAMES = { elevenlabs: 'ElevenLabs', fal: 'fal.ai', mac: 'This Mac (free)' } as const;

export interface PlaceGenerated {
  /** Project-relative path of the generated file. */
  path: string;
  kind: GenKind;
  provider: keyof typeof GEN_NAMES;
  model: string;
  prompt: string;
  /** Pictures and video: a clip on the video row, or over the video. */
  target?: 'clip' | 'over';
  /** Audio: where it starts in the finished video (seconds). Default: the playhead. */
  at?: number | null;
  /** Audio: its level (1 = as made). */
  gain?: number;
}

/** Adds the file as a source and places it. Returns the new source and the timeline item it became. */
export async function placeGenerated(g: PlaceGenerated): Promise<{ sourceId: string; itemId: string | null; label: string }> {
  const app = useApp.getState();
  const projectPath = app.projectPath;
  if (!projectPath) throw new Error('No project is open.');
  const [probe] = await window.cutaway.native.probe([`${projectPath}/${g.path}`]);
  if (!probe?.ok) throw new Error(probe?.error?.message ?? 'The generated file could not be read.');
  const kind = g.kind;
  const role: SourceRole = kind === 'image' ? 'image' : kind === 'video' ? 'broll' : 'music';
  const label = kind === 'voice' ? 'Voiceover' : kind === 'music' ? 'Music' : kind === 'sound' ? 'Sound' : kind === 'image' ? 'Image' : 'Video';
  const short = g.prompt.length > 40 ? `${g.prompt.slice(0, 38)}…` : g.prompt;
  const source: MediaSource = {
    ...sourceFromProbe({ ...probe, path: g.path }, role, { managed: true, origin: 'import', name: `${label} · ${short}` }),
    note: `Generated with ${GEN_NAMES[g.provider]} (${g.model}) from: “${g.prompt}”`,
    license: g.provider === 'mac' ? 'macOS system voice' : `Generated with ${GEN_NAMES[g.provider]}; see its terms for use`,
  };
  app.patch((p) => withSources(p, [...p.sources, source]));
  const target = g.target ?? 'over';
  if (kind === 'image') {
    if (target === 'clip') photosToClips([source.id]);
    else placeOverlays([source.id]);
    return { sourceId: source.id, itemId: null, label };
  }
  if (kind === 'video') {
    const clip = target === 'clip' ? sourceToClip(source.id) : (placeOverlays([source.id]), null);
    return { sourceId: source.id, itemId: clip, label };
  }
  let id = '';
  app.edit((e, p) => {
    const map = timeMapOf(p);
    const at = Math.max(0, Math.min(g.at ?? usePlayback.getState().time, Math.max(0, map.outDuration - 0.3)));
    const m = meta('creator', p.revision + 1);
    // music sits under the voice; a voice or a sound plays at its own level and is never lowered
    const clip =
      kind === 'music'
        ? { ...newMusicClip(source, at, map.outDuration, m), ...(g.gain !== undefined ? { gain: g.gain } : {}) }
        : { id: uid('mus'), sourceId: source.id, start: at, sourceIn: 0, length: Math.max(0.2, source.duration), gain: g.gain ?? (kind === 'voice' ? 1 : 0.8), fadeIn: 0, fadeOut: kind === 'sound' ? Math.min(0.15, source.duration / 4) : 0, duck: false, meta: m };
    id = clip.id;
    return withMusic(e, [...musicClipsOf(e, p.sources), clip]);
  }, `Add ${label.toLowerCase()}`);
  return { sourceId: source.id, itemId: id || null, label };
}
