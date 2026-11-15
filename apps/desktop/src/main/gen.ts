/**
 * Media generation with the creator's own ElevenLabs or fal.ai account: voiceover, music, sound effects,
 * images and video. Everything happens here in the main process: API keys are kept in the macOS keychain
 * (Electron safeStorage) and never reach the editor window, which only learns whether a key is set.
 * Generated files are written into the project's media/generated folder.
 */
import { app, safeStorage } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GenKind, GenProvider, GenRequest, GenResult, GenKeyStatus, GenVoice, GenModels } from '../shared/api';

// end-to-end tests point these at a local fake server, so the whole flow is checked without spending credits
const ELEVEN = (process.env.CUTAWAY_E2E && process.env.CUTAWAY_TEST_ELEVEN_URL) || 'https://api.elevenlabs.io';
const FAL_QUEUE = (process.env.CUTAWAY_E2E && process.env.CUTAWAY_TEST_FAL_URL) || 'https://queue.fal.run';

/** The fal.ai model used for each kind unless the creator picked another in Settings. */
export const DEFAULT_FAL_MODELS: GenModels = {
  voice: 'fal-ai/elevenlabs/tts/multilingual-v2',
  music: 'fal-ai/stable-audio-25/text-to-audio',
  sound: 'fal-ai/elevenlabs/sound-effects/v2',
  image: 'fal-ai/flux/schnell',
  video: 'fal-ai/pixverse/v5.6/text-to-video',
};
/** What each provider can make. ElevenLabs makes sound only. */
export const CAN: Record<GenProvider, GenKind[]> = { elevenlabs: ['voice', 'music', 'sound'], fal: ['voice', 'music', 'sound', 'image', 'video'] };
/** Voices offered for fal's ElevenLabs speech model (it takes a voice name). */
const FAL_VOICES = ['Rachel', 'Aria', 'Roger', 'Sarah', 'Laura', 'Charlie', 'George', 'Callum', 'River', 'Liam', 'Charlotte', 'Alice', 'Matilda', 'Will', 'Jessica', 'Eric', 'Chris', 'Brian', 'Daniel', 'Lily', 'Bill'];

export class GenError extends Error {
  constructor(
    message: string,
    readonly code: 'no-key' | 'bad-key' | 'no-credits' | 'rejected' | 'failed' | 'timeout' | 'unsupported',
  ) {
    super(message);
  }
}

// ───────────────────────────── keys ─────────────────────────────

let keyFile = '';
let models: GenModels = { ...DEFAULT_FAL_MODELS };
const keys: Partial<Record<GenProvider, string>> = {};

/** Load the stored keys (decrypted with the keychain) and model choices. Call once the app is ready. */
export async function initGen(userData: string) {
  keyFile = path.join(userData, 'generation.json');
  try {
    const raw = JSON.parse(await fsp.readFile(keyFile, 'utf8')) as { keys?: Partial<Record<GenProvider, string>>; models?: Partial<GenModels> };
    for (const p of ['elevenlabs', 'fal'] as GenProvider[]) {
      const enc = raw.keys?.[p];
      if (enc && safeStorage.isEncryptionAvailable()) keys[p] = safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
    models = { ...DEFAULT_FAL_MODELS, ...(raw.models ?? {}) };
  } catch {
    /* nothing stored yet */
  }
  // test runs may hand a key in through the environment; it is never written to disk
  if (process.env.CUTAWAY_TEST_ELEVENLABS_KEY) keys.elevenlabs = process.env.CUTAWAY_TEST_ELEVENLABS_KEY;
  if (process.env.CUTAWAY_TEST_FAL_KEY) keys.fal = process.env.CUTAWAY_TEST_FAL_KEY;
}

async function persist() {
  if (!keyFile) return;
  const enc: Partial<Record<GenProvider, string>> = {};
  for (const p of ['elevenlabs', 'fal'] as GenProvider[]) {
    const k = keys[p];
    if (!k) continue;
    if (!safeStorage.isEncryptionAvailable()) throw new GenError('This Mac’s keychain is not available, so the key cannot be stored safely.', 'failed');
    enc[p] = safeStorage.encryptString(k).toString('base64');
  }
  await fsp.writeFile(keyFile, JSON.stringify({ keys: enc, models }, null, 2), { mode: 0o600 });
}

export function keyStatus(): GenKeyStatus {
  const show = (k?: string) => (k ? { set: true, hint: `…${k.slice(-4)}` } : { set: false, hint: null });
  return { elevenlabs: show(keys.elevenlabs), fal: show(keys.fal), models, defaults: DEFAULT_FAL_MODELS, can: CAN };
}

export async function setKey(provider: GenProvider, key: string | null): Promise<GenKeyStatus> {
  const clean = key?.trim() ?? '';
  if (clean && (clean.length < 16 || clean.length > 300 || /\s/.test(clean))) throw new GenError('That does not look like an API key. Copy the whole key and paste it again.', 'bad-key');
  if (clean) keys[provider] = clean;
  else delete keys[provider];
  await persist();
  return keyStatus();
}

export async function setModels(patch: Partial<GenModels>): Promise<GenKeyStatus> {
  for (const [k, v] of Object.entries(patch) as [GenKind, string | undefined][]) {
    const id = (v ?? '').trim();
    models[k] = id && /^[\w.-]+(\/[\w.-]+)+$/.test(id) ? id : DEFAULT_FAL_MODELS[k];
  }
  await persist();
  return keyStatus();
}

const need = (provider: GenProvider): string => {
  const k = keys[provider];
  if (!k) throw new GenError(`Add your ${provider === 'fal' ? 'fal.ai' : 'ElevenLabs'} API key in Settings › AI generation first.`, 'no-key');
  return k;
};

/** Why a request failed, in words the creator can act on. */
async function failure(provider: GenProvider, res: Response): Promise<GenError> {
  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    const j = JSON.parse(body) as { detail?: unknown; message?: string; error?: string };
    const d = j.detail;
    detail = typeof d === 'string' ? d : d && typeof d === 'object' && 'message' in d ? String((d as { message: unknown }).message) : Array.isArray(d) ? d.map((x) => (x as { msg?: string }).msg ?? '').join('; ') : (j.message ?? j.error ?? detail);
  } catch {
    /* not JSON */
  }
  const name = provider === 'fal' ? 'fal.ai' : 'ElevenLabs';
  // Checked first: an account that has run out answers 403 too ("User is locked. Reason: Exhausted balance").
  if (res.status === 402 || /quota|credit|balance|insufficient/i.test(detail)) return new GenError(`Your ${name} account is out of credits: ${detail}`, 'no-credits');
  if (res.status === 401 || res.status === 403) {
    if (/permission|scope/i.test(detail)) return new GenError(`Your ${name} key is not allowed to do this: ${detail}`, 'bad-key');
    return new GenError(`${name} did not accept the API key. Check it in Settings › AI generation.`, 'bad-key');
  }
  if (res.status === 422 || res.status === 400) return new GenError(`${name} refused the request: ${detail}`, 'rejected');
  return new GenError(`${name} could not make it (${res.status}): ${detail}`, 'failed');
}

/** Checks that a key works, without spending credits. */
export async function testKey(provider: GenProvider): Promise<{ ok: boolean; message: string }> {
  try {
    const key = need(provider);
    if (provider === 'elevenlabs') {
      const res = await fetch(`${ELEVEN}/v1/voices`, { headers: { 'xi-api-key': key } });
      if (!res.ok) throw await failure(provider, res);
      const j = (await res.json()) as { voices?: unknown[] };
      return { ok: true, message: `Connected. ${j.voices?.length ?? 0} voices available.` };
    }
    // the status of a request that does not exist: 404 for a good key, 401 for a bad one, and free
    const res = await fetch(`${FAL_QUEUE}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`, { headers: { Authorization: `Key ${key}` } });
    if (res.status === 401 || res.status === 403) throw await failure(provider, res);
    return { ok: true, message: 'Connected.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function listVoices(provider: GenProvider): Promise<GenVoice[]> {
  if (provider === 'fal') return FAL_VOICES.map((n) => ({ id: n, name: n, description: null, previewUrl: null }));
  const res = await fetch(`${ELEVEN}/v1/voices`, { headers: { 'xi-api-key': need(provider) } });
  if (!res.ok) throw await failure(provider, res);
  const j = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string>; preview_url?: string }[] };
  return j.voices.map((v) => ({ id: v.voice_id, name: v.name, description: [v.labels?.gender, v.labels?.accent, v.labels?.use_case ?? v.labels?.description].filter(Boolean).join(' · ') || null, previewUrl: v.preview_url ?? null }));
}

// ───────────────────────────── generating ─────────────────────────────

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const running = new Map<string, AbortController>();

/** Delete a generated file that was not added to the project. Only files in media/generated can be removed. */
export async function discard(projectPath: string, relPath: string): Promise<void> {
  const dir = path.resolve(projectPath, 'media', 'generated');
  const file = path.resolve(projectPath, relPath);
  if (path.dirname(file) !== dir || !/^(voice|music|sound|image|video)-[a-z0-9]+\.[a-z0-9]+$/.test(path.basename(file))) throw new GenError('Only generated files can be discarded.', 'rejected');
  await fsp.rm(file, { force: true });
}

export function cancel(jobId: string) {
  running.get(jobId)?.abort();
}

/** Make one piece of media and save it in the project. */
/** Reference pictures as data URLs. Only files inside the project or Cutaway's own folder are read. */
async function referenceImages(projectPath: string, paths: string[] | undefined): Promise<string[]> {
  const roots = [path.resolve(projectPath), path.resolve(app.getPath('userData'))];
  const out: string[] = [];
  for (const p of (paths ?? []).slice(0, 4)) {
    const abs = path.resolve(p);
    if (!path.isAbsolute(p) || !roots.some((r) => abs.startsWith(r + path.sep))) throw new GenError('A reference picture must be inside the project or Cutaway\'s own folder.', 'rejected');
    const type = /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg';
    out.push(`data:${type};base64,${(await fsp.readFile(abs)).toString('base64')}`);
  }
  return out;
}

export async function generate(projectPath: string, req: GenRequest, onStatus: (s: string) => void): Promise<GenResult> {
  if (!CAN[req.provider].includes(req.kind)) throw new GenError(`${req.provider === 'fal' ? 'fal.ai' : 'ElevenLabs'} cannot make ${req.kind}.`, 'unsupported');
  const prompt = req.prompt.trim();
  if (!prompt) throw new GenError(req.kind === 'voice' ? 'Write what the voice should say.' : 'Describe what to make.', 'rejected');
  const ctrl = new AbortController();
  running.set(req.jobId, ctrl);
  const signal = ctrl.signal;
  try {
    let bytes: Buffer;
    let ext: string;
    let model: string;
    if (req.provider === 'elevenlabs') {
      ({ bytes, ext, model } = await eleven(req, prompt, signal));
    } else {
      ({ bytes, ext, model } = await fal(req, prompt, signal, onStatus, await referenceImages(projectPath, req.referencePaths)));
    }
    const dir = path.join(projectPath, 'media', 'generated');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${req.kind}-${Date.now().toString(36)}.${ext}`);
    await fsp.writeFile(file, bytes);
    return { path: path.relative(projectPath, file), provider: req.provider, model };
  } catch (e) {
    if (signal.aborted) throw new GenError('Stopped.', 'failed');
    if (e instanceof GenError) throw e;
    throw new GenError(`Could not reach ${req.provider === 'fal' ? 'fal.ai' : 'ElevenLabs'}: ${e instanceof Error ? e.message : String(e)}`, 'failed');
  } finally {
    running.delete(req.jobId);
  }
}

async function eleven(req: GenRequest, prompt: string, signal: AbortSignal): Promise<{ bytes: Buffer; ext: string; model: string }> {
  const key = need('elevenlabs');
  const post = async (url: string, body: object) => {
    const res = await fetch(url, { method: 'POST', signal, headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(body) });
    if (!res.ok) throw await failure('elevenlabs', res);
    return Buffer.from(await res.arrayBuffer());
  };
  if (req.kind === 'voice') {
    if (!req.voiceId) throw new GenError('Pick a voice.', 'rejected');
    const model = 'eleven_multilingual_v2';
    return { bytes: await post(`${ELEVEN}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}?output_format=mp3_44100_128`, { text: prompt, model_id: model }), ext: 'mp3', model };
  }
  if (req.kind === 'sound') {
    const model = 'eleven_text_to_sound_v2';
    return { bytes: await post(`${ELEVEN}/v1/sound-generation?output_format=mp3_44100_128`, { text: prompt, model_id: model, ...(req.seconds ? { duration_seconds: clamp(req.seconds, 0.5, 30) } : {}) }), ext: 'mp3', model };
  }
  const model = 'music_v1';
  return { bytes: await post(`${ELEVEN}/v1/music?output_format=mp3_44100_128`, { prompt, model_id: model, music_length_ms: Math.round(clamp(req.seconds ?? 30, 3, 600) * 1000), force_instrumental: req.instrumental ?? true }), ext: 'mp3', model };
}

/** The input a fal model expects, for the default models (other models get the common fields). */
function falInput(req: GenRequest, prompt: string, refs: string[] = []): Record<string, unknown> {
  switch (req.kind) {
    case 'voice':
      return { text: prompt, voice: req.voiceId || 'Rachel' };
    case 'sound':
      return { text: prompt, prompt, ...(req.seconds ? { duration_seconds: clamp(req.seconds, 0.5, 22) } : {}) };
    case 'music':
      return { prompt, seconds_total: Math.round(clamp(req.seconds ?? 30, 1, 190)) };
    case 'image':
      if (refs.length) return { prompt, image_urls: refs, aspect_ratio: req.aspect ?? '16:9', resolution: '1K', num_images: 1, output_format: 'png' };
      // Google's image models take an aspect ratio rather than an image size.
      if (/nano-banana/.test(req.model ?? '')) return { prompt, aspect_ratio: req.aspect ?? '16:9', resolution: '1K', num_images: 1, output_format: 'png' };
      return { prompt, image_size: req.aspect === '9:16' ? 'portrait_16_9' : req.aspect === '1:1' ? 'square_hd' : 'landscape_16_9', num_images: 1 };
    case 'video':
      // the cheapest settings that still look right: 360p, 5 s
      return { prompt, aspect_ratio: req.aspect ?? '16:9', resolution: req.resolution ?? '360p', duration: req.seconds && req.seconds > 5 ? 8 : 5 };
  }
}

/** The file URL in a fal result: audio.url, video.url, images[0].url, or the first url found. */
function resultUrl(out: unknown): { url: string; contentType?: string } | null {
  const o = out as Record<string, unknown>;
  for (const k of ['audio', 'video', 'audio_file', 'image']) {
    const f = o?.[k] as { url?: string; content_type?: string } | undefined;
    if (f?.url) return { url: f.url, contentType: f.content_type };
  }
  const imgs = o?.images as { url?: string; content_type?: string }[] | undefined;
  if (imgs?.[0]?.url) return { url: imgs[0].url, contentType: imgs[0].content_type };
  return null;
}

/** fal.ai model for images made from reference pictures (it keeps a face from a photo, and draws legible words). */
export const FAL_REFERENCE_IMAGE_MODEL = 'fal-ai/nano-banana-pro/edit';

async function fal(req: GenRequest, prompt: string, signal: AbortSignal, onStatus: (s: string) => void, refs: string[] = []): Promise<{ bytes: Buffer; ext: string; model: string }> {
  const key = need('fal');
  const model = req.model?.trim() || (refs.length && req.kind === 'image' ? FAL_REFERENCE_IMAGE_MODEL : models[req.kind]);
  const auth = { Authorization: `Key ${key}` };
  const submit = await fetch(`${FAL_QUEUE}/${model}`, { method: 'POST', signal, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(falInput(req, prompt, refs)) });
  if (!submit.ok) throw await failure('fal', submit);
  const job = (await submit.json()) as { status_url: string; response_url: string; queue_position?: number };
  const deadline = Date.now() + (req.kind === 'video' ? 15 : 5) * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new GenError('fal.ai took too long. Try again, or a shorter or simpler request.', 'timeout');
    await new Promise((r) => setTimeout(r, req.kind === 'video' ? 2500 : 1000));
    if (signal.aborted) throw new Error('aborted');
    const st = await fetch(job.status_url, { signal, headers: auth });
    if (!st.ok) throw await failure('fal', st);
    const s = (await st.json()) as { status: string; queue_position?: number; error?: string };
    if (s.status === 'IN_QUEUE') onStatus(s.queue_position ? `Waiting in line (${s.queue_position} ahead)…` : 'Waiting in line…');
    else if (s.status === 'IN_PROGRESS') onStatus('Making it…');
    else if (s.status === 'COMPLETED') {
      if (s.error) throw new GenError(`fal.ai could not make it: ${s.error}`, 'failed');
      break;
    }
  }
  const res = await fetch(job.response_url, { signal, headers: auth });
  if (!res.ok) throw await failure('fal', res);
  const file = resultUrl(await res.json());
  if (!file) throw new GenError('fal.ai finished but returned no file.', 'failed');
  onStatus('Downloading…');
  const dl = await fetch(file.url, { signal });
  if (!dl.ok) throw new GenError(`The result could not be downloaded (${dl.status}).`, 'failed');
  const type = file.contentType ?? dl.headers.get('content-type') ?? '';
  const fromUrl = new URL(file.url).pathname.split('.').pop()?.toLowerCase() ?? '';
  const ext = /^(mp3|wav|m4a|mp4|mov|webm|png|jpg|jpeg|webp)$/.test(fromUrl) ? fromUrl : type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('mp4') ? 'mp4' : req.kind === 'video' ? 'mp4' : req.kind === 'image' ? 'jpg' : 'mp3';
  return { bytes: Buffer.from(await dl.arrayBuffer()), ext, model };
}
