import { describe, expect, it } from 'vitest';
import { addTakeAsClip, clipsOf, createProject, defaultSync, isPhotoClip, photoSourcesLongEnough, projectWithEdit, setClipLength, sourceAt, withSources, type MediaSource, type Project } from '../src';

const base = (id: string, extra: Partial<MediaSource>): MediaSource => ({ id, role: 'screen', name: `${id}`, path: `/tmp/${id}`, managed: false, origin: 'import', kind: 'video', duration: 10, width: 1920, height: 1080, hasAudio: false, fingerprint: { sizeBytes: 1, duration: 10 }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [], ...extra });

/** A 10 s screen recording, then a photo shown for 5 s, then another 10 s recording with a zoom on it. */
function project(): Project {
  let p = withSources(createProject('Photos', []), [base('scr', {})]);
  p = addTakeAsClip(p, { take: 'ph', name: 'Beach', sources: [base('photo', { kind: 'image', duration: 5, width: 800, height: 1000 })] });
  p = addTakeAsClip(p, { take: 'end', name: 'End', sources: [base('scr2', {})] });
  return { ...p, edit: { ...p.edit, zooms: [{ id: 'z1', start: 17, end: 19, scale: 1.8, follow: false, x: 0.5, y: 0.5, meta: { origin: 'creator', revision: 1 } }] } };
}

describe('photos as clips', () => {
  it('a photo is a clip of its own, between the videos, for as long as it is shown', () => {
    const p = project();
    const clips = clipsOf(p);
    expect(clips.map((c) => [c.name, c.start, c.out - c.in])).toEqual([['Clip 1', 0, 10], ['Beach', 10, 5], ['End', 15, 10]]);
    expect(isPhotoClip(p, clips[1]!)).toBe(true);
    expect(isPhotoClip(p, clips[0]!)).toBe(false);
    expect(p.duration).toBe(25);
    // the photo is the picture while its clip plays
    expect(sourceAt(p, 'screen', 12)?.id).toBe('photo');
    expect(sourceAt(p, 'screen', 16)?.id).toBe('scr2');
  });

  it('showing it longer moves what comes after, with everything on it', () => {
    const p = project();
    const sources = photoSourcesLongEnough(p.sources, 'ph', 8);
    const next = projectWithEdit({ ...p, sources }, setClipLength(p, 'ph', 8));
    const clips = clipsOf(next);
    expect(clips.map((c) => [c.name, c.start, c.out - c.in])).toEqual([['Clip 1', 0, 10], ['Beach', 10, 8], ['End', 18, 10]]);
    expect(next.duration).toBe(28);
    expect(next.edit.zooms[0]).toMatchObject({ start: 20, end: 22 });
    expect(sourceAt(next, 'screen', 17.5)?.id).toBe('photo');
  });

  it('showing it shorter pulls what comes after in', () => {
    const p = project();
    const next = projectWithEdit(p, setClipLength(p, 'ph', 2));
    expect(clipsOf(next).map((c) => c.start)).toEqual([0, 10, 12]);
    expect(next.edit.zooms[0]).toMatchObject({ start: 14, end: 16 });
  });

  it("a photo's picture only ever gets longer, so undo can never leave the clip without one", () => {
    const p = project();
    expect(photoSourcesLongEnough(p.sources, 'ph', 3)).toBe(p.sources);
    const longer = photoSourcesLongEnough(p.sources, 'ph', 9);
    expect(longer.find((s) => s.id === 'photo')!.duration).toBe(9);
    expect(longer.find((s) => s.id === 'scr')).toBe(p.sources.find((s) => s.id === 'scr'));
  });
});

import { sourceFromProbe } from '../src';
describe('importing a photo', () => {
  it('keeps its pixel size, so it is shown in its own shape', () => {
    const s = sourceFromProbe({ path: '/tmp/beach.png', ok: true, kind: 'image', image: { width: 600, height: 800 } }, 'image', { managed: false, origin: 'import' });
    expect([s.width, s.height]).toEqual([600, 800]);
  });
});
