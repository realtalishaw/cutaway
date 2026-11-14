import { describe, expect, it } from 'vitest';
import {
  MAIN_TAKE,
  SESSION_LANES,
  TimeMap,
  addTakeAsClip,
  buildCues,
  chaptersToOutput,
  checkpoint,
  clipAt,
  clipEnd,
  clipInfos,
  clipKept,
  clipRuns,
  clipTrim,
  clipsOf,
  commitEdit,
  coverage,
  createProject,
  defaultSync,
  dropTake,
  projectOfTake,
  flagsOf,
  isMasterVoice,
  manualCut,
  mapRange,
  mapTime,
  moveClip,
  playingClips,
  projectAtCheckpoint,
  putBackClip,
  removeClip,
  renameClip,
  resolveLayout,
  restoreRevision,
  sessionMap,
  sourceAt,
  splitClip,
  stageKey,
  trackOf,
  trimClip,
  validateOps,
  withSources,
  type EditState,
  type MediaSource,
  type Project,
  type Word,
} from '../src';

function src(id: string, role: MediaSource['role'], duration: number, extra: Partial<MediaSource> = {}): MediaSource {
  return {
    id,
    role,
    name: `${id}.mov`,
    path: `/tmp/${id}.mov`,
    managed: false,
    origin: 'import',
    kind: role === 'voice' ? 'audio' : 'video',
    duration,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    fingerprint: { sizeBytes: 1000, duration },
    available: true,
    cursorBaked: true,
    sync: defaultSync('reference'),
    gaps: [],
    ...extra,
  };
}

const word = (id: string, text: string, start: number): Word => ({ id, text, start, end: start + 0.4, kind: 'word' });
const meta = { origin: 'creator' as const, revision: 1 };

/** Take one: a 20 s screen recording with camera A. Words every 2 s. */
function oneTake(): Project {
  let p = createProject('Clips', []);
  p = withSources(p, [src('scr1', 'screen', 20), src('cam1', 'cameraA', 22, { sync: { ...defaultSync('reference'), offset: 0.5 } })]);
  const words = Array.from({ length: 10 }, (_, i) => word(`a${i}`, `one${i}`, i * 2 + 0.2));
  return {
    ...p,
    transcript: { engine: 't', locale: 'en-US', onDevice: true, sourceId: 'cam1', hasSpeech: true, words, generatedAt: '' },
    analysis: { silences: [{ start: 5, end: 6 }], activity: Array.from({ length: 81 }, (_, i) => i), activityHz: 4, clicks: [{ t: 3, x: 0.5, y: 0.5 }], waveform: Array.from({ length: 401 }, (_, i) => i), waveformHz: 20, computedAt: '' },
    flags: [{ id: 'f1', t: 4, takeId: 'take-1' }],
  };
}

/** Adds a second take: 10 s of camera only, with its own words at 1 s and 5 s (take time) and a flag at 2 s. */
function twoTakes(): Project {
  const p = addTakeAsClip(oneTake(), { take: 't2', name: 'Talking head', sources: [src('cam2', 'cameraA', 10)], baseLayout: 'camera', flags: [2] });
  // what transcription and analysis would add for the new clip
  return {
    ...p,
    transcript: { ...p.transcript!, words: [...p.transcript!.words, word('b0', 'two0', 21), word('b1', 'two1', 25)] },
    analysis: { ...p.analysis!, silences: [...p.analysis!.silences, { start: 22, end: 23 }], activity: Array.from({ length: 121 }, (_, i) => i), waveform: Array.from({ length: 601 }, (_, i) => i) },
  };
}

function withLanes(p: Project): Project {
  const edit: EditState = {
    ...p.edit,
    cuts: [{ id: 'c1', start: 1, end: 2, kind: 'manual', meta }, { id: 'c2', start: 24, end: 24.5, kind: 'manual', meta }],
    keeps: [{ start: 8, end: 9 }],
    speeds: [{ id: 's1', start: 10, end: 12, speed: 2, meta }],
    layouts: [{ id: 'l1', start: 3, end: 6, mode: 'screen', camera: 'A', transition: 'smooth', meta }],
    zooms: [{ id: 'z1', start: 13, end: 15, scale: 2, follow: false, x: 0.5, y: 0.5, meta }],
    overlays: [{ id: 'o1', kind: 'callout', text: 'second', start: 26, end: 28, x: 0.5, y: 0.5, meta }],
    broll: [{ id: 'b1', assetId: 'asset', start: 7, end: 7.9, assetIn: 0, fit: 'cover', useAssetAudio: false, meta }],
    masks: [{ id: 'm1', start: 16, end: 17, target: 'screen', rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, style: 'blur', meta }],
    locks: [{ id: 'k1', start: 18, end: 19, note: 'keep', createdAt: '' }],
    suggestions: [{ id: 'g1', kind: 'cut', start: 27, end: 28, title: 't', reason: 'r', confidence: 'low', status: 'open', apply: [{ op: 'cut', start: 27, end: 28, kind: 'pacing' }], revision: 1 }],
    sounds: [{ id: 'x1', start: 21, end: 21.5, builtin: 'pop', gain: 1, meta }],
  };
  return commitEdit(p, edit);
}

/** Numbers to the microsecond: re-laying adds and subtracts offsets, which may differ in the last bit. */
const norm = <T,>(x: T): T => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))) as T;

const starts = (p: Project, lane: string) => ((p.edit as unknown as Record<string, { start: number }[]>)[lane] ?? []).map((x) => +x.start.toFixed(3));

describe('clips: the model', () => {
  it('a project saved before clips existed is one clip, and nothing about it changes', () => {
    const p = oneTake();
    expect(p.edit.clips).toBeUndefined();
    const clips = clipsOf(p);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ id: MAIN_TAKE, take: MAIN_TAKE, start: 0, in: 0, out: 20 });
    expect(clipsOf(p)).toBe(clips); // stable while the edit is
    expect(p.sources.every((s) => !s.window && !s.shift && !s.take)).toBe(true);
    expect(sourceAt(p, 'screen', 7)?.id).toBe('scr1');
  });

  it('new footage becomes a clip at the end, placed on the session timeline', () => {
    const p = twoTakes();
    expect(playingClips(clipsOf(p)).map((c) => [c.name, c.start, clipEnd(c)])).toEqual([['Clip 1', 0, 20], ['Talking head', 20, 30]]);
    expect(p.duration).toBe(30);
    const cam2 = p.sources.find((s) => s.id === 'cam2')!;
    expect(cam2).toMatchObject({ take: 't2', shift: 20, window: { start: 20, end: 30 } });
    expect(cam2.sync.offset).toBe(20);
    expect(coverage(cam2)).toEqual([{ start: 20, end: 30 }]);
    // the first take's camera ran past its screen recording; it must not spill into the next clip
    expect(coverage(p.sources.find((s) => s.id === 'cam1')!)).toEqual([{ start: 0.5, end: 20 }]);
    // flags come in on the take's clock and land in the clip
    expect(flagsOf(p).map((f) => f.t)).toEqual([4, 22]);
    expect(clipInfos(p).map((c) => c.roles)).toEqual([['screen', 'cameraA'], ['cameraA']]);
  });

  it('each clip answers for its own sources and its own view', () => {
    const p = twoTakes();
    expect(sourceAt(p, 'screen', 5)?.id).toBe('scr1');
    expect(sourceAt(p, 'screen', 25)).toBeUndefined();
    expect(sourceAt(p, 'cameraA', 5)?.id).toBe('cam1');
    expect(sourceAt(p, 'cameraA', 25)?.id).toBe('cam2');
    expect(sourceAt(p, 'cameraA', 30)?.id).toBe('cam2'); // the very end of the video
    expect(resolveLayout(p, 5)).toMatchObject({ mode: 'overlay', unresolved: false });
    expect(resolveLayout(p, 25)).toMatchObject({ mode: 'camera', camera: 'A', unresolved: false, fellBack: false });
  });

  it('each footage group has its own audible voice', () => {
    const p = twoTakes();
    const cam1 = p.sources.find((s) => s.id === 'cam1')!;
    const cam2 = p.sources.find((s) => s.id === 'cam2')!;
    expect(p.edit.audio.masterVoiceId).toBe('cam1');
    expect(p.edit.audio.takeVoices).toEqual({ t2: 'cam2' });
    expect(isMasterVoice(p.edit.audio, cam1) && isMasterVoice(p.edit.audio, cam2)).toBe(true);
    expect(trackOf(p.edit.audio, cam2)).toEqual({ gain: 1, muted: false });
    expect(trackOf(p.edit.audio, p.sources.find((s) => s.id === 'scr1')!)?.muted).toBe(true);
  });
});

describe('clips: reorder', () => {
  it('maps session time piece by piece', () => {
    const p = twoTakes();
    const from = clipsOf(p);
    const to = moveClip(p, 't2', 0).clips!;
    const map = sessionMap(from, to);
    expect(mapTime(map, 0)).toBe(10);
    expect(mapTime(map, 19.5)).toBe(29.5);
    expect(mapTime(map, 20)).toBe(0);
    expect(mapTime(map, 30)).toBe(10); // the end of the last stretch
    expect(mapRange(map, { start: 18, end: 22 })).toEqual([{ start: 28, end: 30 }, { start: 0, end: 2 }]);
  });

  it('moving a clip carries every session-time lane with it', () => {
    const p = withLanes(twoTakes());
    const moved = commitEdit(p, moveClip(p, 't2', 0));
    expect(playingClips(clipsOf(moved)).map((c) => [c.id, c.start])).toEqual([['t2', 0], [MAIN_TAKE, 10]]);
    // every lane in the list was exercised by the fixture, and every item moved by its clip's shift
    for (const lane of SESSION_LANES) expect(starts(p, lane).length, lane).toBeGreaterThan(0);
    expect(starts(moved, 'cuts')).toEqual([4, 11]);
    expect(starts(moved, 'keeps')).toEqual([18]);
    expect(starts(moved, 'speeds')).toEqual([20]);
    expect(starts(moved, 'layouts')).toEqual([13]);
    expect(starts(moved, 'zooms')).toEqual([23]);
    expect(starts(moved, 'overlays')).toEqual([6]);
    expect(starts(moved, 'broll')).toEqual([17]);
    expect(starts(moved, 'masks')).toEqual([26]);
    expect(starts(moved, 'locks')).toEqual([28]);
    expect(starts(moved, 'suggestions')).toEqual([7]);
    expect(moved.edit.suggestions[0]!.apply[0]).toMatchObject({ start: 7, end: 8 });
    expect(starts(moved, 'sounds')).toEqual([1]);
  });

  it('and everything outside the edit: sources, words, analysis, flags, chapters, chat', () => {
    let p = withLanes(twoTakes());
    p = { ...p, packaging: { ...p.packaging, chapters: [{ sessionTime: 0, title: 'Start' }, { sessionTime: 21, title: 'Second' }] }, chat: [{ id: 'm1', role: 'assistant', text: '', at: '', scope: { start: 20, end: 30 }, moments: [{ start: 25, end: 26, note: 'n' }], items: [{ id: 'i1', kind: 'add', op: { op: 'cut', start: 22, end: 23, kind: 'pacing' }, range: { start: 22, end: 23 }, what: '', why: '', status: 'open' }] }] };
    const moved = commitEdit(p, moveClip(p, 't2', 0));
    expect(moved.duration).toBe(30);
    expect(moved.sources.find((s) => s.id === 'scr1')).toMatchObject({ shift: 10, window: { start: 10, end: 30 } });
    expect(moved.sources.find((s) => s.id === 'scr1')!.sync.offset).toBe(10);
    expect(moved.sources.find((s) => s.id === 'cam1')!.sync.offset).toBe(10.5);
    expect(moved.sources.find((s) => s.id === 'cam2')).toMatchObject({ shift: 0, window: { start: 0, end: 10 } });
    expect(moved.transcript!.words.map((w) => w.text).slice(0, 4)).toEqual(['two0', 'two1', 'one0', 'one1']);
    expect(moved.transcript!.words.find((w) => w.id === 'a3')!.start).toBeCloseTo(16.2);
    expect(moved.analysis!.silences).toEqual([{ start: 2, end: 3 }, { start: 15, end: 16 }]);
    expect(moved.analysis!.clicks[0]!.t).toBe(13);
    // sample i of the old array described session second i / hz; it must describe the same footage after the move
    expect(moved.analysis!.activity[0]).toBe(80);
    expect(moved.analysis!.activity[40]).toBe(0);
    expect(moved.analysis!.waveform[200 + 20]).toBe(20);
    expect(flagsOf(moved).map((f) => f.t)).toEqual([2, 14]);
    expect(moved.packaging.chapters.map((c) => c.sessionTime)).toEqual([10, 1]);
    expect(moved.chat![0]).toMatchObject({ scope: { start: 0, end: 10 }, moments: [{ start: 5, end: 6 }], items: [{ range: { start: 2, end: 3 }, op: { start: 2, end: 3 } }] });
    // moving a clip is not a reason to transcribe or analyse again
    expect(stageKey(moved, 'transcribe')).toBe(stageKey(p, 'transcribe'));
  });

  it('undo (putting the earlier edit back) restores the project exactly', () => {
    const p = withLanes(twoTakes());
    const moved = commitEdit(p, moveClip(p, 't2', 0));
    const back = commitEdit(moved, p.edit);
    expect(norm(back.sources)).toEqual(norm(p.sources));
    expect(norm(back.transcript)).toEqual(norm(p.transcript));
    expect(norm(back.analysis)).toEqual(norm(p.analysis));
    expect(norm(back.flags)).toEqual(norm(p.flags));
    expect(back.duration).toBe(p.duration);
    expect(back.edit).toBe(p.edit);
  });

  it('the finished video plays the clips in their new order: time map, captions, chapters', () => {
    const p = withLanes(twoTakes());
    const moved = commitEdit({ ...p, packaging: { ...p.packaging, chapters: [{ sessionTime: 0, title: 'Screen part' }, { sessionTime: 20, title: 'Camera part' }] } }, moveClip(p, 't2', 0));
    const map = TimeMap.fromEdit(moved.duration, moved.edit);
    // 30 s of footage, minus 1 s and 0.5 s of cuts, minus 1 s saved by the 2× stretch
    expect(map.outDuration).toBeCloseTo(27.5);
    const cues = buildCues(moved.transcript, moved.edit, map);
    expect(cues[0]!.text.startsWith('two0')).toBe(true);
    expect(cues.map((c) => c.start)).toEqual([...cues.map((c) => c.start)].sort((a, b) => a - b));
    expect(chaptersToOutput(moved.packaging.chapters, map).map((c) => c.title)).toEqual(['Camera part', 'Screen part']);
  });

  it('an earlier version is shown, and restored, in its own clip order', () => {
    let p = checkpoint(withLanes(twoTakes()), 'Before moving', 'creator');
    const rev = p.revision;
    p = commitEdit(p, moveClip(p, 't2', 0));
    const view = projectAtCheckpoint(p, rev)!;
    expect(playingClips(clipsOf(view)).map((c) => c.id)).toEqual([MAIN_TAKE, 't2']);
    expect(view.sources.find((s) => s.id === 'cam2')!.sync.offset).toBe(20);
    expect(view.transcript!.words[0]!.text).toBe('one0');
    expect(starts(view, 'overlays')).toEqual([26]);
    // looking changes nothing
    expect(p.sources.find((s) => s.id === 'cam2')!.sync.offset).toBe(0);
    const restored = restoreRevision(p, rev);
    expect(playingClips(clipsOf(restored)).map((c) => c.id)).toEqual([MAIN_TAKE, 't2']);
    expect(restored.transcript!.words[0]!.text).toBe('one0');
  });

  it('a version saved before the second clip existed keeps the new footage, after its own', () => {
    let p = checkpoint(oneTake(), 'One clip', 'creator');
    const rev = p.revision;
    p = commitEdit(p, manualCut(p.edit, { start: 1, end: 2 }, p.revision + 1));
    p = addTakeAsClip(p, { take: 't2', name: 'Later', sources: [src('cam2', 'cameraA', 10)] });
    p = commitEdit(p, moveClip(p, 't2', 0));
    const restored = restoreRevision(p, rev);
    expect(playingClips(clipsOf(restored)).map((c) => [c.take, c.start])).toEqual([[MAIN_TAKE, 0], ['t2', 20]]);
    expect(restored.edit.cuts).toEqual([]);
    expect(restored.sources.find((s) => s.id === 'cam2')!.sync.offset).toBe(20);
  });
});

describe('clips: split, trim, remove', () => {
  it('a split changes nothing until the halves are moved apart', () => {
    const p = withLanes(twoTakes());
    const split = commitEdit(p, splitClip(p, 8)!);
    expect(playingClips(clipsOf(split)).map((c) => [c.take, c.start, c.in, c.out])).toEqual([[MAIN_TAKE, 0, 0, 8], [MAIN_TAKE, 8, 8, 20], ['t2', 20, 0, 10]]);
    expect(clipRuns(clipsOf(split)).map((r) => [r.take, r.start, r.end])).toEqual([[MAIN_TAKE, 0, 20], ['t2', 20, 30]]);
    expect(split.sources).toEqual(p.sources);
    expect(split.transcript).toBe(p.transcript);
    expect(splitClip(p, 0.05)).toBeNull();
    expect(splitClip(p, 19.95)).toBeNull();
  });

  it('halves that sit apart each get their own placement of the files; back together, one', () => {
    const p = twoTakes();
    const split = commitEdit(p, splitClip(p, 8)!);
    const secondHalf = clipsOf(split)[1]!;
    const apart = commitEdit(split, moveClip(split, secondHalf.id, 2));
    expect(playingClips(clipsOf(apart)).map((c) => [c.take, c.start, c.in])).toEqual([[MAIN_TAKE, 0, 0], ['t2', 8, 0], [MAIN_TAKE, 18, 8]]);
    const placements = apart.sources.filter((s) => s.role === 'screen');
    expect(placements.map((s) => [s.id, s.instanceOf ?? null, s.shift, s.window])).toEqual([
      ['scr1', null, 0, { start: 0, end: 8 }],
      [`scr1~${secondHalf.id}`, 'scr1', 10, { start: 18, end: 30 }],
    ]);
    expect(sourceAt(apart, 'screen', 4)?.id).toBe('scr1');
    expect(sourceAt(apart, 'screen', 10)).toBeUndefined();
    expect(sourceAt(apart, 'screen', 20)?.id).toBe(`scr1~${secondHalf.id}`);
    // the second placement plays the same file from where the first half stopped
    const inst = placements[1]!;
    expect((18 - inst.sync.offset) * inst.sync.rate).toBeCloseTo(8);
    expect(trackOf(apart.edit.audio, apart.sources.find((s) => s.id === `cam1~${secondHalf.id}`)!)).toEqual(trackOf(apart.edit.audio, apart.sources.find((s) => s.id === 'cam1')!));
    expect(isMasterVoice(apart.edit.audio, apart.sources.find((s) => s.id === `cam1~${secondHalf.id}`)!)).toBe(true);
    // words follow their half
    expect(apart.transcript!.words.find((w) => w.id === 'a5')!.start).toBeCloseTo(20.2);
    expect(apart.transcript!.words.find((w) => w.id === 'b0')!.start).toBeCloseTo(9);
    const together = commitEdit(apart, moveClip(apart, secondHalf.id, 1));
    expect(together.sources.filter((s) => s.instanceOf)).toEqual([]);
    expect(norm(together.sources)).toEqual(norm(split.sources));
    expect(norm(together.transcript)).toEqual(norm(split.transcript));
  });

  it('a decision that spans a split is cut in two only when the halves part', () => {
    let p = twoTakes();
    p = commitEdit(p, { ...p.edit, zooms: [{ id: 'z', start: 6, end: 10, scale: 2, follow: false, x: 0.5, y: 0.5, meta }] });
    const split = commitEdit(p, splitClip(p, 8)!);
    expect(split.edit.zooms).toHaveLength(1);
    const second = clipsOf(split)[1]!;
    const apart = commitEdit(split, moveClip(split, second.id, 2));
    expect(apart.edit.zooms.map((z) => [z.id, z.start, z.end])).toEqual([['z', 6, 8], ['z~2', 18, 20]]);
  });

  it('trimming is a cut on the clip edge: restorable, and nothing else moves', () => {
    const p = withLanes(twoTakes());
    const t2 = clipsOf(p)[1]!;
    let q = commitEdit(p, trimClip(p, 't2', 'head', 1.5));
    q = commitEdit(q, trimClip(q, 't2', 'tail', 2));
    expect(clipTrim(q.edit, clipsOf(q)[1]!)).toEqual({ head: 1.5, tail: 2 });
    expect(clipKept(q.edit, clipsOf(q)[1]!)).toEqual({ start: 21.5, end: 28 });
    expect(clipsOf(q)[1]).toMatchObject({ start: t2.start, in: 0, out: 10 });
    expect(starts(q, 'overlays')).toEqual([26]);
    expect(TimeMap.fromEdit(q.duration, q.edit).outDuration).toBeCloseTo(TimeMap.fromEdit(p.duration, p.edit).outDuration - 3.5);
    // dragging the handle again replaces the trim, and back to zero restores the footage
    q = commitEdit(q, trimClip(q, 't2', 'head', 0.5));
    expect(clipTrim(q.edit, clipsOf(q)[1]!)).toEqual({ head: 0.5, tail: 2 });
    q = commitEdit(q, trimClip(commitEdit(q, trimClip(q, 't2', 'head', 0)), 't2', 'tail', 0));
    expect(q.edit.cuts.map((c) => c.id)).toEqual(p.edit.cuts.map((c) => c.id));
    // a clip can never be trimmed to nothing
    const all = commitEdit(p, trimClip(p, 't2', 'head', 99));
    expect(clipTrim(all.edit, clipsOf(all)[1]!).head).toBeCloseTo(9.8);
  });

  it('removing a clip takes it off the timeline with its decisions; putting it back restores them', () => {
    const p = withLanes(twoTakes());
    const removed = commitEdit(p, removeClip(p, MAIN_TAKE));
    expect(removed.duration).toBe(10);
    expect(playingClips(clipsOf(removed)).map((c) => [c.id, c.start])).toEqual([['t2', 0]]);
    expect(clipsOf(removed).find((c) => c.id === MAIN_TAKE)).toMatchObject({ removed: true, start: 10 });
    // only the second clip's decisions are on the lanes now
    expect(starts(removed, 'cuts')).toEqual([4]);
    expect(starts(removed, 'zooms')).toEqual([]);
    expect(starts(removed, 'overlays')).toEqual([6]);
    expect(removed.transcript!.words.map((w) => w.text)).toEqual(['two0', 'two1']);
    expect(removed.transcript!.parked).toHaveLength(10);
    expect(removed.analysis!.silences).toEqual([{ start: 2, end: 3 }]);
    expect(flagsOf(removed).map((f) => f.t)).toEqual([2]);
    // the footage is still in the project, just not in the video
    expect(removed.sources.find((s) => s.id === 'scr1')).toMatchObject({ window: { start: 10, end: 30 } });
    expect(sourceAt(removed, 'screen', 5)).toBeUndefined();
    expect(resolveLayout(removed, 5)).toMatchObject({ mode: 'camera', unresolved: false });
    expect(TimeMap.fromEdit(removed.duration, removed.edit).outDuration).toBeCloseTo(9.5);
    // the last clip cannot be removed
    expect(removeClip(removed, 't2')).toBe(removed.edit);
    const back = commitEdit(removed, putBackClip(removed, MAIN_TAKE, 0));
    expect(back.duration).toBe(30);
    expect(norm(back.sources)).toEqual(norm(p.sources));
    expect(norm(back.transcript)).toEqual(norm(p.transcript));
    expect(norm(back.analysis)).toEqual(norm(p.analysis));
    for (const lane of SESSION_LANES) expect(starts(back, lane), lane).toEqual(starts(p, lane));
    expect(back.edit.suggestions[0]!.apply[0]).toMatchObject({ start: 27, end: 28 });
    // and undo of the removal is exact
    expect(norm(commitEdit(removed, p.edit).transcript)).toEqual(norm(p.transcript));
  });

  it('one take by itself (for a quick render) is the project with the other clips off the timeline', () => {
    const p = withLanes(twoTakes());
    const alone = projectOfTake(p, 't2');
    expect(playingClips(clipsOf(alone)).map((c) => c.id)).toEqual(['t2']);
    expect(alone.duration).toBe(10);
    expect(starts(alone, 'overlays')).toEqual([6]);
    expect(sourceAt(alone, 'cameraA', 3)?.id).toBe('cam2');
    expect(projectOfTake(oneTake(), MAIN_TAKE).edit.clips).toBeUndefined();
    // and taking a footage group out altogether leaves nothing of it behind
    const dropped = dropTake(p, 't2');
    expect(clipsOf(dropped).map((c) => c.id)).toEqual([MAIN_TAKE]);
    expect(dropped.sources.map((s) => s.id)).toEqual(['scr1', 'cam1']);
    expect(dropped.duration).toBe(20);
    expect(dropped.transcript!.words.every((w) => w.text.startsWith('one'))).toBe(true);
    expect(flagsOf(dropped).map((f) => f.t)).toEqual([4]);
    expect(dropped.edit.audio.takeVoices).toBeUndefined();
    expect(starts(dropped, 'overlays')).toEqual([]);
  });

  it('rename', () => {
    const p = twoTakes();
    expect(clipsOf(commitEdit(p, renameClip(p, 't2', '  Outro  ')))[1]!.name).toBe('Outro');
    expect(renameClip(p, 't2', '   ')).toBe(p.edit);
  });

  it('a take whose length changes stretches its last clip and moves what follows', () => {
    const p = withLanes(twoTakes());
    const longer = withSources(p, p.sources.map((s) => (s.id === 'scr1' ? { ...s, duration: 24 } : s)));
    expect(playingClips(clipsOf(longer)).map((c) => [c.start, clipEnd(c)])).toEqual([[0, 24], [24, 34]]);
    expect(longer.duration).toBe(34);
    expect(starts(longer, 'overlays')).toEqual([30]);
    expect(longer.sources.find((s) => s.id === 'cam2')!.sync.offset).toBe(24);
    expect(longer.transcript!.words.find((w) => w.id === 'b0')!.start).toBeCloseTo(25);
  });
});

describe('clips: proposals stay inside one clip', () => {
  it('a removal across a boundary becomes one per clip; a zoom stays in the clip that holds most of it', () => {
    const p = twoTakes();
    const res = validateOps(p, [{ op: 'cut', start: 18.9, end: 20.9, kind: 'manual' }, { op: 'speed', start: 15, end: 25, speed: 2 }], { origin: 'creator' });
    expect(res.accepted.filter((o) => o.op === 'speed').map((o) => [o.start, o.end])).toEqual([[15, 20], [20, 25]]);
    expect(res.accepted.filter((o) => o.op === 'cut').every((o) => o.end <= 20 + 1e-6 || o.start >= 20 - 1e-6)).toBe(true);
    expect(res.adjusted.some((a) => /one clip ends/.test(a.note))).toBe(true);
    const zoom = validateOps(p, [{ op: 'zoom', start: 14, end: 22, scale: 2 }], { origin: 'ai' });
    expect(zoom.accepted.map((o) => [o.start, o.end])).toEqual([[14, 20]]);
    expect(zoom.adjusted[0]!.note).toMatch(/inside one clip/);
  });

  it('nothing needs a screen where the clip has none', () => {
    const p = twoTakes();
    expect(validateOps(p, [{ op: 'zoom', start: 22, end: 26, scale: 2 }], { origin: 'ai' }).rejected[0]!.code).toBe('no-coverage');
    expect(validateOps(p, [{ op: 'layout', start: 22, end: 26, mode: 'screen' }], { origin: 'ai' }).rejected[0]!.code).toBe('no-coverage');
    expect(validateOps(p, [{ op: 'layout', start: 22, end: 26, mode: 'camera' }], { origin: 'ai' }).accepted).toHaveLength(1);
  });

  it('a project that is one clip validates exactly as before', () => {
    const p = oneTake();
    const res = validateOps(p, [{ op: 'zoom', start: 14, end: 19, scale: 2 }, { op: 'speed', start: 2, end: 9, speed: 2 }], { origin: 'ai' });
    expect(res.accepted).toHaveLength(2);
    expect(res.adjusted).toEqual([]);
  });

  it('clipAt', () => {
    const clips = clipsOf(twoTakes());
    expect(clipAt(clips, 0)?.id).toBe(MAIN_TAKE);
    expect(clipAt(clips, 20)?.id).toBe('t2');
    expect(clipAt(clips, 30)?.id).toBe('t2');
    expect(clipAt(clips, 31)).toBeNull();
  });
});
