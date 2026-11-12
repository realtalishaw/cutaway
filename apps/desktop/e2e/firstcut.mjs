// End-to-end: import generated footage → first cut → manual edits → export → verify the file.
// Usage: node e2e/firstcut.mjs <outDir for screenshots>
import { launch, root } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const shots = process.argv[2] ?? '/tmp/cutaway-e2e';
fs.mkdirSync(shots, { recursive: true });
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
const { app, page, exportDir } = await launch();
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const log = (...a) => console.log(...a);

const report = await page.evaluate(async (files) => {
  const r = await window.__cutaway.actions.importIntoNewProject(files);
  return { accepted: r.accepted.map((a) => [a.source.role, a.source.name, a.source.sync.status]), rejected: r.rejected.map((x) => [x.path.split('/').pop(), x.error?.code, x.error?.message]) };
}, [fx('screen.mp4'), fx('camera-a.mov'), fx('broll-render-farm.mp4'), fx('corrupt.mp4')]);
log('import', JSON.stringify(report));
await shot('01-sources');

// sync camera A from shared audio
const sync = await page.evaluate(async () => {
  const { useApp, core } = window.__cutaway;
  const st = useApp.getState();
  const p = st.project;
  const ref = p.sources.find((s) => s.role === 'screen');
  const cam = p.sources.find((s) => s.role === 'cameraA');
  const abs = (s) => (s.path.startsWith('/') ? s.path : `${st.projectPath}/${s.path}`);
  const r = await window.cutaway.native.correlate(abs(ref), abs(cam), 600);
  st.patch((q) => core.withSources(q, q.sources.map((s) => (s.id === cam.id ? { ...s, sync: { ...s.sync, offset: r.offset, rate: r.rate, method: 'audio-correlation', confidence: r.confidence, status: r.reliable ? 'aligned' : 'needs-review', checkpoints: r.checkpoints, confirmedByCreator: r.reliable } } : s))));
  return r;
});
log('sync', JSON.stringify(sync));

await page.evaluate(() => window.__cutaway.useApp.getState().setView('brief'));
await shot('02-brief');
await page.getByRole('button', { name: /Create first cut/ }).click();
await page.waitForTimeout(1500);
await shot('03-processing');
await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return !s.job || s.job.status !== 'running'; }, null, { timeout: 240000 });
const cut = await page.evaluate(() => {
  const { useApp, timeMapOf } = window.__cutaway;
  const s = useApp.getState();
  const p = s.project;
  return { job: s.job && { status: s.job.status, error: s.job.error, stages: s.job.stages.map((x) => [x.id, x.status, x.detail]) }, view: p.ui.view, firstCut: p.firstCut, words: p.transcript?.words.length, engine: p.transcript?.engine, text: p.transcript?.words.map((w) => w.text).join(' ').slice(0, 400), cuts: p.edit.cuts.map((c) => [c.kind, +c.start.toFixed(2), +c.end.toFixed(2), c.meta.origin]), layouts: p.edit.layouts.map((l) => [l.mode, l.camera, +l.start.toFixed(1), +l.end.toFixed(1)]), zooms: p.edit.zooms.length, suggestions: p.edit.suggestions.map((x) => [x.kind, x.title, x.status]), duration: p.duration, out: timeMapOf(p).outDuration, revisions: p.revisions.map((r) => r.label) };
});
log('firstcut', JSON.stringify(cut, null, 1));
await shot('04-editor');

// manual edits: a zoom, a mask, a callout, expanded timeline
await page.evaluate(() => {
  const { useApp, core } = window.__cutaway;
  const st = useApp.getState();
  st.edit((e, p) => core.applyOps(e, [{ op: 'zoom', start: 8, end: 13, scale: 2, x: 0.25, y: 0.3, follow: false }, { op: 'overlay', kind: 'callout', start: 9, end: 13, text: 'Pick the format first' }], 'creator', p.revision + 1), 'Test edits');
  st.edit((e, p) => ({ ...e, masks: [...e.masks, { id: 'mask_test', start: 0, end: 20, target: 'screen', rect: { x: 0.02, y: 0.0, w: 0.2, h: 0.06 }, style: 'blur', meta: { origin: 'creator', revision: p.revision + 1 } }] }), 'Mask');
  st.patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } }));
  window.__cutaway.usePlayback.getState().seek(window.__cutaway.timeMapOf(useApp.getState().project).toOutput(10.5));
});
await page.waitForTimeout(1500);
await shot('05-editor-zoomed');
await page.evaluate(() => window.__cutaway.usePlayback.getState().setPlaying(true));
await page.waitForTimeout(2500);
const playing = await page.evaluate(() => ({ t: window.__cutaway.usePlayback.getState().time, playing: window.__cutaway.usePlayback.getState().playing }));
log('playback', JSON.stringify(playing));
await page.evaluate(() => window.__cutaway.usePlayback.getState().setPlaying(false));
await shot('06-editor-playing');

// local revision: lock one range, ask for "no zooms" in another, compare, accept, undo (SC-016)
const rev = await page.evaluate(async () => {
  const { useApp, core, jobs } = window.__cutaway;
  let st = useApp.getState();
  st.replace(core.applyProposal(st.project, [{ op: 'zoom', start: 15, end: 19, scale: 2.4, x: 0.7, y: 0.3 }, { op: 'zoom', start: 30, end: 34, scale: 2 }], { label: 'Test AI zooms' }).project, 'Test AI zooms');
  st.edit((e) => core.addLock(e, { start: 29, end: 35 }, 'keep this explanation intact'), 'Lock');
  const manualBefore = JSON.stringify(useApp.getState().project.edit.zooms.filter((z) => z.meta.origin === 'creator'));
  await jobs.reviseSection({ start: 14, end: 20 }, 'no zooms in this section');
  const c = useApp.getState().comparison;
  if (!c) return { comparison: false };
  const inScope = (p) => p.edit.zooms.filter((z) => z.start < 20 && z.end > 14).length;
  const out = { comparison: true, label: c.label, notes: c.notes, beforeInScope: inScope(c.before), afterInScope: inScope(c.after), lockedZoomKept: c.after.edit.zooms.some((z) => z.start >= 29.9 && z.end <= 34.1), manualKept: JSON.stringify(c.after.edit.zooms.filter((z) => z.meta.origin === 'creator')) === manualBefore };
  return out;
});
log('revision', JSON.stringify(rev));
await shot('07-compare');
const acc = await page.evaluate(() => {
  const { useApp, jobs } = window.__cutaway;
  jobs.acceptComparison();
  const after = useApp.getState().project.edit.zooms.filter((z) => z.start < 20 && z.end > 14).length;
  useApp.getState().undo();
  const undone = useApp.getState().project.edit.zooms.filter((z) => z.start < 20 && z.end > 14).length;
  return { afterAccept: after, afterUndo: undone };
});
log('accept/undo', JSON.stringify(acc));

// export through the real renderer pipeline
const exp = await page.evaluate(async (dest) => {
  const { useApp, exporter } = window.__cutaway;
  const st = useApp.getState();
  const session = await window.cutaway.export.begin(dest, 'e2e-export');
  const t0 = performance.now();
  let last = null;
  try {
    const r = await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: (p) => (last = p), signal: new AbortController().signal });
    const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
    return { ok: true, r, seconds: (performance.now() - t0) / 1000, last, folder: done.folder, files: done.files };
  } catch (e) {
    await window.cutaway.export.abort(session.id, false);
    return { ok: false, error: e.message, code: e.code, last };
  }
}, exportDir);
log('export', JSON.stringify(exp));
if (exp.ok) {
  const f = path.join(exp.folder, 'video.mp4');
  log(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,nb_frames,duration,color_space,color_primaries,color_transfer,sample_rate,channels:format=duration,size', '-of', 'compact', f]).toString());
  fs.copyFileSync(f, path.join(shots, 'export.mp4'));
}
await app.close();
