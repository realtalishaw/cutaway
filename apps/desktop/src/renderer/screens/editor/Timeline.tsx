import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RP, type ReactNode } from 'react';
import { clamp, fmtTime, type DecisionMeta, type Project, type Range } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject, type Selection } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { Button } from '../../ui/kit';
import { patchItem, retime, seekSource } from './ops';

const GUTTER = 84;
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

function Lane({ label, icon, height = 28, children, onBackground }: { label: string; icon: IconName; height?: number; children: ReactNode; onBackground?: { down(e: RP): void; move(e: RP): void; up(e: RP): void } }) {
  return (
    <div className="tl-lane" style={{ height }}>
      <div className="tl-gutter">
        <Icon name={icon} size={12} />
        <span>{label}</span>
      </div>
      <div className="tl-track" onPointerDown={onBackground?.down} onPointerMove={onBackground?.move} onPointerUp={onBackground?.up}>
        {children}
      </div>
    </div>
  );
}

/** Waveform + kept/cut shading, drawn only for the visible window so long projects stay cheap. */
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
    // kept footage
    ctx.fillStyle = 'rgba(255,236,214,0.055)';
    const endX = Math.min(width, x(project.duration));
    ctx.beginPath();
    ctx.roundRect(Math.max(0, x(0)), 3, Math.max(0, endX - Math.max(0, x(0))), height - 6, 6);
    ctx.fill();
    // waveform
    const wf = project.analysis?.waveform;
    const hz = project.analysis?.waveformHz ?? 20;
    if (wf && wf.length) {
      ctx.fillStyle = 'rgba(243,236,227,0.42)';
      const mid = height / 2;
      const step = Math.max(1, Math.floor(hz / pps));
      for (let i = Math.max(0, Math.floor(t0 * hz)); i < Math.min(wf.length, Math.ceil(t1 * hz)); i += step) {
        let v = 0;
        for (let j = i; j < Math.min(wf.length, i + step); j++) v = Math.max(v, wf[j]!);
        const h = Math.max(1, v * (height - 14));
        ctx.fillRect(x(i / hz), mid - h / 2, Math.max(1, (step / hz) * pps - 0.6), h);
      }
    } else {
      ctx.fillStyle = 'rgba(243,236,227,0.12)';
      ctx.fillRect(Math.max(0, x(0)), height / 2 - 0.5, Math.max(0, endX - Math.max(0, x(0))), 1);
    }
    // words as faint ticks when zoomed in enough
    if (pps > 60 && project.transcript) {
      ctx.fillStyle = 'rgba(243,236,227,0.5)';
      ctx.font = '10px "Hanken Grotesk Variable", sans-serif';
      for (const w of project.transcript.words) {
        if (w.end < t0 || w.start > t1) continue;
        if ((w.end - w.start) * pps > 22) ctx.fillText(project.edit.wordText[w.id] ?? w.text, x(w.start) + 2, height - 6, (w.end - w.start) * pps - 3);
      }
    }
  }, [project, pps, scrollLeft, width, height]);
  return <canvas ref={ref} className="tl-clip-canvas" style={{ width, height, transform: `translateX(${scrollLeft}px)` }} />;
}

function ticks(pps: number): { major: number; minor: number } {
  const options = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = options.find((s) => s * pps >= 84) ?? 600;
  return { major, minor: major / (major >= 10 ? 5 : 4) };
}

export function Timeline() {
  const project = useShownProject();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const comparing = useApp((s) => !!s.comparison);
  const expanded = project.ui.expandedTimeline;
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pps, setPps] = useState(0);
  const map = timeMapOf(project);
  const duration = Math.max(0.1, project.duration);
  const fitPps = Math.max(2, (width - GUTTER - 24) / duration);
  const scale = pps || fitPps;
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
        select(null);
        seekSource(project, timeAt(e.clientX));
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

  const zoomBy = (f: number) => {
    const sc = scrollRef.current;
    const center = sc ? (sc.scrollLeft + (sc.clientWidth - GUTTER) / 2) / scale : 0;
    const next = clamp(scale * f, fitPps, 400);
    setPps(next <= fitPps * 1.01 ? 0 : next);
    requestAnimationFrame(() => sc && (sc.scrollLeft = Math.max(0, center * next - (sc.clientWidth - GUTTER) / 2)));
  };

  const aiMarks = !expanded ? [...e.zooms, ...e.layouts, ...e.overlays, ...e.broll] : [];
  const assetName = (id: string) => project.sources.find((s) => s.id === id)?.name ?? 'Missing asset';
  const ro = comparing; // while comparing, the timeline is read-only

  return (
    <div className={`timeline ${expanded ? 'expanded' : 'simple'}${ro ? ' readonly' : ''}`}>
      <div className="tl-toolbar">
        <div className="seg">
          <button aria-pressed={!expanded} onClick={() => useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: false } }))}>Simple</button>
          <button aria-pressed={expanded} onClick={() => useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } }))} title="Show every lane (⌘T)">All lanes</button>
        </div>
        <span className="tiny dim">
          {fmtTime(map.outDuration)} final · {fmtTime(project.duration)} recorded · {e.cuts.length} cut{e.cuts.length === 1 ? '' : 's'}
        </span>
        <div className="grow" />
        <span className="row gap-2 tiny dim" aria-hidden>
          <i className="tl-swatch ai" /> AI <i className="tl-swatch you" style={{ marginLeft: 8 }} /> You <Icon name="lock" size={10} style={{ marginLeft: 8 }} /> Locked
        </span>
        <Button size="sm" variant="ghost" icon="minus" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom timeline out" title="Zoom out" />
        <Button size="sm" variant="ghost" onClick={() => setPps(0)} title="Fit whole recording">Fit</Button>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => zoomBy(1.5)} aria-label="Zoom timeline in" title="Zoom in" />
      </div>
      <div className="tl-scroll" ref={scrollRef} onScroll={(ev) => setScrollLeft(ev.currentTarget.scrollLeft)}>
        <div className="tl-content" style={{ width: GUTTER + contentWidth }}>
          <div className="tl-ruler" onPointerDown={rulerHandlers.down} onPointerMove={rulerHandlers.move} onPointerUp={rulerHandlers.up}>
            <div className="tl-gutter" />
            <div className="tl-track">
              {rulerTicks.map((t) => (
                <span key={t.t.toFixed(3)} className={`tick${t.major ? ' major' : ''}`} style={{ left: t.t * scale }}>
                  {t.major ? <b className="mono">{major < 1 ? `${fmtTime(t.t)}.${Math.round((t.t % 1) * 10)}` : fmtTime(t.t)}</b> : null}
                </span>
              ))}
            </div>
          </div>

          <Lane label="Footage" icon="scissors" height={expanded ? 56 : 64} onBackground={ro ? undefined : clipHandlers}>
            <ClipCanvas project={project} pps={scale} scrollLeft={scrollLeft} width={Math.max(0, width - GUTTER)} height={expanded ? 56 : 64} />
            {e.speeds.map((s) => (
              <Item key={s.id} kind="speed" id={s.id} range={s} pps={scale} duration={duration} meta={s.meta} selected={isSel('speed', s.id)} title={`${s.speed}× speed`} onSelect={() => select({ kind: 'speed', id: s.id })} onChange={(r, k) => retime('speeds', s.id, r, k)}>
                <Icon name="speed" size={10} /> {s.speed}×
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
                title={`${c.meta.origin === 'ai' ? 'AI' : 'Your'} cut · ${c.kind} · ${(c.end - c.start).toFixed(1)}s removed${c.meta.reason ? ` · ${c.meta.reason}` : ''}`}
                onSelect={() => select({ kind: 'cut', id: c.id })}
                onChange={(r) => patchItem('cuts', c.id, r, 'Adjust cut')}
              />
            ))}
            {rangeSel ? <div className="tl-range" style={{ left: rangeSel.start * scale, width: Math.max(2, (rangeSel.end - rangeSel.start) * scale) }} /> : null}
          </Lane>

          {expanded ? (
            <>
              <Lane label="View" icon="layout">
                {e.layouts.map((l) => (
                  <Item key={l.id} kind="layout" id={l.id} range={l} pps={scale} duration={duration} meta={l.meta} minLength={0.5} selected={isSel('layout', l.id)} className={`mode-${l.mode}`} title={`${VIEW_LABEL[l.mode]!.label}${l.mode !== 'screen' ? ` · camera ${l.camera}` : ''}${l.meta.reason ? ` · ${l.meta.reason}` : ''}`} onSelect={() => select({ kind: 'layout', id: l.id })} onChange={(r, k) => retime('layouts', l.id, r, k)}>
                    <Icon name={VIEW_LABEL[l.mode]!.icon} size={11} />
                    {VIEW_LABEL[l.mode]!.label}
                    {l.mode !== 'screen' ? <b className="mono cam">{l.camera}</b> : null}
                  </Item>
                ))}
              </Lane>
              <Lane label="Zoom" icon="zoom">
                {e.zooms.map((z) => (
                  <Item key={z.id} kind="zoom" id={z.id} range={z} pps={scale} duration={duration} meta={z.meta} minLength={0.6} selected={isSel('zoom', z.id)} title={`Zoom ${z.scale.toFixed(1)}×${z.follow ? ' · follows cursor' : ''}${z.meta.reason ? ` · ${z.meta.reason}` : ''}`} onSelect={() => select({ kind: 'zoom', id: z.id })} onChange={(r, k) => retime('zooms', z.id, r, k)}>
                    {z.scale.toFixed(1)}×
                  </Item>
                ))}
              </Lane>
              <Lane label="Graphics" icon="text">
                {e.overlays.map((o) => (
                  <Item key={o.id} kind="overlay" id={o.id} range={o} pps={scale} duration={duration} meta={o.meta} minLength={0.8} selected={isSel('overlay', o.id)} title={`${o.kind}: ${o.text}`} onSelect={() => select({ kind: 'overlay', id: o.id })} onChange={(r) => patchItem('overlays', o.id, r, 'Move graphic')}>
                    {o.text}
                  </Item>
                ))}
              </Lane>
              <Lane label="B-roll" icon="broll">
                {e.broll.map((b) => (
                  <Item key={b.id} kind="broll" id={b.id} range={b} pps={scale} duration={duration} meta={b.meta} minLength={0.8} selected={isSel('broll', b.id)} title={`B-roll: ${assetName(b.assetId)}${b.meta.reason ? ` · ${b.meta.reason}` : ''}`} onSelect={() => select({ kind: 'broll', id: b.id })} onChange={(r, k) => retime('broll', b.id, r, k)}>
                    {assetName(b.assetId)}
                  </Item>
                ))}
              </Lane>
              {e.masks.length ? (
                <Lane label="Masks" icon="mask">
                  {e.masks.map((m) => (
                    <Item key={m.id} kind="mask" id={m.id} range={m} pps={scale} duration={duration} meta={m.meta} selected={isSel('mask', m.id)} title={`${m.style} mask on ${m.target}`} onSelect={() => select({ kind: 'mask', id: m.id })} onChange={(r) => patchItem('masks', m.id, r, 'Move mask')}>
                      {m.style}
                    </Item>
                  ))}
                </Lane>
              ) : null}
            </>
          ) : (
            <Lane label="Decisions" icon="sparkle" height={18}>
              {aiMarks.map((m) => (
                <span key={m.id} className={`tl-mark ${m.meta.origin === 'ai' ? 'ai' : 'you'}`} style={{ left: m.start * scale, width: Math.max(3, (m.end - m.start) * scale) }} />
              ))}
            </Lane>
          )}

          {/* locks span every lane */}
          <div className="tl-locks" style={{ left: GUTTER }}>
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
