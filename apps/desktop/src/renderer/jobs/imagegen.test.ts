import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PALETTES, conceptFromTemplate, createProject, type GeneratedArt, type MediaSource, type PackagingConcept, type Project } from '@cutaway/core';
import type { AiImageRequest, AiImageResult } from '../../shared/api';
import { ART_PROVIDER, artAllowed, artInUse, artPromptInput, artReferences, generateArt, withArt, withoutArt } from './imagegen';
import { claudeGate } from './shared';
import type { JobContext } from './types';

const src = (role: MediaSource['role'], duration: number): MediaSource =>
  ({ id: `src_${role}`, role, kind: 'video', name: `${role}.mov`, path: `media/${role}.mov`, managed: true, duration, width: 1920, height: 1080, fps: 30, hasAudio: true, available: true, sync: { offset: 0, rate: 1, method: 'recorded', confidence: 1, status: 'aligned', checkpoints: [], confirmedByCreator: true }, cursorBaked: false }) as unknown as MediaSource;

function setup(): { project: Project; concept: PackagingConcept } {
  const project = createProject('Export walkthrough', [src('screen', 40), src('cameraA', 40)]);
  const concept = conceptFromTemplate('headline', 'Export settings explained', 'EXPORT RIGHT', { sourceId: 'src_screen', time: 12 }, PALETTES[1]!, 'Shows the export panel and the one setting people miss.', [{ sessionTime: 12, quote: 'do not delete this file' }], 'ai');
  return { project, concept };
}

const art = (n: number): GeneratedArt => ({ id: `art_${n}`, path: `media/generated/art-${n}.png`, provider: ART_PROVIDER.consent, note: `picture ${n}`, direction: '', at: '2026-11-13T00:00:00.000Z' });

let generateImage: ReturnType<typeof vi.fn>;
let frames: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
beforeEach(() => {
  generateImage = vi.fn(async (req: AiImageRequest): Promise<AiImageResult> => ({ ok: true, path: `media/generated/${req.id}.png`, note: 'A desk at night.', durationMs: 31000, provider: 'codex' }));
  frames = vi.fn(async (projectPath: string, _file: string, times: number[]) => times.map((t) => ({ t, path: `${projectPath}/cache/frames/f-${Math.round(t * 1000)}.jpg` })));
  cancel = vi.fn(async () => undefined);
  (globalThis as unknown as { window: unknown }).window = { cutaway: { ai: { generateImage, cancel, status: vi.fn(async () => ({ found: true, path: '/x/codex', version: '0.160.0', signedIn: true, message: 'ok', provider: 'codex' })) }, native: { frames } } };
});

describe('thumbnail art', () => {
  it('is its own permission, tied to the image provider', () => {
    const { project } = setup();
    expect(artAllowed(project)).toBe(false);
    expect(artAllowed({ ...project, consent: { provider: 'Anthropic via local Claude Code', scope: ['transcript', 'frames', 'edit-metadata'], grantedAt: 'x' } })).toBe(false);
    expect(artAllowed({ ...project, artConsent: { provider: 'Anthropic via local Claude Code', grantedAt: 'x' } })).toBe(false);
    expect(artAllowed({ ...project, artConsent: { provider: 'OpenAI via local Codex', grantedAt: 'x' } })).toBe(true);
  });

  it('sends nothing without that permission', async () => {
    const { project, concept } = setup();
    const r = await generateArt({ projectPath: '/lib/Demo.cutaway', project, concept, direction: '', signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: false, code: 'no-consent' });
    expect(generateImage).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
  });

  it('builds the request from the concept: its frame as reference, its text kept out of the picture', async () => {
    const { project, concept } = setup();
    const allowed = { ...project, artConsent: { provider: ART_PROVIDER.consent, grantedAt: 'x' } };
    expect(artReferences(concept)).toEqual([{ sourceId: 'src_screen', time: 12 }]);
    const input = artPromptInput(concept, 'a desk at night', 1, 0);
    expect(input.overlayText.join(' ')).toMatch(/EXPORT RIGHT/i);
    expect(input.quotes).toEqual(['do not delete this file']);
    const r = await generateArt({ projectPath: '/lib/Demo.cutaway', project: allowed, concept, direction: ' a desk at night ', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    const req = generateImage.mock.calls[0]![0] as AiImageRequest;
    expect(req.projectPath).toBe('/lib/Demo.cutaway');
    expect(req.referencePaths).toEqual(['/lib/Demo.cutaway/cache/frames/f-12000.jpg']);
    expect(req.prompt).toContain('Its title is "Export settings explained"');
    expect(req.prompt).toContain('a desk at night');
    expect(req.prompt).toMatch(/No words, letters, numbers/);
    expect(req.prompt).toMatch(/no realistic human faces/);
    expect(req.prompt).toMatch(/No logos/);
    if (r.ok) expect(r.art).toMatchObject({ provider: 'OpenAI via local Codex', note: 'A desk at night.', direction: 'a desk at night', path: expect.stringMatching(/^media\/generated\//) });
  });

  it('reports a failure or a cancel without changing anything', async () => {
    const { project, concept } = setup();
    const allowed = { ...project, artConsent: { provider: ART_PROVIDER.consent, grantedAt: 'x' } };
    generateImage.mockResolvedValueOnce({ ok: false, error: { code: 'failed', message: 'Codex answered, but no picture was made.' }, durationMs: 9, provider: 'codex' });
    expect(await generateArt({ projectPath: '/p.cutaway', project: allowed, concept, direction: '', signal: new AbortController().signal })).toMatchObject({ ok: false, message: 'Codex answered, but no picture was made.' });
    const ac = new AbortController();
    generateImage.mockImplementationOnce(async () => {
      ac.abort();
      return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 1, provider: 'codex' };
    });
    expect(await generateArt({ projectPath: '/p.cutaway', project: allowed, concept, direction: '', signal: ac.signal })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('places the picture above the video frame and below the shade and text, one at a time, labelled', () => {
    const { concept } = setup();
    const kinds = (ls: PackagingConcept['layers']) => ls.map((l) => (l.kind === 'image' && l.generated ? 'art' : l.kind));
    const before = kinds(concept.layers);
    const one = withArt(concept.layers, art(1));
    const at = kinds(one).indexOf('art');
    expect(at).toBe(kinds(one).lastIndexOf('frame') + 1);
    expect(kinds(one).slice(at + 1)).not.toContain('frame');
    expect(kinds(one).filter((k) => k === 'text').length).toBe(before.filter((k) => k === 'text').length);
    const layer = artInUse({ ...concept, layers: one })!;
    expect(layer).toMatchObject({ path: 'media/generated/art-1.png', x: 0.5, y: 0.5, scale: 1, generated: { provider: 'OpenAI via local Codex', note: 'picture 1' } });
    const two = withArt(one, art(2));
    expect(kinds(two).filter((k) => k === 'art')).toHaveLength(1);
    expect(artInUse({ ...concept, layers: two })!.path).toBe('media/generated/art-2.png');
    expect(kinds(withoutArt(two))).toEqual(before);
    expect(artInUse(concept)).toBeNull();
  });
});

describe('the gate names whichever provider is in use', () => {
  const ctx = (over: Partial<JobContext>) => ({ useClaude: true, signal: new AbortController().signal, ...over }) as JobContext;
  it('uses the provider the main process reports', async () => {
    expect(await claudeGate(ctx({}))).toMatchObject({ usable: true, provider: 'codex', name: 'Codex', app: 'Codex' });
  });
  it('asks nothing of either app when the creator declined', async () => {
    const status = (globalThis as unknown as { window: { cutaway: { ai: { status: ReturnType<typeof vi.fn> } } } }).window.cutaway.ai.status;
    expect(await claudeGate(ctx({ useClaude: false, provider: 'codex' }))).toMatchObject({ usable: false, fellBack: false, reason: expect.stringMatching(/^Codex was not used/) });
    expect(await claudeGate(ctx({ useClaude: false }))).toMatchObject({ reason: expect.stringMatching(/^Claude was not used/) });
    expect(status).not.toHaveBeenCalled();
  });
});

describe('whole AI thumbnails', async () => {
  const { applyWholeThumbnail, isWholeThumbnail, withoutWholeThumbnail, fallbackImagePrompt } = await import('./imagegen');
  const base = { id: 'c1', title: 'I Built My Own AI Video Editor', layers: [{ id: 't', kind: 'text', text: 'I BUILT THIS', x: 0.1, y: 0.2, size: 0.2, color: '#fff', font: 'display', weight: 800, align: 'left', stroke: null, background: null, rotation: 0, uppercase: true } as never], rationale: '', evidence: [], origin: 'ai' as const, editedByCreator: false };
  const art = (n: number) => ({ id: `a${n}`, path: `media/generated/image-${n}.png`, provider: 'fal.ai with your own key', note: '', direction: '', at: '2026-11-15T00:00:00Z', kind: 'thumbnail' as const });
  it('replaces the layers with one picture and keeps the earlier layers to go back to', () => {
    const one = applyWholeThumbnail(base, art(1));
    expect(isWholeThumbnail(one)).toBe(true);
    expect(one.layers).toHaveLength(1);
    expect(one.baseLayers).toEqual(base.layers);
    // a second picture keeps the original layers, not the first picture
    const two = applyWholeThumbnail(one, art(2));
    expect(two.baseLayers).toEqual(base.layers);
    expect(two.art).toHaveLength(2);
    expect(withoutWholeThumbnail(two).layers).toEqual(base.layers);
  });
  it('describes a whole thumbnail for concepts no AI designed', () => {
    expect(fallbackImagePrompt(base)).toMatch(/^YouTube thumbnail, 16:9\. The person from image 1/);
    expect(fallbackImagePrompt(base)).toContain('"I BUILT THIS"');
  });
});
