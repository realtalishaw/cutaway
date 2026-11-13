// Rendering parity checks through the real app, helper and exporter.
// Records a synthetic take (with captureKeys), then switches each feature on, screenshots the
// preview, exports, and compares exported frames with a baseline export by PSNR.
// Usage: node e2e/render-parity.mjs <outDir>      (ONLY=parity or ONLY=look runs one half)
import { launch } from './harness.mjs';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const FF = '/opt/homebrew/bin/ffmpeg';
const out = process.argv[2] ?? '/tmp/cutaway-render-parity';
fs.mkdirSync(out, { recursive: true });
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const run = (section) => !ONLY || ONLY.has(section);

// ── a local stand-in for the Unsplash API (the live service is never contacted by this test) ──
const mock = { searches: [], downloads: [], auth: [] };
for (const [id, color] of [['mockA', '0x10a0c0'], ['mockB', '0xc04020']]) execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720`, '-frames:v', '1', path.join(out, `${id}.jpg`)]);
const mockServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const base = `http://127.0.0.1:${mockServer.address().port}`;
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith('/img/')) {
    const file = path.join(out, path.basename(url.pathname));
    if (!fs.existsSync(file)) return json(404, {});
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(fs.readFileSync(file));
  }
  mock.auth.push(req.headers.authorization ?? '');
  if (req.headers.authorization !== 'Client-ID test-key') return json(401, { errors: ['OAuth error: The access token is invalid'] });
  if (url.pathname === '/search/photos') {
    mock.searches.push({ query: url.searchParams.get('query'), page: url.searchParams.get('page') });
    const photo = (id, color, name) => ({ id, width: 1280, height: 720, color, alt_description: `${name} test photo`, urls: { raw: `${base}/img/${id}.jpg`, thumb: `${base}/img/${id}.jpg` }, links: { html: `https://unsplash.com/photos/${id}`, download_location: `${base}/photos/${id}/download` }, user: { name, links: { html: `https://unsplash.com/@${id}` } } });
    if (url.searchParams.get('query') === 'nothing') return json(200, { total: 0, total_pages: 0, results: [] });
    return json(200, { total: 3, total_pages: 1, results: [photo('mockA', '#10a0c0', 'Ada Example'), photo('mockB', '#c04020', 'Ben Sample'), { ...photo('evil', '#000000', 'Mallory'), urls: { raw: 'https://evil.example/x.jpg', thumb: 'https://evil.example/t.jpg' } }] });
  }
  const dl = /^\/photos\/([\w-]+)\/download$/.exec(url.pathname);
  if (dl) { mock.downloads.push(dl[1]); return json(200, { url: `${base}/img/${dl[1]}.jpg` }); }
  json(404, {});
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
process.env.CUTAWAY_UNSPLASH_BASE = `http://127.0.0.1:${mockServer.address().port}`;

const { app, page, exportDir, userData } = await launch();
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

if (run('parity')) {
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

} // parity

if (run('look')) {
  // ══════════════════ LOOK: colour LUTs, sharpening, photo search, default zoom ══════════════════
  const cube3 = (n, fn, title = '') => { const rows = []; for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(fn(r / (n - 1), g / (n - 1), b / (n - 1)).map((x) => x.toFixed(6)).join(' ')); return `${title ? `TITLE "${title}"\n` : ''}LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`; };
  const lutDir = path.join(out, 'luts'); fs.mkdirSync(lutDir, { recursive: true });
  const lutFile = (name, text) => { const f = path.join(lutDir, name); fs.writeFileSync(f, text); return f; };
  const files = {
    swap: lutFile('Swap red and blue.cube', cube3(17, (r, g, b) => [b, g, r], 'Swap')),
    green: lutFile('green.cube', cube3(2, () => [0, 1, 0])),
    invert: lutFile('invert-1d.cube', 'TITLE "Invert"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0\n'),
    big: lutFile('identity-65.cube', cube3(65, (r, g, b) => [r, g, b], 'Identity 65')),
    cut: lutFile('cut-short.cube', cube3(9, (r, g, b) => [r, g, b]).split('\n').slice(0, 200).join('\n')),
    huge: lutFile('too-big.cube', 'LUT_3D_SIZE 66\n'),
    notLut: lutFile('not-a-lut.cube', 'This is a text file.\n'),
  };
  const importLut = (file) => page.evaluate(async ({ pp, file }) => { try { return { ok: true, ref: await window.cutaway.looks.importLut(pp, file) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } }, { pp: info.projectPath, file });
  const setGrade = (grade) => page.evaluate((grade) => window.__cutaway.useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, grade } }), 'grade'), grade);
  const previewPixel = (x, y) => page.evaluate(([x, y]) => { const c = document.querySelector('.preview-canvas'); const ctx = c.getContext('2d'); const d = ctx.getImageData(Math.round((x / 1920) * c.width) - 2, Math.round((y / 1080) * c.height) - 2, 5, 5).data; let r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]; }, [x, y]);
  const near = (a, b, tol) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
  const strip = (png, x, y, w) => [...execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', png, '-vf', `crop=${w}:8:${x}:${y},scale=${w}:1:flags=area,format=gray`, '-f', 'rawvideo', '-'])];
  const timed = async (label) => { const t0 = Date.now(); const video = await exportVideo(label); return { video, ms: Date.now() - t0 }; };
  const t = T.cam;
  // The synthetic pictures are a flat colour with a white bar that sweeps on the host clock: sample away from the bar.
  const awayFromBar = (x0, w, y, candidates) => { const s = strip(B.cam, x0, y, w); const bar = x0 + s.indexOf(Math.max(...s)); return candidates.sort((a, b) => Math.abs(b - bar) - Math.abs(a - bar))[0]; };
  const SX = awayFromBar(130, 1660, 700, [300, 1000, 1500]); const SCREEN = [SX, 700];
  const CX = awayFromBar(1640, 220, 912, [1680, 1752, 1830]); const CAM = [CX, 912];
  const BG = [40, 30];
  const baseScreen = pixel(B.cam, ...SCREEN); const baseCam = pixel(B.cam, ...CAM); const baseBg = pixel(B.cam, ...BG);
  note(`sample points: screen ${SCREEN} = ${baseScreen}; camera ${CAM} = ${baseCam}; background ${BG} = ${baseBg}`);

  // ── 9. LUT import ──
  const imp = {}; for (const k of Object.keys(files)) imp[k] = await importLut(files[k]);
  check('a 3D .cube is validated, copied into the project folder and described', imp.swap.ok && imp.swap.ref.file === 'media/luts/Swap red and blue.cube' && imp.swap.ref.kind === '3d' && imp.swap.ref.size === 17 && imp.swap.ref.name === 'Swap' && fs.existsSync(path.join(info.projectPath, imp.swap.ref.file)), JSON.stringify(imp.swap.ref ?? imp.swap));
  check('a 1D .cube and a 65-point 3D .cube are accepted', imp.invert.ok && imp.invert.ref.kind === '1d' && imp.invert.ref.size === 2 && imp.big.ok && imp.big.ref.size === 65, `${JSON.stringify(imp.invert.ref ?? imp.invert)} ${JSON.stringify(imp.big.ref ?? imp.big)}`);
  check('broken files are refused with a reason and nothing is copied', !imp.cut.ok && imp.cut.code === 'bad-lut' && /rows/.test(imp.cut.message) && !imp.huge.ok && /largest Cutaway reads is 65/.test(imp.huge.message) && !imp.notLut.ok && imp.notLut.code === 'bad-lut' && fs.readdirSync(path.join(info.projectPath, 'media', 'luts')).length === 4, `${imp.cut.message} | ${imp.huge.message} | ${imp.notLut.message}`);
  const again = await importLut(files.swap);
  check('importing the same name twice keeps both files', again.ok && again.ref.file !== imp.swap.ref.file, again.ref?.file);
  const backend = await page.evaluate(() => window.__cutawayGrade.gradeBackend());
  check('the grade pass runs on the GPU here', backend === 'gl', `backend: ${backend}`);

  // ── 10. screen LUT in the export, and only on the screen ──
  await setGrade({ screen: { lut: imp.swap.ref, strength: 1, sharpen: 0 } });
  await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setPanels({ tab: 'background', inspector: true, drawer: null }); });
  await seek(t); await page.waitForTimeout(600);
  await page.getByTestId('lut-screen').scrollIntoViewIfNeeded().catch(() => {});
  await shot('09-screen-lut', 900);
  const lutRow = await page.getByTestId('lut-screen').innerText().catch(() => '');
  check('the Background tab shows the screen LUT by name and size', /Swap/.test(lutRow) && /17×17×17/.test(lutRow), lutRow.replace(/\n/g, ' · '));
  const pvSwap = await previewPixel(...SCREEN);
  let lv = await exportVideo('lut-screen-swap');
  let lf = frame(lv, t, 'lut-screen-swap');
  let got = pixel(lf, ...SCREEN);
  check('screen LUT (red↔blue .cube): the exported screen colour is the baseline with red and blue swapped', near(got, [baseScreen[2], baseScreen[1], baseScreen[0]], 14), `baseline ${baseScreen} → ${got}`);
  check('the screen LUT leaves the camera and the background alone', near(pixel(lf, ...CAM), baseCam, 5) && near(pixel(lf, ...BG), baseBg, 5), `camera ${pixel(lf, ...CAM)} (was ${baseCam}); background ${pixel(lf, ...BG)} (was ${baseBg})`);
  check('Preview and export agree on the graded screen colour', near(pvSwap, got, 14), `preview ${pvSwap}; export ${got}`);
  await page.evaluate(() => window.__cutaway.saveNow?.());
  const savedGrade = JSON.parse(fs.readFileSync(path.join(info.projectPath, 'project.json'), 'utf8')).edit.appearance.grade;
  check('the project stores a reference to the LUT, not the table', JSON.stringify(savedGrade).length < 300 && savedGrade.screen.lut.file === imp.swap.ref.file, JSON.stringify(savedGrade));

  await setGrade({ screen: { lut: imp.green.ref, strength: 0.5, sharpen: 0 } });
  await seek(t); await page.waitForTimeout(900);
  const pvHalf = await previewPixel(...SCREEN);
  lv = await exportVideo('lut-screen-half');
  got = pixel(frame(lv, t, 'lut-screen-half'), ...SCREEN);
  const half = [Math.round(baseScreen[0] / 2), Math.round((baseScreen[1] + 255) / 2), Math.round(baseScreen[2] / 2)];
  check('strength 50% lands halfway between the original and the LUT colour', near(got, half, 14) && near(pvHalf, got, 14), `expected about ${half}; export ${got}; preview ${pvHalf}`);

  await setGrade({ screen: { lut: imp.big.ref, strength: 1, sharpen: 0 } });
  lv = await exportVideo('lut-identity-65');
  const idp = psnr(B.cam, frame(lv, t, 'lut-identity-65'));
  check('a 65-point identity LUT leaves the picture as it was', idp === Infinity || idp > 42, `PSNR ${idp === Infinity ? 'inf' : idp.toFixed(1)} dB vs baseline`);

  // ── 11. camera LUT (1D) ──
  await setGrade({ camera: { lut: imp.invert.ref, strength: 1, sharpen: 0 } });
  await page.evaluate(() => window.__cutaway.useApp.getState().setPanels({ tab: 'camera' }));
  await seek(t); await shot('10-camera-lut', 1500);
  const pvCam = await previewPixel(...CAM);
  lv = await exportVideo('lut-camera-invert');
  lf = frame(lv, t, 'lut-camera-invert');
  got = pixel(lf, ...CAM);
  check('camera LUT (1D invert .cube): the exported camera colour is the baseline inverted', near(got, baseCam.map((x) => 255 - x), 16), `baseline ${baseCam} → ${got}`);
  check('the camera LUT leaves the screen alone, and Preview agrees with the export', near(pixel(lf, ...SCREEN), baseScreen, 5) && near(pvCam, got, 16), `screen ${pixel(lf, ...SCREEN)} (was ${baseScreen}); camera preview ${pvCam}`);

  // ── 12. GPU and CPU paths give the same picture ──
  await setGrade({ screen: { lut: imp.swap.ref, strength: 0.8, sharpen: 0 }, camera: { lut: imp.invert.ref, strength: 0.6, sharpen: 0 } });
  await seek(t); await page.waitForTimeout(900);
  const glPx = [await previewPixel(...SCREEN), await previewPixel(...CAM)];
  await page.evaluate(() => window.__cutawayGrade.setGradeBackend('cpu'));
  await page.waitForTimeout(1500);
  const cpuBackend = await page.evaluate(() => window.__cutawayGrade.gradeBackend());
  const cpuPx = [await previewPixel(...SCREEN), await previewPixel(...CAM)];
  await page.evaluate(() => window.__cutawayGrade.setGradeBackend(null));
  check('without WebGL the same grade runs on the CPU and matches the GPU result', cpuBackend === 'cpu' && near(cpuPx[0], glPx[0], 3) && near(cpuPx[1], glPx[1], 3), `gpu ${JSON.stringify(glPx)}; cpu ${JSON.stringify(cpuPx)}`);

  // ── 13. sharpening ──
  await reset();
  await setGrade({ screen: { lut: null, strength: 1, sharpen: 1 }, camera: { lut: null, strength: 1, sharpen: 1 } });
  await seek(t); await page.waitForTimeout(900);
  const pvSharp = await previewPixel(...SCREEN);
  lv = await exportVideo('sharpen');
  lf = frame(lv, t, 'sharpen');
  const edge = (png, x, y, w) => { const s = strip(png, x, y, w); let sum = 0; for (let i = 1; i < s.length; i++) sum += Math.abs(s[i] - s[i - 1]); return { sum, min: Math.min(...s) }; };
  const e0 = edge(B.cam, 130, 700, 1660); const e1 = edge(lf, 130, 700, 1660);
  check('sharpening raises contrast at the edges of the screen picture', e1.sum > e0.sum * 1.08 && e1.min < e0.min - 6, `edge travel ${e0.sum} → ${e1.sum}; darkest value beside the bar ${e0.min} → ${e1.min}`);
  // the camera's bar is only inside the bubble part of the time: use the moment where the baseline shows it best
  const camEdge = [5.6, 6.0, 6.4, 6.8, 7.0, 7.3, 7.7, 8.1, 8.5, 9.0].map((tt) => ({ tt, e: edge(frame(baseVideo, tt, `base-camedge-${tt}`), 1640, 912, 220) })).sort((a, b) => b.e.sum - a.e.sum)[0];
  const c1 = edge(frame(lv, camEdge.tt, 'sharpen-camedge'), 1640, 912, 220);
  check('sharpening raises contrast at the edges of the camera picture', camEdge.e.sum > 150 && c1.sum > camEdge.e.sum * 1.08 && c1.min < camEdge.e.min - 6, `at ${camEdge.tt}s: edge travel ${camEdge.e.sum} → ${c1.sum}; darkest value beside the bar ${camEdge.e.min} → ${c1.min}`);
  check('sharpening leaves flat areas alone, in Preview and in the export', near(pixel(lf, ...SCREEN), baseScreen, 4) && near(pvSharp, pixel(lf, ...SCREEN), 12) && near(pixel(lf, ...BG), baseBg, 4), `screen ${pixel(lf, ...SCREEN)} (was ${baseScreen}); preview ${pvSharp}`);
  await page.evaluate(() => window.__cutaway.useApp.getState().setPanels({ tab: 'background' }));
  await page.getByText('Screen sharpening').scrollIntoViewIfNeeded().catch(() => {});
  await shot('11-sharpen', 900);

  // ── 14. speed: both layers graded and sharpened ──
  await reset();
  const plain = await timed('speed-plain');
  await setGrade({ screen: { lut: imp.big.ref, strength: 1, sharpen: 0.5 }, camera: { lut: imp.swap.ref, strength: 1, sharpen: 0.5 } });
  const graded = await timed('speed-graded');
  const frames = Number(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', graded.video]).toString().trim());
  const fpsPlain = frames / (plain.ms / 1000); const fpsGraded = frames / (graded.ms / 1000);
  check('a 1080p30 export with a LUT and sharpening on both layers still renders faster than real time', fpsGraded > 30, `${frames} frames: ${fpsPlain.toFixed(0)} fps plain, ${fpsGraded.toFixed(0)} fps graded (whole export, including audio and mux)`);

  // ── 15. a LUT file that went missing ──
  fs.rmSync(path.join(info.projectPath, imp.big.ref.file));
  await setGrade({ screen: { lut: imp.big.ref, strength: 1, sharpen: 0 } });
  await page.evaluate(() => window.__cutaway.saveNow?.());
  await page.evaluate(() => window.location.reload());
  await page.waitForFunction(() => !!window.__cutaway, null, { timeout: 15000 });
  await page.evaluate((p) => window.__cutaway.actions.openProjectAt(p), info.projectPath);
  await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.setView('edit'); s.setPanels({ tab: 'background', inspector: true, drawer: null }); });
  await seek(t); await page.waitForTimeout(1500);
  const missingText = await page.locator('.status-line.bad').first().innerText().catch(() => '');
  lv = await exportVideo('lut-missing');
  const mp = psnr(B.cam, frame(lv, t, 'lut-missing'));
  check('a missing LUT file is reported in the inspector and the picture is drawn ungraded, not broken', /no longer in the project folder/.test(missingText) && (mp === Infinity || mp > 42), `"${missingText.replace(/\n/g, ' ')}"; PSNR ${mp === Infinity ? 'inf' : mp.toFixed(1)} dB vs baseline`);
  await reset();

  // ── 16. photo search (against the local stand-in; the live Unsplash API is not contacted) ──
  const openImagePage = async () => { await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.go('project'); s.setView('edit'); s.select(null); s.setPanels({ tab: 'background', inspector: true, drawer: null }); }); await page.getByRole('group', { name: 'Background type' }).getByRole('button', { name: 'Image' }).click(); };
  await openImagePage();
  const noKeyText = await page.getByTestId('image-search-nokey').innerText().catch(() => '');
  const noKeyCall = await page.evaluate(async () => { try { await window.cutaway.looks.searchImages('mountains', 1); return 'ok'; } catch (e) { return e.code; } });
  const bgAfterTab = await page.evaluate(() => window.__cutaway.useApp.getState().project.edit.appearance.background.type);
  check('without an access key the Image page says where to add one, and nothing is searched', /access key/.test(noKeyText) && /Settings/.test(noKeyText) && noKeyCall === 'no-key' && mock.searches.length === 0 && bgAfterTab === 'wallpaper', `"${noKeyText}" · call → ${noKeyCall}`);
  await shot('12-image-no-key', 500);
  const saveKey = async (key) => { await page.evaluate(() => window.__cutaway.useApp.getState().go('settings')); const field = page.getByLabel('Unsplash access key'); await field.fill(key); await page.getByTestId('images-section').getByRole('button', { name: 'Save' }).click(); await page.waitForFunction((k) => window.__cutaway.useApp.getState().settings.unsplashKey === k, key, { timeout: 5000 }); };
  await saveKey('wrong-key');
  await shot('13-settings-key', 400);
  const fieldType = await page.getByLabel('Unsplash access key').getAttribute('type');
  const wrong = await page.evaluate(async () => { try { await window.cutaway.looks.searchImages('mountains', 1); return { ok: true }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } });
  check('a key Unsplash rejects is reported plainly; the field hides the key by default', !wrong.ok && wrong.code === 'bad-key' && /did not accept the access key/.test(wrong.message) && fieldType === 'password', `${wrong.code}: ${wrong.message}`);
  await saveKey('test-key');
  const settingsOnDisk = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  check('the key is saved in this Mac\'s settings file', settingsOnDisk.unsplashKey === 'test-key');
  await openImagePage();
  await page.getByLabel('Search Unsplash photos').fill('mountains');
  await page.getByTestId('image-search').getByRole('button', { name: 'Search' }).click();
  await page.waitForSelector('.photo', { timeout: 10000 });
  const photoCount = await page.locator('.photo').count();
  const thumbs = await page.locator('.photo img').evaluateAll((els) => els.filter((i) => i.complete && i.naturalWidth > 0 && i.src.startsWith('data:image/')).length);
  check('searching shows the photos, with thumbnails fetched by the main process', photoCount === 2 && thumbs === 2 && mock.searches.some((s) => s.query === 'mountains' && s.page === '1'), `${photoCount} photos, ${thumbs} thumbnails; requests ${JSON.stringify(mock.searches)}`);
  check('a result that points at another host is dropped', photoCount === 2 && !(await page.locator('.photo[aria-label*="Mallory"]').count()));
  await shot('14-image-search', 500);
  await page.locator('.photo').first().click();
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project.edit.appearance.background.type === 'image', null, { timeout: 15000 });
  const bg = await page.evaluate(() => window.__cutaway.useApp.getState().project.edit.appearance.background);
  check('picking a photo downloads it into the project and keeps the photographer credit', bg.path === 'media/backgrounds/unsplash-mockA.jpg' && fs.existsSync(path.join(info.projectPath, bg.path)) && bg.credit?.author === 'Ada Example' && bg.credit?.source === 'unsplash' && /^https:\/\/unsplash\.com\/@mockA\?utm_source=cutaway/.test(bg.credit?.authorUrl ?? '') && mock.downloads.includes('mockA'), JSON.stringify(bg));
  const creditText = await page.getByTestId('image-credit').innerText().catch(() => '');
  check('the inspector credits the photographer', /Photo by\s+Ada Example\s+on\s+Unsplash/.test(creditText.replace(/\s+/g, ' ')), creditText.replace(/\s+/g, ' '));
  await seek(t); await shot('15-image-background', 1500);
  const pvBg = await previewPixel(...BG);
  lv = await exportVideo('image-background');
  const exBg = pixel(frame(lv, t, 'image-background'), ...BG);
  check('the downloaded photo is the background in Preview and in the export', near(exBg, [16, 160, 192], 16) && near(pvBg, exBg, 14), `expected about 16,160,192; export ${exBg}; preview ${pvBg}`);
  await page.evaluate(() => window.__cutaway.saveNow?.());
  const grep = spawnSync('/usr/bin/grep', ['-rl', 'test-key', info.projectPath]);
  const pj = JSON.parse(fs.readFileSync(path.join(info.projectPath, 'project.json'), 'utf8'));
  check('the access key is not written anywhere in the project', grep.stdout.toString().trim() === '' && pj.edit.appearance.background.credit.author === 'Ada Example' && mock.auth.every((a) => a === 'Client-ID test-key' || a === 'Client-ID wrong-key'), grep.stdout.toString().trim() || 'no file in the project contains it');
  await page.getByLabel('Search Unsplash photos').fill('nothing');
  await page.getByTestId('image-search').getByRole('button', { name: 'Search' }).click();
  await page.waitForFunction(() => /No photos found/.test(document.querySelector('[data-testid="image-search"]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  check('an empty result says so', /No photos found for “nothing”/.test(await page.getByTestId('image-search').innerText()));
  await reset();

  // ── 17. default zoom level ──
  await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setPanels({ tab: 'motion', inspector: true, drawer: null }); });
  const zoomSlider = page.getByLabel('Zoom', { exact: true });
  const before = await page.evaluate(() => window.__cutaway.core.zoomLevelOf(window.__cutaway.useApp.getState().project.edit.appearance));
  await zoomSlider.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const afterKeys = await page.evaluate(() => window.__cutaway.useApp.getState().project.edit.appearance.zoomLevel);
  check('the Motion tab has a default zoom level, starting at 1.8×', before === 1.8 && Math.abs(afterKeys - 1.9) < 1e-6, `1.8 → ${afterKeys} after two steps`);
  await page.evaluate(() => window.__cutaway.useApp.getState().edit((e) => ({ ...e, zooms: [], appearance: { ...e.appearance, zoomLevel: 2.6 } }), 'zoom level'));
  await shot('16-default-zoom', 600);
  await seek(8);
  await page.locator('[title="Add zoom at the playhead"], [aria-label="Add zoom at the playhead"]').first().click();
  const added = await page.evaluate(() => window.__cutaway.useApp.getState().project.edit.zooms.map((z) => [z.scale, z.meta.origin]));
  check('a zoom added by hand starts at the project level', added.length === 1 && added[0][0] === 2.6 && added[0][1] === 'creator', JSON.stringify(added));
  await page.evaluate(() => window.__cutaway.useApp.getState().edit((e) => ({ ...e, zooms: [] }), 'clear zooms'));
  await page.evaluate(() => window.__cutaway.jobs.startFirstCut(false));
  await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return !s.job || s.job.status !== 'running'; }, null, { timeout: 180000 });
  const fc = await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); return { job: s.job && { status: s.job.status, error: s.job.error }, zooms: s.project.edit.zooms.map((z) => [z.scale, z.meta.origin]), clicks: s.project.analysis?.clicks.length }; });
  check('the first cut (built-in rules) places its zooms at the project level', !fc.job && fc.zooms.length > 0 && fc.zooms.every((z) => z[0] === 2.6 && z[1] === 'ai'), JSON.stringify(fc));
} // look

const failed = results.filter((x) => !x[0]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Frames and screenshots: ${out}`);
await app.close();
mockServer.close();
process.exit(failed.length ? 1 : 0);
