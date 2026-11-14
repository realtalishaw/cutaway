/** Creator edit actions. Every one is a single undoable step through the store. */
import {
  acceptSuggestion,
  addLock,
  applyOps,
  cameraSource,
  coversRange,
  dismissSuggestion,
  manualCut,
  meta,
  removeById,
  removeMusicClip,
  soundsOf,
  restoreCut,
  restoreRange,
  uid,
  updateById,
  writeLane,
  zoomLevelOf,
  type CameraSlot,
  type EditState,
  type LayoutMode,
  type Mask,
  type GraphicKind,
  type Project,
  type Range,
} from '@cutaway/core';
import { selectedItems, timeMapOf, useApp, usePlayback, type Selection } from '../../state/store';
import { removeItems } from './itemOps';
import { removeClipById } from './clipOps';

type Lane = 'cuts' | 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll' | 'masks' | 'locks' | 'suggestions';
export const LANE_OF: Record<NonNullable<Selection>['kind'], Lane | null> = { cut: 'cuts', speed: 'speeds', layout: 'layouts', zoom: 'zooms', overlay: 'overlays', broll: 'broll', mask: 'masks', lock: 'locks', suggestion: 'suggestions', music: null, sound: null, clip: null, range: null, words: null };

const app = () => useApp.getState();

export function selectedRange(sel: Selection): Range | null {
  if (!sel) return null;
  if (sel.kind === 'range') return sel.range;
  if (sel.kind === 'words') return sel.range;
  return null;
}

/** Session time under the playhead. */
export function playheadSource(project: Project): number {
  return timeMapOf(project).toSource(usePlayback.getState().time);
}

export function seekSource(project: Project, t: number) {
  usePlayback.getState().seek(timeMapOf(project).toOutput(t));
}

export function cutRange(range: Range, kind: 'manual' | 'transcript' = 'manual') {
  const out = usePlayback.getState().time;
  const before = app().project;
  app().edit((e, p) => manualCut(e, range, p.revision + 1, kind), kind === 'transcript' ? 'Cut text' : 'Cut');
  app().select(null);
  app().toast(`Removed ${(range.end - range.start).toFixed(1)}s — ⌘Z to undo`);
  // keep the playhead on the same content where possible
  const p = app().project;
  if (p && before) {
    const src = timeMapOf(before).toSource(out);
    usePlayback.getState().seek(timeMapOf(p).toOutput(src >= range.start && src < range.end ? range.end : src));
  }
}

export function restore(range: Range) {
  app().edit((e) => restoreRange(e, range), 'Restore');
}

export function restoreOne(cutId: string) {
  app().edit((e) => restoreCut(e, cutId), 'Restore cut');
  app().select(null);
}

export function lockRange(range: Range, note = 'Keep this as it is') {
  app().edit((e) => addLock(e, range, note), 'Lock range');
}

export function setSpeed(range: Range, speed: number) {
  app().edit((e, p) => {
    if (Math.abs(speed - 1) < 1e-3) {
      // back to normal speed: carve the range out of the speed lane
      const speeds = e.speeds.flatMap((s) => {
        if (s.end <= range.start || s.start >= range.end) return [s];
        const parts = [];
        if (s.start < range.start - 0.05) parts.push({ ...s, end: range.start });
        if (s.end > range.end + 0.05) parts.push({ ...s, id: uid('spd'), start: range.end });
        return parts;
      });
      return { ...e, speeds };
    }
    return applyOps(e, [{ op: 'speed', start: range.start, end: range.end, speed }], 'creator', p.revision + 1);
  }, `Speed ${speed}×`);
}

export function addZoom(range: Range, x = 0.5, y = 0.5, follow?: boolean) {
  let id = '';
  app().edit((e, p) => {
    const hasCursor = p.sources.some((s) => s.role === 'screen' && !s.cursorBaked && s.cursorFile);
    const next = applyOps(e, [{ op: 'zoom', start: range.start, end: range.end, scale: zoomLevelOf(e.appearance), x, y, follow: follow ?? hasCursor }], 'creator', p.revision + 1);
    id = next.zooms.find((z) => !e.zooms.includes(z) && z.start >= range.start - 1e-3)?.id ?? '';
    return next;
  }, 'Add zoom');
  if (id) app().select({ kind: 'zoom', id });
}

/** Which camera slots can actually be shown across a range. */
export function camerasFor(project: Project, range: Range): CameraSlot[] {
  return (['A', 'B'] as CameraSlot[]).filter((slot) => coversRange(cameraSource(project, slot), range));
}

export function setLayout(range: Range, mode: LayoutMode, camera?: CameraSlot) {
  let id = '';
  app().edit((e, p) => {
    const cam = camera ?? camerasFor(p, range)[0] ?? 'A';
    const next = applyOps(e, [{ op: 'layout', start: range.start, end: range.end, mode, camera: cam, transition: 'smooth' }], 'creator', p.revision + 1);
    id = next.layouts.find((l) => !e.layouts.includes(l) && l.start >= range.start - 1e-3 && l.end <= range.end + 1e-3)?.id ?? '';
    return next;
  }, 'Change view');
  if (id) app().select({ kind: 'layout', id });
}

export function addOverlay(range: Range, kind: GraphicKind, text: string) {
  let id = '';
  app().edit((e, p) => {
    const next = applyOps(e, [{ op: 'overlay', kind, start: range.start, end: Math.min(range.end, range.start + (kind === 'section-card' ? 3 : 6)), text }], 'creator', p.revision + 1);
    id = next.overlays.find((o) => !e.overlays.includes(o))?.id ?? '';
    return next;
  }, 'Add graphic');
  if (id) app().select({ kind: 'overlay', id });
}

export function addBroll(range: Range, assetId: string) {
  let id = '';
  app().edit((e, p) => {
    const asset = p.sources.find((s) => s.id === assetId);
    const length = asset?.kind === 'video' ? Math.min(range.end - range.start, asset.duration) : range.end - range.start;
    const next = applyOps(e, [{ op: 'broll', assetId, start: range.start, end: range.start + length, assetIn: 0 }], 'creator', p.revision + 1);
    id = next.broll.find((b) => !e.broll.includes(b))?.id ?? '';
    return next;
  }, 'Insert B-roll');
  if (id) app().select({ kind: 'broll', id });
}

export function addMask(range: Range, target: Mask['target'], rect = { x: 0.35, y: 0.4, w: 0.3, h: 0.12 }) {
  const id = uid('mask');
  app().edit((e, p) => ({ ...e, masks: [...e.masks, { id, start: range.start, end: range.end, target, rect, style: 'blur' as const, meta: meta('creator', p.revision + 1) }] }), 'Add mask');
  app().select({ kind: 'mask', id });
}

export function patchItem<K extends Lane>(lane: K, id: string, patch: Partial<EditState[K][number]>, label: string, coalesce = true) {
  app().edit((e, p) => updateById(e, lane, id, patch, p.revision + 1), label, coalesce ? `${lane}:${id}:${Object.keys(patch).join(',')}` : undefined);
}

/** Move or resize an item on a non-overlapping lane, carving neighbours. */
export function retime(lane: 'layouts' | 'zooms' | 'broll' | 'speeds', id: string, range: Range, coalesceKey: string) {
  app().edit((e, p) => {
    const item = (e[lane] as (Range & { id: string })[]).find((x) => x.id === id);
    if (!item) return e;
    const moved = { ...item, start: range.start, end: range.end, meta: { ...(item as unknown as { meta: object }).meta, origin: 'creator' as const, revision: p.revision + 1 } };
    const rest = (e[lane] as (Range & { id: string })[]).filter((x) => x.id !== id);
    return { ...e, [lane]: writeLane(rest as never[], moved as never) } as EditState;
  }, 'Retime', coalesceKey);
}

export function removeSelected() {
  const sel = app().selection;
  if (!sel) return;
  const many = selectedItems(app());
  if (many.length > 1) return removeItems(many);
  if (sel.kind === 'range' || sel.kind === 'words') return cutRange(sel.range, sel.kind === 'words' ? 'transcript' : 'manual');
  if (sel.kind === 'cut') return restoreOne(sel.id);
  if (sel.kind === 'clip') return void removeClipById(sel.id);
  if (sel.kind === 'music' || sel.kind === 'sound') {
    app().edit((e, p) => (sel.kind === 'music' ? removeMusicClip(e, p.sources, sel.id) : { ...e, sounds: soundsOf(e).filter((x) => x.id !== sel.id) }), sel.kind === 'music' ? 'Remove music' : 'Remove sound');
    return app().select(null);
  }
  const lane = LANE_OF[sel.kind];
  if (!lane) return;
  if (sel.kind === 'suggestion') app().edit((e) => dismissSuggestion(e, sel.id), 'Dismiss suggestion');
  else app().edit((e) => removeById(e, lane, sel.id), `Remove ${sel.kind}`);
  app().select(null);
}

export function accept(id: string) {
  app().edit((e, p) => acceptSuggestion(e, id, p.revision + 1), 'Accept suggestion');
}

export function dismiss(id: string) {
  app().edit((e) => dismissSuggestion(e, id), 'Dismiss suggestion');
}

export function toggleItemLock(lane: 'layouts' | 'zooms' | 'overlays' | 'broll' | 'cuts', id: string) {
  app().edit((e) => ({ ...e, [lane]: (e[lane] as { id: string; meta: { locked?: boolean } }[]).map((x) => (x.id === id ? { ...x, meta: { ...x.meta, locked: !x.meta.locked } } : x)) }) as EditState, 'Toggle lock');
}

/** Split the selected timed item at the playhead. */
export function splitSelected(project: Project) {
  const sel = app().selection;
  const t = playheadSource(project);
  if (!sel || !['layout', 'zoom', 'broll', 'speed', 'overlay', 'mask'].includes(sel.kind)) return false;
  const lane = LANE_OF[sel.kind] as 'layouts' | 'zooms' | 'broll' | 'speeds' | 'overlays' | 'masks';
  let done = false;
  app().edit((e) => {
    const items = e[lane] as (Range & { id: string })[];
    const it = items.find((x) => x.id === (sel as { id: string }).id);
    // an animation plays from its own start: two halves would both play it from the beginning
    if (!it || (it as { kind?: string }).kind === 'motion' || t <= it.start + 0.2 || t >= it.end - 0.2) return e;
    done = true;
    const right = { ...it, id: uid(it.id.split('_')[0]), start: t, ...(lane === 'broll' ? { assetIn: (it as unknown as { assetIn: number }).assetIn + (t - it.start) } : {}) };
    return { ...e, [lane]: items.flatMap((x) => (x.id === it.id ? [{ ...it, end: t }, right] : [x])) } as EditState;
  }, 'Split');
  return done;
}
