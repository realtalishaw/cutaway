/**
 * Thumbnail/title concepts grounded in the finished edit.
 *
 * With Claude: three concepts chosen from real frames of the cut, each
 * checked for unsupported numbers, guarantees and unverifiable quotes before
 * it is shown. Without Claude: three template concepts built only from the
 * project's own words. Either way the result is a set of editable layers.
 */
import { AiParseError, PACKAGING_SCHEMA, buildPackagingPrompt, makesGuarantee, parsePackaging, type PackagingFrame, type PackagingSentence } from '@cutaway/ai';
import {
  PALETTES,
  TITLE_MAX,
  TimeMap,
  checkDescription,
  checkTitle,
  checkpoint,
  conceptFromTemplate,
  keptWords,
  normalizeWord,
  sentences,
  sourceByRole,
  unsupportedNumbers,
  type PackagingConcept,
  type Project,
  type ThumbTemplate,
} from '@cutaway/core';
import { JobError, type AiUse, type JobContext } from './types';
import { Stager, askClaude, checkAbort, claudeGate, clusterClicks, extractStills, spread, type FrameWant, type Still } from './shared';

export interface PackagingResult {
  ai: AiUse;
  /** New concepts added by this run. */
  added: number;
  /** Creator-edited or selected concepts that were kept untouched. */
  kept: number;
  notes: string[];
}

interface KeptSentence extends PackagingSentence {
  end: number;
}

function keptSentences(p: Project, map: TimeMap): KeptSentence[] {
  const kept = keptWords(p.transcript, map).map((k) => k.word);
  return sentences(kept).map((s) => ({
    sessionTime: s.start,
    end: s.end,
    outputTime: map.toOutput(s.start),
    text: s.wordIds.map((id) => p.edit.wordText[id] ?? kept.find((w) => w.id === id)?.text ?? '').join(' '),
  }));
}

function frameWants(p: Project, map: TimeMap, ks: KeptSentence[]): FrameWant[] {
  const kept = (t: number) => map.isKept(t);
  const dur = p.duration;
  const wants: FrameWant[] = [];
  const hasScreen = !!sourceByRole(p, 'screen');
  const talk = ks.length ? ks.map((s) => ({ t: Math.min(dur, s.sessionTime + 0.8), priority: Math.min(3, s.text.split(' ').length / 6) })) : [0.15, 0.4, 0.65, 0.9].map((f) => ({ t: map.toSource(map.outDuration * f), priority: 1 }));
  for (const t of spread(talk.filter((c) => kept(c.t)), hasScreen ? 3 : 6, Math.max(4, dur / 10))) wants.push({ sessionTime: t, role: 'cameraA' });
  for (const t of spread(talk.filter((c) => kept(c.t)), hasScreen ? 1 : 2, Math.max(8, dur / 4))) wants.push({ sessionTime: Math.min(dur, t + 0.3), role: 'cameraB' });
  if (hasScreen) {
    const cands: { t: number; priority: number }[] = [];
    for (const z of p.edit.zooms) cands.push({ t: (z.start + z.end) / 2, priority: 3 });
    for (const c of clusterClicks(p.analysis?.clicks ?? [])) cands.push({ t: c.end + 0.6, priority: 2 + Math.min(1, c.count / 8) });
    for (const f of [0.2, 0.5, 0.8]) cands.push({ t: map.toSource(map.outDuration * f), priority: 1 });
    for (const t of spread(cands.filter((c) => c.t >= 0 && c.t <= dur && kept(c.t)), 4, Math.max(4, dur / 12))) wants.push({ sessionTime: t, role: 'screen' });
  }
  return wants;
}

const STOP = new Set('about above after again also been before being both could does doing down during each from have having here into just like more most only other over same should some such than that their them then there these they this those through under until very want were what when where which while with would your yours going really thing things okay right actually basically because'.split(' '));

function keywords(text: string, max: number): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.split(/\s+/)) {
    const w = normalizeWord(raw);
    if (w.length < 4 || STOP.has(w) || /\d/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const firstWords = (s: string, count: number) => s.split(/\s+/).filter(Boolean).slice(0, count).join(' ');

/** Three concepts made only from the project's own name, chapters and spoken words. */
export function templateConcepts(p: Project, ks: KeptSentence[], stills: Still[]): PackagingConcept[] {
  const name = p.name.trim() || 'Untitled';
  const hasScreen = !!sourceByRole(p, 'screen');
  const chapterTitles = p.packaging.chapters.map((c) => c.title.trim()).filter(Boolean);
  const keys = keywords(ks.map((s) => s.text).join(' '), 3);
  const frameFor = (prefer: Still['source'][], nth: number) => {
    const pool = prefer.flatMap((r) => stills.filter((s) => s.source === r));
    const s = pool[nth % Math.max(1, pool.length)] ?? stills[nth % Math.max(1, stills.length)];
    return s ? { sourceId: s.sourceId, time: s.sourceTime } : null;
  };
  const why = 'Built from your project name and your own words. Claude was not used for this one.';

  const strong = ks
    .map((s) => ({ ...s, clean: s.text.replace(/^(so|okay|ok|alright|all right|well|and|now|um|uh)[,.]?\s+/i, '').replace(/[.!?,;:]+$/, '').trim() }))
    .find((s) => {
      const count = s.clean.split(/\s+/).length;
      return count >= 4 && count <= 14 && s.clean.length <= TITLE_MAX;
    });

  const drafts: { template: ThumbTemplate; title: string; text: string; frame: ReturnType<typeof frameFor>; evidence: PackagingConcept['evidence'] }[] = [];
  drafts.push({ template: 'headline', title: name, text: firstWords(name, 4), frame: frameFor(['cameraA', 'cameraB', 'screen'], 0), evidence: [] });
  if (strong) drafts.push({ template: 'banner', title: cap(strong.clean), text: chapterTitles[0] ? firstWords(chapterTitles[0], 5) : keys.length ? keys.slice(0, 2).join(' ') : firstWords(strong.clean, 4), frame: frameFor(['screen', 'cameraA'], 0), evidence: [{ sessionTime: strong.sessionTime, quote: strong.text }] });
  else drafts.push({ template: 'banner', title: `${name}, step by step`, text: 'Step by step', frame: frameFor(['screen', 'cameraA'], 0), evidence: [] });
  if (chapterTitles.length >= 2) {
    const list = chapterTitles.slice(0, 3);
    const joined = list.length === 3 ? `${list[0]}, ${list[1]} and ${list[2]}` : `${list[0]} and ${list[1]}`;
    drafts.push({ template: 'badge', title: `${name}: ${joined}`, text: firstWords([...chapterTitles].sort((a, b) => a.length - b.length)[0]!, 5), frame: frameFor(['screen', 'cameraA'], 1), evidence: p.packaging.chapters.slice(0, 3).map((c) => ({ sessionTime: c.sessionTime, quote: c.title })) });
  } else {
    const silent = !p.transcript?.hasSpeech;
    drafts.push({ template: 'badge', title: silent ? `${name}: a silent walkthrough` : hasScreen ? `${name}: a walkthrough` : `${name}, explained`, text: keys.length ? keys.slice(0, 2).join(' ') : hasScreen ? 'Walkthrough' : 'Explained', frame: frameFor(['screen', 'cameraA'], 1), evidence: [] });
  }
  const seen = new Set<string>();
  return drafts.map((d, i) => {
    let title = d.title.replace(/[<>]/g, '').slice(0, TITLE_MAX);
    if (seen.has(title.toLowerCase())) title = `${title} (${i + 1})`.slice(0, TITLE_MAX);
    seen.add(title.toLowerCase());
    return conceptFromTemplate(d.template, title, d.text || firstWords(name, 4), d.frame, PALETTES[i % PALETTES.length]!, why, d.evidence, 'template');
  });
}

function quoteIsSpoken(quote: string, spoken: string): boolean {
  const q = quote.split(/\s+/).map(normalizeWord).filter(Boolean).join(' ');
  return q.length > 0 && spoken.includes(q);
}

export async function generatePackaging(ctx: JobContext): Promise<PackagingResult> {
  const st = new Stager(ctx, ['packaging'], { packaging: ctx.useClaude });
  const notes: string[] = [];
  try {
    checkAbort(ctx, 'packaging');
    st.start('packaging', 'Picking real frames from the finished cut…');
    const p = ctx.get();
    const map = TimeMap.fromEdit(p.duration, p.edit);
    if (map.outDuration < 0.5) throw new JobError('packaging', 'failed', 'The edit is empty, so there is nothing to package yet.', false);
    const ks = keptSentences(p, map);
    const hasSpeech = !!p.transcript?.hasSpeech && ks.length > 0;
    const { stills, imageDir } = await extractStills(ctx, p, frameWants(p, map, ks));
    checkAbort(ctx, 'packaging');
    if (stills.length === 0) notes.push('No frames could be extracted, so the thumbnails are typography only until you pick a frame.');

    const gate = await claudeGate(ctx);
    st.patch('packaging', { remote: gate.usable });
    let ai: AiUse = { mode: 'local-rules', reason: gate.reason, fellBack: gate.fellBack };
    let fresh: PackagingConcept[] = [];
    let description = '';
    let chapters: Project['packaging']['chapters'] = [];
    const fallback = templateConcepts(p, ks, stills);

    if (gate.usable) {
      const frames: PackagingFrame[] = stills.map((s, i) => ({ index: i, file: s.file, source: s.source, sessionTime: s.sessionTime, outputTime: map.toOutput(s.sessionTime) }));
      const prompt = buildPackagingPrompt({
        projectName: p.name,
        brief: p.brief,
        outDuration: map.outDuration,
        hasSpeech,
        sentences: ks.map(({ outputTime, sessionTime, text }) => ({ outputTime, sessionTime, text })),
        visualMoments: hasSpeech ? [] : clusterClicks(p.analysis?.clicks ?? []).filter((c) => map.isKept(c.start)).slice(0, 30).map((c) => ({ outputTime: map.toOutput(c.start), sessionTime: c.start, description: `${c.count} click${c.count === 1 ? '' : 's'} on screen` })),
        frames,
        paletteCount: PALETTES.length,
        chapters: p.packaging.chapters,
        editSummary: p.firstCut?.summary ?? '',
      });
      st.detail('packaging', `Claude is reading the finished cut${frames.length ? ` and ${frames.length} frame${frames.length === 1 ? '' : 's'}` : ''}. Video and audio stay on this Mac.`);
      const res = await askClaude(ctx, { purpose: 'packaging', prompt, schema: PACKAGING_SCHEMA as unknown as Record<string, unknown>, imagePaths: stills.map((s) => s.path), imageDir });
      if (!res.ok && (res.error?.code === 'cancelled' || ctx.signal.aborted)) throw new JobError('packaging', 'cancelled', 'Cancelled. Your existing thumbnails and titles are unchanged.', true);
      if (res.ok) {
        try {
          const reply = parsePackaging(res.data, { frameCount: stills.length, paletteCount: PALETTES.length });
          const spoken = (p.transcript?.words ?? []).map((w) => normalizeWord(p.edit.wordText[w.id] ?? w.text)).filter(Boolean).join(' ');
          fresh = reply.concepts.map((c, i) => {
            const claim = `${c.title} ${c.thumbnailText}`;
            const bad = !checkTitle(c.title).ok ? 'its title is not valid for YouTube' : makesGuarantee(claim) ? 'it promised an outcome' : unsupportedNumbers(claim, p).length ? `it used a figure ("${unsupportedNumbers(claim, p)[0]}") that is not in the recording` : null;
            if (bad) {
              notes.push(`One of Claude's concepts was replaced because ${bad}.`);
              return fallback[i]!;
            }
            const evidence = c.evidence.filter((e) => e.sessionTime <= p.duration && (!hasSpeech || quoteIsSpoken(e.quote, spoken)));
            const still = stills[c.frameIndex];
            return conceptFromTemplate(c.template, c.title, c.thumbnailText, still ? { sourceId: still.sourceId, time: still.sourceTime } : null, PALETTES[c.paletteIndex] ?? PALETTES[i % PALETTES.length]!, c.rationale, evidence, 'ai');
          });
          if (checkDescription(reply.description).ok && !makesGuarantee(reply.description) && unsupportedNumbers(reply.description, p).length === 0) description = reply.description;
          chapters = reply.chapters.filter((c) => c.sessionTime <= p.duration);
          ai = { mode: 'claude', reason: null, fellBack: false };
        } catch (e) {
          ai = { mode: 'local-rules', reason: e instanceof AiParseError ? `Claude's reply could not be used (${e.message})` : String(e), fellBack: true };
        }
      } else ai = { mode: 'local-rules', reason: res.error?.message ?? 'Claude Code failed.', fellBack: true };
    }
    if (ai.mode !== 'claude') {
      fresh = fallback;
      if (hasSpeech) description = ks.slice(0, 2).map((s) => s.text).join(' ').slice(0, 400);
    }

    checkAbort(ctx, 'packaging');
    const q = ctx.get();
    const saved = checkpoint(q, 'Packaging generated', 'creator');
    const keep = q.packaging.concepts.filter((c) => c.editedByCreator || c.id === q.packaging.selectedId);
    const next: Project = {
      ...saved,
      packaging: {
        ...q.packaging,
        concepts: [...keep, ...fresh],
        selectedId: keep.some((c) => c.id === q.packaging.selectedId) ? q.packaging.selectedId : null,
        // The creator's own description and chapters are never overwritten.
        description: q.packaging.description.trim() ? q.packaging.description : description,
        chapters: q.packaging.chapters.length ? q.packaging.chapters : chapters.length >= 3 ? chapters : [],
        basedOnRevision: q.revision,
        stale: false,
        staleReason: null,
        reviewed: false,
      },
    };
    ctx.update(() => next);
    const how = ai.mode === 'claude' ? 'from Claude, grounded in the finished cut' : ai.fellBack ? `built from your own words because Claude was not used (${ai.reason})` : 'built from your own words on this Mac';
    st.done('packaging', `${fresh.length} thumbnail and title concepts ${how}.${keep.length ? ` ${keep.length} you edited or selected ${keep.length === 1 ? 'was' : 'were'} kept.` : ''}`);
    return { ai, added: fresh.length, kept: keep.length, notes };
  } catch (e) {
    const je = e instanceof JobError ? e : new JobError('packaging', ctx.signal.aborted ? 'cancelled' : 'failed', e instanceof Error ? e.message : String(e), true);
    st.fail('packaging', je.message);
    throw je;
  }
}
