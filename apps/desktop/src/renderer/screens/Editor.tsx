import { useEffect, useRef, useState } from 'react';
import { fmtTime, type Range } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject } from '../state/store';
import { acceptComparison, discardComparison, reviseSection } from '../state/jobs';
import { Preview, type PreviewPoint } from '../engine/Preview';
import { Icon } from '../ui/icons';
import { Button, Segmented, Slider } from '../ui/kit';
import { Timeline } from './editor/Timeline';
import { Inspector } from './editor/Inspector';
import { addMask, addOverlay, addZoom, cutRange, lockRange, patchItem, playheadSource, removeSelected, seekSource, selectedRange, setLayout, splitSelected } from './editor/ops';
import './editor/editor.css';

type Pick = 'zoom' | 'mask' | 'callout' | null;

function Timecode({ total }: { total?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const project = useShownProject();
  useEffect(() => {
    if (total) return;
    const update = () => {
      if (ref.current) ref.current.textContent = fmtTime(usePlayback.getState().time, true);
    };
    update();
    return usePlayback.subscribe(update);
  }, [total]);
  if (total) return <span className="timecode mono dim">{fmtTime(timeMapOf(project).outDuration, true)}</span>;
  return (
    <span className="timecode mono dim" ref={ref}>
      0:00.00
    </span>
  );
}

export const ASPECTS: { id: string; label: string; ratio: string; w: number; h: number }[] = [
  { id: 'wide', label: 'Wide', ratio: '16:9', w: 16, h: 9 },
  { id: 'vertical', label: 'Vertical', ratio: '9:16', w: 9, h: 16 },
  { id: 'square', label: 'Square', ratio: '1:1', w: 1, h: 1 },
  { id: 'classic', label: 'Classic', ratio: '4:3', w: 4, h: 3 },
  { id: 'tall', label: 'Tall', ratio: '4:5', w: 4, h: 5 },
];

export function aspectOf(width: number, height: number) {
  return ASPECTS.find((a) => Math.abs(a.w / a.h - width / height) < 0.01) ?? ASPECTS[0]!;
}

/** Output size for an aspect, keeping the current quality tier (1080 or 2160 on the short side). */
export function sizeFor(aspect: (typeof ASPECTS)[number], current: { width: number; height: number }) {
  const short = Math.min(current.width, current.height) >= 2000 ? 2160 : 1080;
  const even = (n: number) => Math.round(n / 2) * 2;
  return aspect.w >= aspect.h ? { width: even((short * aspect.w) / aspect.h), height: short } : { width: short, height: even((short * aspect.h) / aspect.w) };
}

function AspectMenu() {
  const project = useShownProject();
  const [open, setOpen] = useState(false);
  const out = project.edit.appearance.output;
  const cur = aspectOf(out.width, out.height);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Output shape">
        <Icon name="aspect" size={16} /> {cur.label} <span className="dim">{cur.ratio}</span> <Icon name="chevronDown" size={13} style={{ color: 'var(--text-3)' }} />
      </button>
      {open ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 290 }} onMouseDown={() => setOpen(false)} />
          <div className="menu" style={{ position: 'absolute', left: 0, bottom: 40, minWidth: 220 }} role="menu">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                role="menuitemradio"
                aria-checked={a.id === cur.id}
                onClick={() => {
                  setOpen(false);
                  useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, output: { ...e.appearance.output, ...sizeFor(a, e.appearance.output) } } }), `Shape ${a.ratio}`);
                }}
              >
                <i className="aspect-chip" style={{ aspectRatio: `${a.w} / ${a.h}` }} />
                {a.label} <span className="dim">{a.ratio}</span>
                {a.id === cur.id ? <Icon name="check" size={13} style={{ marginLeft: 'auto', color: 'var(--accent-2)' }} /> : null}
              </button>
            ))}
            <div className="sep" />
            <div className="tiny dim" style={{ padding: '4px 10px 6px' }}>YouTube packages use Wide 16:9. Other shapes export the video only.</div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function CropPopover() {
  const project = useShownProject();
  const [open, setOpen] = useState(false);
  const crop = project.edit.appearance.crop;
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const set = (patch: Partial<typeof crop>) => useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, crop: { ...e.appearance.crop, ...patch } } }), 'Crop', 'look:crop');
  const cropped = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1;
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div style={{ position: 'relative' }}>
      <button className={`btn${cropped ? ' on' : ''}`} disabled={!hasScreen} onClick={() => setOpen(!open)} aria-expanded={open} title="Crop the recording">
        <Icon name="crop" size={16} /> Crop
      </button>
      {open ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 290 }} onMouseDown={() => setOpen(false)} />
          <div className="menu crop-pop" style={{ position: 'absolute', left: 0, bottom: 40 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="insp-heading">Crop the recording</span>
              <button className="reset-link" disabled={!cropped} onClick={() => set({ x: 0, y: 0, w: 1, h: 1 })}>Reset</button>
            </div>
            <div className="grid-2">
              <Slider label="Left" min={0} max={0.45} value={crop.x} format={pc} onChange={(v) => set({ x: v, w: Math.min(crop.w, 1 - v) })} />
              <Slider label="Top" min={0} max={0.45} value={crop.y} format={pc} onChange={(v) => set({ y: v, h: Math.min(crop.h, 1 - v) })} />
              <Slider label="Width" min={0.2} max={1 - crop.x} value={crop.w} format={pc} onChange={(v) => set({ w: v })} />
              <Slider label="Height" min={0.2} max={1 - crop.y} value={crop.h} format={pc} onChange={(v) => set({ h: v })} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TopControls() {
  const project = useShownProject();
  const expanded = project.ui.expandedTimeline;
  return (
    <div className="ed-top">
      <div className="row" style={{ gap: 8 }}>
        <AspectMenu />
        <CropPopover />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className={`btn${expanded ? ' on' : ''}`} onClick={() => useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: !p.ui.expandedTimeline } }))} title="Show or hide the layout, graphics and mask timelines (⌘T)" aria-pressed={expanded}>
          {expanded ? '3 visible timelines' : '1 visible timeline'} <Icon name="chevronDown" size={13} style={{ color: 'var(--text-3)' }} />
        </button>
      </div>
    </div>
  );
}

/** Floating tool pill on the left edge of the stage: add a zoom, a camera layout or a mask at the playhead. */
function PreviewToolbar({ pickMask }: { pickMask(): void }) {
  const project = useShownProject();
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const hasCam = project.sources.some((s) => s.role === 'cameraA' || s.role === 'cameraB');
  const range = (len: number) => {
    const t = playheadSource(project);
    return { start: t, end: Math.min(project.duration, t + len) };
  };
  const tool = (icon: Parameters<typeof Icon>[0]['name'], label: string, run: () => void) => (
    <button key={label} className="tbtn" title={label} aria-label={label} onClick={run}>
      <Icon name={icon} size={19} />
    </button>
  );
  const groups = [
    hasScreen ? [tool('zoom', 'Add zoom at the playhead', () => addZoom(range(3)))] : [],
    hasCam
      ? [
          tool('camera', 'Fullscreen camera from the playhead', () => setLayout(range(4), 'camera')),
          ...(hasScreen ? [tool('split', 'Split screen from the playhead', () => setLayout(range(4), 'split')), tool('layout', 'Camera overlay from the playhead', () => setLayout(range(4), 'overlay')), tool('screen', 'Screen only from the playhead', () => setLayout(range(4), 'screen'))] : []),
        ]
      : [],
    hasScreen
      ? [
          tool('mask', 'Hide sensitive content: drag over it on the preview', () => (addMask(range(5), 'screen'), pickMask())),
          tool('text', 'Add a callout at the playhead', () => addOverlay(range(4), 'callout', 'Callout')),
        ]
      : [],
  ].filter((g) => g.length);
  if (!groups.length) return null;
  return (
    <div className="ed-tools" role="toolbar" aria-label="Add to the video">
      {groups.map((g, i) => (
        <div key={i} className="ed-tools-group">
          {g}
        </div>
      ))}
    </div>
  );
}

function Transport({ zoom, onZoom, onScissors, cutting }: { zoom: number; onZoom(z: number): void; onScissors(): void; cutting: boolean }) {
  const playing = usePlayback((s) => s.playing);
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
    <div className="ed-controls">
      <div className="row">
        <button className={`tbtn${cutting ? ' on' : ''}`} onClick={onScissors} title="Cut: removes the selected range, or marks in and out points at the playhead" aria-label="Cut" aria-pressed={cutting}><Icon name="scissors" size={19} /></button>
      </div>
      <div className="row ed-transport">
        <Timecode />
        <button className="tbtn" onClick={() => jump(-1)} title="Previous edit point" aria-label="Previous edit point"><Icon name="skipBack" size={20} /></button>
        <button className="tbtn play" onClick={() => usePlayback.getState().toggle()} aria-label={playing ? 'Pause' : 'Play'} title="Play or pause (Space)"><Icon name={playing ? 'pauseCircle' : 'playCircle'} size={26} /></button>
        <button className="tbtn" onClick={() => jump(1)} title="Next edit point" aria-label="Next edit point"><Icon name="skipFwd" size={20} /></button>
        <Timecode total />
      </div>
      <div className="row ed-controls-right">
        <Icon name="width" size={16} style={{ color: 'var(--text-3)' }} />
        <input className="slider grey" style={{ width: 110, ['--p' as string]: `${zoom * 100}%` }} type="range" min={0} max={1} step={0.01} value={zoom} onChange={(e) => onZoom(Number(e.target.value))} aria-label="Timeline zoom" title="Timeline zoom" />
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
  const inspector = useApp((s) => s.panels.inspector);
  const [zoom, setZoom] = useState(0);
  const [pick, setPick] = useState<Pick>(null);
  const [revising, setRevising] = useState(false);
  const [mark, setMark] = useState<number | null>(null);
  const dragStart = useRef<PreviewPoint | null>(null);

  // Keep the library card's poster current: grab the preview when leaving the editor.
  useEffect(
    () => () => {
      const canvas = document.querySelector<HTMLCanvasElement>('.preview-canvas');
      const path = useApp.getState().projectPath;
      if (!canvas || !path || canvas.width < 16) return;
      try {
        const small = document.createElement('canvas');
        small.width = 640;
        small.height = Math.round((640 * canvas.height) / canvas.width);
        small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
        small.toBlob((blob) => blob && void blob.arrayBuffer().then((b) => window.cutaway.library.savePoster(path, new Uint8Array(b)).catch(() => {})), 'image/jpeg', 0.82);
      } catch {
        /* a poster is a nicety; never block navigation on it */
      }
    },
    [],
  );

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
      const app = useApp.getState();
      const p = app.project;
      if (!p || app.comparison) return;
      // ⌃L camera, ⌃S screen, ⌃B both: add a layout at the playhead
      if (e.ctrlKey && !e.metaKey && !e.altKey && ['l', 's', 'b'].includes(e.key.toLowerCase())) {
        const t = playheadSource(p);
        const r = selectedRange(app.selection) ?? { start: t, end: Math.min(p.duration, t + 4) };
        const hasCam = p.sources.some((x) => x.role === 'cameraA' || x.role === 'cameraB');
        const hasScreen = p.sources.some((x) => x.role === 'screen');
        const mode = e.key.toLowerCase() === 'l' ? 'camera' : e.key.toLowerCase() === 's' ? 'screen' : 'overlay';
        if ((mode !== 'screen' && !hasCam) || (mode !== 'camera' && !hasScreen)) return;
        e.preventDefault();
        return setLayout(r, mode);
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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

  const selRange = selectedRange(selection);
  const scissors = () => {
    const app = useApp.getState();
    const p = app.project;
    if (!p || app.comparison) return;
    const r = selectedRange(app.selection);
    if (r) return cutRange(r, app.selection?.kind === 'words' ? 'transcript' : 'manual');
    if (splitSelected(p)) return;
    const t = playheadSource(p);
    if (mark === null) {
      setMark(t);
      app.toast('In point set at the playhead. Move the playhead and press the scissors again to select the range to cut.');
    } else {
      if (Math.abs(t - mark) > 0.05) app.select({ kind: 'range', range: { start: Math.min(mark, t), end: Math.max(mark, t) } });
      setMark(null);
    }
  };
  return (
    <div className={`editor${inspector ? '' : ' no-inspector'}`}>
      <section className="ed-stage">
        <TopControls />
        {!project.firstCut && !comparing ? (
          <div className="stage-note">
            <span className="row" style={{ gap: 8 }}>
              <Icon name="sparkle" size={14} style={{ color: 'var(--accent-2)' }} />
              <span className="muted">This is the raw recording. Edit by hand, or let Cutaway assemble a first cut.</span>
            </span>
            <Button size="sm" onClick={() => useApp.getState().setView('brief')}>Create first cut</Button>
          </div>
        ) : null}
        <CompareBar />
        <div className="stage-preview">
          {!comparing ? <PreviewToolbar pickMask={() => setPick('mask')} /> : null}
          <Preview onPointer={pick ? onPointer : undefined} cursorStyle={pick ? 'crosshair' : undefined} selectedMaskId={selection?.kind === 'mask' ? selection.id : null} />
          {pick ? (
            <div className="pick-hint">
              {pick === 'mask' ? 'Drag to select the area for the new mask' : pick === 'zoom' ? 'Click the point to zoom into' : 'Click where the callout should sit'}
              <button className="btn ghost sm" onClick={() => setPick(null)}>Done</button>
            </div>
          ) : null}
          {revising ? (
            <div className="pick-hint">
              <span className="spinner" /> Working out the change for this section…
            </div>
          ) : null}
          {selRange && !pick ? (
            <div className="pick-hint">
              {fmtTime(selRange.start, true)} – {fmtTime(selRange.end, true)} selected
              <button className="btn sm" onClick={() => cutRange(selRange)}><Icon name="scissors" size={12} /> Cut</button>
              <button className="btn ghost sm" onClick={() => lockRange(selRange)}><Icon name="lock" size={12} /> Keep</button>
            </div>
          ) : null}
        </div>
        <Transport zoom={zoom} onZoom={setZoom} onScissors={scissors} cutting={mark !== null} />
      </section>

      {inspector ? <Inspector pickTarget={setPick} /> : null}
      <div className="editor-timeline">
        <Timeline zoom={zoom} onZoom={setZoom} />
      </div>
      <button className="sr-only" onClick={() => seekSource(project, 0)}>Go to start</button>
    </div>
  );
}
