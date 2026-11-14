/**
 * One turn of the "Ask AI" chat. Produces the assistant's message: what it
 * says, the moments it points at, and proposal cards. Nothing is committed
 * here; cards are applied by the creator (state/chat.ts).
 *
 * The model is reached only through the shared gate (claudeGate / askClaude),
 * so whichever local provider the app is set to use answers. Without one, the
 * built-in rules answer the requests they understand and say so.
 */
import { AiParseError } from '@cutaway/ai';
import { CHAT_SCHEMA, buildChatPrompt, parseChat, type ChatDecision } from '@cutaway/ai/chat';
import { TimeMap, chatDigest, decisionHandles, flagsOf, proposeChatItems, sourceByRole, uid, zoomLevelOf, type ChatLane, type ChatMessage, type ChatProposalItem, type Project, type Range } from '@cutaway/core';
import type { PromptKeyframe } from '@cutaway/ai';
import { JobError, type AiUse, type JobContext } from './types';
import { LOCAL_REVISION_HELP, proposeRevision } from './revision';
import { allTemplates, localMotionCard, motionCards, templatesForChat } from '../motion/chatCards';
import { askClaude, claudeGate, clusterClicks, errorText, extractStills, promptAssets, promptSentences, promptSources, screenActivity, type FrameWant } from './shared';

/** Stills are only worth their time when the request is about a short section. */
const STILLS_MAX_SECTION = 90;

function assistant(scope: Range | null, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: uid('msg'), role: 'assistant', text, at: new Date().toISOString(), scope, ...extra };
}

/** What the built-in rules can do with this request, as one card (or an explanation when they cannot). */
async function localAnswer(ctx: JobContext, text: string, scope: Range | null, ai: AiUse): Promise<ChatMessage> {
  const p = ctx.get();
  const range: Range = scope ?? { start: 0, end: p.duration };
  const why = ai.reason ? `${ai.reason} ` : '';
  // an animation request becomes an animation card, not a rules edit
  const motion = localMotionCard(p, text, scope, await allTemplates());
  if (motion) return assistant(scope, `${why}${motion.motion!.template ? 'Here is a ready-made animation for that.' : 'That needs an animation written for it; Apply opens it in the animation sheet.'}`, { mode: 'local-rules', modeReason: ai.reason, items: [motion] });
  try {
    const { outcome } = await proposeRevision({ ...ctx, useClaude: false }, range, text);
    if (!outcome.changed) return assistant(scope, `${why}${outcome.message || `The built-in rules cannot do that. ${LOCAL_REVISION_HELP}`}`, { mode: 'local-rules', modeReason: ai.reason });
    const item: ChatProposalItem = {
      id: uid('ci'),
      kind: 'rules',
      rules: { instruction: text, scope: range },
      range,
      what: outcome.understood.join(' ') || outcome.label,
      why: 'Worked out by Cutaway’s built-in rules, on this Mac.',
      status: 'open',
    };
    return assistant(scope, `${why}The built-in rules can do this${scope ? ' in the section you selected' : ' across the video'}.`, { mode: 'local-rules', modeReason: ai.reason, items: [item] });
  } catch (e) {
    if (e instanceof JobError && e.code === 'cancelled') throw e;
    return assistant(scope, `${why}${errorText(e)}`, { mode: 'local-rules', modeReason: ai.reason });
  }
}

function promptDecisions(p: Project, scope: Range | null) {
  const handles = decisionHandles(p, scope);
  const decisions: ChatDecision[] = handles.map((h) => ({ handle: h.handle, lane: h.lane, start: h.start, end: h.end, origin: h.origin, locked: h.locked, description: h.description }));
  return { handles, decisions };
}

/** The thread before the message being answered (which goes in <request>, not in the digest). */
function priorTurns(p: Project): ChatMessage[] {
  const chat = p.chat ?? [];
  return chat[chat.length - 1]?.role === 'creator' ? chat.slice(0, -1) : chat;
}

/** Answer the creator's message about the open edit. `scope` null = the whole video. */
export async function answerChat(ctx: JobContext, text: string, scope: Range | null): Promise<ChatMessage> {
  const message = text.trim();
  if (!message) throw new JobError('assemble', 'failed', 'Type what you would like changed, or a question about the video.', false);
  if (ctx.signal.aborted) throw new JobError('assemble', 'cancelled', 'Cancelled.', true);
  const p = ctx.get();
  if (scope) scope = { start: Math.max(0, Math.min(scope.start, scope.end)), end: Math.min(p.duration, Math.max(scope.start, scope.end)) };
  if (scope && scope.end - scope.start < 0.2) scope = null;

  const gate = await claudeGate(ctx);
  if (!gate.usable) return localAnswer(ctx, message, scope, { mode: 'local-rules', reason: gate.reason, fellBack: gate.fellBack });

  const wants: FrameWant[] = [];
  if (scope && scope.end - scope.start <= STILLS_MAX_SECTION && sourceByRole(p, 'screen')) for (const f of [0.15, 0.5, 0.85]) wants.push({ sessionTime: scope.start + (scope.end - scope.start) * f, role: 'screen' });
  const { stills, imageDir } = wants.length ? await extractStills(ctx, p, wants) : { stills: [], imageDir: null };
  if (ctx.signal.aborted) throw new JobError('assemble', 'cancelled', 'Cancelled.', true);
  const keyframes: PromptKeyframe[] = stills.map((s) => ({ file: s.file, sessionTime: s.sessionTime, source: s.source }));

  const inScope = (r: Range) => !scope || (r.end > scope.start && r.start < scope.end);
  const { handles, decisions } = promptDecisions(p, scope);
  const templates = await allTemplates();
  const prompt = buildChatPrompt({
    animationTemplates: templatesForChat(templates),
    projectName: p.name,
    message,
    scope,
    duration: p.duration,
    outputDuration: TimeMap.fromEdit(p.duration, p.edit).outDuration,
    brief: p.brief,
    sources: promptSources(p),
    hasSpeech: !!p.transcript?.hasSpeech,
    sentences: promptSentences(p, scope ?? undefined),
    decisions,
    activeRanges: screenActivity(p).filter(inScope),
    clickClusters: clusterClicks(p.analysis?.clicks ?? []).filter(inScope),
    assets: p.brief.allowBroll ? promptAssets(p) : [],
    locks: p.edit.locks.filter(inScope).map((l) => ({ start: l.start, end: l.end, note: l.note })),
    keeps: p.edit.keeps.filter(inScope),
    flags: flagsOf(p).map((f) => f.t).filter((t) => !scope || (t >= scope.start && t <= scope.end)),
    keyframes,
    thread: chatDigest(priorTurns(p)),
    zoomLevel: zoomLevelOf(p.edit.appearance),
    editingNotes: ctx.settings.playbookNotes?.editing,
  });
  const res = await askClaude(ctx, { purpose: 'local-revision', prompt, schema: CHAT_SCHEMA as unknown as Record<string, unknown>, imagePaths: stills.map((s) => s.path), imageDir });
  if (!res.ok && (res.error?.code === 'cancelled' || ctx.signal.aborted)) throw new JobError('assemble', 'cancelled', 'Cancelled. Nothing was changed.', true);

  const fallBack = (reason: string) => localAnswer(ctx, message, scope, { mode: 'local-rules', reason, fellBack: true });
  if (!res.ok) return fallBack(res.error?.message ?? 'The AI provider failed.');
  let reply: ReturnType<typeof parseChat>;
  try {
    reply = parseChat(res.data, handles.map((h) => h.handle), p.duration);
  } catch (e) {
    return fallBack(e instanceof AiParseError ? `The reply could not be used (${e.message})` : errorText(e));
  }
  // Validate against the edit as it is now (it cannot change while the creator waits, but be exact anyway).
  const q = ctx.get();
  const byHandle = new Map(handles.map((h) => [h.handle, h]));
  const remove = reply.remove.map((h) => byHandle.get(h)!).filter(Boolean).map((h) => ({ lane: h.lane as ChatLane, id: h.id }));
  const items = [...proposeChatItems(q, { ops: reply.ops, remove }, scope), ...motionCards(reply.animations, templates, scope, q.duration)];
  return assistant(scope, reply.reply, { mode: 'claude', modeReason: null, moments: reply.moments, items });
}
