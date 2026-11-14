/**
 * Editor actions on clips. Each is one undoable step. The model code is in
 * core/clips.ts; this file only adds what the editor needs around it: where
 * the playhead goes, what is selected afterwards, and what the creator is told.
 */
import { clipAt, clipsOf, mapTime, moveClip, playingClips, putBackClip, removeClip, renameClip, sessionMap, setClipLayout, splitClip, trimClip, type LayoutMode, type Project } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, readOnly } from '../../state/store';

const app = () => useApp.getState();

/** Session time under the playhead. */
const playhead = (p: Project) => timeMapOf(p).toSource(usePlayback.getState().time);

/** Keep the playhead on the same footage after the clips were re-laid. */
function follow(before: Project, t: number) {
  const after = app().project;
  if (!after || after === before) return;
  const moved = mapTime(sessionMap(clipsOf(before), clipsOf(after)), t);
  if (moved === null) return;
  usePlayback.getState().seek(timeMapOf(after).toOutput(Math.min(moved, Math.max(0, after.duration - 1e-3))));
}

/** Move a clip to a position among the playing clips (0 = first). */
export function moveClipTo(id: string, index: number): boolean {
  const p = app().project;
  if (!p || readOnly(app())) return false;
  const t = playhead(p);
  const name = clipsOf(p).find((c) => c.id === id)?.name ?? 'clip';
  app().edit((_e, q) => moveClip(q, id, index), `Move “${name}”`);
  follow(p, t);
  return app().project !== p;
}

/** Split the clip under the playhead in two. False when the playhead is too close to an edge. */
export function splitClipAtPlayhead(project: Project): boolean {
  if (readOnly(app())) return false;
  const t = playhead(project);
  const next = splitClip(project, t);
  if (!next) return false;
  app().edit((_e, q) => splitClip(q, t) ?? q.edit, 'Split clip');
  const after = app().project;
  const second = after ? clipAt(clipsOf(after), t + 1e-3) : null;
  if (second) app().select({ kind: 'clip', id: second.id });
  return true;
}

export function removeClipById(id: string): boolean {
  const p = app().project;
  if (!p || readOnly(app())) return false;
  const clips = clipsOf(p);
  const c = clips.find((x) => x.id === id && !x.removed);
  if (!c) return false;
  if (playingClips(clips).length < 2) {
    app().toast('This is the only clip on the timeline, so it stays. To remove part of it, mark a range with I and O, then press X.');
    return false;
  }
  const t = playhead(p);
  app().edit((_e, q) => removeClip(q, id), `Remove “${c.name}”`);
  app().select(null);
  follow(p, t >= c.start && t < c.start + (c.out - c.in) ? Math.max(0, c.start - 1e-3) : t);
  app().toast(`“${c.name}” is off the timeline. Its footage and edits are kept: undo, or put it back from the clip panel or Sources.`);
  return true;
}

export function putBackClipById(id: string, index?: number) {
  const p = app().project;
  if (!p || readOnly(app())) return;
  const t = playhead(p);
  app().edit((_e, q) => putBackClip(q, id, index), 'Put clip back');
  follow(p, t);
  app().select({ kind: 'clip', id });
}

export function renameClipTo(id: string, name: string) {
  app().edit((_e, q) => renameClip(q, id, name), 'Rename clip', `clip-name:${id}`);
}

export function setClipView(id: string, mode: LayoutMode | undefined) {
  app().edit((_e, q) => setClipLayout(q, id, mode), 'Clip view');
}

/** Trim a clip's start or end to `seconds` (0 = nothing trimmed). Drags coalesce into one undo step. */
export function trimClipTo(id: string, side: 'head' | 'tail', seconds: number) {
  app().edit((_e, q) => trimClip(q, id, side, seconds), side === 'head' ? 'Trim clip start' : 'Trim clip end', `clip-trim:${id}:${side}`);
}
