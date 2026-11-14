// Transitions between clips, B-roll fades and the punch-in on jump cuts, each proved from an exported file.
//   node e2e/transitions.mjs [outDir]
// Footage is generated here with ffmpeg (flat colours, a white square, sine tones): nothing of the creator's is used.
// Needs the app built (node scripts/build.mjs), the native helper built, and ffmpeg/ffprobe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-transitions'));
fs.mkdirSync(out, { recursive: true });
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const ff = (args, opts = {}) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 1 << 26, ...opts });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rgbNear = (px, want, tol) => px.every((v, i) => Math.abs(v - want[i]) <= tol);

// ── footage ──
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-transitions-media-'));
const RED = [220, 30, 30];
const BLUE = [30, 30, 220];
const GREEN = [30, 200, 30];
const WHITE = [255, 255, 255];
const hex = (c) => `0x${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
function flat(name, seconds, colour, hz) {
  const file = path.join(media, name);
  ff(['-y', '-f', 'lavfi', '-i', `color=c=${hex(colour)}:s=1280x720:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '160k', '-shortest', file]);
  return file;
}
const A = flat('opening.mp4', 6, RED, 440);
const B = flat('middle.mp4', 6, BLUE, 880);
const C = flat('ending.mp4', 5, GREEN, 1320);
// a silent white clip that imports as B-roll (its name says so)
const BROLL = path.join(media, 'b-roll white.mp4');
ff(['-y', '-f', 'lavfi', '-i', `color=c=white:s=1280x720:r=30:d=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BROLL]);
// a stand-in for a talking head: a white square in the middle of a dark frame
const HEAD = path.join(media, 'talking.mp4');
ff(['-y', '-f', 'lavfi', '-i', 'color=c=0x202428:s=1280x720:r=30:d=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=48000', '-filter_complex', '[0:v]drawbox=x=480:y=200:w=320:h=320:color=white:t=fill[v]', '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-shortest', HEAD]);

/** Average colour of a small patch of one frame of a file. */
function pixelAt(file, t, x = 200, y = 150) {
  const rgb = ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=16:16:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [rgb[0], rgb[1], rgb[2]];
}
/** Width in pixels of the white square along the middle row of one frame. */
function squareWidth(file, t) {
  const row = ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=iw:2:0:ih/2-1,scale=iw:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  let n = 0;
  for (const v of row) if (v > 160) n++;
  return n;
}
/** Level of each tone in a short stretch of a file's sound, and the loudest sample there. */
function soundAt(file, t, seconds = 0.1) {
  const pcm = ff(['-ss', String(t), '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const n = Math.floor(pcm.length / 2);
  let peak = 0;
  const acc = { 440: [0, 0], 880: [0, 0], 1320: [0, 0] };
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    peak = Math.max(peak, Math.abs(v));
    for (const hz of [440, 880, 1320]) {
      const w = (2 * Math.PI * hz * i) / 48000;
      acc[hz][0] += v * Math.cos(w);
      acc[hz][1] += v * Math.sin(w);
    }
  }
  const amp = (hz) => (2 * Math.hypot(acc[hz][0], acc[hz][1])) / Math.max(1, n);
  return { 440: amp(440), 880: amp(880), 1320: amp(1320), peak };
}
const lengthOf = (file) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

const { app, page, exportDir } = await launch();
const state = (fn, arg) => page.evaluate(fn, arg);
const menu = async (cmd) => {
  await app.evaluate(({ BrowserWindow }, c) => (BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('#')) ?? BrowserWindow.getAllWindows()[0]).webContents.send('menu', c), cmd);
  await page.waitForTimeout(300);
};
const shot = async (name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};
const exportNow = (name) =>
  state(
    async ({ dest, name }) => {
      const { useApp, exporter } = window.__cutaway;
      const st = useApp.getState();
      const session = await window.cutaway.export.begin(dest, name);
      try {
        const r = await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
        const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
        return { ok: true, duration: r.duration, hasAudio: r.hasAudio, file: `${done.folder}/video.mp4` };
      } catch (e) {
        await window.cutaway.export.abort(session.id, false);
        return { ok: false, error: e.message };
      }
    },
    { dest: exportDir, name },
  );
const transitions = () =>
  state(() => {
    const { useApp, core } = window.__cutaway;
    const p = useApp.getState().project;
    const name = (id) => core.clipsOf(p).find((c) => c.id === id)?.name;
    return core.transitionsOf(p.edit).map((t) => ({ from: name(t.from), to: name(t.to), kind: t.kind, duration: t.duration }));
  });
const joins = () => page.locator('[data-testid="clip-join"]');
const joinKinds = () => joins().evaluateAll((els) => els.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((e) => e.getAttribute('data-kind')));
const idOf = (name) => state((n) => window.__cutaway.core.clipsOf(window.__cutaway.useApp.getState().project).find((c) => c.name === n)?.id, name);

try {
  // ───────────── three clips, with footage beyond the first clip change ─────────────
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), A);
  await state((files) => window.__cutaway.actions.importFiles(files), [B, C, BROLL]);
  await state(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForSelector('[data-testid="clip-track"]');
  const setup = await state(() => {
    const { useApp, core } = window.__cutaway;
    const cs = core.clipsOf(useApp.getState().project);
    ['Opening', 'Middle', 'Ending'].forEach((n, i) => useApp.getState().edit((_e, p) => core.renameClip(p, cs[i].id, n), 'Rename clip'));
    // Opening loses its last second and Middle its first: that footage is what the dissolve can use
    useApp.getState().edit((_e, p) => core.trimClip(p, cs[0].id, 'tail', 1), 'Trim');
    useApp.getState().edit((_e, p) => core.trimClip(p, cs[1].id, 'head', 1), 'Trim');
    // tones are measured as they are: no voice clean-up
    useApp.getState().edit((e) => ({ ...e, audio: { ...e.audio, voiceCleanup: { ...e.audio.voiceCleanup, enabled: false } } }), 'Clean-up off');
    const p = useApp.getState().project;
    return { clips: core.playingClips(core.clipsOf(p)).map((c) => [c.name, +c.start.toFixed(2), +(c.out - c.in).toFixed(2)]), roles: p.sources.map((s) => s.role), out: +window.__cutaway.timeMapOf(p).outDuration.toFixed(2), broll: p.sources.find((s) => s.role === 'broll')?.id ?? null };
  });
  check('three clips on the timeline and one B-roll file', setup.clips.length === 3 && !!setup.broll && near(setup.out, 15, 0.1), JSON.stringify(setup));
  check('a marker sits on each clip change, and shows a hard cut', (await joins().count()) === 2 && JSON.stringify(await joinKinds()) === JSON.stringify(['none', 'none']), JSON.stringify(await joinKinds()));

  // the hard-cut export is the reference for length and for full sound level
  const hard = await exportNow('hard-cuts');
  check('the hard-cut edit exports', hard.ok && hard.hasAudio, JSON.stringify(hard));
  const hardLength = hard.ok ? lengthOf(hard.file) : 0;
  const full = hard.ok ? { 440: soundAt(hard.file, 2, 0.2)[440], 880: soundAt(hard.file, 7.5, 0.2)[880], 1320: soundAt(hard.file, 12.5, 0.2)[1320] } : { 440: 1, 880: 1, 1320: 1 };
  if (hard.ok) {
    check('at a hard cut the picture changes from one frame to the next', rgbNear(pixelAt(hard.file, 4.9), RED, 40) && rgbNear(pixelAt(hard.file, 5.1), BLUE, 40), `${pixelAt(hard.file, 4.9)} → ${pixelAt(hard.file, 5.1)}`);
    check('each clip is heard at a steady level', full[440] > 0.02 && full[880] > 0.02 && full[1320] > 0.02, JSON.stringify(full));
  }

  // ───────────── set transitions: on the boundary, and from the clip panel ─────────────
  await page.locator('[data-testid="clip-track"]').hover();
  await joins().first().click();
  await page.waitForSelector('[data-testid="clip-join-menu"]');
  await shot('01-boundary-menu');
  await page.locator('[data-testid="clip-join-menu"] [data-kind="dissolve"]').click();
  await page.waitForTimeout(200);
  let tr = await transitions();
  check('choosing Cross-dissolve on the boundary sets it between those two clips', tr.length === 1 && tr[0].from === 'Opening' && tr[0].to === 'Middle' && tr[0].kind === 'dissolve' && near(tr[0].duration, 0.5, 1e-6), JSON.stringify(tr));
  check('the marker now shows the transition', JSON.stringify(await joinKinds()) === JSON.stringify(['dissolve', 'none']) && (await joins().first().getAttribute('class')).includes('set'));
  check('the menu shows a length control once a transition is set', (await page.locator('[data-testid="clip-join-menu"] input[type="range"]').count()) === 1);
  await page.locator('[data-testid="clip-join-all"]').click();
  await page.waitForTimeout(250);
  tr = await transitions();
  check('"Use on every clip change" sets the same transition on every boundary', tr.length === 2 && tr.every((t) => t.kind === 'dissolve') && JSON.stringify(await joinKinds()) === JSON.stringify(['dissolve', 'dissolve']), JSON.stringify(tr));
  await menu('undo');
  tr = await transitions();
  check('and that is one undo step', tr.length === 1 && tr[0].to === 'Middle', JSON.stringify(tr));
  await page.keyboard.press('Escape');

  // the second boundary from the clip panel
  await page.locator('[data-testid="clip-block"]', { hasText: 'Ending' }).first().click();
  await page.waitForSelector('[data-testid="transition-in"]');
  check('the clip panel offers the transition into the selected clip, and none out of the last clip', (await page.locator('[data-testid="transition-in"]').count()) === 1 && (await page.locator('[data-testid="transition-out"]').count()) === 0);
  await page.locator('[data-testid="transition-in"] [data-kind="dip-black"]').click();
  await page.waitForTimeout(200);
  tr = await transitions();
  check('choosing Dip to black in the clip panel sets it on that boundary', tr.length === 2 && tr.some((t) => t.from === 'Middle' && t.to === 'Ending' && t.kind === 'dip-black'), JSON.stringify(tr));
  await shot('02-clip-panel');
  // one second each, and B-roll over the last clip that fades in over a second and ends on a hard cut
  const [opening, middle, ending] = [await idOf('Opening'), await idOf('Middle'), await idOf('Ending')];
  const laid = await state(({ opening, middle, ending, broll }) => {
    const { useApp, core, timeMapOf } = window.__cutaway;
    useApp.getState().edit((_e, p) => core.setTransition(p, opening, middle, 'dissolve', 1), 'Length');
    useApp.getState().edit((_e, p) => core.setTransition(p, middle, ending, 'dip-black', 1), 'Length');
    useApp.getState().edit((e, p) => ({ ...e, broll: [{ id: 'br1', assetId: broll, start: 13.2, end: 16.2, assetIn: 0, fit: 'cover', useAssetAudio: false, fadeIn: 1, fadeOut: 0, meta: { origin: 'creator', revision: p.revision + 1 } }] }), 'B-roll');
    const p = useApp.getState().project;
    const map = timeMapOf(p);
    return { out: +map.outDuration.toFixed(3), placed: core.placedTransitions(p, map).map((t) => [t.transition.kind, +t.start.toFixed(3), +t.at.toFixed(3), +t.end.toFixed(3)]), broll: [+map.toOutput(13.2).toFixed(2), +map.toOutput(16.2).toFixed(2)] };
  }, { opening, middle, ending, broll: setup.broll });
  check('both transitions are centred on their clip change and the video is no longer or shorter', near(laid.out, setup.out, 1e-6) && JSON.stringify(laid.placed) === JSON.stringify([['dissolve', 4.5, 5, 5.5], ['dip-black', 9.5, 10, 10.5]]), JSON.stringify(laid));

  // the preview draws the same blend
  await state(() => window.__cutaway.usePlayback.getState().seek(10.0));
  await page.waitForTimeout(700);
  const prev = await page.locator('canvas.preview-canvas').first().evaluate((c) => {
    const d = c.getContext('2d').getImageData(Math.round(c.width * 0.15), Math.round(c.height * 0.15), 4, 4).data;
    return [d[0], d[1], d[2]];
  });
  check('the preview shows the dip at the clip change (black)', prev.every((v) => v < 40), String(prev));
  await state(() => window.__cutaway.usePlayback.getState().seek(5.0));
  await page.waitForTimeout(1200);
  const prevMix = await page.locator('canvas.preview-canvas').first().evaluate((c) => {
    const d = c.getContext('2d').getImageData(Math.round(c.width * 0.15), Math.round(c.height * 0.15), 4, 4).data;
    return [d[0], d[1], d[2]];
  });
  check('the preview shows both clips blended in the middle of the dissolve', prevMix[0] > 70 && prevMix[0] < 190 && prevMix[2] > 70 && prevMix[2] < 190, String(prevMix));
  await shot('03-mid-dissolve');

  const soft = await exportNow('transitions');
  check('the edit with transitions exports', soft.ok && soft.hasAudio, JSON.stringify(soft));
  if (soft.ok && hard.ok) {
    const f = soft.file;
    check('the export is exactly as long as with hard cuts', near(lengthOf(f), hardLength, 0.02), `${lengthOf(f).toFixed(3)} s vs ${hardLength.toFixed(3)} s`);
    // ── cross-dissolve, 4.5 → 5.5 ──
    const before = pixelAt(f, 4.3);
    const mid = pixelAt(f, 4.99);
    const after = pixelAt(f, 5.7);
    check('before the dissolve the picture is the first clip, after it the second', rgbNear(before, RED, 40) && rgbNear(after, BLUE, 40), `${before} … ${after}`);
    check('in the middle each pixel is the blend of the two clips', near(mid[0], (RED[0] + BLUE[0]) / 2, 30) && near(mid[2], (RED[2] + BLUE[2]) / 2, 30) && mid[1] < 70, `${mid} (want about ${[(RED[0] + BLUE[0]) / 2, 30, (RED[2] + BLUE[2]) / 2]})`);
    const ramp = [4.6, 4.8, 5.0, 5.2, 5.4].map((t) => pixelAt(f, t));
    check('the blend moves steadily from one clip to the other', ramp.every((p, i) => i === 0 || (p[0] < ramp[i - 1][0] - 8 && p[2] > ramp[i - 1][2] + 8)), ramp.map((p) => `${p[0]}/${p[2]}`).join(' → '));
    // ── dip to black, 9.5 → 10.5 ──
    const dipIn = pixelAt(f, 9.74);
    const dip = [pixelAt(f, 9.97), pixelAt(f, 10.0)];
    const dipOut = pixelAt(f, 10.24);
    check('a dip is black at the clip change', dip.every((p) => p.every((v) => v < 35)), dip.join(' | '));
    check('half way into the dip the first clip is half faded, half way out the second is half up', near(dipIn[2], BLUE[2] / 2, 35) && dipIn[0] < 40 && near(dipOut[1], GREEN[1] / 2, 35) && dipOut[2] < 40, `${dipIn} … ${dipOut}`);
    check('outside the dip the clips are untouched', rgbNear(pixelAt(f, 9.3), BLUE, 40) && rgbNear(pixelAt(f, 10.7), GREEN, 40));
    // ── sound ──
    const sMid = soundAt(f, 4.95, 0.1);
    check('in the middle of the dissolve both clips are heard at about 71% (equal power)', near(sMid[440] / full[440], Math.SQRT1_2, 0.12) && near(sMid[880] / full[880], Math.SQRT1_2, 0.12), `${(sMid[440] / full[440]).toFixed(2)} and ${(sMid[880] / full[880]).toFixed(2)}`);
    const sEarly = soundAt(f, 4.7, 0.1);
    const sLate = soundAt(f, 5.2, 0.1);
    check('the first clip fades down as the second comes up, using the footage beyond each edge', sEarly[440] / full[440] > 0.8 && near(sEarly[880] / full[880], Math.sin(((0.25 * Math.PI) / 2)), 0.12) && sLate[880] / full[880] > 0.8 && near(sLate[440] / full[440], Math.cos((0.75 * Math.PI) / 2), 0.12), `early ${(sEarly[440] / full[440]).toFixed(2)}/${(sEarly[880] / full[880]).toFixed(2)}, late ${(sLate[440] / full[440]).toFixed(2)}/${(sLate[880] / full[880]).toFixed(2)}`);
    const loud = Math.max(...[4.4, 4.6, 4.8, 5.0, 5.2, 5.4].map((t) => soundAt(f, t, 0.2).peak));
    check('the two sounds together never clip', loud < 0.98 && loud < (full[440] + full[880]) * 1.05, `peak ${loud.toFixed(3)}; the two at full level would reach ${(full[440] + full[880]).toFixed(3)}`);
    const sDip = soundAt(f, 9.97, 0.06);
    const sDipIn = soundAt(f, 9.72, 0.06);
    const sDipOut = soundAt(f, 10.22, 0.06);
    check('through a dip the sound goes down to silence and comes back up', sDip[880] / full[880] < 0.15 && sDip[1320] / full[1320] < 0.15 && near(sDipIn[880] / full[880], Math.SQRT1_2, 0.15) && near(sDipOut[1320] / full[1320], Math.SQRT1_2, 0.15), `at the change ${(sDip[880] / full[880]).toFixed(2)}/${(sDip[1320] / full[1320]).toFixed(2)}; before ${(sDipIn[880] / full[880]).toFixed(2)}; after ${(sDipOut[1320] / full[1320]).toFixed(2)}`);
    // ── B-roll: output 11.2 → 14.2, one second in, hard cut out ──
    const half = pixelAt(f, 11.7);
    check('B-roll with a one-second fade is half way in after half a second', half[0] > 95 && half[0] < 190 && half[2] > 95 && half[2] < 190 && half[1] > 200, String(half));
    check('it starts from the footage and reaches full', rgbNear(pixelAt(f, 11.25), GREEN, 45) && rgbNear(pixelAt(f, 12.4), WHITE, 30), `${pixelAt(f, 11.25)} … ${pixelAt(f, 12.4)}`);
    check('with its fade-out set to nothing it ends on a hard cut', rgbNear(pixelAt(f, 14.12), WHITE, 30) && rgbNear(pixelAt(f, 14.3), GREEN, 45), `${pixelAt(f, 14.12)} → ${pixelAt(f, 14.3)}`);
  }

  // ───────────── clip operations keep transitions honest ─────────────
  const moved = await state(({ ending }) => {
    const { useApp, core } = window.__cutaway;
    useApp.getState().edit((_e, p) => core.moveClip(p, ending, 0), 'Move clip');
    const p = useApp.getState().project;
    const name = (id) => core.clipsOf(p).find((c) => c.id === id)?.name;
    return { order: core.playingClips(core.clipsOf(p)).map((c) => c.name), left: core.transitionsOf(p.edit).map((t) => [name(t.from), name(t.to), t.kind]) };
  }, { ending });
  await page.waitForTimeout(250);
  check('moving a clip away drops the transition it was part of and keeps the other', JSON.stringify(moved.order) === JSON.stringify(['Ending', 'Opening', 'Middle']) && JSON.stringify(moved.left) === JSON.stringify([['Opening', 'Middle', 'dissolve']]), JSON.stringify(moved));
  check('the markers follow', JSON.stringify(await joinKinds()) === JSON.stringify(['none', 'dissolve']), JSON.stringify(await joinKinds()));
  await menu('undo');
  tr = await transitions();
  check('undo brings the clip and its transition back together', tr.length === 2 && JSON.stringify(await joinKinds()) === JSON.stringify(['dissolve', 'dip-black']), JSON.stringify(tr));

  // ───────────── punch-in on jump cuts ─────────────
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), HEAD);
  await state(() => window.__cutaway.useApp.getState().setView('edit'));
  await page.waitForSelector('.timeline');
  const talk = await state(() => {
    const { useApp, core } = window.__cutaway;
    const meta = (p) => ({ origin: 'creator', revision: p.revision + 1 });
    useApp.getState().edit((e, p) => ({ ...e, cuts: [{ id: 'c1', start: 3, end: 3.5, kind: 'manual', meta: meta(p) }, { id: 'c2', start: 6, end: 6.5, kind: 'manual', meta: meta(p) }, { id: 'c3', start: 8, end: 8.5, kind: 'manual', meta: meta(p) }] }), 'Cuts');
    const p = useApp.getState().project;
    return { roles: p.sources.map((s) => s.role), view: core.resolveLayout(p, 1).mode, on: core.punchInOf(p.edit).enabled };
  });
  check('a camera-only video plays full frame, and the punch-in is off until asked for', talk.view === 'camera' && talk.on === false && !talk.roles.includes('screen'), JSON.stringify(talk));
  check('no cut is marked while it is off', (await page.locator('[data-testid="punch-mark"]').count()) === 0);
  // switch it on in the Camera tab
  await state(() => (window.__cutaway.useApp.getState().select(null), window.__cutaway.useApp.getState().setPanels({ inspector: true, tab: 'camera' })));
  await page.waitForTimeout(300);
  const toggle = page.locator('.insp-section', { hasText: 'Jump cuts' }).locator('button[role="switch"][aria-label="Punch in on jump cuts"]').first();
  if (await toggle.count()) await toggle.click();
  await page.waitForTimeout(300);
  let punchOn = await state(() => window.__cutaway.core.punchInOf(window.__cutaway.useApp.getState().project.edit).enabled);
  check('the Camera tab has a "Punch in on jump cuts" switch that turns it on', punchOn === true);
  if (!punchOn) await state(() => window.__cutaway.useApp.getState().edit((e) => window.__cutaway.core.setPunchIn(e, { enabled: true }), 'Punch in'));
  await page.waitForTimeout(300);
  await shot('04-punch-in');
  const marks = () => page.locator('[data-testid="punch-mark"]').evaluateAll((els) => els.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((e) => e.getAttribute('data-state')));
  check('every cut inside the shot is marked on the timeline: in, back out, in', JSON.stringify(await marks()) === JSON.stringify(['in', 'out', 'in']), JSON.stringify(await marks()));
  check('the Camera tab lists where the framing changes', (await page.locator('[data-testid="punch-join"]').count()) === 3 && /3 of 3/.test((await page.locator('[data-testid="punch-count"]').textContent()) ?? ''), (await page.locator('[data-testid="punch-count"]').textContent().catch(() => '')) ?? '');
  // leave the third cut out, from the cut's own panel
  await state(() => window.__cutaway.useApp.getState().select({ kind: 'cut', id: 'c3' }));
  await page.waitForTimeout(250);
  const cutToggle = page.locator('.insp-section', { hasText: 'Punch in at this cut' }).locator('button[role="switch"][aria-label="Punch in at this cut"]').first();
  if (await cutToggle.count()) await cutToggle.click();
  await page.waitForTimeout(300);
  let skip = await state(() => window.__cutaway.core.punchInOf(window.__cutaway.useApp.getState().project.edit).skip);
  check('a cut\'s own panel can leave that cut out', JSON.stringify(skip) === JSON.stringify(['c3']), JSON.stringify(skip));
  if (skip.length === 0) await state(() => window.__cutaway.useApp.getState().edit((e) => window.__cutaway.core.setPunchSkipped(e, ['c3'], true), 'Leave out'));
  await page.waitForTimeout(250);
  check('and the timeline shows it as left out', JSON.stringify(await marks()) === JSON.stringify(['in', 'out', 'off']), JSON.stringify(await marks()));
  await menu('undo');
  check('leaving a cut out is one undo step', JSON.stringify(await state(() => window.__cutaway.core.punchInOf(window.__cutaway.useApp.getState().project.edit).skip)) === '[]');
  await menu('redo');
  const punched = await exportNow('punch-in');
  check('the talking-head edit exports', punched.ok, JSON.stringify(punched));
  if (punched.ok) {
    const f = punched.file;
    // output: shot 1 0–3, shot 2 3–5.5, shot 3 5.5–7, shot 4 7–8.5
    const w = [1.5, 4.2, 6.2, 7.8].map((t) => squareWidth(f, t));
    check('before the first cut the framing is normal', near(w[0], 480, 14), `${w[0]} px (the square is a quarter of the 1920 px frame)`);
    check('after a qualifying cut the picture is punched in by about 12%', near(w[1] / w[0], 1.12, 0.03), `${w[1]} px, ×${(w[1] / w[0]).toFixed(3)}`);
    check('after the next cut it is back to normal', near(w[2], w[0], 6), `${w[2]} px`);
    check('at the cut that was left out the framing does not change', near(w[3], w[2], 6), `${w[3]} px`);
    check('the punch-in changes framing only: the video is as long as its kept footage', near(lengthOf(f), 8.5, 0.1), `${lengthOf(f).toFixed(2)} s`);
  }
  // derived, not stored: a zoom over the first cut takes the punch-in away there and resets the alternation
  const derived = await state(() => {
    const { useApp, core, timeMapOf } = window.__cutaway;
    const before = JSON.stringify(Object.keys(useApp.getState().project.edit.punchIn));
    useApp.getState().edit((e, p) => ({ ...e, layouts: [{ id: 'lv', start: 6.2, end: 9, mode: 'camera', camera: 'A', transition: 'cut', meta: { origin: 'creator', revision: p.revision + 1 } }] }), 'View change');
    const p = useApp.getState().project;
    return { stored: before, joins: core.punchJoins(p, timeMapOf(p)).map((j) => [j.qualifies, j.why ?? null, j.punched]) };
  });
  check('only the setting and the left-out cuts are stored; where it applies is worked out from the edit', derived.stored === JSON.stringify(['enabled', 'scale', 'skip']) && JSON.stringify(derived.joins) === JSON.stringify([[true, null, true], [false, 'view', false], [true, null, false]]), JSON.stringify(derived));
} catch (e) {
  failed++;
  console.log('E2E FAILED:', e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(media, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
