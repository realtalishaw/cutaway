import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SOUNDS,
  DUCK_LEVEL,
  TEXT_TEMPLATES,
  TimeMap,
  addSounds,
  createProject,
  cutMoments,
  defaultSync,
  defaultTextStyle,
  duckStep,
  duplicateOverlay,
  exportPreflight,
  fitMusicClip,
  makeSound,
  manualCut,
  musicClipsOf,
  musicFade,
  musicGainAt,
  musicSourceTime,
  newMusicClip,
  normalizeTextStyle,
  overlaysFromTemplate,
  soundEvents,
  soundOnEveryText,
  speakingAt,
  speechWindows,
  synthSound,
  textPose,
  textStyleOf,
  trimMusicStart,
  updateMusicClip,
  validateOps,
  viewChangeMoments,
  withMusic,
  withoutSoundSource,
  type MediaSource,
  type MusicClip,
  type Project,
} from '../src';

function src(id: string, role: MediaSource['role'], duration: number, kind: MediaSource['kind'] = 'video'): MediaSource {
  return { id, role, name: `${id}.mov`, path: `/tmp/${id}.mov`, managed: false, origin: 'import', kind, duration, hasAudio: true, fingerprint: { sizeBytes: 1, duration }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [] };
}
const meta = { origin: 'creator' as const, revision: 1 };
function project(): Project {
  return createProject('demo', [src('cam', 'cameraA', 60), src('song', 'music', 30, 'audio'), src('hit', 'music', 2, 'audio')]);
}

describe('text style', () => {
  it('fills every field from nothing and keeps a good style unchanged', () => {
    const d = defaultTextStyle();
    expect(normalizeTextStyle(undefined)).toEqual(d);
    expect(normalizeTextStyle(null)).toEqual(d);
    expect(normalizeTextStyle(d)).toEqual(d);
    for (const t of TEXT_TEMPLATES) for (const p of t.parts) expect(normalizeTextStyle(p.style)).toEqual(p.style);
  });

  it('clamps sizes, rejects colours it cannot parse and unknown names', () => {
    const s = normalizeTextStyle({ size: 99, width: -3, color: 'red; drop', font: 'comic', align: 'justify', shadow: 7, outline: { width: 5, color: 12 }, in: { type: 'spin', duration: 600 }, background: { shape: 'star', opacity: -1 } });
    const d = defaultTextStyle();
    expect(s.size).toBe(0.4);
    expect(s.width).toBe(0.1);
    expect(s.color).toBe(d.color);
    expect(s.font).toBe('inter');
    expect(s.align).toBe('center');
    expect(s.shadow).toBe(1);
    expect(s.outline).toEqual({ width: 0.3, color: d.outline.color });
    expect(s.in).toEqual({ type: d.in.type, duration: 3 });
    expect(s.background.shape).toBe('none');
    expect(s.background.opacity).toBe(0);
  });

  it('never asks a one-weight font for a bold it does not have', () => {
    expect(normalizeTextStyle({ font: 'anton', weight: 800 }).weight).toBe(400);
    expect(normalizeTextStyle({ font: 'serif', weight: 700 }).weight).toBe(400);
    expect(normalizeTextStyle({ font: 'inter', weight: 800 }).weight).toBe(800);
  });

  it('an accent or scrim that is switched off stays off', () => {
    expect(normalizeTextStyle({ accent: null, scrim: null })).toMatchObject({ accent: null, scrim: null });
    expect(normalizeTextStyle({ scrim: { color: '#000000', opacity: 0 } }).scrim).toBeNull();
    expect(normalizeTextStyle({ accent: '#FF5A36' }).accent).toBe('#ff5a36');
  });
});

describe('text animation is a function of time', () => {
  const fade = { in: { type: 'fade' as const, duration: 0.4 }, out: { type: 'fade' as const, duration: 0.2 } };

  it('is hidden before it starts and after it ends, settled in between', () => {
    expect(textPose(fade, -0.1, 5).opacity).toBe(0);
    expect(textPose(fade, 5, 0).opacity).toBe(0);
    expect(textPose(fade, 2, 2)).toEqual({ opacity: 1, dy: 0, scale: 1, reveal: 1 });
  });

  it('fades in and out monotonically', () => {
    const a = [0.05, 0.1, 0.2, 0.3, 0.39].map((t) => textPose(fade, t, 4).opacity);
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeGreaterThan(a[i - 1]!);
    expect(a[0]!).toBeGreaterThan(0);
    expect(a[4]!).toBeLessThan(1);
    const b = [0.19, 0.1, 0.02].map((t) => textPose(fade, 4, t).opacity);
    expect(b[0]!).toBeGreaterThan(b[1]!);
    expect(b[1]!).toBeGreaterThan(b[2]!);
  });

  it('slide up arrives from below and leaves upward', () => {
    const s = { in: { type: 'slide-up' as const, duration: 0.5 }, out: { type: 'slide-up' as const, duration: 0.5 } };
    expect(textPose(s, 0.1, 4).dy).toBeGreaterThan(0);
    expect(textPose(s, 0.1, 4).dy).toBeGreaterThan(textPose(s, 0.3, 4).dy);
    expect(textPose(s, 2, 2).dy).toBe(0);
    expect(textPose(s, 4, 0.1).dy).toBeLessThan(0);
  });

  it('pop grows into place and typewriter reveals letters in step with time', () => {
    const pop = { in: { type: 'pop' as const, duration: 0.4 }, out: { type: 'none' as const, duration: 0.3 } };
    expect(textPose(pop, 0.02, 4).scale).toBeLessThan(0.9);
    expect(textPose(pop, 0.5, 4).scale).toBe(1);
    const type = { in: { type: 'typewriter' as const, duration: 1 }, out: { type: 'none' as const, duration: 0.3 } };
    expect(textPose(type, 0.25, 4).reveal).toBeCloseTo(0.25, 5);
    expect(textPose(type, 0.75, 4).reveal).toBeCloseTo(0.75, 5);
    expect(textPose(type, 1.5, 4).reveal).toBe(1);
    // "none" on the way out: fully there until the last instant
    expect(textPose(type, 3, 0.001).opacity).toBe(1);
  });

  it('shortens both animations when the text is shorter than them, and gives the same answer every time', () => {
    const long = { in: { type: 'fade' as const, duration: 2 }, out: { type: 'fade' as const, duration: 2 } };
    // one second long: half a second each way, so the middle is fully there
    expect(textPose(long, 0.5, 0.5).opacity).toBeCloseTo(1, 5);
    expect(textPose(long, 0.25, 0.75).opacity).toBeGreaterThan(0);
    expect(textPose(long, 0.25, 0.75)).toEqual(textPose(long, 0.25, 0.75));
  });
});

describe('title templates', () => {
  it('cover titles, lower thirds, cards and labels, each made only of text overlays', () => {
    const ids = TEXT_TEMPLATES.map((t) => t.id);
    for (const need of ['big-title', 'title-subtitle', 'chapter', 'lower-third-bar', 'lower-third-clean', 'end-card']) expect(ids).toContain(need);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEXT_TEMPLATES) {
      const made = overlaysFromTemplate(t.id, 10, 60, meta);
      expect(made.length).toBeGreaterThan(0);
      for (const o of made) {
        expect(o.kind).toBe('text');
        expect(o.start).toBeGreaterThanOrEqual(10);
        expect(o.end - o.start).toBeGreaterThanOrEqual(0.5);
        expect(o.end).toBeLessThanOrEqual(60);
        expect(textStyleOf(o)).toEqual(o.style);
      }
    }
  });

  it('stay inside the project when added near its end, and can be duplicated', () => {
    const [o] = overlaysFromTemplate('end-card', 59.8, 60, meta);
    expect(o!.end).toBeLessThanOrEqual(60);
    expect(o!.end - o!.start).toBeGreaterThanOrEqual(0.5);
    const [t] = overlaysFromTemplate('plain', 10, 60, meta);
    const copy = duplicateOverlay(t!, 60, meta);
    expect(copy.id).not.toBe(t!.id);
    expect(copy.start).toBe(t!.end);
    expect(copy.end - copy.start).toBeCloseTo(t!.end - t!.start, 6);
    // no room after it: the copy sits on top, nudged so both can be grabbed
    const [late] = overlaysFromTemplate('plain', 57, 60, meta);
    const onTop = duplicateOverlay(late!, 60, meta);
    expect(onTop.start).toBe(late!.start);
    expect(onTop.y).not.toBe(late!.y);
  });

  it('the AI still cannot propose free text', () => {
    const p = project();
    const r = validateOps(p, [{ op: 'overlay', kind: 'text', start: 1, end: 4, text: 'Hello' }], { origin: 'ai' });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(validateOps(p, [{ op: 'overlay', kind: 'callout', start: 1, end: 4, text: 'Hello' }], { origin: 'ai' }).accepted).toHaveLength(1);
  });
});

describe('music clips live on the output timeline', () => {
  const clip = (patch: Partial<MusicClip> = {}): MusicClip => ({ id: 'm1', sourceId: 'song', start: 5, sourceIn: 2, length: 10, gain: 0.5, fadeIn: 2, fadeOut: 4, duck: true, meta, ...patch });

  it('reads the old single music field as one clip from the start, then retires it on the first change', () => {
    const p = project();
    const old = { ...p.edit, audio: { ...p.edit.audio, music: { sourceId: 'song', gain: 0.3, duck: true } } };
    const clips = musicClipsOf(old, p.sources);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ sourceId: 'song', start: 0, sourceIn: 0, length: 30, gain: 0.3, duck: true, fadeIn: 0, fadeOut: 0 });
    const next = updateMusicClip(old, p.sources, clips[0]!.id, { gain: 0.6 }, 7);
    expect(next.audio.music).toBeNull();
    expect(next.music).toHaveLength(1);
    expect(next.music![0]).toMatchObject({ gain: 0.6, length: 30 });
    expect(next.music![0]!.meta.revision).toBe(7);
    expect(musicClipsOf(p.edit, p.sources)).toEqual([]);
  });

  it('fades ramp up and down and are silent outside the clip', () => {
    const c = clip();
    expect(musicFade(c, -0.01)).toBe(0);
    expect(musicFade(c, 10)).toBe(0);
    expect(musicFade(c, 0)).toBe(0);
    const up = [0.5, 1, 1.5, 2].map((t) => musicFade(c, t));
    for (let i = 1; i < up.length; i++) expect(up[i]!).toBeGreaterThan(up[i - 1]!);
    expect(musicFade(c, 3)).toBe(1);
    const down = [6.5, 8, 9, 9.9].map((t) => musicFade(c, t));
    for (let i = 1; i < down.length; i++) expect(down[i]!).toBeLessThan(down[i - 1]!);
    expect(musicGainAt(c, 5 + 3)).toBeCloseTo(0.5, 6);
    expect(musicGainAt(c, 4)).toBe(0);
    expect(musicSourceTime(c, 8)).toBe(5);
    // a clip with no fades still never starts on a step
    expect(musicFade(clip({ fadeIn: 0, fadeOut: 0 }), 0)).toBe(0);
    expect(musicFade(clip({ fadeIn: 0, fadeOut: 0 }), 0.05)).toBe(1);
  });

  it('does not move when footage is cut or sped up, while content-bound things do', () => {
    const p = project();
    const withClip = withMusic(p.edit, [clip({ start: 12 })]);
    const before = new TimeMap(60, [], []);
    const cut = manualCut(withClip, { start: 2, end: 8 }, 2);
    const after = new TimeMap(60, cut.cuts, [{ start: 20, end: 30, speed: 2 }]);
    expect(after.outDuration).toBeCloseTo(60 - 6 - 5, 6);
    // the same second of the finished video, the same second of the song, the same level
    expect(musicClipsOf(cut, p.sources)[0]!.start).toBe(12);
    for (const out of [12.5, 14, 20, 21.9]) {
      expect(musicGainAt(musicClipsOf(cut, p.sources)[0]!, out)).toBe(musicGainAt(clip({ start: 12 }), out));
      expect(musicSourceTime(musicClipsOf(cut, p.sources)[0]!, out)).toBe(2 + (out - 12));
    }
    // a sound effect at session second 15 lands 6 s earlier once 2–8 is cut
    const fx = addSounds(cut, [15], { builtin: 'pop', gain: 0.6 }, p.sources, meta).edit;
    expect(soundEvents({ edit: fx, sources: p.sources }, before)[0]!.at).toBeCloseTo(15, 6);
    expect(soundEvents({ edit: fx, sources: p.sources }, after)[0]!.at).toBeCloseTo(9, 6);
  });

  it('keeps a clip inside its file and its fades inside the clip', () => {
    const file = src('song', 'music', 30, 'audio');
    const fit = fitMusicClip(clip({ sourceIn: 25, length: 20, fadeIn: 8, fadeOut: 8, gain: 3, start: -4 }), file);
    expect(fit.start).toBe(0);
    expect(fit.sourceIn).toBe(25);
    expect(fit.length).toBe(5);
    expect(fit.gain).toBe(1);
    expect(fit.fadeIn + fit.fadeOut).toBeLessThanOrEqual(fit.length + 1e-9);
    expect(fit.fadeIn).toBeCloseTo(fit.fadeOut, 6);
  });

  it('a new clip is trimmed to end with the video; trimming the front keeps the rest playing where it was', () => {
    const file = src('song', 'music', 30, 'audio');
    const made = newMusicClip(file, 0, 12, meta);
    expect(made.length).toBe(12);
    expect(made.fadeOut).toBeGreaterThan(0);
    const c = clip();
    const t = trimMusicStart(c, 8);
    expect(t).toEqual({ start: 8, sourceIn: 5, length: 7 });
    expect(musicSourceTime({ ...c, ...t }, 10)).toBe(musicSourceTime(c, 10));
    // cannot reveal sound from before the file begins
    expect(trimMusicStart(c, 0).start).toBe(3);
  });

  it('ducking follows speech with padding and settles at its two levels', () => {
    const p = { transcript: { engine: 't', locale: 'en', onDevice: true, sourceId: 'cam', hasSpeech: true, generatedAt: '', words: [{ id: 'w1', text: 'hello', start: 10, end: 10.4, kind: 'word' as const }, { id: 'w2', text: 'there', start: 10.5, end: 11, kind: 'word' as const }] } };
    const w = speechWindows(p);
    expect(w).toHaveLength(1);
    expect(speakingAt(w, 9.8)).toBe(true);
    expect(speakingAt(w, 11.3)).toBe(true);
    expect(speakingAt(w, 9.7)).toBe(false);
    expect(speakingAt(w, 11.4)).toBe(false);
    let level = 1;
    for (let i = 0; i < 48000; i++) level = duckStep(level, true, 1 / 48000);
    expect(level).toBeCloseTo(DUCK_LEVEL, 3);
    for (let i = 0; i < 48000; i++) level = duckStep(level, false, 1 / 48000);
    expect(level).toBeCloseTo(1, 3);
    // one big step and many small ones agree
    expect(duckStep(1, true, 0.1)).toBeCloseTo(Array.from({ length: 100 }).reduce<number>((l) => duckStep(l, true, 0.001), 1), 6);
  });

  it('a missing music file blocks the export and removing a file removes what played it', () => {
    const p = project();
    const edit = { ...withMusic(p.edit, [clip()]), sounds: [makeSound(3, { builtin: null, sourceId: 'hit', gain: 0.5 }, p.sources, meta)] };
    const missing: Project = { ...p, edit, sources: p.sources.map((s) => (s.id === 'song' ? { ...s, available: false } : s)) };
    const pre = exportPreflight(missing, { freeBytes: 1e12, estimatedBytes: 1e6, destinationWritable: true } as never);
    expect(pre.checks.some((c) => c.id === 'missing-song' && c.level === 'block')).toBe(true);
    const gone = withoutSoundSource(edit, p.sources, 'song');
    expect(gone.music).toEqual([]);
    expect(gone.sounds).toHaveLength(1);
    expect(withoutSoundSource(gone, p.sources, 'hit').sounds).toEqual([]);
    expect(withoutSoundSource(p.edit, p.sources, 'song')).toBe(p.edit);
  });
});

describe('sound effects', () => {
  it('the built-in sounds are synthesised the same way every time, at a safe level', () => {
    expect(BUILTIN_SOUNDS.length).toBeGreaterThanOrEqual(5);
    for (const s of BUILTIN_SOUNDS) {
      const a = synthSound(s.id, 48000);
      expect(a.length).toBe(Math.round(s.duration * 48000));
      let peak = 0;
      let energy = 0;
      for (const v of a) {
        peak = Math.max(peak, Math.abs(v));
        energy += v * v;
      }
      expect(peak).toBeCloseTo(0.8, 3);
      expect(Number.isFinite(energy) && energy > 1).toBe(true);
      expect(Math.abs(a[0]!)).toBe(0);
      expect(Math.abs(a[a.length - 1]!)).toBeLessThan(0.01);
      expect(s.hit).toBeLessThan(s.duration);
      // a different rate is a different rendering of the same sound, not a different length in seconds
      expect(synthSound(s.id, 44100).length).toBe(Math.round(s.duration * 44100));
    }
    expect(synthSound('pop', 48000)).toBe(synthSound('pop', 48000));
  });

  it('a sound is dropped when its moment is cut and moves with its content otherwise', () => {
    const p = project();
    let edit = addSounds(p.edit, [5, 20, 40], { builtin: 'ding', gain: 0.5 }, p.sources, meta).edit;
    expect(edit.sounds).toHaveLength(3);
    edit = manualCut(edit, { start: 18, end: 22 }, 2);
    const map = new TimeMap(60, edit.cuts, [{ start: 0, end: 10, speed: 2 }]);
    const ev = soundEvents({ edit, sources: p.sources }, map);
    expect(ev.map((e) => e.key)).toEqual([edit.sounds![0]!.id, edit.sounds![2]!.id]);
    expect(ev[0]!.at).toBeCloseTo(2.5, 6); // session 5 at 2×
    expect(ev[1]!.at).toBeCloseTo(40 - 5 - 4, 6); // 5 s saved by the speed-up, 4 s cut
    expect(ev[1]!.moment).toBe(ev[1]!.at);
  });

  it('a riser ends on its moment and a whoosh peaks on it; a lead-in before the start is skipped, not shifted', () => {
    const p = project();
    const riser = BUILTIN_SOUNDS.find((s) => s.id === 'riser')!;
    const map = new TimeMap(60, [], []);
    const at = (t: number, id: string) => soundEvents({ edit: addSounds(p.edit, [t], { builtin: id, gain: 0.5 }, p.sources, meta).edit, sources: p.sources }, map)[0]!;
    const r = at(10, 'riser');
    expect(r.at).toBeCloseTo(10 - riser.hit, 6);
    expect(r.moment).toBe(10);
    expect(r.skip).toBe(0);
    const early = at(0.5, 'riser');
    expect(early.at).toBe(0);
    expect(early.skip).toBeCloseTo(riser.hit - 0.5, 6);
    expect(at(10, 'pop').at).toBe(10);
  });

  it('a text plays its sound when it first shows, and not at all when it is cut entirely', () => {
    const p = project();
    const [o] = overlaysFromTemplate('plain', 10, 60, meta);
    const edit = { ...p.edit, overlays: [{ ...o!, sound: { builtin: 'swish', gain: 0.4 } }] };
    const swish = BUILTIN_SOUNDS.find((s) => s.id === 'swish')!;
    expect(soundEvents({ edit, sources: p.sources }, new TimeMap(60, [], []))[0]!.moment).toBe(10);
    expect(soundEvents({ edit, sources: p.sources }, new TimeMap(60, [], []))[0]!.at).toBeCloseTo(10 - swish.hit, 6);
    // its first second is cut: it shows from where the cut lands
    const partly = new TimeMap(60, [{ start: 9, end: 11 }], []);
    expect(soundEvents({ edit, sources: p.sources }, partly)[0]!.moment).toBeCloseTo(9, 6);
    const all = new TimeMap(60, [{ start: 9, end: 20 }], []);
    expect(soundEvents({ edit, sources: p.sources }, all)).toEqual([]);
  });

  it('adds one sound per cut or view change, never two on the same moment, and one per text', () => {
    const p = project();
    let edit = manualCut(manualCut(p.edit, { start: 5, end: 7 }, 2), { start: 20, end: 25 }, 3);
    const map = new TimeMap(60, edit.cuts, [{ start: 30, end: 40, speed: 2 }]);
    // speed boundaries are not cuts
    expect(cutMoments(map)).toEqual([7, 25]);
    const first = addSounds(edit, cutMoments(map), { builtin: 'whoosh', gain: 0.5 }, p.sources, meta);
    expect(first.added).toHaveLength(2);
    const again = addSounds(first.edit, cutMoments(map), { builtin: 'whoosh', gain: 0.5 }, p.sources, meta);
    expect(again.added).toHaveLength(0);
    expect(again.edit).toBe(first.edit);
    edit = { ...edit, layouts: [{ id: 'l1', start: 10, end: 14, mode: 'camera', camera: 'A', transition: 'smooth', meta }, { id: 'l2', start: 14, end: 18, mode: 'screen', camera: 'A', transition: 'smooth', meta }] };
    expect(viewChangeMoments(edit, 60)).toEqual([10, 14, 18]);
    const texts = { ...edit, overlays: [...overlaysFromTemplate('plain', 1, 60, meta), { ...overlaysFromTemplate('plain', 30, 60, meta)[0]!, sound: { builtin: 'ding', gain: 0.2 } }] };
    const r = soundOnEveryText(texts, { builtin: 'pop', gain: 0.5 });
    expect(r.changed).toBe(1);
    expect(r.edit.overlays.map((o) => o.sound?.builtin)).toEqual(['pop', 'ding']);
  });

  it('a file used as a sound effect is never played like a song', () => {
    const p = project();
    const long = makeSound(3, { builtin: null, sourceId: 'song', gain: 0.5 }, p.sources, meta);
    expect(long.end - long.start).toBe(12);
    const ev = soundEvents({ edit: { ...p.edit, sounds: [long] }, sources: p.sources }, new TimeMap(60, [], []));
    expect(ev[0]).toMatchObject({ at: 3, duration: 12 });
    // a sound whose file has left the project is not an event
    expect(soundEvents({ edit: { ...p.edit, sounds: [{ ...long, sourceId: 'nope' }] }, sources: p.sources }, new TimeMap(60, [], []))).toEqual([]);
  });
});
