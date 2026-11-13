/**
 * Local regeneration: "less movement in this section", "keep this intact".
 *
 * proposeRevision never commits. It returns a preview project so the UI can
 * show before/after for the section and commit (ctx.update(() => preview))
 * only when the creator accepts. Everything outside the range, every creator
 * decision and every lock is left exactly as it was.
 */
import { AiParseError, REVISION_SCHEMA, buildRevisionPrompt, parseRevision, type PromptKeyframe, type RevisionDecision, type RevisionLane } from '@cutaway/ai';
import {
  addLock,
  applyProposal,
  checkpoint,
  commitEdit,
  overlaps,
  proposePacing,
  proposeZooms,
  sourceByRole,
  type DecisionMeta,
  type EditOp,
  type Project,
  type Range,
  type RejectedOp,
} from '@cutaway/core';
import { JobError, type AiUse, type JobContext } from './types';
import { askClaude, claudeGate, clusterClicks, errorText, extractStills, promptAssets, promptSentences, promptSources, screenActivity, type FrameWant } from './shared';

export interface RevisionOutcome {
  ai: AiUse;
  /** The preview differs from the current project. */
  changed: boolean;
  /** Plain statements of what was understood and done. */
  understood: string[];
  /** Shown when nothing could be done, or as extra context. */
  message: string;
  label: string;
  accepted: number;
  rejected: RejectedOp[];
  adjusted: { op: EditOp; note: string }[];
}

export interface RevisionProposal {
  /** Project with the revision applied. Not committed. */
  preview: Project;
  outcome: RevisionOutcome;
}

/** What the built-in rules can do without Claude. */
export const LOCAL_REVISION_HELP = 'Without an AI model, Cutaway understands: "less movement", "no zooms", "more movement", "tighter", "slower" and "keep this" (lock).';

function describe(lane: RevisionLane, x: Record<string, unknown>): string {
  switch (lane) {
    case 'cuts':
      return `cut (${String(x.kind)})`;
    case 'speeds':
      return `speed ×${String(x.speed)}`;
    case 'layouts':
      return `view ${String(x.mode)}${x.mode === 'screen' ? '' : ` camera ${String(x.camera)}`}`;
    case 'zooms':
      return `zoom ×${Number(x.scale).toFixed(2)}${x.follow ? ' following the cursor' : ''}`;
    case 'overlays':
      return `${String(x.kind)} "${String(x.text)}"`;
    case 'broll':
      return `B-roll ${String(x.assetId)}`;
  }
}

function decisionsIn(p: Project, range: Range): RevisionDecision[] {
  const lanes: RevisionLane[] = ['cuts', 'speeds', 'layouts', 'zooms', 'overlays', 'broll'];
  const out: RevisionDecision[] = [];
  for (const lane of lanes) {
    for (const item of p.edit[lane] as (Range & { meta: DecisionMeta })[]) {
      if (!overlaps(item, range)) continue;
      out.push({ lane, start: item.start, end: item.end, origin: item.meta.origin, locked: !!item.meta.locked, description: describe(lane, item as unknown as Record<string, unknown>) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function unchanged(ctx: JobContext, ai: AiUse, label: string, message: string): RevisionProposal {
  return { preview: ctx.get(), outcome: { ai, changed: false, understood: [], message, label, accepted: 0, rejected: [], adjusted: [] } };
}

/** Deterministic handling of a few common requests. */
function localRevision(ctx: JobContext, range: Range, instruction: string, ai: AiUse): RevisionProposal {
  const p = ctx.get();
  const text = instruction.toLowerCase();
  const label = `Revise: ${instruction.trim().slice(0, 48)}`;
  const understood: string[] = [];
  const replace = new Set<RevisionLane>();
  const ops: EditOp[] = [];
  let lock = false;

  const aiZooms = p.edit.zooms.filter((z) => z.meta.origin === 'ai' && !z.meta.locked && overlaps(z, range));
  const clip = (r: Range): Range => ({ start: Math.max(r.start, range.start), end: Math.min(r.end, range.end) });
  const movement = /(movement|motion|zoom|pan|busy|dizzy|animation)/.test(text);

  if (/\b(keep|lock|intact|leave)\b|don'?t (cut|touch|change)|do not (cut|touch|change)/.test(text) && !movement) {
    lock = true;
    understood.push('Locked this section so later cleanup cannot change it.');
  } else if (movement && /\b(no|remove|without|stop|kill)\b/.test(text)) {
    replace.add('zooms');
    understood.push(`Removed ${aiZooms.length} automatic zoom${aiZooms.length === 1 ? '' : 's'} in this section.`);
  } else if (movement && /\b(less|fewer|reduce|calm|calmer|gentle|gentler|subtle|tone down|too much)\b/.test(text)) {
    replace.add('zooms');
    // Keep every other automatic zoom, and make the survivors gentler.
    const keep = aiZooms.filter((_, i) => i % 2 === 0);
    for (const z of keep) ops.push({ op: 'zoom', ...clip(z), scale: Math.max(1.15, 1 + (z.scale - 1) * 0.6), x: z.x, y: z.y, follow: z.follow, reason: 'Gentler zoom, as requested', confidence: 'high' });
    understood.push(`Reduced movement: ${aiZooms.length - keep.length} of ${aiZooms.length} automatic zooms removed, the rest made gentler.`);
  } else if (movement && /\b(more|add|extra|lively|livelier|energetic|punch)\b/.test(text)) {
    replace.add('zooms');
    for (const z of aiZooms) ops.push({ op: 'zoom', ...clip(z), scale: Math.min(4, 1 + (z.scale - 1) * 1.3), x: z.x, y: z.y, follow: z.follow, reason: 'Stronger zoom, as requested', confidence: 'high' });
    if (sourceByRole(p, 'screen')) {
      const clicks = (p.analysis?.clicks ?? []).filter((c) => c.t >= range.start && c.t <= range.end);
      for (const z of proposeZooms(clicks, p.duration, 'lively')) if (!aiZooms.some((e) => overlaps(e, z)) && !p.edit.zooms.some((e) => e.meta.origin === 'creator' && overlaps(e, z))) ops.push(z);
    }
    understood.push('Added movement: existing automatic zooms are stronger and click moments without a zoom get one.');
  } else if (/\b(tight|tighter|tighten|faster|quicker|shorter|snappier|trim)\b/.test(text) || /\b(slower|slow down|relax|relaxed|breathe|breathing|room|loosen|less rushed)\b/.test(text)) {
    const slower = /\b(slower|slow down|relax|relaxed|breathe|breathing|room|loosen|less rushed)\b/.test(text);
    const a = p.analysis;
    const words = p.transcript?.words ?? [];
    const hasSpeech = !!p.transcript?.hasSpeech && words.length > 0;
    if (!hasSpeech && !(a && a.activity.length)) return unchanged(ctx, ai, label, 'There is no transcript or screen activity to pace this section by.');
    if (slower) replace.add('cuts');
    const proposed = proposePacing({ duration: p.duration, words, hasSpeech, brief: { pacing: slower ? 'relaxed' : 'energetic' }, activity: a?.activity ?? [], activityHz: a?.activityHz || 4, clicks: a?.clicks ?? [] });
    for (const o of proposed) if (overlaps(o, range)) ops.push(o);
    understood.push(slower ? 'Slower pacing: automatic pause cuts in this section were redone with more room.' : 'Tighter pacing: pauses in this section were shortened further where nothing happens on screen.');
  } else {
    return unchanged(ctx, ai, label, `That request needs Claude Code or Codex. ${LOCAL_REVISION_HELP}`);
  }

  if (lock) {
    const saved = checkpoint(p, `Before: ${label}`, 'creator');
    const preview = checkpoint(commitEdit(saved, addLock(saved.edit, range, instruction.trim().slice(0, 120))), label, 'creator');
    return { preview, outcome: { ai, changed: true, understood, message: '', label, accepted: 0, rejected: [], adjusted: [] } };
  }
  const out = applyProposal(p, ops, { label, scope: range, replaceAi: [...replace] });
  const changed = JSON.stringify(out.project.edit) !== JSON.stringify(p.edit);
  return {
    preview: changed ? out.project : p,
    outcome: { ai, changed, understood: changed ? understood : [], message: changed ? '' : 'Nothing in this section could be changed that way: there were no automatic decisions of that kind here.', label, accepted: out.accepted, rejected: out.rejected, adjusted: out.adjusted },
  };
}

export async function proposeRevision(ctx: JobContext, range: Range, instruction: string): Promise<RevisionProposal> {
  const p = ctx.get();
  const scope: Range = { start: Math.max(0, Math.min(range.start, range.end)), end: Math.min(p.duration, Math.max(range.start, range.end)) };
  if (scope.end - scope.start < 0.2) throw new JobError('assemble', 'failed', 'Select a longer section to revise.', false);
  if (!instruction.trim()) throw new JobError('assemble', 'failed', 'Describe the change you want.', false);
  if (ctx.signal.aborted) throw new JobError('assemble', 'cancelled', 'Cancelled.', true);

  const gate = await claudeGate(ctx);
  if (!gate.usable) return localRevision(ctx, scope, instruction, { mode: 'local-rules', reason: gate.reason, fellBack: gate.fellBack });

  const label = `Revise: ${instruction.trim().slice(0, 48)}`;
  const wants: FrameWant[] = [];
  if (sourceByRole(p, 'screen')) for (const f of [0.1, 0.35, 0.65, 0.9]) wants.push({ sessionTime: scope.start + (scope.end - scope.start) * f, role: 'screen' });
  wants.push({ sessionTime: (scope.start + scope.end) / 2, role: 'cameraA' }, { sessionTime: (scope.start + scope.end) / 2, role: 'cameraB' });
  const { stills, imageDir } = await extractStills(ctx, p, wants);
  if (ctx.signal.aborted) throw new JobError('assemble', 'cancelled', 'Cancelled.', true);
  const keyframes: PromptKeyframe[] = stills.map((s) => ({ file: s.file, sessionTime: s.sessionTime, source: s.source }));
  const inScope = (r: Range) => r.end > scope.start && r.start < scope.end;
  const prompt = buildRevisionPrompt({
    projectName: p.name,
    playbookNotes: ctx.settings.playbookNotes,
    instruction,
    scope,
    duration: p.duration,
    brief: p.brief,
    sources: promptSources(p),
    hasSpeech: !!p.transcript?.hasSpeech,
    sentences: promptSentences(p, scope),
    decisions: decisionsIn(p, scope),
    activeRanges: screenActivity(p).filter(inScope),
    clickClusters: clusterClicks(p.analysis?.clicks ?? []).filter(inScope),
    assets: p.brief.allowBroll ? promptAssets(p) : [],
    locks: p.edit.locks.filter(inScope).map((l) => ({ start: l.start, end: l.end, note: l.note })),
    keeps: p.edit.keeps.filter(inScope),
    keyframes,
  });
  const res = await askClaude(ctx, { purpose: 'local-revision', prompt, schema: REVISION_SCHEMA as unknown as Record<string, unknown>, imagePaths: stills.map((s) => s.path), imageDir });
  if (!res.ok && (res.error?.code === 'cancelled' || ctx.signal.aborted)) throw new JobError('assemble', 'cancelled', 'Cancelled. Nothing was changed.', true);

  const fallBack = (reason: string) => localRevision(ctx, scope, instruction, { mode: 'local-rules', reason, fellBack: true });
  if (!res.ok) return fallBack(res.error?.message ?? `${gate.app} failed.`);
  let reply: ReturnType<typeof parseRevision>;
  try {
    reply = parseRevision(res.data);
  } catch (e) {
    return fallBack(e instanceof AiParseError ? `${gate.name}'s reply could not be used (${e.message})` : errorText(e));
  }
  const ai: AiUse = { mode: 'claude', provider: res.provider ?? gate.provider, reason: null, fellBack: false };
  // The project may not change while the creator waits, but apply to the latest state anyway.
  const q = ctx.get();
  if (reply.lock && reply.ops.length === 0) {
    const saved = checkpoint(q, `Before: ${label}`, 'creator');
    const preview = checkpoint(commitEdit(saved, addLock(saved.edit, scope, instruction.trim().slice(0, 120))), label, 'creator');
    return { preview, outcome: { ai, changed: true, understood: [reply.understood || 'Locked this section.'], message: '', label, accepted: 0, rejected: [], adjusted: [] } };
  }
  const out = applyProposal(q, reply.ops, { label, scope, replaceAi: reply.replace });
  const changed = JSON.stringify(out.project.edit) !== JSON.stringify(q.edit);
  return {
    preview: changed ? out.project : q,
    outcome: {
      ai,
      changed,
      understood: reply.understood ? [reply.understood] : [],
      message: changed ? reply.notes.join(' ') : `${gate.name} did not find anything it could safely change in this section.`,
      label,
      accepted: out.accepted,
      rejected: out.rejected,
      adjusted: out.adjusted,
    },
  };
}
