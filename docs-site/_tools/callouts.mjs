// Numbered callouts for the docs screenshots.
//
// While shots.mjs drives the app, `measure()` reads where the buttons are (from selectors), and `saveMarks()` stores
// those boxes in _tools/marks.json next to the name of the screenshot. annotate.mjs then draws rings and numbered
// badges on a copy of each screenshot in images/annotated/. Restyling the callouts never needs the app again:
// change the drawing here and re-run annotate.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const here = path.dirname(new URL(import.meta.url).pathname);
export const MARKS_FILE = path.join(here, 'marks.json');

/**
 * A mark is { sel, n?, at?, pad?, label? }:
 *  - sel: a CSS/Playwright selector string, a Playwright Locator, or { box: [x, y, w, h] } in screenshot pixels
 *  - n: the number in the badge (default: its place in the list, from 1). n: 0 draws a ring with no badge
 *  - at: where the badge sits: 'tl' (default), 'tr', 'bl', 'br', 'l', 'r', 't', 'b'
 *  - pad: space between the element and its ring (default 4)
 */
export async function measure(page, marks) {
  const out = [];
  for (const [i, m] of marks.entries()) {
    let box = null;
    if (m.box) {
      const [x, y, w, h] = m.box;
      box = { x, y, width: w, height: h };
    } else {
      const loc = typeof m.sel === 'string' ? page.locator(m.sel).first() : m.sel;
      try {
        await loc.waitFor({ state: 'visible', timeout: 4000 });
        box = await loc.boundingBox();
      } catch {
        box = null;
      }
    }
    if (!box) {
      console.log('  mark not found:', m.sel?.toString?.() ?? m.sel);
      continue;
    }
    const pad = m.pad ?? 4;
    out.push({ n: m.n ?? i + 1, x: Math.round(box.x - pad), y: Math.round(box.y - pad), w: Math.round(box.width + pad * 2), h: Math.round(box.height + pad * 2), at: m.at ?? 'tl', ...(m.round ? { round: m.round } : {}) });
  }
  return out;
}

export function loadMarks() {
  try {
    return JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Store the callouts for one annotated picture. `entry` = { src, marks, crop?, dim? }. */
export function saveMarks(name, entry) {
  const all = loadMarks();
  all[name] = entry;
  const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  fs.writeFileSync(MARKS_FILE, JSON.stringify(sorted, null, 1) + '\n');
}

/** Keep PNGs small: anything over `max` bytes is reduced to a 256-colour palette (looks the same for app UI). */
export function shrinkPng(file, max = 400_000) {
  if (!fs.existsSync(file) || fs.statSync(file).size <= max) return;
  const tmp = file.replace(/\.png$/, '.tmp.png');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', tmp]);
  if (fs.statSync(tmp).size < fs.statSync(file).size) fs.renameSync(tmp, file);
  else fs.rmSync(tmp);
}

const BADGE = 17;
/** SVG for a set of marks on a W x H picture, with an optional crop offset. */
export function markSvg(marks, W, H, { dx = 0, dy = 0, dim = false } = {}) {
  const rings = [];
  const badges = [];
  const holes = [];
  for (const m of marks) {
    const x = m.x - dx, y = m.y - dy;
    const r = Math.min(12, m.round ?? 12, m.h / 2, m.w / 2);
    holes.push(`<rect x="${x}" y="${y}" width="${m.w}" height="${m.h}" rx="${r}" fill="black"/>`);
    // a dark halo under the yellow ring keeps it readable on light and dark backgrounds
    rings.push(`<rect x="${x}" y="${y}" width="${m.w}" height="${m.h}" rx="${r}" fill="none" stroke="rgba(10,10,20,.55)" stroke-width="7"/><rect x="${x}" y="${y}" width="${m.w}" height="${m.h}" rx="${r}" fill="none" stroke="#ffcf3f" stroke-width="3.5"/>`);
    if (!m.n) continue;
    const pos = {
      tl: [x, y], tr: [x + m.w, y], bl: [x, y + m.h], br: [x + m.w, y + m.h],
      l: [x - BADGE - 4, y + m.h / 2], r: [x + m.w + BADGE + 4, y + m.h / 2], t: [x + m.w / 2, y - BADGE - 4], b: [x + m.w / 2, y + m.h + BADGE + 4],
    }[m.at ?? 'tl'];
    // keep the badge inside the picture
    const bx = Math.max(BADGE + 2, Math.min(W - BADGE - 2, pos[0]));
    const by = Math.max(BADGE + 2, Math.min(H - BADGE - 2, pos[1]));
    badges.push(`<circle cx="${bx}" cy="${by}" r="${BADGE}" fill="#ffcf3f" stroke="#14151c" stroke-width="3"/><text x="${bx}" y="${by + 7.5}" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="21" font-weight="800" fill="#14151c">${m.n}</text>`);
  }
  const shade = dim ? `<defs><mask id="m"><rect width="${W}" height="${H}" fill="white"/>${holes.join('')}</mask></defs><rect width="${W}" height="${H}" fill="rgba(0,0,0,.38)" mask="url(#m)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${shade}${rings.join('')}${badges.join('')}</svg>`;
}
