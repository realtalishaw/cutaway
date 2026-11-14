/**
 * Free text overlays: layout and drawing. Called by the one compositor, so the preview and the export
 * draw the same pixels. Layout is a pure function of the overlay and the output size; the animation is
 * a pure function of time (core.textPose).
 */
import { TEXT_SAFE_MARGIN, fontWeightFor, shownText, textPose, textStyleOf, type Overlay, type Rect, type TextFont, type TextStyle } from '@cutaway/core';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const TEXT_FONT_CSS: Record<TextFont, string> = {
  inter: "'Inter Variable', 'Inter', -apple-system, sans-serif",
  grotesk: "'Hanken Grotesk Variable', 'Hanken Grotesk', 'Helvetica Neue', sans-serif",
  anton: "'Anton', 'Impact', sans-serif",
  serif: "'Instrument Serif', Georgia, serif",
  mono: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
};

export function textFontCss(font: TextFont, weight: number, px: number): string {
  return `${fontWeightFor(font, weight)} ${Math.max(1, px).toFixed(2)}px ${TEXT_FONT_CSS[font]}`;
}

/** Font strings to hand to `document.fonts.load` before an export, so no frame is drawn in a fallback face. */
export function textFontsToLoad(overlays: Overlay[]): string[] {
  const out = new Set<string>();
  for (const o of overlays) {
    if (o.kind !== 'text') continue;
    const s = textStyleOf(o);
    out.add(textFontCss(s.font, s.weight, 48));
    if (o.subtext) out.add(textFontCss(s.sub.font, s.sub.weight, 48));
  }
  return [...out];
}

interface Line {
  text: string;
  /** Left edge and baseline in output pixels, at rest. */
  x: number;
  y: number;
  width: number;
}

export interface TextLayout {
  style: TextStyle;
  fontPx: number;
  subPx: number;
  /** The whole block (background included), at rest. */
  block: Rect;
  radius: number;
  lines: Line[];
  subLines: Line[];
  accent: Rect | null;
  chars: number;
}

function setSpacing(ctx: Ctx, px: number) {
  // Chromium supports letterSpacing on canvas; where it is missing the text is simply set solid
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px.toFixed(3)}px`;
}

function wrap(ctx: Ctx, text: string, maxWidth: number, trackingPx: number): { text: string; width: number }[] {
  const out: { text: string; width: number }[] = [];
  // the spacing after the last letter is not part of the line
  const measure = (t: string) => Math.max(0, ctx.measureText(t).width - (t ? trackingPx : 0));
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push({ text: '', width: 0 });
      continue;
    }
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && measure(next) > maxWidth) {
        out.push({ text: cur, width: measure(cur) });
        cur = w;
      } else cur = next;
    }
    out.push({ text: cur, width: measure(cur) });
  }
  return out.slice(0, 12);
}

/** Where everything sits when the overlay is at rest. Sizes come from the output's short side. */
export function layoutText(ctx: Ctx, o: Overlay, W: number, H: number): TextLayout {
  const style = textStyleOf(o);
  const U = Math.min(W, H);
  const margin = TEXT_SAFE_MARGIN * U;
  const fontPx = style.size * U;
  const subPx = fontPx * style.sub.scale;
  const boxed = style.background.shape !== 'none';
  const padX = boxed ? fontPx * (style.background.shape === 'pill' ? 0.8 : 0.55) : 0;
  const padY = boxed ? fontPx * 0.4 : 0;
  const sideBar = !!style.accent && style.align !== 'center';
  const barW = sideBar ? Math.max(2, fontPx * 0.09) : 0;
  const barGap = sideBar ? fontPx * 0.34 : 0;
  const rule = !!style.accent && style.align === 'center';
  const ruleH = rule ? Math.max(2, fontPx * 0.06) : 0;
  const ruleW = rule ? fontPx * 1.15 : 0;
  const ruleGap = rule ? fontPx * 0.3 : 0;
  const maxText = Math.max(fontPx, Math.min(style.width * W, W - 2 * margin - 2 * padX - barW - barGap));

  const tracking = style.tracking * fontPx;
  ctx.font = textFontCss(style.font, style.weight, fontPx);
  setSpacing(ctx, tracking);
  const main = wrap(ctx, shownText(o.text, style.uppercase), maxText, tracking);
  const cap = ctx.measureText('H').actualBoundingBoxAscent || fontPx * 0.72;

  const subTracking = style.sub.tracking * subPx;
  ctx.font = textFontCss(style.sub.font, style.sub.weight, subPx);
  setSpacing(ctx, subTracking);
  const sub = o.subtext?.trim() ? wrap(ctx, shownText(o.subtext, style.sub.uppercase), maxText, subTracking).slice(0, 4) : [];
  const subCap = ctx.measureText('H').actualBoundingBoxAscent || subPx * 0.72;
  setSpacing(ctx, 0);

  const lineH = fontPx * style.leading;
  const subLineH = subPx * 1.3;
  const mainH = (main.length - 1) * lineH + fontPx;
  const subGap = sub.length ? fontPx * 0.2 : 0;
  const subH = sub.length ? (sub.length - 1) * subLineH + subPx : 0;
  const ruleBlock = rule ? ruleGap + ruleH + (sub.length ? ruleGap - subGap : 0) : 0;
  const contentW = Math.max(ruleW, ...main.map((l) => l.width), ...sub.map((l) => l.width));
  const contentH = mainH + ruleBlock + subGap + subH;
  const w = contentW + 2 * padX + barW + barGap;
  const h = contentH + 2 * padY;

  // the anchor is the edge the text is aligned to (or the centre), and the vertical middle
  let left = style.align === 'left' ? o.x * W : style.align === 'right' ? o.x * W - w : o.x * W - w / 2;
  let top = o.y * H - h / 2;
  left = Math.min(Math.max(left, margin), Math.max(margin, W - margin - w));
  top = Math.min(Math.max(top, margin), Math.max(margin, H - margin - h));

  const textLeft = left + padX + (style.align === 'right' ? 0 : barW + barGap);
  const lineX = (width: number) => (style.align === 'left' ? textLeft : style.align === 'right' ? textLeft + contentW - width : textLeft + (contentW - width) / 2);
  let y = top + padY;
  const lines: Line[] = main.map((l, i) => ({ text: l.text, width: l.width, x: lineX(l.width), y: y + i * lineH + fontPx / 2 + cap / 2 }));
  y += mainH;
  let accent: Rect | null = null;
  if (rule) {
    accent = { x: textLeft + (contentW - ruleW) / 2, y: y + ruleGap, w: ruleW, h: ruleH };
    y += ruleBlock;
  }
  y += subGap;
  const subLines: Line[] = sub.map((l, i) => ({ text: l.text, width: l.width, x: lineX(l.width), y: y + i * subLineH + subPx / 2 + subCap / 2 }));
  if (sideBar) accent = { x: style.align === 'right' ? left + w - padX - barW : left + padX, y: top + padY + fontPx * 0.06, w: barW, h: contentH - fontPx * 0.12 };

  const radius = !boxed ? 0 : style.background.shape === 'pill' ? h / 2 : Math.min(h / 2, fontPx * 0.24);
  const chars = [...lines, ...subLines].reduce((n, l) => n + [...l.text].length, 0);
  return { style, fontPx, subPx, block: { x: left, y: top, w, h }, radius, lines, subLines, accent, chars };
}

function alpha(hex: string, mul: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  const a = (h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1) * mul;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(4)})`;
}

function roundRectPath(ctx: Ctx, r: Rect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)));
}

/**
 * Draws one free text overlay. `sinceIn` / `untilOut` are output seconds since it appeared and until
 * it goes; everything that moves is derived from them.
 */
export function drawTextOverlay(ctx: Ctx, o: Overlay, sinceIn: number, untilOut: number, W: number, H: number): TextLayout | null {
  const L = layoutText(ctx, o, W, H);
  const { style, fontPx, subPx, block } = L;
  const pose = textPose(style, sinceIn, untilOut);
  if (pose.opacity <= 0.001) return L;
  ctx.save();
  if (style.scrim) {
    ctx.globalAlpha = pose.opacity * style.scrim.opacity;
    ctx.fillStyle = alpha(style.scrim.color, 1);
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = pose.opacity;
  // canvas shadows ignore the current transform, and the preview draws through one
  const t = ctx.getTransform();
  const k = Math.hypot(t.a, t.b);
  const cx = block.x + block.w / 2;
  const cy = block.y + block.h / 2;
  ctx.translate(cx, cy + pose.dy * fontPx);
  ctx.scale(pose.scale, pose.scale);
  ctx.translate(-cx, -cy);

  const boxed = style.background.shape !== 'none' && style.background.opacity > 0;
  const shadow = (on: boolean) => {
    if (on && style.shadow > 0) {
      ctx.shadowColor = `rgba(0,0,0,${(0.22 + 0.5 * style.shadow).toFixed(3)})`;
      ctx.shadowBlur = fontPx * (0.1 + 0.42 * style.shadow) * k * pose.scale;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = fontPx * 0.07 * style.shadow * k * pose.scale;
    } else {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
  };

  if (boxed) {
    shadow(true);
    ctx.fillStyle = alpha(style.background.color, style.background.opacity);
    roundRectPath(ctx, block, L.radius);
    ctx.fill();
    shadow(false);
  }
  if (L.accent && style.accent) {
    ctx.fillStyle = alpha(style.accent, 1);
    roundRectPath(ctx, L.accent, Math.min(L.accent.w, L.accent.h) / 2);
    ctx.fill();
  }

  // typewriter: letters arrive in reading order across every line
  let budget = pose.reveal >= 1 ? Infinity : Math.floor(pose.reveal * L.chars + 1e-6);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const draw = (lines: TextLayout['lines'], font: string, trackingPx: number, color: string, px: number) => {
    ctx.font = font;
    setSpacing(ctx, trackingPx);
    for (const line of lines) {
      if (budget <= 0) break;
      const glyphs = [...line.text];
      const text = budget >= glyphs.length ? line.text : glyphs.slice(0, budget).join('');
      budget -= glyphs.length;
      if (!text) continue;
      if (style.outline.width > 0) {
        shadow(!boxed);
        ctx.strokeStyle = alpha(style.outline.color, 1);
        ctx.lineWidth = style.outline.width * px * 2;
        ctx.strokeText(text, line.x, line.y);
        shadow(false);
      } else shadow(!boxed);
      ctx.fillStyle = alpha(color, 1);
      ctx.fillText(text, line.x, line.y);
      shadow(false);
    }
  };
  draw(L.lines, textFontCss(style.font, style.weight, fontPx), style.tracking * fontPx, style.color, fontPx);
  draw(L.subLines, textFontCss(style.sub.font, style.sub.weight, subPx), style.sub.tracking * subPx, style.sub.color, subPx);
  setSpacing(ctx, 0);
  ctx.restore();
  return L;
}

/** Editor only: a thin outline around the selected text, so it reads as something you can drag. */
export function drawTextSelection(ctx: Ctx, block: Rect, U: number) {
  const t = ctx.getTransform();
  const k = Math.max(1e-6, Math.hypot(t.a, t.b));
  const pad = U * 0.012;
  ctx.save();
  ctx.lineWidth = 1.5 / k;
  ctx.strokeStyle = 'rgba(129, 140, 248, 0.95)';
  ctx.setLineDash([6 / k, 4 / k]);
  ctx.strokeRect(block.x - pad, block.y - pad, block.w + pad * 2, block.h + pad * 2);
  ctx.restore();
}

let scratch: OffscreenCanvasRenderingContext2D | null = null;
/** A context for measuring text away from any visible canvas (hit-testing in the editor). */
export function measuringContext(): Ctx {
  scratch ??= new OffscreenCanvas(8, 8).getContext('2d')!;
  return scratch;
}
