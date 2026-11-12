// Journeys through the real app + real native helper, using the helper's synthetic
// capture mode (same clock/writers/recovery code, generated pictures; needs no permission).
//   A. two live cameras + screen + mic + system audio → pause/resume → first cut → package → export
//   B. recorder killed mid-take → recovery offers the checkpointed media
// Usage: node e2e/journey.mjs <outDir>
import { launch } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';

const out = process.argv[2] ?? '/tmp/cutaway-journey';
fs.mkdirSync(out, { recursive: true });
const { app, page, exportDir } = await launch();
const results = [];
const check = (name, ok, detail = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIG = { fps: 30, synthetic: true, screen: { type: 'display', displayId: 1, showCursor: false }, cameras: [{ slot: 'A', deviceId: 'synthetic-a', width: 1280, height: 720, fps: 30 }, { slot: 'B', deviceId: 'synthetic-b', width: 1280, height: 720, fps: 30 }], microphone: { deviceId: '' }, systemAudio: true };

// ── A ──
await page.evaluate(async () => { const { path } = await window.cutaway.library.create('Two camera journey'); await window.__cutaway.actions.openProjectAt(path); });
const started = await page.evaluate(async (config) => { const st = window.__cutaway.useApp.getState(); window.__events = []; window.cutaway.record.onEvent((e) => window.__events.push(e)); return window.cutaway.record.start(st.projectPath, config); }, CONFIG);
await sleep(3000);
await page.evaluate(() => window.cutaway.record.pause());
await sleep(1500);
await page.evaluate(() => window.cutaway.record.resume());
await sleep(5000);
const manifest = await page.evaluate(() => window.cutaway.record.stop());
check('two-camera take stops with a complete manifest', manifest.complete === true && manifest.sources.length === 5, `${manifest.sources.map((s) => `${s.id}:${s.duration.toFixed(2)}s@${s.start.toFixed(3)}`).join(' ')}`);
check('paused interval is absent from the take', manifest.duration > 7.4 && manifest.duration < 8.8 && manifest.pauses.length === 1, `duration ${manifest.duration.toFixed(2)}s, pause wall ${manifest.pauses[0]?.wallDuration?.toFixed(2)}s`);
const starts = manifest.sources.filter((s) => s.role !== 'systemAudio' && s.role !== 'voice').map((s) => s.start);
check('sources share one clock (video starts within a frame of each other)', Math.max(...starts) - Math.min(...starts) < 0.05, `spread ${((Math.max(...starts) - Math.min(...starts)) * 1000).toFixed(1)} ms`);
const added = await page.evaluate(async ({ manifest, takeDir }) => { const r = await window.__cutaway.recording.addTakeToProject(manifest, takeDir); const p = window.__cutaway.useApp.getState().project; return { added: r.added.length, roles: p.sources.map((s) => [s.role, s.sync.method, s.sync.status, s.cursorBaked, !!s.cursorFile, s.managed]), duration: p.duration, master: p.sources.find((s) => s.id === p.edit.audio.masterVoiceId)?.role }; }, { manifest, takeDir: started.takeDir });
check('project holds independent screen, camera A, camera B, voice and system tracks', ['screen', 'cameraA', 'cameraB', 'voice', 'systemAudio'].every((r) => added.roles.some((x) => x[0] === r)), JSON.stringify(added.roles.map((r) => r[0])));
check('recorded sources are aligned by the recorded clock, cursor kept separate', added.roles.filter((r) => r[0] !== 'systemAudio').every((r) => r[1] === 'recorded-clock' && r[2] === 'aligned') && added.roles.find((r) => r[0] === 'screen')[3] === false && added.roles.find((r) => r[0] === 'screen')[4] === true, `master voice: ${added.master}`);
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.go('project'); s.setView('sources'); });
await shot('A1-sources-two-cameras');

// manual angle decisions, then a first cut must leave them alone
await page.evaluate(() => { const { useApp, core } = window.__cutaway; useApp.getState().edit((e, p) => core.applyOps(e, [{ op: 'layout', start: 1, end: 3, mode: 'camera', camera: 'B', transition: 'cut' }], 'creator', p.revision + 1), 'Manual angle'); });
await page.evaluate(() => window.__cutaway.jobs.startFirstCut(false));
await page.waitForFunction(() => !window.__cutaway.useApp.getState().job || window.__cutaway.useApp.getState().job.status !== 'running', null, { timeout: 180000 });
const cut = await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); const p = s.project; return { job: s.job && { status: s.job.status, error: s.job.error }, firstCut: p.firstCut, transcript: p.transcript && { hasSpeech: p.transcript.hasSpeech, words: p.transcript.words.length }, manual: p.edit.layouts.filter((l) => l.meta.origin === 'creator').map((l) => [l.mode, l.camera, l.start, l.end]), layouts: p.edit.layouts.length, clicks: p.analysis?.clicks.length, out: window.__cutaway.timeMapOf(p).outDuration }; });
check('first cut completes on a take without speech', !cut.job && !!cut.firstCut, cut.job ? JSON.stringify(cut.job) : cut.firstCut.summary.slice(0, 140));
check('no transcript is fabricated for a silent take', !cut.transcript || (cut.transcript.hasSpeech === false && cut.transcript.words === 0), JSON.stringify(cut.transcript));
check('the manual camera-B decision survives the AI pass', cut.manual.length === 1 && cut.manual[0][1] === 'B' && cut.manual[0][2] === 1 && cut.manual[0][3] === 3, JSON.stringify(cut.manual));
await page.evaluate(() => { const { usePlayback, useApp, timeMapOf } = window.__cutaway; usePlayback.getState().seek(timeMapOf(useApp.getState().project).toOutput(2)); useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } })); });
await page.waitForTimeout(1200);
await shot('A2-editor-camera-b');

// packaging (templates, nothing sent) → full package export
const pack = await page.evaluate(async () => {
  const { useApp, jobs, pipeline } = window.__cutaway;
  const ctx = jobs.jobContext(new AbortController().signal, false);
  const r = await pipeline.generatePackaging(ctx);
  const p = useApp.getState().project;
  useApp.getState().pack((k) => ({ ...k, selectedId: k.concepts[0]?.id ?? null, reviewed: true }), 'Choose concept');
  return { concepts: p.packaging.concepts.map((c) => [c.title, c.origin, c.layers.length]), ai: r.ai };
});
check('three editable thumbnail/title concepts exist without Claude', pack.concepts.length >= 3 && pack.concepts.every((c) => c[2] >= 2), JSON.stringify(pack.concepts.map((c) => c[0])));
const exp = await page.evaluate(async (dest) => {
  const { useApp, packageExport } = window.__cutaway;
  const st = useApp.getState();
  const t0 = performance.now();
  const r = await packageExport.runPackageExport({ project: st.project, projectPath: st.projectPath, destDir: dest, draft: true, onProgress: () => {}, signal: new AbortController().signal });
  if (r.record) st.patch((p) => ({ ...p, exports: [...p.exports, r.record] }));
  return { status: r.status, folder: r.folder, files: r.files, error: r.error, notes: r.notes, seconds: (performance.now() - t0) / 1000, video: r.video };
}, exportDir);
check('package export completes', exp.status === 'complete', exp.error ? JSON.stringify(exp.error) : `${exp.files.map((f) => f.name).join(', ')} in ${exp.seconds.toFixed(1)}s`);
if (exp.folder) {
  const names = fs.readdirSync(exp.folder);
  check('folder has video, thumbnail, title and package.json; no captions for a silent take', ['video.mp4', 'thumbnail.jpg', 'title.txt', 'title-options.txt', 'package.json'].every((n) => names.includes(n)) && !names.includes('captions.srt'), names.join(', '));
  const probe = execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,nb_frames,color_primaries,sample_rate,channels:format=duration', '-of', 'compact', path.join(exp.folder, 'video.mp4')]).toString().trim();
  console.log(probe);
  check('video is H.264 1920×1080 with AAC audio', /codec_name=h264/.test(probe) && /width=1920\|height=1080/.test(probe) && /codec_name=aac/.test(probe));
  const pkg = JSON.parse(fs.readFileSync(path.join(exp.folder, 'package.json'), 'utf8'));
  check('package.json records the edit revision and that nothing was uploaded', typeof pkg.editRevision === 'number' && pkg.uploadedToYouTube === false && pkg.captions.omittedReason, `revision ${pkg.editRevision}; captions: ${pkg.captions.omittedReason}`);
  execSync(`/opt/homebrew/bin/ffmpeg -hide_banner -loglevel error -y -i "${path.join(exp.folder, 'video.mp4')}" -vf "select='eq(n,20)+eq(n,60)+eq(n,120)+eq(n,200)',scale=960:-1,tile=2x2" -frames:v 1 "${path.join(out, 'A3-export-frames.png')}"`);
}
// reopen: same media, revision, packaging, restorable AI checkpoint (SC-001, SC-027)
const before = await page.evaluate(async () => { await window.__cutaway.saveNow(); const s = window.__cutaway.useApp.getState(); return { path: s.projectPath, revision: s.project.revision, selected: s.project.packaging.selectedId, sources: s.project.sources.length, exports: s.project.exports.length }; });
await page.evaluate(() => window.__cutaway.actions.backToLibrary());
await page.waitForTimeout(600);
await shot('A4-library');
const after = await page.evaluate(async (p) => { await window.__cutaway.actions.openProjectAt(p); const s = window.__cutaway.useApp.getState().project; return { revision: s.revision, selected: s.packaging.selectedId, sources: s.sources.length, available: s.sources.every((x) => x.available), exports: s.exports.length, checkpoints: s.revisions.map((r) => r.label) }; }, before.path);
check('saved project reopens with the same media, revision, packaging and export history', after.revision === before.revision && after.selected === before.selected && after.sources === before.sources && after.available && after.exports === before.exports, JSON.stringify(after.checkpoints));
check('the AI cut can still be restored after reopening', after.checkpoints.some((l) => /first cut/i.test(l)));

// ── B: crash during capture ──
await page.evaluate(async () => { await window.__cutaway.actions.backToLibrary(); const { path } = await window.cutaway.library.create('Crash recovery'); await window.__cutaway.actions.openProjectAt(path); window.__events = []; });
const b = await page.evaluate(async (config) => window.cutaway.record.start(window.__cutaway.useApp.getState().projectPath, config), CONFIG);
await sleep(6500);
execSync('pkill -9 -f "cutaway-native record" || true');
await sleep(1500);
const crashed = await page.evaluate(() => window.__events.filter((e) => e.type === 'crashed').length);
check('a killed recorder is reported as a crash, not a clean stop', crashed === 1);
const rec = await page.evaluate(() => window.cutaway.library.recoverable());
check('interrupted take is offered for recovery', rec.some((r) => r.takeDir === b.takeDir), `${rec.length} recoverable`);
const recovered = await page.evaluate((d) => window.cutaway.library.recover(d), b.takeDir);
check('recovery returns usable media up to the last checkpoint (≤ 2 s lost)', recovered.recovered === true && recovered.duration >= 4.0 && recovered.duration <= 6.6, `recovered ${recovered.duration.toFixed(2)}s of ~6.5s; sources ${recovered.sources.map((s) => `${s.id}:${s.duration.toFixed(1)}`).join(' ')}`);
const addedB = await page.evaluate(async ({ manifest, takeDir }) => { const r = await window.__cutaway.recording.addTakeToProject(manifest, takeDir); return { n: r.added.length, playable: window.__cutaway.useApp.getState().project.sources.every((s) => s.available && s.duration > 3) }; }, { manifest: recovered, takeDir: b.takeDir });
check('recovered sources open in the project', addedB.n >= 3 && addedB.playable, `${addedB.n} sources`);
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.go('project'); s.setView('edit'); });
await page.waitForTimeout(1500);
await shot('B1-recovered-editor');

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await app.close();
process.exit(failed.length ? 1 : 0);
