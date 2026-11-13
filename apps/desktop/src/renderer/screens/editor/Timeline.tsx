import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RP, type ReactNode } from 'react';
import { clamp, flagsOf, fmtTime, type DecisionMeta, type Project, type Range } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject, type Selection } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { addZoom, patchItem, retime, seekSource } from './ops';

const GUTTER = 20;
const VIEW_LABEL: Record<string, { label: string; icon: IconName }> = {
  screen: { label: 'Screen', icon: 'screen' },
  camera: { label: 'Camera', icon: 'camera' },
  overlay: { label: 'Screen + camera', icon: 'layout' },
  split: { label: 'Split', icon: 'split' },
};

type ItemKind = 'cut' | 'speed' | 'layout' | 'zoom' | 'overlay' | 'broll' | 'mask' | 'lock';

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
  onChange(range: Range, key: string): void;
  onSelect(): void;
}

/** A draggable, resizable block on a lane. */
function Item({ kind, id, range, pps, duration, meta, selected, className = '', title, children, minLength = 0.3, onChange, onSelect }: ItemProps) {
  const drag = useRef<{ mode: 'move' | 'l' | 'r'; x: number; start: number; end: number; moved: boolean } | null>(null);
  const down = (mode: 'move' | 'l' | 'r') => (e: RP) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, start: range.start, end: range.end, moved: false };
    onSelect();
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
    if (d.mode === 'move') {
      const len = d.end - d.start;
      start = clamp(d.start + dt, 0, duration - len);
      end = start + len;
    } else if (d.mode === 'l') start = clamp(d.start + dt, 0, d.end - minLength);
    else end = clamp(d.end + dt, d.start + minLength, duration);
    onChange({ start, end }, `${kind}:${id}:${d.mode}`);
  };
  const up = () => (drag.current = null);
  const w = Math.max(3, (range.end - range.start) * pps);
  const locked = !!meta?.locked;
  return (
    <div
      className={`tl-item ${kind} ${meta ? (meta.origin === 'ai' ? 'ai' : 'you') : ''} ${selected ? 'selected' : ''} ${locked ? 'locked' : ''} ${className}`}
      style={{ left: range.start * pps, width: w }}
      title={title}
      role="button"
      tabIndex={0}
      aria-label={title}
      onPointerDown={down('move')}
      onPointerMove={move}
      onPointerUp={up}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
    >
      {w > 14 && !locked ? <span className="handle l" onPointerDown={down('l')} onPointerMove={move} onPointerUp={up} /> : null}
      <span className="tl-item-body">{children}</span>
      {locked ? <Icon name="lock" size={10} /> : null}
      {w > 14 && !locked ? <span className="handle r" onPointerDown={down('r')} onPointerMove={move} onPointerUp={up} /> : null}
    </div>
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
    const kept = map.keptRanges();
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
  const comparing = useApp((s) => !!s.comparison);
  const expanded = project.ui.expandedTimeline;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const map = timeMapOf(project);
  const flags = useMemo(() => flagsOf(project), [project.flags]);
  const duration = Math.max(0.1, project.duration);
  const fitPps = Math.max(2, (width - GUTTER - 24) / duration);
  // zoom 0 = whole recording fits; 1 = 240 px per second
  const scale = zoom <= 0.001 ? fitPps : fitPps * Math.pow(Math.max(1, 240 / fitPps), zoom);
  const contentWidth = Math.max(width - GUTTER, duration * scale + 24);

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
        select(null);
        seekSource(project, t);
      }
    },
  };

  const isSel = (kind: NonNullable<Selection>['kind'], id: string) => !!selection && 'id' in selection && selection.kind === kind && selection.id === id;
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
  const ro = comparing; // while comparing, the timeline is read-only

  const labelEvery = major;
  return (
    <div className={`timeline ${expanded ? 'expanded' : 'simple'}${ro ? ' readonly' : ''}`}>
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

          <Lane kind="clip" height={48} onBackground={ro ? undefined : clipHandlers}>
            <ClipCanvas project={project} pps={scale} scrollLeft={scrollLeft} width={Math.max(0, width - GUTTER)} height={48} />
            {e.speeds.map((s) => (
              <Item key={s.id} kind="speed" id={s.id} range={s} pps={scale} duration={duration} meta={s.meta} selected={isSel('speed', s.id)} title={`${s.speed}× speed`} onSelect={() => select({ kind: 'speed', id: s.id })} onChange={(r, k) => retime('speeds', s.id, r, k)}>
                <Icon name="speed" size={10} /> {s.speed}x
              </Item>
            ))}
            {e.cuts.map((c) => (
              <Item
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
              </Item>
            ))}
            {rangeSel ? <div className="tl-range" style={{ left: rangeSel.start * scale, width: Math.max(2, (rangeSel.end - rangeSel.start) * scale) }} /> : null}
          </Lane>

          <Lane kind="zoom" pps={scale} hint="Zoom" onAdd={ro || !project.sources.some((s) => s.role === 'screen') ? undefined : (t) => addZoom({ start: Math.max(0, t - 0.3), end: Math.min(duration, t + 2.7) })}>
            {e.zooms.map((z) => (
              <Item key={z.id} kind="zoom" id={z.id} range={z} pps={scale} duration={duration} meta={z.meta} minLength={0.6} selected={isSel('zoom', z.id)} title={`Zoom ${z.scale.toFixed(1)}×${z.follow ? ' · follows cursor' : ''}${z.meta.reason ? ` · ${z.meta.reason}` : ''}`} onSelect={() => select({ kind: 'zoom', id: z.id })} onChange={(r, k) => retime('zooms', z.id, r, k)}>
                <span className="tl-two">
                  <small><Icon name="pointer" size={10} /> Zoom{z.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
                  <span><Icon name="zoom" size={11} /> {z.scale.toFixed(z.scale % 1 ? 1 : 0)}x <Icon name="cursor" size={10} /> {z.follow ? 'Auto' : 'Manual'}</span>
                </span>
              </Item>
            ))}
            {e.zooms.length === 0 && !ro ? <span className="tl-empty">Click to add zoom on cursor</span> : null}
          </Lane>

          {expanded ? (
            <>
              <Lane kind="view" pps={scale}>
                {e.layouts.map((l) => (
                  <Item key={l.id} kind="layout" id={l.id} range={l} pps={scale} duration={duration} meta={l.meta} minLength={0.5} selected={isSel('layout', l.id)} title={`${VIEW_LABEL[l.mode]!.label}${l.mode !== 'screen' ? ` · camera ${l.camera}` : ''}${l.meta.reason ? ` · ${l.meta.reason}` : ''}`} onSelect={() => select({ kind: 'layout', id: l.id })} onChange={(r, k) => retime('layouts', l.id, r, k)}>
                    <span className="tl-two">
                      <small><Icon name="layout" size={10} /> Layout{l.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
                      <span><Icon name={VIEW_LABEL[l.mode]!.icon} size={11} /> {VIEW_LABEL[l.mode]!.label}{l.mode !== 'screen' ? ` ${l.camera}` : ''}</span>
                    </span>
                  </Item>
                ))}
                {e.layouts.length === 0 ? <span className="tl-empty">Layouts · select a range on the clip to change the view</span> : null}
              </Lane>
              <Lane kind="graphics" pps={scale}>
                {e.overlays.map((o) => (
                  <Item key={o.id} kind="overlay" id={o.id} range={o} pps={scale} duration={duration} meta={o.meta} minLength={0.8} selected={isSel('overlay', o.id)} title={`${o.kind}: ${o.text}`} onSelect={() => select({ kind: 'overlay', id: o.id })} onChange={(r) => patchItem('overlays', o.id, r, 'Move graphic')}>
                    <span className="tl-two">
                      <small><Icon name="text" size={10} /> {o.kind === 'callout' ? 'Callout' : o.kind === 'section-card' ? 'Section' : 'Lower third'}{o.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
                      <span>{o.text}</span>
                    </span>
                  </Item>
                ))}
                {e.broll.map((b) => (
                  <Item key={b.id} kind="broll" id={b.id} range={b} pps={scale} duration={duration} meta={b.meta} minLength={0.8} selected={isSel('broll', b.id)} title={`B-roll: ${assetName(b.assetId)}${b.meta.reason ? ` · ${b.meta.reason}` : ''}`} onSelect={() => select({ kind: 'broll', id: b.id })} onChange={(r, k) => retime('broll', b.id, r, k)}>
                    <span className="tl-two">
                      <small><Icon name="broll" size={10} /> B-roll{b.meta.origin === 'ai' ? <Icon name="sparkle" size={9} /> : null}</small>
                      <span>{assetName(b.assetId)}</span>
                    </span>
                  </Item>
                ))}
                {e.masks.map((m) => (
                  <Item key={m.id} kind="mask" id={m.id} range={m} pps={scale} duration={duration} meta={m.meta} selected={isSel('mask', m.id)} title={`${m.style} mask on ${m.target}`} onSelect={() => select({ kind: 'mask', id: m.id })} onChange={(r) => patchItem('masks', m.id, r, 'Move mask')}>
                    <span className="tl-two">
                      <small><Icon name="mask" size={10} /> Mask</small>
                      <span>{m.style === 'blur' ? 'Blur' : m.style === 'solid' ? 'Cover' : 'Spotlight'}</span>
                    </span>
                  </Item>
                ))}
                {e.overlays.length + e.broll.length + e.masks.length === 0 ? <span className="tl-empty">Graphics, B-roll and masks</span> : null}
              </Lane>
            </>
          ) : null}

          {/* locks span every lane */}
          <div className="tl-locks" style={{ left: GUTTER }}>
            {flags.map((f) => (
              <i key={f.id} className="tl-flagline" style={{ left: f.t * scale }} />
            ))}
            {e.locks.map((l) => (
              <button key={l.id} className={`tl-lock${isSel('lock', l.id) ? ' selected' : ''}`} style={{ left: l.start * scale, width: Math.max(4, (l.end - l.start) * scale) }} title={`Locked: ${l.note}`} onClick={() => select({ kind: 'lock', id: l.id })}>
                <Icon name="lock" size={10} />
              </button>
            ))}
          </div>
          <div className="tl-playhead" ref={headRef}>
            <i />
          </div>
        </div>
      </div>
    </div>
  );
}
