// Makes the friendly demo footage used for the docs screenshots:
//   demo/screen.mp4  – a 1920x1080 "screen recording" of a made-up list app (Listful), with narration
//   demo/camera.mp4  – a 1280x720 "camera": a realistic talking presenter, same narration (so sync works)
//   demo/music.mp3   – background music for the music docs and tutorial
//   demo/camera-b.mp4        – a second camera angle (a close-up of the same take), for the two-camera docs
//   demo/screen-browser.mp4  – the screen recording inside a made-up browser's tabs and address bar (1920x1200)
// Narration and music come from ElevenLabs; the presenter photo from fal (Flux) and her lip-synced
// talking video from fal (Kling AI Avatar). Everything generated is cached in _tools/cache, so re-runs are free.
// The screen recording frames are rendered deterministically in Chrome.
// Usage: node docs-site/_tools/make-footage.mjs <outDir>
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { speak, music, fal, download, fileUri } from './gen.mjs';

const out = path.resolve(process.argv[2] ?? 'demo');
fs.mkdirSync(path.join(out, 'parts'), { recursive: true });
const FPS = 30;
const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

// [text, pause after (s)]
const LINES = [
  ["Hi! Today I'll show you how to make a shared shopping list in Listful.", 1.0],
  ['First, click New list.', 1.2],
  ['Um.', 1.0],
  ["Let's call it, let's call it Weekend groceries.", 3.2],
  ['Now type each item and press Enter.', 0.6],
  ['Eggs. Milk. And some strawberries.', 1.4],
  ['To share it, click the Share button at the top, and pick a friend.', 1.6],
  ["And that's it. Your list is ready to use.", 1.5],
];
const here = path.dirname(new URL(import.meta.url).pathname);
const cache = path.join(here, 'cache');
fs.mkdirSync(cache, { recursive: true });
let t = 1.0;
const timing = [];
for (const [i, [text, gap]] of LINES.entries()) {
  const f = path.join(cache, `line-${i}-${text.replace(/[^a-z]+/gi, '-').slice(0, 40)}.mp3`);
  await speak(text, f);
  const d = Number(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`));
  timing.push({ i, text, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
  timing[timing.length - 1].file = f;
  t += d + gap;
}
const TOTAL = +(t + 0.5).toFixed(2);
fs.writeFileSync(path.join(out, 'timing.json'), JSON.stringify({ total: TOTAL, lines: timing.map(({ file, ...l }) => l) }, null, 2));

// mix the lines at their start times
const inputs = timing.map((l) => `-i "${l.file}"`).join(' ');
const delays = timing.map((l, k) => `[${k}:a]aresample=48000,adelay=${Math.round(l.start * 1000)}:all=1[a${k}]`).join(';');
const mix = timing.map((_, k) => `[a${k}]`).join('') + `amix=inputs=${timing.length}:normalize=0,apad,atrim=0:${TOTAL}[out]`;
execSync(`ffmpeg -hide_banner -loglevel error -y ${inputs} -filter_complex "${delays};${mix}" -map "[out]" -ac 1 -ar 48000 "${path.join(out, 'narration.wav')}"`);

const browser = await chromium.launch({ channel: 'chrome' });
async function render(file, w, h, name) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(path.dirname(new URL(import.meta.url).pathname), file));
  await page.evaluate((tm) => window.setup(tm), { total: TOTAL, lines: timing });
  const dir = path.join(out, 'frames-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const n = Math.ceil(TOTAL * FPS);
  for (let f = 0; f < n; f++) {
    await page.evaluate((x) => window.render(x), f / FPS);
    await page.screenshot({ path: path.join(dir, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  await page.close();
  return dir;
}
const sDir = await render('screen.html', 1920, 1080, 'screen');
execSync(`ffmpeg -hide_banner -loglevel error -y -framerate ${FPS} -i "${sDir}/%05d.jpg" -i "${out}/narration.wav" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -shortest "${out}/screen.mp4"`);
// camera: a realistic presenter photo, animated to speak the narration
const photo = path.join(cache, 'presenter.jpg');
if (!fs.existsSync(photo)) {
  const r = await fal('fal-ai/flux/dev', { prompt: 'Candid webcam-style photo of a friendly Black woman in her early thirties with natural curly hair, smiling and talking to the camera, sitting at a desk in a bright cozy home office, bookshelf and a plant softly blurred behind her, warm natural window light, shoulders and head centered, realistic skin texture, 16:9', image_size: 'landscape_16_9', num_inference_steps: 28, num_images: 1 });
  await download(r.images[0].url, photo);
}
const narrationMp3 = path.join(out, 'narration.mp3');
execSync(`ffmpeg -hide_banner -loglevel error -y -i "${out}/narration.wav" -b:a 128k "${narrationMp3}"`);
const key = (await import('node:crypto')).createHash('sha1').update(fs.readFileSync(narrationMp3)).digest('hex').slice(0, 10);
const talking = path.join(cache, `presenter-talking-${key}.mp4`);
if (!fs.existsSync(talking)) {
  const r = await fal('fal-ai/kling-video/ai-avatar/v2/standard', { image_url: fileUri(photo), audio_url: fileUri(narrationMp3), prompt: 'A friendly creator talking naturally to her webcam, relaxed, small natural head movements, warm smile between sentences.' });
  await download(r.video.url, talking);
}
execSync(`ffmpeg -hide_banner -loglevel error -y -i "${talking}" -i "${out}/narration.wav" -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30,tpad=stop_mode=clone:stop_duration=5[v];[1:a]volume=0.6[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k -t ${TOTAL} "${out}/camera.mp4"`);
// a second camera angle for the two-camera docs: a warmer close-up of the same take, so it is in sync
execSync(`ffmpeg -hide_banner -loglevel error -y -i "${out}/camera.mp4" -vf "crop=880:495:180:80,hflip,scale=1280:720:flags=lanczos,eq=saturation=1.12:brightness=0.02,colorbalance=rs=0.05:bs=-0.05" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k "${out}/camera-b.mp4"`);
// the same screen recorded in a browser window, tabs and address bar included (for "Hide browser bar"), 1920x1200
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 120 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(here, 'browser.html'));
  await page.screenshot({ path: path.join(out, 'parts', 'browser-bar.png') });
  await page.close();
  execSync(`ffmpeg -hide_banner -loglevel error -y -i "${out}/screen.mp4" -i "${path.join(out, 'parts', 'browser-bar.png')}" -filter_complex "[0:v]pad=1920:1200:0:120:color=white[p];[p][1:v]overlay=0:0" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a copy "${out}/screen-browser.mp4"`);
}
// background music
await music('Light, warm, upbeat acoustic background music for a friendly how-to video. Soft guitar and gentle percussion, no vocals.', 45, path.join(cache, 'music.mp3'));
fs.copyFileSync(path.join(cache, 'music.mp3'), path.join(out, 'music.mp3'));
fs.rmSync(sDir, { recursive: true });
await browser.close();
console.log('footage ready', out, TOTAL + 's');
