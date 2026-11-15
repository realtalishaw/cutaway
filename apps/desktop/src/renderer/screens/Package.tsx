import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { disclosure, type DisclosureScope } from '@cutaway/ai';
import {
  DESCRIPTION_MAX,
  PALETTES,
  TITLE_MAX,
  buildThumbnail,
  chapterStamp,
  chaptersToOutput,
  checkChapters,
  checkDescription,
  checkTitle,
  covers,
  fmtTime,
  toSourceTime,
  uid,
  type MediaSource,
  type PackagingConcept,
  type Project,
  type ThumbTemplate,
  type ThumbnailLayer,
} from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useProject } from '../state/store';
import { generatePackaging } from '../jobs/packaging';
import { JobError, type JobContext, type StageState } from '../jobs/types';
import { drawThumbnail, hitTest, layerBox, layerFailed, layerLabel, prepareThumbnail } from '../engine/thumb';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Modal, Segmented, Slider, Toggle } from '../ui/kit';
import './package.css';
import { CraftWarnings } from './package/CraftWarnings';
import { ArtPanel } from './package/ArtPanel';
import { FalArtConsent } from './package/FalArtConsent';
import { ConsentSheet as ArtConsentSheet } from '../ui/Consent';
import { applyWholeThumbnail, artAllowed, artInUse, findArtSource, generateThumbnail, isWholeThumbnail, type ArtSource } from '../jobs/imagegen';
import { openSettingsAt } from './Settings';
import { aiInfo, consentCovers, useAiInfo } from '../state/jobs';

type TextLayer = Extract<ThumbnailLayer, { kind: 'text' }>;
type ShapeLayer = Extract<ThumbnailLayer, { kind: 'shape' }>;
type FrameLayer = Extract<ThumbnailLayer, { kind: 'frame' }>;
type ImageLayer = Extract<ThumbnailLayer, { kind: 'image' }>;
type ScrimLayer = Extract<ThumbnailLayer, { kind: 'scrim' }>;

const FULL_SCOPE: DisclosureScope[] = ['transcript', 'edit-metadata', 'frames'];
const SWATCHES = [...new Set(['#ffffff', PALETTES[0]!.paper, '#0d0b0a', ...PALETTES.map((p) => p.accent)])];
const LAYER_ICON: Record<ThumbnailLayer['kind'], IconName> = { frame: 'film', image: 'image', scrim: 'eye', shape: 'layout', text: 'text' };

// ───────────────────────────── store helpers ─────────────────────────────

function editLayers(conceptId: string, fn: (layers: ThumbnailLayer[]) => ThumbnailLayer[], label: string, key?: string) {
  useApp.getState().pack((p) => ({ ...p, concepts: p.concepts.map((c) => (c.id === conceptId ? { ...c, layers: fn(c.layers), editedByCreator: true } : c)) }), label, key);
}

function patchLayer(conceptId: string, layerId: string, patch: Record<string, unknown>, label: string, key?: string) {
  editLayers(conceptId, (ls) => ls.map((l) => (l.id === layerId ? ({ ...l, ...patch } as ThumbnailLayer) : l)), label, key ?? `thumb-${layerId}-${Object.keys(patch).join('-')}`);
}

function patchConcept(conceptId: string, patch: Partial<PackagingConcept>, label: string, key?: string) {
  useApp.getState().pack((p) => ({ ...p, concepts: p.concepts.map((c) => (c.id === conceptId ? { ...c, ...patch, editedByCreator: true } : c)) }), label, key);
}

function useRes() {
  const projectPath = useApp((s) => s.projectPath)!;
  const sources = useApp((s) => s.project!.sources);
  return useMemo(() => ({ projectPath, sources }), [projectPath, sources]);
}

// ───────────────────────────── static thumbnail ─────────────────────────────

function Thumb({ layers, pixels = 480, className, style }: { layers: ThumbnailLayer[]; pixels?: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const res = useRes();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let live = true;
    const W = pixels;
    const H = Math.round((W * 9) / 16);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d')!;
    drawThumbnail(ctx, layers, W, H);
    void prepareThumbnail(layers, res).then(() => live && drawThumbnail(ctx, layers, W, H));
    return () => {
      live = false;
    };
  }, [layers, pixels, res]);
  return <canvas ref={ref} className={className} style={{ width: '100%', aspectRatio: '16 / 9', display: 'block', ...style }} aria-hidden />;
}

// ───────────────────────────── interactive editor ─────────────────────────────

type Drag = { mode: 'move' | 'size' | 'width'; id: string; startX: number; startY: number; orig: ThumbnailLayer };

function ThumbEditor({ concept, selectedId, onSelect }: { concept: PackagingConcept; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const res = useRes();
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [, bump] = useState(0);
  const [guide, setGuide] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const layers = concept.layers;

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || size.w < 10) return;
    let live = true;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(size.w * dpr);
    const H = Math.round(size.h * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d')!;
    drawThumbnail(ctx, layers, W, H);
    void prepareThumbnail(layers, res).then(() => {
      if (!live) return;
      drawThumbnail(ctx, layers, W, H);
      bump((n) => n + 1); // selection box depends on loaded image sizes and fonts
    });
    return () => {
      live = false;
    };
  }, [layers, size, res]);

  const selected = layers.find((l) => l.id === selectedId) ?? null;
  const box = selected ? layerBox(selected, size.w, size.h) : null;

  const point = (e: RPointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = point(e);
    const handle = (e.target as HTMLElement).dataset.handle as Drag['mode'] | undefined;
    const id = handle && selected ? selected.id : hitTest(layers, p.x, p.y, size.w, size.h);
    onSelect(id);
    stage.current?.focus();
    const orig = layers.find((l) => l.id === id);
    if (!orig) return;
    drag.current = { mode: handle ?? 'move', id: orig.id, startX: p.x, startY: p.y, orig };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = (p.x - d.startX) / size.w;
    const dy = (p.y - d.startY) / size.h;
    if (Math.abs(p.x - d.startX) + Math.abs(p.y - d.startY) < 2) return;
    const o = d.orig;
    const key = `thumb-drag-${d.id}-${d.mode}`;
    if (d.mode === 'move') {
      if (o.kind === 'scrim') return;
      let x = o.x + dx;
      let y = o.y + dy;
      if (o.kind === 'frame') {
        // a frame always covers the canvas: stop at its edges instead of exposing a gap
        const fb = layerBox(o, size.w, size.h);
        const hx = fb.w / size.w / 2;
        const hy = fb.h / size.h / 2;
        patchLayer(concept.id, d.id, { x: clamp(x, 1 - hx, hx), y: clamp(y, 1 - hy, hy) }, 'Reposition frame', key);
        return;
      }
      // snap the layer's centre to the canvas centre
      const b = layerBox(o, size.w, size.h);
      const cx = (b.x + b.w / 2) / size.w + dx;
      const cy = (b.y + b.h / 2) / size.h + dy;
      const snapV = !e.altKey && Math.abs(cx - 0.5) < 0.012;
      const snapH = !e.altKey && Math.abs(cy - 0.5) < 0.018;
      if (snapV) x += 0.5 - cx;
      if (snapH) y += 0.5 - cy;
      setGuide({ v: snapV, h: snapH });
      patchLayer(concept.id, d.id, { x: clamp(x, -0.6, 1.6), y: clamp(y, -0.6, 1.6) }, 'Move layer', key);
    } else if (d.mode === 'size') {
      if (o.kind === 'shape') patchLayer(concept.id, d.id, { w: clamp(o.w + dx, 0.01, 1.6), h: clamp(o.h + dy, 0.006, 1.6) }, 'Resize shape', key);
      else if (o.kind === 'text') patchLayer(concept.id, d.id, { size: clamp(o.size * (1 + dy * 2.4), 0.03, 0.5) }, 'Resize text', key);
      else if (o.kind === 'image') patchLayer(concept.id, d.id, { scale: clamp(o.scale + dx * 2, 0.03, 2) }, 'Resize image', key);
    } else if (d.mode === 'width' && o.kind === 'text') {
      const factor = o.align === 'center' ? 2 : o.align === 'right' ? -1 : 1;
      patchLayer(concept.id, d.id, { maxWidth: clamp(o.maxWidth + dx * factor, 0.08, 1.2) }, 'Change text width', key);
    }
  };

  const onUp = () => {
    drag.current = null;
    setGuide({ v: false, h: false });
  };

  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (!selected) return;
    const step = e.shiftKey ? 0.02 : 0.004;
    const move = (dx: number, dy: number) => {
      e.preventDefault();
      if (selected.kind === 'scrim') return;
      patchLayer(concept.id, selected.id, { x: selected.x + dx, y: selected.y + dy }, 'Nudge layer', `thumb-nudge-${selected.id}`);
    };
    if (e.key === 'ArrowLeft') move(-step, 0);
    else if (e.key === 'ArrowRight') move(step, 0);
    else if (e.key === 'ArrowUp') move(0, -step * (16 / 9));
    else if (e.key === 'ArrowDown') move(0, step * (16 / 9));
    else if (e.key === 'Escape') onSelect(null);
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      editLayers(concept.id, (ls) => ls.filter((l) => l.id !== selected.id), 'Delete layer');
      onSelect(null);
    }
  };

  return (
    <div
      ref={stage}
      className="thumb-stage"
      tabIndex={0}
      role="application"
      aria-label="Thumbnail canvas. Click a layer to select it, drag to move, arrow keys to nudge, Delete to remove."
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      <canvas ref={canvas} />
      {guide.v ? <i className="guide v" /> : null}
      {guide.h ? <i className="guide h" /> : null}
      {selected && box ? (
        box.full ? (
          <div className="sel full">
            <span className="sel-tag">{selected.kind === 'frame' ? 'Frame · drag to reposition' : 'Shade · adjust in the inspector'}</span>
          </div>
        ) : (
          <div className="sel" style={{ left: box.x, top: box.y, width: box.w, height: box.h, transformOrigin: `${box.cx - box.x}px ${box.cy - box.y}px`, transform: `rotate(${box.rotation}deg)` }}>
            {selected.kind === 'text' ? <b className="handle e" data-handle="width" title="Drag to change the text box width" /> : null}
            <b className="handle se" data-handle="size" title="Drag to resize" />
          </div>
        )
      ) : null}
    </div>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ───────────────────────────── inspector ─────────────────────────────

function Swatches({ value, onChange, allowNone, allowTransparent, label }: { value: string | null; onChange: (v: string | null) => void; allowNone?: boolean; allowTransparent?: boolean; label: string }) {
  const custom = value && value !== 'transparent' && !SWATCHES.includes(value.toLowerCase()) ? value : null;
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="swatches" role="group" aria-label={label}>
        {allowNone ? (
          <button className={`swatch none${value === null ? ' on' : ''}`} onClick={() => onChange(null)} aria-pressed={value === null} title="None" aria-label="None" />
        ) : null}
        {allowTransparent ? (
          <button className={`swatch clear${value === 'transparent' ? ' on' : ''}`} onClick={() => onChange('transparent')} aria-pressed={value === 'transparent'} title="Transparent" aria-label="Transparent" />
        ) : null}
        {SWATCHES.map((c) => (
          <button key={c} className={`swatch${value?.toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-pressed={value?.toLowerCase() === c} title={c} aria-label={`Colour ${c}`} />
        ))}
        <label className={`swatch custom${custom ? ' on' : ''}`} style={custom ? { background: custom } : undefined} title="Custom colour">
          <input type="color" value={custom ?? '#ff5a36'} onChange={(e) => onChange(e.target.value)} aria-label={`Custom ${label.toLowerCase()}`} />
          {custom ? null : <Icon name="plus" size={10} />}
        </label>
      </div>
    </div>
  );
}

function XY({ layer, set }: { layer: { x: number; y: number }; set: (patch: Record<string, unknown>, label: string) => void }) {
  return (
    <div className="two">
      <Slider label="Across" value={layer.x} min={-0.2} max={1.2} step={0.005} onChange={(x) => set({ x }, 'Move layer')} format={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Down" value={layer.y} min={-0.2} max={1.2} step={0.005} onChange={(y) => set({ y }, 'Move layer')} format={(v) => `${Math.round(v * 100)}%`} />
    </div>
  );
}

function TextInspector({ l, set }: { l: TextLayer; set: (patch: Record<string, unknown>, label: string) => void }) {
  const weighted = l.font === 'grotesk' || l.font === 'mono';
  return (
    <>
      <label className="field">
        <span className="label">
          Text <span className="value">{l.text.trim().split(/\s+/).filter(Boolean).length} words</span>
        </span>
        <textarea className="textarea" rows={2} value={l.text} onChange={(e) => set({ text: e.target.value }, 'Edit thumbnail text')} aria-label="Thumbnail text" />
      </label>
      <div className="field">
        <span className="label">Typeface</span>
        <Segmented
          full
          label="Typeface"
          value={l.font}
          onChange={(font) => set({ font }, 'Change typeface')}
          options={[
            { value: 'display', label: 'Poster' },
            { value: 'grotesk', label: 'Grotesk' },
            { value: 'serif', label: 'Serif' },
            { value: 'mono', label: 'Mono' },
          ]}
        />
      </div>
      <div className="two">
        <Slider label="Size" value={l.size} min={0.04} max={0.36} step={0.002} onChange={(size) => set({ size }, 'Resize text')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Box width" value={l.maxWidth} min={0.1} max={1.1} step={0.01} onChange={(maxWidth) => set({ maxWidth }, 'Change text width')} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
      {weighted ? <Slider label="Weight" value={l.weight} min={300} max={900} step={50} onChange={(weight) => set({ weight }, 'Change weight')} format={(v) => String(v)} /> : null}
      <div className="row between">
        <Segmented
          label="Alignment"
          value={l.align}
          onChange={(align) => set({ align }, 'Change alignment')}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
            { value: 'right', label: 'Right' },
          ]}
        />
        <button className={`btn sm${l.uppercase ? ' on' : ''}`} aria-pressed={l.uppercase} onClick={() => set({ uppercase: !l.uppercase }, 'Toggle capitals')} title="All capitals">
          AA
        </button>
      </div>
      <Swatches label="Colour" value={l.color} onChange={(c) => set({ color: c ?? '#ffffff' }, 'Change text colour')} />
      <Swatches label="Outline" value={l.stroke} allowNone onChange={(stroke) => set({ stroke, strokeWidth: stroke ? Math.max(l.strokeWidth, 0.008) : 0 }, 'Change outline')} />
      {l.stroke ? <Slider label="Outline width" value={l.strokeWidth} min={0.002} max={0.03} step={0.001} onChange={(strokeWidth) => set({ strokeWidth }, 'Change outline')} format={(v) => `${(v * 100).toFixed(1)}%`} /> : null}
      <Swatches label="Plate behind text" value={l.background} allowNone onChange={(background) => set({ background }, 'Change text plate')} />
      <Slider label="Rotation" value={l.rotation} min={-20} max={20} step={0.5} onChange={(rotation) => set({ rotation }, 'Rotate text')} format={(v) => `${v.toFixed(1)}°`} />
      <XY layer={l} set={set} />
    </>
  );
}

function ShapeInspector({ l, set }: { l: ShapeLayer; set: (patch: Record<string, unknown>, label: string) => void }) {
  return (
    <>
      <div className="field">
        <span className="label">Shape</span>
        <Segmented
          full
          label="Shape"
          value={l.shape}
          onChange={(shape) => set({ shape }, 'Change shape')}
          options={[
            { value: 'rect', label: 'Block' },
            { value: 'pill', label: 'Pill' },
            { value: 'circle', label: 'Circle' },
          ]}
        />
      </div>
      <Swatches label="Colour" value={l.color} onChange={(c) => set({ color: c ?? '#ffffff' }, 'Change shape colour')} />
      <div className="two">
        <Slider label="Width" value={l.w} min={0.01} max={1.2} step={0.005} onChange={(w) => set({ w }, 'Resize shape')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Height" value={l.h} min={0.006} max={1.2} step={0.002} onChange={(h) => set({ h }, 'Resize shape')} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
      <div className="two">
        <Slider label="Rotation" value={l.rotation} min={-45} max={45} step={0.5} onChange={(rotation) => set({ rotation }, 'Rotate shape')} format={(v) => `${v.toFixed(1)}°`} />
        <Slider label="Opacity" value={l.opacity} min={0.05} max={1} onChange={(opacity) => set({ opacity }, 'Change opacity')} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
      <XY layer={l} set={set} />
    </>
  );
}

function FrameInspector({ l, set, sources }: { l: FrameLayer; set: (patch: Record<string, unknown>, label: string) => void; sources: MediaSource[] }) {
  const visual = sources.filter((s) => s.kind !== 'audio' && s.available);
  const src = sources.find((s) => s.id === l.sourceId);
  const [scrub, setScrub] = useState(l.time);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setScrub(l.time), [l.time, l.id]);
  const scrubTo = (t: number) => {
    setScrub(t);
    // decode a still only once the creator pauses on a moment
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => set({ time: t }, 'Pick another moment'), 140);
  };
  return (
    <>
      {layerFailed(l) ? (
        <Banner tone="danger" title="This frame could not be read">
          {src ? (src.available ? 'The file could not be decoded at this moment.' : `“${src.name}” is missing. Relink it in Sources.`) : 'Its source is no longer in the project.'}
        </Banner>
      ) : null}
      <label className="field">
        <span className="label">Taken from</span>
        <select className="select" value={l.sourceId} onChange={(e) => set({ sourceId: e.target.value, time: Math.min(l.time, Math.max(0, (sources.find((s) => s.id === e.target.value)?.duration ?? 0) - 0.1)) }, 'Change frame source')}>
          {!src ? <option value={l.sourceId}>Missing source</option> : null}
          {visual.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {src && src.kind === 'video' ? <Slider label="Moment in the footage" value={scrub} min={0} max={Math.max(0.1, src.duration - 0.05)} step={0.05} onChange={scrubTo} format={(v) => fmtTime(v, true)} /> : null}
      <div className="tiny dim">A real frame of your recording. Nothing is generated or retouched.</div>
      <Slider label="Scale" value={l.scale} min={1} max={3} step={0.01} onChange={(scale) => set({ scale }, 'Scale frame')} format={(v) => `${v.toFixed(2)}×`} />
      <XY layer={l} set={set} />
      <div className="two">
        <Slider label="Brightness" value={l.brightness} min={0.3} max={1.6} onChange={(brightness) => set({ brightness }, 'Change brightness')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Saturation" value={l.saturation} min={0} max={2} onChange={(saturation) => set({ saturation }, 'Change saturation')} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
      <Slider label="Blur" value={l.blur} min={0} max={0.03} step={0.0005} onChange={(blur) => set({ blur }, 'Change blur')} format={(v) => (v === 0 ? 'Off' : `${(v * 100).toFixed(1)}%`)} />
      <Toggle label="Mirror" hint="Flips the frame left to right. Text on screen will read backwards." checked={l.mirror} onChange={(mirror) => set({ mirror }, 'Mirror frame')} />
    </>
  );
}

function ImageInspector({ l, set }: { l: ImageLayer; set: (patch: Record<string, unknown>, label: string) => void }) {
  return (
    <>
      <div className="well tiny muted mono" style={{ padding: '7px 9px', wordBreak: 'break-all' }}>
        {l.path}
      </div>
      <div className="two">
        <Slider label="Width" value={l.scale} min={0.03} max={1.6} step={0.005} onChange={(scale) => set({ scale }, 'Resize image')} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Opacity" value={l.opacity} min={0.05} max={1} onChange={(opacity) => set({ opacity }, 'Change opacity')} format={(v) => `${Math.round(v * 100)}%`} />
      </div>
      <XY layer={l} set={set} />
    </>
  );
}

function ScrimInspector({ l, set }: { l: ScrimLayer; set: (patch: Record<string, unknown>, label: string) => void }) {
  return (
    <>
      <div className="tiny dim">A shade over the frame that keeps the words readable.</div>
      <div className="field">
        <span className="label">Darkest side</span>
        <Segmented
          full
          label="Direction"
          value={String(((l.angle % 360) + 360) % 360)}
          onChange={(a) => set({ angle: Number(a) }, 'Change shade direction')}
          options={
            l.from === 'transparent'
              ? [
                  { value: '270', label: 'Left' },
                  { value: '90', label: 'Right' },
                  { value: '0', label: 'Top' },
                  { value: '180', label: 'Bottom' },
                ]
              : [
                  { value: '90', label: 'Left' },
                  { value: '270', label: 'Right' },
                  { value: '180', label: 'Top' },
                  { value: '0', label: 'Bottom' },
                ]
          }
        />
      </div>
      <Swatches label="Shade colour" value={l.from === 'transparent' ? l.to : l.from} onChange={(c) => set(l.from === 'transparent' ? { to: c ?? '#0d0b0a' } : { from: c ?? '#0d0b0a' }, 'Change shade colour')} />
      <Slider label="Strength" value={l.opacity} min={0} max={1} onChange={(opacity) => set({ opacity }, 'Change shade strength')} format={(v) => `${Math.round(v * 100)}%`} />
    </>
  );
}

function templateOf(concept: PackagingConcept): ThumbTemplate | null {
  const shape = concept.layers.find((l): l is ShapeLayer => l.kind === 'shape');
  const text = concept.layers.find((l): l is TextLayer => l.kind === 'text');
  if (!shape || !text) return null;
  if (shape.shape === 'pill') return 'badge';
  if (shape.w > 0.9) return 'banner';
  if (text.align === 'left') return 'headline';
  return null;
}

function Layers({ concept, selectedId, onSelect }: { concept: PackagingConcept; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const sources = useApp((s) => s.project!.sources);
  const res = useRes();
  const top = [...concept.layers].reverse();
  const move = (id: string, dir: 1 | -1) =>
    editLayers(
      concept.id,
      (ls) => {
        const i = ls.findIndex((l) => l.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= ls.length) return ls;
        const next = [...ls];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return next;
      },
      'Reorder layers',
    );
  const insert = (layer: ThumbnailLayer, atBottom = false) => {
    editLayers(
      concept.id,
      (ls) => {
        if (!atBottom) return [...ls, layer];
        // a frame goes above existing frames and below shade, shapes and text
        const lastFrame = ls.reduce((acc, l, i) => (l.kind === 'frame' ? i : acc), -1);
        return [...ls.slice(0, lastFrame + 1), layer, ...ls.slice(lastFrame + 1)];
      },
      'Add layer',
    );
    onSelect(layer.id);
  };
  const addText = () =>
    insert({ id: uid('tl'), kind: 'text', text: 'New text', x: 0.5, y: 0.3, size: 0.1, maxWidth: 0.7, font: 'display', weight: 800, color: '#ffffff', stroke: null, strokeWidth: 0, background: null, rotation: 0, align: 'center', uppercase: true });
  const addShape = () => insert({ id: uid('tl'), kind: 'shape', shape: 'pill', x: 0.38, y: 0.12, w: 0.24, h: 0.085, color: PALETTES[0]!.accent, rotation: 0, opacity: 1 });
  const addFrame = () => {
    const project = useApp.getState().project!;
    const session = timeMapOf(project).toSource(usePlayback.getState().time);
    const order: MediaSource['role'][] = ['cameraA', 'screen', 'cameraB'];
    const src = order.map((r) => project.sources.find((s) => s.role === r && s.available && covers(s, session))).find(Boolean) ?? project.sources.find((s) => s.kind === 'video' && s.available);
    if (!src) return useApp.getState().toast('There is no video source to take a frame from.', 'error');
    const time = clamp(toSourceTime(src.sync, session), 0, Math.max(0, src.duration - 0.1));
    insert({ id: uid('tl'), kind: 'frame', sourceId: src.id, time, x: 0.5, y: 0.5, scale: 1.04, brightness: 1, saturation: 1.08, blur: 0, mirror: false }, true);
  };
  const addImage = async () => {
    const [file] = await window.cutaway.app.pickFiles({ title: 'Add an image to the thumbnail', kinds: ['image'], multiple: false });
    if (!file) return;
    insert({ id: uid('tl'), kind: 'image', path: file, x: 0.78, y: 0.3, scale: 0.28, opacity: 1 });
    void prepareThumbnail([{ id: 'probe', kind: 'image', path: file, x: 0, y: 0, scale: 1, opacity: 1 }], res);
  };
  return (
    <section className="col" style={{ gap: 8 }}>
      <div className="row between">
        <div className="pkg-heading">Layers</div>
        <div className="row gap-2">
          <Button size="sm" variant="ghost" icon="text" onClick={addText} title="Add text" aria-label="Add text" />
          <Button size="sm" variant="ghost" icon="layout" onClick={addShape} title="Add a shape" aria-label="Add a shape" />
          <Button size="sm" variant="ghost" icon="film" onClick={addFrame} title="Add the frame at the playhead" aria-label="Add the frame at the playhead" />
          <Button size="sm" variant="ghost" icon="image" onClick={() => void addImage()} title="Add an image file" aria-label="Add an image file" />
        </div>
      </div>
      <ul className="layer-list">
        {top.map((l, i) => (
          <li key={l.id} className={l.id === selectedId ? 'on' : ''}>
            <button className="layer-pick" onClick={() => onSelect(l.id)} aria-pressed={l.id === selectedId}>
              <Icon name={LAYER_ICON[l.kind]} size={13} />
              <span className="layer-name">{layerLabel(l, sources)}</span>
              {layerFailed(l) ? <Icon name="warn" size={12} style={{ color: 'var(--danger)' }} /> : null}
            </button>
            <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(l.id, 1)} title="Bring forward" aria-label="Bring forward">
              <Icon name="chevronDown" size={12} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <button className="btn ghost icon sm" disabled={i === top.length - 1} onClick={() => move(l.id, -1)} title="Send back" aria-label="Send back">
              <Icon name="chevronDown" size={12} />
            </button>
            <button
              className="btn ghost icon sm"
              onClick={() => {
                editLayers(concept.id, (ls) => ls.filter((x) => x.id !== l.id), 'Delete layer');
                if (selectedId === l.id) onSelect(null);
              }}
              title="Delete layer"
              aria-label="Delete layer"
            >
              <Icon name="trash" size={12} />
            </button>
          </li>
        ))}
        {top.length === 0 ? <li className="tiny dim" style={{ padding: 10 }}>No layers. Add text or a frame.</li> : null}
      </ul>
    </section>
  );
}

function Inspector({ concept, selectedId, onSelect }: { concept: PackagingConcept; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const sources = useApp((s) => s.project!.sources);
  const layer = concept.layers.find((l) => l.id === selectedId) ?? null;
  const set = useCallback((patch: Record<string, unknown>, label: string) => layer && patchLayer(concept.id, layer.id, patch, label), [concept.id, layer]);
  const current = templateOf(concept);
  const relayout = (t: ThumbTemplate) => {
    const frame = concept.layers.find((l): l is FrameLayer => l.kind === 'frame');
    const text = concept.layers.find((l): l is TextLayer => l.kind === 'text');
    const colours = new Set(concept.layers.flatMap((l) => (l.kind === 'shape' ? [l.color.toLowerCase()] : [])));
    const palette = PALETTES.find((p) => colours.has(p.accent)) ?? PALETTES[0]!;
    editLayers(concept.id, () => buildThumbnail(t, frame ? { sourceId: frame.sourceId, time: frame.time } : null, text?.text ?? concept.title, palette), 'Change layout');
    onSelect(null);
  };
  const recolour = (i: number) => {
    const from = PALETTES.find((p) => concept.layers.some((l) => l.kind === 'shape' && l.color.toLowerCase() === p.accent)) ?? null;
    const to = PALETTES[i]!;
    const swap = (c: string | null): string | null => {
      if (!c || !from) return c;
      const k = c.toLowerCase();
      return k === from.accent ? to.accent : k === from.ink ? to.ink : k === from.paper ? to.paper : c;
    };
    editLayers(
      concept.id,
      (ls) =>
        ls.map((l) => {
          if (l.kind === 'shape') return { ...l, color: from ? swap(l.color)! : to.accent };
          if (l.kind === 'text') return { ...l, color: swap(l.color)!, stroke: swap(l.stroke), background: swap(l.background) };
          if (l.kind === 'scrim') return { ...l, from: l.from === 'transparent' ? l.from : swap(l.from)!, to: l.to === 'transparent' ? l.to : swap(l.to)! };
          return l;
        }),
      'Change palette',
    );
  };
  return (
    <aside className="pkg-right scroll" aria-label="Thumbnail inspector">
{/* A whole AI thumbnail is one picture: layouts and palettes do not apply to it. */}
      {isWholeThumbnail(concept) ? null : (
            <section className="col" style={{ gap: 8 }}>
        <div className="pkg-heading">Layout</div>
        <Segmented
          full
          label="Thumbnail layout"
          value={current ?? ('custom' as ThumbTemplate | 'custom')}
          onChange={(t) => t !== 'custom' && relayout(t)}
          options={[
            { value: 'headline', label: 'Headline', title: 'Words on the left, frame on the right' },
            { value: 'banner', label: 'Banner', title: 'Tilted colour band across the bottom' },
            { value: 'badge', label: 'Badge', title: 'Big centred words over a dimmed frame' },
          ]}
        />
        <div className="row between">
          <span className="tiny dim">{current ? 'Switching re-lays out the same words and frame.' : 'Custom layout. Picking one re-lays it out.'}</span>
          <div className="row gap-2" role="group" aria-label="Palette">
            {PALETTES.map((p, i) => (
              <button key={p.accent} className="palette-dot" style={{ background: p.accent }} onClick={() => recolour(i)} title={`Palette ${i + 1}`} aria-label={`Palette ${i + 1}`} />
            ))}
          </div>
        </div>
      </section>
      )}
      <hr className="hr" />
      <Layers concept={concept} selectedId={selectedId} onSelect={onSelect} />
      <hr className="hr" />
      <ArtPanel concept={concept} />
      <hr className="hr" />
      {layer ? (
        <section className="col" style={{ gap: 12 }} key={layer.id}>
          <div className="pkg-heading" style={{ textTransform: 'capitalize' }}>{layer.kind === 'scrim' ? 'Shade' : layer.kind}</div>
          {layer.kind === 'text' ? <TextInspector l={layer} set={set} /> : null}
          {layer.kind === 'shape' ? <ShapeInspector l={layer} set={set} /> : null}
          {layer.kind === 'frame' ? <FrameInspector l={layer} set={set} sources={sources} /> : null}
          {layer.kind === 'image' ? <ImageInspector l={layer} set={set} /> : null}
          {layer.kind === 'scrim' ? <ScrimInspector l={layer} set={set} /> : null}
        </section>
      ) : (
        <div className="tiny dim" style={{ padding: '4px 2px' }}>
          Select a layer on the canvas or in the list to change its text, colour, framing or position.
        </div>
      )}
    </aside>
  );
}

// ───────────────────────────── concepts column ─────────────────────────────

function ConceptCard({ concept, index, focused, selected, onFocus, onChoose, project }: { concept: PackagingConcept; index: number; focused: boolean; selected: boolean; onFocus: () => void; onChoose: () => void; project: Project }) {
  const seek = (sessionTime: number) => {
    const map = timeMapOf(project);
    const kept = map.isKept(sessionTime);
    const out = map.toOutput(sessionTime);
    usePlayback.getState().seek(out);
    useApp.getState().toast(kept ? `Playhead moved to ${fmtTime(out)}` : `That moment was cut; playhead moved to the next kept frame at ${fmtTime(out)}`, 'info', { label: 'Watch in Edit', run: () => useApp.getState().setView('edit') });
  };
  return (
    <article className={`concept rise${focused ? ' focused' : ''}${selected ? ' selected' : ''}`} style={{ animationDelay: `${index * 60}ms` }}>
      <button className="concept-thumb" onClick={onFocus} aria-label={`Edit concept ${index + 1}: ${concept.title}`} aria-pressed={focused}>
        <Thumb layers={concept.layers} pixels={560} />
        {selected ? (
          <span className="pill accent chosen">
            <Icon name="check" size={10} /> Chosen
          </span>
        ) : null}
      </button>
      <div className="concept-body">
        <div className="concept-title">{concept.title || <span className="dim">Untitled</span>}</div>
        <div className="row gap-2 wrap">
          <span className={`pill ${concept.origin === 'ai' ? 'ai' : ''}`}>
            <Icon name={concept.origin === 'ai' ? 'sparkle' : 'pencil'} size={10} />
            {concept.origin === 'ai' ? `From ${concept.aiProvider === 'codex' ? 'Codex' : 'Claude'}` : 'From your words'}
          </span>
          {concept.layers.some((l) => l.kind === 'image' && l.generated) ? (
            <span className="pill ai" title="The background picture was made by an AI image model" data-testid="art-pill">
              <Icon name="image" size={10} /> AI picture
            </span>
          ) : null}
          {concept.editedByCreator ? (
            <span className="pill you">
              <Icon name="pencil" size={10} /> Edited by you
            </span>
          ) : null}
        </div>
        {concept.rationale ? <p className="tiny muted concept-why">{concept.rationale}</p> : null}
        {concept.evidence.length ? (
          <div className="evidence">
            {concept.evidence.slice(0, 3).map((e, i) => (
              <button key={i} className="evidence-chip" onClick={() => seek(e.sessionTime)} title="Jump to this moment in the edit">
                <span className="mono">{fmtTime(timeMapOf(project).toOutput(e.sessionTime))}</span>
                <span className="quote">“{e.quote}”</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant={selected ? 'default' : 'primary'} icon={selected ? 'check' : undefined} disabled={selected} onClick={onChoose}>
            {selected ? 'Chosen pair' : 'Choose this pair'}
          </Button>
        </div>
      </div>
    </article>
  );
}

// ───────────────────────────── consent ─────────────────────────────

function ConsentSheet({ onAllow, onDecline, onClose }: { onAllow: () => void; onDecline: () => void; onClose: () => void }) {
  const ai = useAiInfo();
  const d = disclosure(FULL_SCOPE, ai.id);
  return (
    <Modal
      eyebrow={`Before anything leaves this Mac · ${ai.company}`}
      title={`Let ${ai.name} read the finished cut?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onDecline}>Use on-device templates only</Button>
          <Button variant="primary" icon="sparkle" onClick={onAllow} data-autofocus>
            Allow {ai.company} for this project
          </Button>
        </>
      }
    >
      <div className="col consent" style={{ gap: 14 }}>
        <div>
          <div className="label">Where it goes</div>
          <p>{d.destination}. The model does not run on this Mac.</p>
        </div>
        <div className="two">
          <div>
            <div className="label">What is sent</div>
            <ul>
              {d.leaves.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="label">What is never sent</div>
            <ul>
              {d.stays.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        </div>
        <div>
          <div className="label">Why</div>
          <p>{d.purpose}</p>
        </div>
        <div className="two">
          <div>
            <div className="label">Cost</div>
            <p>{d.cost}</p>
          </div>
          <div>
            <div className="label">Retention</div>
            <p>{d.retention}</p>
          </div>
        </div>
        <p className="tiny dim" style={{ margin: 0 }}>
          {d.decline.replace('assembles the cut with its built-in rules', 'builds the concepts from your own words')} You can withdraw this in Settings.
        </p>
      </div>
    </Modal>
  );
}

// ───────────────────────────── title, preview, text ─────────────────────────────

function TitleCard({ concept, others }: { concept: PackagingConcept; others: PackagingConcept[] }) {
  const check = checkTitle(concept.title);
  const over = concept.title.trim().length > TITLE_MAX;
  return (
    <section className="card col" style={{ gap: 10 }}>
      <label className="field">
        <span className="label">
          Title
          <span className="value" style={over ? { color: 'var(--danger)' } : undefined}>
            {concept.title.trim().length} / {TITLE_MAX}
          </span>
        </span>
        <input className="input title-input" value={concept.title} onChange={(e) => patchConcept(concept.id, { title: e.target.value }, 'Edit title', `title-${concept.id}`)} aria-invalid={!check.ok} aria-label="Video title" />
      </label>
      {!check.ok ? (
        <div className="tiny" style={{ color: 'var(--danger)' }} role="alert">
          <Icon name="warn" size={11} style={{ verticalAlign: -2, marginRight: 5 }} />
          {check.problem}
        </div>
      ) : null}
      {others.length ? (
        <div className="col" style={{ gap: 4 }}>
          <span className="label">Alternatives, exported in title-options.txt</span>
          {others.map((o) => (
            <div key={o.id} className="alt-title">
              <span className="grow">{o.title}</span>
              <Button size="sm" variant="ghost" onClick={() => patchConcept(concept.id, { title: o.title }, 'Use alternative title')}>
                Use here
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BrowsePreview({ concept, duration }: { concept: PackagingConcept; duration: number }) {
  return (
    <section className="col" style={{ gap: 8 }}>
      <div className="row between">
        <div className="pkg-heading">At browsing size</div>
        <span className="tiny dim">168 × 94 points, as in a results list</span>
      </div>
      <div className="browse">
        {(['dark', 'light'] as const).map((mode) => (
          <div key={mode} className={`browse-row ${mode}`}>
            <div className="browse-thumb">
              <Thumb layers={concept.layers} pixels={336} />
              <span className="browse-time">{fmtTime(duration)}</span>
            </div>
            <div className="browse-meta">
              <div className="browse-title">{concept.title || 'Untitled'}</div>
              <div className="browse-sub">Your channel</div>
              <div className="browse-sub">Preview only</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function parseStamp(text: string): number | null {
  const parts = text.trim().split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function StampInput({ value, onCommit }: { value: number; onCommit: (seconds: number) => void }) {
  const [draft, setDraft] = useState(chapterStamp(value));
  useEffect(() => setDraft(chapterStamp(value)), [value]);
  const commit = () => {
    const s = parseStamp(draft);
    if (s === null) return setDraft(chapterStamp(value));
    onCommit(s);
  };
  return <input className="input mono stamp" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Chapter time in the finished video" />;
}

function TextSection({ project }: { project: Project }) {
  const map = timeMapOf(project);
  const pack = useApp((s) => s.pack);
  const d = checkDescription(project.packaging.description);
  const chapters = project.packaging.chapters;
  const out = chaptersToOutput(chapters, map);
  const cc = checkChapters(out, map.outDuration);
  const sorted = chapters.map((c, i) => ({ c, i })).sort((a, b) => a.c.sessionTime - b.c.sessionTime);
  const setChapter = (i: number, patch: Partial<Project['packaging']['chapters'][number]>, key?: string) => pack((p) => ({ ...p, chapters: p.chapters.map((c, j) => (j === i ? { ...c, ...patch } : c)) }), 'Edit chapter', key);
  return (
    <div className="pkg-text">
      <section className="card col" style={{ gap: 10 }}>
        <label className="field">
          <span className="label">
            Description
            <span className="value" style={!d.ok ? { color: 'var(--danger)' } : undefined}>
              {project.packaging.description.length.toLocaleString()} / {DESCRIPTION_MAX.toLocaleString()}
            </span>
          </span>
          <textarea className="textarea" rows={7} value={project.packaging.description} placeholder="What the video covers, in your own words." onChange={(e) => pack((p) => ({ ...p, description: e.target.value }), 'Edit description', 'pkg-description')} aria-invalid={!d.ok} />
        </label>
        {!d.ok ? (
          <div className="tiny" style={{ color: 'var(--danger)' }} role="alert">
            {d.problem}
          </div>
        ) : (
          <div className="tiny dim">Exported as description.txt. Left out of the package when empty.</div>
        )}
      </section>
      <section className="card col" style={{ gap: 10 }}>
        <div className="row between">
          <span className="label" style={{ margin: 0 }}>
            Chapters
          </span>
          {chapters.length === 0 ? null : cc.valid ? (
            <span className="pill ok">
              <Icon name="check" size={10} /> Valid for YouTube
            </span>
          ) : (
            <span className="pill warn">
              <Icon name="warn" size={10} /> Section notes only
            </span>
          )}
        </div>
        {chapters.length === 0 ? (
          <div className="tiny dim">No chapters. Add at least three, each ten seconds or longer, starting at 00:00.</div>
        ) : (
          <ul className="chapters">
            {sorted.map(({ c, i }) => (
              <li key={i}>
                <StampInput value={map.toOutput(c.sessionTime)} onCommit={(s) => setChapter(i, { sessionTime: map.toSource(Math.min(s, map.outDuration)) })} />
                <input className="input" value={c.title} placeholder="Chapter title" onChange={(e) => setChapter(i, { title: e.target.value }, `chapter-title-${i}`)} aria-label="Chapter title" />
                {!map.isKept(c.sessionTime) && c.sessionTime > 0.5 ? (
                  <span className="pill warn" title="This chapter's starting moment was cut, so it lands on the next kept frame.">
                    moved
                  </span>
                ) : null}
                <button className="btn ghost icon sm" onClick={() => pack((p) => ({ ...p, chapters: p.chapters.filter((_, j) => j !== i) }), 'Remove chapter')} aria-label="Remove chapter" title="Remove chapter">
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {chapters.length > 0 && !cc.valid ? (
          <Banner tone="warn" title={cc.problems[0]}>
            Until this is fixed, chapters.txt is exported as plain section notes rather than YouTube chapters.
          </Banner>
        ) : null}
        <div className="row between">
          <span className="tiny dim">Times follow the cut: they are recalculated from the edit every time.</span>
          <Button
            size="sm"
            icon="plus"
            onClick={() => {
              const t = chapters.length === 0 ? 0 : map.toSource(usePlayback.getState().time);
              pack((p) => ({ ...p, chapters: [...p.chapters, { sessionTime: t, title: chapters.length === 0 ? 'Intro' : '' }] }), 'Add chapter');
            }}
          >
            {chapters.length === 0 ? 'Add first chapter' : `Add at playhead (${fmtTime(usePlayback.getState().time)})`}
          </Button>
        </div>
      </section>
    </div>
  );
}

// ───────────────────────────── screen ─────────────────────────────

interface Gen {
  status: 'idle' | 'running' | 'failed';
  stages: StageState[];
  error: string | null;
  note: string | null;
  abort: AbortController | null;
}

export function Package() {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const settings = useApp((s) => s.settings);
  const pkg = project.packaging;
  const map = timeMapOf(project);
  const [gen, setGen] = useState<Gen>({ status: 'idle', stages: [], error: null, note: null, abort: null });
  const [consentOpen, setConsentOpen] = useState(false);
  // Pictures: who can make them, the "nothing can make pictures" question, the consent to ask, and a run in progress.
  const artSource = useRef<ArtSource | null>(null);
  const [needArt, setNeedArt] = useState<Awaited<ReturnType<typeof findArtSource>> | null>(null);
  const [artAsk, setArtAsk] = useState<ArtSource | null>(null);
  const [pictures, setPictures] = useState<{ app: string; done: number; total: number; abort: AbortController } | null>(null);
  const [picturesNote, setPicturesNote] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(pkg.selectedId);
  const [layerId, setLayerId] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  const focused = pkg.concepts.find((c) => c.id === focusId) ?? pkg.concepts.find((c) => c.id === pkg.selectedId) ?? pkg.concepts[0] ?? null;
  useEffect(() => {
    if (focused && !focused.layers.some((l) => l.id === layerId)) setLayerId(null);
  }, [focused, layerId]);

  // Honest "still working" note instead of a made-up percentage.
  useEffect(() => {
    setSlow(false);
    if (gen.status !== 'running') return;
    const t = setTimeout(() => setSlow(true), 30000);
    return () => clearTimeout(t);
  }, [gen.status, gen.stages]);

  const run = useCallback(
    async (useClaude: boolean, whyLocal?: string) => {
      if (!settings) return;
      const abort = new AbortController();
      setGen({ status: 'running', stages: [], error: null, note: null, abort });
      const ctx: JobContext = {
        projectPath,
        get: () => useApp.getState().project!,
        update: (fn) => {
          const app = useApp.getState();
          const cur = app.project!;
          const next = fn(cur);
          if (next.packaging !== cur.packaging) app.replace(next, 'Create thumbnail and title concepts');
          else app.patch(() => next);
        },
        setStages: (stages) => setGen((g) => ({ ...g, stages })),
        signal: abort.signal,
        settings,
        useClaude,
        provider: aiInfo().id,
      };
      try {
        const r = await generatePackaging(ctx);
        const note = [r.ai.mode === 'local-rules' ? `Built on this Mac from your own words. ${whyLocal ?? r.ai.reason ?? ''}`.trim() : null, ...r.notes].filter(Boolean).join(' ');
        setGen({ status: 'idle', stages: [], error: null, note: note || null, abort: null });
        setFocusId(useApp.getState().project!.packaging.selectedId);
        const src = artSource.current;
        if (src) {
          if (artAllowed(useApp.getState().project, src)) void makePictures(src);
          else setArtAsk(src);
        }
      } catch (e) {
        const cancelled = e instanceof JobError && e.code === 'cancelled';
        setGen((g) => ({ status: cancelled ? 'idle' : 'failed', stages: g.stages, error: cancelled ? null : e instanceof Error ? e.message : String(e), note: cancelled ? 'Cancelled. Nothing was changed.' : null, abort: null }));
      }
    },
    [projectPath, settings], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** An AI picture for each new concept that has none, one after another. Text stays the creator's own layer. */
  const makePictures = async (src: ArtSource) => {
    const app = useApp.getState();
    const todo = app.project!.packaging.concepts.filter((c) => !artInUse(c) && !isWholeThumbnail(c) && !c.editedByCreator).slice(0, 3);
    if (!todo.length) return;
    const abort = new AbortController();
    setPicturesNote(null);
    let made = 0;
    const failures: string[] = [];
    for (let i = 0; i < todo.length; i++) {
      setPictures({ app: src.app, done: i, total: todo.length, abort });
      const now = useApp.getState();
      const concept = now.project!.packaging.concepts.find((c) => c.id === todo[i]!.id);
      if (!concept) continue;
      const res = await generateThumbnail({ projectPath, project: now.project!, concept, direction: '', signal: abort.signal, notes: now.settings?.playbookNotes?.thumbnails ?? null, source: src });
      if (abort.signal.aborted) break;
      if (!res.ok) {
        failures.push(res.message);
        continue;
      }
      made++;
      useApp.getState().pack((p) => ({ ...p, concepts: p.concepts.map((c) => (c.id === concept.id ? applyWholeThumbnail(c, res.art) : c)) }), 'Make AI thumbnail');
    }
    setPictures(null);
    setPicturesNote(
      abort.signal.aborted
        ? `Stopped. ${made} picture${made === 1 ? '' : 's'} made.`
        : failures.length
          ? `${made} of ${todo.length} thumbnails made with ${src.app}. ${failures[0]}`
          : `Made ${made} thumbnail${made === 1 ? '' : 's'} with ${src.app}. Ask for changes or make more under AI thumbnail on the right.`,
    );
  };

  const create = useCallback(async (skipArtCheck = false) => {
    // Good thumbnails need a picture generator. Without one, say so and let the creator choose.
    const art = await findArtSource().catch(() => null);
    artSource.current = art?.source ?? null;
    if (!skipArtCheck && art && !art.source) return void setNeedArt(art);
    let status = useApp.getState().claude;
    try {
      status = await window.cutaway.ai.status();
      useApp.setState({ claude: status });
    } catch {
      /* treated as unavailable below */
    }
    const signedIn = !!status?.found && status.signedIn === true;
    const app = aiInfo().app;
    if (!signedIn) return void run(false, !status?.found ? `${app} is not installed on this Mac, so nothing was sent anywhere.` : `${app} is not signed in on this Mac, so nothing was sent anywhere.`);
    // Asked again after a switch of provider: consent to one never covers the other.
    if (consentCovers(useApp.getState().project, FULL_SCOPE)) return void run(true);
    setConsentOpen(true);
  }, [run]);

  const allow = () => {
    setConsentOpen(false);
    const d = disclosure(FULL_SCOPE, aiInfo().id);
    useApp.getState().patch((p) => ({ ...p, consent: { provider: d.provider, scope: FULL_SCOPE, grantedAt: new Date().toISOString() } }));
    void run(true);
  };

  const choose = (id: string) => useApp.getState().pack((p) => ({ ...p, selectedId: id, reviewed: true }), 'Choose thumbnail and title');
  const running = gen.status === 'running';
  const stage = gen.stages.find((s) => s.status === 'running') ?? gen.stages[gen.stages.length - 1] ?? null;
  const claude = useApp((s) => s.claude);
  const ai = useAiInfo();

  const allowArt = (src: ArtSource) => {
    setArtAsk(null);
    useApp.getState().patch((p) => ({ ...p, artConsent: { provider: src.consent, grantedAt: new Date().toISOString() } }));
    void makePictures(src);
  };
  const consent = (
    <>
      {consentOpen ? <ConsentSheet onAllow={allow} onDecline={() => (setConsentOpen(false), void run(false))} onClose={() => setConsentOpen(false)} /> : null}
      {needArt ? (
        <Modal
          eyebrow="Thumbnails"
          title={<>Connect an image generator for better thumbnails</>}
          onClose={() => setNeedArt(null)}
          footer={
            <>
              <Button onClick={() => (setNeedArt(null), void create(true))} data-testid="art-gate-continue">Continue without pictures</Button>
              <Button variant="primary" icon="gear" onClick={() => (setNeedArt(null), openSettingsAt('generation'))} data-autofocus data-testid="art-gate-fal">Add a fal.ai key</Button>
            </>
          }
        >
          <div className="col gap-4" data-testid="art-gate">
            <div>Cutaway designs each thumbnail as one finished AI picture: you, the props and the words, in a format that is working on YouTube now. Nothing on this Mac can make pictures yet. Set up one of these:</div>
            <div className="well" style={{ padding: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Codex</div>
              <div className="col" style={{ gap: 8 }}>
                <span>{needArt.codexFound ? 'Codex is installed but not signed in. Sign in with your ChatGPT account.' : 'Install Codex and sign in with your ChatGPT account. See Settings → AI tools.'}</span>
                {needArt.codexFound ? (
                  <div>
                    <Button size="sm" icon="external" onClick={() => void window.cutaway.ai.signIn('codex').then((r) => useApp.getState().toast(r.message))}>Sign in to Codex…</Button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="well" style={{ padding: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>fal.ai</div>
              <div>Add your fal.ai API key in Settings → AI generation. Each picture spends a little of your fal.ai credit.</div>
            </div>
            <div className="tiny dim">Without either, the three thumbnails are simple layouts: a frame of your video with text on it. They work, but won't look as good.</div>
          </div>
        </Modal>
      ) : null}
      {artAsk?.id === 'codex' ? <ArtConsentSheet purpose="thumbnail pictures" provider="codex" scope={[]} images onClose={() => setArtAsk(null)} onDecline={() => setArtAsk(null)} onAllow={() => allowArt(artAsk)} /> : null}
      {artAsk?.id === 'fal' ? <FalArtConsent onClose={() => setArtAsk(null)} onDecline={() => setArtAsk(null)} onAllow={() => allowArt(artAsk)} /> : null}
    </>
  );
  const picturesBanner = pictures ? (
    <div className="gen-progress" role="status" aria-live="polite" data-testid="pictures-progress">
      <div className="row between">
        <span className="row" style={{ gap: 8 }}>
          <span className="spinner" />
          <b>Making thumbnails with {pictures.app}: {pictures.done + 1} of {pictures.total}</b>
        </span>
        <Button size="sm" variant="ghost" onClick={() => pictures.abort.abort()}>Stop</Button>
      </div>
      <div className="tiny muted">Each takes up to a minute. Your thumbnails are ready to edit meanwhile.</div>
    </div>
  ) : picturesNote ? (
    <Banner tone="info">{picturesNote}</Banner>
  ) : null;

  const progress = running ? (
    <div className="gen-progress" role="status" aria-live="polite">
      <div className="row between">
        <span className="row" style={{ gap: 8 }}>
          <span className="spinner" />
          <b>{stage?.label ?? 'Creating concepts'}</b>
          {stage?.remote ? <span className="pill ai">Sending text and stills to {ai.name}</span> : <span className="pill">On this Mac</span>}
        </span>
        <Button size="sm" variant="ghost" onClick={() => gen.abort?.abort()}>
          Cancel
        </Button>
      </div>
      <div className="tiny muted">{stage?.detail ?? 'Picking real frames from the finished cut…'}</div>
      <div className="progress indeterminate">
        <i />
      </div>
      {slow ? <div className="tiny dim">Still working. This step has no measurable progress; you can cancel or keep waiting, and nothing is lost either way.</div> : null}
    </div>
  ) : null;

  if (pkg.concepts.length === 0) {
    return (
      <div className="page pkg-empty">
        <div className="page-inner" style={{ maxWidth: 860 }}>
          <h1 className="display h2" style={{ margin: 0 }}>Thumbnail and title</h1>
          <p className="muted" style={{ maxWidth: 620, lineHeight: 1.5, margin: '8px 0 0' }}>
            Three pairs built from real frames of your {fmtTime(map.outDuration)} cut and the words you said. Pick one, then change the text, framing, colours and layout.
          </p>
          <div className="card empty-card">
            {progress ?? (
              <>
                <div className="ghost-row" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="ghost-thumb" style={{ animationDelay: `${i * 120}ms` }}>
                      <Icon name="image" size={20} />
                    </div>
                  ))}
                </div>
                {gen.status === 'failed' ? (
                  <Banner tone="danger" title="The concepts could not be created" action={<Button size="sm" onClick={() => void run(false)}>Use on-device templates</Button>}>
                    {gen.error} Your project and edit are untouched.
                  </Banner>
                ) : null}
                {gen.note ? <Banner tone="info">{gen.note}</Banner> : null}
                {map.outDuration < 0.5 ? <Banner tone="warn" title="The edit is empty">Restore some footage in Edit before packaging.</Banner> : null}
                <div className="row between wrap" style={{ gap: 12 }}>
                  <span className="tiny dim" style={{ maxWidth: 420 }}>
                    {claude?.found && claude.signedIn
                      ? `With your permission, ${ai.name} reads the transcript and a few stills (sent to ${ai.company}). Video and audio never leave this Mac.`
                      : `${ai.app} is not signed in on this Mac, so concepts are built on-device from your own words. Sign in from Settings to use ${ai.name}.`}
                  </span>
                  <div className="row">
                    {claude?.found && claude.signedIn ? (
                      <Button onClick={() => void run(false)} disabled={map.outDuration < 0.5}>
                        On-device templates only
                      </Button>
                    ) : null}
                    <Button variant="primary" size="lg" icon="sparkle" onClick={() => void create()} disabled={map.outDuration < 0.5}>
                      Create three concepts
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        {consent}
      </div>
    );
  }

  const others = pkg.concepts.filter((c) => c.id !== focused?.id && c.title.trim());
  return (
    <div className="pkg">
      <aside className="pkg-left scroll" aria-label="Concepts">
        <div className="row between">
          <div className="pkg-heading">Concepts <span className="dim">{pkg.concepts.length}</span></div>
          <Button size="sm" variant="ai" icon="sparkle" busy={running} onClick={() => void create()} title="Adds new concepts. The ones you edited or chose are kept.">
            New concepts
          </Button>
        </div>
        {pkg.stale ? (
          <Banner tone="warn" icon="history" title="Made for an earlier cut">
            {pkg.staleReason ?? 'The edit changed since these were made.'} Chapter and caption times already follow the new cut; check that the thumbnail and title still describe it.
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => useApp.getState().pack((p) => ({ ...p, stale: false, staleReason: null, reviewed: true, basedOnRevision: useApp.getState().project!.revision }), 'Confirm packaging still fits')}>
                Still fits
              </Button>
              <Button size="sm" variant="ai" icon="sparkle" busy={running} onClick={() => void create()}>
                Refresh concepts
              </Button>
            </div>
          </Banner>
        ) : null}
        {progress}
        {gen.status === 'failed' ? (
          <Banner tone="danger" title="New concepts could not be created" action={<Button size="sm" onClick={() => void run(false)}>Use templates</Button>}>
            {gen.error} The concepts below are unchanged.
          </Banner>
        ) : null}
        {gen.note ? <Banner tone="info">{gen.note}</Banner> : null}
        {picturesBanner}
        {pkg.concepts.map((c, i) => (
          <ConceptCard key={c.id} concept={c} index={i} project={project} focused={c.id === focused?.id} selected={c.id === pkg.selectedId} onFocus={() => (setFocusId(c.id), setLayerId(null))} onChoose={() => (choose(c.id), setFocusId(c.id))} />
        ))}
        {!pkg.selectedId ? <div className="tiny dim">Nothing is chosen yet. Export needs one chosen pair, or it can only write a draft.</div> : null}
      </aside>

      {focused ? (
        <>
          <section className="pkg-center scroll">
            <div className="row between">
              <div className="row" style={{ gap: 8 }}>
                <div className="pkg-heading">Thumbnail</div>
                {focused.id === pkg.selectedId ? (
                  <span className="pill accent">
                    <Icon name="check" size={10} /> Chosen for export
                  </span>
                ) : (
                  <span className="pill">Not chosen</span>
                )}
              </div>
              <div className="row gap-2 tiny dim">
                <span className="kbd">←↑↓→</span> nudge <span className="kbd">⌫</span> delete <span className="kbd">⌘Z</span> undo
              </div>
            </div>
            <ThumbEditor key={focused.id} concept={focused} selectedId={layerId} onSelect={setLayerId} />
            <TitleCard concept={focused} others={others} />
            <CraftWarnings concept={focused} />
            <BrowsePreview concept={focused} duration={map.outDuration} />
            <TextSection project={project} />
          </section>
          <Inspector concept={focused} selectedId={layerId} onSelect={setLayerId} />
        </>
      ) : null}
      {consent}
    </div>
  );
}
