import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RP, type ReactNode } from 'react';
import { clipAt, clipBoundaries, clipsOf, splitAtClips, builtinSound, clamp, flagsOf, fmtTime, musicClipsOf, punchInOf, punchJoins, soundsOf, type DecisionMeta, type Project, type Range } from '@cutaway/core';
import { selectedItems, timeMapOf, useApp, usePlayback, useShownProject, type ItemRef, type Selection, readOnly } from '../../state/store';
import { shiftItems } from './itemOps';
import { Icon, type IconName } from '../../ui/icons';
import { addZoom, patchItem, retime, seekSource } from './ops';
import { ClipTrack } from './ClipTrack';
import { MusicBlock } from './MusicBlock';
import { PopMenu, anchorOf, type Anchor } from '../../ui/PopMenu';
import { audioAddItems, effectsAddItems, placeOverlays, selectionMenuItems, videoAddItems } from './addMenus';
import { droppedPaths, importAudioToTimeline, importFiles, importVideosToTimeline } from '../../state/actions';
import { GenerateSheet, type GenTarget } from './GenerateSheet';
import type { GenKind } from '@shared/api';
import { RecordVoiceoverSheet } from '../RecordVoiceover';
import { MotionSheet } from './MotionSheet';
import { addVolumePoint, patchSound, retimeMusic } from './titleSoundOps';
import './inspector/titles-sound.css';

const GUTTER = 20;
/** Height of one row of music: room for the waveform and for dragging volume points. */
const MUSIC_ROW = 46;
/** Height of the simple timeline's video row. */
const VIDEO_ROW = 64;
const VIEW_LABEL: Record<string, { label: string; icon: IconName }> = {
  screen: { label: 'Screen', icon: 'screen' },
  camera: { label: 'Camera', icon: 'camera' },
  overlay: { label: 'Screen + camera', icon: 'layout' },
  split: { label: 'Split', icon: 'split' },
  presenter: { label: 'Camera + screen inset', icon: 'camera' },
};

type ItemKind = 'cut' | 'speed' | 'layout' | 'zoom' | 'overlay' | 'broll' | 'mask' | 'lock' | 'music';

/** How close, in pixels, an edge has to come to something before it snaps there. */
const SNAP_PX = 8;

/**
 * Snapping while dragging on the timeline. `snap` takes the edges being dragged (session time) and
 * returns how far to shift them so the nearest one lands on a snap point (0 = nothing close enough).
 * `skip` names the dragged item so it never snaps to itself; `free` (⌥ held) turns snapping off.
 */
export interface Snapper {
  snap(edges: number[], skip: string, free: boolean): number;
  end(): void;
}

interface ItemProps {
  kind: ItemKind;
  id: string;
  range: Range;
  pps: number;
  duration: number;
  meta?: DecisionMeta;
  selected: boolean;
  className?: string;
  title?: string;
  children?: ReactNode;
  minLength?: number;
  /** Extra placement inside the lane (stacked rows). */
  style?: CSSProperties;
  snapper?: Snapper;
  /** Double-click on the block, with how far into it (in pixels) it was. */
  onDoubleClick?(x: number): void;
  onChange(range: Range, key: string): void;
  /** Pressed: `mods` says whether ⇧ or ⌘ was held. */
  onSelect(mods?: Mods): void;
  /** Released without moving. */
  onTap?(mods: Mods): void;
  /** A move of a block that is selected with others: moves them all. True when it took the move. */
  group?(start: number, key: string): boolean;
}

type Mods = { shiftKey: boolean; metaKey: boolean };

/** A draggable, resizable block on a lane. */
function Item({ kind, id, range, pps, duration, meta, selected, className = '', title, children, minLength = 0.3, style, snapper, onDoubleClick, onChange, onSelect, onTap, group }: ItemProps) {
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x: number; start: number; end: number; moved: boolean } | null>(null);
  const down = (mode: 'move' | 'l' | 'r') => (e: RP) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, start: range.start, end: range.end, moved: false };
    onSelect(e);
  };
  const move = (e: RP) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const dt = dx / pps;
    let start = d.start;
    let end = d.end;
    const skip = `${kind}:${id}`;
    if (d.mode === 'move') {
      const len = d.end - d.start;
      start = clamp(d.start + dt, 0, duration - len);
      start = clamp(start + (snapper?.snap([start, start + len], skip, e.altKey) ?? 0), 0, duration - len);
      end = start + len;
    } else if (d.mode === 'l') {
      start = d.start + dt;
      start = clamp(start + (snapper?.snap([start], skip, e.altKey) ?? 0), 0, d.end - minLength);
    } else {
      end = d.end + dt;
      end = clamp(end + (snapper?.snap([end], skip, e.altKey) ?? 0), d.start + minLength, duration);
    }
    if (d.mode === 'move' && group?.(start, `${kind}:${id}:move`)) return;
    onChange({ start, end }, `${kind}:${id}:${d.mode}`);
  };
  const up = (e: RP) => {
    const d = drag.current;
    drag.current = null;
    snapper?.end();
    if (d && !d.moved) onTap?.(e);
  };
  const w = Math.max(3, (range.end - range.start) * pps);
  const locked = !!meta?.locked;
  return (
    <div
      className={`tl-item ${kind} ${meta ? (meta.origin === 'ai' ? 'ai' : 'you') : ''} ${selected ? 'selected' : ''} ${locked ? 'locked' : ''} ${className}`}
      data-kind={kind}
      data-id={id}
      style={{ ...style, left: range.start * pps, width: w }}
      title={title}
      role="button"
      tabIndex={0}
      aria-label={title}
      onPointerDown={down('move')}
      onPointerMove={move}
      onPointerUp={up}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      // the block holds the pointer while pressed, so a double-click anywhere on it arrives here
      onDoubleClick={onDoubleClick ? (e) => onDoubleClick(e.clientX - e.currentTarget.getBoundingClientRect().left) : undefined}
    >
      {w > 14 && !locked ? <span className="handle l" onPointerDown={down('l')} onPointerMove={move} onPointerUp={up} /> : null}
      <span className="tl-item-body">{children}</span>
      {locked ? <Icon name="lock" size={10} /> : null}
      {w > 14 && !locked ? <span className="handle r" onPointerDown={down('r')} onPointerMove={move} onPointerUp={up} /> : null}
    </div>
  );
}

/** A sound effect: a small marker on its moment that can be dragged along the row. */
function SoundMarker({ t, pps, duration, selected, cut, text, title, onSelect, onMove }: { t: number; pps: number; duration: number; selected: boolean; cut: boolean; text?: boolean; title: string; onSelect(mods?: Mods): void; onMove?(t: number): void }) {
  const drag = useRef<{ x: number; t: number; moved: boolean } | null>(null);
  return (
    <button
      className={`tl-sound${selected ? ' selected' : ''}${cut ? ' cut' : ''}${text ? ' text' : ''}`}
      data-kind={text ? undefined : 'sound'}
      style={{ left: t * pps }}
      title={title}
      aria-label={title}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, t, moved: false };
        onSelect(e);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !onMove) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        onMove(clamp(d.t + dx / pps, 0, duration));
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <i>
        <Icon name={text ? 'text' : 'bell'} size={11} />
      </i>
    </button>
  );
}

function Lane({ kind, height = 48, children, onBackground, hint, onAdd, pps }: { kind: string; height?: number; children: ReactNode; onBackground?: { down(e: RP): void; move(e: RP): void; up(e: RP): void }; hint?: string; onAdd?: (t: number) => void; pps?: number }) {
  const [ghost, setGhost] = useState<number | null>(null);
  const x = (e: RP | React.MouseEvent) => e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;
  return (
    <div className={`tl-lane lane-${kind}`} style={{ height }}>
      <div
        className="tl-track"
        onPointerDown={onBackground?.down}
        onPointerMove={(e) => {
          onBackground?.move(e);
          if (onAdd) setGhost(e.target === e.currentTarget ? x(e) : null);
        }}
        onPointerUp={onBackground?.up}
        onPointerLeave={() => setGhost(null)}
        onClick={(e) => {
          if (onAdd && pps && e.target === e.currentTarget) onAdd(x(e) / pps);
        }}
      >
        {children}
        {onAdd && ghost !== null ? (
          <span className="tl-ghost" style={{ left: ghost - 14 }}>
            <Icon name="plus" size={12} /> {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The footage track: one amber block per kept stretch, waveform inside, drawn only for the visible window. */
function ClipCanvas({ project, pps, scrollLeft, width, height }: { project: Project; pps: number; scrollLeft: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const t0 = scrollLeft / pps;
    const t1 = (scrollLeft + width) / pps;
    const x = (t: number) => t * pps - scrollLeft;
    const map = timeMapOf(project);
    const wf = project.analysis?.waveform;
    const hz = project.analysis?.waveformHz ?? 20;
    // merge segments that only differ by speed boundaries into visual clips, but keep speed labels
    // one block per kept stretch, and never one block across two clips
    const clipList = clipsOf(project);
    const kept = map.keptRanges().flatMap((k) => splitAtClips(clipList, k));
    ctx.font = '600 11px "Inter Variable", sans-serif';
    ctx.textBaseline = 'middle';
    for (const k of kept) {
      if (k.end < t0 || k.start > t1) continue;
      const x0 = x(k.start);
      const w = Math.max(2, (k.end - k.start) * pps - 1);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, 0, w, height, 10);
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#97640b');
      grad.addColorStop(1, '#c07e11');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.clip();
      // thin lighter dividers at each second (when there is room for them)
      if (pps >= 14) {
        ctx.fillStyle = 'rgba(255, 220, 150, 0.16)';
        for (let sec = Math.ceil(Math.max(k.start, t0)); sec < Math.min(k.end, t1); sec++) ctx.fillRect(Math.round(x(sec)), 0, 1, height);
      }
      // waveform, bottom-anchored like a filled area
      if (wf && wf.length) {
        ctx.fillStyle = '#cd9029';
        ctx.beginPath();
        const a = Math.max(0, Math.floor(Math.max(k.start, t0) * hz));
        const b = Math.min(wf.length, Math.ceil(Math.min(k.end, t1) * hz));
        ctx.moveTo(x(a / hz), height);
        for (let i = a; i < b; i++) ctx.lineTo(x(i / hz), height - 2 - wf[i]! * (height * 0.45));
        ctx.lineTo(x(b / hz), height);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(255, 214, 140, 0.22)';
      ctx.fillRect(x0 + 8, 0.5, Math.max(0, w - 16), 1);
      // label: Clip · duration · speed
      const speed = map.segments.find((sg) => sg.srcStart >= k.start - 1e-6 && sg.srcEnd <= k.end + 1e-6 && sg.speed !== 1)?.speed;
      const label = `${fmtDuration(k.end - k.start)}   ${speed ? `${speed}x` : '1x'}`;
      if (w > 96) {
        ctx.fillStyle = 'rgba(255, 244, 220, 0.95)';
        ctx.textAlign = 'center';
        const cx = Math.min(Math.max(x0 + w / 2, 60), width - 60);
        if (cx > x0 + 44 && cx < x0 + w - 44) {
          ctx.font = '500 11.5px "Inter Variable", sans-serif';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.fillText('Clip', cx, height / 2 - 8);
          ctx.font = '500 12px "Inter Variable", sans-serif';
          ctx.fillStyle = '#fff';
          ctx.fillText(label, cx, height / 2 + 8);
        }
      }
    }
  }, [project, pps, scrollLeft, width, height]);
  return <canvas ref={ref} className="tl-clip-canvas" style={{ width, height, transform: `translateX(${scrollLeft}px)` }} />;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, '') : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function ticks(pps: number): { major: number; minor: number } {
  const options = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = options.find((s) => s * pps >= 84) ?? 600;
  return { major, minor: major / (major >= 10 ? 5 : 4) };
}

export function Timeline({ zoom, onZoom }: { zoom: number; onZoom(z: number): void }) {
  const project = useShownProject();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const comparing = useApp(readOnly);
  const expanded = project.ui.expandedTimeline;
  const simple = !project.ui.advancedTimeline;
  const [menu, setMenu] = useState<{ kind: 'video' | 'fx' | 'audio' | 'ctx'; anchor: Anchor } | null>(null);
  const [generating, setGenerating] = useState<{ kind: GenKind; target: GenTarget } | null>(null);
  const openGen = (kind: GenKind, target: GenTarget = 'over') => setGenerating({ kind, target });
  const [recordVo, setRecordVo] = useState(false);
  const [motionSheet, setMotionSheet] = useState<{ editId?: string; request?: string; at?: number | null } | null>(null);
  // "Change it with AI" on the selection bar opens the animation sheet from anywhere
  useEffect(() => {
    // detail: the id of an animation to change, or { request, at } for a new one to be written
    const open = (e: Event) => {
      const d = (e as CustomEvent<string | { request?: string; at?: number | null } | undefined>).detail;
      setMotionSheet(typeof d === 'object' && d ? { request: d.request, at: d.at ?? null } : { editId: d });
    };
    window.addEventListener('cutaway-motion', open);
    return () => window.removeEventListener('cutaway-motion', open);
  }, []);
  const [dropping, setDropping] = useState<'video' | 'fx' | 'audio' | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const map = timeMapOf(project);
  const flags = useMemo(() => flagsOf(project), [project.flags]);
  const duration = Math.max(0.1, project.duration);
  // at the fitted zoom the whole video shows, and in the simple rows so do the + buttons after it
  const fitPps = Math.max(2, (width - GUTTER * 2 - (simple ? 72 : 24)) / duration);
  // zoom 0 = whole recording fits; 1 = 240 px per second
  const scale = zoom <= 0.001 ? fitPps : fitPps * Math.pow(Math.max(1, 240 / fitPps), zoom);
  // the simple rows keep room after the end of the video for their + buttons
  // the content is padded by GUTTER on both sides, so at the fitted zoom it is exactly as wide as the view
  const contentWidth = Math.max(width - GUTTER * 2, duration * scale + (simple ? 72 : 24));

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // playhead follows playback without re-rendering the timeline
  useEffect(() => {
    const update = () => {
      const t = timeMapOf(project).toSource(usePlayback.getState().time);
      const head = headRef.current;
      const sc = scrollRef.current;
      if (!head || !sc) return;
      const x = t * scale;
      head.style.transform = `translateX(${GUTTER + x}px)`;
      if (usePlayback.getState().playing) {
        const view = sc.clientWidth - GUTTER;
        if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + view - 60) sc.scrollLeft = Math.max(0, x - view * 0.2);
      }
    };
    update();
    return usePlayback.subscribe(update);
  }, [project, scale]);

  const timeAt = useCallback(
    (clientX: number) => {
      const sc = scrollRef.current!;
      const r = sc.getBoundingClientRect();
      return clamp((clientX - r.left - GUTTER + sc.scrollLeft) / scale, 0, duration);
    },
    [scale, duration],
  );

  // scrub on the ruler, range-select on the clip lane
  const scrub = useRef(false);
  const rulerHandlers = {
    down: (e: RP) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      scrub.current = true;
      usePlayback.getState().setPlaying(false);
      seekSource(project, timeAt(e.clientX));
    },
    move: (e: RP) => scrub.current && seekSource(project, timeAt(e.clientX)),
    up: () => (scrub.current = false),
  };
  const rangeDrag = useRef<{ t0: number; moved: boolean } | null>(null);
  const clipHandlers = {
    down: (e: RP) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      rangeDrag.current = { t0: timeAt(e.clientX), moved: false };
    },
    move: (e: RP) => {
      const d = rangeDrag.current;
      if (!d) return;
      const t = timeAt(e.clientX);
      if (!d.moved && Math.abs(t - d.t0) * scale < 4) return;
      d.moved = true;
      select({ kind: 'range', range: { start: Math.min(d.t0, t), end: Math.max(d.t0, t) } });
    },
    up: (e: RP) => {
      const d = rangeDrag.current;
      rangeDrag.current = null;
      if (d && !d.moved) {
        const t = timeAt(e.clientX);
        const slice = e.detail >= 2 ? map.keptRanges().find((k) => t >= k.start && t < k.end) : undefined;
        if (slice) return select({ kind: 'range', range: slice });
        // a click on the footage picks the clip under it, so it can be split (⌘B) or removed (⌫) straight away
        const clip = clipAt(clipsOf(project), t);
        select(clip ? { kind: 'clip', id: clip.id } : null);
        seekSource(project, t);
      }
    },
  };

  const also = useApp((s) => s.also);
  const picked = new Set(selectedItems({ selection, also }).map((r) => `${r.kind}:${r.id}`));
  const isSel = (kind: NonNullable<Selection>['kind'], id: string) => (!!selection && 'id' in selection && selection.kind === kind && selection.id === id) || picked.has(`${kind}:${id}`);
  // ⇧- or ⌘-click adds a block to the selection or takes it out; a plain press on a block that is already
  // selected with others keeps them all, so they can be dragged together, and a plain click picks it alone
  const pick = (kind: ItemRef['kind'], id: string) => (m?: Mods) => {
    const st = useApp.getState();
    if (m && (m.shiftKey || m.metaKey) && !ro) return st.toggleSelect({ kind, id });
    if (picked.has(`${kind}:${id}`) && picked.size > 1) return;
    select({ kind, id });
  };
  const tap = (kind: ItemRef['kind'], id: string) => (m: Mods) => {
    if (!m.shiftKey && !m.metaKey && picked.size > 1 && picked.has(`${kind}:${id}`)) select({ kind, id });
  };
  const groupMove = (kind: ItemRef['kind'], id: string, cur: Range) => (start: number, key: string) => {
    const refs = selectedItems(useApp.getState());
    if (refs.length < 2 || !refs.some((r) => r.kind === kind && r.id === id)) return false;
    shiftItems(refs, start - cur.start, `Move ${refs.length} blocks`, `group:${key}`);
    return true;
  };
  const rangeSel = selection && (selection.kind === 'range' || selection.kind === 'words') ? selection.range : null;
  const e = project.edit;
  const { major, minor } = ticks(scale);
  const rulerTicks = useMemo(() => {
    const out: { t: number; major: boolean }[] = [];
    const t0 = Math.max(0, Math.floor(scrollLeft / scale / minor) * minor);
    const t1 = Math.min(duration, (scrollLeft + width) / scale);
    for (let t = t0; t <= t1 + 1e-6; t += minor) out.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6 });
    return out;
  }, [scrollLeft, scale, width, duration, major, minor]);

  void onZoom;
  const assetName = (id: string) => project.sources.find((s) => s.id === id)?.name ?? 'Missing asset';
  // Music is placed in seconds of the finished video; this ruler shows the recording. A clip is drawn from
  // where its first second lands on the recording to where its last one does, so it spans any cut it plays through.
  const music = musicClipsOf(e, project.sources).filter((c) => c.start < map.outDuration);
  // pieces that play at the same time are stacked, so each can be seen and grabbed
  const musicRowEnds: number[] = [];
  const musicRow = music.map((c) => {
    let r = musicRowEnds.findIndex((end) => end <= c.start + 1e-6);
    if (r < 0) r = musicRowEnds.length;
    musicRowEnds[r] = c.start + c.length;
    return r;
  });
  const musicRows = Math.max(1, musicRowEnds.length);
  const musicRange = (c: (typeof music)[number]): Range => ({ start: map.toSource(c.start), end: c.start + c.length >= map.outDuration - 1e-3 ? duration : map.toSource(c.start + c.length) });

  // ── snapping: the start and end of the video, clip changes, flags, the playhead and the edges of every block ──
  const [guide, setGuide] = useState<number | null>(null);
  const snapPoints: { t: number; id: string }[] = [
    { t: 0, id: '' },
    { t: duration, id: '' },
    ...clipBoundaries(clipsOf(project)).map((t) => ({ t, id: 'clip' })),
    ...flags.map((f) => ({ t: f.t, id: 'flag' })),
    // trims are left out: their edges are the clip edges a trim handle is being dragged along
    ...e.cuts.filter((c) => c.kind !== 'trim').flatMap((c) => [{ t: c.start, id: `cut:${c.id}` }, { t: c.end, id: `cut:${c.id}` }]),
    ...([['speed', e.speeds], ['layout', e.layouts], ['zoom', e.zooms], ['overlay', e.overlays], ['broll', e.broll], ['mask', e.masks]] as const).flatMap(([kind, items]) =>
      (items as readonly (Range & { id: string })[]).flatMap((x) => [{ t: x.start, id: `${kind}:${x.id}` }, { t: x.end, id: `${kind}:${x.id}` }]),
    ),
    ...music.flatMap((c) => {
      const r = musicRange(c);
      return [{ t: r.start, id: `music:${c.id}` }, { t: r.end, id: `music:${c.id}` }];
    }),
  ];
  const snapper: Snapper = {
    snap(edges, skip, free) {
      if (free) {
        setGuide(null);
        return 0;
      }
      const head = { t: timeMapOf(project).toSource(usePlayback.getState().time), id: 'playhead' };
      let best: { d: number; at: number } | null = null;
      for (const edge of edges)
        for (const p of [head, ...snapPoints]) {
          if (p.id === skip) continue;
          const d = p.t - edge;
          if (Math.abs(d) * scale <= SNAP_PX && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: p.t };
        }
      setGuide(best ? best.at : null);
      return best?.d ?? 0;
    },
    end: () => setGuide(null),
  };
  const splitAtPlayhead = () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'split' }));
  const sounds = soundsOf(e);
  const soundingTexts = e.overlays.filter((o) => o.sound);
  const cueLabel = (c: { builtin: string | null; sourceId?: string }) => builtinSound(c.builtin)?.name ?? assetName(c.sourceId ?? '');
  const ro = comparing; // while comparing, the timeline is read-only
  // punch-in on jump cuts: which cuts change the framing ('in' punches in, 'out' returns to normal, 'off' was left out)
  const punchMark = new Map<string, 'in' | 'out' | 'off'>();
  if (punchInOf(project.edit).enabled) for (const j of punchJoins(project, map)) if (j.qualifies) for (const id of j.cutIds) punchMark.set(id, j.skipped ? 'off' : j.punched ? 'in' : 'out');


  // ── the blocks, drawn the same way in the simple rows and in the detailed lanes ──
  const rowStyle = (row: number, h: number): CSSProperties => ({ top: row * (h + 3), bottom: 'auto', height: h });
  const zoomItem = (z: (typeof e.zooms)[number], style?: CSSProperties) => (
    <Item snapper={snapper} key={z.id} kind="zoom" id={z.id} style={style} range={z} pps={scale} duration={duration} meta={z.meta} minLength={0.6} selected={isSel('zoom', z.id)} title={`Zoom ${z.scale.toFixed(1)}×${z.follow ? ' · follows cursor' : ''}${z.meta.reason ? ` · ${z.meta.reason}` : ''}`} onSelect={pick('zoom', z.id)} onTap={tap('zoom', z.id)} group={ro ? undefined : groupMove('zoom', z.id, z)} onChange={(r, k) => retime('zooms', z.id, r, k)}>
      <span className="tl-two">
        <small><Icon name="pointer" size={10} /> Zoom{z.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
        <span><Icon name="zoom" size={11} /> {z.scale.toFixed(z.scale % 1 ? 1 : 0)}x <Icon name="cursor" size={10} /> {z.follow ? 'Auto' : 'Manual'}</span>
      </span>
    </Item>
  );
  const overlayItem = (o: (typeof e.overlays)[number], style?: CSSProperties) => (
    <Item snapper={snapper} key={o.id} kind="overlay" id={o.id} style={style} className={o.kind === 'text' ? 'text' : o.kind === 'motion' ? 'motion' : ''} range={o} pps={scale} duration={duration} meta={o.meta} minLength={o.kind === 'text' ? 0.5 : 0.8} selected={isSel('overlay', o.id)} title={`${o.kind === 'text' ? 'Text' : o.kind}: ${o.text}`} onSelect={pick('overlay', o.id)} onTap={tap('overlay', o.id)} group={ro ? undefined : groupMove('overlay', o.id, o)} onChange={(r) => patchItem('overlays', o.id, r, o.kind === 'text' ? 'Move text' : 'Move graphic')}>
      <span className="tl-two">
        <small><Icon name={o.kind === 'motion' ? 'sparkle' : 'text'} size={10} /> {o.kind === 'motion' ? 'Animation' : o.kind === 'text' ? 'Text' : o.kind === 'callout' ? 'Callout' : o.kind === 'section-card' ? 'Section' : 'Lower third'}{o.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
        <span>{o.text}</span>
      </span>
    </Item>
  );
  const isPhoto = (assetId: string) => project.sources.find((x) => x.id === assetId)?.kind === 'image';
  const brollItem = (b: (typeof e.broll)[number], style?: CSSProperties) => (
    <Item snapper={snapper} key={b.id} kind="broll" id={b.id} style={style} range={b} pps={scale} duration={duration} meta={b.meta} minLength={0.8} selected={isSel('broll', b.id)} title={`${isPhoto(b.assetId) ? 'Photo' : 'B-roll'}: ${assetName(b.assetId)}${b.meta.reason ? ` · ${b.meta.reason}` : ''}`} onSelect={pick('broll', b.id)} onTap={tap('broll', b.id)} group={ro ? undefined : groupMove('broll', b.id, b)} onChange={(r, k) => retime('broll', b.id, r, k)}>
      <span className="tl-two">
        <small><Icon name={isPhoto(b.assetId) ? 'image' : 'broll'} size={10} /> {isPhoto(b.assetId) ? 'Photo' : 'B-roll'}{b.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
        <span>{assetName(b.assetId)}</span>
      </span>
    </Item>
  );
  const maskItem = (m: (typeof e.masks)[number], style?: CSSProperties) => (
    <Item snapper={snapper} key={m.id} kind="mask" id={m.id} style={style} range={m} pps={scale} duration={duration} meta={m.meta} selected={isSel('mask', m.id)} title={`${m.style} mask on ${m.target}`} onSelect={pick('mask', m.id)} onTap={tap('mask', m.id)} group={ro ? undefined : groupMove('mask', m.id, m)} onChange={(r) => patchItem('masks', m.id, r, 'Move mask')}>
      <span className="tl-two">
        <small><Icon name="mask" size={10} /> Mask</small>
        <span>{m.style === 'blur' ? 'Blur' : m.style === 'solid' ? 'Cover' : 'Spotlight'}</span>
      </span>
    </Item>
  );
  const cutItem = (c: (typeof e.cuts)[number]) => (
    <Item
      snapper={snapper}
      key={c.id}
      kind="cut"
      id={c.id}
      range={c}
      pps={scale}
      duration={duration}
      meta={c.meta}
      minLength={0.05}
      selected={isSel('cut', c.id)}
      title={`${c.meta.origin === 'ai' ? 'AI' : 'Your'} cut · ${c.kind} · ${(c.end - c.start).toFixed(1)}s removed${c.meta.reason ? ` · ${c.meta.reason}` : ''} · click to review or restore`}
      onSelect={() => select({ kind: 'cut', id: c.id })}
      onChange={(r) => patchItem('cuts', c.id, r, 'Adjust cut')}
    >
      {(c.end - c.start) * scale > 26 ? <Icon name="scissors" size={11} /> : null}
      {punchMark.get(c.id) ? <i className={`tl-punch${punchMark.get(c.id) === 'off' ? ' off' : ''}`} data-testid="punch-mark" data-state={punchMark.get(c.id)} title={punchMark.get(c.id) === 'off' ? 'Punch-in left out at this cut' : punchMark.get(c.id) === 'in' ? 'The framing punches in after this cut' : 'The framing returns to normal after this cut'}>{punchMark.get(c.id) === 'out' ? '−' : '+'}</i> : null}
    </Item>
  );
  const musicItem = (c: (typeof music)[number], i: number) => {
    const range = musicRange(c);
    const w = (range.end - range.start) * scale;
    const fade = (seconds: number) => Math.min(w / 2, (seconds / Math.max(0.01, c.length)) * w);
    return (
      <Item snapper={snapper} key={c.id} kind="music" id={c.id} style={rowStyle(musicRow[i]!, MUSIC_ROW)} range={range} pps={scale} duration={duration} minLength={0.3} selected={isSel('music', c.id)} onDoubleClick={ro ? undefined : (x) => addVolumePoint(c.id, map.toOutput(range.start + x / scale) - c.start)} title={`Music: ${assetName(c.sourceId)} · ${fmtTime(c.start)}–${fmtTime(c.start + c.length)} of the finished video`} onSelect={pick('music', c.id)} onTap={tap('music', c.id)} group={ro ? undefined : groupMove('music', c.id, range)} onChange={(r, k) => retimeMusic(c.id, k.endsWith(':l') ? 'l' : k.endsWith(':r') ? 'r' : 'move', map.toOutput(r.start), map.toOutput(r.end))}>
        {c.fadeIn > 0.05 ? <span className="fade in" style={{ width: fade(c.fadeIn) }} /> : null}
        {c.fadeOut > 0.05 ? <span className="fade out" style={{ width: fade(c.fadeOut) }} /> : null}
        <MusicBlock clip={c} range={range} pps={scale} map={map} height={MUSIC_ROW} selected={isSel('music', c.id)} readOnly={ro} view={{ left: scrollLeft, width }} />
        <span className="mu-label">
          <Icon name="music" size={11} /> {assetName(c.sourceId)}
          {c.loop ? <small>· loops</small> : null}
        </span>
      </Item>
    );
  };
  const soundLane =
    sounds.length || soundingTexts.length ? (
      <Lane kind="sound" height={24}>
        {soundingTexts.map((o) => (
          <SoundMarker key={`t${o.id}`} text t={o.start} pps={scale} duration={duration} cut={false} selected={isSel('overlay', o.id)} title={`${cueLabel(o.sound!)} as “${o.text}” appears`} onSelect={pick('overlay', o.id)} />
        ))}
        {sounds.map((s) => (
          <SoundMarker key={s.id} t={s.start} pps={scale} duration={duration} cut={!map.isKept(s.start)} selected={isSel('sound', s.id)} title={`${cueLabel(s)} at ${fmtTime(s.start, true)}${map.isKept(s.start) ? '' : ' · its moment is cut, so it is not heard'}`} onSelect={pick('sound', s.id)} onMove={ro ? undefined : (t) => patchSound(s.id, { start: t }, 'Move sound', 'start')} />
        ))}
      </Lane>
    ) : null;

  // ── simple rows: everything over the footage stacked on one row, the footage, and the audio ──
  const fx = [...e.zooms.map((x) => ({ kind: 'zoom' as const, x })), ...e.overlays.map((x) => ({ kind: 'overlay' as const, x })), ...e.broll.map((x) => ({ kind: 'broll' as const, x })), ...e.masks.map((x) => ({ kind: 'mask' as const, x }))].sort((a, b) => a.x.start - b.x.start);
  const fxEnds: number[] = [];
  const fxRow = fx.map((f) => {
    let r = fxEnds.findIndex((end) => end <= f.x.start + 1e-6);
    if (r < 0) r = fxEnds.length;
    fxEnds[r] = f.x.end;
    return r;
  });
  const fxRows = Math.max(1, fxEnds.length);
  const endX = (t: number) => Math.min(t, duration) * scale + 8;
  const fxEnd = fx.length ? Math.max(...fx.map((f) => f.x.end)) : 0;
  const musicEnd = music.length ? Math.max(...music.map((c) => musicRange(c).end)) : 0;
  const openMenu = (kind: 'video' | 'fx' | 'audio') => (ev: React.MouseEvent) => setMenu({ kind, anchor: anchorOf(ev.currentTarget) });
  const dropRow = (kind: 'video' | 'fx' | 'audio') => ({
    onDragOver: (ev: React.DragEvent) => {
      if (ro || !ev.dataTransfer.types.includes('Files')) return;
      ev.preventDefault();
      if (dropping !== kind) setDropping(kind);
    },
    onDragLeave: (ev: React.DragEvent) => {
      if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) setDropping(null);
    },
    onDrop: (ev: React.DragEvent) => {
      setDropping(null);
      if (ro) return;
      const paths = droppedPaths(ev);
      if (!paths.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (kind === 'audio') void importAudioToTimeline(paths);
      else if (kind === 'video') void importVideosToTimeline(paths).then(placeOverlays);
      else void importFiles(paths, { asOverlay: true }).then((r) => placeOverlays(r?.accepted.map((a) => a.source.id) ?? []));
    },
  });
  // a right-click on a block selects it (unless it is already part of the selection) and opens its menu
  const onContextMenu = (ev: React.MouseEvent) => {
    if (ro) return;
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-kind], [data-clip-id]');
    if (!el) return;
    ev.preventDefault();
    const st = useApp.getState();
    const clipId = el.dataset.clipId;
    if (clipId) st.select({ kind: 'clip', id: clipId });
    else {
      const kind = el.dataset.kind as NonNullable<Selection>['kind'];
      const id = el.dataset.id ?? '';
      if (kind === 'cut') st.select({ kind: 'cut', id });
      else if (!picked.has(`${kind}:${id}`)) st.select({ kind, id } as Selection);
    }
    setMenu({ kind: 'ctx', anchor: { x: ev.clientX, y: ev.clientY, above: true } });
  };

  const labelEvery = major;
  return (
    <div className={`timeline ${simple ? 'simple-mode' : expanded ? 'expanded' : 'simple'}${ro ? ' readonly' : ''}`} onContextMenu={onContextMenu}>
      <div className="tl-scroll" ref={scrollRef} onScroll={(ev) => setScrollLeft(ev.currentTarget.scrollLeft)}>
        <div className="tl-content" style={{ width: GUTTER * 2 + contentWidth, paddingLeft: GUTTER }}>
          <div className="tl-ruler" onPointerDown={rulerHandlers.down} onPointerMove={rulerHandlers.move} onPointerUp={rulerHandlers.up}>
            {rulerTicks.filter((t) => t.major).map((t) => (
              <span key={t.t.toFixed(3)} className="tick" style={{ left: t.t * scale }}>
                <b>{labelEvery < 1 ? fmtTime(t.t, true).replace(/0$/, '') : fmtTime(t.t)}</b>
                <i />
              </span>
            ))}
            {rulerTicks.filter((t) => t.major && t.t + major / 2 <= duration).map((t) => (
              <span key={`h${t.t.toFixed(3)}`} className="tick half" style={{ left: (t.t + major / 2) * scale }}>
                <i />
              </span>
            ))}
            {flags.map((f) => (
              <button key={f.id} className="tl-flag" style={{ left: f.t * scale }} title={`Flag at ${fmtTime(f.t)}: you marked this moment while recording`} aria-label={`Flag at ${fmtTime(f.t)}. Go to it.`} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => seekSource(project, f.t)}>
                <Icon name="flag" size={11} />
              </button>
            ))}
          </div>

          {simple ? (
            <>
              <div className={`tl-droprow${dropping === 'fx' ? ' dropping' : ''}`} {...dropRow('fx')}>
                <Lane kind="fx" height={fxRows * 30 + (fxRows - 1) * 3}>
                  {fx.map((f, i) => (f.kind === 'zoom' ? zoomItem(f.x, rowStyle(fxRow[i]!, 30)) : f.kind === 'overlay' ? overlayItem(f.x, rowStyle(fxRow[i]!, 30)) : f.kind === 'broll' ? brollItem(f.x, rowStyle(fxRow[i]!, 30)) : maskItem(f.x, rowStyle(fxRow[i]!, 30))))}
                  {ro ? null : fx.length ? (
                    <button className="tl-addchip" style={{ left: endX(fxEnd), top: 3 }} data-testid="fx-add" title="Add text, a zoom or a photo at the playhead" aria-label="Add text, a zoom or a photo" onPointerDown={(ev) => ev.stopPropagation()} onClick={openMenu('fx')}>
                      <Icon name="plus" size={13} />
                    </button>
                  ) : (
                    <button className="tl-addrow" data-testid="fx-add" onPointerDown={(ev) => ev.stopPropagation()} onClick={openMenu('fx')}>
                      <Icon name="text" size={13} /> Add text, zoom or photo
                    </button>
                  )}
                </Lane>
              </div>
              <div className={`tl-droprow${dropping === 'video' ? ' dropping' : ''}`} {...dropRow('video')}>
                <ClipTrack project={project} pps={scale} readOnly={ro} snapper={snapper} big={{ height: VIDEO_ROW, view: { left: scrollLeft, width } }}>
                  {e.cuts.map(cutItem)}
                  {ro ? null : (
                    <button className="tl-addclip" style={{ left: endX(duration) }} data-testid="video-add" title="Add video or a photo" aria-label="Add video or a photo" onPointerDown={(ev) => ev.stopPropagation()} onClick={openMenu('video')}>
                      <Icon name="plus" size={18} />
                    </button>
                  )}
                </ClipTrack>
              </div>
              <div className={`tl-droprow${dropping === 'audio' ? ' dropping' : ''}`} {...dropRow('audio')}>
                <Lane kind="music" height={music.length ? musicRows * MUSIC_ROW + (musicRows - 1) * 3 : 34}>
                  {music.map(musicItem)}
                  {ro ? null : music.length ? (
                    <button className="tl-addchip" style={{ left: endX(musicEnd), top: (MUSIC_ROW - 26) / 2 }} data-testid="audio-add" title="Add music, a voiceover or a sound" aria-label="Add audio" onPointerDown={(ev) => ev.stopPropagation()} onClick={openMenu('audio')}>
                      <Icon name="plus" size={13} />
                    </button>
                  ) : (
                    <button className="tl-addrow audio" data-testid="audio-add" onPointerDown={(ev) => ev.stopPropagation()} onClick={openMenu('audio')}>
                      <Icon name="music" size={13} /> Add audio
                    </button>
                  )}
                </Lane>
              </div>
              {soundLane}
            </>
          ) : (
            <>
          <ClipTrack project={project} pps={scale} readOnly={ro} snapper={snapper} />
          <Lane kind="clip" height={48} onBackground={ro ? undefined : clipHandlers}>
            <ClipCanvas project={project} pps={scale} scrollLeft={scrollLeft} width={Math.max(0, width - GUTTER)} height={48} />
            {e.speeds.map((s) => (
              <Item snapper={snapper} key={s.id} kind="speed" id={s.id} range={s} pps={scale} duration={duration} meta={s.meta} selected={isSel('speed', s.id)} title={`${s.speed}× speed`} onSelect={pick('speed', s.id)} onTap={tap('speed', s.id)} group={ro ? undefined : groupMove('speed', s.id, s)} onChange={(r, k) => retime('speeds', s.id, r, k)}>
                <Icon name="speed" size={10} /> {s.speed}x
              </Item>
            ))}
            {e.cuts.map(cutItem)}
            {rangeSel ? <div className="tl-range" style={{ left: rangeSel.start * scale, width: Math.max(2, (rangeSel.end - rangeSel.start) * scale) }} /> : null}
          </Lane>

          <Lane kind="zoom" pps={scale} hint="Zoom" onAdd={ro || !project.sources.some((s) => s.role === 'screen') ? undefined : (t) => addZoom({ start: Math.max(0, t - 0.3), end: Math.min(duration, t + 2.7) })}>
            {e.zooms.map((z) => zoomItem(z))}
            {e.zooms.length === 0 && !ro ? <span className="tl-empty">Click to add zoom on cursor</span> : null}
          </Lane>

          {expanded ? (
            <>
              <Lane kind="view" pps={scale}>
                {e.layouts.map((l) => (
                  <Item snapper={snapper} key={l.id} kind="layout" id={l.id} range={l} pps={scale} duration={duration} meta={l.meta} minLength={0.5} selected={isSel('layout', l.id)} title={`${VIEW_LABEL[l.mode]!.label}${l.mode !== 'screen' ? ` · camera ${l.camera}` : ''}${l.meta.reason ? ` · ${l.meta.reason}` : ''}`} onSelect={pick('layout', l.id)} onTap={tap('layout', l.id)} group={ro ? undefined : groupMove('layout', l.id, l)} onChange={(r, k) => retime('layouts', l.id, r, k)}>
                    <span className="tl-two">
                      <small><Icon name="layout" size={10} /> Layout{l.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
                      <span><Icon name={VIEW_LABEL[l.mode]!.icon} size={11} /> {VIEW_LABEL[l.mode]!.label}{l.mode !== 'screen' ? ` ${l.camera}` : ''}</span>
                    </span>
                  </Item>
                ))}
                {e.layouts.length === 0 ? <span className="tl-empty">Layouts · select a range on the clip to change the view</span> : null}
              </Lane>
              <Lane kind="graphics" pps={scale}>
                {e.overlays.map((o) => overlayItem(o))}
                {e.broll.map((b) => brollItem(b))}
                {e.masks.map((m) => maskItem(m))}
                {e.overlays.length + e.broll.length + e.masks.length === 0 ? <span className="tl-empty">Graphics, B-roll and masks</span> : null}
              </Lane>
            </>
          ) : null}

          {music.length || expanded ? (
            <Lane kind="music" height={musicRows * MUSIC_ROW + (musicRows - 1) * 3}>
              {music.map(musicItem)}
              {music.length === 0 ? <span className="tl-empty">Music · add a piece in the Audio tab</span> : null}
            </Lane>
          ) : null}
          {soundLane}
            </>
          )}

          {/* locks span every lane */}
          <div className="tl-locks" style={{ left: GUTTER }}>
            {flags.map((f) => (
              <i key={f.id} className="tl-flagline" style={{ left: f.t * scale }} />
            ))}
            {guide !== null ? <i className="tl-snapline" data-testid="snap-guide" style={{ left: guide * scale }} /> : null}
            {e.locks.map((l) => (
              <button key={l.id} className={`tl-lock${isSel('lock', l.id) ? ' selected' : ''}`} style={{ left: l.start * scale, width: Math.max(4, (l.end - l.start) * scale) }} title={`Locked: ${l.note}`} onClick={() => select({ kind: 'lock', id: l.id })}>
                <Icon name="lock" size={10} />
              </button>
            ))}
          </div>
          <div className="tl-playhead" ref={headRef}>
            <i />
            {!ro ? (
              <button className="tl-split" data-testid="playhead-split" onPointerDown={(ev) => ev.stopPropagation()} onClick={splitAtPlayhead} title="Split at the playhead (⌘B). Splits the selected block, or else the clip under the playhead." aria-label="Split at the playhead">
                <Icon name="scissors" size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {menu ? (
        <PopMenu
          anchor={menu.anchor}
          label={menu.kind === 'video' ? 'Add video' : menu.kind === 'fx' ? 'Add text, zoom or photo' : menu.kind === 'audio' ? 'Add audio' : 'Selection'}
          onClose={() => setMenu(null)}
          items={menu.kind === 'video' ? videoAddItems(openGen) : menu.kind === 'fx' ? effectsAddItems(project, openGen, () => setMotionSheet({})) : menu.kind === 'audio' ? audioAddItems(project, openGen, () => setRecordVo(true)) : selectionMenuItems(project)}
        />
      ) : null}
      {generating ? <GenerateSheet kind={generating.kind} target={generating.target} onClose={() => setGenerating(null)} /> : null}
      {recordVo ? <RecordVoiceoverSheet onClose={() => setRecordVo(false)} /> : null}
      {motionSheet ? <MotionSheet editId={motionSheet.editId} request={motionSheet.request} at={motionSheet.at} onClose={() => setMotionSheet(null)} /> : null}
    </div>
  );
}
