/**
 * The "Ask AI" thread: sending a message, applying or dismissing proposal
 * cards, and stepping through versions. The thread lives on the project
 * (project.chat) and is saved with it; every applied card leaves a named
 * checkpoint that can be looked at or restored.
 */
import { create } from 'zustand';
import { clipRange, clipsOf, appendChat, applyChatItems, fmtTime, historyOf, uid, updateChatItems, type ChatMessage, type ChatProposalItem, type CheckpointRef, type Project, type Range } from '@cutaway/core';
import { answerChat } from '../jobs/chat';
import { proposeRevision } from '../jobs/revision';
import { JobError } from '../jobs/types';
import { jobContext } from './jobs';
import { timeMapOf, useApp, usePlayback, viewedProject, type Selection } from './store';

interface ChatUi {
  busy: boolean;
  abort: AbortController | null;
  startedAt: number | null;
}

export const useChat = create<ChatUi>(() => ({ busy: false, abort: null, startedAt: null }));

const app = () => useApp.getState();

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** The section a message is about: the selected range or words, or the selected block. null = the whole video. */
export function chatScope(project: Project | null, sel: Selection): Range | null {
  if (!project || !sel) return null;
  if (sel.kind === 'range' || sel.kind === 'words') return sel.range;
  // music lives on the finished video's clock and a sound is a single moment: neither is a section of footage
  if (sel.kind === 'music' || sel.kind === 'sound') return null;
  // a selected clip is a section: a request made with it selected is about that clip
  if (sel.kind === 'clip') {
    const c = clipsOf(project).find((x) => x.id === sel.id && !x.removed);
    return c ? clipRange(c) : null;
  }
  const lane = ({ cut: 'cuts', speed: 'speeds', layout: 'layouts', zoom: 'zooms', overlay: 'overlays', broll: 'broll', mask: 'masks', lock: 'locks', suggestion: 'suggestions' } as const)[sel.kind];
  const item = (project.edit[lane] as (Range & { id: string })[]).find((x) => x.id === sel.id);
  return item ? { start: item.start, end: item.end } : null;
}

/**
 * Send one message. `useProvider` false = the creator chose to stay on this
 * Mac (or no provider is signed in): the built-in rules answer.
 */
export async function sendChat(text: string, useProvider: boolean): Promise<void> {
  const message = text.trim();
  if (!message || useChat.getState().busy) return;
  app().exitViewing();
  if (!app().project || !app().projectPath) return;
  if (app().comparison) return app().toast('Accept or discard the proposed change first.');
  const scope = chatScope(app().project, app().selection);
  const mine: ChatMessage = { id: uid('msg'), role: 'creator', text: message.slice(0, 1200), at: new Date().toISOString(), scope };
  app().patch((p) => appendChat(p, mine));
  const abort = new AbortController();
  useChat.setState({ busy: true, abort, startedAt: Date.now() });
  const path = app().projectPath;
  try {
    const reply = await answerChat(jobContext(abort.signal, useProvider), message, scope);
    // The creator may have opened another project while waiting.
    if (app().projectPath === path) app().patch((p) => appendChat(p, reply));
  } catch (e) {
    if (app().projectPath !== path) return;
    const cancelled = (e instanceof JobError && e.code === 'cancelled') || abort.signal.aborted;
    const failed: ChatMessage = { id: uid('msg'), role: 'assistant', text: cancelled ? 'Stopped. Nothing was changed.' : `That did not work: ${(e as Error).message}`, at: new Date().toISOString(), scope, failed: true };
    app().patch((p) => appendChat(p, failed));
  } finally {
    useChat.setState({ busy: false, abort: null, startedAt: null });
  }
}

export function stopChat() {
  useChat.getState().abort?.abort();
}

function requestBefore(project: Project, messageId: string): string {
  const chat = project.chat ?? [];
  const i = chat.findIndex((m) => m.id === messageId);
  for (let j = i - 1; j >= 0; j--) if (chat[j]!.role === 'creator') return chat[j]!.text;
  return '';
}

/**
 * Apply cards of one reply as a single undoable step with its own checkpoint.
 * `ids` undefined = every card still open.
 */
export async function applyChatCards(messageId: string, ids?: string[]): Promise<void> {
  app().exitViewing();
  const project = app().project;
  if (!project || useChat.getState().busy) return;
  if (app().comparison) return app().toast('Accept or discard the proposed change first.');
  const msg = (project.chat ?? []).find((m) => m.id === messageId);
  if (!msg) return;
  const chosen = (msg.items ?? []).filter((i) => i.status === 'open' && (!ids || ids.includes(i.id)));
  if (chosen.length === 0) return;
  const request = requestBefore(project, messageId);
  const label = chosen.length === 1 && ids ? `Chat: ${clip(chosen[0]!.what, 40)} at ${fmtTime(chosen[0]!.range.start)}` : `Chat: ${clip(request || 'changes', 48)}`;

  const applied = new Map<string, CheckpointRef>();
  const refused = new Map<string, string>();
  let next = project;

  const edits = chosen.filter((i) => i.kind !== 'rules');
  if (edits.length) {
    const out = applyChatItems(next, edits, { label, scope: msg.scope, messageId });
    next = out.project;
    for (const id of out.applied) if (out.checkpoint) applied.set(id, out.checkpoint);
    for (const r of out.refused) refused.set(r.id, r.message);
  }
  // Requests the built-in rules carry out: worked out again against the edit as it is now.
  for (const it of chosen.filter((i) => i.kind === 'rules' && i.rules)) {
    try {
      let live = next;
      const ctx = { ...jobContext(new AbortController().signal, false), get: () => live, update: (fn: (p: Project) => Project) => void (live = fn(live)) };
      const { preview, outcome } = await proposeRevision(ctx, it.rules!.scope, it.rules!.instruction);
      if (!outcome.changed) {
        refused.set(it.id, outcome.message || 'There is nothing left for this to change.');
        continue;
      }
      // Mark the rules' own checkpoint as coming from this conversation.
      next = { ...preview, revisions: preview.revisions.map((r) => (r.revision === preview.revision && r.label === outcome.label ? { ...r, via: 'chat' as const, messageId } : r)) };
      applied.set(it.id, { revision: preview.revision, label: outcome.label });
    } catch (e) {
      refused.set(it.id, (e as Error).message);
    }
  }

  // One undo step for the edit; the thread itself is not part of undo.
  if (next !== project) app().replace(next, label);
  app().patch((p) =>
    updateChatItems(p, messageId, (i): ChatProposalItem => {
      if (applied.has(i.id)) return { ...i, status: 'applied', checkpoint: applied.get(i.id) };
      if (refused.has(i.id)) return { ...i, status: 'refused', note: refused.get(i.id) };
      return i;
    }),
  );
  if (applied.size) app().toast(`${applied.size === 1 ? 'Change' : `${applied.size} changes`} applied and saved as a version. ⌘Z undoes ${applied.size === 1 ? 'it' : 'them'}.`);
  else app().toast(refused.size === 1 ? `Not applied: ${[...refused.values()][0]}` : 'None of these could be applied to the edit as it is now.');
}

export function dismissChatCards(messageId: string, ids?: string[]) {
  app().patch((p) => updateChatItems(p, messageId, (i) => (i.status === 'open' && (!ids || ids.includes(i.id)) ? { ...i, status: 'dismissed' } : i)));
}

/** Put a dismissed card back on the table. */
export function reopenChatCard(messageId: string, id: string) {
  app().patch((p) => updateChatItems(p, messageId, (i) => (i.id === id && i.status === 'dismissed' ? { ...i, status: 'open' } : i)));
}

/** Forget the conversation. Versions it created stay in History. */
export function clearChat() {
  if (useChat.getState().busy) stopChat();
  app().patch((p) => (p.chat?.length ? { ...p, chat: [] } : p));
}

/** Remove one failed reply (and nothing else) so the thread stays readable. */
export function dropChatMessage(id: string) {
  app().patch((p) => (p.chat?.some((m) => m.id === id) ? { ...p, chat: p.chat.filter((m) => m.id !== id) } : p));
}

/** The newest checkpoint a reply produced, if it is still in the history. */
export function checkpointOf(project: Project, message: ChatMessage): CheckpointRef | null {
  const refs = (message.items ?? []).map((i) => i.checkpoint).filter((c): c is CheckpointRef => !!c);
  const alive = refs.filter((c) => project.revisions.some((r) => r.revision === c.revision));
  return alive.sort((a, b) => b.revision - a.revision)[0] ?? null;
}

/** Jump the playhead to a moment of the recording (session time), in whichever version is on screen. */
export function jumpTo(sessionTime: number) {
  const s = app();
  const p = viewedProject(s) ?? s.project;
  if (!p) return;
  usePlayback.getState().setPlaying(false);
  usePlayback.getState().seek(timeMapOf(p).toOutput(Math.max(0, Math.min(p.duration, sessionTime))));
}

/** Look at the version before (−1) or after (+1) the one on screen. From the latest edit, −1 opens the newest checkpoint that differs. */
export function stepVersion(dir: 1 | -1) {
  const s = app();
  const project = s.project;
  if (!project) return;
  // Oldest first, one entry per distinct edit.
  const list = historyOf(project)
    .filter((h) => !h.redundant)
    .reverse();
  if (list.length === 0) return s.toast('There are no earlier versions yet. One is saved before and after every AI change.');
  const at = s.viewing ? list.findIndex((h) => h.record.revision === s.viewing!.revision) : list.length;
  let i = at + dir;
  // From the latest edit, skip a checkpoint that is identical to it.
  if (!s.viewing && dir < 0) while (i >= 0 && list[i]!.record.revision === project.revision) i--;
  if (i < 0) return s.toast('This is the oldest version.');
  if (i >= list.length) return s.viewing ? s.exitViewing() : undefined;
  s.viewVersion({ revision: list[i]!.record.revision, label: list[i]!.record.label });
}
