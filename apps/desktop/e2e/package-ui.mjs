// End-to-end pass over Package → Export → Settings against a seeded fixture project.
// Usage: node e2e/package-ui.mjs [screenshot-dir]
// Needs the app built (node scripts/build.mjs), the native helper built, and ffmpeg/ffprobe on PATH.
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, root } from './harness.mjs';

const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const shots = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-package-ui'));
fs.mkdirSync(shots, { recursive: true });
// Canonical path: os.tmpdir() goes through the /var → /private/var symlink.
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-pkg-e2e-')));
const libraryDir = path.join(profile, 'Library');
const projectDir = path.join(libraryDir, 'Fixture demo.cutaway');
const DURATION = 36;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── 1. fixture media ──
fs.mkdirSync(path.join(projectDir, 'media', 'imports'), { recursive: true });
fs.mkdirSync(path.join(projectDir, 'cache'), { recursive: true });
const screenFile = path.join(projectDir, 'media', 'imports', 'screen.mp4');
const cameraFile = path.join(projectDir, 'media', 'imports', 'camera.mp4');
const ff = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${DURATION}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', screenFile]);
ff(['-f', 'lavfi', '-i', `mandelbrot=size=1280x720:rate=30`, '-t', String(DURATION), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-an', cameraFile]);

// ── 2. project.json built with the real core model ──
const coreOut = path.join(profile, 'core.mjs');
await build({ stdin: { contents: "export * from '@cutaway/core';", resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: coreOut, logLevel: 'error' });
const core = await import(pathToFileURL(coreOut).href);
const probe = (rel, abs, audio) => ({ path: rel, ok: true, kind: 'video', duration: DURATION, sizeBytes: fs.statSync(abs).size, createdAt: null, video: { width: 1280, height: 720, fps: 30, variableFrameRate: false, codec: 'avc1' }, audio: audio ? { channels: 1, sampleRate: 44100, codec: 'aac ' } : null });
const screen = core.sourceFromProbe(probe('media/imports/screen.mp4', screenFile, true), 'screen', { managed: true, origin: 'import', name: 'screen.mp4' });
const camera = core.sourceFromProbe(probe('media/imports/camera.mp4', cameraFile, false), 'cameraA', { managed: true, origin: 'import', name: 'camera.mp4' });
let project = core.createProject('Fixture demo', [screen, camera]);
const script = [
  [1.0, 'So today we set up the export folder for the fixture demo.'],
  [8.0, 'First open the settings panel and choose where the export folder lives.'],
  [16.0, 'Then check the preflight list before you export the package.'],
  [25.0, 'Finally open the export folder and check every file in the package.'],
];
const words = [];
for (const [start, sentence] of script) {
  const parts = sentence.split(' ');
  parts.forEach((text, i) => words.push({ id: `w${words.length}`, text, start: start + i * 0.42, end: start + i * 0.42 + 0.36, kind: 'word' }));
}
project = {
  ...project,
  transcript: { engine: 'fixture', locale: 'en-US', onDevice: true, sourceId: screen.id, hasSpeech: true, words, generatedAt: new Date().toISOString() },
  packaging: { ...project.packaging, chapters: [{ sessionTime: 0, title: 'Intro' }, { sessionTime: 12, title: 'Settings' }, { sessionTime: 24, title: 'Export' }] },
  ui: { ...project.ui, view: 'package' },
};
fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify(project));

// a second project whose camera file has gone missing (SC-033)
const brokenDir = path.join(libraryDir, 'Missing media.cutaway');
fs.mkdirSync(path.join(brokenDir, 'media'), { recursive: true });
const broken = core.createProject('Missing media', [
  { ...screen, id: 'src_screen_abs', path: screenFile, managed: false },
  { ...camera, id: 'src_cam_gone', path: 'media/imports/gone.mp4' },
]);
fs.writeFileSync(path.join(brokenDir, 'project.json'), JSON.stringify({ ...broken, ui: { ...broken.ui, view: 'export' } }));

// ── 3. drive the UI ──
const { app, page, exportDir } = await launch({ profile });
const shot = async (name) => {
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('  shot', file);
};
try {
  await page.waitForSelector('.project-card', { timeout: 15000 });
  await page.locator('.project-card', { hasText: 'Fixture demo' }).click();
  await page.waitForSelector('.pkg-empty', { timeout: 15000 });
  await page.waitForTimeout(700);
  await shot('01-package-empty');

  await page.getByRole('button', { name: 'Create three concepts' }).click();
  await page.waitForSelector('.concept', { timeout: 90000 });
  await page.waitForTimeout(2500); // stills decode
  const conceptCount = await page.locator('.concept').count();
  check('three concepts are created', conceptCount === 3, `${conceptCount} concepts`);
  const origins = await page.locator('.concept .pill').allInnerTexts();
  check('template concepts are labelled as built from the creator\'s words', origins.some((t) => /your words/i.test(t)), origins.join(' | '));
  await shot('02-package-concepts');

  // select the text on the canvas and edit it
  const stage = page.locator('.thumb-stage');
  const box = await stage.boundingBox();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.52);
  await page.waitForSelector('.thumb-stage .sel:not(.full)', { timeout: 5000 });
  check('clicking the canvas selects the text layer', (await page.locator('.pkg-right textarea').count()) === 1);
  await page.locator('.pkg-right textarea').fill('Export in one click');
  await page.waitForTimeout(400);
  // drag it, then nudge with the keyboard
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.52);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.24, box.y + box.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await stage.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const edited = await page.locator('.concept').first().locator('.pill').allInnerTexts();
  check('a manual change marks the concept as edited by the creator', edited.some((t) => /edited by you/i.test(t)), edited.join(' | '));
  await shot('03-package-editing-text');

  // frame inspector via the layer list
  await page.locator('.layer-pick', { hasText: 'Frame' }).first().click();
  await page.waitForTimeout(300);
  await shot('04-package-frame-inspector');

  await page.locator('.concept').first().getByRole('button', { name: 'Choose this pair' }).click();
  const title = page.locator('.title-input');
  await title.fill('How to export a YouTube package from one folder');
  await page.waitForTimeout(300);
  const count = await page.locator('.pkg-center .card .label .value').first().innerText();
  check('title length is checked live', /\/ 100/.test(count), count.replace(/\s+/g, ' '));
  await page.locator('.pkg-center').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(600);
  const chapterPill = await page.locator('.pkg-text .pill').first().innerText();
  check('three ≥10s chapters validate for YouTube', /valid/i.test(chapterPill), chapterPill);
  await shot('05-package-title-preview-chapters');

  // undo goes through the shared store
  await page.locator('.pkg-center').evaluate((el) => el.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(300);
  const afterUndo = await title.inputValue();
  check('undo reverts the title edit', afterUndo !== 'How to export a YouTube package from one folder', afterUndo);
  await page.getByRole('button', { name: 'Redo' }).click();

  // ── export ──
  await page.locator('.titlebar .btn.primary').click();
  await page.waitForSelector('.export .checks', { timeout: 10000 });
  await page.waitForTimeout(800);
  await shot('06a-export-sheet');
  await page.locator('.ex-sheet .seg button', { hasText: 'YouTube package' }).click();
  await page.waitForTimeout(400);
  const pills = await page.locator('.export .ex-card .pill').allInnerTexts();
  await shot('06-export-preflight');
  console.log('  preflight:', pills.join(' | '));

  const go = page.getByRole('button', { name: /Export (YouTube|draft) package/ });
  if (await go.isDisabled()) {
    const t = page.getByRole('switch', { name: 'I understand this is a draft' });
    if (await t.count()) await t.click();
  }
  await go.click();
  await page.waitForTimeout(1500);
  await shot('07-export-running');
  await page.waitForFunction(() => /Package complete|Partial export|Export failed|Export stopped|Video exported|GIF exported|Copied to the clipboard|Exported, but not copied/.test(document.querySelector('.ex-progress > .ex-title, .ex-progress > .row > .ex-title')?.textContent ?? '') && !/^Exporting/.test(document.querySelector('.ex-progress .ex-title')?.textContent ?? ''), null, { timeout: 300000 });
  await page.waitForTimeout(500);
  const outcome = await page.locator('.ex-progress .ex-title').first().innerText();
  await shot('08-export-outcome');
  console.log('  outcome:', outcome);
  if (/complete/i.test(outcome)) {
    const folders = fs.readdirSync(exportDir).filter((n) => !n.startsWith('.'));
    const folder = path.join(exportDir, folders[0]);
    const files = fs.readdirSync(folder).map((n) => `${n} (${fs.statSync(path.join(folder, n)).size})`);
    console.log('  package:', folder, '\n   ', files.join('\n    '));
    const need = ['video.mp4', 'thumbnail.jpg', 'thumbnail-master.jpg', 'title.txt', 'title-options.txt', 'chapters.txt', 'captions.srt', 'package.json'];
    const missing = need.filter((n) => !fs.existsSync(path.join(folder, n)) || fs.statSync(path.join(folder, n)).size === 0);
    check('the package folder holds every applicable file', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : folders[0]);
    const thumbBytes = fs.statSync(path.join(folder, 'thumbnail.jpg')).size;
    check('thumbnail.jpg is under 2 MB', thumbBytes < 2 * 1024 * 1024, `${thumbBytes} bytes`);
    const dims = (f) => execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'csv=p=0', path.join(folder, f)]).toString().trim();
    check('thumbnail sizes', dims('thumbnail.jpg').includes('1920,1080') && dims('thumbnail-master.jpg').includes('3840,2160'), `${dims('thumbnail.jpg')} / ${dims('thumbnail-master.jpg')}`);
    console.log('  video:', dims('video.mp4'), execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(folder, 'video.mp4')]).toString().trim(), 's');
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    check('package.json records the revision and that nothing was uploaded', manifest.uploadedToYouTube === false && typeof manifest.editRevision === 'number' && manifest.validation.ok === true, `revision ${manifest.editRevision}`);
    check('title.txt matches the chosen title', fs.readFileSync(path.join(folder, 'title.txt'), 'utf8').trim() === 'How to export a YouTube package from one folder');
    check('chapters.txt starts at 00:00', fs.readFileSync(path.join(folder, 'chapters.txt'), 'utf8').startsWith('00:00 Intro'));
    check('captions.srt has cues', /^1\n00:00:0\d,\d{3} --> /.test(fs.readFileSync(path.join(folder, 'captions.srt'), 'utf8')));

    // a second export must not overwrite the first
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForTimeout(600);
    const name2 = await page.locator('.ex-dest .dest-name').innerText();
    check('the next export gets a new folder name', name2 !== folders[0], name2);
    await page.getByRole('button', { name: /Export (YouTube|draft) package/ }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Stop export' }).click();
    await page.waitForFunction(() => /Package complete|Partial export|Export failed|Export stopped|Video exported|GIF exported|Copied to the clipboard|Exported, but not copied/.test(document.querySelector('.ex-progress > .ex-title, .ex-progress > .row > .ex-title')?.textContent ?? '') && !/^Exporting/.test(document.querySelector('.ex-progress .ex-title')?.textContent ?? ''), null, { timeout: 120000 });
    const outcome2 = await page.locator('.ex-progress .ex-title').first().innerText();
    await page.waitForTimeout(400);
    await shot('09-export-cancelled');
    const after = fs.readdirSync(exportDir);
    check('cancelling leaves no half-written folder and keeps the first package', /stopped/i.test(outcome2) && after.filter((n) => !n.startsWith('.')).length === 1 && after.filter((n) => n.includes('.working-')).length === 0, `${outcome2} · ${after.join(', ')}`);
  } else {
    const msg = await page.locator('.ex-progress .banner').first().innerText();
    console.log('  failure message:', msg.replace(/\s+/g, ' '));
    const after = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
    check('a failed export leaves no folder with the final name', !after.some((n) => /-youtube(-rev\d+)?$/.test(n)), after.join(', ') || 'export dir empty');
  }

  // ── single-file exports: MP4 at 720p (shape kept), ProRes, GIF, clipboard ──
  const outcomeOf = async () => (await page.locator('.ex-progress .ex-title').first().innerText()).replace(/\s+/g, ' ').trim();
  const waitDone = () => page.waitForFunction(() => /Package complete|Partial export|Export failed|Export stopped|Video exported|GIF exported|Copied to the clipboard|Exported, but not copied/.test(document.querySelector('.ex-progress > .ex-title, .ex-progress > .row > .ex-title')?.textContent ?? '') && !/^Exporting/.test(document.querySelector('.ex-progress .ex-title')?.textContent ?? ''), null, { timeout: 300000 });
  const back = async () => { const b = page.getByRole('button', { name: /^(Back|Done)$/ }); if (await b.count()) await b.first().click(); await page.waitForSelector('.ex-foot', { timeout: 10000 }); };
  const probeV = (f) => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames', '-of', 'csv=p=0', f]).toString().trim().replace(/\n/g, ' | ');
  const tagsOf = (f) => execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_range,color_space,color_transfer,color_primaries', '-of', 'default=nw=1:nk=0', f]).toString().trim().replace(/\n/g, ' ');
  const durationOf = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
  // The native save dialog cannot be driven, so it is replaced in the main process by one that answers with `answer`.
  const answerSaveDialog = (answer) => app.evaluate(({ dialog }, a) => { dialog.showSaveDialog = async () => (a ? { canceled: false, filePath: a } : { canceled: true, filePath: '' }); }, answer);
  /** Y, Cb, Cr of one background pixel of a frame, straight from the decoder (no colour conversion by ffmpeg). */
  const yuvAt = (f, t) => { const b = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'crop=8:8:8:8,scale=1:1:flags=area,format=yuv444p', '-f', 'rawvideo', '-']); return [b[0], b[1], b[2]]; };
  const toRgb = ([y, cb, cr], m) => { const k = m === 709 ? [1.5748, 0.1873, 0.4681, 1.8556] : [1.402, 0.3441, 0.7141, 1.772]; const Y = (y - 16) / 219, B = (cb - 128) / 224, R = (cr - 128) / 224; return [Y + k[0] * R, Y - k[1] * B - k[2] * R, Y + k[3] * B].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)); };
  const far = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  /** Strongest frequency between 150 and 900 Hz in [from, to) seconds of a file's sound. */
  const toneOf = (f, from, to) => { const pcm = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', f, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 64 * 1024 * 1024 }); const x = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4)); let best = 0, bestP = -1; for (let hz = 150; hz <= 900; hz += 2) { const c = 2 * Math.cos((2 * Math.PI * hz) / 8000); let s1 = 0, s2 = 0; for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; } const pw = s1 * s1 + s2 * s2 - c * s1 * s2; if (pw > bestP) { bestP = pw; best = hz; } } return best; };

  // A known flat background colour and a 2× section, so colour and pitch can be measured in the exported files.
  const BG = [200, 40, 60];
  const backgroundBefore = await page.evaluate(() => {
    const c = window.__cutaway;
    const was = c.useApp.getState().project.edit.appearance.background;
    c.useApp.getState().edit((e, p) => ({ ...c.core.applyOps(e, [{ op: 'speed', start: 10, end: 20, speed: 2 }], 'creator', p.revision + 1), appearance: { ...e.appearance, background: { type: 'solid', color: '#c8283c' } } }), 'Test: speed and background');
    return was;
  });
  const outSeconds = await page.evaluate(() => { const c = window.__cutaway; return c.timeMapOf(c.useApp.getState().project).outDuration; });
  check('a 2× section over 10 s shortens the edit by 5 s', Math.abs(outSeconds - (DURATION - 5)) < 0.05, `${outSeconds.toFixed(2)} s`);

  await back();
  await page.locator('.ex-sheet .seg button', { hasText: /^File$/ }).click();
  await page.locator('.ex-sheet .seg button', { hasText: '720p' }).click();
  await page.waitForTimeout(400);
  const hint720 = await page.locator('.ex-row', { hasText: 'Resolution' }).locator('.ex-hint').innerText();
  check('720p keeps the project shape', /1280 × 720/.test(hint720), hint720);

  // cancelling the save dialog starts nothing
  await answerSaveDialog(null);
  await page.getByRole('button', { name: /Export to file/ }).click();
  await page.waitForTimeout(800);
  check('cancelling the save dialog starts no export', (await page.locator('.ex-foot').count()) === 1 && (await page.locator('.ex-progress').count()) === 0);

  const chosenDir = path.join(profile, 'Chosen place');
  const mp4 = path.join(chosenDir, 'my export.mp4');
  await answerSaveDialog(mp4);
  await page.getByRole('button', { name: /Export to file/ }).click();
  await waitDone();
  const o3 = await outcomeOf();
  await page.waitForTimeout(300);
  await shot('09b-export-file-done');
  const mp4Info = fs.existsSync(mp4) ? probeV(mp4) : 'missing';
  const chosenListing = fs.existsSync(chosenDir) ? fs.readdirSync(chosenDir) : [];
  check('MP4 export writes one bare H.264 + AAC file exactly where it was saved', /Video exported/.test(o3) && /h264,1280,720/.test(mp4Info) && /aac/.test(mp4Info) && chosenListing.length === 1 && chosenListing[0] === 'my export.mp4', `${o3} · ${mp4Info} · ${chosenListing.join(', ')}`);
  if (fs.existsSync(mp4)) {
    const tags = tagsOf(mp4);
    check('the MP4 says BT.709 in the H.264 stream (primaries, transfer, matrix), limited range', /color_space=bt709/.test(tags) && /color_transfer=bt709/.test(tags) && /color_primaries=bt709/.test(tags) && /color_range=tv/.test(tags), tags);
    const trace = spawnSync(FFPROBE, ['-v', 'trace', mp4], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stderr ?? '';
    const nclx = (trace.match(/nclx: pri (\d+) trc (\d+) matrix (\d+) full (\d+)/) ?? []).slice(1).join('/');
    check('the MP4 container carries a matching colr box', nclx === '1/1/1/0', `nclx ${nclx || 'not found'}`);
    const px = yuvAt(mp4, 2);
    const as709 = toRgb(px, 709), as601 = toRgb(px, 601);
    check('the background colour decodes correctly with the BT.709 matrix (and wrongly with BT.601)', far(as709, BG) <= 4 && far(as601, BG) >= 8, `YCbCr ${px.join(',')} → 709 rgb(${as709.join(',')}) vs wanted rgb(${BG.join(',')}); as 601 rgb(${as601.join(',')})`);
    const d = durationOf(mp4);
    const normal = toneOf(mp4, 2, 8), fast = toneOf(mp4, 11, 14);
    check('the 2× section keeps the 330 Hz tone at 330 Hz (pitch preserved)', Math.abs(d - (DURATION - 5)) < 0.2 && Math.abs(normal - 330) <= 4 && Math.abs(fast - 330) <= 6, `duration ${d.toFixed(2)} s · normal ${normal} Hz · sped-up ${fast} Hz (plain resampling would give 660 Hz)`);
  }

  // exporting again to the same path: the creator agreed to replace it in the save dialog
  await back();
  const before = fs.existsSync(mp4) ? fs.statSync(mp4).mtimeMs : 0;
  await page.getByRole('button', { name: /Export to file/ }).click();
  await waitDone();
  const o3b = await outcomeOf();
  const listing2 = fs.readdirSync(chosenDir);
  check('saving over a file chosen in the dialog replaces just that file', /Video exported/.test(o3b) && listing2.length === 1 && fs.statSync(mp4).mtimeMs > before, `${o3b} · ${listing2.join(', ')}`);

  // ProRes 422
  await back();
  await page.locator('.ex-sheet .seg button', { hasText: 'ProRes' }).click();
  await page.waitForTimeout(300);
  await shot('09b2-export-prores-sheet');
  const mov = path.join(chosenDir, 'my export.mov');
  await answerSaveDialog(mov);
  await page.getByRole('button', { name: /Export to file/ }).click();
  await waitDone();
  const oMov = await outcomeOf();
  await shot('09b3-export-prores-done');
  if (fs.existsSync(mov)) {
    const info = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,nb_frames,sample_rate,channels', '-of', 'csv=p=0', mov]).toString().trim().replace(/\n/g, ' | ');
    const tags = tagsOf(mov);
    check('ProRes export writes a ProRes 422 MOV with PCM sound', /Video exported/.test(oMov) && /^prores,Standard,1280,720,930/.test(info) && /pcm_s16le,unknown,48000,2/.test(info), `${oMov} · ${info} · ${(fs.statSync(mov).size / 1e6).toFixed(0)} MB`);
    check('the ProRes file is 10-bit 4:2:2 tagged BT.709', /pix_fmt=yuv422p10le/.test(tags) && /color_space=bt709/.test(tags) && /color_transfer=bt709/.test(tags) && /color_primaries=bt709/.test(tags), tags);
    const px = yuvAt(mov, 2);
    check('the ProRes background colour matches the edit', far(toRgb(px, 709), BG) <= 4, `YCbCr ${px.join(',')} → rgb(${toRgb(px, 709).join(',')}) vs wanted rgb(${BG.join(',')})`);
    const fast = toneOf(mov, 11, 14);
    check('the ProRes sound is in step and at pitch', Math.abs(durationOf(mov) - (DURATION - 5)) < 0.2 && Math.abs(fast - 330) <= 6, `${durationOf(mov).toFixed(2)} s · sped-up section ${fast} Hz`);
  } else check('ProRes export writes a ProRes 422 MOV with PCM sound', false, `${oMov} · file missing`);
  check('no working folders are left beside the exported files', fs.readdirSync(chosenDir).every((n) => !n.startsWith('.')), fs.readdirSync(chosenDir).join(', '));

  await back();
  await page.locator('.ex-sheet .seg button', { hasText: /^GIF$/ }).click();
  await page.waitForTimeout(300);
  await shot('09c-export-gif-sheet');
  const gif = path.join(chosenDir, 'my export.gif');
  await answerSaveDialog(gif);
  await page.getByRole('button', { name: /Export to file/ }).click();
  await waitDone();
  const o4 = await outcomeOf();
  await shot('09d-export-gif-done');
  const gifKind = fs.existsSync(gif) ? execFileSync('/usr/bin/file', ['-b', gif]).toString().trim() : 'missing';
  const gifInfo = fs.existsSync(gif) ? probeV(gif) : '';
  check('GIF export writes one animated GIF', /GIF exported/.test(o4) && /^GIF image data/.test(gifKind) && fs.readdirSync(chosenDir).filter((n) => /gif/i.test(n)).length === 1, `${o4} · ${gifKind} · ${gifInfo} · ${fs.existsSync(gif) ? fs.statSync(gif).size : 0} bytes`);

  await back();
  await page.locator('.ex-sheet .seg button', { hasText: /^MP4$/ }).click();
  await page.locator('.ex-sheet .seg button', { hasText: /^Clipboard$/ }).click();
  await answerSaveDialog(null); // the clipboard copy must not ask where to save
  await page.getByRole('button', { name: /Export to clipboard/ }).click();
  await waitDone();
  const o5 = await outcomeOf();
  await shot('09e-export-clipboard-done');
  const clipInfo = execFileSync('/usr/bin/osascript', ['-e', 'clipboard info']).toString().trim();
  let clipPath = '';
  try { clipPath = execFileSync('/usr/bin/osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).toString().trim(); } catch (e) { clipPath = `unreadable: ${e.message.split('\n')[0]}`; }
  check('Export to clipboard puts a bare file from the export folder on the clipboard', /Copied to the clipboard/.test(o5) && /furl/.test(clipInfo) && /Exports\/fixture-demo\.mp4$/.test(clipPath) && fs.existsSync(path.join(exportDir, 'fixture-demo.mp4')), `${o5} · ${clipPath} · ${clipInfo.slice(0, 80)}`);
  await back();
  await page.locator('.ex-sheet .seg button', { hasText: '1080p' }).click();
  // put the edit back as it was, so the later steps see the original timing
  await page.evaluate((bg) => window.__cutaway.useApp.getState().edit((e) => ({ ...e, speeds: [], appearance: { ...e.appearance, background: bg } }), 'Test: restore'), backgroundBefore);

  // ── the preview's voice cleanup: the exporter's own chain, loaded as an audio worklet ──
  const workletFile = fs.readdirSync(path.join(root, 'dist', 'renderer', 'assets')).find((n) => /^voiceWorklet-.*\.js$/.test(n));
  const worklet = await page.evaluate(async (file) => {
    try {
      const main = [...document.querySelectorAll('script[src]')].map((x) => x.src).find((x) => /assets\/index-/.test(x));
      const url = new URL(file, main).href;
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'cutaway-voice-cleaner', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      node.port.postMessage({ on: true, makeup: 1, expander: false });
      const osc = new OscillatorNode(ctx, { frequency: 300 });
      const loud = new GainNode(ctx, { gain: 3 }); // far over full scale: the limiter has to hold it
      osc.connect(loud).connect(node).connect(ctx.destination);
      osc.start();
      const buf = await ctx.startRendering();
      const x = buf.getChannelData(0);
      let peak = 0, sum = 0;
      for (let i = 4800; i < x.length; i++) { peak = Math.max(peak, Math.abs(x[i])); sum += x[i] * x[i]; }
      return { ok: true, peak, rms: Math.sqrt(sum / (x.length - 4800)) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, workletFile ?? 'missing.js');
  check('the preview loads the voice cleanup worklet and it limits like the export does', worklet.ok && worklet.peak <= 0.8913 + 1e-4 && worklet.rms > 0.4, worklet.ok ? `${workletFile} · peak ${worklet.peak.toFixed(4)} (ceiling 0.8913) · rms ${worklet.rms.toFixed(3)}` : worklet.error);

  // ── share bundle (the UI button opens a native folder dialog, so the same IPC is called directly) ──
  const shareDir = path.join(profile, 'Shared');
  const bundle = await page.evaluate(async (dir) => { const st = window.__cutaway.useApp.getState(); await window.__cutaway.saveNow(); return window.cutaway.library.exportBundle(st.projectPath, dir); }, shareDir).catch((e) => ({ error: e.message }));
  let listing = '';
  if (bundle.path) listing = execFileSync('/usr/bin/unzip', ['-l', bundle.path]).toString();
  check('Share project writes a zip holding project.json and the media', !!bundle.path && /Fixture demo\.cutaway\/project\.json/.test(listing) && /media\/imports\/screen\.mp4/.test(listing) && !/\/cache\/./.test(listing), bundle.error ?? `${path.basename(bundle.path)} · ${bundle.bytes} bytes`);

  // ── voiceover (synthetic system voice, on-device) ──
  const voDir = path.join(projectDir, 'media', 'voiceover');
  const voFiles = () => (fs.existsSync(voDir) ? fs.readdirSync(voDir).filter((n) => n.endsWith('.wav')) : []);
  await page.getByRole('button', { name: 'Voiceover…' }).click();
  await page.waitForSelector('.vo', { timeout: 10000 });
  const gotVoices = await page.waitForSelector('.vo-voices button', { timeout: 20000 }).then(() => true).catch(() => false);
  if (gotVoices) {
    // a take that is only auditioned and then abandoned leaves no file behind
    await page.locator('.vo-script').fill('An audition that is thrown away.');
    await page.getByRole('button', { name: 'Generate and play' }).click();
    await page.getByRole('button', { name: 'Play again' }).waitFor({ timeout: 60000 });
    const auditioned = voFiles().length;
    await page.locator('.vo').evaluate(() => document.querySelector('.vo-audio')?.pause());
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForSelector('.vo', { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    check('an auditioned take that is not added is deleted when the sheet closes', auditioned === 1 && voFiles().length === 0, `${auditioned} file while open, ${voFiles().length} after closing`);

    await page.getByRole('button', { name: 'Voiceover…' }).click();
    await page.waitForSelector('.vo-voices button', { timeout: 20000 });
    await page.locator('.vo-script').fill('This is a short narration for the fixture demo.');
    await page.waitForTimeout(300);
    await shot('09f-voiceover');
    await page.getByRole('button', { name: 'Add to project' }).click();
    await page.waitForSelector('.vo', { state: 'detached', timeout: 60000 }).catch(() => {});
    const readVo = () => page.evaluate(() => { const p = window.__cutaway.useApp.getState().project; const s = p.sources.find((x) => x.name.startsWith('Voiceover')); return s ? { role: s.role, path: s.path, duration: s.duration, music: p.edit.audio.music?.sourceId === s.id, master: p.edit.audio.masterVoiceId === s.id } : null; });
    const vo = await readVo();
    const voFile = vo ? path.join(projectDir, vo.path) : '';
    check('voiceover is synthesised on this Mac and added as a supporting track', !!vo && vo.role === 'music' && vo.music && !vo.master && vo.duration > 1 && fs.existsSync(voFile), vo ? `${vo.path} · ${vo.duration.toFixed(2)}s · ${fs.existsSync(voFile) ? fs.statSync(voFile).size : 0} bytes` : 'no voiceover source');

    // delete the take: gone from the project, and its audio file is removed
    await page.getByRole('button', { name: 'Voiceover…' }).click();
    await page.waitForSelector('[data-testid="vo-take"]', { timeout: 10000 });
    await shot('09g-voiceover-takes');
    const del = page.locator('[data-testid="vo-take"]').getByRole('button');
    await del.click();
    const asks = await del.innerText();
    await del.click();
    await page.waitForSelector('[data-testid="vo-take"]', { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => { const p = window.__cutaway.useApp.getState().project; return { sources: p.sources.filter((x) => x.path.startsWith('media/voiceover/')).length, music: p.edit.audio.music }; });
    check('deleting a voiceover take asks first, then removes it from the project and deletes the WAV', /Delete the file\?/.test(asks) && after.sources === 0 && after.music === null && !fs.existsSync(voFile) && voFiles().length === 0, `asked “${asks}” · ${after.sources} voiceover source(s) · music ${JSON.stringify(after.music)} · ${voFiles().length} wav file(s)`);
    const refused = await page.evaluate(async () => { const st = window.__cutaway.useApp.getState(); try { await window.cutaway.native.removeVoiceover(st.projectPath, 'media/imports/screen.mp4'); return 'deleted'; } catch (e) { return e.message; } });
    check('only voiceover takes can be deleted through that call', /Only voiceover takes/.test(refused) && fs.existsSync(screenFile), refused);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForSelector('.vo', { state: 'detached', timeout: 10000 });
  } else {
    const why = await page.locator('.vo .banner').innerText().catch(() => 'no voices listed');
    check('voiceover: system voices are listed', false, why.replace(/\s+/g, ' ').slice(0, 160));
    await page.keyboard.press('Escape');
  }
  await page.locator('.page.export').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(400);
  await shot('10-export-history');

  // ── settings ──
  await page.evaluate(() => window.__cutaway.useApp.getState().go('settings'));
  await page.waitForSelector('.settings', { timeout: 10000 });
  await page.waitForTimeout(600);
  await shot('11-settings-storage');
  await page.locator('.set-nav button', { hasText: 'Processing' }).click();
  await page.waitForTimeout(1500);
  await shot('12-settings-processing');
  await page.locator('.set-nav button', { hasText: 'Presets' }).click();
  await page.getByRole('textbox', { name: 'Preset name' }).fill('Channel look');
  await page.getByRole('button', { name: 'Save preset' }).click();
  await page.waitForSelector('.presets li', { timeout: 5000 });
  await page.locator('.presets').getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(500);
  await shot('13-settings-presets');
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'userData', 'settings.json'), 'utf8'));
  check('the preset is persisted to settings.json', saved.presets?.length === 1 && saved.presets[0].name === 'Channel look');
  await page.locator('.set-nav button', { hasText: 'Shortcuts' }).click();
  await page.waitForTimeout(300);
  await shot('14-settings-shortcuts');
  await page.locator('.set-nav button', { hasText: 'Accessibility' }).click();
  await page.waitForTimeout(300);
  await shot('15-settings-accessibility');

  // the project file on disk has the packaging and the export record
  await page.waitForTimeout(1500);
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  check('project.json keeps the chosen concept and export history', !!onDisk.packaging.selectedId && onDisk.packaging.concepts.length === 3 && onDisk.exports.length >= 1, `${onDisk.exports.length} export record(s): ${onDisk.exports.map((e) => e.status).join(', ')}`);
} catch (e) {
  console.log('E2E ERROR', e.message);
  await shot('99-error').catch(() => {});
  results.push({ name: 'script completed', ok: false, detail: e.message });
} finally {
  await app.close().catch(() => {});
}

// ── 4. failure paths, in a second launch whose export folder cannot be created ──
const ro = path.join(profile, 'read-only');
fs.mkdirSync(ro, { recursive: true });
fs.chmodSync(ro, 0o555);
const second = await launch({ profile, settings: { exportDir: path.join(ro, 'Exports') } });
const page2 = second.page;
const shot2 = async (name) => {
  const file = path.join(shots, `${name}.png`);
  await page2.screenshot({ path: file });
  console.log('  shot', file);
};
try {
  await page2.waitForSelector('.project-card', { timeout: 15000 });
  await page2.locator('.project-card', { hasText: 'Missing media' }).click();
  await page2.waitForSelector('.export .checks', { timeout: 10000 });
  await page2.waitForTimeout(700);
  const blockedBtn = page2.locator('.ex-foot .btn.primary');
  const relink = await page2.getByRole('button', { name: 'Relink in Sources' }).count();
  check('missing media blocks export and offers relink', (await blockedBtn.isDisabled()) && relink >= 1, `${relink} relink action(s)`);
  await shot2('16-export-blocked-missing-media');

  await page2.getByRole('button', { name: 'Show previous projects' }).click();
  await page2.waitForSelector('.project-card', { timeout: 10000 });
  await page2.locator('.project-card', { hasText: 'Fixture demo' }).click();
  await page2.waitForSelector('.steps', { timeout: 10000 });
  await page2.locator('.titlebar .btn.primary').click();
  await page2.waitForSelector('.export .checks', { timeout: 10000 });
  await page2.waitForTimeout(500);
  await page2.locator('.ex-sheet .seg button', { hasText: 'YouTube package' }).click();
  const go2 = page2.getByRole('button', { name: /Export (YouTube|draft) package/ });
  // the edit changed after the thumbnail was chosen (the speed test above), so this is a draft
  if (await go2.isDisabled()) {
    const t = page2.getByRole('switch', { name: 'I understand this is a draft' });
    if (await t.count()) await t.click();
  }
  await go2.click();
  await page2.waitForFunction(() => /Package complete|Partial export|Export failed|Export stopped|Video exported|GIF exported|Copied to the clipboard|Exported, but not copied/.test(document.querySelector('.ex-progress > .ex-title, .ex-progress > .row > .ex-title')?.textContent ?? '') && !/^Exporting/.test(document.querySelector('.ex-progress .ex-title')?.textContent ?? ''), null, { timeout: 60000 });
  const failedOutcome = await page2.locator('.ex-progress .ex-title').first().innerText();
  const msg = (await page2.locator('.ex-progress .banner').first().innerText()).replace(/\s+/g, ' ');
  await page2.waitForTimeout(400);
  await shot2('17-export-failed');
  check('an unwritable destination produces the failed state, not a package', /failed/i.test(failedOutcome) && (await page2.getByRole('button', { name: 'Export again' }).count()) === 1, `${failedOutcome} · ${msg.slice(0, 120)}`);
  await page2.waitForTimeout(1500);
  const disk = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  check('the failed attempt is recorded in export history', disk.exports.some((e) => e.status === 'failed'), disk.exports.map((e) => `${e.status}${e.failedStage ? `@${e.failedStage}` : ''}`).join(', '));
} catch (e) {
  console.log('E2E ERROR (failure paths)', e.message);
  await shot2('98-error').catch(() => {});
  results.push({ name: 'failure-path script completed', ok: false, detail: e.message });
} finally {
  await second.app.close().catch(() => {});
  fs.chmodSync(ro, 0o755);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`);
process.exit(failed.length ? 1 : 0);
