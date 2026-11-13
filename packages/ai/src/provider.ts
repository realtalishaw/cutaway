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

export const ART_REPLY_SCHEMA = {
  type: 'object',
  properties: { generated: { type: 'boolean' }, note: { type: 'string' } },
  required: ['generated', 'note'],
  additionalProperties: false,
} as const;
