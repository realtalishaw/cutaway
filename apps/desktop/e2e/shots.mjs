// Visual review helper: opens (or builds) a demo project in a persistent profile and screenshots every main screen.
// Usage: PROFILE=<dir> node e2e/shots.mjs <outDir>
import { launch, root } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
const out = process.argv[2] ?? '/tmp/cutaway-shots';
fs.mkdirSync(out, { recursive: true });
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
const { app, page } = await launch({ profile: process.env.PROFILE });
const shot = async (name, wait = 700) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
let existing = await page.evaluate(() => window.cutaway.library.list());
if (!existing.length) {
  await page.evaluate(async (files) => { await window.__cutaway.actions.importIntoNewProject(files); }, [fx('screen.mp4'), fx('camera-a.mov'), fx('broll-render-farm.mp4')]);
  await page.evaluate(() => window.__cutaway.jobs.startFirstCut(false));
  await page.waitForFunction(() => !window.__cutaway.useApp.getState().job, null, { timeout: 240000 });
  await page.evaluate(() => { const { useApp, core } = window.__cutaway; const st = useApp.getState(); st.edit((e, p) => core.applyOps(e, [{ op: 'zoom', start: 4.5, end: 7.2, scale: 2, x: 0.3, y: 0.3, follow: false }, { op: 'zoom', start: 16.5, end: 19.5, scale: 1.6 }, { op: 'overlay', kind: 'callout', start: 9, end: 13, text: 'Pick the format first' }], 'creator', p.revision + 1), 'Demo edits'); });
  await page.evaluate(() => window.__cutaway.saveNow());
  await page.evaluate(() => window.__cutaway.actions.backToLibrary());
  existing = await page.evaluate(() => window.cutaway.library.list());
}
await shot('01-library', 1200);
await page.evaluate((p) => window.__cutaway.actions.openProjectAt(p), existing[0].path);
const S = () => page.evaluate(() => 0);
await page.evaluate(() => { const { useApp, usePlayback, timeMapOf } = window.__cutaway; const s = useApp.getState(); s.setView('edit'); s.select(null); s.setPanels({ inspector: true, tab: 'background' }); s.patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: false } })); usePlayback.getState().seek(timeMapOf(useApp.getState().project).toOutput(5.6)); });
await shot('02-editor', 2500);
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: true } })); s.setPanels({ tab: 'transcript' }); });
await shot('03-editor-transcript');
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.setPanels({ tab: 'review' }); });
await shot('04-editor-review');
await page.evaluate(() => { const s = window.__cutaway.useApp.getState(); s.setPanels({ tab: 'background' }); s.select({ kind: 'zoom', id: s.project.edit.zooms[0].id }); });
await shot('05-editor-zoom-selected');
for (const tab of ['cursor', 'camera', 'captions', 'audio', 'shortcuts', 'motion']) { await page.evaluate((t) => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setPanels({ tab: t }); }, tab); await shot(`06-tab-${tab}`, 400); }
for (const view of ['sources', 'brief', 'package', 'export']) { await page.evaluate((v) => window.__cutaway.useApp.getState().setView(v), view); await shot(`07-${view}`, 1500); }
await page.evaluate(() => window.__cutaway.useApp.getState().go('settings'));
await shot('08-settings');
await page.evaluate(async () => { await window.__cutaway.actions.backToLibrary(); await window.__cutaway.actions.newRecording(); });
await shot('09-record', 2500);
await page.evaluate(() => window.__cutaway.actions.backToLibrary());
await S();
await app.close();
console.log('shots in', out);
