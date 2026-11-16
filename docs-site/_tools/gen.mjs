// Small ElevenLabs + fal.ai helpers for the docs media. Keys are read from ~/.cutaway-test/
// (elevenlabs.key, fal.key) or from ELEVENLABS_API_KEY / FAL_KEY. Nothing here prints a key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const read = (n) => { try { return fs.readFileSync(path.join(os.homedir(), '.cutaway-test', n), 'utf8').trim(); } catch { return ''; } };
export const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || read('elevenlabs.key');
export const FAL_KEY = process.env.FAL_KEY || read('fal.key');

/** Voices used in the docs: the made-up creator in the demo footage, and the tutorial narrator. */
export const VOICES = { creator: 'cgSgspJ2msm6clMCkdW9' /* Jessica */, narrator: 'EXAVITQu4vr4xnSDxMaL' /* Sarah */ };

/** Text to speech with ElevenLabs (directly, or through fal.ai's ElevenLabs models when only a fal key is set); writes an mp3. */
export async function speak(text, file, voice = VOICES.creator, { stability = 0.45, style = 0.25 } = {}) {
  if (fs.existsSync(file)) return file; // generated media is cached: re-runs cost nothing
  const viaFal = async () => download((await fal('fal-ai/elevenlabs/tts/multilingual-v2', { text, voice, stability, similarity_boost: 0.8, style }, { log: () => {} })).audio.url, file);
  if (!ELEVEN_KEY || process.env.DOCS_TTS === 'fal') return viaFal();
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability, similarity_boost: 0.8, style, use_speaker_boost: true } }),
  });
  if ((r.status === 401 || r.status === 403) && FAL_KEY) return viaFal(); // an expired ElevenLabs key: same voice through fal.ai
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

/** Music with ElevenLabs. */
export async function music(prompt, seconds, file) {
  if (fs.existsSync(file)) return file;
  const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, music_length_ms: Math.round(seconds * 1000), force_instrumental: true }),
  });
  if (!r.ok) throw new Error(`ElevenLabs music ${r.status}: ${(await r.text()).slice(0, 300)}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

const dataUri = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
export const fileUri = (file) => dataUri(file, /\.png$/.test(file) ? 'image/png' : /\.jpe?g$/.test(file) ? 'image/jpeg' : /\.mp3$/.test(file) ? 'audio/mpeg' : /\.wav$/.test(file) ? 'audio/wav' : 'application/octet-stream');

/** Run a fal.ai model through its queue and return the result JSON. */
export async function fal(model, input, { log = console.log } = {}) {
  const h = { authorization: `Key ${FAL_KEY}`, 'content-type': 'application/json' };
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: h, body: JSON.stringify(input) });
  if (!sub.ok) throw new Error(`fal submit ${sub.status}: ${(await sub.text()).slice(0, 400)}`);
  const { status_url, response_url, request_id } = await sub.json();
  log(`fal ${model} queued ${request_id}`);
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, i < 3 ? 3000 : 8000));
    const s = await (await fetch(status_url, { headers: h })).json();
    if (s.status === 'COMPLETED') break;
    if (s.status && !/IN_QUEUE|IN_PROGRESS/.test(s.status)) throw new Error(`fal ${model} ${JSON.stringify(s).slice(0, 300)}`);
  }
  const res = await fetch(response_url, { headers: h });
  const j = await res.json();
  if (!res.ok) throw new Error(`fal result ${res.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

export async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
