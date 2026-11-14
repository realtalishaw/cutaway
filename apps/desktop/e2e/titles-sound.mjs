// Free text and titles, music clips and sound effects, through the real app and exporter.
// Everything is measured from exported files: pixels for the text, samples for the sound.
// Uses only footage and tones generated here with ffmpeg. No model is called.
// Usage: node e2e/titles-sound.mjs [outDir]
import { launch } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FF = '/opt/homebrew/bin/ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-titles-sound'));
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const ff = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 256e6 });

// ── generated media: flat-coloured footage (so text pixels are unmistakable) and pure tones ──
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-ts-media-'));
const DURATION = 12;
const file = (n) => path.join(media, n);
ff(['-f', 'lavfi', '-i', `color=c=0x204060:s=1280x720:r=30:d=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-an', file('camera-main.mp4')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=16', '-af', 'volume=4', '-ac', '2', file('tone-440.wav')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=16', '-af', 'volume=4', '-ac', '2', file('tone-880.wav')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=2000:sample_rate=48000:duration=0.3', '-af', 'volume=4', '-ac', '2', file('blip-2000.wav')]);

const { app, page, exportDir } = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
let exitCode = 1;
try {
  await state((files) => window.__cutaway.actions.importIntoNewProject(files), [file('camera-main.mp4'), file('tone-440.wav'), file('tone-880.wav'), file('blip-2000.wav')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 20000 });
  const setup = await state(() => {
    const { useApp } = window.__cutaway;
    const st = useApp.getState();
    // whatever role the importer guessed, these three are sound files to use as music and effects
    st.patch((p) => ({ ...p, sources: p.sources.map((s) => (s.kind === 'audio' ? { ...s, role: 'music' } : s)) }));
    st.edit((e) => ({ ...e, appearance: { ...e.appearance, background: { type: 'solid', color: '#101820' } } }), 'flat background');
    st.go('project');
    st.setView('edit');
    st.setPanels({ inspector: true, tab: 'text', drawer: null });
    const p = useApp.getState().project;
    return { duration: p.duration, sources: p.sources.map((s) => [s.name, s.role, s.kind, +s.duration.toFixed(2)]), out: p.edit.appearance.output };
  });
  console.log('project', JSON.stringify(setup));
  const W = setup.out.width, H = setup.out.height;
  check('the generated footage and three tone files are in the project', Math.abs(setup.duration - DURATION) < 0.2 && setup.sources.filter((s) => s[1] === 'music').length === 3, JSON.stringify(setup.sources));
  await page.waitForSelector('[data-testid="tpl-big-title"]', { timeout: 10000 });
  await shot('01-text-tab');

  // ───────────────────────── A. text through the interface ─────────────────────────
  const overlays = () => state(() => window.__cutaway.useApp.getState().project.edit.overlays.map((o) => ({ id: o.id, kind: o.kind, text: o.text, sub: o.subtext ?? null, start: o.start, end: o.end, x: o.x, y: o.y, font: o.style?.font, anim: o.style?.in.type, sound: o.sound ?? null })));
  const seekTo = (session) => state((t) => { const { usePlayback, useApp, timeMapOf } = window.__cutaway; usePlayback.getState().setPlaying(false); usePlayback.getState().seek(timeMapOf(useApp.getState().project).toOutput(t)); }, session);
  const count = await state(() => document.querySelectorAll('.tt-card').length);
  check('the Text tab offers the title templates as live thumbnails', count >= 8 && (await state(() => [...document.querySelectorAll('.tt-thumb canvas')].every((c) => c.width > 0 && c.height > 0))), `${count} templates`);

  await seekTo(1);
  await page.click('[data-testid="tpl-big-title"]');
  let ov = await overlays();
  check('one click on "Big title" adds a text overlay at the playhead and opens its editor', ov.length === 1 && ov[0].kind === 'text' && Math.abs(ov[0].start - 1) < 0.05 && ov[0].font === 'anton' && (await page.locator('[data-testid="text-input"]').count()) === 1, JSON.stringify(ov[0]));
  await page.fill('[data-testid="text-input"]', 'Launch day');
  await page.fill('[data-testid="text-sub-input"]', 'What changed and why');
  ov = await overlays();
  check('the words and a second line are edited in the inspector', ov[0].text === 'Launch day' && ov[0].sub === 'What changed and why');
  check('the text is a block on the timeline', (await page.locator('.tl-item.overlay.text').count()) === 1);
  await shot('02-big-title-editor');

  // drag it on the preview
  const box = await page.locator('.preview-canvas').boundingBox();
  const before = ov[0];
  await page.mouse.move(box.x + box.width * before.x, box.y + box.height * before.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (before.x + 0.08), box.y + box.height * (before.y + 0.2), { steps: 6 });
  await page.mouse.up();
  ov = await overlays();
  check('dragging the text on the preview moves it', Math.abs(ov[0].x - (before.x + 0.08)) < 0.03 && Math.abs(ov[0].y - (before.y + 0.2)) < 0.03, `${before.x.toFixed(2)},${before.y.toFixed(2)} → ${ov[0].x.toFixed(3)},${ov[0].y.toFixed(3)}`);
  await page.mouse.move(box.x + box.width * ov[0].x, box.y + box.height * ov[0].y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 1.4, box.y + box.height * 1.4, { steps: 4 });
  await page.mouse.up();
  ov = await overlays();
  check('a drag past the edge stops at the safe margin', ov[0].x < 0.97 && ov[0].y < 0.96 && ov[0].x > 0.5, `${ov[0].x.toFixed(3)}, ${ov[0].y.toFixed(3)}`);

  await page.click('button[aria-label="Duplicate"]');
  ov = await overlays();
  check('Duplicate makes a second text right after the first and selects it', ov.length === 2 && Math.abs(ov[1].start - ov[0].end) < 1e-6 && ov[1].text === 'Launch day' && (await state(() => window.__cutaway.useApp.getState().selection?.id)) === ov[1].id);
  await state(() => window.__cutaway.useApp.getState().undo());
  check('and one undo takes the copy away', (await overlays()).length === 1);

  // the tool pill and the T key
  await state(() => window.__cutaway.useApp.getState().select(null));
  await seekTo(6);
  await page.click('.ed-tools button[aria-label^="Add text at the playhead"]');
  ov = await overlays();
  check('the text tool adds plain text at the playhead', ov.length === 2 && ov[1].text === 'Your text' && Math.abs(ov[1].start - 6) < 0.05);
  await state(() => { document.activeElement?.blur?.(); window.__cutaway.useApp.getState().select(null); });
  await seekTo(9);
  await page.keyboard.press('t');
  ov = await overlays();
  check('so does the T key', ov.length === 3 && Math.abs(ov[2].start - 9) < 0.05);
  await page.keyboard.press('Backspace');
  check('and Backspace removes the selected text', (await overlays()).length === 2);

  // ───────────────────────── B. exported pixels ─────────────────────────
  // Replace the texts with ones whose colour, place and timing are known exactly.
  const YELLOW = '#ffe600';
  await state(({ YELLOW }) => {
    const { useApp, core } = window.__cutaway;
    const base = core.defaultTextStyle();
    const mk = (id, start, end, text, x, y, patch) => ({ id, kind: 'text', start, end, text, x, y, style: core.normalizeTextStyle({ ...base, font: 'inter', weight: 800, size: 0.2, color: YELLOW, shadow: 0, tracking: 0, ...patch }), meta: { origin: 'creator', revision: 1 } });
    useApp.getState().edit((e) => ({
      ...e,
      overlays: [
        mk('ov_slide', 1, 4, 'HHHH', 0.5, 0.3, { in: { type: 'slide-up', duration: 1 }, out: { type: 'none', duration: 0.2 } }),
        mk('ov_fade', 5, 7, 'HHHH', 0.5, 0.3, { in: { type: 'fade', duration: 1 }, out: { type: 'fade', duration: 0.5 } }),
        mk('ov_type', 8, 10, 'HHHHHHHH', 0.5, 0.3, { size: 0.12, in: { type: 'typewriter', duration: 1 }, out: { type: 'none', duration: 0.2 } }),
        mk('ov_pill', 10.2, 11.8, 'HH', 0.5, 0.75, { size: 0.1, color: '#000000', background: { shape: 'pill', color: '#ff00ff', opacity: 1 }, in: { type: 'none', duration: 0.2 }, out: { type: 'none', duration: 0.2 } }),
      ],
    }), 'known texts');
    useApp.getState().select(null);
  }, { YELLOW });

  let n = 0;
  const exportVideo = async (label) => {
    const r = await state(async ({ dest, name }) => {
      const { useApp, exporter } = window.__cutaway;
      const st = useApp.getState();
      const session = await window.cutaway.export.begin(dest, name);
      try {
        await exporter.renderVideo({ project: st.project, projectPath: st.projectPath, sessionId: session.id, fileName: 'video.mp4', onProgress: () => {}, signal: new AbortController().signal });
        const done = await window.cutaway.export.commit(session.id, ['video.mp4']);
        return { ok: true, folder: done.folder };
      } catch (e) { await window.cutaway.export.abort(session.id, false); return { ok: false, error: e.message }; }
    }, { dest: exportDir, name: `ts-${++n}-${label}` });
    if (!r.ok) throw new Error(`export ${label} failed: ${r.error}`);
    return path.join(r.folder, 'video.mp4');
  };
  /** One exported frame as RGB, scaled to a width of 480. */
  const frameAt = (video, t, fps = 30) => {
    const w = 480, h = Math.round((480 * H) / W / 2) * 2;
    const raw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `select='eq(n\\,${Math.round(t * fps)})',scale=${w}:${h}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 });
    return { w, h, px: (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; }, raw };
  };
  /** Pixels that are the text colour or a blend of it over the dark footage, with their centre and extent. */
  const yellow = (f, region = [0, 0, 1, 1]) => {
    let c = 0, sx = 0, sy = 0, minX = Infinity, maxX = -Infinity, strength = 0;
    for (let y = Math.floor(region[1] * f.h); y < Math.ceil(region[3] * f.h); y++) for (let x = Math.floor(region[0] * f.w); x < Math.ceil(region[2] * f.w); x++) {
      const i = (y * f.w + x) * 3;
      const r = f.raw[i], g = f.raw[i + 1], b = f.raw[i + 2];
      if (r - b > 45 && g - b > 35) { c++; sx += x; sy += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); strength += r - b; }
    }
    return { count: c, cx: c ? sx / c / f.w : null, cy: c ? sy / c / f.h : null, minX: minX / f.w, maxX: maxX / f.w, strength: c ? strength / c : 0 };
  };

  const v1 = await exportVideo('texts');
  const settled = yellow(frameAt(v1, 3.0));
  const none = yellow(frameAt(v1, 0.5));
  check('exported: the text is there, in its colour, where it was placed', settled.count > 1500 && Math.abs(settled.cx - 0.5) < 0.02 && Math.abs(settled.cy - 0.3) < 0.03, JSON.stringify(settled));
  const solid = frameAt(v1, 3.0);
  // an "H" has solid vertical strokes: somewhere along the text's middle row the pure colour appears
  let pure = 0;
  for (let x = Math.round(solid.w * settled.minX); x < Math.round(solid.w * settled.maxX); x++) { const [r, g, b] = solid.px(x, settled.cy * solid.h); if (r > 235 && g > 205 && b < 60) pure++; }
  check('exported: settled text is the exact colour asked for', pure > 20, `${pure} pixels of ${YELLOW} on the middle row`);
  check('exported: nothing of it before it starts, or between texts', none.count === 0 && yellow(frameAt(v1, 4.5)).count === 0, `${none.count} at 0.5 s, ${yellow(frameAt(v1, 4.5)).count} at 4.5 s`);
  check('exported: the rest of the frame has none of the text colour', yellow(frameAt(v1, 3.0), [0, 0.55, 1, 1]).count === 0);
  const sliding = yellow(frameAt(v1, 1.2));
  check('exported: mid slide-up the text is lower and fainter than when settled', sliding.count > 200 && sliding.cy > settled.cy + 0.02 && sliding.strength < settled.strength - 15, `centre y ${sliding.cy?.toFixed(3)} vs ${settled.cy.toFixed(3)} · strength ${sliding.strength.toFixed(0)} vs ${settled.strength.toFixed(0)}`);
  const f1 = yellow(frameAt(v1, 5.3)), f2 = yellow(frameAt(v1, 5.7)), f3 = yellow(frameAt(v1, 6.3)), f4 = yellow(frameAt(v1, 6.85));
  check('exported: a fade gets stronger on the way in and weaker on the way out, without moving', f1.strength < f2.strength - 8 && f2.strength < f3.strength - 8 && f4.strength < f3.strength - 8 && Math.abs((f2.cy ?? 0) - f3.cy) < 0.01, [f1, f2, f3, f4].map((f) => f.strength.toFixed(0)).join(' → '));
  const t1 = yellow(frameAt(v1, 8.3)), t2 = yellow(frameAt(v1, 8.7)), t3 = yellow(frameAt(v1, 9.5));
  check('exported: typewriter text grows from its left edge, letter by letter', t1.count > 50 && t1.count < t2.count && t2.count < t3.count && Math.abs(t1.minX - t3.minX) < 0.01 && t1.maxX < t2.maxX - 0.03 && t2.maxX < t3.maxX - 0.03, `right edge ${t1.maxX.toFixed(3)} → ${t2.maxX.toFixed(3)} → ${t3.maxX.toFixed(3)}`);
  const pill = frameAt(v1, 11);
  const magenta = (x, y) => { const [r, g, b] = pill.px(x * pill.w, y * pill.h); return r > 200 && g < 70 && b > 200; };
  let pillL = 1, pillR = 0;
  for (let x = 0; x < 1; x += 1 / pill.w) if (magenta(x, 0.75)) { pillL = Math.min(pillL, x); pillR = Math.max(pillR, x); }
  check('exported: a pill panel is drawn behind its text, centred on the anchor', pillR - pillL > 0.08 && Math.abs((pillL + pillR) / 2 - 0.5) < 0.02 && !magenta(0.5, 0.6) && !magenta(pillL - 0.03, 0.75), `pill spans ${pillL.toFixed(3)}–${pillR.toFixed(3)}`);

  // the preview draws the same thing
  await seekTo(3);
  await sleep(700);
  const prev = await state(() => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] - d[i + 2] > 45 && d[i + 1] - d[i + 2] > 35) { n++; sx += x; sy += y; } }
    return { n, cx: n ? sx / n / c.width : null, cy: n ? sy / n / c.height : null, share: n / (c.width * c.height) };
  });
  const exportShare = settled.count / (480 * (Math.round((480 * H) / W / 2) * 2));
  check('the preview shows the same text in the same place and at the same size', prev.n > 0 && Math.abs(prev.cx - settled.cx) < 0.01 && Math.abs(prev.cy - settled.cy) < 0.01 && Math.abs(prev.share / exportShare - 1) < 0.12, `preview centre ${prev.cx?.toFixed(3)},${prev.cy?.toFixed(3)} · covers ${(prev.share * 100).toFixed(2)}% vs ${(exportShare * 100).toFixed(2)}% exported`);

  // vertical output: sized from the short side and held inside the safe margin
  await state(() => {
    const { useApp, core } = window.__cutaway;
    useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, output: { ...e.appearance.output, width: 1080, height: 1920 } }, overlays: [{ id: 'ov_edge', kind: 'text', start: 0.5, end: 3, text: 'HHHHHH', x: 0.99, y: 0.99, style: core.normalizeTextStyle({ ...core.defaultTextStyle(), weight: 800, size: 0.12, align: 'right', color: '#ffe600', shadow: 0, tracking: 0, in: { type: 'none', duration: 0.2 }, out: { type: 'none', duration: 0.2 } }), meta: { origin: 'creator', revision: 1 } }] }), 'vertical');
  });
  const v2 = await exportVideo('vertical');
  const dims = execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', v2]).toString().trim();
  const vraw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', v2, '-vf', `select='eq(n\\,45)',scale=270:480`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64e6 });
  const vy = yellow({ w: 270, h: 480, raw: vraw });
  let maxY = 0;
  for (let y = 0; y < 480; y++) for (let x = 0; x < 270; x++) { const i = (y * 270 + x) * 3; if (vraw[i] - vraw[i + 2] > 45 && vraw[i + 1] - vraw[i + 2] > 35) maxY = y; }
  // 5% of the short side: 54 px of 1080 wide, i.e. 5% of the width and 2.8% of the height
  check('vertical export: text pushed into the corner stays inside the safe margin and fits the width', dims === '1080,1920' && vy.count > 300 && vy.maxX <= 0.955 && vy.maxX > 0.9 && vy.minX > 0.05 && maxY / 480 <= 0.975 && maxY / 480 > 0.9, `${dims} · x ${vy.minX.toFixed(3)}–${vy.maxX.toFixed(3)} · bottom ${(maxY / 480).toFixed(3)}`);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.undo(); });

  // ───────────────────────── C. music and sound through the interface ─────────────────────────
  await state(() => { const st = window.__cutaway.useApp.getState(); st.select(null); st.setPanels({ inspector: true, tab: 'audio', drawer: null }); });
  await page.waitForSelector('[data-testid="music-add"]', { timeout: 10000 });
  const ids = await state(() => Object.fromEntries(window.__cutaway.useApp.getState().project.sources.map((s) => [s.name, s.id])));
  await seekTo(0);
  await page.selectOption('[data-testid="music-add"]', ids['tone-440.wav']);
  const music = () => state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return core.musicClipsOf(p.edit, p.sources).map((c) => ({ id: c.id, src: c.sourceId, start: c.start, length: c.length, sourceIn: c.sourceIn, gain: c.gain, fadeIn: c.fadeIn, fadeOut: c.fadeOut, duck: c.duck })); });
  let mu = await music();
  check('choosing a file adds a music clip that ends with the video and fades out', mu.length === 1 && mu[0].start === 0 && Math.abs(mu[0].length - DURATION) < 0.2 && mu[0].fadeOut > 0 && (await state(() => window.__cutaway.useApp.getState().selection?.kind)) === 'music', JSON.stringify(mu[0]));
  check('it is a block on the music row of the timeline', (await page.locator('.lane-music .tl-item.music').count()) === 1);
  await shot('03-music-editor');
  await state(() => window.__cutaway.useApp.getState().select(null));
  await page.waitForSelector('[data-testid="sound-add"]');
  await seekTo(2);
  await page.click('.cue-chip:has-text("Ding")');
  await page.click('[data-testid="sound-add"]');
  const sounds = () => state(() => (window.__cutaway.useApp.getState().project.edit.sounds ?? []).map((s) => ({ id: s.id, start: s.start, builtin: s.builtin, sourceId: s.sourceId ?? null, gain: s.gain })));
  let sn = await sounds();
  check('a built-in sound is added at the playhead and shows on the sound row', sn.length === 1 && sn[0].builtin === 'ding' && Math.abs(sn[0].start - 2) < 0.05 && (await page.locator('.lane-sound .tl-sound').count()) === 1, JSON.stringify(sn[0]));
  await shot('04-sound-effect');

  // "on every cut": two cuts → two sounds, one undo step
  await state(() => {
    const { useApp, core } = window.__cutaway;
    const st = useApp.getState();
    st.select(null);
    st.edit((e, p) => core.manualCut(core.manualCut(e, { start: 3, end: 4 }, p.revision + 1), { start: 7, end: 7.5 }, p.revision + 1), 'two cuts');
  });
  await page.click('.cue-chip:has-text("Pop")');
  await page.click('[data-testid="sound-every-cuts"]');
  sn = await sounds();
  check('"On every cut" puts one sound just after each cut', sn.length === 3 && sn.filter((s) => s.builtin === 'pop').map((s) => +s.start.toFixed(2)).join() === '4,7.5', JSON.stringify(sn.map((s) => [s.builtin, s.start])));
  await page.click('[data-testid="sound-every-cuts"]');
  check('pressing it again adds nothing', (await sounds()).length === 3);
  await state(() => window.__cutaway.useApp.getState().undo());
  check('and one undo removes them all', (await sounds()).length === 1);

  // ───────────────────────── D. exported sound ─────────────────────────
  // A known arrangement. Footage: 12 s with session 3–4 cut, so the video is 11 s and session t ≥ 4 plays at t − 1.
  await state(({ ids }) => {
    const { useApp, core } = window.__cutaway;
    const st = useApp.getState();
    const meta = { origin: 'creator', revision: 1 };
    const words = [];
    // speech from session 6.6 to 7.4: output 5.6–6.4, ducking window 5.35–6.75
    for (let i = 0; i < 4; i++) words.push({ id: `w${i}`, text: 'word', start: 6.6 + i * 0.2, end: 6.6 + i * 0.2 + 0.2, kind: 'word' });
    st.patch((p) => ({ ...p, transcript: { engine: 'fixture', locale: 'en-US', onDevice: true, sourceId: p.sources[0].id, hasSpeech: true, words, generatedAt: new Date().toISOString() } }));
    st.edit((e, p) => ({
      ...core.withMusic({ ...e, cuts: [], overlays: [] }, [
        { id: 'mus_a', sourceId: ids['tone-440.wav'], start: 2, sourceIn: 1, length: 6, gain: 0.5, fadeIn: 1.5, fadeOut: 1, duck: true, meta },
        { id: 'mus_b', sourceId: ids['tone-880.wav'], start: 5, sourceIn: 0, length: 3.2, gain: 0.3, fadeIn: 0, fadeOut: 0, duck: false, meta },
      ]),
      cuts: [{ id: 'cut_1', kind: 'manual', start: 3, end: 4, meta }],
      sounds: [
        core.makeSound(1, { builtin: 'pop', gain: 0.8 }, p.sources, meta), // output 1.0
        core.makeSound(3.5, { builtin: 'ding', gain: 0.8 }, p.sources, meta), // inside the cut: dropped
        core.makeSound(10, { builtin: 'click', gain: 0.8 }, p.sources, meta), // output 9.0
        core.makeSound(11.2, { builtin: null, sourceId: ids['blip-2000.wav'], gain: 0.5 }, p.sources, meta), // output 10.2
      ],
      overlays: [{ id: 'ov_snd', kind: 'text', start: 10.5, end: 11.5, text: 'Hi', x: 0.5, y: 0.5, style: core.defaultTextStyle(), sound: { builtin: 'ding', gain: 0.8 }, meta }], // output 9.5
    }), 'known sound');
  }, { ids });
  await state(() => window.__cutaway.useApp.getState().select(null));
  const tops = await state(() => [...document.querySelectorAll('.lane-music .tl-item.music')].map((el) => Math.round(el.getBoundingClientRect().top)));
  check('two pieces of music that overlap are stacked on the music row, not hidden behind each other', tops.length === 2 && Math.abs(tops[0] - tops[1]) > 20, JSON.stringify(tops));
  check('a sound whose moment is cut is shown dimmed on the sound row', (await page.locator('.lane-sound .tl-sound.cut').count()) === 1 && (await page.locator('.lane-sound .tl-sound').count()) === 5);
  await shot('05-arrangement');
  const v3 = await exportVideo('sound');
  const SR = 8000;
  const pcmBuf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', v3, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 256e6 });
  const pcm = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 4));
  const outSeconds = pcm.length / SR;
  /** Amplitude of one frequency in [from, to) seconds (Goertzel). */
  const amp = (hz, from, to) => {
    const a = Math.max(0, Math.round(from * SR)), b = Math.min(pcm.length, Math.round(to * SR));
    const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = a; i < b; i++) { const s0 = pcm[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / Math.max(1, b - a);
  };
  const rms = (from, to) => { let s = 0, n = 0; for (let i = Math.round(from * SR); i < Math.min(pcm.length, Math.round(to * SR)); i++) { s += pcm[i] * pcm[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
  const onset = (from, to, thr) => { for (let i = Math.round(from * SR); i < Math.min(pcm.length, Math.round(to * SR)); i++) if (Math.abs(pcm[i]) > thr) return i / SR; return null; };
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  check('the exported sound is as long as the video and never clips', Math.abs(outSeconds - 11) < 0.15 && peak < 0.99 && peak > 0.2, `${outSeconds.toFixed(2)} s · peak ${peak.toFixed(3)}`);

  // music clip A: 440 Hz, plays output 2–8, 1.5 s in, 1 s out, ducks under speech
  const plateau = amp(440, 3.8, 4.8);
  check('music starts where it was placed: silent before 2.0 s, playing after', amp(440, 1.2, 1.95) < plateau * 0.01 && amp(440, 2.4, 2.6) > plateau * 0.05 && plateau > 0.05, `before ${amp(440, 1.2, 1.95).toExponential(1)} · plateau ${plateau.toFixed(3)}`);
  const ramp = [2.2, 2.6, 3.0, 3.4].map((t) => amp(440, t - 0.1, t + 0.1) / plateau);
  // level follows (t / fade)² : 0.018, 0.16, 0.44, 0.87 at these centres
  check('the fade-in ramps up along its curve', ramp.every((v, i) => i === 0 || v > ramp[i - 1]) && Math.abs(ramp[1] - 0.16) < 0.06 && Math.abs(ramp[2] - 0.444) < 0.08 && Math.abs(ramp[3] - 0.871) < 0.1, ramp.map((v) => v.toFixed(3)).join(' → '));
  // the cut is at output 3.0: the music must run straight through it
  const across = [2.9, 3.0, 3.1].map((t) => amp(440, t - 0.05, t + 0.05) / plateau);
  check('a cut in the footage does not chop or dip the music', across[0] < across[1] && across[1] < across[2] && Math.abs(across[1] - 0.444) < 0.08, across.map((v) => v.toFixed(3)).join(' → '));
  const ducked = amp(440, 5.75, 6.25) / plateau;
  check('ducking lowers the music under speech to about a fifth, and brings it back', Math.abs(ducked - 0.22) < 0.05 && amp(440, 6.9, 7.0) / plateau > 0.6, `during speech ${ducked.toFixed(3)} of the plateau`);
  const b = amp(880, 5.75, 6.25), bFree = amp(880, 7.0, 7.9);
  check('an overlapping second clip plays at the same time and is not ducked', b > 0.02 && Math.abs(b / bFree - 1) < 0.08 && amp(880, 4.0, 4.9) < b * 0.02 && amp(880, 8.3, 8.9) < b * 0.02, `880 Hz ${b.toFixed(3)} under speech, ${bFree.toFixed(3)} after · none before 5 s or after 8.2 s`);
  const fall = [7.2, 7.5, 7.8].map((t) => amp(440, t - 0.1, t + 0.1) / plateau);
  check('the fade-out ramps down and the clip ends on time', fall[0] > fall[1] && fall[1] > fall[2] && Math.abs(fall[1] - 0.25) < 0.08 && amp(440, 8.1, 8.9) < plateau * 0.01, fall.map((v) => v.toFixed(3)).join(' → '));
  check('the level ratio between the two clips is the one that was set', Math.abs(bFree / plateau - 0.6) < 0.06, `${(bFree / plateau).toFixed(3)} (0.3 / 0.5)`);

  // sound effects
  const pop = onset(0.2, 1.8, 0.02);
  check('a sound effect lands on its moment', pop !== null && Math.abs(pop - 1.0) < 0.012 && rms(0.2, 0.95) < 0.002, `pop first heard at ${pop?.toFixed(4)} s`);
  const click = onset(8.4, 9.4, 0.02);
  check('a sound after the cut moves with its footage', click !== null && Math.abs(click - 9.0) < 0.012, `session 10 s → heard at ${click?.toFixed(4)} s`);
  const dingRef = amp(1174.66, 9.5, 9.9);
  check('a text plays its sound as it appears', dingRef > 0.02 && amp(1174.66, 9.05, 9.45) < dingRef * 0.05, `1175 Hz ${dingRef.toFixed(3)} from 9.5 s`);
  check('a sound whose moment was cut is dropped', amp(1174.66, 2.9, 3.6) < dingRef * 0.03, `1175 Hz around the cut: ${amp(1174.66, 2.9, 3.6).toExponential(1)}`);
  const blip = amp(2000, 10.2, 10.45);
  check('the creator’s own sound file plays at its moment and stops', blip > 0.05 && amp(2000, 9.8, 10.15) < blip * 0.05 && amp(2000, 10.6, 10.95) < blip * 0.05, `2 kHz ${blip.toFixed(3)} in 10.2–10.45 s`);

  // the old single-track field still plays, as one clip from the start
  await state(({ ids }) => {
    const st = window.__cutaway.useApp.getState();
    st.edit((e) => { const { music: _m, ...rest } = e; return { ...rest, sounds: [], overlays: [], audio: { ...e.audio, music: { sourceId: ids['tone-880.wav'], gain: 0.4, duck: false } } }; }, 'old project');
  }, { ids });
  check('a project saved with the old single music track shows it as one clip', (await music()).length === 1 && (await music())[0].start === 0 && (await page.locator('.lane-music .tl-item.music').count()) === 1, JSON.stringify((await music())[0]));

  await seekTo(0);
  await shot('06-end');
  exitCode = results.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log('ERROR', e.stack ?? e.message);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(media, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(failed || exitCode ? `\n${failed} check(s) failed${exitCode && !failed ? ' (the run stopped early)' : ''}` : `\nall ${results.length} checks passed`);
console.log(`screenshots → ${out}`);
process.exit(exitCode);
