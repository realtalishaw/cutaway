// Real hardware: record the main display + microphone + system audio for a few seconds
// (needs Screen Recording permission for the launching app), then edit and export it.
// Usage: node e2e/real-capture.mjs <outDir>
import { launch } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';

const out = process.argv[2] ?? '/tmp/cutaway-real';
fs.mkdirSync(out, { recursive: true });
const { app, page, exportDir } = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const devices = await page.evaluate(() => window.cutaway.native.devices());
console.log('permissions', JSON.stringify(devices.permissions), 'displays', devices.displays.map((d) => `${d.name} ${d.width}x${d.height}@${d.scale}x`).join(', '), 'cameras', devices.cameras.map((c) => c.name).join(', '));
await page.evaluate(async () => { const { path } = await window.cutaway.library.create('Real capture'); await window.__cutaway.actions.openProjectAt(path); window.__events = []; window.cutaway.record.onEvent((e) => window.__events.push(e)); });
const main = devices.displays.find((d) => d.main) ?? devices.displays[0];
let started;
try {
  started = await page.evaluate((cfg) => window.cutaway.record.start(window.__cutaway.useApp.getState().projectPath, cfg), { fps: 60, screen: { type: 'display', displayId: main.id, showCursor: false }, cameras: [], microphone: { deviceId: '' }, systemAudio: true });
} catch (e) {
  console.log('BLOCKED: recording could not start:', e.message);
  await app.close();
  process.exit(2);
}
// something audible on the system-audio track
const say = spawn('say', ['-r', '180', 'This is a real capture test. Cutaway records system audio on its own track.']);
await sleep(7000);
say.kill();
const manifest = await page.evaluate(() => window.cutaway.record.stop());
console.log('manifest', JSON.stringify({ duration: manifest.duration, complete: manifest.complete, cursor: manifest.cursor, sources: manifest.sources.map((s) => ({ id: s.id, start: s.start, duration: s.duration, w: s.width, h: s.height, fps: s.fps, frames: s.frames, cursorBaked: s.cursorBaked })) }));
const events = await page.evaluate(() => window.__events.filter((e) => e.type !== 'tick' && e.type !== 'levels').map((e) => e.type + (e.message ? `:${e.message}` : '')));
console.log('events', events.join(' '));
const info = await page.evaluate(async ({ manifest, takeDir }) => {
  const { useApp, recording, core, timeMapOf } = window.__cutaway;
  await recording.addTakeToProject(manifest, takeDir);
  const st = useApp.getState();
  const screen = st.project.sources.find((s) => s.role === 'screen');
  const samples = await window.cutaway.native.readCursor(`${st.projectPath}/${screen.cursorFile}`);
  st.edit((e, p) => core.applyOps(e, [{ op: 'zoom', start: 1.5, end: 5, scale: 2, follow: true }], 'creator', p.revision + 1), 'Zoom');
  st.go('project'); st.setView('edit');
  window.__cutaway.usePlayback.getState().seek(3);
  return { cursorSamples: samples.length, first: samples[0], screen: { w: screen.width, h: screen.height, fps: screen.fps, baked: screen.cursorBaked }, out: timeMapOf(useApp.getState().project).outDuration };
}, { manifest, takeDir: started.takeDir });
console.log('project', JSON.stringify(info));
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(out, 'real-editor.png') });
const exp = await page.evaluate(async (dest) => {
  const { useApp, exporter } = window.__cutaway;
  const st = useApp.getState();
  const session = await window.cutaway.export.begin(dest, 'real-export');
  const t0 = performance.now();
  try {
    const r = await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
    const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
    return { ok: true, r, seconds: (performance.now() - t0) / 1000, folder: done.folder };
  } catch (e) { await window.cutaway.export.abort(session.id, false); return { ok: false, error: e.message, code: e.code }; }
}, exportDir);
console.log('export', JSON.stringify(exp));
if (exp.ok) {
  const f = path.join(exp.folder, 'video.mp4');
  console.log(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames,color_primaries,channels:format=duration', '-of', 'compact', f]).toString().trim());
  console.log(execSync(`/opt/homebrew/bin/ffmpeg -hide_banner -i "${f}" -af volumedetect -vn -f null - 2>&1 | grep -E "mean_volume|max_volume"`).toString().trim());
  // do not keep frames of the creator's real desktop: only report that they decode
  console.log('decoded frames ok');
}
await app.close();
