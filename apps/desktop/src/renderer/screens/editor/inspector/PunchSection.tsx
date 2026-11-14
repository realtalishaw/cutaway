import { PUNCH, fmtTime, punchInOf, punchJoins } from '@cutaway/core';
import { timeMapOf, useApp, useProject, readOnly } from '../../../state/store';
import { Slider, Toggle } from '../../../ui/kit';
import { seekSource } from '../ops';
import { setCutPunchSkipped, setPunch, togglePunch } from '../transitionOps';
import { Reset, Section } from './shared';
import '../clips.css';

/**
 * Punch-in on jump cuts: the setting, how strong it is, and every cut where the
 * framing changes. Clicking a cut goes to it; its own panel can exclude it.
 */
export function PunchSection() {
  const project = useProject();
  const ro = useApp(readOnly);
  const select = useApp((s) => s.select);
  const p = punchInOf(project.edit);
  const joins = punchJoins(project, timeMapOf(project)).filter((j) => j.qualifies);
  const applied = joins.filter((j) => !j.skipped);
  const noScreen = !project.sources.some((s) => s.role === 'screen');
  return (
    <Section title="Jump cuts" icon="scissors" action={<Reset show={p.enabled && Math.abs(p.scale - PUNCH.default) > 0.001} onClick={() => setPunch({ scale: PUNCH.default })} />}>
      <Toggle
        label="Punch in on jump cuts"
        hint={noScreen ? 'Suggested for this video: with no screen to cut to, every cut inside a shot shows as a jump.' : 'Changes the framing slightly at each cut inside a camera shot, so the cut reads as a change of shot.'}
        checked={p.enabled}
        onChange={() => !ro && togglePunch()}
      />
      {p.enabled ? (
        <>
          <Slider label="Punch-in" min={PUNCH.min} max={PUNCH.max} step={0.01} value={p.scale} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => !ro && setPunch({ scale: v })} />
          {joins.length === 0 ? (
            <div className="tiny dim" data-testid="punch-none">No cut qualifies yet. It applies where a cut sits inside one full-frame camera shot, in the same clip, with no zoom and no view change at the cut.</div>
          ) : (
            <>
              <div className="tiny muted" data-testid="punch-count">
                Framing changes at {applied.length} of {joins.length} cut{joins.length === 1 ? '' : 's'}. Each is marked on the timeline; select a cut to leave it out.
              </div>
              <div className="punch-list" role="list" aria-label="Cuts where the framing changes">
                {joins.map((j) => (
                  <button
                    key={j.cutIds.join('+') || j.at}
                    role="listitem"
                    data-testid="punch-join"
                    data-skipped={j.skipped}
                    data-punched={j.punched}
                    title={j.skipped ? 'Left out: the framing stays as it was. Click to go to this cut.' : 'Click to go to this cut. Select the cut to leave it out.'}
                    onClick={() => {
                      seekSource(project, j.after);
                      if (j.cutIds[0]) select({ kind: 'cut', id: j.cutIds[0] });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!ro) setCutPunchSkipped(j.cutIds, !j.skipped);
                    }}
                  >
                    <span className="mono">{fmtTime(j.at, true)}</span>
                    <span>{j.skipped ? 'Left out' : j.punched ? 'Punches in' : 'Back to normal'}</span>
                    <span className={`tag${j.punched && !j.skipped ? ' in' : ''}`}>{j.punched ? `${Math.round(p.scale * 100)}%` : '100%'}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}
    </Section>
  );
}
