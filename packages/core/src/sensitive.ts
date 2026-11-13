/**
 * Finding things on screen that a creator would not want in a published video:
 * email addresses, API keys and tokens, card numbers, password values and phone
 * numbers.
 *
 * Input is text recognised on sampled screen frames. The recognised text is
 * only ever held in memory while it is classified here; callers keep the
 * category and the box, never the text. Nothing in this module logs.
 */
import type { Range, Rect, Seconds } from './types';

export type SensitiveCategory = 'email' | 'api-key' | 'card-number' | 'password' | 'phone';

export const SENSITIVE_LABEL: Record<SensitiveCategory, string> = {
  email: 'Email address',
  'api-key': 'API key or token',
  'card-number': 'Card number',
  password: 'Password or secret',
  phone: 'Phone number',
};

/** One recognised line of text. Boxes are normalised to the frame, origin top-left. */
export interface TextLine {
  text: string;
  box: Rect;
  /** Boxes of the whitespace-separated pieces of `text`, by character range. */
  tokens?: { start: number; end: number; box: Rect }[];
}

export interface SensitiveMatch {
  category: SensitiveCategory;
  /** Character range inside the line. */
  start: number;
  end: number;
}

export interface SensitiveHit {
  category: SensitiveCategory;
  box: Rect;
}

/** A hit that persists over time, ready to be offered as a mask. */
export interface SensitiveFinding extends Range {
  category: SensitiveCategory;
  rect: Rect;
  /** How many sampled frames showed it. */
  frames: number;
}

// Text recognition sometimes puts a space after the @, so one is allowed there.
const EMAIL = /[A-Za-z0-9][A-Za-z0-9._%+-]*@ ?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Tokens with a recognisable issuer prefix. */
const KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style
  /\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/** `password: hunter2`, `API_KEY=…`, `"secret": "…"`: the value after the label is what gets hidden. */
const LABELLED = /\b(pass(?:word|wd|phrase)?|pwd|secret|client[_ -]?secret|api[_ -]?key|access[_ -]?key|auth[_ -]?token|token)\b["']?\s*(?:[:=]|\bis\b)\s*["']?([^\s"',;]{4,})/gi;

const CARD = /(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g;
const PHONE = /(?<![\w.]|\d[ .-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]\d{3,4}(?![\w.]|[ .-]\d)/g;

export function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0 && !/^0+$/.test(digits);
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A long random-looking run of letters and digits with no issuer prefix. */
function looksRandom(token: string): boolean {
  if (token.length < 28 || token.length > 200) return false;
  if (!/^[A-Za-z0-9_+/=-]+$/.test(token)) return false;
  if (/^https?/i.test(token) || token.includes('//')) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(token)).length;
  // Hex digests (git hashes, checksums) are long and random but not secrets. Allow for a few characters misread on screen.
  const hex = token.replace(/[^0-9a-f]/gi, '').length;
  if (hex / token.length > 0.9) return false;
  return classes >= 3 && entropy(token) >= 4;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sensitive spans inside one line of text. Earlier categories win where spans overlap. */
export function matchSensitive(text: string): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  const add = (category: SensitiveCategory, start: number, end: number) => {
    const m = { category, start, end };
    if (end > start && !out.some((o) => overlaps(o, m))) out.push(m);
  };
  for (const m of text.matchAll(EMAIL)) add('email', m.index, m.index + m[0].length);
  for (const re of KEY_PATTERNS) for (const m of text.matchAll(re)) add('api-key', m.index, m.index + m[0].length);
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, '');
    if (luhn(digits)) add('card-number', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(LABELLED)) {
    const value = m[2]!;
    // A masked field (••••) or a placeholder is already safe to show.
    if (/^[•*●·x]+$/i.test(value) || /^(?:true|false|null|none|required|optional|undefined|string)$/i.test(value)) continue;
    const start = m.index + m[0].length - value.length;
    add(/pass|pwd|secret/i.test(m[1]!) ? 'password' : 'api-key', start, start + value.length);
  }
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    // 2024-11-12-style dates and version strings are not phone numbers.
    if (/^(?:19|20)\d{2}[ .-]\d{1,2}[ .-]\d{1,2}/.test(m[0].trim())) continue;
    add('phone', m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0].replace(/^["'(<[]+|["')>\],;.]+$/g, '');
    if (looksRandom(token)) {
      const start = m.index + m[0].indexOf(token);
      add('api-key', start, start + token.length);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function clampRect(r: Rect): Rect {
  const x = Math.min(1, Math.max(0, r.x));
  const y = Math.min(1, Math.max(0, r.y));
  return { x, y, w: Math.max(0, Math.min(1 - x, r.x + r.w - x)), h: Math.max(0, Math.min(1 - y, r.y + r.h - y)) };
}

/** Box of a character range: the pieces it touches, or a proportional slice of the line when pieces are unknown. */
function boxOf(line: TextLine, start: number, end: number): Rect {
  const touched = (line.tokens ?? []).filter((t) => t.start < end && start < t.end);
  if (touched.length) {
    // A piece that is only partly matched (KEY=value with no space) contributes the matching share of its width.
    return touched
      .map((t) => {
        const n = Math.max(1, t.end - t.start);
        const from = Math.max(0, start - t.start) / n;
        const to = Math.min(n, end - t.start) / n;
        return { x: t.box.x + t.box.w * from, y: t.box.y, w: t.box.w * (to - from), h: t.box.h };
      })
      .reduce(union);
  }
  const n = Math.max(1, line.text.length);
  return { x: line.box.x + (line.box.w * start) / n, y: line.box.y, w: (line.box.w * (end - start)) / n, h: line.box.h };
}

/** Sensitive areas of one recognised line. The text does not leave this function. */
export function findSensitive(line: TextLine): SensitiveHit[] {
  return matchSensitive(line.text).map((m) => ({ category: m.category, box: clampRect(boxOf(line, m.start, m.end)) }));
}

function iou(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Join per-frame hits into findings that last as long as the thing stays in
 * roughly the same place. Each finding's rectangle covers every position it was
 * seen at, grown a little so the mask does not sit flush on the glyphs.
 */
export function groupSensitive(frames: { t: Seconds; hits: SensitiveHit[] }[], opts: { interval: Seconds; duration: Seconds; pad?: number }): SensitiveFinding[] {
  const pad = opts.pad ?? 0.006;
  type Open = SensitiveFinding & { last: Seconds; lastBox: Rect };
  const open: Open[] = [];
  const done: Open[] = [];
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  for (const f of sorted) {
    for (const h of f.hits) {
      if (h.box.w <= 0 || h.box.h <= 0) continue;
      const cur = open.find((o) => o.category === h.category && f.t - o.last <= opts.interval * 1.6 && iou(o.lastBox, h.box) > 0.25);
      if (cur) {
        if (f.t > cur.last) cur.frames += 1;
        cur.last = f.t;
        cur.lastBox = h.box;
        cur.rect = union(cur.rect, h.box);
      } else open.push({ category: h.category, start: f.t, end: f.t, rect: h.box, frames: 1, last: f.t, lastBox: h.box });
    }
    for (let i = open.length - 1; i >= 0; i--) {
      if (f.t - open[i]!.last > opts.interval * 1.6) done.push(...open.splice(i, 1));
    }
  }
  done.push(...open);
  return done
    .map((d) => ({
      category: d.category,
      // The thing may have appeared just after the previous sample and stayed until just before the next.
      start: Math.max(0, d.start - opts.interval),
      end: Math.min(opts.duration, d.last + opts.interval),
      rect: clampRect({ x: d.rect.x - pad, y: d.rect.y - pad, w: d.rect.w + pad * 2, h: d.rect.h + pad * 2 }),
      frames: d.frames,
    }))
    .filter((d) => d.end > d.start)
    .sort((a, b) => a.start - b.start || a.rect.y - b.rect.y);
}
