/**
 * Actions on several timeline blocks at once: move them together, nudge them, remove them, and copy,
 * cut, paste or duplicate them. Each is one undoable step.
 *
 * Every block is placed in recording (session) seconds, except music, which sits on the finished video
 * (output seconds). Here music is converted through the time map so a group keeps its shape on screen.
 */
import { fitMusicClip, musicClipsOf, soundsOf, uid, withMusic, writeLane, type EditState, type MusicClip, type Project, type Range, type SoundEffect, type TimeMap } from '@cutaway/core';
import { selectedItems, timeMapOf, useApp, usePlayback, type ItemRef } from '../../state/store';

const app = () => useApp.getState();

type BlockLane = 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll' | 'masks';
const LANE: Record<Exclude<ItemRef['kind'], 'music' | 'sound'>, BlockLane> = { speed: 'speeds', layout: 'layouts', zoom: 'zooms', overlay: 'overlays', broll: 'broll', mask: 'masks' };
/** Lanes on which blocks never overlap: a block moved or pasted onto another trims it. */
const NO_OVERLAP = new Set<BlockLane>(['speeds', 'layouts', 'zooms', 'broll']);

type Block = Range & { id: string; meta: { origin: string; revision: number } };

/** Where a block sits on the timeline, in recording seconds. */
export function itemRange(e: EditState, p: Project, map: TimeMap, ref: ItemRef): Range | null {
  if (ref.kind === 'music') {
    const c = musicClipsOf(e, p.sources).find((x) => x.id === ref.id);
    return c ? { start: map.toSource(c.start), end: c.start + c.length >= map.outDuration - 1e-3 ? p.duration : map.toSource(c.start + c.length) } : null;
  }
  if (ref.kind === 'sound') return soundsOf(e).find((x) => x.id === ref.id) ?? null;
  return ((e[LANE[ref.kind]] as Block[]).find((x) => x.id === ref.id) as Range | undefined) ?? null;
}

const creator = <T extends { meta: object }>(x: T, revision: number): T => ({ ...x, meta: { ...x.meta, origin: 'creator', revision } });

function putOnLane(items: Block[], add: Block[], lane: BlockLane): Block[] {
  if (!NO_OVERLAP.has(lane)) return [...items, ...add].sort((a, b) => a.start - b.start);
  return add.reduce((acc, b) => writeLane(acc, b), items);
}

/**
 * Move blocks together by `delta` recording seconds. The move is shortened so none of them leaves the
 * timeline. Returns how far they actually moved.
 */
export function shiftItems(refs: ItemRef[], delta: number, label: string, coalesceKey?: string): number {
  let moved = 0;
  app().edit((e, p) => {
    const map = timeMapOf(p);
    let d = delta;
    for (const r of refs) {
      const rg = itemRange(e, p, map, r);
      if (!rg) continue;
      d = Math.min(Math.max(d, -rg.start), p.duration - rg.end);
    }
    if (Math.abs(d) < 1e-6) return e;
    moved = d;
    const rev = p.revision + 1;
    let next: EditState = { ...e };
    for (const [kind, lane] of Object.entries(LANE) as [ItemRef['kind'], BlockLane][]) {
      const ids = new Set(refs.filter((r) => r.kind === kind).map((r) => r.id));
      if (!ids.size) continue;
      const items = next[lane] as Block[];
      const shifted = items.filter((x) => ids.has(x.id)).map((x) => creator({ ...x, start: x.start + d, end: x.end + d }, rev));
      next = { ...next, [lane]: putOnLane(items.filter((x) => !ids.has(x.id)), shifted, lane) };
    }
    const music = new Set(refs.filter((r) => r.kind === 'music').map((r) => r.id));
    if (music.size)
      next = withMusic(
        next,
        musicClipsOf(next, p.sources).map((c) => (music.has(c.id) ? creator({ ...c, start: Math.max(0, map.toOutput(Math.min(p.duration, Math.max(0, map.toSource(c.start) + d)))) }, rev) : c)),
      );
    const sounds = new Set(refs.filter((r) => r.kind === 'sound').map((r) => r.id));
    if (sounds.size) next = { ...next, sounds: soundsOf(next).map((s) => (sounds.has(s.id) ? creator({ ...s, start: s.start + d, end: s.end + d }, rev) : s)) };
    return next;
  }, label, coalesceKey);
  return moved;
}

/** Nudge the selected blocks. False when nothing that can move is selected. */
export function nudgeSelected(seconds: number): boolean {
  const refs = selectedItems(app());
  if (!refs.length) return false;
  shiftItems(refs, seconds, refs.length > 1 ? `Nudge ${refs.length} blocks` : 'Nudge', `nudge:${refs.map((r) => r.id).join(',')}`);
  return true;
}

export function removeItems(refs: ItemRef[]) {
  if (!refs.length) return;
  app().edit((e, p) => {
    let next: EditState = { ...e };
    for (const [kind, lane] of Object.entries(LANE) as [ItemRef['kind'], BlockLane][]) {
      const ids = new Set(refs.filter((r) => r.kind === kind).map((r) => r.id));
      if (ids.size) next = { ...next, [lane]: (next[lane] as Block[]).filter((x) => !ids.has(x.id)) };
    }
    const music = new Set(refs.filter((r) => r.kind === 'music').map((r) => r.id));
    if (music.size) next = withMusic(next, musicClipsOf(next, p.sources).filter((c) => !music.has(c.id)));
    const sounds = new Set(refs.filter((r) => r.kind === 'sound').map((r) => r.id));
    if (sounds.size) next = { ...next, sounds: soundsOf(next).filter((s) => !sounds.has(s.id)) };
    return next;
  }, refs.length > 1 ? `Remove ${refs.length} blocks` : 'Remove');
  app().select(null);
}

// ───────────────────────────── clipboard ─────────────────────────────

/** What is copied: each block as it was, and where it sat (recording seconds). */
export interface Copied {
  kind: ItemRef['kind'];
  item: Block | MusicClip | SoundEffect;
  start: number;
  end: number;
}

export const CLIPBOARD_TYPE = 'application/x-cutaway-blocks';
let clipboard: Copied[] = [];

/** The blocks as copied. `remember` = false leaves the clipboard as it was (duplicate). */
export function copyItems(refs: ItemRef[], remember = true): Copied[] {
  const p = app().project;
  if (!p) return [];
  const map = timeMapOf(p);
  const out: Copied[] = [];
  for (const r of refs) {
    const rg = itemRange(p.edit, p, map, r);
    const item = r.kind === 'music' ? musicClipsOf(p.edit, p.sources).find((c) => c.id === r.id) : r.kind === 'sound' ? soundsOf(p.edit).find((s) => s.id === r.id) : (p.edit[LANE[r.kind]] as Block[]).find((x) => x.id === r.id);
    if (rg && item) out.push({ kind: r.kind, item: structuredClone(item), start: rg.start, end: rg.end });
  }
  out.sort((a, b) => a.start - b.start);
  if (out.length && remember) clipboard = out;
  return out;
}

export const hasCopied = () => clipboard.length > 0;
export function setCopied(items: Copied[]) {
  if (items.length) clipboard = items;
}

/**
 * Paste copied blocks so the earliest starts at `at` (recording seconds; the playhead when not given),
 * keeping their spacing. Blocks that would start past the end are left out, ones that run past it are
 * shortened, and ones whose file is no longer in the project are skipped. The pasted blocks are selected.
 */
export function pasteItems(items: Copied[] = clipboard, at?: number): number {
  const p0 = app().project;
  if (!p0 || !items.length) return 0;
  const t0 = at ?? timeMapOf(p0).toSource(usePlayback.getState().time);
  const anchor = Math.min(...items.map((c) => c.start));
  const made: ItemRef[] = [];
  app().edit((e, p) => {
    const map = timeMapOf(p);
    const rev = p.revision + 1;
    const has = (id: string | undefined) => !!id && p.sources.some((s) => s.id === id);
    let next: EditState = { ...e };
    const add: Partial<Record<BlockLane, Block[]>> = {};
    const music: MusicClip[] = [];
    const sounds: SoundEffect[] = [];
    for (const c of items) {
      const start = t0 + (c.start - anchor);
      const end = Math.min(p.duration, t0 + (c.end - anchor));
      if (start >= p.duration - 0.1 || end - start < 0.1) continue;
      const prefix = c.item.id.split('_')[0] || c.kind;
      if (c.kind === 'music') {
        const m = c.item as MusicClip;
        if (!has(m.sourceId)) continue;
        const outStart = map.toOutput(start);
        const fit = fitMusicClip(creator({ ...m, id: uid('mus'), start: outStart }, rev), p.sources.find((s) => s.id === m.sourceId));
        music.push(fit);
        made.push({ kind: 'music', id: fit.id });
      } else if (c.kind === 'sound') {
        const s = c.item as SoundEffect;
        if (!s.builtin && !has(s.sourceId)) continue;
        const id = uid('sfx');
        sounds.push(creator({ ...s, id, start, end: start + (s.end - s.start) }, rev));
        made.push({ kind: 'sound', id });
      } else {
        const b = c.item as Block & { assetId?: string };
        if (c.kind === 'broll' && !has(b.assetId)) continue;
        const id = uid(prefix);
        const lane = LANE[c.kind];
        (add[lane] ??= []).push(creator({ ...b, id, start, end }, rev));
        made.push({ kind: c.kind, id });
      }
    }
    for (const [lane, blocks] of Object.entries(add) as [BlockLane, Block[]][]) next = { ...next, [lane]: putOnLane(next[lane] as Block[], blocks, lane) };
    if (music.length) next = withMusic(next, [...musicClipsOf(next, p.sources), ...music]);
    if (sounds.length) next = { ...next, sounds: [...soundsOf(next), ...sounds] };
    return next;
  }, items.length > 1 ? `Paste ${items.length} blocks` : 'Paste');
  // a pasted block may have trimmed another away entirely: select only what is there
  const p = app().project!;
  const map = timeMapOf(p);
  const present = made.filter((r) => itemRange(p.edit, p, map, r));
  app().selectMany(present);
  if (present.length < items.length) app().toast(present.length ? `Pasted ${present.length} of ${items.length}: the rest would start past the end of the video or play a file that is no longer here.` : 'Nothing to paste here: the blocks would start past the end of the video.');
  return present.length;
}

/** Copies the selected blocks and places the copy right after them. */
export function duplicateSelected(): number {
  const refs = selectedItems(app());
  const copied = copyItems(refs, false);
  if (!copied.length) return 0;
  return pasteItems(copied, Math.max(...copied.map((c) => c.end)));
}
