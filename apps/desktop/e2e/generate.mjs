// Media generation against a local fake ElevenLabs and fal.ai, so nothing is spent: keys entered in
// Settings and checked, a key that is refused, then voiceover, music and a sound effect onto the audio row,
// an image as a clip on the video row and a video over the footage, each with the request it sent checked.
//   node e2e/generate.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const FF = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-generate'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const ff = (...a) => execFileSync(FF, ['-y', '-loglevel', 'error', ...a]);
const video = path.join(out, 'screen.mp4');
ff('-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=30:d=12', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video);
// what the fake services hand back
const files = {
  'speech.mp3': (f) => ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', '-c:a', 'libmp3lame', f),
  'music.mp3': (f) => ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', '-c:a', 'libmp3lame', f),
  'sound.mp3': (f) => ff('-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-c:a', 'libmp3lame', f),
  'music.wav': (f) => ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', f),
  'image.png': (f) => ff('-f', 'lavfi', '-i', 'color=c=0xdc1edc:s=640x360', '-frames:v', '1', f),
  'clip.mp4': (f) => ff('-f', 'lavfi', '-i', 'color=c=0x1e1edc:s=640x360:r=24:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f),
};
const blobs = {};
for (const [n, make] of Object.entries(files)) {
  const f = path.join(out, n);
  make(f);
  blobs[n] = fs.readFileSync(f);
}

// ── the fake ElevenLabs and fal.ai ──
const GOOD = { eleven: 'e2e-eleven-key-0000000000', fal: 'e2e-fal-key-00000000000000' };
const seen = [];
let base = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const json = (code, o) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    const send = (name, type) => (res.writeHead(200, { 'content-type': type }), res.end(blobs[name]));
    if (url.pathname.startsWith('/files/')) return send(url.pathname.slice(7), url.pathname.endsWith('.png') ? 'image/png' : url.pathname.endsWith('.mp4') ? 'video/mp4' : url.pathname.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
    if (url.pathname.startsWith('/eleven/')) {
      if (req.headers['xi-api-key'] !== GOOD.eleven) return json(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      const p = url.pathname.slice(7);
      seen.push({ who: 'eleven', path: p, body: body ? JSON.parse(body) : null });
      if (p === '/v1/voices') return json(200, { voices: [{ voice_id: 'voice-a', name: 'Avery', labels: { gender: 'female', accent: 'american' } }, { voice_id: 'voice-b', name: 'Blake', labels: {} }] });
      if (p.startsWith('/v1/text-to-speech/')) return send('speech.mp3', 'audio/mpeg');
      if (p === '/v1/sound-generation') return send('sound.mp3', 'audio/mpeg');
      if (p === '/v1/music') return send('music.mp3', 'audio/mpeg');
      return json(404, { detail: 'not found' });
    }
    if (url.pathname.startsWith('/fal/')) {
      if (req.headers.authorization !== `Key ${GOOD.fal}`) return json(401, { detail: 'Unauthorized' });
      const p = url.pathname.slice(4);
      const m = p.match(/^\/(.+)\/requests\/([^/]+)(\/status)?$/);
      if (m) {
        if (m[2] === '00000000-0000-0000-0000-000000000000') return json(404, { detail: 'Request not found' });
        const job = seen.find((s) => s.id === m[2]);
        if (m[3]) return json(200, { status: 'COMPLETED' });
        const out = /image|flux/.test(job.path) ? { images: [{ url: `${base}/files/image.png`, width: 640, height: 360, content_type: 'image/png' }] } : /video|pixverse/.test(job.path) ? { video: { url: `${base}/files/clip.mp4` } } : /stable-audio/.test(job.path) ? { audio: { url: `${base}/files/music.wav` } } : { audio: { url: `${base}/files/${/sound/.test(job.path) ? 'sound' : 'speech'}.mp3` } };
        return json(200, out);
      }
      const id = `req-${seen.length}`;
      const app = p.split('/').slice(1, 3).join('/');
      seen.push({ who: 'fal', id, path: p, body: JSON.parse(body) });
      return json(200, { request_id: id, status_url: `${base}/fal/${app}/requests/${id}/status`, response_url: `${base}/fal/${app}/requests/${id}` });
    }
    json(404, {});
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;
process.env.CUTAWAY_TEST_ELEVEN_URL = `${base}/eleven`;
process.env.CUTAWAY_TEST_FAL_URL = `${base}/fal`;

let failed = 0;
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failed++;
};
const { app, page } = await launch();
const state = (fn, a) => page.evaluate(fn, a);
const music = () => state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return core.musicClipsOf(p.edit, p.sources).map((c) => { const s = p.sources.find((x) => x.id === c.sourceId); return { name: s?.name, path: s?.path, note: s?.note, start: +c.start.toFixed(2), length: +c.length.toFixed(2), gain: c.gain, duck: c.duck }; }); });
const last = (who) => [...seen].reverse().find((s) => s.who === who && !/voices|status|requests/.test(s.path));
/** Open a generation from a + menu, fill it and generate. */
const generate = async (row, item, prompt, provider) => {
  await page.click(`[data-testid="${row}"]`);
  await page.click(`[data-testid="${item}"]`);
  await page.waitForSelector('[data-testid="generate-sheet"]');
  if (provider) await page.locator('[data-testid="generate-sheet"] .seg button, [data-testid="generate-sheet"] [role="radio"]', { hasText: provider }).first().click();
  await page.fill('[data-testid="gen-prompt"]', prompt);
  await page.waitForTimeout(300);
  await page.click('[data-testid="gen-go"]');
  await page.waitForSelector('[data-testid="gen-result"]', { timeout: 20000 });
};
try {
  // ── keys in Settings ──
  await state(() => window.__cutaway.useApp.getState().go('settings'));
  await page.getByRole('button', { name: 'AI generation' }).click();
  await page.fill('input[aria-label="ElevenLabs API key"]', 'not-the-right-key-1234567');
  await page.locator('[data-testid="gen-key-elevenlabs"] button', { hasText: 'Save' }).click();
  await page.waitForTimeout(500);
  const bad = await page.locator('[data-testid="gen-key-elevenlabs"]').textContent();
  check('a key ElevenLabs refuses is reported as such', /did not accept the API key/.test(bad), bad.slice(-120));
  await page.fill('input[aria-label="ElevenLabs API key"]', GOOD.eleven);
  await page.locator('[data-testid="gen-key-elevenlabs"] button', { hasText: 'Save' }).click();
  await page.waitForTimeout(500);
  const good = await page.locator('[data-testid="gen-key-elevenlabs"]').textContent();
  check('a good ElevenLabs key is saved, tested and shown only by its last four characters', /Connected\. 2 voices/.test(good) && (await page.getAttribute('input[aria-label="ElevenLabs API key"]', 'placeholder')) === 'Saved (…0000)', good.slice(-80));
  await page.fill('input[aria-label="fal.ai API key"]', GOOD.fal);
  await page.locator('[data-testid="gen-key-fal"] button', { hasText: 'Save' }).click();
  await page.waitForTimeout(500);
  check('a good fal.ai key is saved and tested without a paid request', /Connected/.test(await page.locator('[data-testid="gen-key-fal"]').textContent()));
  check('the window never gets the keys back', !JSON.stringify(await state(() => window.cutaway.gen.status())).includes('e2e-'));
  const stored = fs.readFileSync(path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'generation.json'), 'utf8');
  check('keys are stored encrypted, not as text', !stored.includes(GOOD.eleven) && !stored.includes(GOOD.fal));
  await page.screenshot({ path: path.join(out, '1-settings.png') });

  // ── the editor ──
  await state((f) => window.__cutaway.actions.importIntoNewProject([f]), video);
  await state(() => { const st = window.__cutaway.useApp.getState(); st.go('project'); st.setView('edit'); });
  await page.waitForSelector('.lane-video');
  await page.waitForTimeout(600);

  await state(() => window.__cutaway.usePlayback.getState().seek(1));
  await generate('audio-add', 'gen-voice', 'Welcome to the demo.');
  check('AI voiceover lists the account’s ElevenLabs voices', (await page.locator('[data-testid="gen-voice"] option').allTextContents()).join('|').includes('Avery'));
  let req = last('eleven');
  check('it asks ElevenLabs to speak the script with the chosen voice', req.path === '/v1/text-to-speech/voice-a' && req.body.text === 'Welcome to the demo.' && req.body.model_id === 'eleven_multilingual_v2', JSON.stringify(req));
  await page.screenshot({ path: path.join(out, '2-voice.png') });
  await page.click('[data-testid="gen-add"]');
  await page.waitForTimeout(600);
  let m = await music();
  check('the voiceover goes on the audio row at the playhead, at full level', m.length === 1 && m[0].start === 1 && m[0].gain === 1 && m[0].duck === false && /^media\/generated\/voice-/.test(m[0].path) && /ElevenLabs/.test(m[0].note), JSON.stringify(m));

  await state(() => window.__cutaway.usePlayback.getState().seek(0));
  await generate('audio-add', 'gen-music', 'calm piano', 'fal.ai');
  req = last('fal');
  check('music from fal.ai uses the default model with the chosen length', req.path === '/fal-ai/stable-audio-25/text-to-audio' && req.body.prompt === 'calm piano' && req.body.seconds_total === 20, JSON.stringify(req));
  await page.click('[data-testid="gen-add"]');
  await page.waitForTimeout(600);
  m = await music();
  check('music goes under the voice: quieter, and lowered while someone speaks', m.length === 2 && m.some((c) => /^Music/.test(c.name) && c.gain === 0.25 && c.duck === true), JSON.stringify(m));

  await state(() => window.__cutaway.usePlayback.getState().seek(6));
  await generate('audio-add', 'gen-sound', 'a soft whoosh', 'ElevenLabs');
  req = last('eleven');
  check('a sound effect from ElevenLabs is asked for at its length', req.path === '/v1/sound-generation' && req.body.text === 'a soft whoosh' && req.body.duration_seconds === 3, JSON.stringify(req));
  await page.click('[data-testid="gen-add"]');
  await page.waitForTimeout(600);
  check('and lands on the audio row at 6 s', (await music()).some((c) => /^Sound/.test(c.name) && c.start === 6));

  await generate('video-add', 'gen-image-clip', 'a sunny beach');
  req = last('fal');
  check('an image from fal.ai (FLUX schnell, wide)', req.path === '/fal-ai/flux/schnell' && req.body.image_size === 'landscape_16_9', JSON.stringify(req));
  await page.screenshot({ path: path.join(out, '3-image.png') });
  await page.click('[data-testid="gen-add"]');
  await page.waitForTimeout(800);
  const clips = await state(() => { const { useApp, core } = window.__cutaway; const p = useApp.getState().project; return core.playingClips(core.clipsOf(p)).map((c) => ({ name: c.name, photo: core.isPhotoClip(p, c), len: +(c.out - c.in).toFixed(2) })); });
  check('a generated image added from the video row becomes a photo clip', clips.length === 2 && clips[1].photo && clips[1].len === 5, JSON.stringify(clips));

  await state(() => window.__cutaway.usePlayback.getState().seek(2));
  await generate('fx-add', 'gen-video-over', 'drone over hills');
  req = last('fal');
  check('a video from fal.ai at the cheap settings (360p, 5 s)', req.path === '/fal-ai/pixverse/v5.6/text-to-video' && req.body.resolution === '360p' && req.body.duration === 5 && req.body.aspect_ratio === '16:9', JSON.stringify(req));
  await page.click('[data-testid="gen-add"]');
  await page.waitForTimeout(800);
  const broll = await state(() => window.__cutaway.useApp.getState().project.edit.broll.map((b) => ({ start: +b.start.toFixed(2), end: +b.end.toFixed(2) })));
  check('a generated video added from the text & effects row goes over the footage at the playhead', broll.length === 1 && broll[0].start === 2 && broll[0].end > 6, JSON.stringify(broll));
  await page.screenshot({ path: path.join(out, '4-timeline.png') });

  // a result that is not added leaves no file behind
  const dir = path.join(await state(() => window.__cutaway.useApp.getState().projectPath), 'media', 'generated');
  const before = fs.readdirSync(dir).length;
  await generate('audio-add', 'gen-sound', 'a click', 'ElevenLabs');
  check('a generated file exists while it is being looked at', fs.readdirSync(dir).length === before + 1);
  await page.locator('[data-testid="generate-sheet"]').locator('xpath=ancestor::*[contains(@class,"modal")]').getByRole('button', { name: 'Cancel' }).click().catch(async () => page.getByRole('button', { name: 'Cancel' }).last().click());
  await page.waitForTimeout(500);
  check('and is deleted when the sheet is closed without adding it', fs.readdirSync(dir).length === before, `${fs.readdirSync(dir).length} vs ${before}`);
} finally {
  await app.close();
  server.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all generate checks passed');
process.exit(failed ? 1 : 0);
