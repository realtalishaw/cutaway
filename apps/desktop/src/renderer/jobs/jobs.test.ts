import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProposal, commitEdit, createProject, defaultSync, updateById, type MediaSource, type Project } from '@cutaway/core';
import type { AiRequest, AiResult, AppSettings, ClaudeStatus } from '../../shared/api';
import { JobError, clearReplyCache, generatePackaging, proposeRevision, runFirstCut, type JobContext, type StageState } from './index';

// ───────────────────────────── fixtures ─────────────────────────────

function src(role: MediaSource['role'], duration: number, extra: Partial<MediaSource> = {}): MediaSource {
  return {
    id: `src_${role}`,
    role,
    name: `${role}.mov`,
    path: `/media/${role}.mov`,
    managed: false,
    origin: 'import',
    kind: role === 'voice' ? 'audio' : 'video',
    duration,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    fingerprint: { sizeBytes: 1000, duration },
    available: true,
    cursorBaked: true,
    sync: defaultSync('reference'),
    gaps: [],
    ...extra,
  };
}

const settings = { transcription: { engine: 'auto', whisperModelPath: null, locale: 'en-US' }, claudePath: null, claudeModel: 'sonnet' } as unknown as AppSettings;

const SPEECH: [string, number, number][] = [
  ['First', 1.0, 1.3], ['open', 1.3, 1.6], ['the', 1.6, 1.7], ['export', 1.7, 2.1], ['panel.', 2.1, 2.6],
  ['um', 4.0, 4.3],
  ['Do', 6.0, 6.2], ['not', 6.2, 6.5], ['delete', 6.5, 7.0], ['this', 7.0, 7.2], ['file.', 7.2, 7.7],
  ['Now', 20.0, 20.3], ['wait', 20.3, 20.6], ['for', 20.6, 20.7], ['the', 20.7, 20.8], ['build', 20.8, 21.2], ['to', 21.2, 21.3], ['finish.', 21.3, 21.9],
  ['Then', 30.0, 30.3], ['the', 30.3, 30.4], ['export', 30.4, 30.8], ['panel', 30.8, 31.2], ['shows', 31.2, 31.5], ['the', 31.5, 31.6], ['export', 31.6, 32.0], ['result.', 32.0, 32.6],
];

interface Mock {
  api: {
    native: Record<'probe' | 'frames' | 'activity' | 'transcribe' | 'analyzeVoice' | 'correlate' | 'readCursor', ReturnType<typeof vi.fn>>;
    ai: { status: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  };
  status: ClaudeStatus;
  reply: (req: AiRequest) => AiResult | Promise<AiResult>;
}

function installMock(opts: { speech?: boolean; activity?: (t: number) => number } = {}): Mock {
  const m: Mock = {
    status: { found: true, path: '/opt/homebrew/bin/claude', version: '2.1.193', signedIn: true, message: 'ok' },
    reply: () => ({ ok: false, error: { code: 'failed', message: 'no reply configured' }, durationMs: 1 }),
    api: {
      native: {
        probe: vi.fn(async (paths: string[]) => paths.map((path) => ({ path, ok: true }))),
        frames: vi.fn(async (projectPath: string, _file: string, times: number[]) => times.map((t) => ({ t, path: `${projectPath}/cache/frames/f-${Math.round(t * 1000)}.jpg` }))),
        activity: vi.fn(async () => ({ fps: 4, samples: Array.from({ length: 160 }, (_, i) => ({ t: i / 4, change: (opts.activity ?? (() => 0))(i / 4) })) })),
        transcribe: vi.fn(async () => (opts.speech === false ? { engine: 'apple-speechanalyzer', locale: 'en-US', onDevice: true, hasSpeech: false, words: [] } : { engine: 'apple-speechanalyzer', locale: 'en-US', onDevice: true, hasSpeech: true, words: SPEECH.map(([text, start, end]) => ({ text, start, end, confidence: 0.9 })) })),
        analyzeVoice: vi.fn(async () => ({ silences: [{ start: 8, end: 19.5 }], waveform: [0.1, 0.5, 0.2], waveformHz: 20, hasSignal: true, duration: 40 })),
        correlate: vi.fn(async () => ({ offset: 0, rate: 1, confidence: 0, checkpoints: [], reliable: false })),
        readCursor: vi.fn(async () => []),
      },
      ai: {
        status: vi.fn(async () => m.status),
        run: vi.fn(async (req: AiRequest) => m.reply(req)),
        cancel: vi.fn(async () => undefined),
      },
    },
  };
  (globalThis as unknown as { window: unknown }).window = { cutaway: m.api };
  return m;
}

function makeCtx(project: Project, over: Partial<JobContext> = {}): JobContext & { state: { project: Project; stages: StageState[]; updates: number }; controller: AbortController } {
  const state = { project, stages: [] as StageState[], updates: 0 };
  const controller = new AbortController();
  return {
    state,
    controller,
    projectPath: '/lib/Demo.cutaway',
    get: () => state.project,
    update: (fn) => {
      state.project = fn(state.project);
      state.updates++;
    },
    setStages: (s) => {
      state.stages = s;
    },
    signal: controller.signal,
    settings,
    useClaude: true,
    ...over,
  };
}

const talking = () => createProject('Export panel walkthrough', [src('screen', 40, { hasAudio: false }), src('cameraA', 40)]);

beforeEach(() => clearReplyCache());

// ───────────────────────────── first cut ─────────────────────────────

describe('runFirstCut', () => {
  it('(a) edits a silent screen-only project without inventing a transcript', async () => {
    // activity for the first 5 s and the last 10 s; 25 s of frozen screen in between
    const m = installMock({ activity: (t) => (t < 5 || t >= 30 ? 0.04 : 0) });
    const ctx = makeCtx(createProject('Silent demo', [src('screen', 40, { hasAudio: false })]));
    const res = await runFirstCut(ctx);
    const p = ctx.state.project;
    expect(m.api.native.transcribe).not.toHaveBeenCalled(); // no audio at all
    expect(p.transcript).toMatchObject({ hasSpeech: false, words: [] });
    expect(p.edit.cuts.length).toBeGreaterThan(0);
    expect(p.edit.cuts.every((c) => c.start >= 5 && c.end <= 30 && c.meta.origin === 'ai')).toBe(true);
    expect(p.firstCut).not.toBeNull();
    expect(res.summary).toContain('No speech was found');
    expect(ctx.state.stages.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(ctx.state.stages.every((s) => s.progress === null)).toBe(true); // no invented percentages
    expect(p.ui.view).toBe('edit');
    expect(p.revisions.some((r) => r.label === 'AI first cut' && r.origin === 'ai')).toBe(true);
  });

  it('(a2) audio with no speech still yields zero words and an edit', async () => {
    const m = installMock({ speech: false, activity: (t) => (t < 5 || t >= 30 ? 0.04 : 0) });
    const ctx = makeCtx(createProject('Silent demo', [src('screen', 40)]), { useClaude: false });
    await runFirstCut(ctx);
    expect(m.api.native.transcribe).toHaveBeenCalledTimes(1);
    expect(ctx.state.project.transcript!.words).toEqual([]);
    expect(ctx.state.project.transcript!.hasSpeech).toBe(false);
    expect(ctx.state.project.edit.cuts.length).toBeGreaterThan(0);
  });

  it('(b) a declined-consent run never contacts Claude', async () => {
    const m = installMock({ activity: (t) => (t >= 20 && t < 24 ? 0.05 : 0) });
    const ctx = makeCtx(talking(), { useClaude: false });
    const res = await runFirstCut(ctx);
    expect(m.api.ai.run).toHaveBeenCalledTimes(0);
    expect(m.api.ai.status).toHaveBeenCalledTimes(0);
    expect(m.api.native.frames).toHaveBeenCalledTimes(0); // no stills are even prepared
    expect(res.mode).toBe('local-rules');
    expect(res.ai.fellBack).toBe(false);
    expect(ctx.state.project.firstCut!.mode).toBe('local-rules');
    expect(res.summary).toContain('Claude was not used');
    expect(ctx.state.stages.every((s) => !s.remote)).toBe(true);
    // the filler was removed, the negation was not
    const cuts = ctx.state.project.edit.cuts;
    expect(cuts.some((c) => c.kind === 'filler')).toBe(true);
    expect(cuts.some((c) => c.start < 7.7 && c.end > 6.0)).toBe(false);
    // "export panel" opens two sentences? no: only real repeats become suggestions, never cuts
    expect(ctx.state.project.transcript!.words.find((w) => w.text === 'um')!.kind).toBe('filler');
  });

  it('(c) a failed assemble keeps finished checkpoints, so the retry does not transcribe again', async () => {
    const m = installMock({ activity: (t) => (t >= 20 && t < 24 ? 0.05 : 0) });
    const ctx = makeCtx(talking(), { useClaude: false });
    const realUpdate = ctx.update;
    let failing = true;
    ctx.update = (fn) => {
      const before = ctx.state.project;
      const next = fn(before);
      if (failing && next.firstCut && !before.firstCut) throw new Error('disk full while saving the cut');
      realUpdate(() => next);
    };
    const err = await runFirstCut(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err).toMatchObject({ stage: 'assemble', code: 'failed', retryable: true });
    expect(ctx.state.stages.find((s) => s.id === 'assemble')!.status).toBe('failed');
    expect(ctx.state.stages.find((s) => s.id === 'preview')!.status).toBe('pending');
    expect(ctx.state.project.firstCut).toBeNull();
    expect(ctx.state.project.stages.transcribe).toBeDefined();
    expect(ctx.state.project.stages.visual).toBeDefined();
    expect(ctx.state.project.transcript!.words.length).toBe(SPEECH.length);

    failing = false;
    const res = await runFirstCut(ctx);
    expect(m.api.native.transcribe).toHaveBeenCalledTimes(1);
    expect(m.api.native.activity).toHaveBeenCalledTimes(1);
    expect(res.skipped).toEqual(['sync', 'transcribe', 'visual']);
    expect(res.ran).toEqual(['validate', 'assemble', 'preview']);
    expect(ctx.state.project.firstCut).not.toBeNull();
  });

  it('routes a Claude proposal through validation and reuses a paid reply on retry', async () => {
    const m = installMock({ activity: (t) => (t >= 20 && t < 24 ? 0.05 : 0) });
    m.reply = () => ({
      ok: true,
      durationMs: 5,
      data: {
        summary: 'Camera for the intro, screen for the build.',
        ops: [
          { op: 'exec', start: 0, end: 1, cmd: 'rm -rf ~' },
          { op: 'layout', start: 0, end: 5, mode: 'camera', camera: 'A', reason: 'Intro to camera' },
          { op: 'layout', start: 10, end: 20, mode: 'camera', camera: 'B', reason: 'no such camera' },
          { op: 'cut', start: 6.15, end: 6.55, kind: 'pacing', confidence: 'high', reason: 'tighten' },
          { op: 'overlay', kind: 'callout', start: 21, end: 24, text: '87% faster builds' },
          { op: 'broll', assetId: 'nope', start: 25, end: 28 },
        ],
        chapters: [{ sessionTime: 0, title: 'Open the panel' }, { sessionTime: 15, title: 'Build' }, { sessionTime: 29, title: 'Result' }],
        notes: ['Check the build wait.'],
      },
    });
    const ctx = makeCtx(talking());
    const res = await runFirstCut(ctx);
    const p = ctx.state.project;
    expect(m.api.ai.run).toHaveBeenCalledTimes(1);
    const req = m.api.ai.run.mock.calls[0]![0] as AiRequest;
    expect(req.purpose).toBe('first-cut');
    expect(req.imageDir).toBe('/lib/Demo.cutaway/cache/frames');
    expect(req.imagePaths.length).toBeGreaterThan(0);
    expect(req.imagePaths.length).toBeLessThanOrEqual(24);
    expect(req.imagePaths.every((x) => x.startsWith(`${req.imageDir}/`))).toBe(true);
    expect(req.prompt).toContain('Do not delete this file.');
    expect(res.mode).toBe('claude');
    expect(p.firstCut!.mode).toBe('claude');
    expect(res.rejected.map((r) => r.code).sort()).toEqual(['missing-asset', 'unknown-op', 'unsupported-fact']);
    expect(p.edit.layouts.some((l) => l.mode === 'camera' && l.start === 0 && l.end === 5)).toBe(true);
    expect(p.edit.layouts.every((l) => l.camera === 'A')).toBe(true); // camera B does not exist
    expect(p.edit.overlays).toHaveLength(0);
    expect(p.edit.broll).toHaveLength(0);
    // "not" was not cut: the removal became a suggestion for the creator
    expect(p.edit.cuts.some((c) => c.start < 6.5 && c.end > 6.2)).toBe(false);
    expect(p.edit.suggestions.some((s) => s.status === 'open' && s.start < 6.5 && s.end > 6.2)).toBe(true);
    expect(p.packaging.chapters).toHaveLength(3);
    expect(res.notes).toEqual(['Check the build wait.']);
    expect(ctx.state.stages.find((s) => s.id === 'assemble')!.remote).toBe(true);

    // Same inputs again (forced regeneration): the reply is reused, not paid for twice.
    await runFirstCut(ctx, { regenerate: true });
    expect(m.api.ai.run).toHaveBeenCalledTimes(1);
  });

  it('falls back to built-in rules and says so when Claude fails or is signed out', async () => {
    const m = installMock({ activity: (t) => (t >= 20 && t < 24 ? 0.05 : 0) });
    m.reply = () => ({ ok: false, error: { code: 'timeout', message: 'Claude Code did not answer in time.' }, durationMs: 9 });
    const ctx = makeCtx(talking());
    const res = await runFirstCut(ctx);
    expect(res.mode).toBe('local-rules');
    expect(res.ai.fellBack).toBe(true);
    expect(ctx.state.project.firstCut!.mode).toBe('local-rules');
    expect(res.summary).toContain('Claude was not used');
    expect(res.summary).toContain("built-in rules");

    const m2 = installMock();
    m2.status = { ...m2.status, signedIn: false };
    const ctx2 = makeCtx(talking());
    const res2 = await runFirstCut(ctx2);
    expect(m2.api.ai.run).not.toHaveBeenCalled();
    expect(res2.ai).toMatchObject({ mode: 'local-rules', fellBack: true });
    expect(res2.summary).toContain('not signed in');
  });

  it('stops with a typed error for a missing source or a cancel, keeping earlier checkpoints', async () => {
    const m = installMock();
    m.api.native.probe.mockImplementation(async (paths: string[]) => paths.map((path) => ({ path, ok: !path.includes('cameraA') })));
    const ctx = makeCtx(talking());
    await expect(runFirstCut(ctx)).rejects.toMatchObject({ stage: 'validate', code: 'missing-source' });
    expect(m.api.native.transcribe).not.toHaveBeenCalled();

    const m2 = installMock();
    const ctx2 = makeCtx(talking());
    m2.reply = async () => {
      ctx2.controller.abort();
      return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 1 };
    };
    await expect(runFirstCut(ctx2)).rejects.toMatchObject({ stage: 'assemble', code: 'cancelled' });
    expect(m2.api.ai.cancel).toHaveBeenCalled();
    expect(ctx2.state.project.stages.transcribe).toBeDefined();
    expect(ctx2.state.project.firstCut).toBeNull();
  });
});

// ───────────────────────────── packaging ─────────────────────────────

describe('generatePackaging', () => {
  async function cut(useClaude: boolean, m: Mock) {
    const ctx = makeCtx(talking(), { useClaude: false });
    await runFirstCut(ctx);
    void m;
    return makeCtx(ctx.state.project, { useClaude });
  }

  it('builds three template concepts from the project’s own words when Claude is declined', async () => {
    const m = installMock();
    const ctx = await cut(false, m);
    const res = await generatePackaging(ctx);
    const pk = ctx.state.project.packaging;
    expect(m.api.ai.run).not.toHaveBeenCalled();
    expect(res).toMatchObject({ added: 3, kept: 0 });
    expect(pk.concepts).toHaveLength(3);
    expect(pk.concepts.every((c) => c.origin === 'template' && c.title.length <= 100)).toBe(true);
    expect(new Set(pk.concepts.map((c) => c.title)).size).toBe(3);
    expect(pk.concepts[0]!.title).toBe('Export panel walkthrough');
    expect(pk.concepts.every((c) => c.layers.some((l) => l.kind === 'frame') && c.layers.some((l) => l.kind === 'text'))).toBe(true);
    expect(pk).toMatchObject({ basedOnRevision: ctx.state.project.revision, stale: false, selectedId: null });
    expect(ctx.state.stages[0]).toMatchObject({ id: 'packaging', status: 'done', remote: false });
  });

  it('keeps Claude concepts that are grounded and replaces ones that are not', async () => {
    const m = installMock();
    const ctx = await cut(true, m);
    m.reply = (req) => {
      expect(req.purpose).toBe('packaging');
      return {
        ok: true,
        durationMs: 3,
        data: {
          concepts: [
            { title: 'Why you should not delete this file', thumbnailText: 'Do not delete', template: 'headline', frameIndex: 0, paletteIndex: 1, rationale: 'The warning is the key moment.', evidence: [{ sessionTime: 6, quote: 'Do not delete this file' }, { sessionTime: 9, quote: 'I doubled my revenue' }] },
            { title: 'Export 87% faster', thumbnailText: '87% faster', template: 'banner', frameIndex: 1, paletteIndex: 2, rationale: 'x', evidence: [] },
            { title: 'Guaranteed to go viral', thumbnailText: 'Go viral', template: 'badge', frameIndex: 2, paletteIndex: 3, rationale: 'x', evidence: [] },
          ],
          description: 'A walkthrough of the export panel and the build.',
          chapters: [],
        },
      };
    };
    const res = await generatePackaging(ctx);
    const pk = ctx.state.project.packaging;
    expect(m.api.ai.run).toHaveBeenCalledTimes(1);
    expect(res.ai.mode).toBe('claude');
    expect(pk.concepts).toHaveLength(3);
    expect(pk.concepts[0]).toMatchObject({ origin: 'ai', title: 'Why you should not delete this file' });
    expect(pk.concepts[0]!.evidence).toEqual([{ sessionTime: 6, quote: 'Do not delete this file' }]); // the unspoken quote is dropped
    expect(pk.concepts[1]!.origin).toBe('template');
    expect(pk.concepts[2]!.origin).toBe('template');
    expect(res.notes).toHaveLength(2);
    expect(pk.description).toBe('A walkthrough of the export panel and the build.');
  });

  it('refresh keeps the creator’s edited concept, selection and description', async () => {
    const m = installMock();
    const ctx = await cut(false, m);
    await generatePackaging(ctx);
    const first = ctx.state.project.packaging.concepts[1]!;
    ctx.update((p) => ({ ...p, packaging: { ...p.packaging, selectedId: first.id, description: 'My own words.', stale: true, staleReason: 'cut changed', concepts: p.packaging.concepts.map((c) => (c.id === first.id ? { ...c, title: 'My title', editedByCreator: true } : c)) } }));
    const res = await generatePackaging(ctx);
    const pk = ctx.state.project.packaging;
    expect(res).toMatchObject({ added: 3, kept: 1 });
    expect(pk.concepts).toHaveLength(4);
    expect(pk.concepts[0]).toMatchObject({ id: first.id, title: 'My title', editedByCreator: true });
    expect(pk.selectedId).toBe(first.id);
    expect(pk.description).toBe('My own words.');
    expect(pk.stale).toBe(false);
  });
});

// ───────────────────────────── local revision ─────────────────────────────

describe('proposeRevision', () => {
  function withZooms(): Project {
    let p = createProject('Demo', [src('screen', 100, { hasAudio: false }), src('cameraA', 100)]);
    p = applyProposal(p, [
      { op: 'zoom', start: 10, end: 14, scale: 2 },
      { op: 'zoom', start: 46, end: 50, scale: 2 },
      { op: 'zoom', start: 52, end: 56, scale: 2 },
      { op: 'layout', start: 60, end: 70, mode: 'camera', camera: 'A' },
    ], { label: 'AI first cut' }).project;
    const manual = p.edit.zooms[0]!;
    return commitEdit(p, updateById(p.edit, 'zooms', manual.id, { scale: 1.3 }, p.revision + 1));
  }

  it('previews a local change without committing, touching only AI decisions in the section', async () => {
    installMock();
    const ctx = makeCtx(withZooms(), { useClaude: false });
    const before = ctx.state.project;
    const { preview, outcome } = await proposeRevision(ctx, { start: 45, end: 58 }, 'less movement in this section');
    expect(ctx.state.updates).toBe(0);
    expect(ctx.state.project).toBe(before);
    expect(outcome).toMatchObject({ changed: true, ai: { mode: 'local-rules' } });
    expect(outcome.understood[0]).toContain('Reduced movement');
    const inScope = preview.edit.zooms.filter((z) => z.start >= 45 && z.end <= 58);
    expect(inScope).toHaveLength(1);
    expect(inScope[0]!.scale).toBeCloseTo(1.6);
    expect(preview.edit.zooms.find((z) => z.start === 10)).toMatchObject({ scale: 1.3, meta: { origin: 'creator' } });
    expect(preview.edit.layouts).toEqual(before.edit.layouts);
    expect(preview.revisions.some((r) => r.label.startsWith('Before: Revise'))).toBe(true); // undo point
  });

  it('locks a section on "keep this" and explains what it cannot do without Claude', async () => {
    installMock();
    const ctx = makeCtx(withZooms(), { useClaude: false });
    const kept = await proposeRevision(ctx, { start: 20, end: 30 }, 'keep this explanation intact');
    expect(kept.preview.edit.locks).toHaveLength(1);
    expect(kept.preview.edit.locks[0]).toMatchObject({ start: 20, end: 30 });
    expect(ctx.state.project.edit.locks).toHaveLength(0);
    const unknown = await proposeRevision(ctx, { start: 20, end: 30 }, 'make it funnier');
    expect(unknown.outcome.changed).toBe(false);
    expect(unknown.preview).toBe(ctx.state.project);
    expect(unknown.outcome.message).toContain('needs Claude');
  });

  it('scopes a Claude revision and discards operations outside it', async () => {
    const m = installMock();
    m.reply = (req) => {
      expect(req.purpose).toBe('local-revision');
      expect(req.prompt).toContain('SECTION BEING REVISED: 45.00–58.00');
      return { ok: true, durationMs: 2, data: { understood: 'Removed the zooms here.', replace: ['zooms'], lock: false, ops: [{ op: 'zoom', start: 5, end: 20, scale: 3 }, { op: 'zoom', start: 51, end: 53, scale: 1.2 }], notes: [] } };
    };
    const ctx = makeCtx(withZooms());
    const { preview, outcome } = await proposeRevision(ctx, { start: 45, end: 58 }, 'less movement here');
    expect(outcome.ai.mode).toBe('claude');
    expect(outcome.rejected.some((r) => r.code === 'out-of-range')).toBe(true);
    expect(preview.edit.zooms.filter((z) => z.start >= 45 && z.end <= 58).map((z) => z.scale)).toEqual([1.2]);
    expect(preview.edit.zooms.find((z) => z.start === 10)!.scale).toBe(1.3);
    expect(ctx.state.updates).toBe(0);
  });
});
