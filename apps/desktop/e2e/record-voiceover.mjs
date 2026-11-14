// Record voiceover from the audio menu, with Chromium's fake microphone (a steady beep) so no real mic
// is used: countdown, recording while the video plays silently, listening back, adding to the audio row,
// the WAV in the project folder, and the take heard in an export where it was recorded.
//   node e2e/record-voiceover.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FP = FF.replace(/ffmpeg$/, 'ffprobe');
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-record-voiceover'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const video = path.join(out, 'screen.mp4');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=12', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const { app, page, exportDir } = await launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const state = (fn, a) => page.evaluate(fn, a);
const music = () => state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return core.musicClipsOf(p.edit, p.sources).map((c) => { const s = p.sources.find((x) => x.id === c.sourceId); return { id: c.id, name: s?.name, path: s?.path, start: +c.start.toFixed(2), length: +c.length.toFixed(2), gain: c.gain, duck: c.duck }; }); });
try {
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('edit'); });
  await page.waitForSelector('.lane-video');
  await page.waitForTimeout(600);
  await state(() => window.__cutaway.usePlayback.getState().seek(2));

  await page.click('[data-testid="audio-add"]');
  const items = await page.locator('.popmenu [role="menuitem"]').allTextContents();
  check('the audio menu offers Record voiceover', items.some((t) => /Record voiceover/.test(t)), JSON.stringify(items));
  await page.click('[data-testid="add-record-voiceover"]');
  await page.waitForSelector('[data-testid="record-voiceover"]');
  await page.waitForTimeout(1200);
  const lvl = await page.locator('.rvo-meter').getAttribute('aria-valuenow');
  check('the microphone opens and its level shows', Number(lvl) > 5, `level ${lvl}`);
  await page.screenshot({ path: path.join(out, '1-sheet.png') });

  await page.click('[data-testid="vo-record"]');
  check('Record counts down 3, 2, 1', (await page.locator('[data-testid="vo-countdown"]').textContent()) === '3');
  await page.waitForSelector('[data-testid="vo-stop"]', { timeout: 6000 });
  const during = await state(() => ({ playing: window.__cutaway.usePlayback.getState().playing, volume: window.__cutaway.usePlayback.getState().volume }));
  check('while recording, the video plays without its sound', during.playing && during.volume === 0, JSON.stringify(during));
  await page.waitForTimeout(2500);
  check('while recording, the sheet says where the take starts, not where the playhead has moved on to', /Starts at 0:02\.00/.test(await page.locator('.modal, [role="dialog"]').last().textContent()));
  await page.screenshot({ path: path.join(out, '2-recording.png') });
  await page.click('[data-testid="vo-stop"]');
  await page.waitForSelector('[data-testid="vo-add"]', { timeout: 8000 });
  const after = await state(() => ({ playing: window.__cutaway.usePlayback.getState().playing, volume: window.__cutaway.usePlayback.getState().volume }));
  check('Stop stops the video and gives its sound back', !after.playing && after.volume === 1, JSON.stringify(after));
  check('the take can be listened to before adding it', (await page.locator('.rvo-listen').count()) === 1);
  await page.screenshot({ path: path.join(out, '3-take.png') });

  await page.click('[data-testid="vo-add"]');
  await page.waitForTimeout(800);
  const m = await music();
  check('Add to timeline puts the take on the audio row where the playhead was, at full level, not ducked', m.length === 1 && m[0].name === 'Voiceover 1' && m[0].start === 2 && m[0].length > 2 && m[0].length < 4 && m[0].gain === 1 && m[0].duck === false, JSON.stringify(m));
  check('and selects it', (await state(() => window.__cutaway.useApp.getState().selection?.kind)) === 'music');
  const file = path.join(await state(() => window.__cutaway.useApp.getState().projectPath), m[0].path);
  const probe = JSON.parse(execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=codec_name,channels:format=duration', '-of', 'json', file]).toString());
  check('the take is a mono WAV in the project’s voiceover folder', /^media\/voiceover\/voiceover-[a-z0-9]+\.wav$/.test(m[0].path) && probe.streams[0].codec_name === 'pcm_s16le' && probe.streams[0].channels === 1, `${m[0].path} ${JSON.stringify(probe.streams[0])}`);
  await page.screenshot({ path: path.join(out, '4-on-row.png') });

  // export and listen: silence before 2 s, the beep after
  await state(() => window.__cutaway.useApp.getState().select(null));
  const r = await state(async ({ dest }) => {
    const { useApp, exporter } = window.__cutaway;
    const st = useApp.getState();
    const session = await window.cutaway.export.begin(dest, 'voiceover');
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
    const SR = 8000;
    const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', path.join(r.folder, 'video.mp4'), '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64e6 });
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    const rms = (a, b) => { let s = 0, n = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) { s += pcm[i] * pcm[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
    check('the voiceover is heard from 2 s and not before', rms(0.2, 1.8) < 0.002 && rms(2.6, 3.8) > 0.01, `before ${rms(0.2, 1.8).toFixed(4)} · after ${rms(2.6, 3.8).toFixed(4)}`);
  }
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all record-voiceover checks passed');
process.exit(failed ? 1 : 0);
