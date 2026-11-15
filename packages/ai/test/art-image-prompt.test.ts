import { describe, expect, it } from 'vitest';
import { buildArtPrompt, buildImageModelArtPrompt } from '../src/provider';

const input = { title: 'I built a video editor with AI', rationale: 'Built from your project name and your own words. No AI model was used for this one.', quotes: ['so I built my own editor'], overlayText: ['I BUILT THIS'], palette: ['#ff5a36', '#ffffff'], direction: '', referenceCount: 0, variation: 0, template: 'headline' as const, notes: null };

describe('buildImageModelArtPrompt (fal.ai)', () => {
  it('describes a picture, without agent instructions, rules lists or an answer format', () => {
    const p = buildImageModelArtPrompt(input);
    expect(p).toMatch(/^A striking visual metaphor, made only of objects and scenery, for a video titled "I built a video editor with AI"/);
    expect(p).toContain('no people in it');
    expect(p).not.toMatch(/close-up(?! of one object)/);
    expect(p).toContain('right third');
    expect(p).toContain('#ff5a36');
    expect(p).toMatch(/No text, no letters, no logos/);
    expect(p).not.toMatch(/tool|JSON|RULES|shell|Reply/);
    // a template concept's "how it was made" is not the subject
    expect(p).not.toMatch(/Built from your project name/);
    expect(p.length).toBeLessThan(900);
  });
  it("puts the creator's own direction first", () => {
    expect(buildImageModelArtPrompt({ ...input, direction: 'a glowing film strip turning into code' })).toMatch(/^a glowing film strip turning into code\./);
  });
  it('leaves the Codex instructions as they were', () => {
    expect(buildArtPrompt(input)).toMatch(/built-in image generation tool/);
  });
});
