import { describe, expect, it } from 'vitest';
import { defaultSync, fitMusicClip, musicGainAt, musicSourceTime, sliceVolume, splitMusicClip, trimMusicStart, volumeAt, type MediaSource, type MusicClip } from '../src';

const file: MediaSource = { id: 'song', role: 'music', name: 'song.m4a', path: '/tmp/song.m4a', managed: false, origin: 'import', kind: 'audio', duration: 30, hasAudio: true, fingerprint: { sizeBytes: 1, duration: 30 }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [] };
const clip = (o: Partial<MusicClip> = {}): MusicClip => ({ id: 'mus_1', sourceId: 'song', start: 5, sourceIn: 2, length: 20, gain: 0.5, fadeIn: 1, fadeOut: 2, duck: false, meta: { origin: 'creator', revision: 1 }, ...o });

describe('volume points', () => {
  it('are flat without points, straight between them and held beyond them', () => {
    expect(volumeAt(undefined, 3)).toBe(1);
    const pts = [{ t: 2, level: 1 }, { t: 4, level: 0.2 }];
    expect(volumeAt(pts, 0)).toBe(1);
    expect(volumeAt(pts, 3)).toBeCloseTo(0.6, 9);
    expect(volumeAt(pts, 10)).toBeCloseTo(0.2, 9);
  });

  it('multiply the clip level, fades included', () => {
    const c = clip({ volume: [{ t: 5, level: 1 }, { t: 6, level: 0.5 }] });
    expect(musicGainAt(c, c.start + 4)).toBeCloseTo(0.5, 9);
    expect(musicGainAt(c, c.start + 8)).toBeCloseTo(0.25, 9);
  });

  it('are sorted, clamped, and kept past a trimmed end so dragging it back restores them', () => {
    const fit = fitMusicClip(clip({ length: 5, volume: [{ t: 12, level: 9 }, { t: 1, level: -1 }] }), file);
    expect(fit.volume).toEqual([{ t: 1, level: 0 }, { t: 12, level: 2 }]);
  });

  it('move with the music when the start is trimmed', () => {
    const c = clip({ volume: [{ t: 6, level: 0.3 }] });
    const trimmed = { ...c, ...trimMusicStart(c, c.start + 4) };
    expect(trimmed.volume![0]!.t).toBeCloseTo(2, 9);
    expect(musicGainAt(trimmed, c.start + 6)).toBeCloseTo(musicGainAt(c, c.start + 6), 9);
  });

  it('a slice pins the level at both of its ends', () => {
    const s = sliceVolume([{ t: 0, level: 1 }, { t: 10, level: 0 }], 5, 8)!;
    expect(s[0]).toEqual({ t: 0, level: 0.5 });
    expect(s[1]!.t).toBe(3);
    expect(s[1]!.level).toBeCloseTo(0.2, 9);
  });
});

describe('splitting a music clip', () => {
  it('gives two clips that play exactly as the one did, away from the join', () => {
    const c = clip({ volume: [{ t: 3, level: 1 }, { t: 15, level: 0.2 }] });
    const [a, b] = splitMusicClip(c, 13)!;
    expect(a.id).toBe(c.id);
    expect(b.id).not.toBe(c.id);
    expect(a.start + a.length).toBeCloseTo(b.start, 9);
    expect(b.sourceIn).toBeCloseTo(c.sourceIn + 8, 9);
    for (const out of [6, 9, 12.9, 13.1, 17, 24]) {
      const part = out < 13 ? a : b;
      expect(musicGainAt(part, out)).toBeCloseTo(musicGainAt(c, out), 6);
      expect(musicSourceTime(part, out)).toBeCloseTo(musicSourceTime(c, out), 9);
    }
  });

  it('refuses a split too near either end', () => {
    expect(splitMusicClip(clip(), 5.1)).toBeNull();
    expect(splitMusicClip(clip(), 24.9)).toBeNull();
  });
});

describe('looping music', () => {
  it('may run longer than its file, and starts the file again each time it runs out', () => {
    expect(fitMusicClip(clip({ length: 100 }), file).length).toBe(28);
    const c = fitMusicClip(clip({ length: 100, loop: true }), file);
    expect(c.length).toBe(100);
    expect(musicSourceTime(c, c.start + 27, 30)).toBeCloseTo(29, 9);
    expect(musicSourceTime(c, c.start + 29, 30)).toBeCloseTo(1, 9);
    expect(musicSourceTime(c, c.start + 59, 30)).toBeCloseTo(1, 9);
  });

  it('dips for a few milliseconds at each join, so it never clicks, and is untouched elsewhere', () => {
    const c = fitMusicClip(clip({ length: 100, loop: true, fadeIn: 0, fadeOut: 0 }), file);
    const join = c.start + (30 - c.sourceIn);
    expect(musicGainAt(c, join, 30)).toBeCloseTo(0, 6);
    expect(musicGainAt(c, join + 30, 30)).toBeCloseTo(0, 6);
    expect(musicGainAt(c, join + 0.5, 30)).toBeCloseTo(c.gain, 9);
    expect(musicGainAt(c, join - 0.5, 30)).toBeCloseTo(c.gain, 9);
  });

  it('a later part of a split looping clip begins at the same place in the file', () => {
    const c = fitMusicClip(clip({ length: 100, loop: true }), file);
    const [, b] = splitMusicClip(c, c.start + 40)!;
    const fit = fitMusicClip(b, file);
    expect(fit.sourceIn).toBeCloseTo((2 + 40) % 30, 9);
    expect(musicSourceTime(fit, c.start + 50, 30)).toBeCloseTo(musicSourceTime(c, c.start + 50, 30), 9);
  });
});

import { createProject, withSources } from '../src';

describe('a voice file turned into music', () => {
  it('stops being the master voice', () => {
    const voice: MediaSource = { ...file, id: 'alice', role: 'voice', name: 'alice.mp3', duration: 57 };
    const screen: MediaSource = { ...file, id: 'scr', role: 'screen', kind: 'video', name: 'screen.mov', duration: 19, hasAudio: false };
    const p = createProject('t', [screen, voice]);
    expect(p.edit.audio.masterVoiceId).toBe('alice');
    const next = withSources(p, p.sources.map((s) => (s.id === 'alice' ? { ...s, role: 'music' as const } : s)));
    expect(next.edit.audio.masterVoiceId).not.toBe('alice');
  });
});

import { parseMotionMeta, withFieldDefaults, motionPixels, clampBox } from '../src';
describe('animations', () => {
  const page = `<html><head><script type="application/json" id="cutaway-motion">{"name":"Tag","duration":3,"placement":"box","box":{"x":0.9,"y":0.1,"w":0.3,"h":0.2},"fields":[{"id":"name","label":"Name","type":"text","default":"Ada"}],"sounds":[{"t":0.2,"sound":"pop"},{"t":0.3,"sound":"boom"}]}</script></head><body></body></html>`;
  it('reads the page’s declaration, keeping a box inside the frame and refusing unknown sounds', () => {
    const { meta, problems } = parseMotionMeta(page);
    expect(meta).toMatchObject({ name: 'Tag', duration: 3, placement: 'box', box: { x: 0.7, y: 0.1, w: 0.3, h: 0.2 } });
    expect(meta!.sounds).toEqual([{ t: 0.2, sound: 'pop' }]);
    expect(problems.join(' ')).toMatch(/boom/);
  });
  it('saving as a template keeps the words the creator set', () => {
    expect(parseMotionMeta(withFieldDefaults(page, { name: 'Grace' }, 'Grace tag')).meta).toMatchObject({ name: 'Grace tag', fields: [{ id: 'name', value: 'Grace' }] });
  });
  it('a boxed animation is rendered at its box’s size, in even pixels', () => {
    expect(motionPixels({ box: { x: 0.25, y: 0.5, w: 0.3333, h: 0.1 } }, 1920, 1080)).toEqual({ x: 480, y: 540, width: 640, height: 108 });
    expect(motionPixels({}, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(clampBox({ x: -0.2, y: 0.95, w: 0.01, h: 0.5 })).toEqual({ x: 0, y: 0.5, w: 0.04, h: 0.5 });
  });
});
