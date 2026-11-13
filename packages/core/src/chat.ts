/**
 * The "Ask AI" thread and version viewing — pure model code.
 *
 * A chat reply is a proposal: a list of items the creator applies one by one
 * or all at once. An item is one of the seven validated edit operations, or
 * the removal of one existing decision. Every application goes through the
 * same validation as any other AI edit and leaves a named checkpoint, so each
 * step of a conversation can be looked at again or restored.
 */
import type { ChatLane, ChatMessage, ChatProposalItem, CheckpointRef, DecisionMeta, EditOp, EditState, Project, Range, RevisionRecord } from './types';
import { fmtTime, overlaps, uid } from './ranges';
import { applyOps, restoreCut, removeById } from './edit';
import { checkpoint, commitEdit } from './project';
import { validateOps } from './validate';

export const CHAT_LANES: ChatLane[] = ['cuts', 'speeds', 'layouts', 'zooms', 'overlays', 'broll'];

const LANE_NOUN: Record<ChatLane, [string, string]> = {
  cuts: ['cut', 'cuts'],
  speeds: ['speed change', 'speed changes'],
  layouts: ['view change', 'view changes'],
  zooms: ['zoom', 'zooms'],
  overlays: ['graphic', 'graphics'],
  broll: ['B-roll insert', 'B-roll inserts'],
};

const VIEW: Record<string, string> = { screen: 'screen only', camera: 'camera full frame', overlay: 'screen with a small camera', split: 'screen beside camera' };

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** One edit operation in plain words, for a proposal card. */
export function describeOp(op: EditOp): string {
  switch (op.op) {
    case 'cut':
      return `Cut ${(op.end - op.start).toFixed(1)}s${op.kind === 'filler' ? ' (filler)' : op.kind === 'silence' || op.kind === 'pacing' ? ' (pause)' : op.kind === 'retake' ? ' (retake)' : ''}`;
    case 'speed':
      return `Play at ${op.speed}×`;
    case 'layout':
      return `Show ${VIEW[op.mode] ?? op.mode}${op.mode !== 'screen' && op.camera ? ` (camera ${op.camera})` : ''}`;
    case 'zoom':
      return `Zoom to ${Number(op.scale).toFixed(1)}×${op.follow ? ', following the cursor' : ''}`;
    case 'overlay':
      return `${op.kind === 'callout' ? 'Callout' : op.kind === 'section-card' ? 'Section card' : 'Lower third'}: “${clip(op.text, 48)}”`;
    case 'broll':
      return 'Insert B-roll';
    case 'suggest':
      return `Suggestion for you to decide: ${clip(op.title, 60)}`;
  }
}

/** An existing decision in plain words (what a removal card and the prompt call it). */
export function describeDecision(lane: ChatLane, item: Record<string, unknown>): string {
  switch (lane) {
    case 'cuts':
      return `cut (${String(item.kind)})`;
    case 'speeds':
      return `speed ${String(item.speed)}×`;
    case 'layouts':
      return `view: ${VIEW[String(item.mode)] ?? String(item.mode)}${item.mode === 'screen' ? '' : `, camera ${String(item.camera)}`}`;
    case 'zooms':
      return `zoom ${Number(item.scale).toFixed(1)}×${item.follow ? ' following the cursor' : ''}`;
    case 'overlays':
      return `${String(item.kind)} “${clip(String(item.text ?? ''), 40)}”`;
    case 'broll':
      return `B-roll ${String(item.assetId)}`;
  }
}

export interface DecisionHandle extends Range {
  /** Short name the model uses to point at the decision: D1, D2, … */
  handle: string;
  lane: ChatLane;
  id: string;
  origin: DecisionMeta['origin'];
  locked: boolean;
  description: string;
}

/** Every current decision (inside `scope` when given), in timeline order, with a stable short handle. */
export function decisionHandles(project: Pick<Project, 'edit'>, scope?: Range | null): DecisionHandle[] {
  const out: Omit<DecisionHandle, 'handle'>[] = [];
  for (const lane of CHAT_LANES) {
    for (const item of project.edit[lane] as (Range & { id: string; meta: DecisionMeta })[]) {
      if (scope && !overlaps(item, scope)) continue;
      out.push({ lane, id: item.id, start: item.start, end: item.end, origin: item.meta.origin, locked: !!item.meta.locked, description: describeDecision(lane, item as unknown as Record<string, unknown>) });
    }
  }
  out.sort((a, b) => a.start - b.start || CHAT_LANES.indexOf(a.lane) - CHAT_LANES.indexOf(b.lane));
  return out.map((d, i) => ({ ...d, handle: `D${i + 1}` }));
}

function removalRefusal(project: Pick<Project, 'edit'>, r: { lane: ChatLane; id: string }, scope: Range | null): string | null {
  const item = (project.edit[r.lane] as (Range & { id: string; meta: DecisionMeta })[]).find((x) => x.id === r.id);
  if (!item) return 'It is no longer in the edit.';
  if (item.meta.locked) return 'It is locked. Unlock it first if you want it changed.';
  if (project.edit.locks.some((l) => overlaps(l, item))) return 'It sits inside a section you locked.';
  if (scope && !overlaps(item, scope)) return 'It is outside the section you selected.';
  return null;
}

const BLOCKED_BY_CREATOR = 'A decision you made yourself is in the way. Ask for that one to be replaced too, or change it by hand.';

/** Would applying this AI operation change anything? (It never overwrites creator-made or locked decisions.) */
function changes(edit: EditState, op: EditOp): boolean {
  const next = applyOps(edit, [op], 'ai', 0);
  const lane = op.op === 'cut' ? 'cuts' : op.op === 'speed' ? 'speeds' : op.op === 'layout' ? 'layouts' : op.op === 'zoom' ? 'zooms' : op.op === 'overlay' ? 'overlays' : op.op === 'broll' ? 'broll' : 'suggestions';
  const strip = (xs: unknown) => JSON.stringify((xs as { id: string }[]).map(({ id: _id, ...rest }) => rest));
  return strip(next[lane]) !== strip(edit[lane]);
}

function withoutDecision(edit: EditState, r: { lane: ChatLane; id: string }): EditState {
  return r.lane === 'cuts' ? restoreCut(edit, r.id) : removeById(edit, r.lane, r.id);
}

/**
 * Turn an untrusted reply into proposal cards. Each operation is validated on
 * its own, against the edit as it would be once the proposed removals are
 * made, so a card says up front whether it can be applied.
 */
export function proposeChatItems(project: Project, raw: { ops: unknown[]; remove: { lane: ChatLane; id: string }[] }, scope: Range | null): ChatProposalItem[] {
  const items: ChatProposalItem[] = [];
  let base = project.edit;
  for (const r of raw.remove.slice(0, 200)) {
    const item = (project.edit[r.lane] as (Range & { id: string; meta: DecisionMeta })[] | undefined)?.find((x) => x.id === r.id);
    if (!item) continue;
    const refusal = removalRefusal(project, r, scope);
    const noun = LANE_NOUN[r.lane][0];
    items.push({
      id: uid('ci'),
      kind: 'remove',
      remove: { lane: r.lane, id: r.id },
      range: { start: item.start, end: item.end },
      what: r.lane === 'cuts' ? `Bring back ${(item.end - item.start).toFixed(1)}s that was cut` : `Remove the ${noun} (${describeDecision(r.lane, item as unknown as Record<string, unknown>)})`,
      why: item.meta.origin === 'creator' ? 'You made this one yourself.' : '',
      status: refusal ? 'refused' : 'open',
      ...(refusal ? { note: refusal } : {}),
    });
    if (!refusal) base = withoutDecision(base, r);
  }
  const probe = { ...project, edit: base };
  for (const rawOp of raw.ops.slice(0, 200)) {
    const res = validateOps(probe, [rawOp], { origin: 'ai', scope: scope ?? undefined });
    for (const op of res.accepted) {
      const blocked = !changes(base, op);
      const note = blocked ? BLOCKED_BY_CREATOR : res.adjusted.find((a) => a.op === op)?.note;
      if (blocked) {
        items.push({ id: uid('ci'), kind: 'add', op, range: { start: op.start, end: op.end }, what: describeOp(op), why: clip(('reason' in op && op.reason) || '', 240), status: 'refused', note });
        continue;
      }
      items.push({ id: uid('ci'), kind: 'add', op, range: { start: op.start, end: op.end }, what: describeOp(op), why: clip(('reason' in op && op.reason) || '', 240), status: 'open', ...(note ? { note } : {}) });
    }
    for (const rej of res.rejected) {
      const o = (rej.op && typeof rej.op === 'object' ? rej.op : {}) as Record<string, unknown>;
      const start = typeof o.start === 'number' && Number.isFinite(o.start) ? Math.max(0, Math.min(o.start, project.duration)) : 0;
      const end = typeof o.end === 'number' && Number.isFinite(o.end) ? Math.max(start, Math.min(o.end, project.duration)) : start;
      items.push({ id: uid('ci'), kind: 'add', range: { start, end }, what: typeof o.op === 'string' ? `A ${o.op} that cannot be applied` : 'A change that cannot be applied', why: clip(typeof o.reason === 'string' ? o.reason : '', 240), status: 'refused', note: rej.message });
    }
  }
  return items.sort((a, b) => a.range.start - b.range.start);
}

export interface ChatApplyOutcome {
  project: Project;
  /** Item ids that changed the edit. */
  applied: string[];
  /** Items that could not be applied now, with the reason. */
  refused: { id: string; message: string }[];
  /** The checkpoint holding the result; null when nothing was applied. */
  checkpoint: CheckpointRef | null;
}

/**
 * Apply chosen proposal items as one step: checkpoint the current edit, make
 * the removals, validate and apply the operations against what is there now,
 * and checkpoint the result under `label`. Nothing is applied half-way: an
 * item that no longer fits is reported and skipped.
 */
export function applyChatItems(project: Project, items: ChatProposalItem[], opts: { label: string; scope?: Range | null; messageId?: string }): ChatApplyOutcome {
  const scope = opts.scope ?? null;
  const saved = checkpoint(project, `Before: ${opts.label}`, 'creator');
  const revision = saved.revision + 1;
  let edit = saved.edit;
  const applied: string[] = [];
  const refused: { id: string; message: string }[] = [];
  for (const it of items) {
    if (it.kind !== 'remove' || !it.remove) continue;
    const refusal = removalRefusal({ edit }, it.remove, scope);
    if (refusal) refused.push({ id: it.id, message: refusal });
    else {
      edit = withoutDecision(edit, it.remove);
      applied.push(it.id);
    }
  }
  for (const it of items) {
    if (it.kind !== 'add') continue;
    if (!it.op) {
      refused.push({ id: it.id, message: it.note ?? 'This change cannot be applied.' });
      continue;
    }
    const res = validateOps({ ...saved, edit }, [it.op], { origin: 'ai', scope: scope ?? undefined });
    if (res.accepted.length === 0) {
      refused.push({ id: it.id, message: res.rejected[0]?.message ?? 'This change no longer fits the edit.' });
      continue;
    }
    if (!res.accepted.some((op) => changes(edit, op))) {
      refused.push({ id: it.id, message: BLOCKED_BY_CREATOR });
      continue;
    }
    edit = applyOps(edit, res.accepted, 'ai', revision);
    applied.push(it.id);
  }
  if (applied.length === 0) return { project, applied, refused, checkpoint: null };
  let next = commitEdit(saved, edit);
  next = checkpoint(next, opts.label, 'ai', { via: 'chat', messageId: opts.messageId });
  return { project: next, applied, refused, checkpoint: { revision: next.revision, label: opts.label } };
}

// ───────────────────────────── thread ─────────────────────────────

const MAX_CHAT = 200;

export function appendChat(project: Project, message: ChatMessage): Project {
  return { ...project, chat: [...(project.chat ?? []), message].slice(-MAX_CHAT) };
}

export function updateChatMessage(project: Project, id: string, fn: (m: ChatMessage) => ChatMessage): Project {
  const chat = project.chat ?? [];
  if (!chat.some((m) => m.id === id)) return project;
  return { ...project, chat: chat.map((m) => (m.id === id ? fn(m) : m)) };
}

export function updateChatItems(project: Project, messageId: string, fn: (it: ChatProposalItem) => ChatProposalItem): Project {
  return updateChatMessage(project, messageId, (m) => ({ ...m, items: (m.items ?? []).map(fn) }));
}

export interface ChatDigestLine {
  role: 'creator' | 'assistant';
  text: string;
  /** assistant only: what became of its proposal. */
  outcome?: string;
}

/** The last few turns, compressed for the next prompt. Never the whole thread. */
export function chatDigest(chat: ChatMessage[] | undefined, turns = 6): ChatDigestLine[] {
  return (chat ?? [])
    .filter((m) => !m.failed)
    .slice(-turns)
    .map((m) => {
      if (m.role === 'creator') return { role: 'creator' as const, text: clip(m.text, 300) };
      const items = m.items ?? [];
      const n = (s: ChatProposalItem['status']) => items.filter((i) => i.status === s).length;
      const outcome = items.length ? [n('applied') ? `${n('applied')} applied` : '', n('dismissed') ? `${n('dismissed')} dismissed by the creator` : '', n('open') ? `${n('open')} still waiting` : '', n('refused') ? `${n('refused')} refused by validation` : ''].filter(Boolean).join(', ') : undefined;
      const what = items.filter((i) => i.status === 'applied').slice(0, 6).map((i) => `${i.what} at ${fmtTime(i.range.start)}`).join('; ');
      return { role: 'assistant' as const, text: clip(m.text, 300), outcome: outcome ? `${outcome}${what ? ` (${what})` : ''}` : undefined };
    });
}

// ───────────────────────────── versions ─────────────────────────────

/** The checkpoint for a revision number (a revision number identifies one exact edit). */
export function findCheckpoint(project: Pick<Project, 'revisions'>, ref: { revision: number; label?: string }): RevisionRecord | null {
  const same = project.revisions.filter((r) => r.revision === ref.revision);
  return same.find((r) => r.label === ref.label) ?? same[same.length - 1] ?? null;
}

/** The project as it was at a checkpoint: same footage and thread, that version's edit. Read-only by convention. */
export function projectAtCheckpoint(project: Project, revision: number): Project | null {
  const rec = findCheckpoint(project, { revision });
  if (!rec) return null;
  return { ...project, edit: rec.snapshot };
}

function cutSeconds(e: EditState): number {
  return e.cuts.reduce((n, c) => n + (c.end - c.start), 0);
}

/** One line on how `after` differs from `before`, e.g. "+2 cuts (4.1s shorter) · −1 zoom · look changed". */
export function diffSummary(before: EditState, after: EditState): string {
  const parts: string[] = [];
  for (const lane of CHAT_LANES) {
    const a = new Map((before[lane] as { id: string }[]).map((x) => [x.id, x]));
    const b = new Map((after[lane] as { id: string }[]).map((x) => [x.id, x]));
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [id, x] of b) {
      if (!a.has(id)) added++;
      else if (a.get(id) !== x && JSON.stringify(a.get(id)) !== JSON.stringify(x)) changed++;
    }
    for (const id of a.keys()) if (!b.has(id)) removed++;
    const [one, many] = LANE_NOUN[lane];
    const bits: string[] = [];
    if (added) bits.push(`+${added} ${added === 1 ? one : many}`);
    if (removed) bits.push(`−${removed} ${removed === 1 ? one : many}`);
    if (changed && !added && !removed) bits.push(`${changed} ${changed === 1 ? one : many} changed`);
    if (lane === 'cuts' && bits.length) {
      const d = cutSeconds(after) - cutSeconds(before);
      if (Math.abs(d) >= 0.05) bits[bits.length - 1] += ` (${Math.abs(d).toFixed(1)}s ${d > 0 ? 'shorter' : 'longer'})`;
    }
    parts.push(...bits);
  }
  const count = (label: string, x: number, y: number) => {
    if (x !== y) parts.push(`${y > x ? '+' : '−'}${Math.abs(y - x)} ${label}${Math.abs(y - x) === 1 ? '' : 's'}`);
  };
  count('mask', before.masks.length, after.masks.length);
  count('lock', before.locks.length, after.locks.length);
  const open = (e: EditState) => e.suggestions.filter((s) => s.status === 'open').length;
  count('open suggestion', open(before), open(after));
  if (before.appearance !== after.appearance && JSON.stringify(before.appearance) !== JSON.stringify(after.appearance)) parts.push('look changed');
  if (before.audio !== after.audio && JSON.stringify(before.audio) !== JSON.stringify(after.audio)) parts.push('audio changed');
  if (before.wordText !== after.wordText && JSON.stringify(before.wordText) !== JSON.stringify(after.wordText)) parts.push('caption text changed');
  return parts.length ? parts.join(' · ') : 'Same edit as the version before';
}

export interface HistoryEntry {
  record: RevisionRecord;
  /** you = made by hand, ai = an AI pass (first cut, section revision), chat = applied from the Ask AI thread. */
  origin: 'you' | 'ai' | 'chat';
  /** What differs from the checkpoint before it (or what the first one holds). */
  diff: string;
  /** This checkpoint is the edit that is current right now. */
  current: boolean;
  /** The same edit as the checkpoint before it (a "Before: …" marker taken when nothing had changed). Lists can leave it out. */
  redundant: boolean;
}

/** Checkpoints, newest first, each with what changed since the one before. */
export function historyOf(project: Pick<Project, 'revisions' | 'revision' | 'edit'>): HistoryEntry[] {
  const asc = [...project.revisions].sort((a, b) => a.revision - b.revision || a.createdAt.localeCompare(b.createdAt));
  const out: HistoryEntry[] = asc.map((record, i) => ({
    record,
    origin: record.via === 'chat' ? 'chat' : record.origin === 'ai' ? 'ai' : 'you',
    diff: i === 0 ? `First checkpoint: ${record.summary}` : diffSummary(asc[i - 1]!.snapshot, record.snapshot),
    current: record.revision === project.revision,
    redundant: i > 0 && asc[i - 1]!.revision === record.revision,
  }));
  return out.reverse();
}
