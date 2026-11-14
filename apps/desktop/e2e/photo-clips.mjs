// Photos as clips on the video row: added from files, shown for 5 s, length changed from the bar and by
// dragging the end, drawn in the preview, undone, and exported with each moment showing the right picture.
//   node e2e/photo-clips.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-photo-clips'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const video = path.join(out, 'screen.mp4');
const photo = path.join(out, 'beach.png');
// 6 s of solid green, and a portrait magenta photo
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1ec81e:s=1280x720:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xdc1edc:s=600x800', '-frames:v', '1', photo]);

let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const { app, page, exportDir } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const clips = () => state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return core.playingClips(core.clipsOf(p)).map((c) => ({ id: c.id, name: c.name, start: +c.start.toFixed(2), len: +(c.out - c.in).toFixed(2), photo: core.isPhotoClip(p, c) })); });
const duration = () => state(() => +window.__cutaway.useApp.getState().project.duration.toFixed(2));
/** Colour at the centre of a preview or export frame, by name. */
const name = ([r, g, b]) => (g > 150 && r < 100 && b < 100 ? 'green' : r > 150 && b > 150 && g < 100 ? 'magenta' : `rgb(${r},${g},${b})`);
try {
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('edit'); });
  await page.waitForSelector('.lane-video');
  await page.waitForTimeout(800);

  // what "Video or photo from my files…" does with a picked photo
  await state((f) => window.__cutaway.actions.importVideosToTimeline([f]), photo);
  await page.waitForTimeout(600);
  let cl = await clips();
  check('a photo goes on the video row as a clip of its own, after the video, for 5 s', cl.length === 2 && cl[1].photo && cl[1].name === 'beach' && cl[1].start === 6 && cl[1].len === 5, JSON.stringify(cl));
  check('the video is now as long as both', (await duration()) === 11);
  check('it is not also shown over the footage', (await state(() => window.__cutaway.useApp.getState().project.edit.broll.length)) === 0);
  check('the photo clip shows a still of the photo', (await page.locator('[data-testid="clip-block"]').nth(1).locator('.tl-clip-film').count()) === 1);

  // the preview shows the photo while its clip plays
  await state(() => window.__cutaway.usePlayback.getState().seek(8));
  await page.waitForTimeout(700);
  const px = await state(() => { const c = document.querySelector('.preview-canvas'); const x = document.createElement('canvas'); x.width = c.width; x.height = c.height; const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; });
  check('the preview shows the photo at 8 s', name(px) === 'magenta', name(px));
  // the photo is portrait: it is shown in its own shape, so the left of the frame is background, not photo
  const side = await state(() => { const c = document.querySelector('.preview-canvas'); const x = document.createElement('canvas'); x.width = c.width; x.height = c.height; const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(Math.floor(c.width * 0.15), Math.floor(c.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; });
  check('a portrait photo keeps its shape in the preview (not stretched to fill)', name(side) !== 'magenta', name(side));

  // length from the bar
  await page.locator('[data-testid="clip-block"]').nth(1).click();
  await page.waitForTimeout(200);
  check('selecting it shows Length on the bar', (await page.locator('[data-testid="selbar-length"]').textContent())?.includes('5.0s'));
  await page.click('[data-testid="selbar-length"]');
  await page.locator('.popmenu input[type="range"]').fill('3');
  await page.waitForTimeout(200);
  cl = await clips();
  check('setting it to 3 s shortens the clip and the video', cl[1].len === 3 && (await duration()) === 9, JSON.stringify(cl));
  await page.keyboard.press('Escape');

  // drag its end out to about 7 s
  const block = page.locator('[data-testid="clip-block"]').nth(1);
  await block.hover();
  const handle = block.locator('[data-testid="clip-trim-tail"]');
  const hb = await handle.boundingBox();
  const bb = await block.boundingBox();
  const pps = bb.width / 3;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.keyboard.down('Alt'); // no snapping, so the length is exactly what the pointer did
  await page.mouse.move(hb.x + hb.width / 2 + 4 * pps, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(200);
  cl = await clips();
  check('dragging the end of a photo makes it play longer', Math.abs(cl[1].len - 7) < 0.25, JSON.stringify(cl));
  await state(() => window.__cutaway.useApp.getState().undo());
  cl = await clips();
  check('the drag is one undo step', cl[1].len === 3, JSON.stringify(cl));
  await state(() => window.__cutaway.useApp.getState().undo());
  cl = await clips();
  check('and undo again brings back 5 s', cl[1].len === 5 && (await duration()) === 11, JSON.stringify(cl));
  await page.screenshot({ path: path.join(out, 'photo-clip.png') });

  // export: green, then the photo
  await state(() => window.__cutaway.useApp.getState().select(null));
  const r = await state(async ({ dest }) => {
    const { useApp, exporter } = window.__cutaway;
    const st = useApp.getState();
    const session = await window.cutaway.export.begin(dest, 'photo-clips');
    try {
      await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
      const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
      return { ok: true, folder: done.folder };
    } catch (e) {
      await window.cutaway.export.abort(session.id, false);
      return { ok: false, error: e.message };
    }
  }, { dest: exportDir });
  check('the edit exports', r.ok, r.error ?? '');
  if (r.ok) {
    const file = path.join(r.folder, 'video.mp4');
    const length = Number(execFileSync(FF.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
    check('the export is 11 s long', Math.abs(length - 11) < 0.15, `${length.toFixed(2)} s`);
    const at = (t) => { const b = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=32:32,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return name([b[0], b[1], b[2]]); };
    const seen = [1, 3, 5.5, 6.5, 8, 10.5].map((t) => `${t}s ${at(t)}`);
    const sideAt = (t) => { const b = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=8:8:iw*0.15:ih/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return name([b[0], b[1], b[2]]); };
    check('and keeps its shape in the export', sideAt(8) !== 'magenta', sideAt(8));
    check('the video plays first, then the photo for its 5 s', seen.join(' ') === '1s green 3s green 5.5s green 6.5s magenta 8s magenta 10.5s magenta', seen.join(', '));
  }
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all photo-clip checks passed');
process.exit(failed ? 1 : 0);
