/**
 * Animation ideas from what the creator says. Plain rules over the transcript, so they are instant, free, work
 * without an AI, and always map to a built-in template that is known to render well: "subscribe" gets the
 * Subscribe button, "my name is …" a name tag, "10,000 users" a counter, "step two" or "next up …" a title card,
 * "click here" an arrow. Each idea lands at the moment the words are said; the creator accepts or dismisses it.
 */
import type { Project, Suggestion, Word } from './types';
import { uid } from './ranges';

export interface MotionIdea {
  /** Built-in template id. */
  template: 'subscribe' | 'nametag' | 'counter' | 'titlecard' | 'arrow' | 'checklist';
  fields: Record<string, string>;
  /** Session time the animation starts. */
  t: number;
  title: string;
  reason: string;
}

/** How long each idea's template runs, for the suggestion's range (the real length comes from the page). */
const LENGTH: Record<MotionIdea['template'], number> = { subscribe: 4.2, nametag: 4.5, counter: 3.6, titlecard: 3.5, arrow: 3, checklist: 5 };
const MAX_IDEAS = 8;

const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9%$,.'-]/g, '').replace(/[.,]+$/, '');
const cap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const NUMBER_WORDS: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
const STEP_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', first: '1', second: '2', third: '3', fourth: '4', fifth: '5' };
const NOUNS = /^(views?|users?|subscribers?|customers?|downloads?|people|followers?|members?|sales|signups?|creators?|students?|companies|teams?|dollars|hours|minutes|lines|files|stars|videos|messages|emails|orders)$/;
const STOP = new Set(['and', 'so', 'but', 'the', 'a', 'an', 'i', 'im', "i'm", 'we', 'today', 'here', 'this', 'that', 'um', 'uh', 'like', 'just', 'going', 'gonna', 'to', 'is', 'and,']);

/** The spoken words, in order, skipping fillers and anything cut from the video. */
function spoken(p: Project): Word[] {
  const words = p.transcript?.hasSpeech ? p.transcript.words : [];
  const cut = (t: number) => p.edit.cuts.some((c) => t >= c.start && t < c.end);
  return words.filter((w) => w.kind === 'word' && !cut((w.start + w.end) / 2));
}

/** Parse "10,000", "10k", "2.5 million", "$500", "40%" at words[i]; returns the value, its text and how many words it used. */
function numberAt(ws: string[], i: number): { value: number; prefix: string; suffix: string; used: number } | null {
  const raw = ws[i]!;
  const m = raw.match(/^(\$?)([0-9][0-9,]*(?:\.[0-9]+)?)(k|m|%)?$/);
  if (!m) return null;
  let value = Number(m[2]!.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  let used = 1;
  let suffix = m[3] === '%' ? '%' : '';
  if (m[3] === 'k') value *= 1000;
  if (m[3] === 'm') value *= 1e6;
  const scale = NUMBER_WORDS[ws[i + 1] ?? ''];
  if (scale) (value *= scale), used++;
  if (ws[i + used] === 'percent') (suffix = '%'), used++;
  return { value, prefix: m[1] ? '$' : '', suffix, used };
}

/** A few words after position i that make a short title (stops at the end of a phrase). */
function phraseAfter(words: Word[], i: number, max = 5): string {
  const out: string[] = [];
  for (let j = i; j < words.length && out.length < max; j++) {
    const w = words[j]!;
    if (j > i && w.start - words[j - 1]!.end > 0.6) break;
    const t = w.text.replace(/[^\p{L}\p{N}'’-]/gu, '');
    if (t) out.push(t);
    if (/[.!?,;:]$/.test(w.text)) break;
  }
  while (out.length && STOP.has(out[out.length - 1]!.toLowerCase())) out.pop();
  return cap(out.join(' '));
}

/** Ideas for the whole recording, earliest first, at most one per template kind within a few seconds. */
export function motionIdeas(p: Project): MotionIdea[] {
  const words = spoken(p);
  const ws = words.map((w) => clean(w.text));
  const ideas: MotionIdea[] = [];
  const at = (i: number, lead = 0.2) => Math.max(0, words[i]!.start - lead);
  let subscribed = false;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    const next = ws.slice(i + 1, i + 4).join(' ');
    // "subscribe" (once: the first time is the one that matters)
    if (!subscribed && /^subscrib(e|ed|ing)$/.test(w)) {
      subscribed = true;
      ideas.push({ template: 'subscribe', fields: {}, t: at(i, 1.1), title: 'Subscribe button', reason: `You say “subscribe” at this point; a Subscribe button that gets clicked lands right as you say it.` });
      continue;
    }
    // "my name is Alex Rivera" / "I'm Alex" in the first minute
    if (words[i]!.start < 60 && ((w === 'name' && ws[i - 1] === 'my' && ws[i + 1] === 'is') || ((w === "i'm" || w === 'im') && /^[A-Z]/.test(words[i + 1]?.text ?? '') && words[i + 1]!.text !== 'I'))) {
      const from = w === 'name' ? i + 2 : i + 1;
      const taken: string[] = [];
      for (const x of words.slice(from, from + 3).map((x) => x.text.replace(/[^\p{L}'’-]/gu, ''))) {
        if (!/^\p{Lu}/u.test(x)) break;
        taken.push(x);
      }
      if (taken.length) {
        ideas.push({ template: 'nametag', fields: { name: taken.join(' '), role: '' }, t: at(i, 0.3), title: `Name tag: ${taken.join(' ')}`, reason: 'You introduce yourself here. A name tag tells new viewers who is talking.' });
        continue;
      }
    }
    // "10,000 users", "2 million views", "40% faster"
    const n = numberAt(ws, i);
    if (n && n.value >= 100) {
      const noun = ws[i + n.used] ?? '';
      if (NOUNS.test(noun) || n.suffix === '%' || n.prefix) {
        ideas.push({
          template: 'counter',
          fields: { target: String(Math.round(n.value)), prefix: n.prefix, suffix: n.suffix || (n.value >= 1000 ? '+' : ''), label: NOUNS.test(noun) ? noun : '' },
          t: at(i, 0.4),
          title: `Count up to ${n.prefix}${Math.round(n.value).toLocaleString('en-US')}${n.suffix}${NOUNS.test(noun) ? ` ${noun}` : ''}`,
          reason: 'A number you say out loud lands harder when it counts up on screen.',
        });
        i += n.used;
        continue;
      }
    }
    // "step two", "part three", "chapter 2" → title card with what follows
    if (/^(step|part|chapter)$/.test(w) && (STEP_WORDS[ws[i + 1] ?? ''] !== undefined || /^[0-9]+$/.test(ws[i + 1] ?? ''))) {
      const num = STEP_WORDS[ws[i + 1]!] ?? ws[i + 1]!;
      const title = phraseAfter(words, i + 2) || `${cap(w)} ${num}`;
      ideas.push({ template: 'titlecard', fields: { kicker: `${cap(w)} ${num}`, title }, t: at(i, 0.5), title: `Title card: ${cap(w)} ${num}`, reason: 'You start a new step here. A title card marks the change of section.' });
      i += 1;
      continue;
    }
    // "next up, …" / "let's talk about …" / "moving on to …"
    const lead = `${w} ${next}`;
    const intro = lead.match(/^(next up|let's talk about|lets talk about|moving on to|now let's look at|now lets look at)\b/);
    if (intro) {
      const skip = intro[1]!.split(' ').length;
      const title = phraseAfter(words, i + skip);
      if (title) {
        ideas.push({ template: 'titlecard', fields: { kicker: 'Next up', title }, t: at(i, 0.5), title: `Title card: ${title}`, reason: 'You move on to a new topic here. A title card makes the change of section clear.' });
        i += skip;
        continue;
      }
    }
    // "click here", "click on the … button"
    if (w === 'click' && /^(here|this|that|on)\b/.test(next)) {
      ideas.push({ template: 'arrow', fields: { note: 'Click here' }, t: at(i, 0.3), title: 'Arrow pointing at what to click', reason: 'You tell viewers to click something. An arrow shows them exactly where; drag its box over the button.' });
      continue;
    }
  }
  // one per template within 8 s, skipping places that already have an animation
  const existing = p.edit.overlays.filter((o) => o.kind === 'motion');
  const kept: MotionIdea[] = [];
  for (const idea of ideas.sort((a, b) => a.t - b.t)) {
    if (kept.some((k) => k.template === idea.template && Math.abs(k.t - idea.t) < 8)) continue;
    if (existing.some((o) => Math.abs(o.start - idea.t) < 3)) continue;
    kept.push(idea);
    if (kept.length >= MAX_IDEAS) break;
  }
  return kept;
}

/** The ideas as Review suggestions ("Your call"), dropping ones already suggested, accepted or dismissed. */
export function motionSuggestions(p: Project): Suggestion[] {
  const had = p.edit.suggestions.filter((s) => s.kind === 'animation');
  return motionIdeas(p)
    .filter((i) => !had.some((s) => s.motion?.template === i.template && Math.abs(s.start - i.t) < 2))
    .map((i) => ({
      id: uid('sug'),
      kind: 'animation' as const,
      start: i.t,
      end: Math.min(p.duration, i.t + LENGTH[i.template]),
      title: i.title,
      reason: i.reason,
      confidence: 'medium' as const,
      status: 'open' as const,
      apply: [],
      revision: p.revision,
      motion: { template: i.template, fields: i.fields },
    }));
}
