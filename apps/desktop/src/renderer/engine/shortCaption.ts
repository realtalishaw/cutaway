/**
 * Word-by-word captions for shorts, drawn by the one compositor so preview
 * and export match. Fonts come from the bundled set that free text uses
 * (textOverlay.ts). Everything is a function of the cue and the output time.
 */
import { SHORT_SAFE, activeWord, shortCaptionLook, type Cue, type Rect, type ShortCaptions } from '@cutaway/core';
import { textFontCss } from './textOverlay';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Font string to load before drawing, so the first frames are not set in a fallback face. */
export function shortCaptionFont(captions: ShortCaptions): string {
  const look = shortCaptionLook(captions.preset);
  return textFontCss(look.font, look.weight, 48);
}

interface Placed {
  text: string;
  index: number;
  x: number;
  y: number;
  w: number;
}

export interface ShortCaptionLayout {
  /** Box around every line, in output pixels. */
  block: Rect;
  words: Placed[];
  size: number;
  lineHeight: number;
}

const ease = (p: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

function setSpacing(ctx: Ctx, px: number) {
  // Chromium supports letterSpacing on canvas; where it is missing the text is simply set solid.
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px.toFixed(3)}px`;
}

/** Where each word of a cue sits. Lines are centred and never wider than the clear area. */
export function layoutShortCaption(ctx: Ctx, cue: Cue, captions: ShortCaptions, W: number, H: number): ShortCaptionLayout {
  const look = shortCaptionLook(captions.preset);
  const U = Math.min(W, H);
  const texts = (cue.words ?? cue.text.split(' ').map((text) => ({ text }))).map((w) => (look.uppercase ? w.text.toUpperCase() : w.text));
  const maxWidth = SHORT_SAFE.width * W;
  let size = look.size * U * Math.min(1.4, Math.max(0.7, captions.size || 1));
  let lines: { words: { text: string; index: number; w: number }[]; width: number }[] = [];
  let space = 0;
  // One very long word is shrunk to fit instead of running out of the frame.
  for (let attempt = 0; attempt < 4; attempt++) {
    ctx.font = textFontCss(look.font, look.weight, size);
    setSpacing(ctx, look.letterSpacing * size);
    space = ctx.measureText(' ').width + look.letterSpacing * size + size * 0.06;
    lines = [];
    let cur: { words: { text: string; index: number; w: number }[]; width: number } = { words: [], width: 0 };
    let widest = 0;
    texts.forEach((text, index) => {
      const w = ctx.measureText(text).width;
      widest = Math.max(widest, w);
      const next = cur.words.length ? cur.width + space + w : w;
      if (cur.words.length && next > maxWidth) {
        lines.push(cur);
        cur = { words: [{ text, index, w }], width: w };
      } else {
        cur.words.push({ text, index, w });
        cur.width = next;
      }
    });
    if (cur.words.length) lines.push(cur);
    if (widest <= maxWidth && lines.length <= 3) break;
    size *= Math.min(0.9, maxWidth / Math.max(1, widest));
  }
  const lineHeight = size * 1.16;
  const height = lines.length * lineHeight;
  const cy = Math.min(H * (1 - SHORT_SAFE.bottom) - height / 2, Math.max(H * SHORT_SAFE.top + height / 2, SHORT_SAFE.y[captions.position] * H));
  const top = cy - height / 2;
  const words: Placed[] = [];
  let widest = 0;
  lines.forEach((line, li) => {
    let x = (W - line.width) / 2;
    widest = Math.max(widest, line.width);
    for (const w of line.words) {
      words.push({ text: w.text, index: w.index, x, y: top + li * lineHeight + lineHeight / 2, w: w.w });
      x += w.w + space;
    }
  });
  return { block: { x: (W - widest) / 2, y: top, w: widest, h: height }, words, size, lineHeight };
}

/** Draw the caption line for one frame. `out` is the output time of the frame. */
export function drawShortCaption(ctx: Ctx, cue: Cue, out: number, captions: ShortCaptions, W: number, H: number): ShortCaptionLayout | null {
  if (captions.preset === 'off') return null;
  const look = shortCaptionLook(captions.preset);
  ctx.save();
  const laid = layoutShortCaption(ctx, cue, captions, W, H);
  const { size } = laid;
  const active = activeWord(cue, out);
  // The line arrives with a small, quick pop.
  const arrive = ease((out - cue.start) / 0.09);
  const cx = W / 2;
  const cyBlock = laid.block.y + laid.block.h / 2;
  ctx.globalAlpha *= 0.25 + 0.75 * arrive;
  ctx.translate(cx, cyBlock);
  ctx.scale(0.94 + 0.06 * arrive, 0.94 + 0.06 * arrive);
  ctx.translate(-cx, -cyBlock);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  if (look.panel) {
    const px = size * 0.42;
    const py = size * 0.2;
    ctx.save();
    ctx.globalAlpha *= look.panel.opacity;
    ctx.fillStyle = look.panel.color;
    ctx.beginPath();
    ctx.roundRect(laid.block.x - px, laid.block.y - py, laid.block.w + 2 * px, laid.block.h + 2 * py, size * 0.3);
    ctx.fill();
    ctx.restore();
  }

  const spokenAt = (i: number) => cue.words?.[i]?.start ?? cue.start;
  for (const w of laid.words) {
    const isActive = w.index === active;
    const said = active >= 0 && w.index <= active;
    ctx.save();
    if (isActive && look.bump > 0) {
      const k = 1 + look.bump * ease((out - spokenAt(w.index)) / 0.08);
      ctx.translate(w.x + w.w / 2, w.y);
      ctx.scale(k, k);
      ctx.translate(-(w.x + w.w / 2), -w.y);
    }
    if (look.active === 'box' && isActive) {
      const px = size * 0.2;
      const py = size * 0.02;
      ctx.fillStyle = look.activeColor;
      ctx.beginPath();
      ctx.roundRect(w.x - px, w.y - laid.lineHeight / 2 + py, w.w + 2 * px, laid.lineHeight - 2 * py, size * 0.22);
      ctx.fill();
    }
    if (look.active === 'dim' && !said) ctx.globalAlpha *= look.restOpacity ?? 0.5;
    const onBox = look.active === 'box' && isActive;
    if (look.shadow > 0 && !onBox) {
      ctx.shadowColor = `rgba(0,0,0,${(0.6 * look.shadow).toFixed(3)})`;
      ctx.shadowBlur = size * 0.2 * look.shadow;
      ctx.shadowOffsetY = size * 0.05;
    }
    if (look.outline) {
      ctx.strokeStyle = look.outline.color;
      ctx.lineWidth = look.outline.width * size;
      ctx.strokeText(w.text, w.x, w.y);
      // the shadow belongs to the outline; the fill on top stays crisp
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = onBox ? (look.onBox ?? '#ffffff') : isActive && look.active === 'color' ? look.activeColor : look.color;
    ctx.fillText(w.text, w.x, w.y);
    ctx.restore();
  }
  ctx.restore();
  return laid;
}
