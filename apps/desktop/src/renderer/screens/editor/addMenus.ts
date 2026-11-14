/**
 * What the simple timeline's "+ Add" buttons offer, and the menu shared by the selection toolbar's "…"
 * button and a right-click on a block. Everything is added at the playhead and selected, so it can be
 * seen and changed straight away.
 */
import { clipsOf, musicClipsOf, playingClips, type Project } from '@cutaway/core';
import { pickAudioToTimeline, pickOverlayMedia, pickVideosToTimeline, placeMusic } from '../../state/actions';
import { selectedItems, timeMapOf, useApp, usePlayback } from '../../state/store';
import type { MenuItem } from '../../ui/PopMenu';
import type { GenKind } from '@shared/api';

/** Opens the generation sheet for a kind; pictures and video go `clip` (video row) or `over` the footage. */
export type OpenGenerate = (kind: GenKind, target?: 'clip' | 'over') => void;
import { moveClipTo, removeClipById, splitClipAtPlayhead } from './clipOps';
import { copyItems, duplicateSelected, hasCopied, pasteItems } from './itemOps';
import { addBroll, addZoom, playheadSource, removeSelected, restoreOne } from './ops';
import { addSoundAtPlayhead, addText, defaultCue } from './titleSoundOps';

const app = () => useApp.getState();
const split = () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'split' }));

/** Show pictures or videos over the footage from the playhead, one after another. */
export function placeOverlays(ids: string[]) {
  const p = app().project;
  if (!p || !ids.length) return;
  let t = playheadSource(p);
  for (const id of ids) {
    const s = app().project!.sources.find((x) => x.id === id);
    if (!s) continue;
    const length = s.kind === 'video' ? Math.min(6, s.duration) : 4;
    const end = Math.min(app().project!.duration, t + length);
    if (end - t < 0.5) break;
    addBroll({ start: t, end }, id);
    t = end;
  }
}

export function videoAddItems(gen: OpenGenerate): MenuItem[] {
  return [
    { label: 'Video or photo from my files…', icon: 'upload', testId: 'add-video-file', onClick: () => void pickVideosToTimeline().then(placeOverlays) },
    { label: 'Record a clip', icon: 'record', onClick: () => app().go('record') },
    'sep',
    { label: 'Generate an image…', icon: 'sparkle', testId: 'gen-image-clip', onClick: () => gen('image', 'clip') },
    { label: 'Generate a video…', icon: 'sparkle', testId: 'gen-video-clip', onClick: () => gen('video', 'clip') },
  ];
}

export function effectsAddItems(project: Project, gen: OpenGenerate, openMotion: () => void): MenuItem[] {
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const t = () => playheadSource(app().project!);
  return [
    { label: 'Animation…', icon: 'sparkle', testId: 'add-motion', onClick: openMotion },
    { label: 'Text', icon: 'text', hint: 'T', testId: 'add-text', onClick: () => void addText('plain') },
    ...(hasScreen ? [{ label: 'Zoom in on the screen', icon: 'zoom' as const, testId: 'add-zoom', onClick: () => addZoom({ start: t(), end: Math.min(app().project!.duration, t() + 3) }) }] : []),
    { label: 'Photo or video over the footage…', icon: 'image', testId: 'add-overlay', onClick: () => void pickOverlayMedia().then(placeOverlays) },
    'sep',
    { label: 'Generate an image…', icon: 'sparkle', testId: 'gen-image-over', onClick: () => gen('image', 'over') },
    { label: 'Generate a video…', icon: 'sparkle', testId: 'gen-video-over', onClick: () => gen('video', 'over') },
  ];
}

export function audioAddItems(project: Project, gen: OpenGenerate, openRecord: () => void): MenuItem[] {
  const used = new Set(musicClipsOf(project.edit, project.sources).map((c) => c.sourceId));
  const inProject = project.sources.filter((s) => s.role === 'music' && s.available && !used.has(s.id));
  return [
    { label: 'Music or sound from my files…', icon: 'upload', testId: 'add-audio-file', onClick: () => void pickAudioToTimeline() },
    ...inProject.slice(0, 5).map((s) => ({ label: `Add “${s.name}”`, icon: 'music' as const, onClick: () => void placeMusic(s.id) })),
    'sep',
    { label: 'Record voiceover…', icon: 'record', testId: 'add-record-voiceover', onClick: openRecord },
    { label: 'AI voiceover…', icon: 'sparkle', testId: 'gen-voice', onClick: () => gen('voice') },
    'sep',
    { label: 'Generate music…', icon: 'sparkle', testId: 'gen-music', onClick: () => gen('music') },
    { label: 'Generate a sound effect…', icon: 'sparkle', testId: 'gen-sound', onClick: () => gen('sound') },
    { label: 'Built-in sound at the playhead', icon: 'bell', onClick: () => void addSoundAtPlayhead(defaultCue()) },
  ];
}

/** The "…" and right-click menu for whatever is selected. */
export function selectionMenuItems(project: Project): MenuItem[] {
  const sel = app().selection;
  if (!sel) return [];
  if (sel.kind === 'cut') return [{ label: 'Bring this part back', icon: 'undo', onClick: () => restoreOne(sel.id) }];
  if (sel.kind === 'clip') {
    const playing = playingClips(clipsOf(project));
    const i = playing.findIndex((c) => c.id === sel.id);
    return [
      { label: 'Split at the playhead', icon: 'scissors', hint: 'S', onClick: () => void splitClipAtPlayhead(project) },
      { label: 'Play earlier', disabled: i <= 0, hint: '⌥←', onClick: () => void moveClipTo(sel.id, i - 1) },
      { label: 'Play later', disabled: i < 0 || i >= playing.length - 1, hint: '⌥→', onClick: () => void moveClipTo(sel.id, i + 1) },
      'sep',
      { label: 'Remove clip', icon: 'trash', danger: true, hint: '⌫', disabled: playing.length < 2, onClick: () => void removeClipById(sel.id) },
    ];
  }
  const refs = selectedItems(app());
  if (!refs.length) return [];
  const motion = refs.length === 1 && refs[0]!.kind === 'overlay' && project.edit.overlays.some((o) => o.id === refs[0]!.id && o.kind === 'motion');
  const splittable = refs.length === 1 && !motion && ['layout', 'zoom', 'broll', 'speed', 'music', 'overlay', 'mask'].includes(refs[0]!.kind);
  return [
    { label: 'Copy', icon: 'copy', hint: '⌘C', onClick: () => void copyItems(refs) },
    { label: 'Paste at the playhead', hint: '⌘V', disabled: !hasCopied(), onClick: () => void pasteItems() },
    { label: 'Duplicate', hint: '⌘D', onClick: () => void duplicateSelected() },
    ...(splittable ? [{ label: 'Split at the playhead', icon: 'scissors' as const, hint: 'S', onClick: split }] : []),
    'sep',
    { label: refs.length > 1 ? `Delete ${refs.length} items` : 'Delete', icon: 'trash', danger: true, hint: '⌫', onClick: removeSelected },
  ];
}

/** Seconds of the finished video under the playhead (for labels). */
export const playheadOut = () => usePlayback.getState().time;
export const outDurationOf = (p: Project) => timeMapOf(p).outDuration;
