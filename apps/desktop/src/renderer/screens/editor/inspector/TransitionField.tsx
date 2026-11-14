import { clipsOf, maxTransition, placedTransitions, transitionBetween, TRANSITION, TRANSITION_KINDS, type TransitionKind } from '@cutaway/core';
import { timeMapOf, useApp, useProject, readOnly } from '../../../state/store';
import { Slider } from '../../../ui/kit';
import { setClipTransition } from '../transitionOps';

/** Small drawing of each kind: two frames overlapping, or a frame giving way to black or white. */
export function TransitionGlyph({ kind, size = 14 }: { kind: TransitionKind | null; size?: number }) {
  const s = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true } as const;
  if (kind === 'dissolve')
    return (
      <svg {...s}>
        <rect x="1.5" y="3.5" width="8" height="9" rx="1.6" fill="currentColor" opacity="0.55" />
        <rect x="6.5" y="3.5" width="8" height="9" rx="1.6" fill="currentColor" opacity="0.9" />
      </svg>
    );
  if (kind === 'dip-black' || kind === 'dip-white')
    return (
      <svg {...s}>
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <rect x="6" y="3.5" width="4" height="9" fill={kind === 'dip-black' ? '#08090d' : '#ffffff'} stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  return (
    <svg {...s}>
      <path d="M8 2.5v11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const sec = (v: number) => `${v.toFixed(v < 1 ? 2 : 1).replace(/0$/, '')}s`;

/**
 * Choose how one clip gives way to the next, and for how long. Used in the clip
 * panel and in the menu on the boundary in the clips row.
 */
export function TransitionField({ from, to, compact }: { from: string; to: string; compact?: boolean }) {
  const project = useProject();
  const ro = useApp(readOnly);
  const t = transitionBetween(project, from, to);
  const clips = clipsOf(project);
  const a = clips.find((c) => c.id === from);
  const b = clips.find((c) => c.id === to);
  if (!a || !b) return null;
  const map = timeMapOf(project);
  const room = maxTransition(map, a, b);
  const drawn = t ? (placedTransitions(project, map).find((p) => p.transition.id === t.id)?.duration ?? 0) : 0;
  const options: { value: TransitionKind | null; label: string }[] = [{ value: null, label: 'Hard cut' }, ...TRANSITION_KINDS];
  return (
    <div className="tr-field" data-testid="transition-field">
      <div className={`tr-kinds${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Transition">
        {options.map((o) => (
          <button key={o.value ?? 'none'} role="radio" aria-checked={(t?.kind ?? null) === o.value} disabled={ro || (o.value !== null && room < 0.05)} data-kind={o.value ?? 'none'} onClick={() => setClipTransition(from, to, o.value, t?.duration)}>
            <TransitionGlyph kind={o.value} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {t ? (
        <>
          <Slider label="Length" min={TRANSITION.min} max={TRANSITION.max} step={0.05} value={t.duration} format={sec} onChange={(v) => !ro && setClipTransition(from, to, t.kind, v)} />
          {drawn > 0 && drawn < t.duration - 0.01 ? <div className="tiny dim">Plays for {sec(drawn)}: these two clips are too short for more.</div> : null}
          {drawn === 0 ? <div className="tiny dim">One of these clips has nothing left to play, so this is a hard cut for now.</div> : null}
        </>
      ) : room < 0.05 ? (
        <div className="tiny dim">These clips are too short for a transition.</div>
      ) : null}
    </div>
  );
}
