import { describe, expect, it } from 'vitest';
import {
  SHORT_CAPTION_LINE,
  SHORT_FACE,
  SHORT_LIMITS,
  TimeMap,
  activeWord,
  addShorts,
  buildFaceTrack,
  buildShortCues,
  createProject,
  defaultSync,
  evaluateFrame,
  hookLine,
  manualCut,
  moveClip,
  newShort,
  nudgeShortRange,
  parseShortCandidates,
  projectWithEdit,
  removeShort,
  ruleShortCandidates,
  shortDuration,
  shortFaceCrop,
  shortFramings,
  shortMap,
  shortProject,
  shortsOf,
  snapShortRange,
  splitClip,
  updateShort,
  type FaceSample,
  type MediaSource,
  type Project,
  type Transcript,
  type Word,
} from '../src';

function src(id: string, role: MediaSource['role'], duration: number, extra: Partial<MediaSource> = {}): MediaSource {
  return { id, role, name: `${id}.mov`, path: `/tmp/${id}.mov`, managed: false, origin: 'import', kind: 'video', duration, hasAudio: true, fingerprint: { sizeBytes: 1, duration }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [], width: 1920, height: 1080, ...extra } as MediaSource;
}

/**
 * A made-up talk: sentences of `n` words, 0.3 s a word, with a pause after
 * each. Sentence k (from 0) starts at `starts[k]`.
 */
function talk(sentences: string[], gap = 0.9, t0 = 1): { transcript: Transcript; starts: number[]; ends: number[]; end: number } {
  const words: Word[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let t = t0;
  sentences.forEach((s, k) => {
    starts.push(t);
    for (const w of s.split(' ')) {
      words.push({ id: `w${words.length}`, text: w, start: t, end: t + 0.26, kind: /^(um|uh)$/i.test(w) ? 'filler' : 'word' });
      t += 0.3;
    }
    ends.push(t - 0.04);
    t += gap + (k % 3 === 0 ? 0.3 : 0);
  });
  return { transcript: { engine: 'test', locale: 'en-US', onDevice: true, sourceId: 'cam', hasSpeech: true, words, generatedAt: '' }, starts, ends, end: t };
}

const LINE = 'this sentence has exactly some plain words in it okay.';
function longTalk(n = 40): string[] {
  const out = Array.from({ length: n }, () => LINE);
  out[6] = 'Why do most exports look blurry on a phone screen?';
  out[20] = 'Here are 3 settings that fix it every single time.';
  out[30] = 'and then we also looked at some other things too.';
  return out;
}

function demo(sentences = longTalk(), sources: MediaSource[] = [src('cam', 'cameraA', 200), src('scr', 'screen', 200)]): { p: Project; starts: number[]; ends: number[] } {
  const t = talk(sentences);
  const p = createProject('demo', sources);
  return { p: { ...p, duration: 200, transcript: t.transcript }, starts: t.starts, ends: t.ends };
}

describe('a short is a range that plays through the long edit', () => {
  it('runs only its own range, minus what the long edit already cut, at the long edit speed', () => {
    const { p } = demo();
    let edit = manualCut(p.edit, { start: 30, end: 40 }, 1);
    edit = { ...edit, speeds: [{ id: 's', start: 50, end: 60, speed: 2, meta: { origin: 'creator', revision: 1 } }] };
    const q = { ...p, edit };
    const map = shortMap(q, { start: 20, end: 70 });
    expect(map.outDuration).toBeCloseTo(10 + 10 + 5 + 10, 5);
    expect(shortDuration(q, { start: 20, end: 70 })).toBeCloseTo(35, 5);
    expect(map.toSource(0)).toBeCloseTo(20, 5);
    expect(map.toSource(10.5)).toBeCloseTo(40.5, 5);
    expect(map.isKept(19)).toBe(false);
    expect(map.isKept(71)).toBe(false);
  });

  it('derives a project in the short frame and leaves the long project exactly as it was', () => {
    const { p } = demo();
    const before = JSON.stringify(p);
    const short = newShort(p, { start: 20, end: 60, title: 'Blurry exports' }, 'creator');
    const d = shortProject(p, short);
    expect(JSON.stringify(p)).toBe(before);
    expect(d.edit.appearance.output).toMatchObject({ width: 1080, height: 1920 });
    expect(shortProject(p, { ...short, shape: 'square' }).edit.appearance.output).toMatchObject({ width: 1080, height: 1080 });
    expect(d.edit.cuts.map((c) => [c.start, c.end])).toEqual([[0, 20], [60, 200]]);
    expect(d.edit.layouts).toHaveLength(1);
    expect(d.edit.layouts[0]).toMatchObject({ mode: 'camera', camera: 'A', start: 20, end: 60 });
    expect(d.edit.reframe).toEqual({ framing: 'face', fillScreen: true });
    expect(d.edit.appearance.captions).toMatchObject({ burnIn: true, short: { preset: 'pop', position: 'low' } });
    expect(d.name).toContain('Blurry exports');
    // text, graphics, masks and sound effects are the long edit's own
    expect(d.edit.overlays).toBe(p.edit.overlays);
    expect(d.edit.masks).toBe(p.edit.masks);
    expect(shortProject(p, { ...short, framing: 'stack' }).edit.layouts[0]!.mode).toBe('split');
    expect(shortProject(p, { ...short, framing: 'screen' }).edit.layouts[0]!.mode).toBe('screen');
    expect(shortProject(p, { ...short, framing: 'original' }).edit.layouts).toBe(p.edit.layouts);
    expect(shortProject(p, { ...short, captions: { preset: 'off', position: 'low', size: 1 } }).edit.appearance.captions.burnIn).toBe(false);
  });

  it('offers only the framings the footage allows, and falls back when a saved one is not possible', () => {
    const both = demo().p;
    expect(shortFramings(both, { start: 10, end: 50 })).toEqual(['face', 'stack', 'screen', 'original']);
    const camOnly = demo(longTalk(), [src('cam', 'cameraA', 200)]).p;
    expect(shortFramings(camOnly, { start: 10, end: 50 })).toEqual(['face', 'original']);
    const screenOnly = demo(longTalk(), [src('scr', 'screen', 200)]).p;
    expect(shortFramings(screenOnly, { start: 10, end: 50 })).toEqual(['screen', 'original']);
    const s = newShort(screenOnly, { start: 10, end: 50, title: 't' }, 'creator');
    expect(s.framing).toBe('screen');
    expect(shortProject(screenOnly, { ...s, framing: 'face' }).edit.reframe!.framing).toBe('screen');
  });

  it('moves music onto the short clock and trims it to the short', () => {
    const { p } = demo(longTalk(), [src('cam', 'cameraA', 200), src('song', 'music', 300, { kind: 'audio' } as Partial<MediaSource>)]);
    const meta = { origin: 'creator' as const, revision: 1 };
    const q: Project = { ...p, edit: { ...p.edit, music: [{ id: 'm', sourceId: 'song', start: 10, sourceIn: 0, length: 60, gain: 0.3, fadeIn: 1, fadeOut: 2, duck: true, meta }, { id: 'late', sourceId: 'song', start: 150, sourceIn: 0, length: 20, gain: 0.3, fadeIn: 1, fadeOut: 2, duck: true, meta }] } };
    const d = shortProject(q, newShort(q, { start: 30, end: 60, title: 't' }, 'creator'));
    expect(d.edit.music).toHaveLength(1);
    expect(d.edit.music![0]).toMatchObject({ id: 'm', start: 0, sourceIn: 20, length: 30 });
    expect(q.edit.music![0]!.start).toBe(10);
  });

  it('adds, changes and removes shorts without touching the edit', () => {
    const { p } = demo();
    const a = newShort(p, { start: 20, end: 60, title: 'A' }, 'rules');
    const b = newShort(p, { start: 5, end: 30, title: 'B' }, 'ai', 'codex');
    let q = addShorts(p, [a, b]);
    expect(q.edit).toBe(p.edit);
    expect(shortsOf(q).map((s) => s.title)).toEqual(['B', 'A']);
    q = updateShort(q, a.id, { title: 'A2', framing: 'stack' });
    expect(shortsOf(q).find((s) => s.id === a.id)).toMatchObject({ title: 'A2', framing: 'stack', origin: 'rules' });
    q = removeShort(q, b.id);
    expect(shortsOf(q)).toHaveLength(1);
    expect(q.edit).toBe(p.edit);
    expect(updateShort(q, 'nope', { title: 'x' })).toBe(q);
  });

  it('a short follows its footage when the clips are reordered', () => {
    const { p } = demo();
    const split = splitClip(p, 100);
    expect(split).not.toBeNull();
    const two = projectWithEdit(p, split!);
    const withShort = addShorts(two, [newShort(two, { start: 120, end: 150, title: 'second half' }, 'creator')]);
    const second = withShort.edit.clips![1]!;
    const moved = projectWithEdit(withShort, moveClip(withShort, second.id, 0));
    const s = shortsOf(moved)[0]!;
    expect(s.start).toBeCloseTo(20, 3);
    expect(s.end).toBeCloseTo(50, 3);
  });
});

describe('fitting a range to the footage', () => {
  it('starts at the start of a sentence and ends at the end of one, never inside a word', () => {
    const { p, starts, ends } = demo();
    const r = snapShortRange(p, { start: starts[4]! + 1.1, end: ends[14]! - 0.7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const words = p.transcript!.words;
    for (const w of words) {
      expect(r.range.start > w.start + 0.01 && r.range.start < w.end - 0.01).toBe(false);
      expect(r.range.end > w.start + 0.01 && r.range.end < w.end - 0.01).toBe(false);
    }
    // the first word in the range begins a sentence, the last one ends one
    const inside = words.filter((w) => w.start >= r.range.start && w.end <= r.range.end);
    expect(starts.some((s) => Math.abs(s - inside[0]!.start) < 1e-6)).toBe(true);
    expect(inside[inside.length - 1]!.text.endsWith('.')).toBe(true);
    expect(r.range.start).toBeLessThanOrEqual(inside[0]!.start);
    expect(inside[0]!.start - r.range.start).toBeLessThanOrEqual(0.2 + 1e-6);
    expect(r.duration).toBeGreaterThanOrEqual(SHORT_LIMITS.min);
  });

  it('never starts or ends inside a cut', () => {
    const { p, starts, ends } = demo();
    const cut = { start: starts[5]! - 0.5, end: starts[8]! - 0.05 };
    const q = { ...p, edit: manualCut(p.edit, cut, 1) };
    const r = snapShortRange(q, { start: starts[6]!, end: ends[20]! });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const map = TimeMap.fromEdit(q.duration, q.edit);
    expect(map.isKept(r.range.start)).toBe(true);
    expect(map.isKept(r.range.end - 1e-3)).toBe(true);
    expect(r.range.start >= cut.end - 1e-6 || r.range.start <= cut.start).toBe(true);
    // a range that is entirely cut has nothing to offer
    const gone = snapShortRange({ ...p, transcript: null, edit: manualCut(p.edit, { start: 10, end: 60 }, 1) }, { start: 20, end: 50 });
    expect(gone.ok).toBe(false);
  });

  it('brings a range inside 15 to 90 seconds on whole sentences, or says why it cannot', () => {
    const { p, starts, ends } = demo();
    const long = snapShortRange(p, { start: starts[0]!, end: ends[39]! });
    expect(long.ok).toBe(true);
    if (long.ok) {
      expect(long.duration).toBeLessThanOrEqual(SHORT_LIMITS.max + 0.01);
      expect(long.notes.join(' ')).toMatch(/Shortened/);
      expect(ends.some((e) => long.range.end >= e && long.range.end - e <= 0.31)).toBe(true);
    }
    const tiny = snapShortRange(p, { start: starts[10]!, end: ends[10]! });
    expect(tiny.ok).toBe(true);
    if (tiny.ok) {
      expect(tiny.duration).toBeGreaterThanOrEqual(SHORT_LIMITS.min - 0.05);
      expect(tiny.notes.join(' ')).toMatch(/Extended/);
    }
    const short = demo(['just three words here.', 'and four more words now.']).p;
    const r = snapShortRange(short, { start: 0, end: 5 });
    expect(r.ok).toBe(false);
    expect(snapShortRange(p, { start: Number.NaN, end: 3 }).ok).toBe(false);
    expect(snapShortRange(p, { start: 500, end: 600 }).ok).toBe(false);
    // by hand a short may be as short as three seconds
    const hand = snapShortRange(p, { start: starts[10]!, end: ends[10]! }, { min: SHORT_LIMITS.handMin, max: SHORT_LIMITS.max });
    expect(hand.ok && hand.duration < 5).toBe(true);
  });

  it('moves one end a sentence at a time', () => {
    const { p, starts, ends } = demo();
    const base = snapShortRange(p, { start: starts[5]!, end: ends[12]! });
    if (!base.ok) throw new Error('fixture');
    const later = nudgeShortRange(p, base.range, 'end', 1);
    expect(later.ok && Math.abs(later.range.end - (ends[13]! + 0.3)) < 0.02).toBe(true);
    const earlier = nudgeShortRange(p, base.range, 'start', -1);
    expect(earlier.ok && Math.abs(earlier.range.start - (starts[4]! - 0.2)) < 0.02).toBe(true);
    expect(earlier.ok && Math.abs(earlier.range.end - base.range.end) < 1e-6).toBe(true);
    const first = snapShortRange(p, { start: starts[0]!, end: ends[8]! });
    if (!first.ok) throw new Error('fixture');
    expect(nudgeShortRange(p, first.range, 'start', -1).ok).toBe(false);
  });

  it('quotes the opening line with the creator spelling', () => {
    const { p, starts, ends } = demo();
    const id = p.transcript!.words.find((w) => w.start === starts[6]!)!.id;
    const q = { ...p, edit: { ...p.edit, wordText: { [id]: 'WHY' } } };
    expect(hookLine(q, { start: starts[6]! - 0.2, end: ends[9]! + 0.3 })).toBe('WHY do most exports look blurry on a phone screen?');
  });
});

describe('candidates from an AI reply are untrusted', () => {
  it('keeps what fits, snapped, and rejects the rest with a reason', () => {
    const { p, starts, ends } = demo();
    const reply = {
      shorts: [
        { title: 'Why exports look blurry', start: starts[6]! + 0.4, end: ends[14]! - 0.5, hook: 'made up', reason: 'A complete question and answer.' },
        { title: 'Same again', start: starts[7]!, end: ends[14]!, hook: '', reason: '' },
        { title: 'Outside', start: 400, end: 430, hook: '', reason: '' },
        { title: 'Backwards', start: 50, end: 40, hook: '', reason: '' },
        { title: 'Not numbers', start: '12', end: 40, hook: '', reason: '' },
        'nonsense',
        { title: '', start: starts[20]!, end: ends[27]!, hook: '', reason: '' },
      ],
    };
    const { candidates, rejected } = parseShortCandidates(reply, p);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ title: 'Why exports look blurry', reason: 'A complete question and answer.' });
    // the hook is what was really said, not what the model wrote
    expect(candidates[0]!.hook).toBe('Why do most exports look blurry on a phone screen?');
    expect(Math.abs(candidates[0]!.start - (starts[6]! - 0.2))).toBeLessThan(0.02);
    expect(candidates[1]!.title).toBe('Here are 3 settings that fix it every single time');
    expect(candidates.every((c) => c.duration >= 15 && c.duration <= 90)).toBe(true);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
    expect(rejected[0]!.reason).toMatch(/repeats/);
    expect(rejected[1]!.reason).toMatch(/outside/);
  });

  it('refuses a reply that is not a list, ranges already taken, and more than the limit', () => {
    const { p, starts, ends } = demo();
    expect(parseShortCandidates('hello', p).candidates).toEqual([]);
    expect(parseShortCandidates({ shorts: 'x' }, p).rejected[0]!.reason).toMatch(/no list/);
    const one = { title: 'a', start: starts[2]!, end: ends[8]!, hook: '', reason: '' };
    expect(parseShortCandidates({ shorts: [one] }, p, { taken: [{ start: starts[2]!, end: ends[8]! }] }).candidates).toEqual([]);
    const many = { shorts: [0, 8, 16, 24, 32].map((k) => ({ title: `s${k}`, start: starts[k]!, end: ends[k + 5]!, hook: '', reason: '' })) };
    const r = parseShortCandidates(many, p, { max: 3 });
    expect(r.candidates).toHaveLength(3);
    expect(r.rejected.some((x) => /Only 3/.test(x.reason))).toBe(true);
  });
});

describe('built-in rules', () => {
  it('prefer a question, a number and a flagged moment, and never overlap', () => {
    const { p, starts } = demo();
    const flagged: Project = { ...p, flags: [{ id: 'f', t: starts[33]! + 2 }] };
    const picks = ruleShortCandidates(flagged, { max: 4 });
    expect(picks.length).toBeGreaterThanOrEqual(3);
    expect(picks.length).toBeLessThanOrEqual(4);
    for (const c of picks) {
      expect(c.duration).toBeGreaterThanOrEqual(15);
      expect(c.duration).toBeLessThanOrEqual(90);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.reason.length).toBeGreaterThan(0);
    }
    for (let i = 1; i < picks.length; i++) expect(picks[i]!.start).toBeGreaterThanOrEqual(picks[i - 1]!.end - 0.25 * (picks[i - 1]!.end - picks[i - 1]!.start));
    const hooks = picks.map((c) => c.hook);
    expect(hooks).toContain('Why do most exports look blurry on a phone screen?');
    expect(hooks).toContain('Here are 3 settings that fix it every single time.');
    expect(picks.find((c) => /question/.test(c.reason))).toBeTruthy();
    expect(picks.some((c) => /flagged/.test(c.reason))).toBe(true);
    // a line that starts mid-thought is not chosen as an opening
    expect(hooks.some((h) => /^and then/.test(h))).toBe(false);
  });

  it('do not propose what is already a short, and cope with no speech', () => {
    const { p } = demo();
    const first = ruleShortCandidates(p, { max: 2 });
    const more = ruleShortCandidates(p, { max: 5, taken: first });
    for (const c of more) for (const t of first) expect(Math.min(c.end, t.end) - Math.max(c.start, t.start)).toBeLessThan(0.25 * Math.min(c.end - c.start, t.end - t.start));
    const silent = { ...p, transcript: null };
    const s = ruleShortCandidates(silent);
    expect(s).toHaveLength(1);
    expect(s[0]!.reason).toMatch(/No speech/);
    expect(s[0]!.duration).toBeCloseTo(40, 1);
    const tiny = demo(['only a few words here.']).p;
    expect(ruleShortCandidates({ ...tiny, duration: 6 })).toEqual([]);
  });
});

describe('captions that follow the voice', () => {
  it('breaks into lines of two to five words at sentence ends and pauses', () => {
    const { p } = demo(['Why do most exports look blurry on a phone screen?', 'Well, um it is the bitrate.', 'Stop.', 'Use these 3 settings every single time you export a video.']);
    const map = TimeMap.fromEdit(p.duration, p.edit);
    const cues = buildShortCues(p.transcript, p.edit, map);
    expect(cues.length).toBeGreaterThan(4);
    for (const c of cues) {
      expect(c.words!.length).toBeLessThanOrEqual(SHORT_CAPTION_LINE.maxWords);
      expect(c.text.length).toBeLessThanOrEqual(SHORT_CAPTION_LINE.maxChars + 9);
      expect(c.end).toBeGreaterThan(c.start);
    }
    // only a one-word sentence may stand alone
    expect(cues.filter((c) => c.words!.length === 1).map((c) => c.text)).toEqual(['Stop']);
    // a line never runs across the end of a sentence
    expect(cues.some((c) => /screen\? Well/.test(c.text))).toBe(false);
    expect(cues.find((c) => c.text.endsWith('screen?'))).toBeTruthy();
    // fillers are not captioned; commas and full stops are dropped
    const all = cues.map((c) => c.text).join(' ');
    expect(all).not.toMatch(/\bum\b/);
    expect(all).not.toMatch(/[.,]/);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-6);
  });

  it('times every word through cuts and speed changes, and uses the creator spelling', () => {
    const { p, starts } = demo(['one two three four five six seven eight nine ten.', 'eleven twelve thirteen fourteen fifteen sixteen.']);
    const w = p.transcript!.words;
    // cut "four five six" and play the second sentence at double speed
    let edit = manualCut(p.edit, { start: w[3]!.start - 0.02, end: w[6]!.start - 0.02 }, 1);
    edit = { ...edit, wordText: { [w[0]!.id]: 'ONE' }, speeds: [{ id: 's', start: starts[1]! - 0.1, end: starts[1]! + 3, speed: 2, meta: { origin: 'creator', revision: 1 } }] };
    const q = { ...p, edit };
    const map = shortMap(q, { start: 0.5, end: 12 });
    const cues = buildShortCues(q.transcript, q.edit, map);
    const flat = cues.flatMap((c) => c.words!);
    expect(flat.map((x) => x.text)).toEqual(['ONE', 'two', 'three', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen']);
    // "seven" follows "three" directly: the cut footage takes no time
    const three = flat[2]!;
    const seven = flat[3]!;
    expect(seven.start - three.start).toBeCloseTo(0.3, 1);
    // at double speed the words are 0.15 s apart
    const eleven = flat[7]!;
    const twelve = flat[8]!;
    expect(twelve.start - eleven.start).toBeCloseTo(0.15, 2);
    // output time of the first word: the short starts at 0.5, the word at 1.0
    expect(flat[0]!.start).toBeCloseTo(0.5, 2);
    for (const c of cues) for (const x of c.words!) expect(x.start >= c.start - 1e-6 && x.start < c.end).toBe(true);
  });

  it('lights the word being spoken', () => {
    const cue = { words: [{ text: 'a', start: 1, end: 1.2 }, { text: 'b', start: 1.3, end: 1.5 }, { text: 'c', start: 1.6, end: 1.9 }] };
    expect(activeWord(cue, 0.9)).toBe(-1);
    expect(activeWord(cue, 1.0)).toBe(0);
    expect(activeWord(cue, 1.25)).toBe(0);
    expect(activeWord(cue, 1.31)).toBe(1);
    expect(activeWord(cue, 5)).toBe(2);
  });
});

describe('following a face in a frame of another shape', () => {
  const SRC = 16 / 9;
  const DST = 9 / 16;
  const samples = (f: (t: number) => { x: number; y: number }, n = 200): FaceSample[] => Array.from({ length: n }, (_, i) => ({ t: i / 5, ...f(i / 5), w: 0.12, h: 0.2 }));

  it('centres the window on the face with room above the head, and never leaves the picture', () => {
    const track = buildFaceTrack(samples(() => ({ x: 0.64, y: 0.2 })), 5)!;
    const c = shortFaceCrop(track, 10, SRC, DST);
    // face centre is at x 0.70, y 0.30
    expect(c.cx).toBeCloseTo(0.7, 2);
    expect(c.scale).toBeGreaterThanOrEqual(1);
    expect(c.scale).toBeLessThanOrEqual(SHORT_FACE.maxScale);
    const h = 1 / c.scale;
    const top = c.cy - h / 2;
    // the face sits about 40% of the way down the window
    expect((0.3 - top) / h).toBeCloseTo(SHORT_FACE.eyeLine, 1);
    // a face at the very edge: the window stops at the edge of the picture
    const edge = shortFaceCrop(buildFaceTrack(samples(() => ({ x: 0.9, y: 0.0 })), 5)!, 10, SRC, DST);
    const w = (DST / SRC) / edge.scale;
    expect(edge.cx + w / 2).toBeLessThanOrEqual(1 + 1e-9);
    expect(edge.cy - 1 / edge.scale / 2).toBeGreaterThanOrEqual(-1e-9);
    // a small face is magnified, a large one is not
    const small = buildFaceTrack(samples(() => ({ x: 0.4, y: 0.3 })).map((s) => ('none' in s ? s : { ...s, h: 0.1 })), 5)!;
    const big = buildFaceTrack(samples(() => ({ x: 0.4, y: 0.3 })).map((s) => ('none' in s ? s : { ...s, h: 0.5 })), 5)!;
    expect(shortFaceCrop(small, 10, SRC, DST).scale).toBeGreaterThan(1.5);
    expect(shortFaceCrop(big, 10, SRC, DST).scale).toBe(1);
  });

  it('does not shake with a noisy detector, and still follows a real move', () => {
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.04;
    const noisy = buildFaceTrack(samples(() => ({ x: 0.44 + noise(), y: 0.2 + noise() })), 5)!;
    let worst = 0;
    let prev = shortFaceCrop(noisy, 5, SRC, DST);
    for (let t = 5 + 1 / 30; t < 30; t += 1 / 30) {
      const c = shortFaceCrop(noisy, t, SRC, DST);
      worst = Math.max(worst, Math.abs(c.cx - prev.cx));
      expect(c.scale).toBe(prev.scale);
      prev = c;
    }
    // frame-to-frame movement under 0.15% of the picture width
    expect(worst).toBeLessThan(0.0015);
    const walk = buildFaceTrack(samples((t) => ({ x: t < 20 ? 0.2 : 0.6, y: 0.2 })), 5)!;
    expect(shortFaceCrop(walk, 10, SRC, DST).cx).toBeCloseTo(0.26, 1);
    expect(shortFaceCrop(walk, 35, SRC, DST).cx).toBeCloseTo(0.66, 1);
  });
});

describe('the frame of a short', () => {
  it('face framing fills the frame with the camera; screen framing fills it with a window that follows the pointer', () => {
    const { p } = demo();
    const short = newShort(p, { start: 20, end: 60, title: 't' }, 'creator');
    const face = shortProject(p, short);
    const track = buildFaceTrack(Array.from({ length: 400 }, (_, i) => ({ t: i / 5, x: 0.64, y: 0.2, w: 0.12, h: 0.2 })), 5)!;
    const ctx = (q: Project, follow: Parameters<typeof evaluateFrame>[0]['follow'] = null) => ({ project: q, map: TimeMap.fromEdit(q.duration, q.edit), cursor: null, follow, screenAspect: 16 / 9, faces: { A: track } });
    const f = evaluateFrame(ctx(face), 5);
    expect(f.src).toBeCloseTo(25, 3);
    expect(f.layout.mode).toBe('camera');
    expect(f.cameras[0]!.rect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(f.cameras[0]!.crop!.cx).toBeCloseTo(0.7, 2);

    const screen = shortProject(p, { ...short, framing: 'screen' });
    const xs = new Float32Array(120 * 80).fill(0.8);
    const follow = { hz: 120, t0: 0, xs, ys: new Float32Array(xs.length).fill(0.5), clicks: [], lastMove: new Float32Array(xs.length), kinds: new Uint8Array(xs.length) } as unknown as NonNullable<Parameters<typeof evaluateFrame>[0]['follow']>;
    const s = evaluateFrame(ctx(screen, follow), 5);
    expect(s.layout.mode).toBe('screen');
    expect(s.screen!.rect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    const z = s.screen!.zoom;
    expect(z.ax).toBeCloseTo((9 / 16) / (16 / 9), 4);
    expect(z.ay).toBe(1);
    // the window follows the pointer but stays inside the screen
    expect(z.cx).toBeGreaterThan(0.75);
    expect(z.cx + z.ax! / 2).toBeLessThanOrEqual(1 + 1e-9);
    // without a pointer it sits in the middle
    expect(evaluateFrame(ctx(screen), 5).screen!.zoom.cx).toBeCloseTo(0.5, 5);
    // the long project is unaffected: no window narrowing there
    expect(evaluateFrame(ctx(p), 25).screen!.zoom.ax).toBeUndefined();
  });
});
