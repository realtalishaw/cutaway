import { describe, expect, it } from 'vitest';
import { suggestRole } from '../src/project';

const video = (path: string, width = 1920, height = 1080) => ({ path, kind: 'video' as const, duration: 30, video: { width, height } });

describe('suggestRole', () => {
  it('reads B-roll from the file name', () => {
    expect(suggestRole(video('/x/b-roll city.mp4'), [])).toBe('broll');
    expect(suggestRole(video('/x/stock sunset.mov'), [])).toBe('broll');
  });
  it('does not treat the app’s own name as a B-roll hint', () => {
    expect(suggestRole(video('/x/Cutaway demo recording.mp4', 2880, 1800), [])).toBe('screen');
    expect(suggestRole(video('/x/My Cutaway walkthrough.mov'), [])).not.toBe('broll');
  });
});
