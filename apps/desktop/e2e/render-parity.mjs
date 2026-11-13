// Rendering parity checks through the real app, helper and exporter.
// Records a synthetic take (with captureKeys), then switches each feature on, screenshots the
// preview, exports, and compares exported frames with a baseline export by PSNR.
// Usage: node e2e/render-parity.mjs <outDir>
import { launch } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const FF = '/opt/homebrew/bin/ffmpeg';
const out = process.argv[2] ?? '/tmp/cutaway-render-parity';
fs.mkdirSync(out, { recursive: true });
const { app, page, exportDir } = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const note = (s) => console.log(`NOTE  ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name, wait = 900) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(out, `${name}.png`) }); };

// ── a synthetic take with screen, camera A, mic and keyboard telemetry ──
await page.evaluate(async () => { const { path } = await window.cutaway.library.create('Render parity'); await window.__cutaway.actions.openProjectAt(path); });
const started = await page.evaluate((cfg) => window.cutaway.record.start(window.__cutaway.useApp.getState().projectPath, cfg), { fps: 30, synthetic: true, captureKeys: true, screen: { type: 'display', displayId: 1, showCursor: false }, cameras: [{ slot: 'A', deviceId: 'synthetic-a', width: 1280, height: 720, fps: 30 }], microphone: { deviceId: '' }, systemAudio: false });
await sleep(10600);
const manifest = await page.evaluate(() => window.cutaway.record.stop());
check('synthetic take with captureKeys reports keyboard telemetry', !!manifest.keys?.file && manifest.keys.events > 0, JSON.stringify(manifest.keys));

// Deterministic telemetry for the checks (same file formats the helper writes).
const cursorLines = [];
for (let i = 0; i <= 600; i++) {
  const t = i / 60;
  // slow drift, then a fast dash between 2.0 s and 2.35 s, then slow again
  const x = t < 2 ? 0.2 + 0.02 * t : t < 2.35 ? 0.24 + ((t - 2) / 0.35) * 0.5 : 0.74 + 0.004 * (t - 2.35);
  const y = 0.35 + 0.1 * Math.sin(t * 0.7);
  cursorLines.push(JSON.stringify({ t: +t.toFixed(4), x: +x.toFixed(5), y: +y.toFixed(5), c: t > 6.5 ? 'ibeam' : t > 4 ? 'pointer' : 'arrow', e: 'move' }));
  if (Math.abs(t - 3) < 1e-6 || Math.abs(t - 5.5) < 1e-6) cursorLines.push(JSON.stringify({ t, x: +x.toFixed(5), y: +y.toFixed(5), c: 'arrow', e: 'down' }), JSON.stringify({ t: t + 0.08, x: +x.toFixed(5), y: +y.toFixed(5), c: 'arrow', e: 'up' }));
}
fs.writeFileSync(path.join(started.takeDir, 'cursor.jsonl'), cursorLines.join('\n') + '\n');
const keyLines = [{ t: 1.0, e: 'shortcut', keys: ['cmd', 'k'] }, { t: 4.5, e: 'shortcut', keys: ['cmd', 'shift', '4'] }];
for (let t = 5.0; t < 9.2; t += 0.12) keyLines.push({ t: +t.toFixed(2), e: 'type' });
fs.writeFileSync(path.join(started.takeDir, 'keys.jsonl'), keyLines.sort((a, b) => a.t - b.t).map((k) => JSON.stringify(k)).join('\n') + '\n');

const info = await page.evaluate(async ({ manifest, takeDir }) => {
  const { useApp, recording, core } = window.__cutaway;
  await recording.addTakeToProject(manifest, takeDir);
  const st = useApp.getState();
  st.edit((e, p) => core.applyOps(e, [{ op: 'zoom', start: 2, end: 5, scale: 2.2, x: 0.7, y: 0.35, follow: false }], 'creator', p.revision + 1), 'Zoom');
  st.go('project'); st.setView('edit');
  const p = useApp.getState().project;
  const screen = p.sources.find((s) => s.role === 'screen');
  const cam = p.sources.find((s) => s.role === 'cameraA');
  return { projectPath: st.projectPath, keysFile: screen.keysFile, cursorFile: screen.cursorFile, camPath: `${st.projectPath}/${cam.path}`, duration: p.duration, zoomId: p.edit.zooms[0].id };
}, { manifest, takeDir: started.takeDir });
check('the screen source carries its keys file and cursor file', !!info.keysFile && !!info.cursorFile, `${info.keysFile}`);

// ── helpers ──
const setAp = (fn) => page.evaluate((src) => { const f = new Function(`return (${src})`)(); window.__cutaway.useApp.getState().edit((e) => ({ ...e, appearance: f(e.appearance) }), 'test'); }, fn.toString());
const base = await page.evaluate(() => JSON.parse(JSON.stringify(window.__cutaway.useApp.getState().project.edit)));
const reset = () => page.evaluate((edit) => window.__cutaway.useApp.getState().edit(() => JSON.parse(JSON.stringify(edit)), 'reset'), base);
const seek = (t) => page.evaluate((t) => { const { usePlayback, useApp, timeMapOf } = window.__cutaway; usePlayback.getState().seek(timeMapOf(useApp.getState().project).toOutput(t)); }, t);
let n = 0;
async function exportVideo(label) {
  const r = await page.evaluate(async ({ dest, name }) => {
    const { useApp, exporter } = window.__cutaway;
    const st = useApp.getState();
    const session = await window.cutaway.export.begin(dest, name);
    try {
      const res = await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
      const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
      return { ok: true, folder: done.folder, res };
    } catch (e) { await window.cutaway.export.abort(session.id, false); return { ok: false, error: e.message }; }
  }, { dest: exportDir, name: `rp-${++n}-${label}` });
  if (!r.ok) throw new Error(`export ${label} failed: ${r.error}`);
  return path.join(r.folder, 'video.mp4');
}
const frame = (video, t, name) => { const f = path.join(out, `${name}.png`); execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select='eq(n,${Math.round(t * 30)})'`, '-frames:v', '1', f]); return f; };
const psnr = (a, b) => { const r = spawnSync(FF, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-']); const m = /average:(inf|[\d.]+)/.exec(r.stderr.toString()); return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : NaN; };
const pixel = (png, x, y) => [...execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', `crop=6:6:${x - 3}:${y - 3},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
const pcm = (video) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', video, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 64e6 });
const differs = (name, a, b, detail = '') => { const v = psnr(a, b); check(name, Number.isFinite(v) && v < 45, `PSNR ${v.toFixed(1)} dB vs baseline${detail ? ` · ${detail}` : ''}`); };

// ── baseline, and determinism ──
const baseVideo = await exportVideo('base');
const baseAgain = await exportVideo('base-again');
const T = { blur: 2.2, cursorDash: 2.2, zoomed: 3.5, shortcut: 1.3, pointer: 5.0, cam: 7.0 };
const B = Object.fromEntries(Object.entries(T).map(([k, t]) => [k, frame(baseVideo, t, `base-${k}`)]));
check('two exports of the same edit are pixel-identical', psnr(B.zoomed, frame(baseAgain, T.zoomed, 'base-again-zoomed')) === Infinity && psnr(B.blur, frame(baseAgain, T.blur, 'base-again-blur')) === Infinity);

// ── 1. motion blur ──
await setAp((a) => ({ ...a, motionBlur: { amount: 1, cursor: true, animation: true } }));
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setPanels({ tab: 'motion', inspector: true, drawer: null }); });
await seek(T.blur); await shot('01-motion-blur');
let v = await exportVideo('blur');
differs('motion blur changes the frames where the zoom animates and the cursor dashes', B.blur, frame(v, T.blur, 'blur-moving'));
const still = psnr(B.zoomed, frame(v, T.zoomed, 'blur-still'));
check('motion blur leaves a frame with almost no movement practically untouched', still === Infinity || still > 48, `PSNR ${still === Infinity ? 'inf' : still.toFixed(1)} dB`);
await reset();

// ── 2. zoom styles ──
await page.evaluate((id) => { const s = window.__cutaway.useApp.getState(); s.edit((e) => ({ ...e, zooms: e.zooms.map((z) => ({ ...z, style: 'magnifier', lensSize: 0.45 })) }), 'magnifier'); s.select({ kind: 'zoom', id }); }, info.zoomId);
await seek(T.zoomed); await shot('02-magnifier');
v = await exportVideo('magnifier');
const lensFrame = frame(v, T.zoomed, 'magnifier');
differs('magnifier draws a lens instead of zooming the frame', B.zoomed, lensFrame);
await reset();
await page.evaluate(() => window.__cutaway.useApp.getState().edit((e) => ({ ...e, zooms: e.zooms.map((z) => ({ ...z, style: 'instant' })) }), 'instant'));
v = await exportVideo('instant');
differs('instant zoom is already fully zoomed just after its start', frame(baseVideo, 2.1, 'base-zoom-start'), frame(v, 2.1, 'instant-zoom-start'));
await reset();

// ── 3. cursor ──
await setAp((a) => ({ ...a, cursor: { ...a.cursor, style: 'arrow' } }));
v = await exportVideo('default-pointer');
differs('"always use default pointer" replaces the recorded hand cursor', B.pointer, frame(v, T.pointer, 'cursor-arrow'));
await reset();
await setAp((a) => ({ ...a, cursor: { ...a.cursor, rotate: true, antiShake: true, loop: true, size: 2.5 } }));
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setPanels({ tab: 'cursor' }); });
await seek(T.pointer); await shot('03-cursor-tab');
v = await exportVideo('cursor-options');
differs('rotate / loop / larger cursor reach the exported pixels', frame(baseVideo, 9.8, 'base-end'), frame(v, 9.8, 'cursor-loop-end'));
await reset();
await setAp((a) => ({ ...a, cursor: { ...a.cursor, clickSound: { enabled: true, volume: 1 } } }));
v = await exportVideo('click-sound');
const a0 = pcm(baseVideo); const a1 = pcm(v);
const diffAt = (t) => { let d = 0; for (let i = Math.round(t * 8000) * 2; i < Math.round((t + 0.05) * 8000) * 2 && i + 1 < Math.min(a0.length, a1.length); i += 2) d += Math.abs(a0.readInt16LE(i) - a1.readInt16LE(i)); return d; };
check('click sound is mixed into the export at each click and nowhere else', diffAt(3.0) > 2000 && diffAt(5.5) > 2000 && diffAt(7.2) < 200, `diff at clicks ${diffAt(3.0)}, ${diffAt(5.5)}; away from clicks ${diffAt(7.2)}`);
await reset();

// ── 4. shortcuts overlay + 5. typing speed-up ──
await setAp((a) => ({ ...a, shortcuts: { show: true, size: 1.4, position: 'bottom', hidden: [] } }));
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setPanels({ tab: 'shortcuts' }); });
await seek(T.shortcut); await shot('04-shortcuts', 1500);
v = await exportVideo('shortcuts');
differs('shortcut key caps appear in the export while a shortcut is held', B.shortcut, frame(v, T.shortcut, 'shortcuts-on'));
const quiet = psnr(B.zoomed, frame(v, T.zoomed, 'shortcuts-quiet'));
check('no key caps between shortcuts (typing is never shown)', quiet === Infinity || quiet > 50, `PSNR ${quiet === Infinity ? 'inf' : quiet.toFixed(1)} dB at 3.5 s; typing at 5–9 s`);
const typingFrame = psnr(frame(baseVideo, 7.0, 'base-typing'), frame(v, 7.0, 'shortcuts-typing'));
check('frames during plain typing are identical to the baseline', typingFrame === Infinity || typingFrame > 50, `PSNR ${typingFrame === Infinity ? 'inf' : typingFrame.toFixed(1)} dB`);
const beforeOut = await page.evaluate(() => window.__cutaway.timeMapOf(window.__cutaway.useApp.getState().project).outDuration);
await page.getByRole('button', { name: 'Speed up typing' }).last().click();
const typed = await page.evaluate(() => { const p = window.__cutaway.useApp.getState().project; return { speeds: p.edit.speeds.map((s) => [+s.start.toFixed(2), +s.end.toFixed(2), s.speed, s.meta.origin]), out: window.__cutaway.timeMapOf(p).outDuration }; });
check('"Speed up typing" adds a creator speed range over the typing stretch', typed.speeds.length === 1 && typed.speeds[0][2] === 2 && typed.speeds[0][3] === 'creator' && typed.out < beforeOut - 1.5, `${JSON.stringify(typed.speeds)}; ${beforeOut.toFixed(2)}s → ${typed.out.toFixed(2)}s`);
await page.evaluate(() => window.__cutaway.useApp.getState().undo());
await reset();

// ── 6. camera: look, face framing (seeded track), cutout (seeded matte) ──
await setAp((a) => ({ ...a, camera: { ...a.camera, look: { brightness: 1.03, contrast: 1.15, saturation: 0, warmth: 0 } } }));
v = await exportVideo('look-mono');
const mono = frame(v, T.cam, 'look-mono');
differs('camera look changes the camera picture', B.cam, mono);
const [r, g, b] = pixel(mono, 1752, 912);
check('the Mono look is really monochrome in the export', Math.abs(r - g) < 10 && Math.abs(g - b) < 10, `bubble centre rgb ${r},${g},${b}; baseline ${pixel(B.cam, 1752, 912).join(',')}`);
await reset();

const hash = crypto.createHash('sha1').update(info.camPath).digest('hex').slice(0, 12);
// real helper runs on the synthetic camera (no person in it)
const realFaces = await page.evaluate(async ({ pp, f }) => { try { const t = await window.cutaway.native.faces(pp, f); return { ok: true, found: t.samples.filter((s) => !s.none).length, total: t.samples.length }; } catch (e) { return { ok: false, error: e.message }; } }, { pp: info.projectPath, f: info.camPath });
note(`native faces on the synthetic camera: ${JSON.stringify(realFaces)}`);
const realMatte = await page.evaluate(async ({ pp, f }) => { try { return { ok: true, ...(await window.cutaway.native.matte(pp, f)) }; } catch (e) { return { ok: false, error: e.message }; } }, { pp: info.projectPath, f: info.camPath });
note(`native matte on the synthetic camera: ${JSON.stringify({ ...realMatte, path: realMatte.path ? path.basename(realMatte.path) : undefined })}`);
check('native matte runs and matches the camera timing', realMatte.ok && Math.abs(realMatte.duration - manifest.sources.find((s) => s.id === 'cameraA').duration) < 0.2, realMatte.ok ? `${realMatte.frames} frames, ${realMatte.duration.toFixed(2)}s` : realMatte.error);
// Seed the caches with a known face track and a known matte (left half = person) to verify the render path.
fs.mkdirSync(path.join(info.projectPath, 'cache', 'faces'), { recursive: true });
fs.writeFileSync(path.join(info.projectPath, 'cache', 'faces', `${hash}.json`), JSON.stringify({ fps: 5, samples: Array.from({ length: 55 }, (_, i) => ({ t: i / 5, x: 0.62, y: 0.12, w: 0.16, h: 0.22 })) }));
const matteFile = path.join(info.projectPath, 'cache', 'matte', `${hash}.mov`);
fs.mkdirSync(path.dirname(matteFile), { recursive: true });
execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=11', '-vf', 'drawbox=x=0:y=0:w=640:h=720:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', matteFile]);
fs.writeFileSync(`${matteFile}.json`, JSON.stringify({ path: matteFile, duration: 11, frames: 330, width: 1280, height: 720 }));
await page.evaluate(() => window.location.reload());
await page.waitForFunction(() => !!window.__cutaway, null, { timeout: 15000 });
await page.evaluate((p) => window.__cutaway.actions.openProjectAt(p), info.projectPath);
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.setView('edit'); s.setPanels({ tab: 'camera', inspector: true, drawer: null }); });

await setAp((a) => ({ ...a, camera: { ...a.camera, face: { zoom: true, follow: true } } }));
await seek(T.cam); await shot('05-camera-face', 2500);
v = await exportVideo('face');
{
  // The synthetic camera is a bar sweeping on the host clock, so a single moment can be a flat colour
  // (where any crop looks the same). Compare several moments and require the crop to show in at least one.
  const worst = Math.min(...[6.0, 6.4, 6.8, 7.0, 7.3, 7.7].map((t) => psnr(frame(baseVideo, t, `base-face-${t}`), frame(v, t, `face-${t}`))));
  check('face framing (seeded track) re-crops the camera in the export', Number.isFinite(worst) && worst < 45, `lowest PSNR ${worst.toFixed(1)} dB vs baseline across six moments`);
}
await reset();
await setAp((a) => ({ ...a, camera: { ...a.camera, cutout: { enabled: true, backdrop: 'color', color: '#ff0000' } } }));
await seek(T.cam); await shot('06-camera-cutout', 2500);
v = await exportVideo('cutout');
const cut = frame(v, T.cam, 'cutout');
const person = pixel(cut, 1690, 912); const backdrop = pixel(cut, 1815, 912); const camBase = pixel(B.cam, 1690, 912);
check('cutout (seeded half matte): person side shows the camera, the other side shows the backdrop', backdrop[0] > 200 && backdrop[1] < 60 && backdrop[2] < 60 && Math.abs(person[0] - camBase[0]) + Math.abs(person[1] - camBase[1]) + Math.abs(person[2] - camBase[2]) < 40, `person side ${person.join(',')} (camera ${camBase.join(',')}); backdrop side ${backdrop.join(',')}`);
await setAp((a) => ({ ...a, camera: { ...a.camera, cutout: { enabled: true, backdrop: 'none', color: '#ff0000' } } }));
v = await exportVideo('cutout-floating');
const fl = frame(v, T.cam, 'cutout-floating');
const through = pixel(fl, 1815, 912);
check('cutout with no backdrop lets the recording show through behind the person', through[0] < 200 || through[1] > 60, `matte-black side ${through.join(',')}`);
await reset();

// ── 7. device frame ──
await page.evaluate(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, sources: p.sources.map((s) => (s.role === 'screen' ? { ...s, deviceKind: 'ipad' } : s)) })));
await setAp((a) => ({ ...a, device: { frame: true, color: 'silver' } }));
await page.evaluate(() => window.__cutaway.useApp.getState().setPanels({ tab: 'motion' }));
await seek(1.5); await shot('07-device-frame');
v = await exportVideo('device');
differs('device frame draws a bezel around the screen picture', frame(baseVideo, 1.5, 'base-plain'), frame(v, 1.5, 'device'));
await page.evaluate(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, sources: p.sources.map((s) => (s.role === 'screen' ? { ...s, deviceKind: undefined } : s)) })));
await reset();

// ── 8. portrait and square outputs ──
for (const [name, w, h] of [['vertical', 1080, 1920], ['square', 1080, 1080]]) {
  await page.evaluate(({ w, h }) => window.__cutaway.useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, output: { ...e.appearance.output, width: w, height: h }, shortcuts: { show: true, size: 1, position: 'bottom', hidden: [] } }, overlays: [{ id: 'ov_t', kind: 'callout', start: 0.5, end: 9, text: 'Pick the format first', x: 0.5, y: 0.2, meta: { origin: 'creator', revision: 1 } }] }), 'shape'), { w, h });
  await seek(T.shortcut); await shot(`08-${name}`, 1200);
  v = await exportVideo(name);
  const probe = execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'csv=p=0', v]).toString().trim();
  check(`${name} export has the requested shape`, probe.startsWith(`${w},${h},`), probe);
  frame(v, T.shortcut, `shape-${name}`);
  await reset();
}

const failed = results.filter((x) => !x[0]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Frames and screenshots: ${out}`);
await app.close();
process.exit(failed.length ? 1 : 0);
