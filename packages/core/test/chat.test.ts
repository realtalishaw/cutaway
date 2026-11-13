import { describe, expect, it } from 'vitest';
import {
  addLock,
  appendChat,
  applyChatItems,
  applyOps,
  applyProposal,
  chatDigest,
  checkpoint,
  commitEdit,
  createProject,
  decisionHandles,
  defaultSync,
  diffSummary,
  findCheckpoint,
  historyOf,
  projectAtCheckpoint,
  proposeChatItems,
  restoreRevision,
  updateChatItems,
  type ChatMessage,
  type MediaSource,
  type Project,
} from '../src';

function src(role: MediaSource['role'], duration: number): MediaSource {
  return { id: `src_${role}`, role, name: role, path: `/tmp/${role}.mov`, managed: false, origin: 'recording', kind: 'video', duration, width: 1920, height: 1080, fps: 30, hasAudio: false, fingerprint: { sizeBytes: 1, duration }, available: true, cursorBaked: false, sync: defaultSync('reference'), gaps: [] };
}

/** 60 s screen + camera, with two AI zooms and one zoom the creator made. */
function project(): Project {
  let p = createProject('demo', [src('screen', 60), src('cameraA', 60)]);
  p = applyProposal(p, [
    { op: 'zoom', start: 2, end: 6, scale: 1.8, x: 0.3, y: 0.3, reason: 'click on settings' },
    { op: 'zoom', start: 20, end: 24, scale: 2, x: 0.7, y: 0.5, reason: 'format picker' },
  ], { label: 'AI first cut' }).project;
  return commitEdit(p, applyOps(p.edit, [{ op: 'zoom', start: 40, end: 44, scale: 1.5 }], 'creator', p.revision + 1));
}

describe('chat proposals', () => {
  it('gives every decision a short handle in timeline order', () => {
    const hs = decisionHandles(project());
    expect(hs.map((h) => [h.handle, h.lane, h.origin])).toEqual([
      ['D1', 'zooms', 'ai'],
      ['D2', 'zooms', 'ai'],
      ['D3', 'zooms', 'creator'],
    ]);
    expect(decisionHandles(project(), { start: 0, end: 10 }).map((h) => h.handle)).toEqual(['D1']);
  });

  it('turns a reply into cards and says up front what cannot be applied', () => {
    let p = project();
    p = commitEdit(p, addLock(p.edit, { start: 50, end: 58 }, 'keep'));
    const [d1] = decisionHandles(p);
    const items = proposeChatItems(
      p,
      {
        remove: [{ lane: 'zooms', id: d1!.id }],
        ops: [
          { op: 'zoom', start: 10, end: 14, scale: 1.6, x: 0.5, y: 0.5, reason: 'the export button' },
          { op: 'cut', start: 51, end: 53, kind: 'pacing', reason: 'slow' },
          { op: 'format-disk', start: 0, end: 1 },
        ],
      },
      null,
    );
    const by = (what: RegExp) => items.find((i) => what.test(i.what))!;
    expect(by(/Remove the zoom/).status).toBe('open');
    expect(by(/Zoom to 1\.6×/)).toMatchObject({ status: 'open', kind: 'add', why: 'the export button', range: { start: 10, end: 14 } });
    const refused = items.filter((i) => i.status === 'refused');
    expect(refused).toHaveLength(2);
    expect(refused.every((i) => !!i.note)).toBe(true);
    // sorted for reading along the timeline
    expect(items.map((i) => i.range.start)).toEqual([...items.map((i) => i.range.start)].sort((a, b) => a - b));
  });

  it('keeps proposals inside the selected section', () => {
    const p = project();
    const items = proposeChatItems(p, { remove: [{ lane: 'zooms', id: decisionHandles(p)[1]!.id }], ops: [{ op: 'zoom', start: 30, end: 34, scale: 2, reason: 'x' }] }, { start: 0, end: 10 });
    expect(items.every((i) => i.status === 'refused')).toBe(true);
  });

  it('applies chosen cards as one checkpointed step and leaves the rest of the edit alone', () => {
    const p = project();
    const hs = decisionHandles(p);
    const items = proposeChatItems(p, { remove: [{ lane: 'zooms', id: hs[0]!.id }], ops: [{ op: 'zoom', start: 10, end: 14, scale: 1.6, reason: 'r' }] }, null);
    const out = applyChatItems(p, items, { label: 'Chat: fewer zooms early', messageId: 'm1' });
    expect(out.applied).toHaveLength(2);
    expect(out.refused).toHaveLength(0);
    expect(out.project.edit.zooms.map((z) => z.start)).toEqual([10, 20, 40]);
    expect(out.project.edit.zooms.find((z) => z.start === 40)!.meta.origin).toBe('creator');
    expect(out.project.revision).toBe(p.revision + 1);
    expect(out.checkpoint).toEqual({ revision: p.revision + 1, label: 'Chat: fewer zooms early' });
    const rec = findCheckpoint(out.project, out.checkpoint!)!;
    expect(rec).toMatchObject({ via: 'chat', messageId: 'm1', origin: 'ai' });
    // the state before is restorable too
    expect(findCheckpoint(out.project, { revision: p.revision, label: 'Before: Chat: fewer zooms early' })!.snapshot).toBe(p.edit);
  });

  it('applies one card at a time, each with its own checkpoint', () => {
    const p = project();
    const items = proposeChatItems(p, { remove: [], ops: [{ op: 'zoom', start: 10, end: 14, scale: 1.6, reason: 'a' }, { op: 'zoom', start: 30, end: 33, scale: 1.6, reason: 'b' }] }, null);
    const one = applyChatItems(p, [items[0]!], { label: 'Chat: zoom at 0:10' });
    const two = applyChatItems(one.project, [items[1]!], { label: 'Chat: zoom at 0:30' });
    expect(two.project.edit.zooms).toHaveLength(5);
    expect(two.project.revisions.filter((r) => r.via === 'chat').map((r) => r.label)).toEqual(['Chat: zoom at 0:10', 'Chat: zoom at 0:30']);
  });

  it('never removes a locked decision and reports a card that no longer fits', () => {
    let p = project();
    const hs = decisionHandles(p);
    const items = proposeChatItems(p, { remove: [{ lane: 'zooms', id: hs[1]!.id }], ops: [{ op: 'cut', start: 30, end: 33, kind: 'pacing', reason: 'r' }] }, null);
    // the creator locks things after the proposal was made
    p = { ...p, edit: { ...p.edit, zooms: p.edit.zooms.map((z) => (z.id === hs[1]!.id ? { ...z, meta: { ...z.meta, locked: true } } : z)) } };
    p = commitEdit(p, addLock(p.edit, { start: 28, end: 36 }, 'keep'));
    const out = applyChatItems(p, items, { label: 'Chat: x' });
    expect(out.applied).toHaveLength(0);
    expect(out.refused).toHaveLength(2);
    expect(out.checkpoint).toBeNull();
    expect(out.project).toBe(p);
  });

  it('will not let an AI operation overwrite a decision the creator made, unless its removal is applied too', () => {
    const p = project();
    const mine = decisionHandles(p).find((h) => h.origin === 'creator')!;
    const add = { op: 'zoom', start: 40, end: 44, scale: 2.5, reason: 'stronger' };
    const alone = proposeChatItems(p, { remove: [], ops: [add] }, null);
    expect(alone[0]!.status).toBe('refused');
    const both = proposeChatItems(p, { remove: [{ lane: 'zooms', id: mine.id }], ops: [add] }, null);
    expect(both.map((i) => i.status)).toEqual(['open', 'open']);
    const out = applyChatItems(p, both, { label: 'Chat: stronger zoom' });
    expect(out.project.edit.zooms.find((z) => z.start === 40)).toMatchObject({ scale: 2.5, meta: { origin: 'ai' } });
    // applying only the add, without the removal, is refused at apply time
    const half = applyChatItems(p, both.filter((i) => i.kind === 'add'), { label: 'Chat: half' });
    expect(half.applied).toHaveLength(0);
  });

  it('brings cut footage back through a removal and keeps it from being cut again', () => {
    let p = createProject('demo', [src('screen', 60)]);
    p = applyProposal(p, [{ op: 'cut', start: 10, end: 13, kind: 'pacing', reason: 'pause' }], { label: 'AI first cut' }).project;
    const [d] = decisionHandles(p);
    const items = proposeChatItems(p, { remove: [{ lane: 'cuts', id: d!.id }], ops: [] }, null);
    expect(items[0]!.what).toMatch(/Bring back 3\.0s/);
    const out = applyChatItems(p, items, { label: 'Chat: restore' });
    expect(out.project.edit.cuts).toHaveLength(0);
    expect(out.project.edit.keeps).toEqual([{ start: 10, end: 13 }]);
  });
});

describe('chat thread', () => {
  const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: 'm', role: 'creator', text: '', at: '2026-01-01T00:00:00Z', scope: null, ...m });

  it('is saved on the project and its cards can be updated', () => {
    let p = project();
    const items = proposeChatItems(p, { remove: [], ops: [{ op: 'zoom', start: 10, end: 14, scale: 1.6, reason: 'r' }] }, null);
    p = appendChat(p, msg({ id: 'a', role: 'assistant', text: 'Here is one zoom.', items }));
    p = updateChatItems(p, 'a', (it) => ({ ...it, status: 'dismissed' }));
    expect(p.chat![0]!.items![0]!.status).toBe('dismissed');
    expect(JSON.parse(JSON.stringify(p)).chat).toHaveLength(1);
  });

  it('digests only the recent turns, with what became of each proposal', () => {
    let p = project();
    for (let i = 0; i < 10; i++) p = appendChat(p, msg({ id: `c${i}`, text: `request ${i} ${'x'.repeat(500)}` }));
    const items = proposeChatItems(p, { remove: [], ops: [{ op: 'zoom', start: 10, end: 14, scale: 1.6, reason: 'r' }, { op: 'zoom', start: 30, end: 34, scale: 1.6, reason: 'r' }] }, null);
    items[0]!.status = 'applied';
    items[1]!.status = 'dismissed';
    p = appendChat(p, msg({ id: 'a', role: 'assistant', text: 'Two zooms.', items }));
    p = appendChat(p, msg({ id: 'f', role: 'assistant', text: 'error', failed: true }));
    const d = chatDigest(p.chat, 4);
    expect(d).toHaveLength(4);
    expect(d.every((l) => l.text.length <= 300)).toBe(true);
    const last = d[d.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.outcome).toMatch(/1 applied/);
    expect(last.outcome).toMatch(/1 dismissed/);
    expect(last.outcome).toMatch(/Zoom to 1\.6×.* at 0:10/);
  });
});

describe('versions', () => {
  it('shows a checkpoint without changing the project', () => {
    const p = project();
    const first = p.revisions.find((r) => r.label === 'AI first cut')!;
    const frozen = JSON.stringify(p);
    const view = projectAtCheckpoint(p, first.revision)!;
    expect(view.edit).toBe(first.snapshot);
    expect(view.edit.zooms).toHaveLength(2);
    expect(view.sources).toBe(p.sources);
    expect(view.revisions).toBe(p.revisions);
    expect(JSON.stringify(p)).toBe(frozen);
    expect(projectAtCheckpoint(p, 9999)).toBeNull();
  });

  it('restores a version as a new revision and checkpoints what was there', () => {
    const p = project();
    const first = p.revisions.find((r) => r.label === 'AI first cut')!;
    const r = restoreRevision(p, first.revision);
    expect(r.edit).toBe(first.snapshot);
    expect(r.revision).toBe(p.revision + 1);
    expect(findCheckpoint(r, { revision: p.revision, label: 'Before restore' })!.snapshot).toBe(p.edit);
  });

  it('summarises what differs between two edits in one line', () => {
    const p = project();
    const before = p.revisions.find((r) => r.label === 'Before: AI first cut')!.snapshot;
    const after = p.revisions.find((r) => r.label === 'AI first cut')!.snapshot;
    expect(diffSummary(before, after)).toBe('+2 zooms');
    expect(diffSummary(after, before)).toBe('−2 zooms');
    expect(diffSummary(after, after)).toBe('Same edit as the version before');
    const cut = applyOps(after, [{ op: 'cut', start: 10, end: 14.2, kind: 'pacing' }], 'ai', 9);
    expect(diffSummary(after, cut)).toBe('+1 cut (4.2s shorter)');
    const look = { ...after, appearance: { ...after.appearance, frame: { ...after.appearance.frame, padding: after.appearance.frame.padding + 0.01 } } };
    expect(diffSummary(after, look)).toBe('look changed');
  });

  it('lists history newest first with origin, difference and which one is current', () => {
    let p = project();
    p = checkpoint(p, 'My checkpoint', 'creator');
    const items = proposeChatItems(p, { remove: [], ops: [{ op: 'zoom', start: 10, end: 14, scale: 1.6, reason: 'r' }] }, null);
    p = applyChatItems(p, items, { label: 'Chat: add a zoom' }).project;
    const h = historyOf(p);
    expect(h[0]).toMatchObject({ origin: 'chat', current: true, diff: '+1 zoom' });
    expect(h[0]!.record.label).toBe('Chat: add a zoom');
    expect(h.find((e) => e.record.label === 'AI first cut')).toMatchObject({ origin: 'ai', current: false, diff: '+2 zooms' });
    expect(h.find((e) => e.record.label === 'My checkpoint')).toMatchObject({ origin: 'you', diff: '+1 zoom' });
    expect(h[h.length - 1]!.diff).toMatch(/^First checkpoint:/);
    // "Before: Chat: add a zoom" was taken at the same revision as "My checkpoint": the same edit twice
    expect(h.find((e) => e.record.label === 'Before: Chat: add a zoom')!.redundant).toBe(true);
    expect(h.filter((e) => !e.redundant).map((e) => e.record.label)).toEqual(['Chat: add a zoom', 'My checkpoint', 'AI first cut', 'Before: AI first cut']);
  });
});
