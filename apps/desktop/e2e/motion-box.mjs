// Animations, slice 2: every built-in template passes Cutaway's own check; a boxed one (Circle it) is added,
// drawn inside its box in the preview, moved and resized by dragging on the preview, drawn anew with
// "Draw where it goes", undone, exported (the red ring lands in the box in the file too), and saved as the
// creator's own template, which then shows under "Yours" and can be removed. Nothing is sent to an AI.
//   node e2e/motion-box.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-motion-box'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const video = path.join(out, 'screen.mp4');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1ec81e:s=1280x720:r=30:d=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const near = (a, b, tol = 0.012) => Math.abs(a - b) <= tol;
const fmt = (b) => (b ? `x ${b.x.toFixed(3)} y ${b.y.toFixed(3)} w ${b.w.toFixed(3)} h ${b.h.toFixed(3)}` : 'none');
/** The ring lies inside the box (a little slack for the pen's width) and goes most of the way round it. */
const ringIn = (ring, box) => !!ring && ring.x >= box.x - 0.03 && ring.y >= box.y - 0.05 && ring.x + ring.w <= box.x + box.w + 0.03 && ring.y + ring.h <= box.y + box.h + 0.05 && ring.w > box.w * 0.6 && ring.h > box.h * 0.6;

const { app, page, exportDir, userData } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const motionOf = () => state(() => { const o = window.__cutaway.useApp.getState().project.edit.overlays.find((x) => x.kind === 'motion'); return o ? { id: o.id, start: o.start, end: o.end, box: o.motion.box ?? null, name: o.motion.name, file: o.motion.file, fields: Object.fromEntries(o.motion.fields.map((f) => [f.id, f.value])) } : null; });
const seek = (t) => state((t) => { const { usePlayback } = window.__cutaway; usePlayback.getState().setPlaying(false); usePlayback.getState().seek(t); }, t);
/** Where the red pen is in the preview, as a box in frame fractions. */
const redInPreview = () => state(() => {
  const c = document.querySelector('.preview-canvas');
  const k = document.createElement('canvas');
  k.width = c.width; k.height = c.height;
  const g = k.getContext('2d');
  g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, k.width, k.height).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < k.height; y += 2) for (let x = 0; x < k.width; x += 2) { const i = (y * k.width + x) * 4; if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
  return x1 < 0 ? null : { x: x0 / k.width, y: y0 / k.height, w: (x1 - x0) / k.width, h: (y1 - y0) / k.height };
});
/** Mouse drag on the preview, from and to frame fractions. */
const dragOnPreview = async (from, to) => {
  const r = await page.locator('.preview-canvas').boundingBox();
  const px = ([x, y]) => [r.x + r.width * x, r.y + r.height * y];
  await page.mouse.move(...px(from));
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(...px([from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8]));
  await page.mouse.up();
  await page.waitForTimeout(300);
};
const ready = () => page.waitForSelector('[data-testid="motion-render-status"][data-state="ready"]', { timeout: 60000 });
const settled = async () => { await page.waitForTimeout(400); await ready(); await page.waitForTimeout(600); };

try {
  // ── every template passes the same check an AI's page must pass ──
  const dir = path.join(here, '..', 'src', 'renderer', 'motion', 'templates');
  const results = await state(async (pages) => {
    const { motionPixels, parseMotionMeta } = window.__cutaway.core ?? {};
    const outs = [];
    for (const [file, html] of pages) {
      const meta = parseMotionMeta ? parseMotionMeta(html).meta : null;
      const box = /"placement":\s*"box"/.test(html) ? (meta?.box ?? JSON.parse(html.match(/"box":\s*(\{[^}]*\})/)[1])) : null;
      const size = box ? (motionPixels ? motionPixels({ box }, 1280, 720) : { width: Math.round((1280 * box.w) / 2) * 2, height: Math.round((720 * box.h) / 2) * 2 }) : { width: 1280, height: 720 };
      const c = await window.cutaway.motion.check(html, null, size.width, size.height);
      outs.push(`${file} ${size.width}×${size.height}: ${c.ok ? 'ok' : c.errors.join('; ')}`);
    }
    return outs;
  }, fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  check(`all ${results.length} built-in templates pass Cutaway’s check, boxed ones at their box size`, results.length >= 8 && results.every((r) => r.endsWith(': ok')), results.join(' | '));

  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('edit'); st.edit((e) => ({ ...e, appearance: { ...e.appearance, background: { type: 'solid', color: '#101820' } } }), 'flat'); });
  await page.waitForSelector('.lane-video');
  await page.waitForTimeout(500);

  // ── add "Circle it" ──
  await seek(1);
  await page.click('[data-testid="fx-add"]');
  await page.click('[data-testid="add-motion"]');
  await page.waitForSelector('[data-testid="motion-sheet"]');
  check('the template list shows all eight built-in animations', (await page.locator('[data-testid^="motion-tpl-"]').count()) >= 8);
  await page.click('[data-testid="motion-tpl-highlighter"]');
  await page.waitForTimeout(800);
  const shape = await page.locator('.motion-preview').boundingBox();
  check('a boxed template is previewed at its box’s shape (the highlighter’s long strip, 512×72), not the frame’s', !!shape && near(shape.width / shape.height, 512 / 72, 0.3), shape ? `${Math.round(shape.width)}×${Math.round(shape.height)}` : 'no preview');
  await page.click('[data-testid="motion-tpl-circle"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '1-sheet.png') });
  await page.click('[data-testid="motion-add"]');
  await page.waitForTimeout(600);
  let m = await motionOf();
  check('it is added at the playhead, in the box the template asks for', !!m && m.start === 1 && m.end === 4 && m.box && near(m.box.x, 0.4) && near(m.box.y, 0.36) && near(m.box.w, 0.2) && near(m.box.h, 0.2), JSON.stringify(m));
  check('the panel offers “Draw where it goes”', (await page.locator('[data-testid="motion-place"]').count()) === 1);
  await ready();

  await seek(0.5);
  await page.waitForTimeout(500);
  const before = await redInPreview();
  await seek(3.5);
  await settled();
  const ring = await redInPreview();
  check('the preview shows nothing before it starts, then the ring drawn inside its box', !before && ringIn(ring, m.box), `before ${fmt(before)} · ring ${fmt(ring)} · box ${fmt(m.box)}`);
  await page.screenshot({ path: path.join(out, '2-circle.png') });

  // ── move it by dragging on the preview ──
  await dragOnPreview([0.5, 0.46], [0.7, 0.56]);
  m = await motionOf();
  check('dragging inside the box moves it', near(m.box.x, 0.6, 0.02) && near(m.box.y, 0.46, 0.02) && near(m.box.w, 0.2) && near(m.box.h, 0.2), fmt(m.box));
  await settled();
  const moved = await redInPreview();
  check('and the ring follows it', ringIn(moved, m.box), `ring ${fmt(moved)} · box ${fmt(m.box)}`);

  // ── resize by its bottom-right corner ──
  await dragOnPreview([m.box.x + m.box.w - 0.005, m.box.y + m.box.h - 0.01], [m.box.x + m.box.w + 0.1, m.box.y + m.box.h + 0.1]);
  m = await motionOf();
  check('dragging its bottom-right corner resizes it, keeping its top-left', near(m.box.x, 0.6, 0.02) && near(m.box.y, 0.46, 0.02) && near(m.box.w, 0.3, 0.025) && near(m.box.h, 0.3, 0.025), fmt(m.box));
  await settled();
  const bigger = await redInPreview();
  check('the ring is redrawn to the new size, still all the way round', ringIn(bigger, m.box), `ring ${fmt(bigger)} · box ${fmt(m.box)}`);
  await page.screenshot({ path: path.join(out, '3-resized.png') });

  // ── draw a new box ──
  await page.click('[data-testid="motion-place"]');
  await page.waitForTimeout(200);
  await dragOnPreview([0.1, 0.12], [0.34, 0.42]);
  m = await motionOf();
  check('“Draw where it goes” then a drag on the preview sets a new box', near(m.box.x, 0.1, 0.015) && near(m.box.y, 0.12, 0.015) && near(m.box.w, 0.24, 0.02) && near(m.box.h, 0.3, 0.02), fmt(m.box));
  await settled();
  const drawn = await redInPreview();
  check('the ring is drawn in the new box (a wide one this time)', ringIn(drawn, m.box), `ring ${fmt(drawn)} · box ${fmt(m.box)}`);
  await page.screenshot({ path: path.join(out, '4-drawn.png') });

  // ── undo ──
  await state(() => window.__cutaway.useApp.getState().undo());
  await page.waitForTimeout(300);
  const undone = await motionOf();
  check('undo puts the box back where it was before drawing (one step, not one per mouse move)', near(undone.box.x, 0.6, 0.02) && near(undone.box.w, 0.3, 0.025), fmt(undone.box));
  await state(() => window.__cutaway.useApp.getState().redo());
  await page.waitForTimeout(300);
  m = await motionOf();
  check('redo brings the drawn box back', near(m.box.x, 0.1, 0.015), fmt(m.box));

  // ── export ──
  await state(() => window.__cutaway.useApp.getState().select(null));
  const r = await state(async ({ dest }) => {
    const { useApp, exporter } = window.__cutaway;
    const st = useApp.getState();
    const session = await window.cutaway.export.begin(dest, 'motion-box');
    try {
      await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
      const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
      return { ok: true, folder: done.folder };
    } catch (e) {
      await window.cutaway.export.abort(session.id, false);
      return { ok: false, error: e.message };
    }
  }, { dest: exportDir });
  if (!r.ok) throw new Error(r.error);
  const file = path.join(r.folder, 'video.mp4');
  const W = 320, H = 180;
  const redInExport = (t) => {
    const b = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e7 });
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (b[i] > 170 && b[i + 1] < 100 && b[i + 2] < 100) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } }
    return x1 < 0 ? null : { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  };
  const e0 = redInExport(0.5);
  const e1 = redInExport(3.5);
  check('the export matches: nothing before, then the ring inside the drawn box', !e0 && ringIn(e1, m.box), `before ${fmt(e0)} · ring ${fmt(e1)} · box ${fmt(m.box)}`);

  // ── save as template ──
  await page.locator('.lane-fx .tl-item.motion').click();
  await page.waitForSelector('[data-testid="motion-field-colour"]');
  await page.fill('[data-testid="motion-field-colour"]', '#1e1edc');
  await page.waitForTimeout(300);
  await page.click('[data-testid="motion-save-template"]');
  await page.waitForTimeout(600);
  const saved = fs.existsSync(path.join(userData, 'motion-templates')) ? fs.readdirSync(path.join(userData, 'motion-templates')).filter((f) => f.endsWith('.html')) : [];
  const savedHtml = saved[0] ? fs.readFileSync(path.join(userData, 'motion-templates', saved[0]), 'utf8') : '';
  check('“Save as template” keeps it in Cutaway’s own library, with the chosen colour as its new default', saved.length === 1 && /"default":\s*"#1e1edc"/.test(savedHtml) && /"placement":\s*"box"/.test(savedHtml), saved.join(', '));

  await page.click('[data-testid="fx-add"]');
  await page.click('[data-testid="add-motion"]');
  await page.waitForSelector('[data-testid="motion-sheet"]');
  await page.waitForTimeout(500);
  const own = await page.locator('.motion-tpl-row:has(.motion-tpl-remove)').count();
  const yours = await page.locator('.motion-tpl-row .eyebrow', { hasText: 'Yours' }).count();
  check('it shows under “Yours” in the template list, next to the built-in ones', own === 1 && yours === 1, `own ${own}, heading ${yours}`);
  await page.screenshot({ path: path.join(out, '5-yours.png') });
  await page.locator('.motion-tpl-row:has(.motion-tpl-remove) .motion-tpl-card').click();
  await page.waitForTimeout(500);
  check('picking it shows its saved colour in the fields', (await page.locator('.motion-sheet input[type="color"]').first().inputValue()) === '#1e1edc');
  await page.click('.motion-tpl-remove');
  await page.waitForTimeout(500);
  const left = fs.readdirSync(path.join(userData, 'motion-templates')).filter((f) => f.endsWith('.html'));
  check('removing it takes it out of the list and the library', (await page.locator('.motion-tpl-remove').count()) === 0 && left.length === 0, left.join(', '));
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all motion-box checks passed');
process.exit(failed ? 1 : 0);
