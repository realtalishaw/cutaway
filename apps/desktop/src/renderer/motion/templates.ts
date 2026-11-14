/**
 * Built-in animations, and the creator's own saved ones. Each is an ordinary animation page, so the built-in
 * ones also serve as the model's worked examples.
 */
import { parseMotionMeta } from '@cutaway/core';
import arrow from './templates/arrow.html?raw';
import checklist from './templates/checklist.html?raw';
import circle from './templates/circle.html?raw';
import counter from './templates/counter.html?raw';
import highlighter from './templates/highlighter.html?raw';
import nametag from './templates/nametag.html?raw';
import subscribe from './templates/subscribe.html?raw';
import titlecard from './templates/titlecard.html?raw';

export interface MotionTemplate {
  id: string;
  name: string;
  description: string;
  html: string;
  /** Goes in a box the creator places, rather than over the whole frame. */
  boxed: boolean;
  /** Saved by the creator (can be removed), rather than built in. */
  own?: boolean;
}

const make = (id: string, html: string): MotionTemplate => {
  const meta = parseMotionMeta(html).meta;
  return { id, name: meta?.name ?? id, description: meta?.description ?? '', html, boxed: meta?.placement === 'box' };
};

export const MOTION_TEMPLATES: MotionTemplate[] = [
  make('subscribe', subscribe),
  make('nametag', nametag),
  make('titlecard', titlecard),
  make('counter', counter),
  make('checklist', checklist),
  make('highlighter', highlighter),
  make('circle', circle),
  make('arrow', arrow),
];

export const motionTemplate = (id: string) => MOTION_TEMPLATES.find((t) => t.id === id) ?? null;

/** The creator's own templates, saved from any project. */
export async function ownTemplates(): Promise<MotionTemplate[]> {
  const list = await Promise.resolve()
    .then(() => window.cutaway.motion.templates())
    .catch(() => [] as { id: string; html: string }[]);
  return list.map((t) => ({ ...make(t.id, t.html), own: true }));
}

/** The worked examples given to the model: the one closest to the request, plus a boxed one when it asks for a box. */
export function examplesFor(request: string): MotionTemplate[] {
  const r = request.toLowerCase();
  const pick = (ids: string[]) => ids.map(motionTemplate).filter((t): t is MotionTemplate => !!t);
  if (/circle|arrow|point|highlight|underline|marker|box|around/.test(r)) return pick(['subscribe', /arrow|point/.test(r) ? 'arrow' : /highlight|underline|marker/.test(r) ? 'highlighter' : 'circle']);
  if (/count|number|stat|views|subscribers|\d{3,}/.test(r)) return pick(['subscribe', 'counter']);
  if (/name|lower third|title|chapter|intro/.test(r)) return pick(['subscribe', /title|chapter|intro/.test(r) ? 'titlecard' : 'nametag']);
  if (/list|steps|check|tick/.test(r)) return pick(['subscribe', 'checklist']);
  return pick(['subscribe']);
}
