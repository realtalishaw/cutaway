import { useState } from 'react';
import { fmtTime, type DecisionMeta, type GraphicKind, type LayoutMode, type Project, type Range } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';
import { useApp, useProject } from '../../../state/store';
import { Icon } from '../../../ui/icons';
import { Button, Field, Segmented, Slider, Toggle } from '../../../ui/kit';
import { addBroll, addMask, addOverlay, addZoom, camerasFor, cutRange, lockRange, patchItem, removeSelected, restore, restoreOne, seekSource, setLayout, setSpeed, toggleItemLock } from '../ops';
import { Section, TimesRow, Why, app, pct } from './shared';
import { musicClipsOf, soundsOf } from '@cutaway/core';
import { addText, setOverlaySound } from '../titleSoundOps';
import { CueField } from './CueField';
import { MusicEditor, SoundEditor } from './SoundEditors';
import { TextEditor } from './TextEditor';
import { ClipEditor } from './ClipEditor';
import { BROLL_FADE, punchInOf, punchJoins } from '@cutaway/core';
import { timeMapOf } from '../../../state/store';
import { setCutPunchSkipped } from '../transitionOps';

function RangeActions({ project, range, pickTarget }: { project: Project; range: Range; pickTarget: (what: 'mask') => void }) {
  const [instruction, setInstruction] = useState('');
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const cams = camerasFor(project, range);
  const anyCam = project.sources.some((s) => s.role === 'cameraA' || s.role === 'cameraB');
  const assets = project.sources.filter((s) => (s.role === 'broll' || s.role === 'image') && s.available);
  const cutInside = project.edit.cuts.some((c) => c.start < range.end && c.end > range.start);
  const view = (mode: LayoutMode) => setLayout(range, mode, cams[0]);
  return (
    <>
      <Section title={`Selection · ${(range.end - range.start).toFixed(1)}s`}>
        <TimesRow project={project} range={range} />
        <div className="row wrap">
          <Button icon="scissors" onClick={() => cutRange(range)} title="Remove this footage (⌫)">Cut</Button>
          {cutInside ? <Button icon="undo" onClick={() => restore(range)}>Restore</Button> : null}
          <Button icon="lock" onClick={() => lockRange(range)} title="AI changes will leave this range alone (L)">Keep as is</Button>
        </div>
        <Field label="Speed">
          <Segmented value="x" onChange={(v) => setSpeed(range, Number(v))} full options={[{ value: '0.5', label: '0.5×' }, { value: '1', label: '1×' }, { value: '1.5', label: '1.5×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
        </Field>
      </Section>
      <Section title="Show here">
        <div className="grid-2">
          {hasScreen ? <Button icon="screen" onClick={() => view('screen')}>Screen only</Button> : null}
          {hasScreen && anyCam ? <Button icon="layout" disabled={!cams.length} onClick={() => view('overlay')}>Screen + camera</Button> : null}
          {anyCam ? <Button icon="camera" disabled={!cams.length} onClick={() => view('camera')}>Camera</Button> : null}
          {hasScreen && anyCam ? <Button icon="split" disabled={!cams.length} onClick={() => view('split')}>Split</Button> : null}
        </div>
        {anyCam && !cams.length ? <div className="tiny dim">No camera has footage across this whole selection.</div> : null}
      </Section>
      <Section title="Add">
        <div className="grid-2">
          {hasScreen ? <Button icon="zoom" onClick={() => addZoom(range)}>Zoom</Button> : null}
          <Button icon="text" onClick={() => (seekSource(project, range.start), addText('plain'))}>Text</Button>
          <Button icon="chat" onClick={() => addOverlay(range, 'callout', 'Callout')}>Callout</Button>
          <Button icon="film" onClick={() => addOverlay(range, 'section-card', 'Section title')}>Section card</Button>
          <Button icon="user" onClick={() => addOverlay(range, 'lower-third', 'Name')}>Lower third</Button>
          <Button icon="mask" onClick={() => (addMask(range, hasScreen ? 'screen' : 'cameraA'), pickTarget('mask'))}>Mask</Button>
        </div>
        {assets.length ? (
          <Field label="B-roll from this project">
            <select className="select" value="" onChange={(e) => e.target.value && addBroll(range, e.target.value)} aria-label="Insert B-roll">
              <option value="">Insert an asset…</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="tiny dim">No B-roll in this project. Add clips or images in Sources and they appear here.</div>
        )}
      </Section>
      <Section title="Ask for a change here">
        <textarea className="textarea" rows={2} placeholder="Less movement in this section" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Instruction for this section" />
        <Button variant="ai" icon="sparkle" disabled={!instruction.trim()} onClick={() => (window.dispatchEvent(new CustomEvent('cutaway-revise', { detail: { range, instruction: instruction.trim() } })), setInstruction(''))}>
          Preview the change
        </Button>
        <div className="tiny dim">Only this range changes. You compare before and after, then accept or discard.</div>
      </Section>
    </>
  );
}

export function SelectionPanel({ pickTarget }: { pickTarget: (what: 'zoom' | 'mask' | 'callout' | null) => void }) {
  const project = useProject();
  const sel = useApp((s) => s.selection);
  const e = project.edit;
  if (!sel) return null;
  if (sel.kind === 'range' || sel.kind === 'words') return <RangeActions project={project} range={sel.range} pickTarget={pickTarget} />;
  if (sel.kind === 'clip') return <ClipEditor id={sel.id} />;
  const del = (
    <Button variant="ghost" size="sm" icon="trash" onClick={removeSelected} aria-label="Remove" title="Remove (⌫)" />
  );
  const lockBtn = (lane: 'layouts' | 'zooms' | 'overlays' | 'broll' | 'cuts', meta: DecisionMeta) => (
    <Button variant="ghost" size="sm" icon={meta.locked ? 'lock' : 'unlock'} on={!!meta.locked} onClick={() => toggleItemLock(lane, sel.id)} aria-label={meta.locked ? 'Unlock' : 'Lock'} title={meta.locked ? 'Locked: AI will not change this' : 'Lock so AI changes leave it alone'} />
  );

  if (sel.kind === 'cut') {
    const c = e.cuts.find((x) => x.id === sel.id);
    if (!c) return null;
    return (
      <Section title={`Cut · ${(c.end - c.start).toFixed(1)}s removed`} action={lockBtn('cuts', c.meta)}>
        <TimesRow project={project} range={c} />
        <Why meta={c.meta} />
        <Button icon="undo" onClick={() => restoreOne(c.id)}>Restore this footage</Button>
        <div className="tiny dim">Restored footage is protected from later AI cleanup.</div>
        {(() => {
          // Punch-in on jump cuts: say what happens at this cut and let the creator leave it out.
          if (!punchInOf(e).enabled) return null;
          const j = punchJoins(project, timeMapOf(project)).find((x) => x.cutIds.includes(c.id));
          if (!j) return null;
          if (!j.qualifies) return <div className="tiny dim" data-testid="cut-punch-why">No punch-in here: {j.why === 'clip' ? 'this cut is on a clip change.' : j.why === 'zoom' ? 'a zoom is active at this cut.' : 'the picture is not one full-frame camera shot on both sides.'}</div>;
          return <Toggle label="Punch in at this cut" hint={j.skipped ? 'Left out: the framing stays as it was.' : j.punched ? 'The shot after this cut is punched in.' : 'The shot after this cut returns to normal framing.'} checked={!j.skipped} onChange={(v) => setCutPunchSkipped(j.cutIds, !v)} />;
        })()}
      </Section>
    );
  }
  if (sel.kind === 'zoom') {
    const z = e.zooms.find((x) => x.id === sel.id);
    if (!z) return null;
    const hasCursor = project.sources.some((s) => s.role === 'screen' && !s.cursorBaked && s.cursorFile);
    return (
      <Section title="Zoom" action={<div className="row gap-2">{lockBtn('zooms', z.meta)}{del}</div>}>
        <TimesRow project={project} range={z} />
        <Field label="Zoom style" hint={{ zoom: 'The whole picture moves in.', magnifier: 'The picture stays put; a round lens enlarges what is under it.', instant: 'Jumps in and out with no animation.' }[z.style ?? 'zoom']}>
          <Segmented full value={z.style ?? 'zoom'} onChange={(v) => patchItem('zooms', z.id, { style: v }, 'Zoom style', false)} options={[{ value: 'zoom', label: 'Zoom in' }, { value: 'magnifier', label: 'Magnifier' }, { value: 'instant', label: 'Instant' }]} />
        </Field>
        <Slider label="Magnification" min={1.1} max={4} step={0.05} value={z.scale} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => patchItem('zooms', z.id, { scale: v }, 'Zoom level')} />
        {z.style === 'magnifier' ? <Slider label="Lens size" min={0.15} max={0.8} step={0.01} value={z.lensSize ?? 0.34} format={pct} onChange={(v) => patchItem('zooms', z.id, { lensSize: v }, 'Lens size')} /> : null}
        <Toggle label="Follow the cursor" hint={hasCursor ? 'The view tracks the recorded pointer.' : 'Only for recordings made in Cutaway; this screen source has no cursor data.'} checked={z.follow && hasCursor} onChange={(v) => hasCursor && patchItem('zooms', z.id, { follow: v }, 'Zoom follow', false)} />
        {!z.follow || !hasCursor ? <Button icon="cursor" onClick={() => pickTarget('zoom')}>Click the preview to set the target</Button> : null}
        <Why meta={z.meta} />
      </Section>
    );
  }
  if (sel.kind === 'layout') {
    const l = e.layouts.find((x) => x.id === sel.id);
    if (!l) return null;
    const cams = camerasFor(project, l);
    const hasScreen = project.sources.some((s) => s.role === 'screen');
    const modes = ([['screen', 'Screen', 'screen'], ['overlay', 'Both', 'layout'], ['camera', 'Camera', 'camera'], ['split', 'Split', 'split'], ['presenter', 'Inset', 'camera']] as const).filter(([m]) => (m === 'camera' ? true : hasScreen)).filter(([m]) => m === 'screen' || cams.length > 0 || m === l.mode);
    return (
      <Section title="View" action={<div className="row gap-2">{lockBtn('layouts', l.meta)}{del}</div>}>
        <TimesRow project={project} range={l} />
        <Segmented full value={l.mode} onChange={(m) => patchItem('layouts', l.id, { mode: m }, 'Change view', false)} options={modes.map(([value, label, icon]) => ({ value, label, icon }))} />
        {l.mode !== 'screen' ? (
          <Field label="Camera angle" hint={cams.length < 2 && project.sources.some((s) => s.role === 'cameraB') ? 'A camera is only offered where it has footage for this whole range.' : undefined}>
            <Segmented full value={l.camera} onChange={(c) => patchItem('layouts', l.id, { camera: c }, 'Change angle', false)} options={[{ value: 'A', label: 'Camera A', disabled: !cams.includes('A') }, { value: 'B', label: 'Camera B', disabled: !cams.includes('B') }]} />
          </Field>
        ) : null}
        <Field label="Transition in">
          <Segmented full value={l.transition} onChange={(t) => patchItem('layouts', l.id, { transition: t }, 'Transition', false)} options={[{ value: 'smooth', label: 'Animated' }, { value: 'cut', label: 'Hard cut' }]} />
        </Field>
        <Why meta={l.meta} />
      </Section>
    );
  }
  if (sel.kind === 'overlay') {
    const o = e.overlays.find((x) => x.id === sel.id);
    if (!o) return null;
    if (o.kind === 'text') return <TextEditor project={project} overlay={o} />;
    return (
      <Section title="Graphic" action={<div className="row gap-2">{lockBtn('overlays', o.meta)}{del}</div>}>
        <TimesRow project={project} range={o} />
        <Segmented full value={o.kind} onChange={(k: GraphicKind) => patchItem('overlays', o.id, { kind: k }, 'Graphic type', false)} options={[{ value: 'callout', label: 'Callout' }, { value: 'section-card', label: 'Section' }, { value: 'lower-third', label: 'Lower third' }]} />
        <Field label="Text">
          <input className="input" value={o.text} maxLength={90} onChange={(ev) => patchItem('overlays', o.id, { text: ev.target.value }, 'Edit text')} />
        </Field>
        {o.kind !== 'callout' ? (
          <Field label="Second line">
            <input className="input" value={o.subtext ?? ''} maxLength={120} onChange={(ev) => patchItem('overlays', o.id, { subtext: ev.target.value || undefined }, 'Edit text')} />
          </Field>
        ) : (
          <Button icon="cursor" onClick={() => pickTarget('callout')}>Click the preview to place it</Button>
        )}
        <Field label="Sound as it appears">
          <CueField value={o.sound ?? null} sources={project.sources} onChange={(cue, coalesce) => setOverlaySound(o.id, cue, coalesce)} />
        </Field>
        <Why meta={o.meta} />
      </Section>
    );
  }
  if (sel.kind === 'music') {
    const clip = musicClipsOf(e, project.sources).find((x) => x.id === sel.id);
    return clip ? <MusicEditor project={project} clip={clip} /> : null;
  }
  if (sel.kind === 'sound') {
    const sound = soundsOf(e).find((x) => x.id === sel.id);
    return sound ? <SoundEditor project={project} sound={sound} /> : null;
  }
  if (sel.kind === 'broll') {
    const b = e.broll.find((x) => x.id === sel.id);
    if (!b) return null;
    const asset = project.sources.find((s) => s.id === b.assetId);
    const assets = project.sources.filter((s) => s.role === 'broll' || s.role === 'image');
    return (
      <Section title="B-roll" action={<div className="row gap-2">{lockBtn('broll', b.meta)}{del}</div>}>
        <TimesRow project={project} range={b} />
        <Field label="Asset">
          <select className="select" value={b.assetId} onChange={(ev) => patchItem('broll', b.id, { assetId: ev.target.value, assetIn: 0 }, 'Replace B-roll', false)}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.available ? '' : ' (missing)'}</option>
            ))}
          </select>
        </Field>
        {asset?.kind === 'video' ? <Slider label="Start inside the clip" min={0} max={Math.max(0.1, asset.duration - (b.end - b.start))} step={0.05} value={Math.min(b.assetIn, Math.max(0, asset.duration - (b.end - b.start)))} format={(v) => fmtTime(v, true)} onChange={(v) => patchItem('broll', b.id, { assetIn: v }, 'Trim B-roll')} /> : null}
        <Field label="Fit">
          <Segmented full value={b.fit} onChange={(f) => patchItem('broll', b.id, { fit: f }, 'B-roll fit', false)} options={[{ value: 'cover', label: 'Fill frame' }, { value: 'contain', label: 'Show all' }]} />
        </Field>
        <Toggle label="Use this clip's sound" hint="Off keeps your narration only." checked={b.useAssetAudio} onChange={(v) => patchItem('broll', b.id, { useAssetAudio: v }, 'B-roll audio', false)} />
        <Slider label="Fade in" min={0} max={BROLL_FADE.max} step={0.05} value={b.fadeIn ?? BROLL_FADE.standard} format={(v) => (v < 0.01 ? 'Hard cut' : `${v.toFixed(2)}s`)} onChange={(v) => patchItem('broll', b.id, { fadeIn: v }, 'B-roll fade in')} />
        <Slider label="Fade out" min={0} max={BROLL_FADE.max} step={0.05} value={b.fadeOut ?? BROLL_FADE.standard} format={(v) => (v < 0.01 ? 'Hard cut' : `${v.toFixed(2)}s`)} onChange={(v) => patchItem('broll', b.id, { fadeOut: v }, 'B-roll fade out')} />
        <div className="why">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Where it came from</div>
          <div className="small">{asset?.name ?? 'Missing asset'}</div>
          <div className="tiny dim">{asset ? `${asset.origin === 'import' ? 'Supplied by you' : 'Recorded in this project'}${asset.license ? ` · ${asset.license}` : ''}` : ''}</div>
          {asset ? <button className="btn ghost sm" style={{ marginTop: 6, padding: 0 }} onClick={() => void window.cutaway.app.reveal(resolveSourcePath(app().projectPath!, asset.path))}><Icon name="folder" size={12} /> Show file</button> : null}
        </div>
        <Why meta={b.meta} />
      </Section>
    );
  }
  if (sel.kind === 'mask') {
    const m = e.masks.find((x) => x.id === sel.id);
    if (!m) return null;
    const setRect = (k: 'x' | 'y' | 'w' | 'h', v: number) => patchItem('masks', m.id, { rect: { ...m.rect, [k]: v } }, 'Resize mask');
    return (
      <Section title="Mask" action={del}>
        <TimesRow project={project} range={m} />
        <Field label="Style">
          <Segmented full value={m.style} onChange={(s) => patchItem('masks', m.id, { style: s }, 'Mask style', false)} options={[{ value: 'blur', label: 'Blur' }, { value: 'solid', label: 'Cover' }, { value: 'highlight', label: 'Spotlight' }]} />
        </Field>
        <Field label="Pinned to">
          <select className="select" value={m.target} onChange={(ev) => patchItem('masks', m.id, { target: ev.target.value as typeof m.target }, 'Mask target', false)}>
            {project.sources.filter((s) => ['screen', 'cameraA', 'cameraB'].includes(s.role)).map((s) => (
              <option key={s.id} value={s.role}>{s.role === 'screen' ? 'Screen' : s.role === 'cameraA' ? 'Camera A' : 'Camera B'}</option>
            ))}
          </select>
        </Field>
        <Button icon="region" onClick={() => pickTarget('mask')}>Drag on the preview to redraw</Button>
        <div className="grid-2">
          <Slider label="Left" min={0} max={1 - m.rect.w} value={m.rect.x} format={pct} onChange={(v) => setRect('x', v)} />
          <Slider label="Top" min={0} max={1 - m.rect.h} value={m.rect.y} format={pct} onChange={(v) => setRect('y', v)} />
          <Slider label="Width" min={0.02} max={1 - m.rect.x} value={m.rect.w} format={pct} onChange={(v) => setRect('w', v)} />
          <Slider label="Height" min={0.02} max={1 - m.rect.y} value={m.rect.h} format={pct} onChange={(v) => setRect('h', v)} />
        </div>
        <div className="tiny dim">The mask is attached to the source picture, so it stays on its target through zooms and view changes, in the preview and in the export.</div>
      </Section>
    );
  }
  if (sel.kind === 'lock') {
    const l = e.locks.find((x) => x.id === sel.id);
    if (!l) return null;
    return (
      <Section title="Locked range" action={del}>
        <TimesRow project={project} range={l} />
        <Field label="Note">
          <input className="input" value={l.note} onChange={(ev) => patchItem('locks', l.id, { note: ev.target.value }, 'Edit note')} />
        </Field>
        <div className="tiny dim">AI cleanup, view changes, zooms and regeneration skip this range. Your own edits still work.</div>
        <Button icon="unlock" onClick={removeSelected}>Unlock</Button>
      </Section>
    );
  }
  if (sel.kind === 'speed') {
    const s = e.speeds.find((x) => x.id === sel.id);
    if (!s) return null;
    return (
      <Section title="Speed" action={del}>
        <TimesRow project={project} range={s} />
        <Slider label="Playback speed" min={0.25} max={8} step={0.05} value={s.speed} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => patchItem('speeds', s.id, { speed: v }, 'Speed')} />
        <div className="tiny dim">Captions and chapters are re-timed automatically. Sound follows the speed, so voices change pitch above about 1.5×.</div>
      </Section>
    );
  }
  return null;
}

