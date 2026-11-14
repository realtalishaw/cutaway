/**
 * Animations in the Ask AI conversation: the templates offered to the model, its proposals turned into cards,
 * the built-in rules' own card when no AI is available, and what Apply does with a card.
 */
import { parseMotionMeta, uid, type ChatProposalItem, type Project, type Range } from '@cutaway/core';
import type { ChatAnimation, ChatAnimationTemplate } from '@cutaway/ai/chat';
import { useApp } from '../state/store';
import { addMotion } from './actions';
import { MOTION_TEMPLATES, ownTemplates, type MotionTemplate } from './templates';

const toastBoxed = (name: string) => useApp.getState().toast(`${name} added. Drag its box on the preview over what it should point at.`);

export async function allTemplates(): Promise<MotionTemplate[]> {
  return [...MOTION_TEMPLATES, ...(await ownTemplates())];
}

/** What the model is told about each template. */
export function templatesForChat(list: MotionTemplate[]): ChatAnimationTemplate[] {
  return list.map((t) => {
    const meta = parseMotionMeta(t.html).meta;
    // the key moment: its click, or the first sound well after the start
    const beat = meta?.sounds.find((s) => s.sound === 'click')?.t ?? meta?.sounds.find((s) => s.t >= 0.5)?.t ?? null;
    return { id: t.id, name: t.name, description: t.description, boxed: t.boxed, beat, fields: (meta?.fields ?? []).map((f) => ({ id: f.id, label: f.label })) };
  });
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function card(m: NonNullable<ChatProposalItem['motion']>, list: MotionTemplate[], why: string, duration: number): ChatProposalItem {
  const t = m.template ? list.find((x) => x.id === m.template) : undefined;
  const words = Object.values(m.fields).filter(Boolean).slice(0, 2).map((v) => `“${v}”`).join(', ');
  const where = m.at === null ? 'at the playhead' : `at ${fmt(m.at)}`;
  const what = t ? `Add the ${t.name} animation ${where}${words ? ` with ${words}` : ''}` : `Write a new animation ${where}: ${m.request}`;
  const start = m.at ?? 0;
  return { id: uid('ci'), kind: 'motion', motion: m, range: { start, end: Math.min(duration, start + 3) }, what, why: why || (t ? 'A ready-made animation, added in a moment.' : 'No template does this, so your AI writes it; you see it before it goes in.'), status: 'open' };
}

/** The model's proposals as cards. An unknown template becomes a request to write one. */
export function motionCards(animations: ChatAnimation[], list: MotionTemplate[], scope: Range | null, duration: number): ChatProposalItem[] {
  return animations.map((a) => {
    const known = a.template && list.some((t) => t.id === a.template) ? a.template : null;
    const at = a.at ?? scope?.start ?? null;
    return card({ template: known, fields: known ? a.fields : {}, request: a.request || (a.template ?? 'an animation'), at }, list, a.reason, duration);
  });
}

const INTENT = /\b(animat\w*|motion graphics?|subscribe button|lower third|name ?tag|counter|count(?:s|ing)? up|title card|confetti|arrow|circle (?:it|this|that|around)|highlight(?:er)?)\b/i;
const PICK: [RegExp, string][] = [
  [/subscribe/i, 'subscribe'],
  [/lower third|name ?tag|my name/i, 'nametag'],
  [/counter|count(?:s|ing)? up/i, 'counter'],
  [/title card|chapter/i, 'titlecard'],
  [/check ?list|steps/i, 'checklist'],
  [/arrow|point/i, 'arrow'],
  [/circle/i, 'circle'],
  [/highlight/i, 'highlighter'],
];

/** "when I say subscribe" → the session time just before that word, if it is in the transcript. */
function whenSaid(p: Project, text: string): number | null {
  const m = text.match(/when (?:i|you) (?:say|mention|talk about) ["“']?([\w'’-]+(?: [\w'’-]+)?)/i);
  if (!m || !p.transcript?.hasSpeech) return null;
  const want = m[1]!.toLowerCase().split(' ')[0]!.replace(/[^\w]/g, '');
  const w = p.transcript.words.find((x) => x.kind === 'word' && x.text.toLowerCase().replace(/[^\w]/g, '').startsWith(want) && !p.edit.cuts.some((c) => x.start >= c.start && x.start < c.end));
  return w ? Math.max(0, w.start - 1) : null;
}

/** Without an AI: a card for a request that is clearly about an animation, or null. */
export function localMotionCard(p: Project, text: string, scope: Range | null, list: MotionTemplate[]): ChatProposalItem | null {
  if (!INTENT.test(text)) return null;
  const template = PICK.find(([re]) => re.test(text))?.[1] ?? null;
  const t = template ? list.find((x) => x.id === template) : undefined;
  const fields: Record<string, string> = {};
  const quoted = text.match(/["“]([^"”]{1,60})["”]/)?.[1];
  const first = t ? parseMotionMeta(t.html).meta?.fields.find((f) => f.type === 'text') : undefined;
  if (quoted && first) fields[first.id] = quoted;
  const at = whenSaid(p, text) ?? scope?.start ?? null;
  return card({ template: t ? t.id : null, fields, request: text, at }, list, t ? 'Matched to a ready-made animation by Cutaway’s built-in rules.' : 'No template matches, so this needs your AI to write it.', p.duration);
}

/**
 * Apply one animation card. A template goes in now; one to be written opens the animation sheet with the
 * request, where it is written, checked and previewed before it goes in. Returns what happened.
 */
export async function applyMotionCard(item: ChatProposalItem): Promise<'added' | 'opened'> {
  const m = item.motion!;
  const t = m.template ? (await allTemplates()).find((x) => x.id === m.template) : undefined;
  if (t) {
    // the conversation stays on screen; a boxed one says how to place it
    await addMotion(t.html, { kind: 'template', template: t.id }, m.fields, m.at, undefined, false);
    if (t.boxed) toastBoxed(t.name);
    return 'added';
  }
  window.dispatchEvent(new CustomEvent('cutaway-motion', { detail: { request: m.request, at: m.at } }));
  return 'opened';
}

/** Accept an animation idea from Review: the animation goes in and the idea is marked accepted, as one undo step. */
export async function acceptMotionSuggestion(id: string, project: Project): Promise<void> {
  const s = project.edit.suggestions.find((x) => x.id === id);
  if (!s?.motion || s.status !== 'open') return;
  const t = (await allTemplates()).find((x) => x.id === s.motion!.template);
  if (!t) throw new Error('That template is no longer available.');
  await addMotion(t.html, { kind: 'template', template: t.id }, s.motion.fields, s.start, {
    label: `Add ${t.name} (suggested)`,
    edit: (e) => ({ ...e, suggestions: e.suggestions.map((x) => (x.id === id ? { ...x, status: 'accepted' as const } : x)) }),
  }, false);
  if (t.boxed) toastBoxed(t.name);
}
