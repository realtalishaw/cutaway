import { useEffect, useRef, useState } from 'react';
import { fmtTime, type Range } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject } from '../state/store';
import { acceptComparison, discardComparison, reviseSection } from '../state/jobs';
import { Preview, type PreviewPoint } from '../engine/Preview';
import { Icon } from '../ui/icons';
import { Banner, Button, Segmented } from '../ui/kit';
import { Timeline } from './editor/Timeline';
import { Transcript } from './editor/Transcript';
import { History, Review } from './editor/Review';
import { Inspector } from './editor/Inspector';
import { cutRange, lockRange, patchItem, playheadSource, removeSelected, seekSource, selectedRange, splitSelected } from './editor/ops';
import './editor/editor.css';

type Pick = 'zoom' | 'mask' | 'callout' | null;

function Timecode() {
  const ref = useRef<HTMLSpanElement>(null);
  const project = useShownProject();
  useEffect(() => {
    const update = () => {
      if (ref.current) ref.current.textContent = fmtTime(usePlayback.getState().time, true);
    };
    update();
    return usePlayback.subscribe(update);
  }, []);
  return (
    <span className="timecode mono">
      <span ref={ref}>0:00.00</span>
      <span className="dim"> / {fmtTime(timeMapOf(project).outDuration, true)}</span>
    </span>
  );
}

function Transport() {
  const playing = usePlayback((s) => s.playing);
  const volume = usePlayback((s) => s.volume);
  const project = useShownProject();
  const jump = (dir: 1 | -1) => {
    const map = timeMapOf(project);
    const t = usePlayback.getState().time;
    // jump between edit points (segment boundaries in output time)
    const points = [0, ...map.segments.map((s) => s.outEnd)];
    const next = dir > 0 ? points.find((p) => p > t + 0.05) : [...points].reverse().find((p) => p < t - 0.25);
    usePlayback.getState().seek(next ?? (dir > 0 ? map.outDuration : 0));
  };
  return (
    <div className="ed-transport">
      <Timecode />
      <div className="grow" />
      <Button variant="ghost" icon="back" onClick={() => jump(-1)} title="Previous edit point" aria-label="Previous edit point" />
      <button className="ed-play" onClick={() => usePlayback.getState().toggle()} aria-label={playing ? 'Pause' : 'Play'} title="Play or pause (Space)">
        <Icon name={playing ? 'pause' : 'play'} size={18} />
      </button>
      <Button variant="ghost" icon="chevron" onClick={() => jump(1)} title="Next edit point" aria-label="Next edit point" />
      <div className="grow" />
      <div className="row" style={{ width: 120, gap: 6 }}>
        <Icon name="speaker" size={14} style={{ color: 'var(--text-3)' }} />
        <input className="slider" type="range" min={0} max={1} step={0.01} value={volume} style={{ ['--p' as string]: `${volume * 100}%` }} onChange={(e) => usePlayback.getState().setVolume(Number(e.target.value))} aria-label="Preview volume" />
      </div>
    </div>
  );
}

function CompareBar() {
  const c = useApp((s) => s.comparison);
  if (!c) return null;
  return (
    <div className="compare-bar" role="region" aria-label="Proposed change">
      <div className="row between">
        <div className="row">
          <span className="pill ai"><Icon name="sparkle" size={10} /> Proposed</span>
          <span style={{ fontWeight: 600 }}>{c.label}</span>
          <span className="tiny dim mono">{fmtTime(c.range.start)} – {fmtTime(c.range.end)}</span>
        </div>
        <div className="row">
          <Segmented value={c.showing} onChange={(v) => useApp.getState().setComparison({ ...c, showing: v })} options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]} label="Compare" />
          <Button onClick={discardComparison}>Discard</Button>
          <Button variant="primary" icon="check" onClick={acceptComparison}>Accept</Button>
        </div>
      </div>
      {c.notes.length ? <div className="tiny muted" style={{ marginTop: 6 }}>{c.notes.join(' · ')}</div> : null}
    </div>
  );
}

export function Editor() {
  const project = useShownProject();
  const selection = useApp((s) => s.selection);
  const comparing = useApp((s) => !!s.comparison);
  const [side, setSide] = useState<'transcript' | 'review' | 'history'>(project.firstCut ? 'review' : 'transcript');
  const [pick, setPick] = useState<Pick>(null);
  const [revising, setRevising] = useState(false);
  const [mark, setMark] = useState<number | null>(null);
  const dragStart = useRef<PreviewPoint | null>(null);
  const openSuggestions = project.edit.suggestions.filter((s) => s.status === 'open').length;

  useEffect(() => {
    const onRevise = (e: Event) => {
      const { range, instruction } = (e as CustomEvent<{ range: Range; instruction: string }>).detail;
      setRevising(true);
      void reviseSection(range, instruction).finally(() => setRevising(false));
    };
    const onCommand = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      const p = useApp.getState().project;
      if (!p) return;
      if (cmd === 'split') {
        if (!splitSelected(p)) useApp.getState().toast('Select a view, zoom, B-roll or speed block to split it at the playhead. To remove footage, mark a range with I and O, then press X.');
      } else if (cmd === 'lock') {
        const r = selectedRange(useApp.getState().selection);
        if (r) lockRange(r);
      } else if (cmd === 'toggle-timeline') useApp.getState().patch((q) => ({ ...q, ui: { ...q.ui, expandedTimeline: !q.ui.expandedTimeline } }));
    };
    window.addEventListener('cutaway-revise', onRevise);
    window.addEventListener('cutaway-command', onCommand);
    return () => {
      window.removeEventListener('cutaway-revise', onRevise);
      window.removeEventListener('cutaway-command', onCommand);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const app = useApp.getState();
      const p = app.project;
      if (!p || app.comparison) return;
      const fps = p.edit.appearance.output.fps;
      const pb = usePlayback.getState();
      switch (e.key) {
        case 'Backspace':
        case 'Delete':
          if (app.selection) (e.preventDefault(), removeSelected());
          break;
        case 'Escape':
          setPick(null);
          app.select(null);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          pb.seek(pb.time - (e.shiftKey ? 1 : 1 / fps));
          break;
        case 'ArrowRight':
          e.preventDefault();
          pb.seek(Math.min(timeMapOf(p).outDuration, pb.time + (e.shiftKey ? 1 : 1 / fps)));
          break;
        case 'i':
        case 'I':
          setMark(playheadSource(p));
          app.toast('In point set. Press O at the end of the range.');
          break;
        case 'o':
        case 'O': {
          const t = playheadSource(p);
          if (mark !== null && Math.abs(t - mark) > 0.05) app.select({ kind: 'range', range: { start: Math.min(mark, t), end: Math.max(mark, t) } });
          break;
        }
        case 'x':
        case 'X': {
          const r = selectedRange(app.selection);
          if (r) cutRange(r);
          break;
        }
        case 'l':
        case 'L': {
          const r = selectedRange(app.selection);
          if (r) lockRange(r);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mark]);

  // direct manipulation on the preview: zoom target, callout position, mask rectangle
  const onPointer = (phase: 'down' | 'move' | 'up', pt: PreviewPoint) => {
    const sel = useApp.getState().selection;
    if (!pick || !sel || !('id' in sel)) return;
    if (pick === 'zoom' && sel.kind === 'zoom' && pt.screen && phase !== 'move') {
      patchItem('zooms', sel.id, { x: Math.min(1, Math.max(0, pt.screen.x)), y: Math.min(1, Math.max(0, pt.screen.y)), follow: false }, 'Set zoom target', false);
      if (phase === 'up') setPick(null);
    } else if (pick === 'callout' && sel.kind === 'overlay') {
      patchItem('overlays', sel.id, { x: pt.x, y: pt.y }, 'Place callout');
      if (phase === 'up') setPick(null);
    } else if (pick === 'mask' && sel.kind === 'mask' && pt.screen) {
      if (phase === 'down') dragStart.current = pt;
      const a = dragStart.current?.screen;
      if (a && phase !== 'down') {
        const x = Math.max(0, Math.min(a.x, pt.screen.x));
        const y = Math.max(0, Math.min(a.y, pt.screen.y));
        const w = Math.min(1 - x, Math.abs(pt.screen.x - a.x));
        const h = Math.min(1 - y, Math.abs(pt.screen.y - a.y));
        if (w > 0.01 && h > 0.01) patchItem('masks', sel.id, { rect: { x, y, w, h }, target: 'screen' }, 'Draw mask');
      }
      if (phase === 'up') {
        dragStart.current = null;
        setPick(null);
      }
    }
  };

  const map = timeMapOf(project);
  const selRange = selectedRange(selection);
  return (
    <div className="editor">
      <aside className="ed-side" aria-label="Transcript and review">
        <div className="side-tabs">
          <Segmented
            full
            value={side}
            onChange={setSide}
            options={[
              { value: 'transcript', label: 'Transcript', icon: 'captions' },
              { value: 'review', label: openSuggestions ? `Review · ${openSuggestions}` : 'Review', icon: 'sparkle' },
              { value: 'history', label: 'History', icon: 'history' },
            ]}
          />
        </div>
        {side === 'transcript' ? <Transcript /> : side === 'review' ? <Review /> : <History />}
      </aside>

      <section className="ed-stage">
        {!project.firstCut && !comparing ? (
          <div className="stage-note">
            <Banner icon="sparkle" title="You are looking at the raw recording" action={<Button size="sm" variant="ai" icon="sparkle" onClick={() => useApp.getState().setView('brief')}>Create first cut</Button>}>
              Everything here already works by hand. The first cut adds cleanup, views, zooms and graphics you can then correct.
            </Banner>
          </div>
        ) : null}
        <CompareBar />
        <div className="stage-preview">
          <Preview onPointer={pick ? onPointer : undefined} cursorStyle={pick ? 'crosshair' : undefined} selectedMaskId={selection?.kind === 'mask' ? selection.id : null} />
          {pick ? (
            <div className="pick-hint">
              <Icon name={pick === 'mask' ? 'region' : 'cursor'} size={13} />
              {pick === 'mask' ? 'Drag a rectangle over what to hide' : pick === 'zoom' ? 'Click the point to zoom into' : 'Click where the callout should sit'}
              <button className="btn ghost sm" onClick={() => setPick(null)}>Done</button>
            </div>
          ) : null}
          {revising ? (
            <div className="pick-hint">
              <span className="spinner" /> Working out the change for this section…
            </div>
          ) : null}
        </div>
        <Transport />
        <div className="stage-status tiny dim">
          {selRange ? (
            <span className="row gap-2">
              <Icon name="region" size={12} /> Range {fmtTime(selRange.start, true)} – {fmtTime(selRange.end, true)} selected. <span className="kbd">X</span> cut <span className="kbd">L</span> keep <span className="kbd">Esc</span> clear
            </span>
          ) : (
            <span className="row gap-2">
              <span className="kbd">Space</span> play <span className="kbd">I</span>
              <span className="kbd">O</span> mark a range <span className="kbd">←</span>
              <span className="kbd">→</span> step a frame · drag on Footage to select
            </span>
          )}
          <span className="mono">
            {project.edit.appearance.output.width}×{project.edit.appearance.output.height} · {project.edit.appearance.output.fps} fps · {fmtTime(map.outDuration)}
          </span>
        </div>
      </section>

      <Inspector pickTarget={setPick} />
      <div className="editor-timeline">
        <Timeline />
      </div>
      <button className="sr-only" onClick={() => seekSource(project, 0)}>Go to start</button>
    </div>
  );
}
