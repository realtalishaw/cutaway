/**
 * Free text overlays: style defaults and validation, animation as a pure function of time,
 * and the title templates. Nothing here measures text: layout happens in the compositor.
 */
import type { DecisionMeta, Overlay, Range, Seconds, TextAnimation, TextFont, TextStyle } from './types';
import { clamp, uid } from './ranges';

export const TEXT_FONTS: { id: TextFont; name: string; hint: string; weights: number[] }[] = [
  { id: 'inter', name: 'Inter', hint: 'Clean sans', weights: [400, 500, 600, 700, 800] },
  { id: 'grotesk', name: 'Hanken Grotesk', hint: 'Warm sans', weights: [400, 500, 600, 700, 800] },
  { id: 'anton', name: 'Anton', hint: 'Tall headline', weights: [400] },
  { id: 'serif', name: 'Instrument Serif', hint: 'Editorial serif', weights: [400] },
  { id: 'mono', name: 'Geist Mono', hint: 'Code and labels', weights: [400, 500, 600, 700] },
];

export const TEXT_ANIMATIONS: { id: TextAnimation; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'fade', name: 'Fade' },
  { id: 'slide-up', name: 'Slide up' },
  { id: 'pop', name: 'Pop' },
  { id: 'typewriter', name: 'Typewriter' },
];

/** Text never sits closer to an edge than this share of the output's short side. */
export const TEXT_SAFE_MARGIN = 0.05;

export const TEXT_LIMITS = {
  size: [0.015, 0.4],
  width: [0.1, 1],
  tracking: [-0.08, 0.5],
  leading: [0.8, 2],
  outline: [0, 0.3],
  duration: [0.05, 3],
  text: 400,
} as const;

export function defaultTextStyle(): TextStyle {
  return {
    font: 'inter',
    size: 0.07,
    weight: 700,
    color: '#ffffff',
    align: 'center',
    width: 0.8,
    uppercase: false,
    tracking: -0.01,
    leading: 1.12,
    background: { shape: 'none', color: '#0b0c10', opacity: 0.78 },
    outline: { width: 0, color: '#000000' },
    shadow: 0.5,
    accent: null,
    scrim: null,
    sub: { scale: 0.42, weight: 500, color: '#ffffffcc', font: 'inter', uppercase: false, tracking: 0 },
    in: { type: 'fade', duration: 0.35 },
    out: { type: 'fade', duration: 0.25 },
  };
}

const FONT_IDS = TEXT_FONTS.map((f) => f.id);
const ANIM_IDS = TEXT_ANIMATIONS.map((a) => a.id);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** A weight the font really has. Anton and Instrument Serif ship one weight; anything else would be a synthesised bold. */
export function fontWeightFor(font: TextFont, weight: number): number {
  const weights = TEXT_FONTS.find((f) => f.id === font)?.weights ?? [400];
  return weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), weights[0]!);
}

/**
 * Any value → a complete, in-range style. Used when a project is read and when a style is edited,
 * so the compositor never meets a missing field, a size of zero or a colour it cannot parse.
 */
export function normalizeTextStyle(raw: unknown): TextStyle {
  const d = defaultTextStyle();
  const r = obj(raw);
  const bg = obj(r.background);
  const ol = obj(r.outline);
  const sub = obj(r.sub);
  const anim = (v: unknown, fallback: TextStyle['in']): TextStyle['in'] => {
    const a = obj(v);
    return { type: oneOf(a.type, ANIM_IDS, fallback.type), duration: num(a.duration, TEXT_LIMITS.duration[0], TEXT_LIMITS.duration[1], fallback.duration) };
  };
  const font = oneOf(r.font, FONT_IDS, d.font);
  const scrim = r.scrim && typeof r.scrim === 'object' ? { color: color(obj(r.scrim).color, '#08090d'), opacity: num(obj(r.scrim).opacity, 0, 1, 0.6) } : null;
  const subFont = oneOf(sub.font, FONT_IDS, font);
  return {
    font,
    size: num(r.size, TEXT_LIMITS.size[0], TEXT_LIMITS.size[1], d.size),
    weight: fontWeightFor(font, num(r.weight, 100, 900, d.weight)),
    color: color(r.color, d.color),
    align: oneOf(r.align, ['left', 'center', 'right'] as const, d.align),
    width: num(r.width, TEXT_LIMITS.width[0], TEXT_LIMITS.width[1], d.width),
    uppercase: typeof r.uppercase === 'boolean' ? r.uppercase : d.uppercase,
    tracking: num(r.tracking, TEXT_LIMITS.tracking[0], TEXT_LIMITS.tracking[1], d.tracking),
    leading: num(r.leading, TEXT_LIMITS.leading[0], TEXT_LIMITS.leading[1], d.leading),
    background: { shape: oneOf(bg.shape, ['none', 'box', 'pill'] as const, d.background.shape), color: color(bg.color, d.background.color), opacity: num(bg.opacity, 0, 1, d.background.opacity) },
    outline: { width: num(ol.width, TEXT_LIMITS.outline[0], TEXT_LIMITS.outline[1], d.outline.width), color: color(ol.color, d.outline.color) },
    shadow: num(r.shadow, 0, 1, d.shadow),
    accent: r.accent === null || r.accent === undefined ? null : color(r.accent, '#ff5a36'),
    scrim: scrim && scrim.opacity > 0 ? scrim : null,
    sub: {
      scale: num(sub.scale, 0.2, 1.2, d.sub.scale),
      weight: fontWeightFor(subFont, num(sub.weight, 100, 900, d.sub.weight)),
      color: color(sub.color, d.sub.color),
      font: subFont,
      uppercase: typeof sub.uppercase === 'boolean' ? sub.uppercase : d.sub.uppercase,
      tracking: num(sub.tracking, TEXT_LIMITS.tracking[0], TEXT_LIMITS.tracking[1], d.sub.tracking),
    },
    in: anim(r.in, d.in),
    out: anim(r.out, d.out),
  };
}

/** The style a text overlay is drawn with. */
export function textStyleOf(o: Pick<Overlay, 'style'>): TextStyle {
  return normalizeTextStyle(o.style);
}

// ───────────────────────────── animation ─────────────────────────────

export interface TextPose {
  /** 0…1. */
  opacity: number;
  /** Vertical offset in font sizes; positive is down. */
  dy: number;
  scale: number;
  /** 0…1 share of the characters that are showing (typewriter). */
  reveal: number;
}

const REST: TextPose = { opacity: 1, dy: 0, scale: 1, reveal: 1 };
const outCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const smooth = (p: number) => p * p * (3 - 2 * p);
const outBack = (p: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
};

/** One animation at progress p (0 = hidden, 1 = settled). `leaving` mirrors the motion for the way out. */
function phase(type: TextAnimation, p: number, leaving: boolean): TextPose {
  if (p >= 1 || type === 'none') return REST;
  const q = clamp(p, 0, 1);
  switch (type) {
    case 'fade':
      return { ...REST, opacity: smooth(q) };
    case 'slide-up':
      // arrives from below; leaves by carrying on upward
      return { ...REST, opacity: clamp(q * 1.6, 0, 1), dy: (leaving ? -1 : 1) * (1 - outCubic(q)) * 0.7 };
    case 'pop':
      return { ...REST, opacity: clamp(q * 2.5, 0, 1), scale: leaving ? 0.86 + 0.14 * outCubic(q) : 0.72 + 0.28 * outBack(q) };
    case 'typewriter':
      return { ...REST, opacity: clamp(q * 8, 0, 1), reveal: q };
  }
}

/**
 * Where a text overlay is in its animation. `sinceIn` and `untilOut` are output-time seconds since it
 * appeared and until it goes. A pure function: the same instant always gives the same pose, in preview
 * and in export. When the overlay is shorter than its two animations they are shortened to fit.
 */
export function textPose(style: Pick<TextStyle, 'in' | 'out'>, sinceIn: Seconds, untilOut: Seconds): TextPose {
  if (sinceIn < 0 || untilOut <= 0) return { opacity: 0, dy: 0, scale: 1, reveal: 0 };
  let inDur = style.in.type === 'none' ? 0 : style.in.duration;
  let outDur = style.out.type === 'none' ? 0 : style.out.duration;
  const length = sinceIn + untilOut;
  if (inDur + outDur > length && inDur + outDur > 0) {
    const k = length / (inDur + outDur);
    inDur *= k;
    outDur *= k;
  }
  const a = inDur > 0 ? phase(style.in.type, sinceIn / inDur, false) : REST;
  const b = outDur > 0 ? phase(style.out.type, untilOut / outDur, true) : REST;
  return { opacity: a.opacity * b.opacity, dy: a.dy + b.dy, scale: a.scale * b.scale, reveal: Math.min(a.reveal, b.reveal) };
}

// ───────────────────────────── templates ─────────────────────────────

export interface TextTemplatePart {
  text: string;
  subtext?: string;
  x: number;
  y: number;
  style: TextStyle;
  /** Seconds after the template's start at which this part appears. */
  delay?: Seconds;
}

export interface TextTemplate {
  id: string;
  name: string;
  group: 'Titles' | 'Lower thirds' | 'Cards' | 'Labels';
  description: string;
  /** Default length on the timeline. */
  length: Seconds;
  parts: TextTemplatePart[];
}

const style = (patch: Partial<Omit<TextStyle, 'sub'>> & { sub?: Partial<TextStyle['sub']> }): TextStyle => {
  const d = defaultTextStyle();
  return normalizeTextStyle({ ...d, ...patch, sub: { ...d.sub, ...(patch.sub ?? {}) } });
};

const ACCENT = '#ff5a36';

/**
 * One-click starting points. Each is only a set of ordinary text overlays, so everything about them
 * stays editable afterwards.
 */
export const TEXT_TEMPLATES: TextTemplate[] = [
  {
    id: 'plain',
    name: 'Text',
    group: 'Labels',
    description: 'One line you can put anywhere.',
    length: 4,
    parts: [{ text: 'Your text', x: 0.5, y: 0.5, style: style({ size: 0.06, weight: 700, shadow: 0.6 }) }],
  },
  {
    id: 'big-title',
    name: 'Big title',
    group: 'Titles',
    description: 'A tall headline in the centre of the frame.',
    length: 3.5,
    parts: [
      {
        text: 'Big title',
        x: 0.5,
        y: 0.5,
        style: style({ font: 'anton', size: 0.17, weight: 400, uppercase: true, tracking: 0.01, leading: 1.02, width: 0.86, shadow: 0.75, in: { type: 'pop', duration: 0.45 }, out: { type: 'fade', duration: 0.25 } }),
      },
    ],
  },
  {
    id: 'title-subtitle',
    name: 'Title and subtitle',
    group: 'Titles',
    description: 'A headline with a quieter line under it.',
    length: 4,
    parts: [
      {
        text: 'Title goes here',
        subtext: 'A short line that says what this is about',
        x: 0.5,
        y: 0.5,
        style: style({ font: 'grotesk', size: 0.105, weight: 800, tracking: -0.025, leading: 1.04, width: 0.82, shadow: 0.7, accent: ACCENT, sub: { scale: 0.34, weight: 500, color: '#ffffffd9', font: 'grotesk', tracking: 0 }, in: { type: 'slide-up', duration: 0.5 }, out: { type: 'fade', duration: 0.3 } }),
      },
    ],
  },
  {
    id: 'editorial',
    name: 'Editorial title',
    group: 'Titles',
    description: 'A serif headline, left aligned, with a small label.',
    length: 4,
    parts: [
      {
        text: 'A calmer kind of title',
        subtext: 'Part one',
        x: 0.08,
        y: 0.56,
        style: style({ font: 'serif', size: 0.125, weight: 400, align: 'left', tracking: -0.015, leading: 1.02, width: 0.7, shadow: 0.7, sub: { scale: 0.22, weight: 600, color: '#ffffffb8', font: 'mono', uppercase: true, tracking: 0.14 }, in: { type: 'fade', duration: 0.6 }, out: { type: 'fade', duration: 0.35 } }),
      },
    ],
  },
  {
    id: 'punchy',
    name: 'Punchy caption',
    group: 'Titles',
    description: 'Heavy yellow capitals with a dark outline. Reads over anything.',
    length: 3,
    parts: [
      {
        text: 'Watch this',
        x: 0.5,
        y: 0.78,
        style: style({ font: 'inter', size: 0.1, weight: 800, color: '#ffd426', uppercase: true, tracking: -0.01, leading: 1.02, width: 0.86, shadow: 0.55, outline: { width: 0.07, color: '#0b0c10' }, in: { type: 'pop', duration: 0.3 }, out: { type: 'fade', duration: 0.2 } }),
      },
    ],
  },
  {
    id: 'chapter',
    name: 'Chapter card',
    group: 'Cards',
    description: 'Dims the picture and names the next part.',
    length: 2.6,
    parts: [
      {
        text: 'Chapter title',
        subtext: 'Chapter 1',
        x: 0.5,
        y: 0.5,
        style: style({ font: 'serif', size: 0.13, weight: 400, tracking: -0.015, leading: 1.04, width: 0.8, shadow: 0, accent: ACCENT, scrim: { color: '#08090d', opacity: 0.74 }, sub: { scale: 0.2, weight: 600, color: '#ffffffa6', font: 'mono', uppercase: true, tracking: 0.18 }, in: { type: 'fade', duration: 0.4 }, out: { type: 'fade', duration: 0.35 } }),
      },
    ],
  },
  {
    id: 'end-card',
    name: 'End card',
    group: 'Cards',
    description: 'A closing line over a dimmed picture.',
    length: 5,
    parts: [
      {
        text: 'Thanks for watching',
        subtext: 'Subscribe for the next one',
        x: 0.5,
        y: 0.46,
        style: style({ font: 'grotesk', size: 0.1, weight: 800, tracking: -0.025, leading: 1.05, width: 0.84, shadow: 0, scrim: { color: '#08090d', opacity: 0.8 }, sub: { scale: 0.36, weight: 500, color: '#ffffffc7', font: 'grotesk', tracking: 0 }, in: { type: 'slide-up', duration: 0.55 }, out: { type: 'fade', duration: 0.4 } }),
      },
    ],
  },
  {
    id: 'lower-third-bar',
    name: 'Name bar',
    group: 'Lower thirds',
    description: 'Name and role on a dark panel with an accent.',
    length: 5,
    parts: [
      {
        text: 'Your Name',
        subtext: 'What you do',
        x: 0.055,
        y: 0.84,
        style: style({ font: 'inter', size: 0.042, weight: 700, align: 'left', tracking: -0.012, leading: 1.1, width: 0.6, shadow: 0.35, accent: ACCENT, background: { shape: 'box', color: '#0b0c10', opacity: 0.86 }, sub: { scale: 0.62, weight: 500, color: '#ffffffb8', font: 'inter', tracking: 0 }, in: { type: 'slide-up', duration: 0.4 }, out: { type: 'fade', duration: 0.25 } }),
      },
    ],
  },
  {
    id: 'lower-third-clean',
    name: 'Name, no panel',
    group: 'Lower thirds',
    description: 'Name and role straight on the picture.',
    length: 5,
    parts: [
      {
        text: 'Your Name',
        subtext: 'What you do',
        x: 0.06,
        y: 0.85,
        style: style({ font: 'grotesk', size: 0.052, weight: 800, align: 'left', tracking: -0.02, leading: 1.08, width: 0.6, shadow: 0.85, sub: { scale: 0.52, weight: 600, color: '#ffffffe0', font: 'mono', uppercase: true, tracking: 0.1 }, in: { type: 'fade', duration: 0.4 }, out: { type: 'fade', duration: 0.3 } }),
      },
    ],
  },
  {
    id: 'label-pill',
    name: 'Pill label',
    group: 'Labels',
    description: 'A small rounded tag for pointing something out.',
    length: 4,
    parts: [
      {
        text: 'Worth noticing',
        x: 0.5,
        y: 0.14,
        style: style({ font: 'inter', size: 0.034, weight: 650, tracking: -0.005, width: 0.6, shadow: 0.4, background: { shape: 'pill', color: '#ffffff', opacity: 1 }, color: '#0b0c10', in: { type: 'pop', duration: 0.35 }, out: { type: 'fade', duration: 0.2 } }),
      },
    ],
  },
  {
    id: 'typed',
    name: 'Typed line',
    group: 'Labels',
    description: 'Monospace text that types itself in.',
    length: 4.5,
    parts: [
      {
        text: 'npm run build',
        x: 0.5,
        y: 0.82,
        style: style({ font: 'mono', size: 0.04, weight: 500, tracking: 0, width: 0.8, shadow: 0.3, background: { shape: 'box', color: '#0b0c10', opacity: 0.9 }, color: '#e7fbe9', in: { type: 'typewriter', duration: 0.9 }, out: { type: 'fade', duration: 0.25 } }),
      },
    ],
  },
];

export function textTemplate(id: string): TextTemplate {
  return TEXT_TEMPLATES.find((t) => t.id === id) ?? TEXT_TEMPLATES[0]!;
}

/** The overlays a template makes at `start` (session time), ready to append to `edit.overlays`. */
export function overlaysFromTemplate(templateId: string, start: Seconds, maxEnd: Seconds, meta: DecisionMeta): Overlay[] {
  const t = textTemplate(templateId);
  return t.parts.map((p) => {
    const a = Math.min(start + (p.delay ?? 0), Math.max(0, maxEnd - 0.5));
    const b = Math.max(a + 0.5, Math.min(maxEnd, start + t.length));
    return { id: uid('ov'), kind: 'text' as const, start: a, end: b, text: p.text, subtext: p.subtext, x: p.x, y: p.y, style: p.style, meta: { ...meta } };
  });
}

/** A copy for "Duplicate": right after the original when there is room, otherwise on top of it and nudged down so both can be grabbed. */
export function duplicateOverlay(o: Overlay, duration: Seconds, meta: DecisionMeta): Overlay {
  const len = o.end - o.start;
  const fits = o.end + len <= duration + 1e-6;
  return {
    ...o,
    id: uid('ov'),
    start: fits ? o.end : o.start,
    end: fits ? o.end + len : o.end,
    y: fits ? o.y : clamp(o.y + 0.07, 0.05, 0.95),
    style: o.style ? normalizeTextStyle(o.style) : undefined,
    sound: o.sound ? { ...o.sound } : undefined,
    meta: { ...meta },
  };
}

/** Text as it is drawn: trimmed to the limit, upper-cased when the style says so. */
export function shownText(text: string, uppercase: boolean): string {
  const t = text.slice(0, TEXT_LIMITS.text);
  return uppercase ? t.toUpperCase() : t;
}

/** Keeps a session range usable for a new overlay: inside the project and at least half a second long. */
export function overlayRange(start: Seconds, length: Seconds, duration: Seconds): Range {
  const a = clamp(start, 0, Math.max(0, duration - 0.5));
  return { start: a, end: Math.max(a + 0.5, Math.min(duration, a + length)) };
}

