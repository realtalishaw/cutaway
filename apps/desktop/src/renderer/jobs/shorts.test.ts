import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, defaultSync, newShort, addShorts, type MediaSource, type Project, type Word } from '@cutaway/core';
import type { AiRequest, AiResult, AppSettings } from '../../shared/api';
import { findShorts, keptSentences } from './shorts';
import { clearReplyCache } from './shared';
import { JobError, type JobContext } from './types';

function src(role: MediaSource['role'], duration: number): MediaSource {
  return { id: `src_${role}`, role, name: `${role}.mov`, path: `/media/${role}.mov`, managed: false, origin: 'import', kind: 'video', duration, width: 1920, height: 1080, fps: 30, hasAudio: true, fingerprint: { sizeBytes: 1000, duration }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [] } as MediaSource;
}

const settings = { claudePath: null, claudeModel: 'sonnet', playbookNotes: { titles: 'Never use the word hack.' } } as unknown as AppSettings;

/** 120 s of talk: forty sentences of six words, one every three seconds. Sentence 4 asks a question. */
function project(): Project {
  const words: Word[] = [];
  for (let k = 0; k < 40; k++) {
    const text = k === 4 ? 'Why does this look so soft?' : 'here is one more plain line.';
    text.split(' ').forEach((w, i) => words.push({ id: `w${k}_${i}`, text: w, start: k * 3 + 0.2 + i * 0.4, end: k * 3 + 0.52 + i * 0.4, kind: 'word' }));
  }
  const p = createProject('Soft exports', [src('screen', 120), src('cameraA', 120)]);
  return { ...p, duration: 120, transcript: { engine: 'test', locale: 'en-US', onDevice: true, sourceId: 'src_cameraA', hasSpeech: true, words, generatedAt: '' } };
}

function install(reply: (req: AiRequest) => AiResult | Promise<AiResult>, signedIn = true) {
  const api = { ai: { status: vi.fn(async () => ({ found: true, path: '/x/claude', version: '1', signedIn, message: '', provider: 'claude' })), run: vi.fn(async (req: AiRequest) => reply(req)), cancel: vi.fn(async () => undefined) } };
  (globalThis as unknown as { window: unknown }).window = { cutaway: api };
  return api;
}

function ctxOf(p: Project, over: Partial<JobContext> = {}) {
  const state = { project: p };
  const controller = new AbortController();
  const ctx: JobContext = { projectPath: '/lib/Demo.cutaway', get: () => state.project, update: (fn) => void (state.project = fn(state.project)), setStages: () => undefined, signal: controller.signal, settings, useClaude: true, ...over };
  return { ctx, state, controller };
}

const ok = (data: unknown): AiResult => ({ ok: true, data, durationMs: 5 });

beforeEach(() => clearReplyCache());

describe('findShorts', () => {
  it('asks the provider with text only and returns validated candidates, changing nothing', async () => {
    const p = project();
    const api = install(() => ok({ shorts: [{ title: 'Why it looks soft', start: 12.4, end: 44, hook: 'x', reason: 'A question and its answer.' }, { title: 'Past the end', start: 300, end: 340, hook: '', reason: '' }] }));
    const { ctx, state } = ctxOf(p);
    const r = await findShorts(ctx, 4);
    expect(r.ai).toMatchObject({ mode: 'claude', provider: 'claude', fellBack: false });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ title: 'Why it looks soft', hook: 'Why does this look so soft?' });
    expect(r.candidates[0]!.start).toBeCloseTo(12.0, 2);
    expect(r.note).toMatch(/Proposed by Claude/);
    expect(r.note).toMatch(/1 proposal was left out/);
    expect(state.project).toBe(p);
    const req = api.ai.run.mock.calls[0]![0] as AiRequest;
    expect(req.purpose).toBe('packaging');
    expect(req.imagePaths).toEqual([]);
    expect(req.imageDir).toBeNull();
    expect(req.prompt).toContain('Why does this look so soft?');
    expect(req.prompt).toContain('Never use the word hack.');
    expect(req.prompt).toContain('up to 4 stretches');
  });

  it('declined: the provider is not even asked whether it is signed in, and the rules answer', async () => {
    const api = install(() => ok({ shorts: [] }));
    const { ctx } = ctxOf(project(), { useClaude: false });
    const r = await findShorts(ctx);
    expect(api.ai.status).not.toHaveBeenCalled();
    expect(api.ai.run).not.toHaveBeenCalled();
    expect(r.ai).toMatchObject({ mode: 'local-rules', fellBack: false });
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    expect(r.candidates.some((c) => c.hook === 'Why does this look so soft?')).toBe(true);
    expect(r.note).toMatch(/nothing was sent off this Mac/);
    expect(r.note).toMatch(/built-in rules/);
  });

  it('falls back to the rules, and says why, when the provider is signed out, fails, or proposes nothing usable', async () => {
    const out = install(() => ok({}), false);
    const a = await findShorts(ctxOf(project()).ctx);
    expect(out.ai.run).not.toHaveBeenCalled();
    expect(a.ai).toMatchObject({ mode: 'local-rules', fellBack: true });
    expect(a.note).toMatch(/not signed in/);

    install(() => ({ ok: false, error: { code: 'failed', message: 'The CLI crashed.' }, durationMs: 1 }));
    const b = await findShorts(ctxOf(project()).ctx);
    expect(b.ai.fellBack).toBe(true);
    expect(b.note).toMatch(/The CLI crashed/);
    expect(b.candidates.length).toBeGreaterThan(0);

    install(() => ok({ shorts: [{ title: 't', start: 500, end: 600, hook: '', reason: '' }] }));
    const c = await findShorts(ctxOf(project()).ctx);
    expect(c.ai.fellBack).toBe(true);
    expect(c.note).toMatch(/outside the video/);

    clearReplyCache(); // the same request would otherwise reuse the reply above
    install(() => ok('not an object'));
    const d = await findShorts(ctxOf(project()).ctx);
    expect(d.ai.mode).toBe('local-rules');
    expect(d.note).toMatch(/no list of shorts/);
  });

  it('does not propose a range that is already a short', async () => {
    const p0 = project();
    const p = addShorts(p0, [newShort(p0, { start: 12, end: 44.82, title: 'kept' }, 'creator')]);
    const api = install(() => ok({ shorts: [{ title: 'Again', start: 12.4, end: 44, hook: '', reason: '' }, { title: 'Later', start: 60.3, end: 92, hook: '', reason: '' }] }));
    const r = await findShorts(ctxOf(p).ctx);
    expect(r.candidates.map((c) => c.title)).toEqual(['Later']);
    expect((api.ai.run.mock.calls[0]![0] as AiRequest).prompt).toMatch(/ALREADY SHORTS[^\n]*12\.00–44\.82/);
  });

  it('a cancel is a cancel, not a fallback', async () => {
    const { ctx, controller } = ctxOf(project());
    install(async () => {
      controller.abort();
      return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 1 };
    });
    await expect(findShorts(ctx)).rejects.toBeInstanceOf(JobError);
  });

  it('sends only sentences that are still in the video', () => {
    const p = project();
    const cut = { ...p, edit: { ...p.edit, cuts: [{ id: 'c', start: 11.9, end: 15.1, kind: 'manual' as const, meta: { origin: 'creator' as const, revision: 1 } }] } };
    const texts = keptSentences(cut).map((s) => s.text);
    expect(texts).toHaveLength(39);
    expect(texts).not.toContain('Why does this look so soft?');
  });
});
