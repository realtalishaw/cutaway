// The simple timeline: the three rows, adding audio, the selection bar, S to split, right-click,
// Advanced, and a voice file marked as Music in Sources landing on the audio row.
//   node e2e/simple-timeline.mjs [outDir]
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { launch } from './harness.mjs';
const FF = '/opt/homebrew/bin/ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-simple-timeline'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const video = path.join(out, 'screen.mp4'), song = path.join(out, 'song.wav'), talk = path.join(out, 'alice.wav');
execFileSync(FF, ['-y','-loglevel','error','-f','lavfi','-i','testsrc=s=1280x720:r=30:d=12','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','12','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
execFileSync(FF, ['-y','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=5:sample_rate=48000',song]);
execFileSync(FF, ['-y','-loglevel','error','-f','lavfi','-i','sine=frequency=300:duration=30:sample_rate=48000',talk]);
let failed = 0; const check = (n, ok, d = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); if (!ok) failed++; };
const { app, page } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const music = () => state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return core.musicClipsOf(p.edit, p.sources).map((c) => ({ id: c.id, start: +c.start.toFixed(2), length: +c.length.toFixed(2), gain: c.gain, loop: !!c.loop, src: p.sources.find((s) => s.id === c.sourceId)?.name })); });
try {
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('edit'); });
  await page.waitForSelector('.timeline');
  await page.waitForTimeout(1500);
  check('the simple timeline is what you see first: text & effects, video, audio', (await page.locator('.lane-fx').count()) === 1 && (await page.locator('.lane-video').count()) === 1 && (await page.locator('.simple-mode .lane-music').count()) === 1 && (await page.locator('.lane-clip').count()) === 0);
  check('an empty audio row says Add audio', ((await page.locator('[data-testid="audio-add"]').textContent()) ?? '').includes('Add audio'));
  check('the video row draws stills of the footage', (await page.locator('.tl-clip-film').count()) >= 1);
  await page.screenshot({ path: path.join(out, '1-simple-empty.png') });

  await page.click('[data-testid="audio-add"]');
  const items = await page.locator('.popmenu [role="menuitem"]').allTextContents();
  check('Add audio offers files, an AI voiceover and a sound effect', items.some((t) => /from my files/.test(t)) && items.some((t) => /AI voiceover/.test(t)) && items.some((t) => /sound effect/i.test(t)), JSON.stringify(items));
  await page.screenshot({ path: path.join(out, '2-add-audio-menu.png') });
  await page.keyboard.press('Escape');

  // what "Music or sound from my files" does once files are picked
  await state((f) => window.__cutaway.actions.importAudioToTimeline([f]), song);
  await page.waitForTimeout(400);
  let m = await music();
  check('a picked audio file goes straight onto the audio row, from the start, and is selected', m.length === 1 && m[0].start === 0 && m[0].src === 'song.wav' && (await state(() => window.__cutaway.useApp.getState().selection?.kind)) === 'music', JSON.stringify(m));
  check('the selection bar shows the music controls', (await page.locator('[data-testid="selection-bar"] [data-testid="selbar-volume"]').count()) === 1);
  await page.click('[data-testid="selbar-volume"]');
  await page.waitForTimeout(150);
  check('Volume opens a slider', (await page.locator('.popmenu input[type="range"]').count()) === 1);
  await page.locator('.popmenu input[type="range"]').fill('0.6');
  await page.waitForTimeout(150);
  m = await music();
  check('which sets the music level', Math.abs(m[0].gain - 0.6) < 0.01, JSON.stringify(m[0]));
  await page.keyboard.press('Escape');
  await page.click('[data-testid="selbar-loop"]');
  check('Loop is one click on the bar', (await music())[0].loop === true);
  await page.screenshot({ path: path.join(out, '3-music-selected.png') });

  // S splits the selected music
  await state(() => { window.__cutaway.usePlayback.getState().seek(2); document.activeElement?.blur?.(); });
  await page.keyboard.press('s');
  await page.waitForTimeout(200);
  m = await music();
  check('S splits the selected music at the playhead', m.length === 2 && Math.abs(m[1].start - 2) < 0.01, JSON.stringify(m));

  // right-click a clip
  await state(() => window.__cutaway.useApp.getState().select(null));
  const clip = page.locator('[data-testid="clip-block"]').first();
  const cb = await clip.boundingBox();
  await page.mouse.click(cb.x + cb.width * 0.7, cb.y + cb.height / 2, { button: 'right' });
  await page.waitForTimeout(200);
  const ctx = await page.locator('.popmenu [role="menuitem"]').allTextContents();
  check('right-clicking a clip opens its menu', ctx.some((t) => /Split at the playhead/.test(t)) && (await state(() => window.__cutaway.useApp.getState().selection?.kind)) === 'clip', JSON.stringify(ctx));
  await page.locator('.popmenu [role="menuitem"]', { hasText: 'Split at the playhead' }).click();
  await page.waitForTimeout(200);
  check('and Split there splits the clip', (await page.locator('[data-testid="clip-block"]').count()) === 2);

  // + on the text & effects row
  await state(() => { window.__cutaway.useApp.getState().select(null); window.__cutaway.usePlayback.getState().seek(5); });
  await page.click('[data-testid="fx-add"]');
  await page.locator('[data-testid="add-text"]').click();
  await page.waitForTimeout(200);
  check('Add text puts a text block on the text & effects row', (await page.locator('.lane-fx .tl-item.overlay').count()) === 1);
  check('and the bar offers Edit, Duplicate, Split and Delete', (await page.locator('[data-testid="selection-bar"]').textContent()).match(/Edit.*Duplicate.*Split.*Delete/) !== null);
  await page.screenshot({ path: path.join(out, '4-simple-filled.png') });

  // Advanced brings back the detailed lanes
  await page.click('[data-testid="timeline-advanced"]');
  await page.waitForTimeout(300);
  check('Advanced shows the detailed lanes', (await page.locator('.lane-clip').count()) === 1 && (await page.locator('.lane-video').count()) === 0);
  await page.screenshot({ path: path.join(out, '5-advanced.png') });
  await page.click('[data-testid="timeline-advanced"]');
  await page.waitForTimeout(300);
  check('and back to simple', (await page.locator('.lane-video').count()) === 1);

  // your case: a screen recording with no sound, plus a voice file you then mark as Music in Sources
  const silent = path.join(out, 'silent.mp4');
  execFileSync(FF, ['-y','-loglevel','error','-f','lavfi','-i','testsrc=s=1280x720:r=30:d=12','-c:v','libx264','-pix_fmt','yuv420p','-an',silent]);
  await state((fs) => window.__cutaway.actions.importIntoNewProject(fs), [silent, talk]);
  const before = await state(() => { const p = window.__cutaway.useApp.getState().project; const a = p.sources.find((s) => s.name === 'alice.wav'); return { role: a.role, master: p.edit.audio.masterVoiceId === a.id }; });
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('sources'); });
  await page.waitForSelector('select[aria-label="Role of alice.wav"]');
  await page.selectOption('select[aria-label="Role of alice.wav"]', 'music');
  await page.waitForTimeout(400);
  const after = await state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; const a = p.sources.find((s) => s.name === 'alice.wav'); return { role: a.role, master: p.edit.audio.masterVoiceId === a.id, onRow: core.musicClipsOf(p.edit, p.sources).some((c) => c.sourceId === a.id) }; });
  check('a voice file changed to Music in Sources stops being the master voice and goes on the audio row', before.role === 'voice' && before.master && after.role === 'music' && !after.master && after.onRow, JSON.stringify({ before, after }));
  await page.screenshot({ path: path.join(out, '6-sources.png') });
  await state(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForTimeout(800);
  check('and it shows on the timeline', (await page.locator('.simple-mode .lane-music .tl-item.music').count()) === 1);
  await page.screenshot({ path: path.join(out, '7-music-on-row.png') });
} finally { await app.close(); }
console.log(failed ? failed + ' failed' : 'all simple-timeline checks passed');
process.exit(failed ? 1 : 0);
