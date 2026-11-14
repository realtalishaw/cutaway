import { clipLength, clipTrim, clipsOf, fmtTime, isTimelineSource, playingClips, takeOf, transitionBetween, transitionsOf, type LayoutMode } from '@cutaway/core';
import { timeMapOf, useApp, useProject, usePlayback, readOnly } from '../../../state/store';
import { Button, Field } from '../../../ui/kit';
import { moveClipTo, putBackClipById, removeClipById, renameClipTo, setClipView, splitClipAtPlayhead, trimClipTo } from '../clipOps';
import { Section } from './shared';
import { setEveryTransition } from '../transitionOps';
import { TransitionField } from './TransitionField';
import '../clips.css';

const VIEWS: { value: LayoutMode; label: string; needs: 'screen' | 'camera' | 'both' }[] = [
  { value: 'screen', label: 'Screen only', needs: 'screen' },
  { value: 'camera', label: 'Camera only', needs: 'camera' },
  { value: 'overlay', label: 'Screen with camera bubble', needs: 'both' },
  { value: 'split', label: 'Side by side', needs: 'both' },
  { value: 'presenter', label: 'Camera with screen inset', needs: 'both' },
];

/** The panel for a selected clip: its name, where it sits, its view, its trims, and the clips that are off the timeline. */
export function ClipEditor({ id }: { id: string }) {
  const project = useProject();
  const ro = useApp(readOnly);
  const clips = clipsOf(project);
  const playing = playingClips(clips);
  const c = clips.find((x) => x.id === id);
  const off = clips.filter((x) => x.removed);
  if (!c) return null;
  const index = playing.findIndex((x) => x.id === id);
  const trim = clipTrim(project.edit, c);
  const roles = new Set(project.sources.filter((s) => isTimelineSource(s) && !s.instanceOf && takeOf(s) === c.take && s.sync.status !== 'unsynced').map((s) => s.role));
  const hasScreen = roles.has('screen');
  const hasCam = roles.has('cameraA') || roles.has('cameraB');
  const views = VIEWS.filter((v) => (v.needs === 'screen' ? hasScreen : v.needs === 'camera' ? hasCam : hasScreen && hasCam));
  const inside = (() => {
    const t = timeMapOf(project).toSource(usePlayback.getState().time);
    return !c.removed && t > c.start + 0.2 && t < c.start + clipLength(c) - 0.2;
  })();
  return (
    <>
      <Section
        title={c.removed ? 'Clip (off the timeline)' : `Clip ${index + 1} of ${playing.length}`}
        action={c.removed ? undefined : <Button variant="ghost" size="sm" icon="trash" disabled={ro || playing.length < 2} onClick={() => removeClipById(c.id)} aria-label="Remove from the timeline" title={playing.length < 2 ? 'The only clip on the timeline stays' : 'Remove from the timeline (⌫). The footage and its edits are kept.'} data-testid="clip-remove" />}
      >
        <Field label="Name">
          <input className="input clip-name-field" key={c.id} defaultValue={c.name} disabled={ro} aria-label="Clip name" data-testid="clip-name" onBlur={(e) => renameClipTo(c.id, e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        </Field>
        {c.removed ? (
          <>
            <div className="tiny dim">This clip is not in the video. Its footage, words and edits are kept.</div>
            <Button size="sm" disabled={ro} onClick={() => putBackClipById(c.id)} data-testid="clip-put-back">Put back at the end</Button>
          </>
        ) : (
          <>
            <div className="tiny mono dim">
              {fmtTime(c.start, true)} – {fmtTime(c.start + clipLength(c), true)} · {fmtTime(clipLength(c) - trim.head - trim.tail, true)} plays
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Button size="sm" disabled={ro || index <= 0} onClick={() => moveClipTo(c.id, index - 1)} data-testid="clip-earlier" title="Play this clip one place earlier (⌥←)">Earlier</Button>
              <Button size="sm" disabled={ro || index >= playing.length - 1} onClick={() => moveClipTo(c.id, index + 1)} data-testid="clip-later" title="Play this clip one place later (⌥→)">Later</Button>
              <Button size="sm" disabled={ro || !inside} onClick={() => splitClipAtPlayhead(project)} data-testid="clip-split" title={inside ? 'Split this clip in two at the playhead (⌘B)' : 'Move the playhead inside this clip to split it there'}>Split at playhead</Button>
            </div>
            {views.length > 1 ? (
              <Field label="View" hint="What this clip shows wherever no view change is set on it.">
                <select className="select" value={c.baseLayout ?? ''} disabled={ro} aria-label="Clip view" data-testid="clip-view" onChange={(e) => setClipView(c.id, (e.target.value || undefined) as LayoutMode | undefined)}>
                  <option value="">Automatic</option>
                  {views.map((v) => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            {trim.head > 0.01 || trim.tail > 0.01 ? (
              <div className="row between tiny" style={{ gap: 8 }}>
                <span className="muted">
                  Trimmed: {trim.head > 0.01 ? `${trim.head.toFixed(1)}s off the start` : ''}{trim.head > 0.01 && trim.tail > 0.01 ? ', ' : ''}{trim.tail > 0.01 ? `${trim.tail.toFixed(1)}s off the end` : ''}
                </span>
                <Button size="sm" variant="ghost" disabled={ro} data-testid="clip-untrim" onClick={() => (trimClipTo(c.id, 'head', 0), trimClipTo(c.id, 'tail', 0))}>Restore</Button>
              </div>
            ) : (
              <div className="tiny dim">Drag either end of the clip on the timeline to trim it. A trim can always be dragged back.</div>
            )}
          </>
        )}
      </Section>
      {!c.removed && playing.length > 1 ? (
        <Section
          title="Transitions"
          action={
            transitionsOf(project.edit).length ? (
              <Button variant="ghost" size="sm" disabled={ro} onClick={() => setEveryTransition(null)} data-testid="transitions-clear" title="Make every clip change a hard cut again">Remove all</Button>
            ) : undefined
          }
        >
          {index > 0 ? (
            <div className="tr-side" data-testid="transition-in">
              <span className="tiny muted">From “{playing[index - 1]!.name}” into this clip</span>
              <TransitionField from={playing[index - 1]!.id} to={c.id} />
            </div>
          ) : null}
          {index < playing.length - 1 ? (
            <div className="tr-side" data-testid="transition-out">
              <span className="tiny muted">From this clip into “{playing[index + 1]!.name}”</span>
              <TransitionField from={c.id} to={playing[index + 1]!.id} />
            </div>
          ) : null}
          {(() => {
            const mine = (index > 0 ? transitionBetween(project, playing[index - 1]!.id, c.id) : null) ?? (index < playing.length - 1 ? transitionBetween(project, c.id, playing[index + 1]!.id) : null);
            return mine && playing.length > 2 ? (
              <Button size="sm" disabled={ro} onClick={() => setEveryTransition(mine.kind, mine.duration)} data-testid="transitions-all">Use on every clip change</Button>
            ) : null;
          })()}
          <div className="tiny dim">A transition never changes the length of the video. It is dropped if these two clips stop being neighbours.</div>
        </Section>
      ) : null}
      {off.filter((x) => x.id !== c.id).length || (off.length && !c.removed) ? (
        <Section title="Off the timeline">
          {off.filter((x) => x.id !== c.id).map((x) => (
            <div key={x.id} className="clip-off">
              <span className="tiny">{x.name} <span className="dim mono">{fmtTime(clipLength(x))}</span></span>
              <Button size="sm" variant="ghost" disabled={ro} onClick={() => putBackClipById(x.id)}>Put back</Button>
            </div>
          ))}
        </Section>
      ) : null}
    </>
  );
}
