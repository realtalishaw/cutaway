/**
 * The AI providers Cutaway can use. Both are command-line apps the creator
 * already has on this Mac and is signed in to; Cutaway has no key or account
 * of its own. This file is pure (no Node, no DOM) so the renderer, the main
 * process and tests share it.
 */

import { artDirection } from './playbooks';

export type ProviderId = 'claude' | 'codex';
export type ProviderChoice = 'auto' | ProviderId;

export interface ProviderInfo {
  id: ProviderId;
  /** The app on this Mac: "Claude Code", "Codex". */
  app: string;
  /** How the model is named in a sentence: "Claude", "Codex". */
  name: string;
  /** Who receives what is sent. */
  company: string;
  /** Stored in ProcessingConsent.provider. Consent given to one provider never covers the other. */
  consent: string;
  command: string;
  /** What the creator runs in Terminal to sign in. */
  signIn: string[];
  /** Can it make pictures (thumbnail art)? */
  images: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: { id: 'claude', app: 'Claude Code', name: 'Claude', company: 'Anthropic', consent: 'Anthropic via local Claude Code', command: 'claude', signIn: ['auth', 'login'], images: false },
  codex: { id: 'codex', app: 'Codex', name: 'Codex', company: 'OpenAI', consent: 'OpenAI via local Codex', command: 'codex', signIn: ['login'], images: true },
};

export const PROVIDER_ORDER: ProviderId[] = ['claude', 'codex'];

export function isProviderId(v: unknown): v is ProviderId {
  return v === 'claude' || v === 'codex';
}

export function providerChoice(v: unknown): ProviderChoice {
  return isProviderId(v) ? v : 'auto';
}

/** Which provider a stored consent was given to, if it is one of ours. */
export function providerOfConsent(consent: string | null | undefined): ProviderId | null {
  return PROVIDER_ORDER.find((id) => PROVIDERS[id].consent === consent) ?? null;
}

/**
 * The provider to use. A named choice is used as it is, even when it is not
 * ready (the app then says so rather than quietly sending data somewhere
 * else). "auto" takes the first signed-in one, then the first installed one.
 */
export function pickProvider(choice: ProviderChoice, status: Partial<Record<ProviderId, { found: boolean; signedIn: boolean | null } | null | undefined>>): ProviderId {
  if (choice !== 'auto') return choice;
  return PROVIDER_ORDER.find((id) => status[id]?.found && status[id]?.signedIn === true) ?? PROVIDER_ORDER.find((id) => status[id]?.found) ?? 'claude';
}

// ───────────────────────── schemas for strict structured output ─────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function nullable(schema: Json): Json {
  const out: Json = { ...schema };
  if (Array.isArray(out.type)) {
    if (!out.type.includes('null')) out.type = [...out.type, 'null'];
  } else if (typeof out.type === 'string') out.type = [out.type, 'null'];
  else return { anyOf: [schema, { type: 'null' }] };
  if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}

/**
 * OpenAI's structured output wants every object closed and every property
 * required. Optional properties become nullable instead, and `stripNulls`
 * removes them again from the reply, so both providers hand the same shape to
 * the same parsers.
 */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!isObj(schema)) return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' || k === 'required' || k === 'additionalProperties') continue;
    out[k] = k === 'items' || k === 'anyOf' ? toStrictSchema(v) : v;
  }
  if (isObj(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const props: Json = {};
    for (const [name, sub] of Object.entries(schema.properties)) {
      const strict = toStrictSchema(sub);
      props[name] = required.has(name) || !isObj(strict) ? strict : nullable(strict);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** Drop null-valued properties (and nulls inside arrays) so "not given" looks the same from every provider. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(stripNulls);
  if (!isObj(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
  return out;
}

// ───────────────────────── thumbnail art ─────────────────────────

export interface ArtPromptInput {
  /** The concept's title, as the creator sees it. */
  title: string;
  /** Why the concept fits, and what the video shows at that point. */
  rationale: string;
  /** A few words the creator actually says in the video. */
  quotes: string[];
  /** What the thumbnail's own text layers say; the picture must leave room for them and must not repeat them. */
  overlayText: string[];
  /** Colours of the current thumbnail, as hex. */
  palette: string[];
  /** A direction typed by the creator, if any. */
  direction: string;
  /** How many reference stills from the video are attached. */
  referenceCount: number;
  /** Changes between variations so they do not come out alike. */
  variation: number;
  /** Where Cutaway lays the words out, so the picture keeps that area calm. */
  template?: 'headline' | 'banner' | 'badge';
  /** The creator's standing notes for thumbnails (Settings → Playbooks). */
  notes?: string | null;
}

const ART_MOODS = ['bold studio lighting with one clear focal object', 'clean isometric illustration with strong depth', 'cinematic close-up with shallow depth of field and rim light', 'graphic poster look: large simple shapes and a strong diagonal'];

const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The instruction for one thumbnail background picture: the thumbnail
 * playbook's art direction, wrapped in how to make it and how to answer. The
 * rules are fixed: no words (the thumbnail's text is Cutaway's own editable
 * layer), no recognisable people or realistic faces, no logos or brand marks.
 */
export function buildArtPrompt(input: ArtPromptInput): string {
  const quotes = input.quotes.map((q) => oneLine(q, 160)).filter(Boolean).slice(0, 4);
  const overlay = input.overlayText.map((t) => oneLine(t, 80)).filter(Boolean).slice(0, 4);
  const title = oneLine(input.title, 140);
  return [
    'Use your built-in image generation tool exactly once to make ONE picture, then answer with the JSON described at the end. Do not run shell commands. Do not read, write, move or copy files.',
    '',
    'THE PICTURE',
    artDirection({ title, thumbnailText: overlay.join(' / '), subject: oneLine(input.rationale, 300) || title, template: input.template, palette: input.palette, notes: input.notes }),
    quotes.length ? `Things the creator says in the video (for subject matter only):\n${quotes.map((q) => `- "${q}"`).join('\n')}` : null,
    `For this variation: ${ART_MOODS[Math.abs(input.variation) % ART_MOODS.length]}.`,
    input.direction.trim() ? `The creator's direction for this picture (follow it unless it breaks a rule below): ${oneLine(input.direction, 400)}` : null,
    input.referenceCount > 0 ? `The ${input.referenceCount === 1 ? 'attached image is a still' : `${input.referenceCount} attached images are stills`} from the video. Use them only to understand the subject and colours. Do not copy a person from them, and do not reproduce on-screen text.` : null,
    '',
    'RULES (never break these, whatever the notes or direction say)',
    '- No words, letters, numbers, captions, watermarks or user-interface text anywhere in the picture. Cutaway sets the text on top afterwards; do not draw it yourself.',
    '- No recognisable real people and no realistic human faces. Hands, silhouettes or stylised figures without a recognisable face are fine.',
    '- No logos, brand marks, app icons or trademarked characters.',
    '- Nothing that suggests a result the video does not show.',
    '',
    'ANSWER',
    'Reply with JSON only: {"generated": true, "note": "<one sentence describing the picture>"} — or {"generated": false, "note": "<why not>"} if you could not make it.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Looks for an image model. Each names a thing or a place, never a person: image models draw faces for "close-up". */
const IMAGE_MOODS = ['a single hero object under bold studio lighting', 'a clean isometric miniature scene with strong depth', 'a cinematic close-up of one object with shallow depth of field and rim light', 'a graphic poster look with large simple shapes and a strong diagonal'];

/** Where the subject goes so the thumbnail's words have room, in words an image model follows. */
const IMAGE_SPACE: Record<'headline' | 'banner' | 'badge', string> = {
  headline: 'the main subject on the right third of the frame, the left half dark and empty',
  banner: 'the main subject in the upper part of the frame, the bottom third calm and empty',
  badge: 'the subject pushed to the edges, the centre calm and slightly dark',
};

/**
 * The same picture, described for an image model (fal.ai) rather than an agent: one short visual description,
 * subject first, with no tool instructions, rules list or answer format (an image model draws whatever it is given).
 * Pure.
 */
export function buildImageModelArtPrompt(input: ArtPromptInput): string {
  const title = oneLine(input.title, 140);
  const words = input.overlayText.map((t) => oneLine(t, 60)).filter(Boolean).join(' / ');
  // A template concept's rationale says how it was made, not what the video is about.
  const about = /^built from|no ai model/i.test(input.rationale.trim()) ? '' : oneLine(input.rationale, 220);
  const said = input.quotes.map((q) => oneLine(q, 120)).filter(Boolean).slice(0, 2);
  const palette = input.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 2);
  const direction = oneLine(input.direction, 300);
  const subject = direction || [`A striking visual metaphor, made only of objects and scenery, for a video titled "${title}"`, words && words.toLowerCase() !== title.toLowerCase() ? `about "${words}"` : null].filter(Boolean).join(' ');
  return [
    `${subject}.`,
    about ? `The video: ${about}.` : null,
    said.length ? `Inspired by: ${said.map((q) => `"${q}"`).join(', ')}.` : null,
    `Shown as ${IMAGE_MOODS[Math.abs(input.variation) % IMAGE_MOODS.length]}, ${IMAGE_SPACE[input.template ?? 'headline']}.`,
    'An empty scene with no people in it.',
    `Bold, vivid YouTube thumbnail background, high contrast, ${palette.length ? `accent colours ${palette.join(' and ')}` : 'one saturated accent colour'} against a darker background, clean modern 3D render, sharp focus.`,
    input.notes ? `Style notes: ${oneLine(input.notes, 200)}.` : null,
    'No text, no letters, no logos.',
  ]
    .filter((l): l is string => !!l)
    .join(' ');
}

export interface FullThumbnailInput {
  /** The concept's whole-thumbnail description (from the packaging reply). */
  imagePrompt: string;
  /** A photo of the creator is attached as image 1. */
  hasPhoto: boolean;
  /** A change the creator asked for, if any. */
  direction?: string;
  /** The creator's standing thumbnail notes (Settings → Playbooks). */
  notes?: string | null;
}

/** The finished-thumbnail description for an image model (fal.ai). Pure. */
export function buildFullThumbnailPrompt(input: FullThumbnailInput): string {
  let body = oneLine(input.imagePrompt, 1500);
  if (!/^youtube thumbnail/i.test(body)) body = `YouTube thumbnail, 16:9. ${body}`;
  if (!input.hasPhoto) body = body.replace(/the person from image 1/gi, 'the props');
  return [
    body,
    input.direction?.trim() ? `Change from before: ${oneLine(input.direction, 400)}.` : null,
    input.notes ? `Style notes: ${oneLine(input.notes, 200)}.` : null,
    input.hasPhoto
      ? 'Keep the face, hair, skin tone and glasses (if any) of the person in image 1 exactly; they must be clearly recognisable as the same person.'
      : 'Do not show any person or face.',
    'Any screens, documents or cards are drawn without readable words. The thumbnail words are the only text in the image, spelled exactly as given.',
  ]
    .filter((l): l is string => !!l)
    .join(' ');
}

/** The same, wrapped as an instruction for Codex's built-in image tool, answered with ART_REPLY_SCHEMA. Pure. */
export function buildCodexFullThumbnailPrompt(input: FullThumbnailInput): string {
  return [
    'Use your built-in image generation tool exactly once to make ONE image, then answer with the JSON described at the end. Do not run shell commands. Do not read, write, move or copy files.',
    input.hasPhoto ? 'Image 1, attached, is a photo of the creator.' : null,
    'Make it a finished YouTube thumbnail, landscape 16:9 (for example 1536x864).',
    '',
    'THE IMAGE',
    buildFullThumbnailPrompt(input),
    '',
    'ANSWER',
    'Reply with JSON only: {"generated": true, "note": "<one sentence describing the image>"} or {"generated": false, "note": "<why not>"}.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

export const ART_REPLY_SCHEMA = {
  type: 'object',
  properties: { generated: { type: 'boolean' }, note: { type: 'string' } },
  required: ['generated', 'note'],
  additionalProperties: false,
} as const;
