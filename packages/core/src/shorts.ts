/**
 * Shorts: vertical clips cut from the long video.
 *
 * A short is a small saved thing in the project: a range of the session
 * timeline plus a shape, a framing and a caption style. It is not a copy of
 * the edit. To play or export one, `shortProject` derives a project that
 * plays only that range through the long edit's own cuts and speed changes,
 * in the short's frame. The derived project goes through the same compositor
 * and exporter as everything else, and the long video's edit is never touched.
 */
import type { CameraSlot, Cut, DecisionMeta, EditState, LayoutSegment, MusicClip, Project, Range, Seconds, Short, ShortCaptionPreset, ShortCaptions, ShortFraming, ShortShape, TextFont, Transcript, Word } from './types';
import { EPS, uid } from './ranges';
import { TimeMap } from './timemap';
import { sentences } from './analysis';
import { displayText, keptWords, type Cue } from './captions';
import { faceAt, type CameraCrop, type FaceTrackSmooth } from './parity';
import { musicClipsOf, withMusic } from './music';
import { cameraSourceAt, covers, sourceAt } from './sync';
import { flagsOf } from './flags';

// ───────────────────────────── limits and basics ─────────────────────────────

/** Length limits in finished (output) seconds. Proposals must be inside them; a short made by hand may be shorter. */
export const SHORT_LIMITS = { min: 15, max: 90, handMin: 3, targetMin: 28, targetMax: 58 } as const;

export const shortsOf = (project: Pick<Project, 'shorts'>): Short[] => project.shorts ?? [];

export function shortOutput(shape: ShortShape, fps: number): { width: number; height: number; fps: number } {
  return shape === 'square' ? { width: 1080, height: 1080, fps } : { width: 1080, height: 1920, fps };
}

type Timed = Pick<Project, 'duration' | 'edit'>;

const longMap = (project: Timed): TimeMap => TimeMap.fromEdit(project.duration, project.edit);

/** The time map of a short: the long edit, with everything outside the short's range removed as well. */
export function shortMap(project: Timed, range: Range): TimeMap {
  const outside: Range[] = [];
  if (range.start > EPS) outside.push({ start: 0, end: range.start });
  if (range.end < project.duration - EPS) outside.push({ start: range.end, end: project.duration });
  return new TimeMap(project.duration, [...project.edit.cuts, ...outside], project.edit.speeds);
}

/** How long a short runs once the long edit's cuts and speed changes are applied. */
export const shortDuration = (project: Timed, range: Range): Seconds => shortMap(project, range).outDuration;

// ───────────────────────────── what can be framed ─────────────────────────────

/** Which pictures exist inside a range (sampled over the footage that survives the edit). */
export function shortSources(project: Pick<Project, 'sources' | 'duration' | 'edit'>, range: Range): { camera: CameraSlot | null; screen: boolean } {
  const map = shortMap(project, range);
  const n = Math.max(3, Math.min(40, Math.ceil(map.outDuration)));
  let a = 0;
  let b = 0;
  let screen = 0;
  for (let i = 0; i < n; i++) {
    const t = map.toSource(((i + 0.5) / n) * map.outDuration);
    if (covers(cameraSourceAt(project, 'A', t), t)) a++;
    if (covers(cameraSourceAt(project, 'B', t), t)) b++;
    if (covers(sourceAt(project, 'screen', t), t)) screen++;
  }
  const need = n * 0.5;
  return { camera: a >= need && a >= b ? 'A' : b >= need ? 'B' : a > 0 ? 'A' : b > 0 ? 'B' : null, screen: screen >= need };
}

export const SHORT_FRAMINGS: { id: ShortFraming; name: string; hint: string }[] = [
  { id: 'face', name: 'Face', hint: 'The camera fills the frame and follows you.' },
  { id: 'stack', name: 'Stack', hint: 'The whole screen on top, you below.' },
  { id: 'screen', name: 'Screen follow', hint: 'The screen fills the frame and follows the pointer.' },
  { id: 'original', name: 'As edited', hint: 'The views of the long video, fitted into this shape.' },
];

/** The framings that make sense for a range, best first. */
export function shortFramings(project: Pick<Project, 'sources' | 'duration' | 'edit'>, range: Range): ShortFraming[] {
  const s = shortSources(project, range);
  if (s.camera && s.screen) return ['face', 'stack', 'screen', 'original'];
  if (s.camera) return ['face', 'original'];
  if (s.screen) return ['screen', 'original'];
  return ['original'];
}

export const defaultShortCaptions = (framing: ShortFraming): ShortCaptions => ({ preset: 'pop', position: framing === 'stack' ? 'middle' : 'low', size: 1 });

// ───────────────────────────── ranges: snapping and validation ─────────────────────────────

export type ShortRange = { ok: true; range: Range; duration: Seconds; notes: string[] } | { ok: false; reason: string };

interface Kept {
  word: Word;
  /** The kept stretch of footage this word sits in (session time). */
  seg: Range;
}

/** Spoken words that survive the long edit, each with the kept stretch it sits in. Fillers are words too. */
function keptSpoken(project: Pick<Project, 'transcript' | 'duration' | 'edit'>, map: TimeMap): Kept[] {
  const out: Kept[] = [];
  const kept = map.keptRanges();
  for (const w of project.transcript?.words ?? []) {
    const mid = (w.start + w.end) / 2;
    const seg = kept.find((k) => mid >= k.start - EPS && mid < k.end - EPS);
    if (seg) out.push({ word: w, seg });
  }
  return out.sort((x, y) => x.word.start - y.word.start);
}

/**
 * Fit a wanted range to the footage: it starts at the beginning of a sentence
 * and ends at the end of one, never in the middle of a word and never inside
 * a cut, and its finished length is inside the limits. Without speech it is
 * only kept out of cuts and inside the limits.
 */
export function snapShortRange(project: Pick<Project, 'transcript' | 'duration' | 'edit'>, raw: Range, limits: { min: number; max: number } = SHORT_LIMITS): ShortRange {
  if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end)) return { ok: false, reason: 'The range is not a pair of times.' };
  const want = { start: Math.max(0, Math.min(raw.start, raw.end)), end: Math.min(project.duration, Math.max(raw.start, raw.end)) };
  if (want.end - want.start < 0.5) return { ok: false, reason: 'The range is empty or outside the video.' };
  const map = longMap(project);
  const notes: string[] = [];
  const out = (r: Range) => map.rangeToOutput(r).reduce((n, x) => n + (x.end - x.start), 0);
  const words = keptSpoken(project, map);

  if (words.length < 3) {
    // No speech to hold on to: keep out of the cuts and inside the limits.
    const kept = map.keptRanges().filter((k) => k.end > want.start + EPS && k.start < want.end - EPS);
    if (kept.length === 0) return { ok: false, reason: 'Everything in this range was cut from the video.' };
    let range = { start: Math.max(want.start, kept[0]!.start), end: Math.min(want.end, kept[kept.length - 1]!.end) };
    if (out(range) > limits.max) {
      range = { start: range.start, end: map.toSource(map.toOutput(range.start) + limits.max) };
      notes.push(`Shortened to ${limits.max} seconds.`);
    }
    const duration = out(range);
    if (duration < limits.min - 0.05) return { ok: false, reason: `Only ${duration.toFixed(1)} seconds of this range are in the video; a short needs at least ${limits.min}.` };
    return { ok: true, range, duration, notes };
  }

  const byId = new Map(words.map((k) => [k.word.id, k]));
  const sents = sentences(words.map((k) => k.word)).map((s) => ({ first: byId.get(s.wordIds[0]!)!, last: byId.get(s.wordIds[s.wordIds.length - 1]!)!, ids: s.wordIds }));
  const nearest = (t: number, pick: (s: (typeof sents)[number]) => number, from = 0) => {
    let best = from;
    for (let i = from; i < sents.length; i++) if (Math.abs(pick(sents[i]!) - t) < Math.abs(pick(sents[best]!) - t)) best = i;
    return best;
  };
  let a = nearest(want.start, (s) => s.first.word.start);
  let b = nearest(want.end, (s) => s.last.word.end, a);
  const index = new Map(words.map((k, i) => [k.word.id, i]));
  /** Session range from the first word of sentence i to the last word (or a given word) of sentence j, with a breath on each side. */
  const span = (i: number, j: number, lastWord?: Kept): Range => {
    const first = sents[i]!.first;
    const last = lastWord ?? sents[j]!.last;
    const before = words[index.get(first.word.id)! - 1];
    const after = words[index.get(last.word.id)! + 1];
    const floor = Math.max(first.seg.start, before && before.word.end <= first.word.start ? before.word.end : first.seg.start);
    const ceil = Math.min(last.seg.end, after && after.word.start >= last.word.end ? after.word.start : last.seg.end);
    const start = Math.min(first.word.start, Math.max(floor, first.word.start - 0.2));
    const end = Math.max(last.word.end, Math.min(ceil, last.word.end + 0.3));
    return { start: Math.max(0, Math.max(start, first.seg.start)), end: Math.min(project.duration, Math.min(end, last.seg.end)) };
  };

  let range = span(a, b);
  let cutShort = false;
  while (out(range) > limits.max && b > a) {
    b--;
    cutShort = true;
    range = span(a, b);
  }
  if (out(range) > limits.max) {
    // One very long sentence: end on the last whole word that fits.
    const first = index.get(sents[a]!.first.word.id)!;
    const lastIdx = index.get(sents[b]!.last.word.id)!;
    let k = lastIdx;
    while (k > first && out(span(a, b, words[k])) > limits.max) k--;
    range = span(a, b, words[k]);
    cutShort = true;
  }
  let grew = false;
  while (out(range) < limits.min && b < sents.length - 1 && out(span(a, b + 1)) <= limits.max) {
    b++;
    grew = true;
    range = span(a, b);
  }
  while (out(range) < limits.min && a > 0 && out(span(a - 1, b)) <= limits.max) {
    a--;
    grew = true;
    range = span(a, b);
  }
  const duration = out(range);
  if (duration < limits.min - 0.05) return { ok: false, reason: `There are only ${duration.toFixed(1)} seconds of speech around here; a short needs at least ${limits.min}.` };
  if (duration > limits.max + 0.05) return { ok: false, reason: `This cannot be brought under ${limits.max} seconds without stopping mid-word.` };
  if (cutShort) notes.push(`Shortened to end on a sentence inside ${limits.max} seconds.`);
  if (grew) notes.push(`Extended to whole sentences to reach ${limits.min} seconds.`);
  if (!cutShort && !grew && (Math.abs(range.start - want.start) > 0.35 || Math.abs(range.end - want.end) > 0.45)) notes.push('Moved to start and end on whole sentences.');
  return { ok: true, range, duration, notes };
}

/**
 * Move one end of a short by a whole sentence (dir −1 = earlier, +1 = later).
 * Returns the fitted range, or a reason when there is no sentence to move to
 * or the result would be too short or too long.
 */
export function nudgeShortRange(project: Pick<Project, 'transcript' | 'duration' | 'edit'>, range: Range, edge: 'start' | 'end', dir: -1 | 1): ShortRange {
  const limits = { min: SHORT_LIMITS.handMin, max: SHORT_LIMITS.max };
  const map = longMap(project);
  const words = keptSpoken(project, map).map((k) => k.word);
  const sents = sentences(words);
  if (sents.length === 0) {
    // No speech: move by two seconds of finished video.
    const at = map.toOutput(edge === 'start' ? range.start : range.end) + dir * 2;
    if (at < 0 || at > map.outDuration) return { ok: false, reason: 'That is the edge of the video.' };
    const t = map.toSource(at);
    return snapShortRange(project, edge === 'start' ? { start: t, end: range.end } : { start: range.start, end: t }, limits);
  }
  const pick = (t: number, of: (i: number) => number) => sents.reduce((best, _s, i) => (Math.abs(of(i) - t) < Math.abs(of(best) - t) ? i : best), 0);
  const a = pick(range.start, (i) => sents[i]!.start);
  const b = Math.max(a, pick(range.end, (i) => sents[i]!.end));
  const na = edge === 'start' ? a + dir : a;
  const nb = edge === 'end' ? b + dir : b;
  if (na < 0 || nb > sents.length - 1) return { ok: false, reason: 'That is the edge of the video.' };
  if (nb < na) return { ok: false, reason: 'A short needs at least one sentence.' };
  const snapped = snapShortRange(project, { start: sents[na]!.start, end: sents[nb]!.end }, limits);
  if (snapped.ok && Math.abs(snapped.range.start - range.start) < 0.01 && Math.abs(snapped.range.end - range.end) < 0.01) return { ok: false, reason: 'It cannot move further without breaking the length limits.' };
  return snapped;
}

/** The first sentence spoken inside a range, as it would be captioned. */
export function hookLine(project: Pick<Project, 'transcript' | 'duration' | 'edit'>, range: Range, maxChars = 140): string {
  const map = longMap(project);
  const words = keptSpoken(project, map)
    .map((k) => k.word)
    .filter((w) => w.start >= range.start - 0.05 && w.end <= range.end + 0.05);
  const first = sentences(words)[0];
  if (!first) return '';
  const byId = new Map(words.map((w) => [w.id, w]));
  const text = first.wordIds.map((id) => displayText(byId.get(id)!, project.edit)).join(' ');
  return text.length > maxChars ? `${text.slice(0, text.lastIndexOf(' ', maxChars - 1)).trimEnd()}…` : text;
}

// ───────────────────────────── candidates ─────────────────────────────

export interface ShortCandidate extends Range {
  title: string;
  /** One line on why this stretch works on its own. */
  reason: string;
  /** The opening line, as spoken. */
  hook: string;
  duration: Seconds;
  notes: string[];
}

const tidy = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const overlap = (x: Range, y: Range): number => Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start)) / Math.max(0.001, Math.min(x.end - x.start, y.end - y.start));

/** A title from a spoken line: no trailing punctuation, sentence case, at most `max` characters, cut at a word. */
export function titleFromLine(line: string, max = 60): string {
  let t = line.replace(/\s+/g, ' ').trim().replace(/[.,;:–—-]+$/, '');
  if (t.length > max) t = `${t.slice(0, t.lastIndexOf(' ', max - 1)).replace(/[.,;:–—-]+$/, '')}…`;
  return t ? t[0]!.toUpperCase() + t.slice(1) : 'Short';
}

/**
 * Candidates from an AI reply. The reply is untrusted: each entry must be an
 * object with a title and two finite times inside the video, is snapped to
 * whole sentences outside the cuts, and must then run 15–90 seconds. Anything
 * else is rejected with a reason; a candidate that mostly repeats an earlier
 * one is dropped.
 */
export function parseShortCandidates(raw: unknown, project: Pick<Project, 'transcript' | 'duration' | 'edit'>, opts: { max?: number; taken?: Range[] } = {}): { candidates: ShortCandidate[]; rejected: { index: number; reason: string }[] } {
  const max = opts.max ?? 5;
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { shorts?: unknown }).shorts) ? ((raw as { shorts: unknown[] }).shorts as unknown[]) : null;
  if (!list) return { candidates: [], rejected: [{ index: -1, reason: 'The reply has no list of shorts.' }] };
  const candidates: ShortCandidate[] = [];
  const rejected: { index: number; reason: string }[] = [];
  list.slice(0, 12).forEach((entry, index) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const start = e.start;
    const end = e.end;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) return void rejected.push({ index, reason: 'Its times are not numbers.' });
    if (end <= start) return void rejected.push({ index, reason: 'It ends before it starts.' });
    if (start < -0.5 || end > project.duration + 0.5 || start >= project.duration) return void rejected.push({ index, reason: 'It is outside the video.' });
    const snapped = snapShortRange(project, { start, end });
    if (!snapped.ok) return void rejected.push({ index, reason: snapped.reason });
    if ([...candidates, ...(opts.taken ?? [])].some((c) => overlap(c, snapped.range) > 0.5)) return void rejected.push({ index, reason: 'It repeats another short.' });
    if (candidates.length >= max) return void rejected.push({ index, reason: `Only ${max} are kept.` });
    const hook = hookLine(project, snapped.range);
    candidates.push({
      ...snapped.range,
      title: tidy(e.title, 80) || titleFromLine(hook),
      reason: tidy(e.reason, 180) || 'Proposed as a moment that works on its own.',
      hook,
      duration: snapped.duration,
      notes: snapped.notes,
    });
  });
  return { candidates, rejected };
}

const QUESTION = /\?\s*$|^(how|why|what|when|where|who|which|did you|do you|have you|ever|can you|should you|is it|are you)\b/i;
const NUMBER = /\d|\b(two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|percent|double|twice)\b/i;
const STRONG = /\b(here'?s|here (is|are)|the secret|stop|never|always|the biggest|most people|mistake|trick|tip|the truth|nobody|the reason|the problem|the best|the worst|the fastest|the easiest|don'?t|you need|you should|let me show)\b/i;
const MID_THOUGHT = /^(and|but|so|because|which|then|or|also|anyway)\b/i;

/**
 * Candidates picked by rules, on this Mac, from what is already known: where
 * the creator pressed the flag key, sentences that begin after a pause, lines
 * that open on a question or a number, and how densely the stretch is spoken.
 */
export function ruleShortCandidates(project: Pick<Project, 'transcript' | 'duration' | 'edit' | 'flags'>, opts: { max?: number; taken?: Range[] } = {}): ShortCandidate[] {
  const max = Math.max(1, Math.min(5, opts.max ?? 4));
  const map = longMap(project);
  const words = keptSpoken(project, map);
  const flags = flagsOf(project)
    .filter((f) => !f.parked && map.isKept(f.t))
    .map((f) => f.t);
  const taken = opts.taken ?? [];

  if (words.length < 12) {
    // No usable speech: the flagged moments, or simply the opening stretch.
    const starts = flags.length ? flags.map((t) => Math.max(0, t - 2)) : [0];
    const out: ShortCandidate[] = [];
    for (const s of starts) {
      const end = map.toSource(Math.min(map.outDuration, map.toOutput(s) + 40));
      const snapped = snapShortRange(project, { start: s, end });
      if (!snapped.ok || [...out, ...taken].some((c) => overlap(c, snapped.range) > 0.2)) continue;
      out.push({ ...snapped.range, title: flags.length ? 'Flagged moment' : 'Opening stretch', reason: flags.length ? 'You flagged this moment while recording. No speech was found, so the range is a plain 40 seconds.' : 'No speech was found, so this is simply the first 40 seconds.', hook: '', duration: snapped.duration, notes: snapped.notes });
      if (out.length >= max) break;
    }
    return out;
  }

  const byId = new Map(words.map((k) => [k.word.id, k]));
  const sents = sentences(words.map((k) => k.word));
  const text = (i: number) => sents[i]!.wordIds.map((id) => displayText(byId.get(id)!.word, project.edit)).join(' ');
  const outAt = (t: number) => map.toOutput(t);
  const scored: { cand: ShortCandidate; score: number }[] = [];
  for (let i = 0; i < sents.length; i++) {
    const startOut = outAt(sents[i]!.start);
    // Grow sentence by sentence; among the ends inside the target length, prefer one followed by a pause.
    let bestJ = -1;
    let bestEnd = -Infinity;
    for (let j = i; j < sents.length; j++) {
      const len = outAt(sents[j]!.end) - startOut;
      if (len > SHORT_LIMITS.targetMax) break;
      if (len < SHORT_LIMITS.targetMin) continue;
      const next = sents[j + 1];
      const pause = next ? outAt(next.start) - outAt(sents[j]!.end) : 2;
      const endScore = Math.min(1.5, pause) + (/[.!?]$/.test(text(j)) ? 0.5 : 0) - Math.abs(len - 42) / 60;
      if (endScore > bestEnd) {
        bestEnd = endScore;
        bestJ = j;
      }
    }
    if (bestJ < 0) continue;
    const snapped = snapShortRange(project, { start: sents[i]!.start, end: sents[bestJ]!.end });
    if (!snapped.ok) continue;
    const range = snapped.range;
    const hook = text(i);
    const prev = sents[i - 1];
    const pauseBefore = prev ? outAt(sents[i]!.start) - outAt(prev.end) : 2;
    const inside = flags.filter((t) => t >= range.start - 1 && t <= range.end);
    const spoken = words.filter((k) => k.word.start >= range.start - 0.05 && k.word.end <= range.end + 0.05).length;
    const density = spoken / Math.max(1, snapped.duration);
    const why: string[] = [];
    let score = 0;
    if (inside.length) {
      score += Math.min(6, inside.length * 3) + (inside.some((t) => t - range.start < 6) ? 1 : 0);
      why.push(inside.length === 1 ? 'You flagged a moment in it while recording' : `You flagged ${inside.length} moments in it while recording`);
    }
    if (QUESTION.test(hook)) {
      score += 3;
      why.push('It opens on a question');
    }
    if (NUMBER.test(hook)) {
      score += 2;
      why.push('The opening line has a number in it');
    }
    if (STRONG.test(hook)) {
      score += 2;
      why.push('The opening line makes a clear claim');
    }
    if (/\byou(r)?\b/i.test(hook)) score += 1;
    if (hook.split(' ').length <= 12) score += 1;
    if (pauseBefore >= 0.6) {
      score += 1;
      why.push('It starts cleanly after a pause');
    }
    if (MID_THOUGHT.test(hook)) score -= 2;
    score += Math.min(3, density);
    if (density >= 2.4) why.push('It is spoken with few pauses');
    score += Math.max(0, bestEnd);
    const lower = (x: string) => x[0]!.toLowerCase() + x.slice(1);
    const reason = why.length ? `${why[0]}${why[1] ? `, and ${lower(why[1])}` : ''}.` : 'A self-contained stretch of whole sentences.';
    scored.push({ cand: { ...range, title: titleFromLine(hook), reason, hook: hookLine(project, range), duration: snapped.duration, notes: snapped.notes }, score });
  }
  scored.sort((x, y) => y.score - x.score || x.cand.start - y.cand.start);
  const out: ShortCandidate[] = [];
  for (const s of scored) {
    if ([...out, ...taken].some((c) => overlap(c, s.cand) > 0.2)) continue;
    out.push(s.cand);
    if (out.length >= max) break;
  }
  if (out.length === 0) {
    // The video is shorter than the target length: offer it whole if it qualifies.
    const whole = snapShortRange(project, { start: words[0]!.word.start, end: words[words.length - 1]!.word.end });
    if (whole.ok && !taken.some((c) => overlap(c, whole.range) > 0.2)) {
      const hook = hookLine(project, whole.range);
      out.push({ ...whole.range, title: titleFromLine(hook), reason: 'The video is short enough to work as one short.', hook, duration: whole.duration, notes: whole.notes });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

// ───────────────────────────── saved shorts ─────────────────────────────

export function newShort(project: Pick<Project, 'sources' | 'duration' | 'edit'>, cand: Range & { title: string; reason?: string; hook?: string }, origin: Short['origin'], provider?: Short['provider']): Short {
  const framing = shortFramings(project, cand)[0]!;
  return {
    id: uid('short'),
    title: cand.title.trim() || 'Short',
    start: cand.start,
    end: cand.end,
    shape: 'vertical',
    framing,
    captions: defaultShortCaptions(framing),
    ...(cand.hook ? { hook: cand.hook } : {}),
    ...(cand.reason ? { reason: cand.reason } : {}),
    origin,
    ...(provider ? { provider } : {}),
    createdAt: new Date().toISOString(),
  };
}

export const addShorts = <P extends Pick<Project, 'shorts'>>(project: P, fresh: Short[]): P => (fresh.length ? { ...project, shorts: [...shortsOf(project), ...fresh].sort((a, b) => a.start - b.start) } : project);

export function updateShort<P extends Pick<Project, 'shorts'>>(project: P, id: string, patch: Partial<Omit<Short, 'id'>>): P {
  const list = shortsOf(project);
  if (!list.some((s) => s.id === id)) return project;
  return { ...project, shorts: list.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export const removeShort = <P extends Pick<Project, 'shorts'>>(project: P, id: string): P => (shortsOf(project).some((s) => s.id === id) ? { ...project, shorts: shortsOf(project).filter((s) => s.id !== id) } : project);

/** Carry the saved shorts through a change of clip order: `relay` maps one session range to where that footage now is. */
export function relayShorts(shorts: Short[] | undefined, relay: (r: Range) => Range): Short[] | undefined {
  if (!shorts?.length) return shorts;
  return shorts.map((s) => {
    const r = relay(s);
    return Math.abs(r.start - s.start) < EPS && Math.abs(r.end - s.end) < EPS ? s : { ...s, start: r.start, end: r.end };
  });
}

// ───────────────────────────── the project a short is rendered from ─────────────────────────────

/** The framing really used: the saved one when the footage allows it, otherwise the best that does. */
export function effectiveFraming(project: Pick<Project, 'sources' | 'duration' | 'edit'>, short: Pick<Short, 'start' | 'end' | 'framing'>): ShortFraming {
  const ok = shortFramings(project, short);
  return ok.includes(short.framing) ? short.framing : ok[0]!;
}

/** Music of the long video, moved onto the short's own clock and trimmed to it. */
function musicForShort(project: Pick<Project, 'sources' | 'duration' | 'edit'>, short: Range): MusicClip[] {
  const offset = longMap(project).toOutput(short.start);
  const length = shortDuration(project, short);
  const out: MusicClip[] = [];
  for (const c of musicClipsOf(project.edit, project.sources)) {
    const start = c.start - offset;
    const end = start + c.length;
    if (end <= 0.1 || start >= length - 0.1) continue;
    const head = Math.max(0, -start);
    const kept = Math.min(end, length) - Math.max(0, start);
    out.push({ ...c, start: Math.max(0, start), sourceIn: c.sourceIn + head, length: kept, fadeIn: head > 0 ? Math.min(c.fadeIn, 0.3) : c.fadeIn, fadeOut: end > length ? Math.max(c.fadeOut, Math.min(1, kept / 4)) : c.fadeOut });
  }
  return out;
}

/**
 * The project that plays one short. Pure and never saved: the same sources,
 * transcript and decisions, with everything outside the range cut away, the
 * short's frame and view, and word-by-word captions switched on. Text,
 * graphics, masks, B-roll and sound effects inside the range come along;
 * music is moved onto the short's clock.
 */
export function shortProject(project: Project, short: Short): Project {
  const meta: DecisionMeta = { origin: 'creator', revision: project.revision };
  const edit = project.edit;
  const ap = edit.appearance;
  const outside: Cut[] = [];
  if (short.start > EPS) outside.push({ id: 'short-head', start: 0, end: short.start, kind: 'trim', meta });
  if (short.end < project.duration - EPS) outside.push({ id: 'short-tail', start: short.end, end: project.duration, kind: 'trim', meta });
  const framing = effectiveFraming(project, short);
  const who = shortSources(project, short);
  const view = (mode: LayoutSegment['mode']): LayoutSegment[] => [{ id: 'short-view', start: short.start, end: short.end, mode, camera: who.camera ?? 'A', transition: 'cut', meta }];
  const layouts = framing === 'face' ? view('camera') : framing === 'stack' ? view('split') : framing === 'screen' ? view('screen') : edit.layouts;
  const reframed = framing !== 'original';
  const captions = short.captions.preset === 'off' ? { ...ap.captions, burnIn: false } : { ...ap.captions, burnIn: true, short: short.captions };
  let next: EditState = {
    ...edit,
    cuts: [...edit.cuts, ...outside],
    layouts,
    appearance: {
      ...ap,
      output: shortOutput(short.shape, ap.output.fps),
      ...(reframed ? { frame: { ...ap.frame, padding: framing === 'stack' ? Math.min(ap.frame.padding, 0.03) : 0 }, camera: { ...ap.camera, face: { zoom: false, follow: true } } } : {}),
      captions,
    },
    reframe: { framing, fillScreen: framing === 'face' || framing === 'screen' },
  };
  next = withMusic(next, musicForShort(project, short));
  return { ...project, name: `${project.name} short ${short.title}`, edit: next };
}

// ───────────────────────────── face follow ─────────────────────────────

/** Face height as a share of the frame, and how far down the frame the face sits (headroom). */
export const SHORT_FACE = { height: 0.3, eyeLine: 0.4, maxScale: 2.2, smooth: 0.35 } as const;

/**
 * Where to point the camera so the speaker sits in a frame of another shape.
 * `srcAspect`/`dstAspect` are width ÷ height of the camera picture and of the
 * box it fills. The magnification comes from the typical face size, so the
 * picture does not pump in and out; the position is the smoothed track,
 * averaged over a moment either side, so detector noise does not shake it.
 * The window never leaves the camera picture.
 */
export function shortFaceCrop(track: FaceTrackSmooth, t: Seconds, srcAspect: number, dstAspect: number): CameraCrop {
  const taps = [-SHORT_FACE.smooth, 0, SHORT_FACE.smooth].map((d) => faceAt(track, Math.max(0, t + d)));
  const cx = taps.reduce((n, f) => n + f.cx, 0) / taps.length;
  const cy = taps.reduce((n, f) => n + f.cy, 0) / taps.length;
  // The window that fills the box at magnification 1, as a share of the camera picture.
  const w0 = srcAspect > dstAspect ? dstAspect / srcAspect : 1;
  const h0 = srcAspect > dstAspect ? 1 : srcAspect / dstAspect;
  const scale = Math.min(SHORT_FACE.maxScale, Math.max(1, (SHORT_FACE.height * h0) / Math.max(0.04, track.median.size)));
  const w = w0 / scale;
  const h = h0 / scale;
  const clampTo = (v: number, half: number) => Math.min(1 - half, Math.max(half, v));
  return { cx: clampTo(cx, w / 2), cy: clampTo(cy + (0.5 - SHORT_FACE.eyeLine) * h, h / 2), scale };
}

// ───────────────────────────── captions ─────────────────────────────

export const SHORT_CAPTION_LINE = { minWords: 2, maxWords: 5, maxChars: 22, gapBreak: 0.45, hold: 0.35 } as const;

/** What a caption shows for a word: sentence punctuation is dropped, question and exclamation marks stay. */
export const captionWord = (text: string): string => text.replace(/[.,;:]+$/, '').replace(/^["“”]+|["“”]+$/g, '');

/**
 * Captions for a short: lines of two to five words in output time, each word
 * with its own span so the one being spoken can be lit. A line breaks at the
 * end of a sentence, at a pause, and before it gets too wide. Filler words
 * that were left in the edit are not captioned.
 */
export function buildShortCues(transcript: Transcript | null, edit: Pick<EditState, 'wordText'>, map: TimeMap, opts: { minWords: number; maxWords: number; maxChars: number; gapBreak: Seconds; hold: Seconds } = SHORT_CAPTION_LINE): Cue[] {
  type W = { id: string; text: string; raw: string; start: Seconds; end: Seconds };
  const words: W[] = keptWords(transcript, map)
    .filter((k) => k.word.kind !== 'filler')
    .map((k) => ({ id: k.word.id, raw: displayText(k.word, edit), text: captionWord(displayText(k.word, edit)), start: k.start, end: k.end }))
    .filter((w) => w.text.length > 0);
  const groups: W[][] = [];
  let cur: W[] = [];
  const chars = (g: W[]) => g.reduce((n, w) => n + w.text.length, 0) + Math.max(0, g.length - 1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const sentenceEnd = /[.!?]["”]?$/.test(prev.raw);
      const clauseEnd = /[,;:]$/.test(prev.raw) && cur.length >= 3;
      const pause = w.start - prev.end > opts.gapBreak;
      const full = cur.length >= opts.maxWords || (cur.length >= opts.minWords && chars(cur) + 1 + w.text.length > opts.maxChars);
      if (sentenceEnd || clauseEnd || pause || full) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  // A word left on its own joins the line before it when they belong together and there is room.
  const merged: W[][] = [];
  for (const g of groups) {
    const before = merged[merged.length - 1];
    const lastOfBefore = before?.[before.length - 1];
    const together = !!before && !!lastOfBefore && g[0]!.start - lastOfBefore.end <= opts.gapBreak && !/[.!?]["”]?$/.test(lastOfBefore.raw);
    if (g.length < opts.minWords && together && before!.length + g.length <= opts.maxWords && chars(before!) + 1 + chars(g) <= opts.maxChars + 8) before!.push(...g);
    else if (g.length < opts.minWords && together && before!.length > opts.minWords) {
      // No room on the line before: bring its last word down instead, so no word is left alone.
      const line = [...g];
      while (line.length < opts.minWords && before!.length > opts.minWords) line.unshift(before!.pop()!);
      merged.push(line);
    } else merged.push([...g]);
  }
  return merged.map((g, i) => {
    const next = merged[i + 1];
    const lastEnd = g[g.length - 1]!.end;
    const end = Math.max(g[0]!.start + 0.08, next ? Math.min(next[0]!.start, lastEnd + opts.hold) : lastEnd + opts.hold);
    return { index: i + 1, start: g[0]!.start, end, text: g.map((w) => w.text).join(' '), wordIds: g.map((w) => w.id), words: g.map((w) => ({ text: w.text, start: w.start, end: w.end })) };
  });
}

/** The word being spoken at an output time: the last one that has started. -1 before the first. */
export function activeWord(cue: Pick<Cue, 'words'>, out: Seconds): number {
  const words = cue.words ?? [];
  let k = -1;
  for (let i = 0; i < words.length; i++) if (out >= words[i]!.start - 1e-4) k = i;
  return k;
}

/** The burned-in captions of a project: word-by-word lines for a short, ordinary cues otherwise. */
export function burnInCues(project: Pick<Project, 'transcript' | 'edit'>, map: TimeMap, ordinary: (transcript: Transcript | null, edit: Pick<EditState, 'wordText'>, map: TimeMap) => Cue[]): Cue[] {
  const c = project.edit.appearance.captions;
  if (!c.burnIn) return [];
  return c.short && c.short.preset !== 'off' ? buildShortCues(project.transcript, project.edit, map) : ordinary(project.transcript, project.edit, map);
}

export interface ShortCaptionLook {
  id: ShortCaptionPreset;
  name: string;
  hint: string;
  font: TextFont;
  weight: number;
  uppercase: boolean;
  /** Letter height as a share of the frame's short side, at size 1. */
  size: number;
  letterSpacing: number;
  color: string;
  /** How the spoken word stands out: its own colour, a filled box behind it, or the rest dimmed. */
  active: 'color' | 'box' | 'dim';
  activeColor: string;
  /** Text colour on the box (active: 'box'). */
  onBox?: string;
  /** Opacity of the words not being spoken (active: 'dim'). */
  restOpacity?: number;
  outline: { color: string; width: number } | null;
  shadow: number;
  /** A translucent panel behind the whole line. */
  panel: { color: string; opacity: number } | null;
  /** The spoken word grows a little. */
  bump: number;
}

export const SHORT_CAPTION_LOOKS: ShortCaptionLook[] = [
  { id: 'pop', name: 'Pop', hint: 'Heavy capitals, the spoken word in yellow', font: 'anton', weight: 400, uppercase: true, size: 0.082, letterSpacing: 0.01, color: '#ffffff', active: 'color', activeColor: '#ffe14d', outline: { color: '#0b0b0f', width: 0.14 }, shadow: 0.5, panel: null, bump: 0.06 },
  { id: 'clean', name: 'Clean', hint: 'Plain white, the words light up as they are said', font: 'inter', weight: 800, uppercase: false, size: 0.064, letterSpacing: -0.015, color: '#ffffff', active: 'dim', activeColor: '#ffffff', restOpacity: 0.5, outline: null, shadow: 0.9, panel: null, bump: 0 },
  { id: 'boxed', name: 'Boxed', hint: 'The spoken word sits on a coloured block', font: 'grotesk', weight: 800, uppercase: false, size: 0.066, letterSpacing: -0.01, color: '#ffffff', active: 'box', activeColor: '#5b5bf0', onBox: '#ffffff', outline: null, shadow: 0.8, panel: null, bump: 0 },
  { id: 'editorial', name: 'Editorial', hint: 'Serif on a soft dark panel, the spoken word in gold', font: 'serif', weight: 400, uppercase: false, size: 0.074, letterSpacing: -0.005, color: '#f6f1e6', active: 'color', activeColor: '#f2c66d', outline: null, shadow: 0, panel: { color: '#0d0d12', opacity: 0.72 }, bump: 0 },
];

export const shortCaptionLook = (id: ShortCaptionPreset | 'off'): ShortCaptionLook => SHORT_CAPTION_LOOKS.find((l) => l.id === id) ?? SHORT_CAPTION_LOOKS[0]!;

/**
 * Where captions may sit. The short-video apps draw their own text and buttons
 * over the bottom fifth and the right edge, and a title bar at the top; lines
 * are centred, at most `width` of the frame wide, and their centre is at one
 * of three heights that all stay inside the clear area.
 */
export const SHORT_SAFE = { top: 0.1, bottom: 0.22, width: 0.8, y: { high: 0.2, middle: 0.52, low: 0.68 } } as const;
