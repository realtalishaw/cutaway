/**
 * Finding shorts in the open edit.
 *
 * With a provider allowed and available, it is asked through the shared gate
 * (claudeGate / askClaude), with transcript text and edit metadata only: no
 * stills, no media. Its reply is untrusted and only becomes candidates after
 * @cutaway/core has snapped and validated every range. Otherwise, or when the
 * reply cannot be used, Cutaway's own rules pick candidates on this Mac and
 * the result says so. Nothing is added to the project here; the creator keeps
 * the candidates they want.
 */
import { SHORTS_SCHEMA, buildShortsPrompt } from '@cutaway/ai/shorts';
import { TimeMap, displayText, flagsOf, parseShortCandidates, ruleShortCandidates, sentences, shortsOf, type Project, type Range, type ShortCandidate } from '@cutaway/core';
import type { PromptSentence } from '@cutaway/ai';
import { JobError, type AiUse, type JobContext } from './types';
import { askClaude, claudeGate, errorText } from './shared';

export interface FoundShorts {
  candidates: ShortCandidate[];
  ai: AiUse;
  /** One honest line for the screen: who picked these, and anything that was left out. */
  note: string;
}

/** Sentences of the footage that is still in the video, in session time. */
export function keptSentences(project: Pick<Project, 'transcript' | 'duration' | 'edit'>): PromptSentence[] {
  const map = TimeMap.fromEdit(project.duration, project.edit);
  const words = (project.transcript?.words ?? []).filter((w) => map.isKept((w.start + w.end) / 2));
  const byId = new Map(words.map((w) => [w.id, w]));
  return sentences(words).map((s) => ({ index: s.index, start: s.start, end: s.end, text: s.wordIds.map((id) => displayText(byId.get(id)!, project.edit)).join(' ') }));
}

function byRules(p: Project, taken: Range[], ai: AiUse, count: number): FoundShorts {
  const candidates = ruleShortCandidates(p, { max: count, taken });
  const why = ai.reason ? `${ai.reason} ` : '';
  const note = candidates.length
    ? `${why}Picked on this Mac by Cutaway's built-in rules: flagged moments, clean sentence starts, and opening lines with a question or a number.`
    : `${why}The built-in rules found no stretch of 15 to 90 seconds that stands on its own. Select a range in the editor and make one by hand.`;
  return { candidates, ai, note };
}

export async function findShorts(ctx: JobContext, count = 4): Promise<FoundShorts> {
  if (ctx.signal.aborted) throw new JobError('assemble', 'cancelled', 'Cancelled.', true);
  const p = ctx.get();
  const taken: Range[] = shortsOf(p).map((s) => ({ start: s.start, end: s.end }));
  const gate = await claudeGate(ctx);
  if (!gate.usable) return byRules(p, taken, { mode: 'local-rules', reason: gate.reason, fellBack: gate.fellBack }, count);

  const map = TimeMap.fromEdit(p.duration, p.edit);
  const prompt = buildShortsPrompt({
    projectName: p.name,
    brief: p.brief,
    duration: p.duration,
    outputDuration: map.outDuration,
    sentences: keptSentences(p),
    cuts: p.edit.cuts.map((c) => ({ start: c.start, end: c.end })),
    flags: flagsOf(p)
      .filter((f) => !f.parked)
      .map((f) => f.t),
    taken,
    count,
    titleNotes: ctx.settings.playbookNotes?.titles,
  });
  const res = await askClaude(ctx, { purpose: 'packaging', prompt, schema: SHORTS_SCHEMA as unknown as Record<string, unknown>, imagePaths: [], imageDir: null });
  if (!res.ok && (res.error?.code === 'cancelled' || ctx.signal.aborted)) throw new JobError('assemble', 'cancelled', 'Cancelled. Nothing was changed.', true);
  const fallBack = (reason: string) => byRules(ctx.get(), taken, { mode: 'local-rules', provider: gate.provider, reason, fellBack: true }, count);
  if (!res.ok) return fallBack(`${gate.name} could not be used (${res.error?.message ?? 'it failed'}).`);
  let parsed: ReturnType<typeof parseShortCandidates>;
  try {
    parsed = parseShortCandidates(res.data, ctx.get(), { max: count, taken });
  } catch (e) {
    return fallBack(`${gate.name}'s reply could not be used (${errorText(e)}).`);
  }
  if (parsed.candidates.length === 0) {
    const first = parsed.rejected[0]?.reason;
    return fallBack(first ? `Nothing ${gate.name} proposed could be used (${first.replace(/\.$/, '')}).` : `${gate.name} found no stretch that stands on its own.`);
  }
  const dropped = parsed.rejected.filter((r) => r.index >= 0).length;
  const note = `Proposed by ${gate.name} from your transcript; every range was then fitted to whole sentences by Cutaway.${dropped ? ` ${dropped} proposal${dropped === 1 ? ' was' : 's were'} left out (${parsed.rejected.find((r) => r.index >= 0)!.reason.replace(/\.$/, '')}).` : ''}`;
  return { candidates: parsed.candidates, ai: { mode: 'claude', provider: gate.provider, reason: null, fellBack: false }, note };
}
