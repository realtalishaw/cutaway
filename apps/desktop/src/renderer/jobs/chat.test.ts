import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addLock, appendChat, applyOps, applyProposal, commitEdit, createProject, defaultSync, type ChatMessage, type MediaSource, type Project } from '@cutaway/core';
import type { AiRequest, AiResult, AppSettings } from '../../shared/api';
import { answerChat } from './chat';
import { clearReplyCache } from './shared';
import { JobError, type JobContext } from './types';

function src(role: MediaSource['role'], duration: number): MediaSource {
  return { id: `src_${role}`, role, name: `${role}.mov`, path: `/media/${role}.mov`, managed: false, origin: 'import', kind: 'video', duration, width: 1920, height: 1080, fps: 30, hasAudio: true, fingerprint: { sizeBytes: 1000, duration }, available: true, cursorBaked: true, sync: defaultSync('reference'), gaps: [] };
}

const settings = { claudePath: null, claudeModel: 'sonnet', playbookNotes: { editing: 'Never zoom on the terminal.' } } as unknown as AppSettings;

/** 40 s screen + camera: two AI zooms, one zoom the creator made, a locked range. */
function project(): Project {
  let p = createProject('Export walkthrough', [src('screen', 40), src('cameraA', 40)]);
  p = applyProposal(p, [{ op: 'zoom', start: 2, end: 6, scale: 1.8, x: 0.3, y: 0.3, reason: 'settings' }, { op: 'zoom', start: 14, end: 18, scale: 2, x: 0.7, y: 0.5, reason: 'format' }], { label: 'AI first cut' }).project;
  p = commitEdit(p, applyOps(p.edit, [{ op: 'zoom', start: 24, end: 27, scale: 1.5 }], 'creator', p.revision + 1));
  return commitEdit(p, addLock(p.edit, { start: 30, end: 34 }, 'keep'));
}

function install(reply: (req: AiRequest) => AiResult | Promise<AiResult>, signedIn = true) {
  const api = {
    native: { frames: vi.fn(async (projectPath: string, _file: string, times: number[]) => times.map((t) => ({ t, path: `${projectPath}/cache/frames/f-${Math.round(t * 1000)}.jpg` }))) },
    ai: { status: vi.fn(async () => ({ found: true, path: '/x/claude', version: '1', signedIn, message: '', provider: 'claude' })), run: vi.fn(async (req: AiRequest) => reply(req)), cancel: vi.fn(async () => undefined) },
  };
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

describe('answerChat', () => {
  it('turns a model reply into cards without changing the project', async () => {
    const p = project();
    const api = install((req) => {
      const d1 = /- (D\d+) \[zooms\] 2\.00–6\.00/.exec(req.prompt)![1];
      return ok({ reply: 'I would drop the early zoom.', edits: [{ op: 'zoom', start: 8, end: 11, scale: 1.6, reason: 'The export button.' }, { op: 'cut', start: 31, end: 33, kind: 'pacing', reason: 'slow' }], remove: [d1, 'D42'] });
    });
    const { ctx, state } = ctxOf(p);
    const m = await answerChat(ctx, '  Remove the zooms in the first ten seconds ', null);
    expect(m).toMatchObject({ role: 'assistant', mode: 'claude', text: 'I would drop the early zoom.', scope: null });
    expect(m.items!.map((i) => [i.kind, i.status])).toEqual([['remove', 'open'], ['add', 'open'], ['add', 'refused']]);
    expect(m.items![0]!.remove).toEqual({ lane: 'zooms', id: p.edit.zooms[0]!.id });
    expect(m.items![2]!.note).toMatch(/locked/i);
    expect(state.project).toBe(p);
    const req = api.ai.run.mock.calls[0]![0] as AiRequest;
    expect(req.purpose).toBe('local-revision');
    expect(req.prompt).toContain('<request>\nRemove the zooms in the first ten seconds\n</request>');
    expect(req.prompt).toContain('Never zoom on the terminal.');
    expect(req.prompt).toContain('SCOPE: the whole video.');
    // a whole-video request sends no stills
    expect(req.imagePaths).toEqual([]);
    expect(api.native.frames).not.toHaveBeenCalled();
  });

  it('for a short selected section sends a few stills and confines the proposal to it', async () => {
    const api = install(() => ok({ reply: 'Screen only here.', edits: [{ op: 'layout', start: 12, end: 20, mode: 'screen', reason: 'r' }, { op: 'zoom', start: 25, end: 28, scale: 2, reason: 'outside' }], remove: [] }));
    const { ctx } = ctxOf(project());
    const m = await answerChat(ctx, 'Show only the screen here', { start: 20, end: 12 });
    expect(m.scope).toEqual({ start: 12, end: 20 });
    expect(m.items!.map((i) => i.status)).toEqual(['open', 'refused']);
    const req = api.ai.run.mock.calls[0]![0] as AiRequest;
    expect(req.prompt).toContain('SECTION THE CREATOR SELECTED: 12.00–20.00');
    expect(req.imagePaths).toHaveLength(3);
    expect(req.imageDir).toBe('/lib/Demo.cutaway/cache/frames');
    // only the decisions inside the section are offered
    expect(req.prompt).toContain('[zooms] 14.00–18.00');
    expect(req.prompt).not.toContain('[zooms] 2.00–6.00');
  });

  it('gives the model a digest of the earlier turns, not the request twice', async () => {
    const turn = (m: Partial<ChatMessage>): ChatMessage => ({ id: `m${Math.random()}`, role: 'creator', text: '', at: '2026-01-01T00:00:00Z', scope: null, ...m });
    let p = project();
    p = appendChat(p, turn({ text: 'Remove the zooms early on' }));
    p = appendChat(p, turn({ role: 'assistant', text: 'I would drop one.', items: [{ id: 'i', kind: 'remove', range: { start: 2, end: 6 }, what: 'Remove the zoom', why: '', status: 'applied' }] }));
    p = appendChat(p, turn({ text: 'Actually bring one back' }));
    const api = install(() => ok({ reply: 'ok', edits: [], remove: [] }));
    await answerChat(ctxOf(p).ctx, 'Actually bring one back', null);
    const prompt = (api.ai.run.mock.calls[0]![0] as AiRequest).prompt;
    const convo = prompt.slice(prompt.indexOf('<conversation>\n'), prompt.indexOf('</conversation>'));
    expect(convo).toContain('Creator: Remove the zooms early on');
    expect(convo).toContain('You: I would drop one. [1 applied (Remove the zoom at 0:02)]');
    expect(convo).not.toContain('Actually bring one back');
  });

  it('answers a question with moments and no cards', async () => {
    install(() => ok({ reply: 'It drags twice.', edits: [], remove: [], moments: [{ start: 9, end: 12, note: 'A long wait.' }] }));
    const m = await answerChat(ctxOf(project()).ctx, 'Where does it drag?', null);
    expect(m.items).toEqual([]);
    expect(m.moments).toEqual([{ start: 9, end: 12, note: 'A long wait.' }]);
  });

  it('stays on this Mac when the creator declined: the built-in rules offer what they can do', async () => {
    const api = install(() => ok({}));
    const m = await answerChat(ctxOf(project(), { useClaude: false }).ctx, 'no zooms please', null);
    expect(api.ai.run).not.toHaveBeenCalled();
    expect(api.ai.status).not.toHaveBeenCalled();
    expect(m.mode).toBe('local-rules');
    expect(m.items).toHaveLength(1);
    expect(m.items![0]).toMatchObject({ kind: 'rules', status: 'open', rules: { instruction: 'no zooms please', scope: { start: 0, end: 40 } } });
    expect(m.items![0]!.what).toMatch(/Removed 2 automatic zooms/);
  });

  it('says what the rules cannot do instead of pretending', async () => {
    install(() => ok({}), false);
    const m = await answerChat(ctxOf(project()).ctx, 'Write me a better intro', null);
    expect(m.mode).toBe('local-rules');
    expect(m.items ?? []).toHaveLength(0);
    expect(m.text).toMatch(/not signed in/);
    expect(m.text).toMatch(/less movement/);
  });

  it('falls back to the rules, with the reason, when the reply cannot be used', async () => {
    install(() => ok({ reply: '', edits: [], remove: [] }));
    const m = await answerChat(ctxOf(project()).ctx, 'fewer zooms', null);
    expect(m.mode).toBe('local-rules');
    expect(m.text).toMatch(/could not be used/);
    expect(m.items).toHaveLength(1);
    install(() => ({ ok: false, error: { code: 'failed', message: 'The CLI crashed.' }, durationMs: 1 }));
    clearReplyCache();
    const n = await answerChat(ctxOf(project()).ctx, 'fewer zooms', null);
    expect(n.text).toMatch(/The CLI crashed\./);
  });

  it('stops cleanly when cancelled and refuses an empty message', async () => {
    install(() => ({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 1 }));
    await expect(answerChat(ctxOf(project()).ctx, 'fewer zooms', null)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(answerChat(ctxOf(project()).ctx, '   ', null)).rejects.toBeInstanceOf(JobError);
  });
});
