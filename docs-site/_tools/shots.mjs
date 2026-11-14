// Screenshots for the docs, taken from the real app driven by Playwright.
// Needs the footage from make-footage.mjs. Never touches your real projects (throwaway profile).
// Usage: node docs-site/_tools/shots.mjs <footageDir> <outDir> [only]
import { launch } from '../../apps/desktop/e2e/harness.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const demo = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] ?? 'images');
const only = process.argv[4] ? new RegExp(process.argv[4]) : null;
fs.mkdirSync(out, { recursive: true });

// Friendly file names: the project is named after the first file.
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-docs-media-'));
const f = (n) => path.join(media, n);
fs.copyFileSync(path.join(demo, 'screen.mp4'), f('Screen recording.mp4'));
execSync(`ffmpeg -hide_banner -loglevel error -y -ss 26 -i "${path.join(demo, 'screen.mp4')}" -frames:v 1 "${f('frame.png')}"`);
fs.copyFileSync(path.join(demo, 'camera.mp4'), f('Camera.mp4'));
fs.copyFileSync(path.join(demo, 'music.mp3'), f('Upbeat acoustic.mp3'));

const { app, page, libraryDir } = await launch({ profile: fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-docs-')) });
const S = (fn, arg) => page.evaluate(fn, arg);
const clearToasts = () => S(() => { const s = window.__cutaway.useApp.getState(); s.toasts.forEach((t) => s.dismissToast(t.id)); });
// steps the docs pass through but don't show
const UNUSED = new Set(['add-menu-fx', 'add-menu-video', 'camera-layouts', 'first-cut-working', 'package', 'shorts', 'tab-shortcuts']);
async function shot(name, { wait = 700, clip, el } = {}) {
  if ((only && !only.test(name)) || UNUSED.has(name)) return;
  await page.waitForTimeout(wait);
  await clearToasts();
  // show the default folders instead of the throwaway test profile's temp paths
  await S(() => {
    const fix = (v) => v.replace(/\S*cutaway-docs-[A-Za-z0-9]+\/Library/g, '~/Movies/Cutaway').replace(/\S*cutaway-docs-[A-Za-z0-9]+\/Exports/g, '~/Movies/Cutaway Exports');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) if (n.nodeValue.includes('cutaway-docs-')) n.nodeValue = fix(n.nodeValue);
    for (const i of document.querySelectorAll('input')) if (i.value.includes('cutaway-docs-')) i.value = fix(i.value);
  });
  await page.waitForTimeout(150);
  const file = path.join(out, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: file });
  else await page.screenshot({ path: file, clip });
  console.log('shot', name);
}
const panel = (tab) => S((t) => { const s = window.__cutaway.useApp.getState(); s.select(null); s.setView('edit'); s.setPanels({ inspector: true, tab: t }); }, tab);
const seek = (t) => S((x) => { const { useApp, usePlayback, timeMapOf } = window.__cutaway; usePlayback.getState().seek(timeMapOf(useApp.getState().project).toOutput(x)); }, t);

try {
  // ── Library, empty ──
  await shot('library-empty', { wait: 1200 });

  // ── Recorder ──
  await S(() => window.__cutaway.actions.newRecording());
  await page.waitForTimeout(6000);
  const frame = 'data:image/png;base64,' + fs.readFileSync(f('frame.png')).toString('base64');
  await S((src) => {
    // The live preview shows the real desktop: cover every picture with a demo frame, and use generic display names.
    for (const el of document.querySelectorAll('video, img, canvas')) {
      const r = el.getBoundingClientRect();
      if (r.width < 60) continue;
      const cover = document.createElement('img');
      cover.src = src; cover.className = 'docs-cover';
      // right on top of the live picture, but under anything drawn over it (like the Start recording card)
      Object.assign(cover.style, { position: 'absolute', left: el.offsetLeft + 'px', top: el.offsetTop + 'px', width: el.offsetWidth + 'px', height: el.offsetHeight + 'px', objectFit: 'contain', background: '#000', pointerEvents: 'none', zIndex: getComputedStyle(el).zIndex === 'auto' ? 0 : getComputedStyle(el).zIndex, borderRadius: getComputedStyle(el).borderRadius });
      el.insertAdjacentElement('afterend', cover);
    }
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; let k = 0;
    while ((n = walk.nextNode())) {
      if (/HP |Display|LG |Dell|Studio/.test(n.nodeValue) && !/Display$/.test(n.nodeValue.trim()) ) n.nodeValue = n.nodeValue.replace(/[A-Z]{2,}[^()]*?\d+\w*/, 'Second display');
    }
  }, frame);
  await shot('record', { wait: 300 });
  await S(() => document.querySelectorAll('.docs-cover').forEach((e) => e.remove()));
  await S(() => window.__cutaway.actions.backToLibrary());

  // ── Import → brief ──
  await S((files) => window.__cutaway.actions.importIntoNewProject(files), [f('Screen recording.mp4'), f('Camera.mp4')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await S(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, name: 'My first video' })));
  await S(() => window.__cutaway.useApp.getState().setView('sources'));
  await shot('sources', { wait: 2500 });
  await S(() => window.__cutaway.useApp.getState().setView('brief'));
  await shot('first-cut-brief', { wait: 1200 });

  // ── First cut (built-in rules, nothing sent anywhere) ──
  await S(() => window.__cutaway.jobs.startFirstCut(false));
  await page.waitForTimeout(1500);
  await shot('first-cut-working', { wait: 0 });
  await page.waitForFunction(() => !window.__cutaway.useApp.getState().job, null, { timeout: 300000 });
  await S(() => window.__cutaway.saveNow());

  // music on the timeline
  await S((p) => window.__cutaway.actions.importAudioToTimeline(p), [f('Upbeat acoustic.mp3')]);
  await page.waitForTimeout(1500);

  // ── Editor overview ──
  await panel('background');
  await S(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: false } })));
  await seek(27);
  await shot('editor', { wait: 2500 });
  for (const tab of ['background', 'cursor', 'camera', 'captions', 'transcript', 'audio', 'text', 'shortcuts', 'motion', 'chat', 'review', 'history']) {
    await panel(tab);
    await shot(`tab-${tab}`, { wait: 700 });
  }
  // ── things you add and change ──
  const click = async (sel) => { await page.locator(sel).first().click({ timeout: 5000 }); await page.waitForTimeout(500); };
  const step = async (name, fn, opts) => { try { await fn(); await shot(name, opts); } catch (e) { console.log('skip', name, e.message.split('\n')[0]); } await page.keyboard.press('Escape').catch(() => {}); };
  await panel('background'); await seek(24.6);
  await step('add-zoom', () => click('[aria-label="Add zoom at the playhead"]'));
  await panel('background'); await seek(4);
  await step('add-text', () => click('[aria-label^="Add text at the playhead"]'));
  await panel('background'); await seek(27);
  await step('add-callout', () => click('[aria-label="Add a callout at the playhead"]'));
  await panel('background');
  await step('camera-layouts', () => page.locator('.ed-tools').first().hover(), { wait: 300 });
  await step('crop', () => click('[data-testid="crop-open"]'));
  await panel('background');
  await step('output-shape', () => click('button[title="Output shape"]'));
  await page.locator('button[title="Output shape"]').first().click({ force: true }).catch(() => {});
  await page.mouse.click(700, 900).catch(() => {});
  await panel('background');
  await step('add-menu-fx', () => click('[data-testid="fx-add"]'));
  await step('add-menu-video', () => click('[data-testid="video-add"]'));
  await step('add-menu-audio', () => click('[data-testid="audio-add"]'));
  await panel('background'); await seek(10);
  await step('clip-selected', async () => { await page.locator('.tl-clip').first().click({ force: true, position: { x: 200, y: 20 } }); await page.waitForTimeout(500); });
  await panel('background'); await seek(12);
  await step('mask', () => click('[aria-label^="Hide sensitive content"]'));
  await panel('background');
  await step('find-sensitive', () => click('[aria-label^="Find sensitive data"]'), { wait: 2500 });
  await panel('background');
  await S(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, advancedTimeline: true } })));
  await step('timeline-advanced', async () => {}, { wait: 900 });
  await S(() => window.__cutaway.useApp.getState().patch((p) => ({ ...p, ui: { ...p.ui, advancedTimeline: false } })));
  await S(() => window.__cutaway.saveNow());
  await S(() => window.__cutaway.actions.backToLibrary());
  await shot('library', { wait: 2000 });

  for (const view of ['package', 'shorts', 'export']) {
    await S(async (p) => { await window.__cutaway.actions.openProjectAt(p); }, (await S(() => window.cutaway.library.list()))[0].path);
    await S((v) => window.__cutaway.useApp.getState().setView(v), view);
    await shot(view, { wait: 1800 });
    if (view === 'package') { try { await page.getByText('Create three concepts').click(); await page.waitForTimeout(9000); await shot('package-concepts', { wait: 500 }); } catch (e) { console.log('skip concepts', e.message.split('\n')[0]); } }
    if (view === 'shorts') { try { await page.getByText('Find shorts').click(); await page.waitForTimeout(12000); await shot('shorts-found', { wait: 500 }); } catch (e) { console.log('skip shorts', e.message.split('\n')[0]); } }
  }
  await S(() => window.__cutaway.useApp.getState().go('settings'));
  await shot('settings', { wait: 1200 });
} finally {
  await app.close();
}
console.log('done', out);
