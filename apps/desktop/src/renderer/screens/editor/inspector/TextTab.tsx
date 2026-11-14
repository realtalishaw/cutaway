import { useEffect, useRef } from 'react';
import { TEXT_TEMPLATES, fmtTime, textStyleOf, type Overlay, type TextTemplate } from '@cutaway/core';
import { useProject } from '../../../state/store';
import { TEXT_FONT_CSS, drawTextOverlay, layoutText, textFontsToLoad } from '../../../engine/textOverlay';
import { Icon } from '../../../ui/icons';
import { seekSource } from '../ops';
import { addText } from '../titleSoundOps';
import { Section, app } from './shared';
import './titles-sound.css';

const GROUPS: TextTemplate['group'][] = ['Titles', 'Lower thirds', 'Cards', 'Labels'];

/** The overlays a template would make, laid out for a thumbnail. */
function previewOverlays(t: TextTemplate): Overlay[] {
  return t.parts.map((p, i) => ({ id: `tpl_${t.id}_${i}`, kind: 'text', start: 0, end: t.length, text: p.text, subtext: p.subtext, x: p.x, y: p.y, style: p.style, meta: { origin: 'creator', revision: 0 } }));
}

/** A stand-in for footage: soft colour fields, so white text and dark panels both read. */
function backdrop(ctx: CanvasRenderingContext2D, W: number, H: number, seed: number) {
  const palettes = [
    ['#1d2233', '#39507a', '#c98a5c'],
    ['#1b2420', '#2f6b5a', '#d7b56d'],
    ['#241a2b', '#6a3f7d', '#e08a8a'],
    ['#1a2230', '#2d5f8c', '#9fd0d6'],
  ];
  const [base, a, b] = palettes[seed % palettes.length]!;
  ctx.fillStyle = base!;
  ctx.fillRect(0, 0, W, H);
  const blob = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  ctx.globalAlpha = 0.85;
  blob(W * 0.22, H * 0.3, W * 0.55, a!);
  ctx.globalAlpha = 0.6;
  blob(W * 0.85, H * 0.8, W * 0.5, b!);
  ctx.globalAlpha = 1;
}

/**
 * A live thumbnail of a template, drawn by the same code that draws it in the video.
 * Hovering plays its arrival once.
 */
function Thumb({ template, aspect, seed }: { template: TextTemplate; aspect: number; seed: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);
  const overlays = previewOverlays(template);
  // laid out at the size of a real frame, then scaled down, so a thumbnail wraps like the video will
  const H = 1080;
  const W = Math.round(H * aspect);
  const paint = (sinceIn: number) => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    // Small text (a lower third, a label) would be a speck at thumbnail size: move in on it, as far as 3.4×.
    const blocks = overlays.map((o) => layoutText(ctx, o, W, H).block);
    const x0 = Math.min(...blocks.map((b) => b.x));
    const x1 = Math.max(...blocks.map((b) => b.x + b.w));
    const y0 = Math.min(...blocks.map((b) => b.y));
    const y1 = Math.max(...blocks.map((b) => b.y + b.h));
    const z = Math.max(1, Math.min(3.4, (0.78 * W) / Math.max(1, x1 - x0), (0.6 * H) / Math.max(1, y1 - y0)));
    const vx = Math.min(W - W / z, Math.max(0, (x0 + x1) / 2 - W / z / 2));
    const vy = Math.min(H - H / z, Math.max(0, (y0 + y1) / 2 - H / z / 2));
    const k = (c.width / W) * z;
    ctx.setTransform(k, 0, 0, k, -vx * k, -vy * k);
    backdrop(ctx, W, H, seed);
    for (const o of overlays) drawTextOverlay(ctx, o, sinceIn, 60, W, H);
  };
  useEffect(() => {
    let alive = true;
    paint(60);
    // the first paint may fall back to a system font: paint again once the template's fonts are in
    void Promise.all(textFontsToLoad(overlays).map((f) => document.fonts.load(f)))
      .then(() => alive && paint(60))
      .catch(() => {});
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
    };
  }, [template.id, aspect]); // eslint-disable-line react-hooks/exhaustive-deps
  const play = () => {
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    const longest = Math.max(...overlays.map((o) => textStyleOf(o).in.duration)) + 0.15;
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      paint(t);
      if (t < longest) raf.current = requestAnimationFrame(step);
      else paint(60);
    };
    raf.current = requestAnimationFrame(step);
  };
  const cw = 320;
  return <canvas ref={ref} width={cw} height={Math.round(cw / aspect)} onPointerEnter={play} aria-hidden />;
}

export function TextTab() {
  const project = useProject();
  const out = project.edit.appearance.output;
  // thumbnails keep the video's shape, within reason for a two-column grid
  const aspect = Math.min(16 / 9, Math.max(1, out.width / out.height));
  const texts = [...project.edit.overlays].sort((a, b) => a.start - b.start);
  const label = (o: Overlay) => (o.kind === 'text' ? 'Aa' : o.kind === 'callout' ? 'C' : o.kind === 'section-card' ? 'S' : 'L');
  return (
    <>
      <Section title="Text and titles">
        <div className="tiny dim">Click one to add it at the playhead. Everything about it can be changed afterwards.</div>
        {GROUPS.map((g) => (
          <div key={g} className="col" style={{ gap: 10 }}>
            <div className="tt-group">{g}</div>
            <div className="tt-grid">
              {TEXT_TEMPLATES.filter((t) => t.group === g).map((t, i) => (
                <button key={t.id} className="tt-card" data-testid={`tpl-${t.id}`} title={t.description} onClick={() => addText(t.id)}>
                  <span className="tt-thumb">
                    <Thumb template={t} aspect={aspect} seed={i + GROUPS.indexOf(g)} />
                    <span className="tt-add"><Icon name="plus" size={13} /></span>
                  </span>
                  <span className="tt-name">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </Section>
      {texts.length ? (
        <Section title="In this video">
          <div className="tt-list">
            {texts.map((o) => (
              <button key={o.id} className="tt-row" onClick={() => (seekSource(project, o.start + 0.01 + Math.min(0.6, (o.end - o.start) / 2)), app().select({ kind: 'overlay', id: o.id }))}>
                <span className="aa" style={o.kind === 'text' ? { fontFamily: TEXT_FONT_CSS[textStyleOf(o).font] } : undefined}>{label(o)}</span>
                <span className="t">{o.text || 'Empty text'}</span>
                <span className="when">{fmtTime(o.start)}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}
