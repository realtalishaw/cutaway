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

import { buildCodexFullThumbnailPrompt, buildFullThumbnailPrompt, thumbnailFormatsBlock, THUMBNAIL_FORMATS } from '../src/index';
import { buildPackagingPrompt, parsePackaging } from '../src/index';

describe('whole thumbnails', () => {
  const base = { imagePrompt: 'Glowing Icon: a huge glowing app icon on the left; the person from image 1 on the right pointing at it. The words "I BUILT THIS" in huge white capitals, top left.', hasPhoto: true };
  it('keeps the face from the photo and the words exactly', () => {
    const p = buildFullThumbnailPrompt(base);
    expect(p).toMatch(/^YouTube thumbnail, 16:9\. Glowing Icon/);
    expect(p).toMatch(/recognisable as the same person/);
    expect(p).toMatch(/only text in the image/);
  });
  it('shows no person when there is no photo', () => {
    const p = buildFullThumbnailPrompt({ ...base, hasPhoto: false });
    expect(p).not.toMatch(/image 1/);
    expect(p).toMatch(/Do not show any person/);
  });
  it('wraps it for Codex with the answer format', () => {
    const p = buildCodexFullThumbnailPrompt({ ...base, direction: 'make the background red' });
    expect(p).toMatch(/built-in image generation tool exactly once/);
    expect(p).toMatch(/Change from before: make the background red/);
    expect(p).toMatch(/"generated": true/);
  });
  it('ships 100 formats and offers them all in the packaging prompt', () => {
    expect(THUMBNAIL_FORMATS).toHaveLength(100);
    expect(new Set(THUMBNAIL_FORMATS.map((f) => f.id)).size).toBe(100);
    expect(thumbnailFormatsBlock()).toContain('#73 Glowing Icon');
    const prompt = buildPackagingPrompt({ projectName: 'x', brief: { audience: '', notes: '' } as never, outDuration: 60, hasSpeech: true, sentences: [{ outputTime: 1, sessionTime: 1, text: 'hi' }], visualMoments: [], frames: [], paletteCount: 4, chapters: [], editSummary: '' } as never);
    expect(prompt).toContain('THUMBNAIL DESIGN');
    expect(prompt).toContain('#91 Six Arms');
    expect(prompt).toContain('"imagePrompt"');
  });
  it('reads the format and image description from a reply', () => {
    const c = { title: 'I Built My Own AI Video Editor', thumbnailText: 'I BUILT THIS', template: 'headline', frameIndex: 0, paletteIndex: 0, rationale: 'r', evidence: [], format: 73, imagePrompt: 'YouTube thumbnail…' };
    const r = parsePackaging({ concepts: [c, { ...c, format: 999 }, { ...c, format: undefined, imagePrompt: undefined }], description: '', chapters: [] }, { frameCount: 1, paletteCount: 4 });
    expect(r.concepts.map((x) => x.format)).toEqual([73, null, null]);
    expect(r.concepts[0]!.imagePrompt).toBe('YouTube thumbnail…');
    expect(r.concepts[2]!.imagePrompt).toBe('');
  });
});

describe('saved logos', async () => {
  const { logosBlock, logosNamedIn, logoNameFromFile, buildPackagingPrompt } = await import('../src/index');
  const { buildFullThumbnailPrompt } = await import('../src/provider');
  it('names a logo from its file', () => {
    expect(logoNameFromFile('/Users/me/Desktop/cutaway-icon@2x.png')).toBe('Cutaway');
    expect(logoNameFromFile('acme_studio_logo_final_v2.png')).toBe('Acme Studio');
    expect(logoNameFromFile('logo.png')).toBe('My brand');
  });
  it('tells Claude the names, and only when there are logos', () => {
    expect(logosBlock([])).toBe('');
    expect(logosBlock(undefined)).toBe('');
    const b = logosBlock(['Cutaway']);
    expect(b).toContain('"Cutaway"');
    expect(b).toContain('"the Cutaway logo"');
    expect(logosBlock(['a "b"\ninjected'])).toContain('"a  b  injected"');
  });
  it('finds the logos a description names, ignoring case', () => {
    expect(logosNamedIn('holding up the CUTAWAY logo', ['Cutaway', 'Figma'])).toEqual(['Cutaway']);
    expect(logosNamedIn('a graph', ['Cutaway'])).toEqual([]);
  });
  it('asks the image model to copy each attached logo', () => {
    const p = buildFullThumbnailPrompt({ imagePrompt: 'YouTube thumbnail, 16:9. The Cutaway logo glowing.', hasPhoto: true, logos: [{ name: 'Cutaway', image: 2 }] });
    expect(p).toContain('The Cutaway logo is image 2: copy it exactly');
  });
  it('puts the logo block in the packaging prompt', () => {
    const p = buildPackagingPrompt({ projectName: 'Demo', brief: { audience: '', notes: '' }, outDuration: 60, hasSpeech: false, sentences: [], visualMoments: [], frames: [], paletteCount: 4, chapters: [], editSummary: '', logos: ['Cutaway'] });
    expect(p).toContain("CREATOR'S LOGOS");
    expect(buildPackagingPrompt({ projectName: 'Demo', brief: { audience: '', notes: '' }, outDuration: 60, hasSpeech: false, sentences: [], visualMoments: [], frames: [], paletteCount: 4, chapters: [], editSummary: '' })).not.toContain("CREATOR'S LOGOS");
  });
});
