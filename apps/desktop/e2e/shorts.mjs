// Shorts from a long video, through the real app and exporter.
// Candidates come from the built-in rules and from a canned provider reply (no model is called);
// everything about the result is measured from the exported files.
// Uses only footage generated here with ffmpeg: flat colour bands, so framing and captions are unmistakable.
// Usage: node e2e/shorts.mjs [outDir]
import { launch } from './harness.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FF = '/opt/homebrew/bin/ffmpeg';
const FP = '/opt/homebrew/bin/ffprobe';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-shorts'));
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const ff = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 256e6 });

// ── generated media ──
// screen: left half teal, right half orange. camera: red | green | blue bands, with a quiet tone as its sound.
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-shorts-media-'));
const DURATION = 36;
const file = (n) => path.join(media, n);
const TEAL = [16, 128, 128], ORANGE = [208, 112, 16], RED = [208, 32, 32], BLUE = [32, 64, 208];
ff(['-f', 'lavfi', '-i', `color=c=0x108080:s=1920x1080:r=30:d=${DURATION}`, '-vf', 'drawbox=x=960:y=0:w=960:h=1080:color=0xd07010:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-an', file('screen.mp4')]);
ff(['-f', 'lavfi', '-i', `color=c=0xd02020:s=1280x720:r=30:d=${DURATION}`, '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${DURATION}`, '-vf', 'drawbox=x=427:y=0:w=426:h=720:color=0x20a040:t=fill,drawbox=x=853:y=0:w=427:h=720:color=0x2040d0:t=fill', '-af', 'volume=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', file('camera-a.mov')]);

// A made-up talk: twelve sentences of six short words, one every three seconds.
const SENTENCES = [
  'This is a quick look today.',
  'Why does each one look soft?',
  'The fix is in two spots.',
  'Pick the high bit rate first.',
  'Then set the frame rate low.',
  'This one line gets cut out.',
  'Now the text stays sharp too.',
  'You can see it right here.',
  'That is all it takes now.',
  'Keep this file for next time.',
  'It will save you an hour.',
  'Thanks for the time and bye.',
];
const WORDS = SENTENCES.flatMap((s, k) => s.split(' ').map((text, i) => ({ id: `w${k}_${i}`, text, start: k * 3 + 0.2 + i * 0.4, end: k * 3 + 0.2 + i * 0.4 + 0.32, kind: 'word' })));
const CUT = { start: 15.05, end: 18.05 }; // removes sentence 5 from the long video

const near = (a, b, tol = 46) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
function probe(f) {
  const j = JSON.parse(execFileSync(FP, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).toString());
  const v = j.streams.find((s) => s.codec_type === 'video');
  return { width: v.width, height: v.height, codec: v.codec_name, duration: Number(j.format.duration), audio: j.streams.some((s) => s.codec_type === 'audio') };
}
function frame(f, t, w, h) {
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 });
  return { w, h, px: (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; } };
}
/** Bounding box and count of the pixels a test accepts, sampled every 3 px. */
function find(fr, test) {
  let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < fr.h; y += 3) for (let x = 0; x < fr.w; x += 3) if (test(fr.px(x, y))) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { n, x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
const isYellow = ([r, g, b]) => r > 215 && g > 185 && b < 140 && r - b > 90;
const isWhite = ([r, g, b]) => r > 232 && g > 232 && b > 232;

const { app, page, exportDir } = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
let exitCode = 1;
try {
  await state((files) => window.__cutaway.actions.importIntoNewProject(files), [file('screen.mp4'), file('camera-a.mov')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 20000 });
  const setup = await state(({ words, cut }) => {
    const { useApp, core } = window.__cutaway;
    const st = useApp.getState();
    st.patch((p) => {
      const sources = p.sources.map((s) => (s.name.startsWith('screen') ? { ...s, role: 'screen' } : s.name.startsWith('camera') ? { ...s, role: 'cameraA' } : s));
      const cam = sources.find((s) => s.role === 'cameraA');
      return { ...p, sources, transcript: { engine: 'test', locale: 'en-US', onDevice: true, sourceId: cam.id, hasSpeech: true, words, generatedAt: new Date().toISOString() } };
    });
    st.edit((e) => core.manualCut({ ...e, appearance: { ...e.appearance, background: { type: 'solid', color: '#600060' } } }, cut, useApp.getState().project.revision), 'cut one sentence');
    st.go('project');
    const p = useApp.getState().project;
    const cam = p.sources.find((s) => s.role === 'cameraA');
    return { duration: p.duration, roles: p.sources.map((s) => [s.name, s.role, +s.duration.toFixed(1), s.width, s.height]), camPath: cam.path.startsWith('/') ? cam.path : `${useApp.getState().projectPath}/${cam.path}`, projectPath: useApp.getState().projectPath, longOut: core.TimeMap.fromEdit(p.duration, p.edit).outDuration };
  }, { words: WORDS, cut: CUT });
  console.log('project', JSON.stringify(setup));
  check('a screen, a camera and a transcript are in the project, with one sentence cut', setup.roles.some((r) => r[1] === 'screen') && setup.roles.some((r) => r[1] === 'cameraA') && Math.abs(setup.longOut - (setup.duration - 3)) < 0.05, `long video ${setup.longOut.toFixed(2)} s of ${setup.duration.toFixed(2)} s`);

  // A known face track for the camera (there is no person in generated footage): on the red band, then on the blue one.
  const hash = crypto.createHash('sha1').update(setup.camPath).digest('hex').slice(0, 12);
  fs.mkdirSync(path.join(setup.projectPath, 'cache', 'faces'), { recursive: true });
  const FACE_MOVES_AT = 16;
  fs.writeFileSync(path.join(setup.projectPath, 'cache', 'faces', `${hash}.json`), JSON.stringify({ fps: 5, samples: Array.from({ length: DURATION * 5 }, (_, i) => ({ t: i / 5, x: i / 5 < FACE_MOVES_AT ? 0.1 : 0.76, y: 0.25, w: 0.14, h: 0.3 })) }));

  const editBefore = await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit));
  const revisionBefore = await state(() => window.__cutaway.useApp.getState().project.revision);

  // ───────────────────────── A. the Shorts screen, and candidates by the built-in rules ─────────────────────────
  await state(() => window.__cutaway.useApp.getState().setView('shorts'));
  await page.waitForSelector('[data-testid="shorts-screen"]', { timeout: 10000 });
  await shot('01-empty');
  check('the Shorts screen starts empty and offers to find shorts', (await page.locator('[data-testid="shorts-find"]').count()) === 1 && (await page.locator('[data-testid="short-saved"]').count()) === 0);
  await page.click('[data-testid="shorts-find"]');
  await page.waitForSelector('[data-testid="short-candidate"]', { timeout: 20000 });
  const rules = await state(() => {
    const { shorts, useApp } = window.__cutaway;
    const ui = shorts.useShorts.getState();
    return { note: ui.note, found: ui.found.map((c) => ({ title: c.title, start: c.start, end: c.end, duration: c.duration, origin: c.origin, hook: c.hook, reason: c.reason })), saved: (useApp.getState().project.shorts ?? []).length };
  });
  console.log('rules', JSON.stringify(rules));
  check('with no provider signed in, the built-in rules propose a short and say so', rules.found.length >= 1 && rules.found.every((c) => c.origin === 'rules') && /built-in rules/.test(rules.note ?? ''), rules.note);
  check('a proposal runs 15 to 90 seconds and opens on a whole sentence', rules.found.every((c) => c.duration >= 15 && c.duration <= 90 && SENTENCES.includes(c.hook)), rules.found.map((c) => `${c.duration.toFixed(1)} s "${c.hook}"`).join(' | '));
  check('the rules prefer the sentence that asks a question', rules.found[0].hook === SENTENCES[1] && /question/.test(rules.found[0].reason), rules.found[0].reason);
  check('nothing is added to the project until a proposal is kept', rules.saved === 0);
  await page.waitForSelector('[data-testid="short-preview"] canvas', { timeout: 10000 });
  await shot('02-rules-candidate');
  await state(() => { const { shorts } = window.__cutaway; for (const c of shorts.useShorts.getState().found) shorts.dismissCandidate(c.key); });

  // ───────────────────────── B. candidates from a provider reply (canned) ─────────────────────────
  await state(() => {
    window.__cutawayFakeAi = {
      seen: [],
      replies: [{ shorts: [
        { title: 'Why exports look soft', start: 3.5, end: 26.6, hook: 'not what was said', reason: 'One question, answered in the same stretch.' },
        { title: 'Outside the video', start: 90, end: 120, hook: '', reason: '' },
        { title: 'Runs backwards', start: 20, end: 10, hook: '', reason: '' },
      ] }],
    };
  });
  const ai = await state(async () => {
    const { shorts } = window.__cutaway;
    const r = await shorts.runFindShorts(true);
    const ui = shorts.useShorts.getState();
    const seen = window.__cutawayFakeAi.seen;
    return { mode: r?.ai.mode, note: ui.note, found: ui.found.map((c) => ({ key: c.key, title: c.title, start: c.start, end: c.end, duration: c.duration, origin: c.origin, hook: c.hook })), asked: seen.length, images: seen[0]?.images, prompt: seen[0]?.prompt ?? '' };
  });
  console.log('provider', JSON.stringify({ ...ai, prompt: `${ai.prompt.length} chars` }));
  const first = ai.found[0];
  check('a provider reply becomes candidates only after validation', ai.mode === 'claude' && ai.found.length === 1 && first?.origin === 'ai' && first.title === 'Why exports look soft', ai.note);
  check('its range is fitted to whole sentences, outside the cut', !!first && Math.abs(first.start - 3.0) < 0.02 && Math.abs(first.end - 26.82) < 0.02, first ? `${first.start.toFixed(2)}–${first.end.toFixed(2)} (asked for 3.50–26.60)` : '');
  check('the opening line is what was said, not what the reply claimed', first?.hook === SENTENCES[1], first?.hook);
  check('proposals outside the video or backwards are left out, and the note says so', /2 proposals were left out/.test(ai.note ?? ''), ai.note);
  check('the provider was sent text only: the kept sentences, the cut and no pictures', ai.asked === 1 && ai.images === 0 && ai.prompt.includes(SENTENCES[1]) && !ai.prompt.includes(SENTENCES[5]) && /REMOVED RANGES[^\n]*15\.05–18\.05/.test(ai.prompt));

  await page.click('[data-testid="short-keep"]');
  await page.waitForSelector('[data-testid="short-saved"]', { timeout: 5000 });
  const kept = await state(() => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    const s = p.shorts[0];
    return { id: s.id, short: s, duration: core.shortDuration(p, s), framings: core.shortFramings(p, s) };
  });
  check('keeping a proposal saves it as a vertical short framed on the face, with captions', kept.short.shape === 'vertical' && kept.short.framing === 'face' && kept.short.captions.preset === 'pop' && kept.short.origin === 'ai', JSON.stringify({ shape: kept.short.shape, framing: kept.short.framing, captions: kept.short.captions }));
  check('with a camera and a screen all four framings are offered', kept.framings.join(',') === 'face,stack,screen,original', kept.framings.join(','));
  check('it plays through the cut of the long video', Math.abs(kept.duration - (26.82 - 3.0 - 3.0)) < 0.03, `${kept.duration.toFixed(2)} s for a 23.82 s range`);

  // ───────────────────────── C. the interface: title, range, captions ─────────────────────────
  await page.fill('[data-testid="short-title"]', 'Soft exports, fixed');
  await page.click('[data-testid="short-end-later"]');
  await page.click('[data-testid="short-cap-boxed"]');
  await sleep(200);
  let now = await state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; const s = p.shorts[0]; return { title: s.title, end: s.end, preset: s.captions.preset, duration: core.shortDuration(p, s) }; });
  check('the title, the end of the range and the caption style can be changed', now.title === 'Soft exports, fixed' && Math.abs(now.end - 29.82) < 0.02 && now.preset === 'boxed', JSON.stringify(now));
  await page.click('[data-testid="short-end-earlier"]');
  await page.click('[data-testid="short-cap-pop"]');
  await sleep(200);
  now = await state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; const s = p.shorts[0]; return { end: s.end, preset: s.captions.preset, duration: core.shortDuration(p, s) }; });
  check('the end moves back by one whole sentence', Math.abs(now.end - 26.82) < 0.02 && now.preset === 'pop', JSON.stringify(now));
  await page.click('[data-testid="short-play"]');
  await sleep(1500);
  const playing = await state(() => { const pb = window.__cutaway.usePlayback.getState(); return { t: pb.time, playing: pb.playing }; });
  await page.click('[data-testid="short-play"]');
  check('the short plays in its own frame', playing.playing && playing.t > 0.5 && playing.t < 5, JSON.stringify(playing));
  await state(() => window.__cutaway.usePlayback.getState().seek(4.2));
  await shot('03-short-face');
  check('the face is being followed (seeded track)', /Following your face/.test(await page.locator('[data-testid="short-face-note"]').innerText().catch(() => '')));

  // ───────────────────────── D. export, and what is in the file ─────────────────────────
  // Where the words land in the short, from the same code the renderer uses.
  const timing = await state(() => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    const s = p.shorts[0];
    const map = core.shortMap(p, s);
    return { cues: core.buildShortCues(p.transcript, p.edit, map), outDuration: map.outDuration, safe: core.SHORT_SAFE };
  });
  await page.click('[data-testid="short-export"]');
  await page.waitForSelector('[data-testid="short-export-result"]', { timeout: 180000 });
  const exported = await state(() => { const { shorts, useApp } = window.__cutaway; const id = useApp.getState().project.shorts[0].id; return { result: shorts.useShorts.getState().results[id], saved: useApp.getState().project.shorts[0].exported, jobLeft: !!window.__cutaway.packageExport.useExportJob.getState().job }; });
  console.log('export', JSON.stringify(exported));
  const v1 = exported.result?.path;
  check('the short is exported as its own file in the export folder', exported.result?.status === 'complete' && !!v1 && v1.startsWith(exportDir) && fs.existsSync(v1) && /short/.test(path.basename(v1)), v1 ? path.basename(v1) : exported.result?.message);
  check('the short remembers its last export', exported.saved?.path === v1 && exported.saved.bytes > 0);
  const p1 = probe(v1);
  const W = 1080, H = 1920;
  check('the file is 1080 × 1920 H.264 with sound', p1.width === W && p1.height === H && p1.codec === 'h264' && p1.audio, JSON.stringify(p1));
  check('its length is the range through the time map', Math.abs(p1.duration - kept.duration) < 0.12, `${p1.duration.toFixed(2)} s vs ${kept.duration.toFixed(2)} s`);

  // framing follows the seeded face: red band early, blue band late (the face moves at session 16 = short 10)
  const early = frame(v1, 4.0, W, H);
  const late = frame(v1, 17.0, W, H);
  const spots = [[540, 200], [150, 420], [930, 1500]];
  check('early on, the frame is on the red band where the face is', spots.every(([x, y]) => near(early.px(x, y), RED)), JSON.stringify(spots.map(([x, y]) => early.px(x, y))));
  check('after the face moves, the frame has followed it to the blue band', spots.every(([x, y]) => near(late.px(x, y), BLUE)), JSON.stringify(spots.map(([x, y]) => late.px(x, y))));

  // captions: a line of at least three words; look while its first word is spoken, then its third
  const cue = timing.cues.find((c) => c.words.length >= 3 && c.start > 1 && c.end < 9);
  const mid = (w) => (w.start + w.end) / 2;
  const fA = frame(v1, mid(cue.words[0]), W, H);
  const fB = frame(v1, mid(cue.words[2]), W, H);
  const yA = find(fA, isYellow), wA = find(fA, isWhite), yB = find(fB, isYellow);
  console.log('caption', JSON.stringify({ line: cue.text, yA, wA, yB }));
  check('captions are 2–5 words to a line', timing.cues.length >= 6 && timing.cues.every((c) => c.words.length >= 2 && c.words.length <= 5), timing.cues.slice(0, 4).map((c) => c.text).join(' / '));
  check('a caption is burned in while a word is spoken: one word lit, the rest white', yA.n > 150 && wA.n > 150, `${yA.n} lit and ${wA.n} white samples for "${cue.text}"`);
  const safeTop = H * timing.safe.top, safeBottom = H * (1 - timing.safe.bottom), side = (W * (1 - timing.safe.width)) / 2;
  const box = { x0: Math.min(yA.x0, wA.x0), x1: Math.max(yA.x1, wA.x1), y0: Math.min(yA.y0, wA.y0), y1: Math.max(yA.y1, wA.y1) };
  check('the caption sits inside the area the short-video apps leave clear', box.y0 >= safeTop && box.y1 <= safeBottom && box.x0 >= side - 12 && box.x1 <= W - side + 12, `x ${box.x0}–${box.x1}, y ${box.y0}–${box.y1}; clear area x ${side}–${W - side}, y ${safeTop}–${safeBottom}`);
  check('the lit word is the one being spoken: it moves on with the voice', yB.n > 60 && (yB.cx - yA.cx > 40 || yB.cy - yA.cy > 40), `lit centre ${Math.round(yA.cx)},${Math.round(yA.cy)} → ${Math.round(yB.cx)},${Math.round(yB.cy)}`);
  const gapCue = timing.cues.find((c, i) => timing.cues[i + 1] && timing.cues[i + 1].start - c.end > 0.2 && c.end > 1);
  const fGap = frame(v1, gapCue.end + 0.1, W, H);
  check('between sentences no caption is shown', find(fGap, isYellow).n === 0 && find(fGap, isWhite).n < 20, `at ${(gapCue.end + 0.1).toFixed(2)} s`);
  check('the cut sentence is neither heard nor captioned', !timing.cues.some((c) => /gets cut out/i.test(c.text)) && timing.cues.some((c) => /sharp/i.test(c.text)));

  // ───────────────────────── E. screen framing, square, no captions ─────────────────────────
  await page.click('[data-testid="short-framing-screen"]');
  await state(() => { const { shorts, useApp } = window.__cutaway; const s = useApp.getState().project.shorts[0]; shorts.patchShort(s.id, { shape: 'square', captions: { ...s.captions, preset: 'off' } }); });
  await shot('04-short-screen-square');
  const second = await state(async (dir) => { const { shorts, useApp } = window.__cutaway; const id = useApp.getState().project.shorts[0].id; const r = await shorts.exportShort(id, dir); return { status: r?.status, path: shorts.useShorts.getState().results[id]?.path, error: r?.error?.message }; }, exportDir);
  const v2 = second.path;
  check('a second export gets its own file name', second.status === 'complete' && !!v2 && v2 !== v1 && fs.existsSync(v1) && fs.existsSync(v2), v2 ? path.basename(v2) : second.error);
  const p2 = probe(v2);
  check('the square short is 1080 × 1080', p2.width === 1080 && p2.height === 1080, JSON.stringify(p2));
  const sq = frame(v2, 5, 1080, 1080);
  check('the screen fills the whole frame: its own colours reach every corner', near(sq.px(8, 8), TEAL) && near(sq.px(8, 1070), TEAL) && near(sq.px(1070, 8), ORANGE) && near(sq.px(1070, 1070), ORANGE), JSON.stringify([sq.px(8, 8), sq.px(1070, 1070)]));
  check('with no pointer to follow the window sits in the middle of the screen', near(sq.px(500, 540), TEAL) && near(sq.px(580, 540), ORANGE), JSON.stringify([sq.px(500, 540), sq.px(580, 540)]));
  check('with captions off nothing is burned in', find(sq, isYellow).n === 0 && find(sq, isWhite).n === 0);

  // ───────────────────────── F. by hand, the long video untouched, saved to disk ─────────────────────────
  const hand = await state(() => { const { shorts, useApp } = window.__cutaway; const r = shorts.makeShortFromRange({ start: 27.6, end: 34.9 }); const p = useApp.getState().project; const s = p.shorts.find((x) => x.id === r.id); return { r, short: s }; });
  check('a short can be made by hand from a range, fitted to whole sentences', !!hand.short && hand.short.origin === 'creator' && Math.abs(hand.short.start - 27.0) < 0.03 && Math.abs(hand.short.end - 35.82) < 0.03, hand.short ? `${hand.short.start.toFixed(2)}–${hand.short.end.toFixed(2)} "${hand.short.title}"` : JSON.stringify(hand.r));
  const after = await state(async () => { const { useApp, saveNow } = window.__cutaway; await saveNow(); const st = useApp.getState(); return { edit: JSON.stringify(st.project.edit), revision: st.project.revision, shorts: st.project.shorts.length, projectPath: st.projectPath, undo: st.past.length }; });
  check('making, changing and exporting shorts left the edit of the long video byte for byte the same', after.edit === editBefore && after.revision === revisionBefore, `${after.edit.length} bytes, revision ${after.revision}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(after.projectPath, 'project.json'), 'utf8'));
  check('the shorts are saved with the project, and the saved edit is the same too', onDisk.shorts.length === 2 && JSON.stringify(onDisk.edit) === editBefore && !('reframe' in onDisk.edit) && !onDisk.edit.appearance.captions.short && onDisk.edit.appearance.output.width !== 1080, `${onDisk.shorts.length} shorts on disk`);
  const reopened = await state(async () => { const loaded = await window.cutaway.library.open(window.__cutaway.useApp.getState().projectPath); const sh = loaded.project?.shorts ?? loaded.shorts ?? []; return sh.map((x) => [x.title, x.framing, x.shape, x.captions.preset, !!x.exported]); });
  check('reading the project back from disk gives the same shorts, with their settings', reopened.length === 2 && reopened[0][0] === 'Soft exports, fixed' && reopened[0][1] === 'screen' && reopened[0][2] === 'square' && reopened[0][3] === 'off' && reopened[0][4] === true, JSON.stringify(reopened));
  await page.click('[data-testid="short-saved"] >> nth=1');
  await page.click('[data-testid="short-delete"]');
  await sleep(200);
  check('a short can be removed', (await state(() => window.__cutaway.useApp.getState().project.shorts.length)) === 1);
  await state(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForSelector('.preview-canvas', { timeout: 10000 });
  await sleep(400);
  const back = await state(() => ({ t: window.__cutaway.usePlayback.getState().time, playhead: window.__cutaway.useApp.getState().project.ui.playhead, out: window.__cutaway.useApp.getState().project.edit.appearance.output }));
  check('back in the editor the long video is as it was: its own playhead and frame', back.t === 0 && back.playhead === 0 && back.out.width === 1920, JSON.stringify(back));

  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.log('E2E FAILED:', e?.stack ?? e);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(media, { recursive: true, force: true });
}
console.log(`screenshots → ${out}`);
process.exit(exitCode);
