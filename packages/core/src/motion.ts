/**
 * Animations ("motion"). The page itself carries what Cutaway needs to know about it, in one JSON block:
 *
 *   <script type="application/json" id="cutaway-motion">
 *     {"name":"Subscribe","duration":4,"fields":[{"id":"label","label":"Button text","type":"text","default":"Subscribe"}],
 *      "sounds":[{"t":1.2,"sound":"click"}]}
 *   </script>
 *
 * Fields reach the page as CSS custom properties (var(--label)) and as the text of [data-field="label"].
 */
import type { MotionCue, MotionField, MotionSpec, Overlay, Rect, Seconds } from './types';
import { BUILTIN_SOUNDS } from './sound';

export const MOTION_META_ID = 'cutaway-motion';
/** Longest animation Cutaway renders. */
export const MAX_MOTION_SECONDS = 30;

export interface MotionMeta {
  name: string;
  duration: Seconds;
  fields: MotionField[];
  sounds: MotionCue[];
  /** 'box': drawn into a box the creator places over something; the page fills its own viewport. */
  placement: 'frame' | 'box';
  /** Where a boxed animation starts out, as fractions of the frame. */
  box: Rect | null;
  description: string;
}

const FIELD_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Read the JSON block of an animation page. Problems come back as plain sentences; nothing throws. */
export function parseMotionMeta(html: string): { meta: MotionMeta | null; problems: string[] } {
  const problems: string[] = [];
  const m = html.match(new RegExp(`<script[^>]*id=["']${MOTION_META_ID}["'][^>]*>([\\s\\S]*?)</script>`, 'i'));
  if (!m) return { meta: null, problems: [`The page has no <script type="application/json" id="${MOTION_META_ID}"> block.`] };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(m[1]!) as Record<string, unknown>;
  } catch (e) {
    return { meta: null, problems: [`The ${MOTION_META_ID} block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Animation';
  const duration = Number(raw.duration);
  if (!Number.isFinite(duration) || duration < 0.3 || duration > MAX_MOTION_SECONDS) problems.push(`"duration" must be a number of seconds from 0.3 to ${MAX_MOTION_SECONDS}.`);
  const fields: MotionField[] = [];
  for (const f of Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>[]) : []) {
    const id = String(f?.id ?? '');
    if (!FIELD_ID.test(id)) {
      problems.push(`Field id "${id}" must be lower-case letters, digits and dashes.`);
      continue;
    }
    const type = f.type === 'color' || f.type === 'number' ? f.type : 'text';
    fields.push({ id, label: String(f.label ?? id).slice(0, 40), type, value: String(f.default ?? f.value ?? '').slice(0, 200) });
  }
  const known = new Set(BUILTIN_SOUNDS.map((b) => b.id));
  const sounds: MotionCue[] = [];
  for (const c of Array.isArray(raw.sounds) ? (raw.sounds as Record<string, unknown>[]) : []) {
    const t = Number(c?.t);
    const sound = String(c?.sound ?? '');
    if (!known.has(sound)) problems.push(`Sound "${sound}" is not one of: ${[...known].join(', ')}.`);
    else if (Number.isFinite(t) && t >= 0 && t <= (Number.isFinite(duration) ? duration : MAX_MOTION_SECONDS)) sounds.push({ t, sound, ...(Number.isFinite(Number(c.gain)) ? { gain: Math.min(1, Math.max(0, Number(c.gain))) } : {}) });
  }
  const placement = raw.placement === 'box' ? 'box' : 'frame';
  const b = raw.box as Record<string, unknown> | undefined;
  const box = placement === 'box' ? clampBox(b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v))) ? { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) } : DEFAULT_BOX) : null;
  const description = typeof raw.description === 'string' ? raw.description.slice(0, 200) : '';
  if (problems.length && !Number.isFinite(duration)) return { meta: null, problems };
  return { meta: { name, duration: Math.min(MAX_MOTION_SECONDS, Math.max(0.3, duration)), fields, sounds, placement, box, description }, problems };
}

/** The values the page is rendered with, by field id. */
export const motionValues = (spec: Pick<MotionSpec, 'fields'>): Record<string, string> => Object.fromEntries(spec.fields.map((f) => [f.id, f.value]));

/** Fields of a new version keep the values the creator had set, where the field still exists. */
export function carryFieldValues(next: MotionField[], prev: MotionField[]): MotionField[] {
  return next.map((f) => {
    const old = prev.find((p) => p.id === f.id && p.type === f.type);
    return old ? { ...f, value: old.value } : f;
  });
}

/** Where a boxed animation starts when nothing else is said: a third of the frame, in the middle. */
export const DEFAULT_BOX: Rect = { x: 0.33, y: 0.36, w: 0.34, h: 0.28 };
/** Smallest box, as a fraction of the frame on each side. */
export const MIN_BOX = 0.04;

/** A box kept inside the frame and not smaller than MIN_BOX. */
export function clampBox(r: Rect): Rect {
  const w = Math.min(1, Math.max(MIN_BOX, r.w));
  const h = Math.min(1, Math.max(MIN_BOX, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}

/** The pixel size an animation is rendered at, for an output of `width`×`height`: its box, or the frame. Even sizes. */
export function motionPixels(spec: Pick<MotionSpec, 'box'>, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const b = spec.box;
  if (!b) return { x: 0, y: 0, width, height };
  const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
  return { x: Math.round(b.x * width), y: Math.round(b.y * height), width: even(b.w * width), height: even(b.h * height) };
}

export const isMotion = (o: Pick<Overlay, 'kind' | 'motion'>): o is Overlay & { motion: MotionSpec } => o.kind === 'motion' && !!o.motion;

/** The page with its fields' defaults set to `values` (saving an animation as a template keeps its words and colours). */
export function withFieldDefaults(html: string, values: Record<string, string>, name?: string): string {
  const re = new RegExp(`(<script[^>]*id=["']${MOTION_META_ID}["'][^>]*>)([\\s\\S]*?)(</script>)`, 'i');
  const m = html.match(re);
  if (!m) return html;
  try {
    const raw = JSON.parse(m[2]!) as { name?: string; fields?: { id: string; default?: string }[] };
    for (const f of raw.fields ?? []) if (values[f.id] !== undefined) f.default = values[f.id];
    if (name) raw.name = name;
    return html.replace(re, (_all, open: string, _body: string, close: string) => `${open}\n${JSON.stringify(raw, null, 2)}\n${close}`);
  } catch {
    return html;
  }
}
