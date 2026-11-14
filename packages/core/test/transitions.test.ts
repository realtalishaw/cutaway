import { describe, expect, it } from 'vitest';
import {
  BROLL_FADE,
  PUNCH,
  TRANSITION,
  TimeMap,
  addTakeAsClip,
  brollFades,
  brollOpacity,
  clipPairs,
  clipsOf,
  commitEdit,
  createProject,
  defaultSync,
  evaluateFrame,
  manualCut,
  maxTransition,
  moveClip,
  placedTransitions,
  playingClips,
  punchCrop,
  punchInOf,
  punchJoins,
  punchScaleAt,
  putBackClip,
  removeClip,
  setAllTransitions,
  setPunchIn,
  setPunchSkipped,
  setTransition,
  splitClip,
  transitionAt,
  transitionBetween,
  transitionGains,
  transitionsOf,
  trimClip,
  withSources,
  type EditState,
  type FaceTrackSmooth,
  type MediaSource,
  type Project,
} from '../src';

function src(id: string, role: MediaSource['role'], duration: number, extra: Partial<MediaSource> = {}): MediaSource {
  return { id, role, name: `${id}.mov`, path: `/tmp/${id}.mov`, managed: false, origin: 'import', kind: 'video', duration, width: 1920, height: 1080, fps: 30, hasAudio: true, fingerprint: { sizeBytes: 1000, duration }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [], ...extra };
}
const meta = { origin: 'creator' as const, revision: 1 };

/** Three camera-only clips: A 0–20, B 20–30, C 30–38. */
function three(): Project {
  let p = createProject('Transitions', []);
  p = withSources(p, [src('camA', 'cameraA', 20)]);
  p = addTakeAsClip(p, { take: 't2', name: 'B', sources: [src('camB', 'cameraA', 10)], baseLayout: 'camera' });
  p = addTakeAsClip(p, { take: 't3', name: 'C', sources: [src('camC', 'cameraA', 8)], baseLayout: 'camera' });
  return p;
}
const ids = (p: Project) => playingClips(clipsOf(p)).map((c) => c.id);
const map = (p: Project) => TimeMap.fromEdit(p.duration, p.edit);
const withEdit = (p: Project, edit: EditState): Project => commitEdit(p, edit);
const ctx = (p: Project, faces?: Partial<Record<'A' | 'B', FaceTrackSmooth | null>>) => ({ project: p, map: map(p), cursor: null, follow: null, screenAspect: null, ...(faces ? { faces } : {}) });

describe('transitions: the model', () => {
  it('sits between two neighbouring clips, and only there', () => {
    const p = three();
    const [a, b, c] = ids(p);
    expect(clipPairs(clipsOf(p)).map((x) => [x.from.id, x.to.id])).toEqual([[a, b], [b, c]]);
    const q = withEdit(p, setTransition(p, a!, b!, 'dissolve', 1));
    expect(transitionBetween(q, a!, b!)).toMatchObject({ kind: 'dissolve', duration: 1 });
    // not neighbours, or the wrong way round: nothing is stored
    expect(setTransition(p, a!, c!, 'dissolve')).toBe(p.edit);
    expect(setTransition(p, b!, a!, 'dissolve')).toBe(p.edit);
    // changing it keeps its identity; clearing removes the list again
    const id = transitionsOf(q.edit)[0]!.id;
    const r = withEdit(q, setTransition(q, a!, b!, 'dip-black', 0.6));
    expect(transitionsOf(r.edit)).toEqual([{ id, from: a, to: b, kind: 'dip-black', duration: 0.6 }]);
    expect(setTransition(r, a!, b!, null).transitions).toBeUndefined();
  });

  it('keeps the wanted length inside its limits, and draws no more than the two clips can give', () => {
    const p = three();
    const [a, b, c] = ids(p);
    expect(setTransition(p, a!, b!, 'dissolve', 9).transitions![0]!.duration).toBe(TRANSITION.max);
    expect(setTransition(p, a!, b!, 'dissolve', 0.01).transitions![0]!.duration).toBe(TRANSITION.min);
    // clip C trimmed down to 0.6 s of playing time: the transition into it cannot be longer than that
    let q = withEdit(p, trimClip(p, c!, 'tail', 7.4));
    q = withEdit(q, setTransition(q, b!, c!, 'dissolve', 2));
    const clips = clipsOf(q);
    expect(maxTransition(map(q), clips[1]!, clips[2]!)).toBeCloseTo(0.6, 3);
    const placed = placedTransitions(q, map(q));
    expect(placed).toHaveLength(1);
    expect(placed[0]!.duration).toBeCloseTo(0.6, 3);
    expect(placed[0]!.start).toBeCloseTo(30 - 0.3, 3);
    expect(placed[0]!.end).toBeCloseTo(30 + 0.3, 3);
  });

  it('never changes the length of the video or moves anything', () => {
    const p = three();
    const [a, b] = ids(p);
    const q = withEdit(p, setAllTransitions(p, 'dissolve', 1.5));
    expect(q.duration).toBe(p.duration);
    expect(map(q).outDuration).toBe(map(p).outDuration);
    expect(q.edit.cuts).toEqual(p.edit.cuts);
    expect(clipsOf(q)).toEqual(clipsOf(p));
    expect(transitionsOf(q.edit).map((t) => [t.from, t.to])).toEqual([[a, b], [b, ids(p)[2]]]);
    expect(setAllTransitions(q, null).transitions).toBeUndefined();
  });

  it('one command sets every clip change, keeping the ids of the ones that were there', () => {
    const p = three();
    const [a, b] = ids(p);
    const q = withEdit(p, setTransition(p, a!, b!, 'dip-white', 0.4));
    const id = transitionsOf(q.edit)[0]!.id;
    const all = setAllTransitions(q, 'dissolve', 0.8).transitions!;
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id, kind: 'dissolve', duration: 0.8 });
  });
});

describe('transitions: what the frame is asked for', () => {
  it('a cross-dissolve is centred on the clip change and blends in the neighbouring clip', () => {
    const p0 = three();
    const [a, b] = ids(p0);
    const p = withEdit(p0, setTransition(p0, a!, b!, 'dissolve', 1));
    const placed = placedTransitions(p, map(p));
    expect(placed[0]).toMatchObject({ at: 20, start: 19.5, end: 20.5, duration: 1 });
    expect(transitionAt(placed, 19.49)).toBeNull();
    expect(transitionAt(placed, 20.5)).toBeNull();
    const early = transitionAt(placed, 19.6)!;
    expect(early.progress).toBeCloseTo(0.1, 6);
    expect(early.partner).toMatchObject({ clipId: b, alpha: expect.closeTo(0.1, 6) });
    expect(early.wash).toBeNull();
    const mid = transitionAt(placed, 19.999)!;
    expect(mid.partner!.alpha).toBeCloseTo(0.5, 2);
    // after the change the playing clip is the second one and the first is laid over it, fading out
    const late = transitionAt(placed, 20.4)!;
    expect(late.partner).toMatchObject({ clipId: a, alpha: expect.closeTo(0.1, 6) });
    // through evaluateFrame too
    expect(evaluateFrame(ctx(p), 19.75).transition).toMatchObject({ kind: 'dissolve', progress: expect.closeTo(0.25, 6) });
    expect(evaluateFrame(ctx(p), 10).transition).toBeNull();
    expect(evaluateFrame(ctx(p0), 19.75).transition).toBeNull();
  });

  it('with no footage beyond the edge the neighbouring clip holds its edge frame', () => {
    const p0 = three();
    const [a, b] = ids(p0);
    const p = withEdit(p0, setTransition(p0, a!, b!, 'dissolve', 1));
    const placed = placedTransitions(p, map(p));
    const before = transitionAt(placed, 19.7)!.partner!;
    expect(before.held).toBe(true);
    expect(before.src).toBeCloseTo(20, 3); // clip B's first frame
    expect(before.edgeOut).toBeGreaterThan(20);
    const after = transitionAt(placed, 20.3)!.partner!;
    expect(after.held).toBe(true);
    expect(after.src).toBeGreaterThan(19.9); // clip A's last frame
    expect(after.src).toBeLessThan(20);
    expect(after.edgeOut).toBeLessThan(20);
    // no real footage there, so the neighbour is not heard
    expect(transitionAt(placed, 19.7)!.partnerSound).toBeNull();
    expect(transitionAt(placed, 20.3)!.partnerSound).toBeNull();
  });

  it('uses real footage beyond a trimmed edge, played in step', () => {
    let p = three();
    const [a, b] = ids(p);
    p = withEdit(p, trimClip(p, a!, 'tail', 2)); // A plays 0–18, with 2 s of footage after its end
    p = withEdit(p, trimClip(p, b!, 'head', 1)); // B plays from 21, with 1 s of footage before its start
    p = withEdit(p, setTransition(p, a!, b!, 'dissolve', 1));
    const m = map(p);
    const placed = placedTransitions(p, m);
    expect(placed[0]!.at).toBeCloseTo(18, 6); // the change, in output time
    expect(placed[0]!.fromEnd).toBeCloseTo(18, 2);
    expect(placed[0]!.toStart).toBeCloseTo(21, 2);
    // 0.3 s before the change: B's picture is 0.3 s before its first kept frame
    const before = transitionAt(placed, 17.7)!;
    expect(before.partner).toMatchObject({ clipId: b, held: false });
    expect(before.partner!.src).toBeCloseTo(20.7, 2);
    expect(before.partnerSound).toBeCloseTo(20.7, 2);
    // 0.3 s after it: A carries on into the footage after its last kept frame
    const after = transitionAt(placed, 18.3)!;
    expect(after.partner).toMatchObject({ clipId: a, held: false });
    expect(after.partner!.src).toBeCloseTo(18.3, 2);
    expect(after.partnerSound).toBeCloseTo(18.3, 2);
  });

  it('a dip fades the first clip to the colour by the clip change and the second up from it', () => {
    const p0 = three();
    const [a, b, c] = ids(p0);
    let p = withEdit(p0, setTransition(p0, a!, b!, 'dip-black', 1));
    p = withEdit(p, setTransition(p, b!, c!, 'dip-white', 0.5));
    const placed = placedTransitions(p, map(p));
    expect(transitionAt(placed, 19.5)!.wash).toEqual({ color: '#000000', alpha: 0 });
    expect(transitionAt(placed, 19.75)!.wash!.alpha).toBeCloseTo(0.5, 6);
    expect(transitionAt(placed, 19.9999)!.wash!.alpha).toBeCloseTo(1, 3);
    expect(transitionAt(placed, 20.0001)!.wash!.alpha).toBeCloseTo(1, 3);
    expect(transitionAt(placed, 20.25)!.wash!.alpha).toBeCloseTo(0.5, 6);
    expect(transitionAt(placed, 20.25)!.partner).toBeNull();
    expect(transitionAt(placed, 30)!.wash).toMatchObject({ color: '#ffffff' });
  });

  it('sound: equal power through a dissolve, down and up through a dip', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      const g = transitionGains('dissolve', p);
      expect(g.from * g.from + g.to * g.to).toBeCloseTo(1, 9);
    }
    expect(transitionGains('dissolve', 0)).toMatchObject({ from: 1, to: expect.closeTo(0, 9) });
    expect(transitionGains('dissolve', 0.5).from).toBeCloseTo(Math.SQRT1_2, 9);
    expect(transitionGains('dip-black', 0)).toEqual({ from: 1, to: 0 });
    expect(transitionGains('dip-black', 0.5).from + transitionGains('dip-black', 0.5).to).toBeCloseTo(0, 9);
    expect(transitionGains('dip-white', 1).to).toBeCloseTo(1, 9);
    expect(transitionGains('dip-white', 0.25).from).toBeCloseTo(Math.SQRT1_2, 9);
    // the playing clip's level in the frame state follows the same curve
    const p0 = three();
    const [a, b] = ids(p0);
    const q = withEdit(p0, setTransition(p0, a!, b!, 'dissolve', 1));
    const placed = placedTransitions(q, map(q));
    expect(transitionAt(placed, 19.75)!.gain).toBeCloseTo(Math.cos(Math.PI / 8), 6);
    expect(transitionAt(placed, 19.75)!.partnerGain).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(transitionAt(placed, 20.25)!.gain).toBeCloseTo(Math.sin((0.75 * Math.PI) / 2), 6);
  });
});

describe('transitions: through the clip operations', () => {
  const start = () => {
    const p = three();
    const [a, b, c] = ids(p);
    let q = withEdit(p, setTransition(p, a!, b!, 'dissolve', 1));
    q = withEdit(q, setTransition(q, b!, c!, 'dip-black', 0.5));
    return { p: q, a: a!, b: b!, c: c! };
  };

  it('moving a clip away drops the transitions it was part of; none is left dangling', () => {
    const { p, a, b, c } = start();
    const moved = withEdit(p, moveClip(p, a, 2)); // order is now B, C, A
    expect(ids(moved)).toEqual([b, c, a]);
    expect(transitionsOf(moved.edit).map((t) => [t.from, t.to, t.kind])).toEqual([[b, c, 'dip-black']]);
    // every stored transition is between neighbours
    const pairs = clipPairs(clipsOf(moved)).map((x) => `${x.from.id}>${x.to.id}`);
    for (const t of transitionsOf(moved.edit)) expect(pairs).toContain(`${t.from}>${t.to}`);
    // moving it back does not bring the dropped one back
    const back = withEdit(moved, moveClip(moved, a, 0));
    expect(transitionBetween(back, a, b)).toBeNull();
  });

  it('removing a clip drops its transitions, and putting it back does not invent them', () => {
    const { p, a, b, c } = start();
    const gone = withEdit(p, removeClip(p, b));
    expect(transitionsOf(gone.edit)).toEqual([]);
    expect(gone.edit.transitions).toBeUndefined();
    expect(placedTransitions(gone, map(gone))).toEqual([]);
    const back = withEdit(gone, putBackClip(gone, b, 1));
    expect(ids(back)).toEqual([a, b, c]);
    expect(transitionsOf(back.edit)).toEqual([]);
  });

  it('splitting a clip keeps the transition on the boundary it was on', () => {
    const { p, a, b, c } = start();
    const split = withEdit(p, splitClip(p, 25)!); // B becomes two halves
    const order = ids(split);
    expect(order).toHaveLength(4);
    const second = order[2]!;
    expect(order[1]).toBe(b);
    // A → first half of B is unchanged; B → C now leaves from the second half
    expect(transitionsOf(split.edit).map((t) => [t.from, t.to])).toEqual([[a, b], [second, c]]);
    expect(transitionBetween(split, b, second)).toBeNull(); // the split itself is a hard cut
    expect(placedTransitions(split, map(split)).map((t) => t.at)).toEqual([20, 30]);
  });

  it('a transition whose clip has nothing left to play is not drawn', () => {
    const { p, b } = start();
    // cut all of clip B
    const cut = withEdit(p, manualCut(p.edit, { start: 20, end: 30 }, p.revision + 1));
    expect(placedTransitions(cut, map(cut))).toEqual([]);
    expect(transitionsOf(cut.edit).some((t) => t.from === b)).toBe(true); // still stored: it returns when the footage does
  });
});

describe('B-roll fades', () => {
  it('an insert with no fades set renders exactly as before', () => {
    const before = (a: number, b: number, out: number) => {
      const fade = Math.min(0.3, (b - a) / 3);
      return Math.max(0, Math.min(1, Math.min((out - a) / fade, (b - out) / fade)));
    };
    for (const [a, b] of [[10, 14], [3, 3.6], [0, 0.3]] as const) for (const out of [a, a + 0.05, a + 0.15, (a + b) / 2, b - 0.1, b - 0.01]) expect(brollOpacity({}, a, b, out)).toBeCloseTo(before(a, b, out), 9);
    expect(brollFades({}, 4)).toEqual({ in: BROLL_FADE.standard, out: BROLL_FADE.standard });
  });

  it('fades are adjustable per side, can be off, and never take more than a third of the insert each', () => {
    expect(brollOpacity({ fadeIn: 0, fadeOut: 0 }, 10, 14, 10)).toBe(1);
    expect(brollOpacity({ fadeIn: 0, fadeOut: 0 }, 10, 14, 13.999)).toBe(1);
    expect(brollOpacity({ fadeIn: 1 }, 10, 14, 10.5)).toBeCloseTo(0.5, 9);
    expect(brollOpacity({ fadeIn: 1, fadeOut: 2 }, 10, 16, 15)).toBeCloseTo(0.5, 9);
    expect(brollOpacity({ fadeIn: 1, fadeOut: 2 }, 10, 16, 13)).toBe(1);
    expect(brollFades({ fadeIn: 2, fadeOut: 2 }, 3)).toEqual({ in: 1, out: 1 });
    expect(brollFades({ fadeIn: 9 }, 30).in).toBe(BROLL_FADE.max);
  });
});

describe('punch-in on jump cuts', () => {
  /** One 30 s talking-head clip with three cuts. */
  function talking(): Project {
    let p = createProject('Punch', []);
    p = withSources(p, [src('cam', 'cameraA', 30)]);
    const edit: EditState = { ...p.edit, cuts: [{ id: 'c1', start: 5, end: 6, kind: 'manual', meta }, { id: 'c2', start: 10, end: 11, kind: 'manual', meta }, { id: 'c3', start: 15, end: 16, kind: 'manual', meta }] };
    return commitEdit(p, edit);
  }
  const on = (p: Project, scale?: number) => commitEdit(p, setPunchIn(p.edit, { enabled: true, ...(scale ? { scale } : {}) }));

  it('is off by default and adds nothing until switched on', () => {
    const p = talking();
    expect(punchInOf(p.edit)).toEqual({ enabled: false, scale: PUNCH.default, skip: [] });
    expect(punchScaleAt(p, map(p), 7)).toBe(1);
    expect(evaluateFrame(ctx(p), 7).punch).toBe(1);
    expect(evaluateFrame(ctx(p), 7).cameras[0]!.crop).toBeUndefined();
  });

  it('alternates between normal framing and the punch-in at each cut inside the shot', () => {
    const p = on(talking());
    const joins = punchJoins(p, map(p));
    expect(joins.map((j) => [j.cutIds, j.qualifies, j.punched])).toEqual([[['c1'], true, true], [['c2'], true, false], [['c3'], true, true]]);
    expect(joins.map((j) => +j.at.toFixed(3))).toEqual([5, 9, 13]);
    const m = map(p);
    expect(punchScaleAt(p, m, 2)).toBe(1);
    expect(punchScaleAt(p, m, 6)).toBe(PUNCH.default);
    expect(punchScaleAt(p, m, 10)).toBe(1);
    expect(punchScaleAt(p, m, 14)).toBe(PUNCH.default);
    // the frame carries it, applied to the camera's framing
    const f = evaluateFrame(ctx(p), 6);
    expect(f.punch).toBe(PUNCH.default);
    expect(f.cameras[0]!.crop).toEqual({ cx: 0.5, cy: 0.5, scale: PUNCH.default });
    expect(evaluateFrame(ctx(p), 10).cameras[0]!.crop).toBeUndefined();
  });

  it('the amount is adjustable within its limits', () => {
    const p = on(talking(), 1.25);
    expect(punchScaleAt(p, map(p), 6)).toBe(1.25);
    expect(punchInOf(setPunchIn(p.edit, { scale: 3 })).scale).toBe(PUNCH.max);
    expect(punchInOf(setPunchIn(p.edit, { scale: 1 })).scale).toBe(PUNCH.min);
  });

  it('one cut can be left out: the framing stays as it was there, and the rest still alternate', () => {
    const p0 = on(talking());
    const p = commitEdit(p0, setPunchSkipped(p0.edit, ['c2'], true));
    expect(punchJoins(p, map(p)).map((j) => [j.skipped, j.punched])).toEqual([[false, true], [true, true], [false, false]]);
    const back = commitEdit(p, setPunchSkipped(p.edit, ['c2'], false));
    expect(punchJoins(back, map(back)).map((j) => j.punched)).toEqual([true, false, true]);
    expect(back.edit.punchIn!.skip).toBeUndefined();
  });

  it('follows later cuts by construction: a new cut earlier in the shot shifts the alternation', () => {
    const p0 = on(talking());
    const p = commitEdit(p0, manualCut(p0.edit, { start: 2, end: 3 }, p0.revision + 1));
    expect(punchJoins(p, map(p)).map((j) => j.punched)).toEqual([true, false, true, false]);
    // and restoring a cut removes its join
    const less = commitEdit(p0, { ...p0.edit, cuts: p0.edit.cuts.filter((c) => c.id !== 'c1') });
    expect(punchJoins(less, map(less)).map((j) => [j.cutIds[0], j.punched])).toEqual([['c2', true], ['c3', false]]);
  });

  it('never applies across a view change or where a zoom is active, and those reset the framing', () => {
    const p0 = on(talking());
    // a view segment starts in the middle of cut c2: the picture on its two sides is not one shot
    const view = commitEdit(p0, { ...p0.edit, layouts: [{ id: 'l1', start: 10.5, end: 20, mode: 'camera', camera: 'A', transition: 'cut', meta }] });
    expect(punchJoins(view, map(view)).map((j) => [j.qualifies, j.why ?? null, j.punched])).toEqual([[true, null, true], [false, 'view', false], [true, null, true]]);
    const zoom = commitEdit(p0, { ...p0.edit, zooms: [{ id: 'z1', start: 4, end: 7, scale: 2, follow: false, x: 0.5, y: 0.5, meta }] });
    expect(punchJoins(zoom, map(zoom)).map((j) => [j.qualifies, j.why ?? null, j.punched])).toEqual([[false, 'zoom', false], [true, null, true], [true, null, false]]);
  });

  it('does not apply when the picture is not a full-frame camera', () => {
    let p = createProject('Screen', []);
    p = withSources(p, [src('scr', 'screen', 30), src('cam', 'cameraA', 30)]);
    p = commitEdit(p, { ...p.edit, cuts: [{ id: 'c1', start: 5, end: 6, kind: 'manual', meta }], punchIn: { enabled: true, scale: 1.12 } });
    expect(punchJoins(p, map(p))).toMatchObject([{ qualifies: false, why: 'view', punched: false }]);
    expect(evaluateFrame(ctx(p), 7).punch).toBe(1);
  });

  it('never applies across a clip change, and each clip starts in normal framing', () => {
    let p = three();
    const [, b] = ids(p);
    p = commitEdit(p, trimClip(p, b!, 'head', 1)); // a cut that sits on the clip change
    p = commitEdit(p, { ...p.edit, cuts: [...p.edit.cuts, { id: 'in-a', start: 8, end: 9, kind: 'manual' as const, meta }, { id: 'in-b', start: 24, end: 25, kind: 'manual' as const, meta }].sort((x, y) => x.start - y.start), punchIn: { enabled: true, scale: 1.12 } });
    const joins = punchJoins(p, map(p));
    expect(joins.map((j) => [j.qualifies, j.why ?? null, j.punched])).toEqual([[true, null, true], [false, 'clip', false], [true, null, true]]);
  });

  it('is a factor on whatever framing the camera already has', () => {
    // no framing: closes in on the centre, or on the usual face position (with headroom) when a track is known
    expect(punchCrop(undefined, 1)).toBeUndefined();
    expect(punchCrop(undefined, 1.12)).toEqual({ cx: 0.5, cy: 0.5, scale: 1.12 });
    const track = { hz: 5, cx: new Float32Array([0.6]), cy: new Float32Array([0.4]), size: new Float32Array([0.3]), median: { cx: 0.6, cy: 0.4, size: 0.3 } } as FaceTrackSmooth;
    const c = punchCrop(undefined, 1.25, track)!;
    expect(c.scale).toBe(1.25);
    expect(c.cx).toBeCloseTo(0.6, 6);
    expect(c.cy).toBeCloseTo(0.4 + 0.3 * 0.08, 6);
    // the window stays inside the picture
    const edge = punchCrop(undefined, 1.25, { ...track, median: { cx: 0.98, cy: 0.02, size: 0.2 } })!;
    expect(edge.cx).toBeCloseTo(1 - 0.4, 6);
    expect(edge.cy).toBeCloseTo(0.4, 6);
    // an existing crop (face framing, or a short's reframe) keeps its centre and is magnified
    expect(punchCrop({ cx: 0.4, cy: 0.35, scale: 1.5 }, 1.12, track)).toEqual({ cx: 0.4, cy: 0.35, scale: 1.5 * 1.12 });
    // through evaluateFrame with a face track supplied
    const p = on(talking());
    const f = evaluateFrame(ctx(p, { A: track }), 6);
    expect(f.cameras[0]!.crop!.scale).toBe(PUNCH.default);
    expect(f.cameras[0]!.crop!.cx).toBeGreaterThan(0.5);
  });
});
