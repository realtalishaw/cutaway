import { useEffect, useRef, useState } from 'react';
import { clipsOf as clipsOfProject, flagsOf, fmtTime, playingClips, type Overlay, type Project, type Range, type Rect } from '@cutaway/core';
import { readOnly, selectedItems, timeMapOf, useApp, usePlayback, useShownProject, viewedProject } from '../state/store';
import { acceptComparison, discardComparison, reviseSection } from '../state/jobs';
import { Preview, type PreviewPoint } from '../engine/Preview';
import { Icon } from '../ui/icons';
import { Button, Segmented } from '../ui/kit';
import { Timeline } from './editor/Timeline';
import { Inspector } from './editor/Inspector';
import { CropSheet } from './editor/CropSheet';
import { SensitiveSheet } from './editor/SensitiveSheet';
import { commandForEvent } from '../state/keymap';
import { stepVersion } from '../state/chat';
import { addMask, addOverlay, addZoom, cutRange, lockRange, patchItem, playheadSource, removeSelected, seekSource, selectedRange, setLayout, splitSelected, switchCamera } from './editor/ops';
import { moveClipTo, splitClipAtPlayhead } from './editor/clipOps';
import { SelectionBar } from './editor/SelectionBar';
import { setMotionBox } from '../motion/actions';
import { addText, splitMusicAtPlayhead } from './editor/titleSoundOps';
import { CLIPBOARD_TYPE, copyItems, duplicateSelected, hasCopied, nudgeSelected, pasteItems, removeItems, setCopied, type Copied } from './editor/itemOps';
import { layoutText, measuringContext } from '../engine/textOverlay';
import './editor/editor.css';

type Pick = 'zoom' | 'mask' | 'callout' | 'motion-box' | null;

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

function CropButton({ onOpen }: { onOpen(): void }) {
  const project = useShownProject();
  const crop = project.edit.appearance.crop;
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const cropped = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1;
  return (
    <button className={`btn${cropped ? ' on' : ''}`} disabled={!hasScreen} onClick={onOpen} aria-haspopup="dialog" title="Crop the recording" data-testid="crop-open">
      <Icon name="crop" size={16} /> Crop
    </button>
  );
}

function TopControls({ onCrop }: { onCrop(): void }) {
  const project = useShownProject();
  const expanded = project.ui.expandedTimeline;
  return (
    <div className="ed-top">
      <div className="row" style={{ gap: 8 }}>
        <AspectMenu />
        <CropButton onOpen={onCrop} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        {project.ui.advancedTimeline ? <button className={`btn${expanded ? ' on' : ''}`} onClick={() => useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: !p.ui.expandedTimeline } }))} title="Show or hide the layout, graphics and mask timelines (⌘T)" aria-pressed={expanded}>
          {expanded ? '3 visible timelines' : '1 visible timeline'} <Icon name="chevronDown" size={13} style={{ color: 'var(--text-3)' }} />
        </button> : null}
      </div>
    </div>
  );
}

/** Floating tool pill on the left edge of the stage: add a zoom, a camera layout or a mask at the playhead. */
/**
 * The "Add" toolbar on the left of the preview: things to put in the video at the playhead. (The bar on the right
 * opens settings panels.) Every button is labelled, and the view choices sit in one menu.
 */
function PreviewToolbar({ pickMask, findSensitive }: { pickMask(): void; findSensitive(): void }) {
  const project = useShownProject();
  const [menu, setMenu] = useState<'view' | 'hide' | null>(null);
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const hasCam = project.sources.some((s) => s.role === 'cameraA' || s.role === 'cameraB');
  const twoCams = project.sources.some((s) => s.role === 'cameraA') && project.sources.some((s) => s.role === 'cameraB');
  const range = (len: number) => {
    const t = playheadSource(project);
    return { start: t, end: Math.min(project.duration, t + len) };
  };
  const tool = (icon: Parameters<typeof Icon>[0]['name'], short: string, label: string, run: () => void, opts: { menu?: 'view' | 'hide'; testId?: string } = {}) => (
    <button
      key={short}
      className={`tbtn labelled${opts.menu && menu === opts.menu ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-haspopup={opts.menu ? 'menu' : undefined}
      aria-expanded={opts.menu ? menu === opts.menu : undefined}
      data-testid={opts.testId}
      onClick={opts.menu ? () => setMenu(menu === opts.menu ? null : opts.menu!) : () => (setMenu(null), run())}
    >
      <Icon name={icon} size={18} />
      <span>{short}</span>
    </button>
  );
  const item = (icon: Parameters<typeof Icon>[0]['name'], text: string, label: string, run: () => void, hint?: string) => (
    <button key={text} className="menu-item" role="menuitem" aria-label={label} title={label} onClick={() => (setMenu(null), run())}>
      <Icon name={icon} size={15} />
      <span className="grow">{text}</span>
      {hint ? <span className="dim tiny mono">{hint}</span> : null}
    </button>
  );
  const buttons = [
    hasScreen ? tool('zoom', 'Zoom', 'Add zoom at the playhead', () => addZoom(range(3))) : null,
    hasCam ? tool('layout', 'View', 'Change what shows from the playhead: camera, split, screen…', () => undefined, { menu: 'view', testId: 'tools-view' }) : null,
    hasScreen ? tool('mask', 'Hide', 'Hide private things: blur an area, or find emails, keys and passwords', () => undefined, { menu: 'hide', testId: 'tools-hide' }) : null,
    hasScreen ? tool('chat', 'Callout', 'Add a callout at the playhead', () => addOverlay(range(4), 'callout', 'Callout')) : null,
    tool('text', 'Text', 'Add text at the playhead (T). Titles and lower thirds are in the Text tab.', () => addText('plain')),
  ].filter(Boolean);
  return (
    <div className="ed-tools" role="toolbar" aria-label="Add to the video at the playhead">
      <div className="ed-tools-head">Add</div>
      {buttons}
      {menu ? <div className="rb-veil" onMouseDown={() => setMenu(null)} /> : null}
      {menu === 'view' ? (
        <div className="menu ed-tools-menu" role="menu" data-testid="tools-view-menu">
          <div className="menu-head">Show from the playhead, for 4 seconds</div>
          {item('camera', 'Camera only', 'Fullscreen camera from the playhead', () => setLayout(range(4), 'camera'), '⌃L')}
          {hasScreen ? item('layout', 'Screen + camera', 'Camera overlay from the playhead', () => setLayout(range(4), 'overlay'), '⌃B') : null}
          {hasScreen ? item('split', 'Split screen', 'Split screen from the playhead', () => setLayout(range(4), 'split')) : null}
          {hasScreen ? item('screen', 'Screen only', 'Screen only from the playhead', () => setLayout(range(4), 'screen'), '⌃S') : null}
          {twoCams ? item('sync', 'Other camera (A ↔ B)', 'Show the other camera (A or B) from the playhead (Ctrl+A)', () => void switchCamera(range(4)), '⌃A') : null}
        </div>
      ) : null}
      {menu === 'hide' ? (
        <div className="menu ed-tools-menu hide" role="menu" data-testid="tools-hide-menu">
          {item('mask', 'Blur an area', 'Hide sensitive content: drag over it on the preview', () => (addMask(range(5), 'screen'), pickMask()))}
          {item('shield', 'Find private info', 'Find sensitive data: emails, keys, card numbers, passwords', findSensitive)}
        </div>
      ) : null}
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
        <label className="tl-mode" title="Advanced shows every lane: views and layouts, masks, speed changes and sound effects. Simple shows text & effects, video and audio.">
          <button
            className="toggle"
            role="switch"
            aria-checked={!!project.ui.advancedTimeline}
            aria-label="Advanced timeline"
            data-testid="timeline-advanced"
            onClick={() => useApp.getState().patch((q) => ({ ...q, ui: { ...q.ui, advancedTimeline: !q.ui.advancedTimeline } }))}
          />
          Advanced
        </label>
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

/** Keys that still work while an earlier version is being looked at: they only move the playhead. */
const VIEW_ONLY_KEYS = new Set(['frame-back', 'frame-forward', 'second-back', 'second-forward', 'flag-prev', 'flag-next', 'version-prev', 'version-next']);

/** Shown while an earlier checkpoint is on screen. Looking changes nothing; restoring is one undoable step. */
function VersionBar() {
  const v = useApp((s) => s.viewing);
  const rec = useApp((s) => (s.viewing && s.project ? (s.project.revisions.find((r) => r.revision === s.viewing!.revision && r.label === s.viewing!.label) ?? s.project.revisions.find((r) => r.revision === s.viewing!.revision) ?? null) : null));
  const isLatest = useApp((s) => !!s.viewing && s.project?.revision === s.viewing.revision);
  if (!v) return null;
  const app = () => useApp.getState();
  return (
    <div className="compare-bar version-bar" role="region" aria-label="Viewing an earlier version" data-testid="version-bar">
      <div className="row between">
        <div className="row" style={{ minWidth: 0 }}>
          <span className="pill"><Icon name="history" size={10} /> {v.showing === 'version' ? 'Viewing a version' : 'Latest, for comparison'}</span>
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid="version-label">{v.label}</span>
          {rec ? <span className="tiny dim">{new Date(rec.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> : null}
        </div>
        <div className="row">
          {isLatest ? (
            <span className="tiny dim">This is the edit you have now.</span>
          ) : (
            <Segmented value={v.showing} onChange={(side) => app().showViewing(side)} options={[{ value: 'version', label: 'This version' }, { value: 'latest', label: 'Latest' }]} label="Compare with latest" />
          )}
          <Button onClick={() => app().exitViewing()} data-testid="version-back">Back to latest</Button>
          {isLatest ? null : (
            <Button variant="primary" icon="history" onClick={() => app().restoreViewed()} data-testid="version-restore">Restore this version</Button>
          )}
        </div>
      </div>
      <div className="tiny muted" style={{ marginTop: 6 }}>Nothing is changed by looking. Play it, scrub it, open the panels. Editing is off until you go back or restore.</div>
    </div>
  );
}

/** Move the playhead to the next or previous recording flag that is still in the video. */
function jumpFlag(dir: 1 | -1) {
  const app = useApp.getState();
  const p = viewedProject(app) ?? app.project;
  if (!p) return;
  const flags = flagsOf(p);
  if (!flags.length) return app.toast('This recording has no flags. Press the flag shortcut while recording to mark a moment.');
  const map = timeMapOf(p);
  const now = usePlayback.getState().time;
  // Compare in output time, so a flag inside a cut is not a place the playhead gets stuck on.
  const outs = flags.map((f) => map.toOutput(f.t)).sort((a, b) => a - b);
  const target = dir > 0 ? outs.find((t) => t > now + 0.03) : [...outs].reverse().find((t) => t < now - 0.03);
  if (target === undefined) return app.toast(dir > 0 ? 'No flag after this point.' : 'No flag before this point.');
  usePlayback.getState().setPlaying(false);
  usePlayback.getState().seek(target);
}

/** The frame-size anchor a text really ends up at: a drag past the safe margin stops at it, so there is no dead zone on the way back. */
function settledAnchor(p: Project, o: Overlay): { x: number; y: number } {
  const { width: W, height: H } = p.edit.appearance.output;
  const L = layoutText(measuringContext(), o, W, H);
  const x = L.style.align === 'left' ? L.block.x : L.style.align === 'right' ? L.block.x + L.block.w : L.block.x + L.block.w / 2;
  return { x: x / W, y: (L.block.y + L.block.h / 2) / H };
}

/** The free text under a point of the preview at the playhead (the one drawn last wins). */
/** A boxed animation showing at the playhead whose box holds the point (the selected one first). */
function motionBoxAt(p: Project, pt: PreviewPoint, selectedId: string | null): Overlay | null {
  const t = timeMapOf(p).toSource(usePlayback.getState().time);
  const inside = p.edit.overlays.filter((o) => {
    const b = o.motion?.box;
    return !!b && t >= o.start && t < o.end && pt.x >= b.x - 0.01 && pt.x <= b.x + b.w + 0.01 && pt.y >= b.y - 0.01 && pt.y <= b.y + b.h + 0.01;
  });
  return inside.find((o) => o.id === selectedId) ?? inside[inside.length - 1] ?? null;
}

function textAt(p: Project, pt: PreviewPoint): Overlay | null {
  const { width: W, height: H } = p.edit.appearance.output;
  const t = playheadSource(p);
  const pad = Math.min(W, H) * 0.015;
  for (const o of [...p.edit.overlays].reverse()) {
    if (o.kind !== 'text' || t < o.start || t >= o.end) continue;
    const b = layoutText(measuringContext(), o, W, H).block;
    if (pt.x * W >= b.x - pad && pt.x * W <= b.x + b.w + pad && pt.y * H >= b.y - pad && pt.y * H <= b.y + b.h + pad) return o;
  }
  return null;
}

export function Editor() {
  const project = useShownProject();
  const selection = useApp((s) => s.selection);
  const comparing = useApp(readOnly);
  const inspector = useApp((s) => s.panels.inspector);
  const [zoom, setZoom] = useState(0);
  const [pick, setPick] = useState<Pick>(null);
  const textSelected = selection?.kind === 'overlay' && project.edit.overlays.some((o) => o.id === selection.id && o.kind === 'text');
  const boxSelected = selection?.kind === 'overlay' && project.edit.overlays.some((o) => o.id === selection.id && !!o.motion?.box);
  const [revising, setRevising] = useState(false);
  const [mark, setMark] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'crop' | 'sensitive' | null>(null);
  const dragStart = useRef<PreviewPoint | null>(null);
  const boxDrag = useRef<{ id: string; from: PreviewPoint; box: Rect; resize: boolean } | null>(null);
  const textDrag = useRef<{ id: string; dx: number; dy: number } | null>(null);

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
        // a selected block is split; otherwise the clip under the playhead is
        const sel = useApp.getState().selection;
        const block = !!sel && ['layout', 'zoom', 'broll', 'speed', 'music', 'overlay', 'mask'].includes(sel.kind);
        const done = sel?.kind === 'music' ? splitMusicAtPlayhead(sel.id) : splitSelected(p);
        if (!done && (block || !splitClipAtPlayhead(p))) useApp.getState().toast(block ? 'Move the playhead inside the selected block to split it there.' : 'Move the playhead inside a clip to split it there. To remove footage, mark a range with I and O, then press X.');
      } else if (cmd === 'lock') {
        const r = selectedRange(useApp.getState().selection);
        if (r) lockRange(r);
      } else if (cmd === 'toggle-timeline') useApp.getState().patch((q) => ({ ...q, ui: { ...q.ui, expandedTimeline: !q.ui.expandedTimeline } }));
      else if (cmd === 'flag-next' || cmd === 'flag-prev') jumpFlag(cmd === 'flag-next' ? 1 : -1);
      else if (cmd === 'version-prev' || cmd === 'version-next') stepVersion(cmd === 'version-next' ? 1 : -1);
      else if (cmd === 'crop' && p.sources.some((x) => x.role === 'screen')) setSheet('crop');
      else if (cmd === 'find-sensitive' && p.sources.some((x) => x.role === 'screen')) setSheet('sensitive');
      else if (cmd === 'add-text') addText('plain');
      else if (cmd === 'duplicate' && !readOnly(useApp.getState())) {
        if (!duplicateSelected()) useApp.getState().toast('Select one or more blocks on the timeline to duplicate them.');
      }
    };
    // Copy, cut and paste arrive from the Edit menu as the page's own clipboard events. While a text field
    // has focus they are left to it; otherwise they act on the blocks selected on the timeline.
    const typing = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (typing() || document.querySelector('.scrim, .qs')) return;
      const st = useApp.getState();
      const refs = selectedItems(st);
      if (!refs.length) return;
      const copied = copyItems(refs);
      if (!copied.length) return;
      e.preventDefault();
      e.clipboardData?.setData(CLIPBOARD_TYPE, JSON.stringify(copied));
      e.clipboardData?.setData('text/plain', `${copied.length} Cutaway ${copied.length === 1 ? 'block' : 'blocks'}`);
      if (e.type === 'cut' && !readOnly(st)) removeItems(refs);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing() || document.querySelector('.scrim, .qs') || readOnly(useApp.getState())) return;
      const raw = e.clipboardData?.getData(CLIPBOARD_TYPE);
      let items: Copied[] | null = null;
      try {
        items = raw ? (JSON.parse(raw) as Copied[]) : null;
      } catch {
        items = null;
      }
      if (items?.length) setCopied(items);
      else if (!hasCopied()) return;
      e.preventDefault();
      pasteItems();
    };
    window.addEventListener('cutaway-revise', onRevise);
    window.addEventListener('cutaway-command', onCommand);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('cutaway-revise', onRevise);
      window.removeEventListener('cutaway-command', onCommand);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const app = useApp.getState();
      // While an earlier version is on screen, the keys move around in that version and change nothing.
      const p = viewedProject(app) ?? app.project;
      // A sheet or the command menu on top owns the keyboard.
      if (!p || app.comparison || document.querySelector('.scrim, .qs')) return;
      if (e.key === 'Escape') {
        setPick(null);
        if (app.viewing) app.exitViewing();
        else app.select(null);
        return;
      }
      // Bindings come from the keymap, so shortcuts changed in Settings apply here. ⌦ always removes, like ⌫.
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      const cmd = commandForEvent(e) ?? (e.key === 'Delete' && plain ? 'delete' : null);
      if (!cmd) return;
      if (app.viewing && !VIEW_ONLY_KEYS.has(cmd)) return;
      const fps = p.edit.appearance.output.fps;
      const pb = usePlayback.getState();
      const step = (seconds: number) => (e.preventDefault(), pb.seek(Math.max(0, Math.min(timeMapOf(p).outDuration, pb.time + seconds))));
      switch (cmd) {
        case 'layout-camera':
        case 'layout-screen':
        case 'layout-both': {
          const t = playheadSource(p);
          const r = selectedRange(app.selection) ?? { start: t, end: Math.min(p.duration, t + 4) };
          const hasCam = p.sources.some((x) => x.role === 'cameraA' || x.role === 'cameraB');
          const hasScreen = p.sources.some((x) => x.role === 'screen');
          const mode = cmd === 'layout-camera' ? 'camera' : cmd === 'layout-screen' ? 'screen' : 'overlay';
          if ((mode !== 'screen' && !hasCam) || (mode !== 'camera' && !hasScreen)) return;
          e.preventDefault();
          return setLayout(r, mode);
        }
        case 'switch-camera': {
          const t = playheadSource(p);
          const r = selectedRange(app.selection) ?? { start: t, end: Math.min(p.duration, t + 4) };
          if (switchCamera(r)) e.preventDefault();
          break;
        }
        case 'delete':
          if (app.selection) (e.preventDefault(), removeSelected());
          break;
        case 'split-key':
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'split' }));
          break;
        case 'nudge-back':
        case 'nudge-forward':
        case 'nudge-back-more':
        case 'nudge-forward-more': {
          const dir = cmd.startsWith('nudge-back') ? -1 : 1;
          // a selected clip moves one place in the playing order instead
          if (app.selection?.kind === 'clip') {
            const id = app.selection.id;
            const index = playingClips(clipsOfProject(p)).findIndex((c) => c.id === id);
            if (index >= 0) (e.preventDefault(), moveClipTo(id, index + dir));
            break;
          }
          if (nudgeSelected(dir * (cmd.endsWith('-more') ? 1 : 1 / fps))) e.preventDefault();
          break;
        }
        case 'frame-back':
          step(-1 / fps);
          break;
        case 'frame-forward':
          step(1 / fps);
          break;
        case 'second-back':
          step(-1);
          break;
        case 'second-forward':
          step(1);
          break;
        case 'flag-prev':
          e.preventDefault();
          jumpFlag(-1);
          break;
        case 'flag-next':
          e.preventDefault();
          jumpFlag(1);
          break;
        case 'version-prev':
          e.preventDefault();
          stepVersion(-1);
          break;
        case 'version-next':
          e.preventDefault();
          stepVersion(1);
          break;
        case 'add-text':
          e.preventDefault();
          addText('plain');
          break;
        case 'mark-in':
          setMark(playheadSource(p));
          app.toast('In point set. Move the playhead and mark the end of the range.');
          break;
        case 'mark-out': {
          const t = playheadSource(p);
          if (mark !== null && Math.abs(t - mark) > 0.05) app.select({ kind: 'range', range: { start: Math.min(mark, t), end: Math.max(mark, t) } });
          break;
        }
        case 'cut': {
          const r = selectedRange(app.selection);
          if (r) cutRange(r);
          break;
        }
        case 'keep': {
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
    if (!pick) {
      // Free text is moved by dragging it: press on a text to select it, keep dragging to place it.
      const p = useApp.getState().project;
      if (!p || comparing) return;
      // a boxed animation: press inside its box to move it, near its bottom-right corner to resize it
      if (phase === 'down') {
        const box = motionBoxAt(p, pt, sel && 'id' in sel ? sel.id : null);
        boxDrag.current = box ? { id: box.id, from: pt, box: box.motion!.box!, resize: Math.abs(pt.x - (box.motion!.box!.x + box.motion!.box!.w)) < 0.025 && Math.abs(pt.y - (box.motion!.box!.y + box.motion!.box!.h)) < 0.04 } : null;
        if (box) {
          textDrag.current = null;
          if (!(sel && 'id' in sel && sel.id === box.id)) useApp.getState().select({ kind: 'overlay', id: box.id });
          return;
        }
      }
      const bd = boxDrag.current;
      if (bd) {
        const dx = pt.x - bd.from.x;
        const dy = pt.y - bd.from.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.002) setMotionBox(bd.id, bd.resize ? { ...bd.box, w: bd.box.w + dx, h: bd.box.h + dy } : { ...bd.box, x: bd.box.x + dx, y: bd.box.y + dy }, bd.resize ? 'resize' : 'move');
        if (phase === 'up') boxDrag.current = null;
        return;
      }
      if (phase === 'down') {
        const hit = textAt(p, pt);
        textDrag.current = hit ? { id: hit.id, dx: hit.x - pt.x, dy: hit.y - pt.y } : null;
        if (hit && !(sel && 'id' in sel && sel.id === hit.id)) useApp.getState().select({ kind: 'overlay', id: hit.id });
        return;
      }
      const d = textDrag.current;
      const o = d ? p.edit.overlays.find((x) => x.id === d.id) : null;
      if (d && o && !o.meta.locked) {
        const at = settledAnchor(p, { ...o, x: pt.x + d.dx, y: pt.y + d.dy });
        if (Math.abs(at.x - o.x) > 1e-4 || Math.abs(at.y - o.y) > 1e-4) patchItem('overlays', o.id, at, 'Move text');
      }
      if (phase === 'up') textDrag.current = null;
      return;
    }
    if (!sel || !('id' in sel)) return;
    if (pick === 'zoom' && sel.kind === 'zoom' && pt.screen && phase !== 'move') {
      patchItem('zooms', sel.id, { x: Math.min(1, Math.max(0, pt.screen.x)), y: Math.min(1, Math.max(0, pt.screen.y)), follow: false }, 'Set zoom target', false);
      if (phase === 'up') setPick(null);
    } else if (pick === 'callout' && sel.kind === 'overlay') {
      patchItem('overlays', sel.id, { x: pt.x, y: pt.y }, 'Place callout');
      if (phase === 'up') setPick(null);
    } else if (pick === 'motion-box' && sel.kind === 'overlay') {
      // draw the box the animation goes in, in frame coordinates
      if (phase === 'down') dragStart.current = pt;
      const a = dragStart.current;
      if (a && phase !== 'down') {
        const x = Math.min(a.x, pt.x);
        const y = Math.min(a.y, pt.y);
        const w = Math.abs(pt.x - a.x);
        const h = Math.abs(pt.y - a.y);
        if (w > 0.02 && h > 0.02) setMotionBox(sel.id, { x, y, w, h }, 'draw');
      }
      if (phase === 'up') {
        dragStart.current = null;
        setPick(null);
      }
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
    if (!p || readOnly(app)) return;
    const r = selectedRange(app.selection);
    if (r) return cutRange(r, app.selection?.kind === 'words' ? 'transcript' : 'manual');
    if (app.selection?.kind === 'music' ? splitMusicAtPlayhead(app.selection.id) : splitSelected(p)) return;
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
        <TopControls onCrop={() => setSheet('crop')} />
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
        <VersionBar />
        <div className="stage-preview">
          {!comparing ? <PreviewToolbar pickMask={() => setPick('mask')} findSensitive={() => setSheet('sensitive')} /> : null}
          {!comparing && !pick ? <SelectionBar /> : null}
          <Preview onPointer={pick || !comparing ? onPointer : undefined} cursorStyle={pick ? 'crosshair' : textSelected ? 'move' : undefined} selectedMaskId={selection?.kind === 'mask' ? selection.id : null} selectedOverlayId={textSelected || boxSelected ? selection!.id : null} />
          {pick ? (
            <div className="pick-hint">
              {pick === 'motion-box' ? 'Drag on the preview where the animation goes' : pick === 'mask' ? 'Drag to select the area for the new mask' : pick === 'zoom' ? 'Click the point to zoom into' : 'Click where the callout should sit'}
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
      {sheet === 'crop' ? <CropSheet onClose={() => setSheet(null)} /> : null}
      {sheet === 'sensitive' ? <SensitiveSheet onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
