// Animations: the Subscribe template added at the playhead with its own words, rendered to transparent
// frames, drawn in the preview and in an export (checked from its pixels and its sound), a field changed,
// then "describe it" with a stand-in AI whose first page is broken, so the check-and-fix loop runs, then a
// change to it and undo. Nothing is sent to a real AI.
//   node e2e/motion.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-motion'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const video = path.join(out, 'screen.mp4');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1ec81e:s=1280x720:r=30:d=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const { app, page, exportDir } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const motions = () => state(() => window.__cutaway.useApp.getState().project.edit.overlays.filter((o) => o.kind === 'motion').map((o) => ({ id: o.id, start: +o.start.toFixed(2), end: +o.end.toFixed(2), file: o.motion.file, name: o.motion.name, fields: Object.fromEntries(o.motion.fields.map((f) => [f.id, f.value])), sounds: o.motion.sounds.length, origin: o.motion.origin })));
/** Colour of the preview at a point of the frame (0…1), by name. */
const name = ([r, g, b]) => (r > 180 && g < 80 && b < 90 ? 'red' : r > 200 && g > 200 && b > 200 ? 'light' : g > 150 && r < 90 && b < 90 ? 'green' : r < 90 && g < 90 && b > 160 ? 'blue' : `rgb(${r},${g},${b})`);
const previewAt = (x, y) => state(([x, y]) => { const c = document.querySelector('.preview-canvas'); const k = document.createElement('canvas'); k.width = c.width; k.height = c.height; const g = k.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data; return [d[0], d[1], d[2]]; }, [x, y]);
const seek = (t) => state((t) => { const { usePlayback } = window.__cutaway; usePlayback.getState().setPlaying(false); usePlayback.getState().seek(t); }, t);
// a point inside the button's left end, clear of its words (the button's row starts at 66% of the height,
// and the bell beside it moves it a little left)
const BTN = [0.35, 0.71];
const ready = () => page.waitForSelector('[data-testid="motion-render-status"][data-state="ready"]', { timeout: 60000 });
try {
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('edit'); st.edit((e) => ({ ...e, appearance: { ...e.appearance, background: { type: 'solid', color: '#101820' } } }), 'flat'); });
  await page.waitForSelector('.lane-video');
  await page.waitForTimeout(500);

  // ── the template ──
  await seek(2);
  await page.click('[data-testid="fx-add"]');
  await page.click('[data-testid="add-motion"]');
  await page.waitForSelector('[data-testid="motion-sheet"]');
  await page.fill('input[aria-label="Button text"]', 'Join');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '1-sheet.png') });
  await page.click('[data-testid="motion-add"]');
  await page.waitForTimeout(600);
  let m = await motions();
  check('the template goes on the text & effects row at the playhead, for its own length, with the chosen words', m.length === 1 && m[0].start === 2 && m[0].end === 6.2 && m[0].fields.label === 'Join' && m[0].sounds === 2 && /^media\/motion\/subscribe-/.test(m[0].file), JSON.stringify(m));
  check('it is selected and shows as an animation block', (await page.locator('.lane-fx .tl-item.motion').count()) === 1 && (await state(() => window.__cutaway.useApp.getState().selection?.kind)) === 'overlay');
  const t0 = Date.now();
  await ready();
  check('its frames are prepared in the background', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await seek(1.5);
  await page.waitForTimeout(500);
  const before = name(await previewAt(...BTN));
  await seek(3);
  await page.waitForTimeout(700);
  const pressed = name(await previewAt(...BTN));
  await seek(4);
  await page.waitForTimeout(700);
  const after = name(await previewAt(...BTN));
  check('the preview draws it: nothing before, the red button, then the grey "subscribed" button', before !== 'red' && before !== 'light' && pressed === 'red' && after === 'light', `${before} → ${pressed} → ${after}`);
  await page.screenshot({ path: path.join(out, '2-preview.png') });

  // ── export: pixels and sound ──
  await state(() => window.__cutaway.useApp.getState().select(null));
  const exp = async (label) => {
    const r = await state(async ({ dest, label }) => {
      const { useApp, exporter } = window.__cutaway;
      const st = useApp.getState();
      const session = await window.cutaway.export.begin(dest, label);
      try {
        await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
        const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
        return { ok: true, folder: done.folder };
      } catch (e) {
        await window.cutaway.export.abort(session.id, false);
        return { ok: false, error: e.message };
      }
    }, { dest: exportDir, label });
    if (!r.ok) throw new Error(r.error);
    return path.join(r.folder, 'video.mp4');
  };
  const file = await exp('motion');
  const at = (t, [x, y]) => { const b = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=4:4:iw*${x}:ih*${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return name([b[0], b[1], b[2]]); };
  const seen = [1.5, 2.9, 3.1, 4, 5].map((t) => `${t}s ${at(t, BTN)}`);
  check('the export shows the same: nothing at 1.5 s, the red button, then the grey one', /^1\.5s (?!red|light)/.test(seen[0]) && seen[1].endsWith('red') && seen[2].endsWith('red') && seen[3].endsWith('light') && seen[4].endsWith('light'), seen.join(', '));
  const SR = 8000;
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64e6 });
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const peak = (a, b) => { let p = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) p = Math.max(p, Math.abs(pcm[i])); return p; };
  check('its click and pop are heard at the click (3.3 s), and nothing before', peak(0.5, 3.2) < 0.01 && peak(3.25, 3.6) > 0.05, `before ${peak(0.5, 3.2).toFixed(3)} · at the click ${peak(3.25, 3.6).toFixed(3)}`);

  // ── a field ──
  await page.locator('.lane-fx .tl-item.motion').click();
  await page.fill('[data-testid="motion-field-done"]', 'Thanks!');
  await page.waitForTimeout(300);
  m = await motions();
  check('changing a field in the panel is saved', m[0].fields.done === 'Thanks!');
  await ready();
  check('and the frames are prepared again for the new words', true);

  // ── describe it, with a stand-in AI ──
  const broken = '<!doctype html><html><head></head><body><div style="width:200px;height:200px;background:blue"></div></body></html>';
  const good = (colour) => `<!doctype html><html><head><script type="application/json" id="cutaway-motion">{"name":"Blue dot","duration":2,"fields":[{"id":"tint","label":"Colour","type":"color","default":"${colour}"}],"sounds":[{"t":0.2,"sound":"whoosh"}]}</script><style>#d{position:absolute;left:10%;top:40%;width:10vh;height:10vh;border-radius:50%;background:var(--tint)}</style></head><body><div id="d"></div><script>document.getElementById('d').animate([{transform:'translateX(0)'},{transform:'translateX(60vw)'}],{duration:2000,fill:'both'});</script></body></html>`;
  await state(({ broken, good }) => {
    window.__cutawayFakeAi = { seen: [], replies: [{ html: broken, summary: 'x' }, { html: good, summary: 'A blue dot' }] };
    window.__cutaway.useApp.setState({ claude: { found: true, path: '/fake/ai', version: '0', signedIn: true, message: 'test provider', provider: 'claude' } });
  }, { broken, good: good('#1e1edc') });
  await state(() => window.__cutaway.useApp.getState().select(null));
  await seek(7);
  await page.click('[data-testid="fx-add"]');
  await page.click('[data-testid="add-motion"]');
  await page.locator('[data-testid="motion-sheet"] .seg button', { hasText: 'Describe it' }).click();
  await page.fill('[data-testid="motion-request"]', 'a blue dot that slides across');
  await state(() => (window.__cutawayFakeAiDelay = 400));
  await page.click('[data-testid="motion-generate"]');
  await page.waitForSelector('[data-testid="motion-steps"].live li[data-state="active"]', { timeout: 5000 });
  const liveText = await page.locator('[data-testid="motion-steps"].live').innerText();
  check('while it works, the sheet shows the step in progress live (the code being written, with how much so far)', /Writing the animation code/.test(liveText) && /(written so far|Waiting for the first lines)/.test(liveText), liveText.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: path.join(out, '3a-live.png') });
  await page.waitForFunction(() => window.__cutawayFakeAi.replies.length === 0 && !document.querySelector('[data-testid="motion-generate"] .spinner'), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const asked = await state(() => window.__cutawayFakeAi.seen.map((s) => ({ purpose: s.purpose, prompt: s.prompt })));
  await page.locator('[data-testid="motion-steps-done"] summary').click();
  const steps = await page.locator('[data-testid="motion-steps-done"] li').evaluateAll((els) => els.map((e) => `${e.dataset.step}:${e.dataset.state}:${e.querySelector('.grow > div.tiny')?.textContent ?? ''}`));
  check(
    'the sheet shows each step: the brief, the code written, the test finding the problem, the fix, the test passing',
    steps.length === 5 && /^brief:done/.test(steps[0]) && /^write-1:done:.*wrote/.test(steps[1]) && /^check-1:failed:Found a problem: .*cutaway-motion/.test(steps[2]) && /^write-2:done:.*“Blue dot”, 2\.0 s/.test(steps[3]) && /^check-2:done:It draws, moves/.test(steps[4]),
    steps.map((x) => x.slice(0, 90)).join(' | '),
  );
  await page.screenshot({ path: path.join(out, '3b-steps.png') });
  check('the request goes to the AI with the animation contract and the worked example', asked.length === 2 && asked[0].purpose === 'motion' && /ANIMATION CONTRACT/.test(asked[0].prompt) && /a blue dot that slides across/.test(asked[0].prompt) && /id="cutaway-motion"/.test(asked[0].prompt));
  check('a broken page is sent back with what was wrong, and fixed', /THESE PROBLEMS CAME UP/.test(asked[1]?.prompt ?? '') && /no <script type="application\/json" id="cutaway-motion">/.test(asked[1]?.prompt ?? ''));
  await page.screenshot({ path: path.join(out, '3-described.png') });
  await page.click('[data-testid="motion-add"]');
  await page.waitForTimeout(600);
  m = await motions();
  const dot = m.find((x) => x.name === 'Blue dot');
  check('the working animation is added at the playhead, marked as written by the AI', !!dot && dot.start === 7 && dot.end === 9 && dot.origin.kind === 'ai' && dot.origin.prompt === 'a blue dot that slides across', JSON.stringify(dot));

  // ── change it, then undo ──
  await state(({ good }) => (window.__cutawayFakeAi.replies = [{ html: good, summary: 'red dot' }]), { good: good('#dc1e1e') });
  await page.click('[data-testid="selbar-motion-revise"]');
  await page.waitForSelector('[data-testid="motion-sheet"]');
  await page.fill('[data-testid="motion-request"]', 'make it red');
  await page.click('[data-testid="motion-generate"]');
  await page.waitForFunction(() => window.__cutawayFakeAi.replies.length === 0, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const changeAsk = await state(() => window.__cutawayFakeAi.seen.at(-1).prompt);
  check('a change sends the current page and the change asked for', /THE CURRENT ANIMATION/.test(changeAsk) && /make it red/.test(changeAsk) && /#1e1edc/.test(changeAsk));
  await page.click('[data-testid="motion-add"]');
  await page.waitForTimeout(600);
  m = await motions();
  const red = m.find((x) => x.id === dot.id);
  check('"Use this version" replaces the animation with a new file, keeping its place', red.file !== dot.file && red.start === 7 && red.origin.prompt === 'make it red' && red.fields.tint === '#1e1edc', JSON.stringify(red));
  await state(() => window.__cutaway.useApp.getState().undo());
  m = await motions();
  check('undo brings the earlier version back', m.find((x) => x.id === dot.id)?.file === dot.file);
  const files = fs.readdirSync(path.join(await state(() => window.__cutaway.useApp.getState().projectPath), 'media', 'motion'));
  check('every version is kept in the project’s media/motion folder', files.length >= 3, files.join(', '));
} finally {
  await app.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all motion checks passed');
process.exit(failed ? 1 : 0);
