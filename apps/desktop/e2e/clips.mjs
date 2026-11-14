// Several clips on one timeline: add, reorder, trim, split, remove, undo, versions, chat scope,
// and an export checked from its pixels and its sound.
//   node e2e/clips.mjs [outDir]
// Footage is generated here with ffmpeg (flat colours and sine tones): nothing of the creator's is used.
// Needs the app built (node scripts/build.mjs), the native helper built, and ffmpeg/ffprobe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-clips'));
fs.mkdirSync(out, { recursive: true });
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

// ── footage: each file is one colour, then another, with its own tone ──
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-clips-media-'));
const COLORS = { red: [220, 30, 30], yellow: [220, 220, 30], green: [30, 200, 30], cyan: [30, 200, 200], blue: [30, 30, 220], magenta: [220, 30, 220] };
const hex = (c) => `0x${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
function make(name, seconds, first, second, hz) {
  const file = path.join(media, name);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${hex(COLORS[first])}:s=1280x720:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`, '-filter_complex', `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=${hex(COLORS[second])}:t=fill:enable='gte(t,${seconds / 2})'[v];[1:a]volume=0.5[a]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '128k', '-t', String(seconds), file]);
  return file;
}
const A = make('opening.mp4', 6, 'red', 'yellow', 440);
const B = make('middle.mp4', 5, 'green', 'cyan', 880);
const C = make('ending.mp4', 4, 'blue', 'magenta', 1320);

/** Which of the six colours the centre of a frame of the export is. */
function colourAt(file, t) {
  const rgb = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=64:64,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
  const px = [rgb[0], rgb[1], rgb[2]];
  let best = null;
  for (const [name, c] of Object.entries(COLORS)) {
    const d = Math.hypot(px[0] - c[0], px[1] - c[1], px[2] - c[2]);
    if (!best || d < best.d) best = { name, d };
  }
  return best.d < 90 ? best.name : `other(${px.join(',')})`;
}
/** Strength of each of the three tones in half a second of the export's sound. */
function tonesAt(file, t) {
  const pcm = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-t', '0.5', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 24 });
  const n = Math.floor(pcm.length / 2);
  const power = (hz) => {
    const w = (2 * Math.PI * hz) / 48000;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      re += v * Math.cos(w * i);
      im += v * Math.sin(w * i);
    }
    return Math.hypot(re, im) / Math.max(1, n);
  };
  const p = { 440: power(440), 880: power(880), 1320: power(1320) };
  const top = Object.entries(p).sort((x, y) => y[1] - x[1])[0];
  return { ...p, loudest: top[1] > 0.02 ? Number(top[0]) : 0 };
}

const { app, page, exportDir } = await launch();
const state = (fn, arg) => page.evaluate(fn, arg);
/** A command from the app menu (⌘Z, ⇧⌘Z, ⌘B are menu shortcuts), sent the way the menu sends it. */
const menu = async (cmd) => {
  await app.evaluate(({ BrowserWindow }, c) => (BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('#')) ?? BrowserWindow.getAllWindows()[0]).webContents.send('menu', c), cmd);
  await page.waitForTimeout(300);
};
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
/** The clips as the creator sees them: name, start and length of each playing clip, in order. */
const clips = () =>
  state(() => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    return core.playingClips(core.clipsOf(p)).map((c) => ({ id: c.id, name: c.name, start: +c.start.toFixed(3), len: +(c.out - c.in).toFixed(3), in: +c.in.toFixed(3) }));
  });
const names = async () => (await clips()).map((c) => c.name);
const blocks = () => page.locator('[data-testid="clip-block"]');
const blockOf = (name) => page.locator('[data-testid="clip-block"]', { hasText: name }).first();
const blockNames = () => blocks().evaluateAll((els) => els.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((e) => e.querySelector('.tl-clip-name')?.textContent ?? e.getAttribute('aria-label')));
/** Drag a block by its middle to a horizontal position on screen. */
async function dragBlock(name, toX) {
  const box = await blockOf(name).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) await page.mouse.move(box.x + box.width / 2 + ((toX - (box.x + box.width / 2)) * i) / steps, y);
  await page.waitForTimeout(80);
  return async () => {
    await page.mouse.up();
    await page.waitForTimeout(250);
  };
}

try {
  // ───────────── one file: an ordinary project, exactly as before ─────────────
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), A);
  await state(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForSelector('.timeline');
  const single = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { stored: p.edit.clips ?? null, sources: p.sources.map((s) => [s.role, s.take ?? null, s.window ?? null]), duration: p.duration };
  });
  check('a project with one file has no clip list and is untouched by the clip model', single.stored === null && single.sources.every((s) => s[1] === null && s[2] === null) && Math.abs(single.duration - 6) < 0.1, JSON.stringify(single));
  check('and still shows its one clip, so there is something to click, split and trim', (await page.locator('[data-testid="clip-block"]').count()) === 1);
  // a click on the footage picks the clip under it
  // the footage row: the simple timeline's video row, or the clip row of the detailed lanes
  await page.waitForTimeout(600); // let the timeline finish sizing itself before measuring
  const lane = await page.locator('[data-testid="clip-block"]').first().boundingBox();
  await page.mouse.click(lane.x + lane.width * 0.4, lane.y + lane.height / 2);
  await page.waitForTimeout(150);
  check('a click on the footage selects the clip under it', (await state(() => window.__cutaway.useApp.getState().selection?.kind)) === 'clip');
  check('and puts the playhead where you clicked', Math.abs((await state(() => window.__cutaway.usePlayback.getState().time)) - 6 * 0.4) < 0.3, String(await state(() => window.__cutaway.usePlayback.getState().time)));
  // the scissors on the playhead split it there; undo leaves the project as it was
  await page.locator('[data-testid="playhead-split"]').click();
  await page.waitForTimeout(250);
  check('the scissors on the playhead split the clip in two', (await page.locator('[data-testid="clip-block"]').count()) === 2);
  await state(() => window.__cutaway.useApp.getState().undo());
  await page.waitForTimeout(150);
  check('undo makes it one clip again', (await page.locator('[data-testid="clip-block"]').count()) === 1);
  await state(() => window.__cutaway.useApp.getState().select(null));

  // ───────────── more footage arrives: clips at the end, not B-roll ─────────────
  const report = await state(async (files) => {
    const r = await window.__cutaway.actions.importFiles(files);
    return r.accepted.map((a) => ({ name: a.source.name, role: a.source.role, clip: a.clip ?? null }));
  }, [B, C]);
  check('each imported video is added to the timeline as a clip', report.length === 2 && report.every((r) => r.clip && r.role !== 'broll'), JSON.stringify(report));
  let cl = await clips();
  check('three clips, end to end, in the order they came', cl.length === 3 && cl[0].start === 0 && Math.abs(cl[1].start - 6) < 0.05 && Math.abs(cl[2].start - 11) < 0.05 && Math.abs(cl[2].start + cl[2].len - 15) < 0.1, JSON.stringify(cl));
  const placed = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { duration: p.duration, cams: p.sources.filter((s) => s.role === 'cameraA').map((s) => ({ name: s.name, take: s.take ?? 'main', offset: +s.sync.offset.toFixed(2), window: s.window && [+s.window.start.toFixed(2), +s.window.end.toFixed(2)] })), voices: [p.edit.audio.masterVoiceId, ...Object.values(p.edit.audio.takeVoices ?? {})].length, broll: p.sources.filter((s) => s.role === 'broll').length };
  });
  check('each clip has its own camera source, placed where the clip plays', placed.cams.length === 3 && placed.cams.every((c) => c.window && Math.abs(c.window[0] - c.offset) < 0.05) && placed.broll === 0, JSON.stringify(placed.cams));
  check('each clip has its own audible voice', placed.voices === 3);
  check('the project is as long as the clips together', Math.abs(placed.duration - 15) < 0.1, String(placed.duration));
  // rename so the blocks can be told apart in the interface
  await state(() => {
    const { useApp, core } = window.__cutaway;
    const st = useApp.getState();
    const cs = core.clipsOf(st.project);
    ['Opening', 'Middle', 'Ending'].forEach((n, i) => useApp.getState().edit((_e, p) => core.renameClip(p, cs[i].id, n), 'Rename clip'));
  });
  await page.waitForSelector('[data-testid="clip-track"]');
  check('the clips row shows one block per clip, in order', JSON.stringify(await blockNames()) === JSON.stringify(['Opening', 'Middle', 'Ending']), JSON.stringify(await blockNames()));
  await shot('01-three-clips');

  // words, a chapter and a flag on known footage, to follow them through the edits
  await state(() => {
    const { useApp } = window.__cutaway;
    const w = (id, text, start) => ({ id, text, start, end: start + 0.4, kind: 'word' });
    useApp.getState().patch((p) => ({
      ...p,
      transcript: { engine: 'test', locale: 'en-US', onDevice: true, sourceId: p.edit.audio.masterVoiceId, hasSpeech: true, words: [w('wa', 'alpha', 1.5), w('wb1', 'bravo', 7), w('wb2', 'delta', 9.5), w('wc', 'charlie', 12)], generatedAt: '' },
      flags: [{ id: 'fl', t: 12.5 }],
      packaging: { ...p.packaging, chapters: [{ sessionTime: 0, title: 'Opening part' }, { sessionTime: 11, title: 'Ending part' }] },
    }));
    useApp.getState().patch((p) => window.__cutaway.core.checkpoint(p, 'Three clips in order', 'creator'));
  });
  const baseRevision = await state(() => window.__cutaway.useApp.getState().project.revision);

  // ───────────── reorder by dragging ─────────────
  const firstBox = await blockOf('Opening').boundingBox();
  const drop = await dragBlock('Ending', firstBox.x + 6);
  check('while dragging, a marker shows where the clip will land', (await page.locator('.tl-clip-drop').count()) === 1 && (await page.locator('.tl-clip.dragging').count()) === 1);
  await shot('02-dragging');
  await drop();
  check('dragging the last clip to the front reorders the clips', JSON.stringify(await names()) === JSON.stringify(['Ending', 'Opening', 'Middle']), JSON.stringify(await names()));
  check('the row follows', JSON.stringify(await blockNames()) === JSON.stringify(['Ending', 'Opening', 'Middle']));
  const moved = await state(() => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    const map = new core.TimeMap(p.duration, p.edit.cuts, p.edit.speeds);
    return { words: p.transcript.words.map((x) => [x.text, +x.start.toFixed(2)]), flag: core.flagsOf(p).map((f) => +f.t.toFixed(2)), chapters: core.chaptersToOutput(p.packaging.chapters, map).map((c) => c.title), cues: core.buildCues(p.transcript, p.edit, map).map((c) => c.text) };
  });
  check('words, the flag and chapters moved with their clips', JSON.stringify(moved.words) === JSON.stringify([['charlie', 1], ['alpha', 5.5], ['bravo', 11], ['delta', 13.5]]) && moved.flag[0] === 1.5 && JSON.stringify(moved.chapters) === JSON.stringify(['Ending part', 'Opening part']), JSON.stringify(moved));
  check('captions follow the new order', /charlie/.test(moved.cues[0] ?? ''), JSON.stringify(moved.cues));
  await menu('undo');
  check('undo puts the clips back, with everything on them', JSON.stringify(await names()) === JSON.stringify(['Opening', 'Middle', 'Ending']) && (await state(() => window.__cutaway.useApp.getState().project.transcript.words[0].text)) === 'alpha');
  await menu('redo');
  check('redo moves it again', JSON.stringify(await names()) === JSON.stringify(['Ending', 'Opening', 'Middle']));
  // keyboard: Option-arrow on a focused block
  await blockOf('Middle').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(200);
  check('Option-arrow moves a clip one place without a pointer', JSON.stringify(await names()) === JSON.stringify(['Ending', 'Middle', 'Opening']), JSON.stringify(await names()));
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForTimeout(200);

  // ───────────── trim by dragging an end ─────────────
  cl = await clips();
  const opening = cl.find((c) => c.name === 'Opening');
  await blockOf('Opening').click();
  const ob = await blockOf('Opening').boundingBox();
  const pps = ob.width / opening.len;
  const head = await blockOf('Opening').locator('[data-testid="clip-trim-head"]').boundingBox();
  await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(head.x + head.width / 2 + (pps * 1.0 * i) / 8, head.y + head.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const trimmed = await state((id) => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    const c = core.clipsOf(p).find((x) => x.id === id);
    return { trim: core.clipTrim(p.edit, c), start: c.start, len: c.out - c.in, cuts: p.edit.cuts.map((x) => [x.kind, +x.start.toFixed(2), +x.end.toFixed(2)]), out: new core.TimeMap(p.duration, p.edit.cuts, p.edit.speeds).outDuration };
  }, opening.id);
  check('dragging the start of a clip trims it by that much', Math.abs(trimmed.trim.head - 1) < 0.15 && trimmed.trim.tail === 0, JSON.stringify(trimmed.trim));
  check('a trim is a cut on the clip edge: the clip keeps its place and length, the video gets shorter', Math.abs(trimmed.start - opening.start) < 1e-6 && Math.abs(trimmed.len - opening.len) < 1e-6 && trimmed.cuts.length === 1 && trimmed.cuts[0][0] === 'trim' && Math.abs(trimmed.out - (15 - trimmed.trim.head)) < 0.05, JSON.stringify(trimmed));
  check('the clip panel says what was trimmed and offers to restore it', /Trimmed: .*off the start/.test(await page.locator('.inspector').innerText()) && (await page.locator('[data-testid="clip-untrim"]').count()) === 1);
  await shot('03-trimmed');
  await page.locator('[data-testid="clip-untrim"]').click();
  await page.waitForTimeout(150);
  check('Restore brings the trimmed footage back', (await state(() => window.__cutaway.useApp.getState().project.edit.cuts.length)) === 0);
  // an exact trim for the export check below
  await state((id) => window.__cutaway.useApp.getState().edit((_e, p) => window.__cutaway.core.trimClip(p, id, 'head', 1), 'Trim clip start'), opening.id);

  // ───────────── split at the playhead, move the halves apart ─────────────
  cl = await clips();
  const middle = cl.find((c) => c.name === 'Middle');
  await state((t) => {
    const { useApp, usePlayback, core } = window.__cutaway;
    const p = useApp.getState().project;
    useApp.getState().select(null);
    usePlayback.getState().seek(new core.TimeMap(p.duration, p.edit.cuts, p.edit.speeds).toOutput(t));
  }, middle.start + 2.5);
  await page.locator('.timeline').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await state(() => window.__cutaway.useApp.getState().select(null));
  await menu('split');
  cl = await clips();
  check('⌘B with nothing selected splits the clip under the playhead', cl.length === 4 && cl.filter((c) => /^Middle/.test(c.name)).length === 2 && Math.abs(cl.find((c) => c.name === 'Middle').len - 2.5) < 0.01, JSON.stringify(cl));
  const halves = await state(() => window.__cutaway.useApp.getState().project.sources.filter((s) => s.instanceOf).length);
  check('a split alone adds no second placement of the file', halves === 0);
  const secondHalf = cl.find((c) => /^Middle \(/.test(c.name));
  check('the new half is selected', (await state(() => window.__cutaway.useApp.getState().selection)).id === secondHalf.id);
  // move the second half to the very front with the panel button, twice... or drag: use the drag
  const endingBox = await blockOf('Ending').boundingBox();
  await (await dragBlock(secondHalf.name, endingBox.x + 4))();
  check('the second half can be moved away from the first', JSON.stringify(await names()) === JSON.stringify([secondHalf.name, 'Ending', 'Opening', 'Middle']), JSON.stringify(await names()));
  const apart = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    const inst = p.sources.filter((s) => s.instanceOf);
    return { inst: inst.map((s) => ({ of: p.sources.find((x) => x.id === s.instanceOf)?.name, window: [+s.window.start.toFixed(2), +s.window.end.toFixed(2)], local: +((s.window.start - s.sync.offset) * s.sync.rate).toFixed(2) })), words: p.transcript.words.map((x) => [x.text, +x.start.toFixed(2)]) };
  });
  check('each half now has its own placement of the same file, starting where it should', apart.inst.length === 1 && /middle/.test(apart.inst[0].of) && apart.inst[0].window[0] === 0 && Math.abs(apart.inst[0].local - 2.5) < 0.01, JSON.stringify(apart.inst));
  check('the word spoken in the second half went with it', apart.words[0][0] === 'delta' && Math.abs(apart.words[0][1] - 1) < 0.01, JSON.stringify(apart.words));
  await shot('04-split-apart');

  // ───────────── remove, undo, remove ─────────────
  await blockOf('Ending').click();
  await page.waitForTimeout(100);
  check('selecting a clip opens its panel', /Clip 2 of 4/.test(await page.locator('.inspector').innerText()));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  check('Backspace takes the selected clip off the timeline', JSON.stringify(await names()) === JSON.stringify([secondHalf.name, 'Opening', 'Middle']), JSON.stringify(await names()));
  const gone = await state(() => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    return { duration: +p.duration.toFixed(2), off: core.clipsOf(p).filter((c) => c.removed).map((c) => c.name), files: p.sources.filter((s) => /ending/.test(s.name)).length, words: p.transcript.words.map((x) => x.text), parked: (p.transcript.parked ?? []).map((x) => x.text), flags: core.flagsOf(p).length };
  });
  check('its footage stays in the project; its words and flag are set aside', gone.off[0] === 'Ending' && gone.files === 1 && !gone.words.includes('charlie') && gone.parked.includes('charlie') && gone.flags === 0 && Math.abs(gone.duration - 11) < 0.05, JSON.stringify(gone));
  await menu('undo');
  check('undo brings the clip back where it was, with its words', JSON.stringify(await names()) === JSON.stringify([secondHalf.name, 'Ending', 'Opening', 'Middle']) && (await state(() => window.__cutaway.useApp.getState().project.transcript.words.map((x) => x.text).join(' '))) === 'delta charlie alpha bravo');
  await menu('redo');
  check('redo removes it again', (await names()).length === 3);
  // Sources lists it as off the timeline and can put it back
  await state(() => window.__cutaway.useApp.getState().setView('sources'));
  await page.waitForSelector('[data-testid="source-clip"]');
  const pills = await page.locator('[data-testid="source-clip"]').allInnerTexts();
  check('Sources shows which clip each file plays in, and which is off the timeline', pills.some((t) => /Off the timeline · Ending/.test(t)) && pills.some((t) => /Middle( \(2\))? \+1/.test(t)), JSON.stringify(pills));
  check('a file placed twice is still one file in Sources', (await page.locator('.source-row').count()) === 3, String(await page.locator('.source-row').count()));
  await shot('05-sources');
  await page.locator('[data-testid="source-put-back"]').click();
  await page.waitForTimeout(250);
  check('Put back returns the clip to the end of the timeline', JSON.stringify(await names()) === JSON.stringify([secondHalf.name, 'Opening', 'Middle', 'Ending']), JSON.stringify(await names()));
  await state(() => window.__cutaway.useApp.getState().undo());
  await state(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForSelector('[data-testid="clip-track"]');

  // ───────────── a version from before all this, looked at and left ─────────────
  const viewing = await state((rev) => {
    const { useApp, core, viewedProject } = window.__cutaway;
    useApp.getState().viewVersion({ revision: rev, label: 'Three clips in order' });
    const v = viewedProject(useApp.getState());
    const live = useApp.getState().project;
    return { viewed: core.playingClips(core.clipsOf(v)).map((c) => c.name), words: v.transcript.words.map((x) => x.text), offsets: v.sources.filter((s) => s.role === 'cameraA' && !s.instanceOf).map((s) => +s.sync.offset.toFixed(1)), live: core.playingClips(core.clipsOf(live)).map((c) => c.name) };
  }, baseRevision);
  await page.waitForTimeout(300);
  check('an earlier version is shown in its own clip order, with the footage laid out to match', viewing.viewed.length === 3 && JSON.stringify(viewing.words) === JSON.stringify(['alpha', 'bravo', 'delta', 'charlie']) && JSON.stringify(viewing.offsets) === JSON.stringify([0, 6, 11]) && viewing.live.length === 3, JSON.stringify(viewing));
  check('the clips row shows that version, read-only', (await blocks().count()) === 3 && (await page.locator('.lane-clips.readonly').count()) === 1);
  await shot('06-viewing-version');
  await state(() => window.__cutaway.useApp.getState().exitViewing());
  await page.waitForTimeout(200);
  check('leaving the version returns to the latest order', (await blocks().count()) === 3 && JSON.stringify(await names()) === JSON.stringify([secondHalf.name, 'Opening', 'Middle']));

  // ───────────── the AI is told about clips, and its proposals stay inside one ─────────────
  await state(() => {
    const { useApp } = window.__cutaway;
    useApp.setState({ claude: { found: true, path: '/fake/ai', version: '0', signedIn: true, message: 'test provider', provider: 'claude' } });
    window.__cutaway.jobs.grantConsent();
    window.__cutawayFakeAi = { replies: [{ reply: 'Faster through the join.', edits: [{ op: 'speed', start: 1, end: 5, speed: 2, reason: 'Nothing happens here.' }], remove: [], moments: [] }], seen: [] };
    useApp.getState().select(null);
    useApp.getState().setPanels({ inspector: true, tab: 'chat' });
  });
  await page.waitForSelector('[data-testid="chat-input"]');
  await page.locator('[data-testid="chat-input"]').fill('Speed up the dull part');
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-reply"]').length >= 1 && !document.querySelector('[data-testid="chat-thinking"]'), null, { timeout: 20000 });
  const prompt = await state(() => window.__cutawayFakeAi.seen[0]?.prompt ?? '');
  check('the model is told the video is several clips, and where each one is', /several clips played one after another/.test(prompt) && /CLIP 1 "Middle \(2\)" — 0\.00–2\.50/.test(prompt) && /CLIP 2 "Opening"/.test(prompt) && /CLIP 3 "Middle"/.test(prompt), (prompt.match(/CLIP \d[^\n]*/g) ?? []).join(' | '));
  const cards = await page.locator('[data-testid="chat-card"]').evaluateAll((els) => els.map((e) => [e.dataset.status, e.querySelector('.chat-card-what')?.textContent ?? '']));
  const notes = await page.locator('[data-testid="chat-note"]').allInnerTexts();
  check('a change that ran across two clips comes back as one per clip, and says so', cards.length === 2 && cards.every((c) => c[0] === 'open') && notes.some((t) => /one clip ends/.test(t)), JSON.stringify({ cards, notes }));
  // a selected clip is the section a request is about
  await state((id) => window.__cutaway.useApp.getState().select({ kind: 'clip', id }), opening.id);
  const scope = await state(() => {
    const st = window.__cutaway.useApp.getState();
    const c = window.__cutaway.core.clipsOf(st.project).find((x) => x.id === st.selection.id);
    return { start: c.start, end: c.start + c.out - c.in };
  });
  check('a selected clip has a definite section', Math.abs(scope.start - 2.5) < 0.01 && Math.abs(scope.end - 8.5) < 0.01, JSON.stringify(scope));
  await state(() => window.__cutaway.useApp.getState().select(null));

  // ───────────── export: the right footage at the right time, in the right order ─────────────
  // Playing order now: Middle second half (cyan, 2.5 s) · Opening minus its first second (red 2 s, yellow 3 s) · Middle first half (green, 2.5 s)
  const exp = await state(async (dest) => {
    const { useApp, exporter } = window.__cutaway;
    const st = useApp.getState();
    const session = await window.cutaway.export.begin(dest, 'clips-export');
    try {
      const r = await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
      const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
      return { ok: true, duration: r.duration, hasAudio: r.hasAudio, folder: done.folder };
    } catch (e) {
      await window.cutaway.export.abort(session.id, false);
      return { ok: false, error: e.message };
    }
  }, exportDir);
  check('the edit exports', exp.ok && exp.hasAudio, JSON.stringify(exp));
  if (exp.ok) {
    const file = path.join(exp.folder, 'video.mp4');
    const length = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
    check('the export is as long as the three playing pieces', Math.abs(length - 10) < 0.15, `${length.toFixed(2)} s`);
    const want = [[0.5, 'cyan'], [2.0, 'cyan'], [3.0, 'red'], [4.2, 'red'], [5.0, 'yellow'], [7.0, 'yellow'], [8.0, 'green'], [9.5, 'green']];
    const got = want.map(([t]) => colourAt(file, t));
    check('each moment of the export shows the footage of the clip that plays there', want.every(([, c], i) => got[i] === c), want.map(([t, c], i) => `${t}s ${got[i]}${got[i] === c ? '' : ` (wanted ${c})`}`).join(', '));
    const sweep = [];
    for (let t = 0.25; t < length - 0.1; t += 0.25) sweep.push(colourAt(file, t));
    check('the removed clip appears nowhere, and neither does the trimmed first second', !sweep.includes('blue') && !sweep.includes('magenta') && sweep.every((c) => !/^other/.test(c)), [...new Set(sweep)].join(', '));
    check('the footage changes exactly three times (two clip changes and the colour change inside the opening clip)', sweep.filter((c, i) => i > 0 && c !== sweep[i - 1]).length === 3, sweep.join(' '));
    const sound = [[0.8, 880], [3.2, 440], [6.5, 440], [8.6, 880]].map(([t, hz]) => ({ t, hz, got: tonesAt(file, t) }));
    check('each clip is heard with its own sound', sound.every((s) => s.got.loudest === s.hz), sound.map((s) => `${s.t}s ${s.got.loudest} Hz`).join(', '));
    check('the removed clip is not heard anywhere', [0.8, 3.2, 6.5, 8.6].every((t) => tonesAt(file, t)[1320] < 0.01));
  }

  // ───────────── recording another take into the project: a clip, or B-roll if preferred ─────────────
  await state(() => window.__cutaway.useApp.getState().setView('sources'));
  await page.waitForSelector('[data-testid="record-clip"]');
  await page.locator('[data-testid="record-clip"]').click();
  await page.waitForSelector('.record .rec-bar', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.rec-stage .spinner'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  await state(() => {
    window.__realStart = window.cutaway.record.start;
    window.cutaway.record.start = (projectPath, config) => window.__realStart(projectPath, { ...config, synthetic: true, screen: { ...(config.screen ?? { type: 'display', displayId: 1, showCursor: false }) }, cameras: [], microphone: null, systemAudio: false, captureKeys: false });
  });
  const before = await clips();
  await page.click('[data-testid="start-recording"]');
  await page.waitForSelector('.rec-live', { timeout: 30000 });
  await page.waitForFunction(() => /Recording/.test(document.querySelector('.rec-live .rec-state')?.textContent ?? ''), null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  await state(() => window.cutaway.record.stop());
  await page.waitForSelector('[data-testid="quick-share"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="qs-use"]', { timeout: 10000 });
  const useText = await page.locator('[data-testid="qs-use"]').innerText();
  let after = await clips();
  const take = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    const mine = p.sources.filter((s) => s.origin === 'recording');
    return { roles: mine.map((s) => s.role), take: mine[0]?.take ?? null, window: mine[0]?.window ?? null, broll: p.sources.filter((s) => s.role === 'broll').length };
  });
  check('a take recorded into a project that has footage becomes a clip at the end', after.length === before.length + 1 && Math.abs(after[after.length - 1].start - before.reduce((n, c) => n + c.len, 0)) < 0.05 && take.roles.includes('screen') && !!take.take && !!take.window && take.broll === 0, JSON.stringify({ after: after.map((c) => c.name), take }));
  check('the sheet says so and offers B-roll instead', /Added to the timeline as “Clip \d+”/.test(useText) && (await page.locator('[data-testid="qs-as-broll"]').count()) === 1, useText);
  await shot('07-take-as-clip');
  await page.locator('[data-testid="qs-as-broll"]').click();
  await page.waitForSelector('[data-testid="qs-as-clip"]', { timeout: 10000 });
  after = await clips();
  const asBroll = await state(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { recorded: p.sources.filter((s) => s.origin === 'recording').map((s) => s.role), duration: +p.duration.toFixed(2) };
  });
  check('“Use as B-roll instead” takes it off the timeline and keeps it as supporting media', after.length === before.length && asBroll.recorded.length > 0 && asBroll.recorded.every((r) => r === 'broll' || r === 'music') && Math.abs(asBroll.duration - 11) < 0.05, JSON.stringify({ asBroll, clips: after.map((c) => c.name) }));
  await page.locator('[data-testid="qs-as-clip"]').click();
  await page.waitForSelector('[data-testid="qs-as-broll"]', { timeout: 10000 });
  after = await clips();
  check('“Add to the timeline” puts it back as a clip', after.length === before.length + 1, JSON.stringify(after.map((c) => c.name)));
  await shot('08-take-switched');

  // ───────────── the processing stages run over every clip ─────────────
  await page.locator('[data-testid="qs-open-editor"], [data-testid="quick-share"] button').first().waitFor({ timeout: 5000 }).catch(() => {});
  const cutRun = await state(async () => {
    const { useApp, jobs, core } = window.__cutaway;
    useApp.getState().go('project');
    // the words planted earlier are not from this footage: let the real stages write their own
    useApp.getState().patch((p) => ({ ...p, transcript: null, analysis: null, stages: {} }));
    void jobs.startFirstCut(false);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    while (useApp.getState().job?.status === 'running' && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 250));
    const st = useApp.getState();
    const p = st.project;
    const total = core.clipsOf(p).reduce((n, c) => n + (c.out - c.in), 0);
    const map = new core.TimeMap(p.duration, p.edit.cuts, p.edit.speeds);
    return { job: st.job && { status: st.job.status, error: st.job.error, stages: st.job.stages.map((x) => [x.id, x.status]) }, firstCut: p.firstCut?.mode ?? null, waveform: p.analysis?.waveform.length ?? 0, hz: p.analysis?.waveformHz ?? 0, activity: p.analysis?.activity.length ?? 0, activityHz: p.analysis?.activityHz ?? 0, total, duration: p.duration, straddling: [...p.edit.zooms, ...p.edit.layouts, ...p.edit.speeds, ...p.edit.overlays, ...p.edit.broll].filter((x) => core.splitAtClips(core.clipsOf(p), x).length > 1).length, clips: core.playingClips(core.clipsOf(p)).length, out: map.outDuration, loud: (() => { const a = p.analysis; if (!a) return []; return core.playingClips(core.clipsOf(p)).map((c) => { const i0 = Math.round((c.start + 0.5) * a.waveformHz); const i1 = Math.round((c.start + c.out - c.in - 0.5) * a.waveformHz); let n = 0; for (let i = i0; i < i1; i++) if ((a.waveform[i] ?? 0) > 0.01) n++; return +(n / Math.max(1, i1 - i0)).toFixed(2); }); })() };
  });
  check('a first cut runs over a project of several clips', !cutRun.job?.error && (cutRun.job === null || cutRun.job.status !== 'failed') && cutRun.firstCut === 'local-rules', JSON.stringify(cutRun.job ?? cutRun.firstCut));
  check('the analysis covers the whole timeline, every clip in its own place', cutRun.waveform >= Math.floor(cutRun.duration * cutRun.hz) && cutRun.loud.slice(0, 3).every((v) => v > 0.6), JSON.stringify({ waveform: cutRun.waveform, hz: cutRun.hz, duration: cutRun.duration, loud: cutRun.loud }));
  // (a removal that touches both sides of a boundary is kept as one cut; it is split if the clips are moved apart)
  check('no view, zoom, speed change or graphic of the cut runs across two clips', cutRun.straddling === 0 && cutRun.clips === 4 && cutRun.out > 2, JSON.stringify({ straddling: cutRun.straddling, clips: cutRun.clips, out: cutRun.out }));

  // ───────────── reopen: everything is saved and comes back the same ─────────────
  const saved = await state(async () => {
    const { useApp, saveNow, core } = window.__cutaway;
    await saveNow();
    const st = useApp.getState();
    const snap = (p) => JSON.stringify({ clips: core.clipsOf(p).map((c) => [c.name, c.start, c.in, c.out, !!c.removed]), sources: p.sources.map((s) => [s.id, s.sync.offset, s.window ?? null]), words: (p.transcript?.words ?? []).map((w) => [w.text, w.start]), duration: p.duration });
    const beforeText = snap(st.project);
    const path_ = st.projectPath;
    const { project } = await window.cutaway.library.open(path_);
    return { same: snap(project) === beforeText, clips: core.clipsOf(project).length };
  });
  check('the project reopens with the same clips, placements and words', saved.same && saved.clips >= 4, JSON.stringify(saved));
} catch (e) {
  failed++;
  console.log(`ERROR ${e.stack ?? e}`);
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  fs.rmSync(media, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
