/**
 * Editor actions for transitions between clips and for the punch-in on jump
 * cuts. Each is one undoable step. The model is in core/transitions.ts and
 * core/punch.ts.
 */
import { clipPairs, clipsOf, punchInOf, punchJoins, setAllTransitions, setPunchIn, setPunchSkipped, setTransition, transitionLabel, type TransitionKind } from '@cutaway/core';
import { timeMapOf, useApp, readOnly } from '../../state/store';

const app = () => useApp.getState();

/** Set, change or clear (`kind: null`) the transition between two neighbouring clips. Slider drags coalesce. */
export function setClipTransition(from: string, to: string, kind: TransitionKind | null, duration?: number) {
  if (readOnly(app())) return;
  app().edit((_e, q) => setTransition(q, from, to, kind, duration), kind ? `Transition: ${transitionLabel(kind)}` : 'Remove transition', `transition:${from}:${to}:${kind ?? 'none'}`);
}

/** The same transition on every clip change, or none. One undo step. */
export function setEveryTransition(kind: TransitionKind | null, duration?: number) {
  const p = app().project;
  if (!p || readOnly(app())) return;
  const n = clipPairs(clipsOf(p)).length;
  if (n === 0) {
    app().toast('Transitions sit between clips, and this video has one clip. Add a clip, or split this one with ⌘B.');
    return;
  }
  app().edit((_e, q) => setAllTransitions(q, kind, duration), kind ? `${transitionLabel(kind)} on every clip change` : 'Remove all transitions');
  app().toast(kind ? `${transitionLabel(kind)} set on ${n} clip change${n === 1 ? '' : 's'}.` : 'All transitions removed. Clip changes are hard cuts again.');
}

export function setPunch(patch: { enabled?: boolean; scale?: number }) {
  if (readOnly(app())) return;
  app().edit((e) => setPunchIn(e, patch), patch.enabled === undefined ? 'Punch-in amount' : patch.enabled ? 'Punch in on jump cuts' : 'Punch-in off', patch.enabled === undefined ? 'punch-scale' : undefined);
}

/** Turn the punch-in on or off and say where it applies. */
export function togglePunch() {
  const p = app().project;
  if (!p || readOnly(app())) return;
  const on = !punchInOf(p.edit).enabled;
  setPunch({ enabled: on });
  if (!on) return;
  const n = punchJoins(p, timeMapOf(p)).filter((j) => j.qualifies).length;
  app().toast(n ? `Punch-in on: the framing now changes at ${n} cut${n === 1 ? '' : 's'} inside camera shots.` : 'Punch-in on. It applies to cuts inside a full-frame camera shot; this edit has none yet.');
}

/** Leave the framing alone at one cut, or let the punch-in apply there again. */
export function setCutPunchSkipped(cutIds: string[], skipped: boolean) {
  if (readOnly(app())) return;
  app().edit((e) => setPunchSkipped(e, cutIds, skipped), skipped ? 'No punch-in at this cut' : 'Punch in at this cut');
}
