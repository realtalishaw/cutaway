/** Putting animations on the timeline and changing them. Each change is one undoable step. */
import { carryFieldValues, clampBox, meta, uid, type EditState, type MotionSpec, type Overlay, type Rect } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback } from '../state/store';

const app = () => useApp.getState();

/** Save a page into the project and read its declaration. Throws when the page cannot be used. */
async function save(html: string, name: string) {
  const p = app().projectPath;
  if (!p) throw new Error('No project is open.');
  const r = await window.cutaway.motion.save(p, html, name);
  if (!r.meta) throw new Error(r.problems[0] ?? 'The animation has no description block.');
  return { file: r.file, meta: r.meta };
}

/** Add an animation at the playhead, for its natural length, and select it. Returns the block's id. */
/** Add an animation at session time `at`, or at the playhead when `at` is null or left out. */
export async function addMotion(html: string, origin: MotionSpec['origin'], values: Record<string, string> = {}, at: number | null = null, also?: { edit(e: EditState): EditState; label: string }, select = true): Promise<string> {
  const { file, meta: m } = await save(html, origin.kind === 'template' ? origin.template : 'animation');
  const id = uid('mot');
  app().edit((e, p) => {
    const start = Math.min(at ?? timeMapOf(p).toSource(usePlayback.getState().time), Math.max(0, p.duration - 0.5));
    const o: Overlay = {
      id,
      kind: 'motion',
      text: m.name,
      x: 0.5,
      y: 0.5,
      start,
      end: Math.min(p.duration, start + m.duration),
      motion: { file, name: m.name, duration: m.duration, fields: m.fields.map((f) => (values[f.id] !== undefined ? { ...f, value: values[f.id]! } : f)), sounds: m.sounds, origin, ...(m.box ? { box: m.box } : {}) },
      meta: meta('creator', p.revision + 1),
    };
    const next = { ...e, overlays: [...e.overlays, o] };
    return also ? also.edit(next) : next;
  }, also?.label ?? `Add ${m.name}`);
  if (select) app().select({ kind: 'overlay', id });
  return id;
}

/** Replace an animation's page with a new version (a revision), keeping the values the creator set. */
export async function reviseMotion(id: string, html: string, prompt: string, provider: string): Promise<void> {
  const { file, meta: m } = await save(html, 'animation');
  app().edit((e, p) => ({
    ...e,
    overlays: e.overlays.map((o) => {
      if (o.id !== id || !o.motion) return o;
      // a boxed animation keeps the box the creator placed; one that now fills the frame drops it
      const box = m.placement === 'box' ? (o.motion.box ?? m.box ?? undefined) : undefined;
      const motion: MotionSpec = { file, name: m.name, duration: m.duration, fields: carryFieldValues(m.fields, o.motion.fields), sounds: m.sounds, origin: { kind: 'ai', provider, prompt }, ...(box ? { box } : {}) };
      // the block keeps its start and takes the new natural length
      return { ...o, text: m.name, end: Math.min(p.duration, o.start + m.duration), motion, meta: meta('creator', p.revision + 1) };
    }),
  }), `Change ${m.name}`);
}

export function setMotionField(id: string, field: string, value: string) {
  app().edit((e) => ({
    ...e,
    overlays: e.overlays.map((o) => (o.id === id && o.motion ? { ...o, motion: { ...o.motion, fields: o.motion.fields.map((f) => (f.id === field ? { ...f, value } : f)) } } : o)),
  }), 'Animation field', `motion:${id}:${field}`);
}

/** Move or resize a boxed animation (fractions of the frame). Drags coalesce into one undo step. */
export function setMotionBox(id: string, box: Rect, coalesce = 'move') {
  app().edit((e) => ({
    ...e,
    overlays: e.overlays.map((o) => (o.id === id && o.motion?.box ? { ...o, motion: { ...o.motion, box: clampBox(box) } } : o)),
  }), 'Place animation', `motion-box:${id}:${coalesce}`);
}
