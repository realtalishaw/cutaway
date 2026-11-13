/**
 * Craft playbooks: Cutaway's own guidance for editing, titles and thumbnails,
 * written as instructions to a model. They sit beside the non-negotiable
 * rules in the prompts and never override them.
 *
 * The guidance was written for Cutaway after reading the sources listed in
 * PLAYBOOK_SOURCES; none of their text is reproduced. Where a source and the
 * product rules disagree (for example "something must change every N
 * seconds" against "do not switch on a timer"), the product rules win and the
 * playbook says how to reconcile them.
 *
 * This file is pure: no Node, no DOM. The renderer imports it for the
 * built-in (no-AI) concepts and for the warnings in the Package tab.
 */

export interface PlaybookNotes {
  editing?: string | null;
  titles?: string | null;
  thumbnails?: string | null;
}

export type PlaybookId = keyof PlaybookNotes;

/** Longest note a creator can add to one playbook. */
export const NOTE_MAX = 600;

// ───────────────────────────── the playbooks ─────────────────────────────

export const EDITING_PLAYBOOK = `EDITING CRAFT (how a good editor uses the operations; the editorial rules always win)
Opening
- The first 15 seconds decide whether people stay. If the take opens with a greeting, housekeeping or a slow wind-up before the first useful sentence, trim it (a "cut" of kind "trim") when nothing protected is lost. If a stronger moment exists later, offer it as a "suggest" of kind "hook"; never move it yourself.
- The opening should say or show what the video is about. Give it one deliberate visual move (a zoom to what matters, or a lower-third), not several.
Pacing
- Remove dead air, false starts and repeated wind-ups; keep the breath that makes speech sound human. Leave roughly 0.15 s of air on each side of a cut and never land inside a word.
- A pause after a key point or just before a result is part of the delivery: keep up to about one second of it.
- Match the energy of the content. Quick listing or clicking can take tight cuts; a careful explanation or a warning needs room.
- Look for stretches where the picture does not change for more than about 30 seconds. Break one only with a motivated change: a zoom to the thing being discussed, the camera for an explanation, a graphic for a term or a number. If nothing motivates a change, leave the shot alone.
Screen tutorials and demos
- The viewer must be able to follow along: keep each step's click, its visible result and the order. Speed up typing and loading (2–4×) instead of cutting them when the result matters.
- Zoom when the target is small in the frame (a menu item, a field, a setting). Start just before the action, hold until its result is visible, then return to the overview. Two or three purposeful zooms a minute is a ceiling, not a target.
- Show the camera when the creator explains why, reacts to a result, or the screen is idle. Be back on the screen before the next action starts, never in the middle of one.
Talking to camera
- Without a screen, variety comes from cuts between sentences, the second camera and sparse graphics. Do not cut inside a thought to hide a breath.
Graphics
- A graphic earns its place when it names a term, a number, a step or a warning the viewer should remember, in the creator's exact words. Bring it in as the phrase is spoken and keep it about a second longer. One at a time, never over the thing being demonstrated.
- A section-card belongs only at a real change of topic.
Ending
- End on the last useful sentence or the final result. Trim trailing silence and repeated goodbyes.
Do: zoom to the Format menu while MP4 is chosen and pull back when the preview updates; camera while they explain why the setting matters.
Don't: a zoom every ten seconds; a camera switch in the middle of a click; a callout that paraphrases instead of quoting; cutting the two-second wait that shows the export finishing.`;

export const TITLES_PLAYBOOK = `TITLE CRAFT (the packaging rules always win)
- A title is a promise the video keeps. Say what the viewer gets or learns, in the creator's own vocabulary, true to what is said and shown.
- Aim for 40–70 characters. Phones show roughly the first 50, so the subject and the hook come first; qualifiers go last or are left out.
- Be specific: name the tool, the task, the result or the mistake. "Export settings that stop blurry uploads" beats "Export tips".
- Decide who it is for. Search-style (someone already looking for this): lead with the task in plain words. Browse-style (someone who was not looking): open a real question the video answers: a mistake, a surprise, a before and after, a choice between two things.
- Curiosity must be paid off inside the video. Hint at the answer; never hide what the video is about, and never promise an outcome it does not show.
- A number is welcome only when it is spoken in the video (steps, minutes, settings).
- Sentence case or title case. At most one word in capitals. No emoji, hashtags, channel name, "Part 1", dates or strings of keywords.
- The three titles take three different angles: (1) the outcome, (2) the method or the question, in searchable words, (3) the warning, mistake or surprising moment.
Patterns (fill them only with things that are in the video)
- How to <do the task> (<the detail that makes it easier>)
- <The mistake>, and how to avoid it
- <A> vs <B>: <the question the video settles>
- The <setting or step> that <visible result>
- <Task>, start to finish
- Why <the surprising thing the video shows>
Do: "Don't Delete This File Before Your Export Finishes".
Don't: "You WON'T BELIEVE This Export Trick!!!"; "Export Settings Tutorial Video Part 1"; "My Thoughts"; a title that only lists the topics covered.`;

export const THUMBNAILS_PLAYBOOK = `THUMBNAIL CRAFT (the packaging rules always win)
- One idea, readable in one second at the size of a postage stamp (about 170 pixels wide). If it needs explaining, simplify.
- At most three elements: a subject (a face, or the clearest part of the screen), a few words, and one accent at most.
- Words: two to four is the aim, five the limit. They add what the title does not say (the stake, the feeling, the key object or a spoken number) and never reuse the title's words. Title: "How to export for YouTube without blurry video"; thumbnail: "DON'T DELETE THIS".
- Title and thumbnail tell one story from two sides: the title says what the video is, the thumbnail shows why it matters.
- Choosing the frame: prefer a close, expressive face looking at the camera, or a screen moment where the result is large and obvious. Avoid frames that are mostly small text, a blink, motion blur or an empty desktop. The subject sits on one third and the words on the other side.
- Template fit: "headline" for a face or a clear subject; "banner" for a readable screen that should stay fully visible (keep its words short: YouTube's duration stamp covers the bottom-right corner); "badge" when the frame is busy and should recede behind the words.
- Contrast: light words on a dark area or the reverse, and one saturated accent against a calmer background. Use a different palette for each concept.
- Honest: built on a real frame of this video. Never imply a result, a person or a brand that is not in it.
Do: the creator's surprised face beside "DON'T DELETE".
Don't: the whole title pasted on the picture; six words; a full settings page nobody can read at small size.`;

export interface Playbook {
  id: PlaybookId;
  title: string;
  /** Where it is used, in the creator's terms. */
  usedFor: string;
  text: string;
}

export const PLAYBOOKS: Playbook[] = [
  { id: 'editing', title: 'Editing', usedFor: 'First cut, section revisions and AI chat', text: EDITING_PLAYBOOK },
  { id: 'titles', title: 'Titles', usedFor: 'Title concepts in the Package tab', text: TITLES_PLAYBOOK },
  { id: 'thumbnails', title: 'Thumbnails', usedFor: 'Thumbnail concepts and generated backgrounds', text: THUMBNAILS_PLAYBOOK },
];

/** What the playbooks were written from. Nothing is copied from these. */
export const PLAYBOOK_SOURCES: { name: string; url: string; licence: string; used: string }[] = [
  { name: 'YouTube Help: Thumbnail & title tips', url: 'https://support.google.com/youtube/answer/12340300', licence: 'Google help content', used: 'Accuracy, short front-loaded titles, simple readable thumbnails, searchable vs intriguing titles' },
  { name: 'YouTube Help: Key moments for audience retention', url: 'https://support.google.com/youtube/answer/9314415', licence: 'Google help content', used: 'The first 30 seconds must match the title and thumbnail; move strong material earlier' },
  { name: 'thecraighewitt/skills: retention-editing, hook-writing, title-craft, thumbnail-design', url: 'https://github.com/thecraighewitt/skills', licence: 'MIT', used: 'Pattern interrupts, pacing by section, no throat-clearing openings, title angles, the one-second thumbnail test' },
  { name: 'browser-use/video-use', url: 'https://github.com/browser-use/video-use', licence: 'not stated in the skill file', used: 'Cut on word boundaries and silences, leave air around cuts, tie each effect to a visible event' },
  { name: 'chongdashu/cc-skills: youtube-titles-thumbnails', url: 'https://github.com/chongdashu/cc-skills', licence: 'none published (ideas only)', used: 'Title and thumbnail complement each other instead of repeating; neutral wording over hype' },
];

/** Trim, strip control characters and cap a creator's note. Pure. */
export function cleanNote(note: string | null | undefined): string {
  return (note ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NOTE_MAX);
}

/** A playbook followed by the creator's own notes, if any. */
export function withNotes(playbook: string, notes?: string | null): string {
  const n = cleanNote(notes);
  return n ? `${playbook}\nTHE CREATOR'S OWN NOTES FOR THIS (follow them unless they conflict with a non-negotiable rule)\n${n}` : playbook;
}

// ───────────────────────────── hard-rule checks ─────────────────────────────

export const TITLE_HARD_MAX = 100;
/** Past this, the end of the title is rarely seen. */
export const TITLE_LONG = 70;
/** Roughly what a phone shows before truncating. */
export const TITLE_FRONT = 50;
export const THUMB_WORDS_MAX = 5;

const SMALL = new Set('a an and are as at be but by for from how in is it its of on or so than that the this to vs was were what when why with you your'.split(' '));

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !SMALL.has(w));
}

/** Words as a viewer would count them on a thumbnail ("BEFORE / AFTER" is two). */
export function thumbnailWordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** Does the thumbnail text mostly reuse the title's words? */
export function repeatsTitle(title: string, thumbnailText: string): boolean {
  const thumb = contentWords(thumbnailText);
  if (thumb.length === 0) return false;
  const inTitle = new Set(contentWords(title));
  const shared = thumb.filter((w) => inTitle.has(w)).length;
  // One shared word in a two-word thumbnail is normal; most of them is a repeat.
  return thumb.length === 1 ? shared === 1 && inTitle.size <= 2 : shared / thumb.length >= 0.75;
}

export type PackagingWarningCode = 'title-over-limit' | 'title-long' | 'title-shouting' | 'thumb-too-many-words' | 'thumb-repeats-title' | 'thumb-no-text';

export interface PackagingWarning {
  code: PackagingWarningCode;
  about: 'title' | 'thumbnail';
  message: string;
}

/**
 * Check one concept against the hard rules of the playbooks. These are
 * warnings for the creator; nothing is rewritten.
 */
export function packagingWarnings(concept: { title: string; thumbnailText: string }): PackagingWarning[] {
  const out: PackagingWarning[] = [];
  const title = concept.title.trim();
  const thumb = concept.thumbnailText.trim();
  if (title.length > TITLE_HARD_MAX) out.push({ code: 'title-over-limit', about: 'title', message: `The title is ${title.length} characters. YouTube allows ${TITLE_HARD_MAX}.` });
  else if (title.length > TITLE_LONG) out.push({ code: 'title-long', about: 'title', message: `The title is ${title.length} characters. Phones show about the first ${TITLE_FRONT}, so put the important words first or shorten it.` });
  const letters = title.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12 && letters === letters.toUpperCase()) out.push({ code: 'title-shouting', about: 'title', message: 'The title is all capitals. Capitalise one word at most.' });
  const words = thumbnailWordCount(thumb);
  if (words > THUMB_WORDS_MAX) out.push({ code: 'thumb-too-many-words', about: 'thumbnail', message: `The thumbnail has ${words} words. More than ${THUMB_WORDS_MAX} cannot be read at small size.` });
  if (words > 0 && title && repeatsTitle(title, thumb)) out.push({ code: 'thumb-repeats-title', about: 'thumbnail', message: 'The thumbnail repeats the title. Use it for what the title does not say.' });
  return out;
}

// ───────────────────────────── built-in title patterns ─────────────────────────────

/** A project name the app made up ("Recording Nov 13 at 8.58 AM") says nothing about the video. */
export function isPlaceholderName(name: string): boolean {
  const n = name.trim();
  if (!n || /^(untitled|new project)$/i.test(n)) return true;
  if (/^(screen|camera|video|movie|clip)[\s_-]*\d*$/i.test(n)) return true;
  const stamp = /^(screen recording|recording|take)\b/i;
  // "Recording Nov 13 at 8.58 AM": a prefix, digits, and no real word after it.
  return stamp.test(n) && /\d/.test(n) && !/[a-z]{5,}/i.test(n.replace(stamp, ''));
}

const WARNING = /\b(do not|don't|dont|never|avoid|before you|make sure|careful|warning|mistake|wrong)\b/i;
const QUESTION = /^(how|why|what|when|which)\b/i;

/** Rank spoken sentences as title material: warnings and how/why lines first. Pure. */
export function titleSentenceScore(sentence: string): number {
  const words = sentence.trim().split(/\s+/).length;
  if (words < 4 || words > 14) return 0;
  let score = 1;
  if (WARNING.test(sentence)) score += 3;
  if (QUESTION.test(sentence.trim())) score += 2;
  if (sentence.length >= 30 && sentence.length <= TITLE_LONG) score += 1;
  return score;
}

/**
 * Pick thumbnail words that add to a title instead of repeating it.
 * Candidates are tried in order; each is cut to four words.
 */
export function complementText(title: string, candidates: string[], fallback: string): string {
  for (const c of candidates) {
    const text = c.trim().replace(/[.!?,;:]+$/, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    if (text && thumbnailWordCount(text) >= 1 && !repeatsTitle(title, text)) return text;
  }
  return fallback;
}

// ───────────────────────────── art direction for generated pictures ─────────────────────────────

export interface ArtDirectionInput {
  title: string;
  thumbnailText: string;
  /** What the video is about or shows, in a sentence, taken from the video itself. */
  subject: string;
  /** Where Cutaway will put the words. */
  template?: 'headline' | 'banner' | 'badge';
  /** Accent colours as hex, most important first. */
  palette?: string[];
  /** The creator's notes for thumbnails, if any. */
  notes?: string | null;
}

const SPACE: Record<NonNullable<ArtDirectionInput['template']>, string> = {
  headline: 'Put the subject on the right third. Keep the left half dark, plain and uncluttered: large words are added there afterwards.',
  banner: 'Compose for the upper two thirds. Keep the bottom third calm and low in detail: a band of words is added there afterwards.',
  badge: 'Keep the whole picture low in detail and slightly dark, with the subject pushed towards the edges: large centred words are added afterwards.',
};

/**
 * A prompt for an image model that paints a BACKGROUND for a thumbnail.
 * Cutaway adds the words itself, so the picture must contain none. The
 * result is an illustration of the topic: it must not look like evidence of
 * something the video does not show.
 */
export function artDirection(input: ArtDirectionInput): string {
  const subject = input.subject.replace(/\s+/g, ' ').trim().slice(0, 300) || input.title.trim();
  const palette = (input.palette ?? []).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 3);
  const notes = cleanNote(input.notes);
  return [
    'Background picture for a YouTube video thumbnail. 16:9, landscape.',
    `The video: ${subject}`,
    `Its title is "${input.title.trim().slice(0, TITLE_HARD_MAX)}" and the words "${input.thumbnailText.trim().slice(0, 60)}" will be laid over the picture later. Illustrate that one idea.`,
    'One clear subject, large in the frame, simple shapes. It must still read when the picture is 170 pixels wide.',
    SPACE[input.template ?? 'headline'],
    `Strong contrast between subject and background${palette.length ? `; accent colours ${palette.join(', ')} against a calmer, darker background` : '; one saturated accent colour against a calmer, darker background'}.`,
    'No text of any kind: no letters, numbers, captions, logos, watermarks or interface labels.',
    'No recognisable real people, no brand marks, no screenshots of real apps or websites.',
    'Illustrate the topic, not a result: no charts of success, money, trophies, before/after proof or anything that reads as a claim.',
    'Clean, modern, photographic or simple 3D look. No collage, no borders, no frames.',
    ...(notes ? [`The creator's own notes: ${notes}`] : []),
  ].join('\n');
}
