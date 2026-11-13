import { app, BrowserWindow } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { findSensitive, type CorrelationResult, type CursorSample, type TextLine } from '@cutaway/core';
import type { SensitiveScan, FaceTrack, KeyEvent, VoiceInfo, AppSettings, DeviceList, PreflightResult, ProbeResult, RecordConfig, RecordEvent, TakeManifest, TranscribeResult, VoiceAnalysis } from '../shared/api';

export class NativeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function helperPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'cutaway-native');
  // dist/main/index.cjs → repo root is four levels up
  return path.resolve(__dirname, '../../../../native/.build/release/cutaway-native');
}

export function helperAvailable(): boolean {
  try {
    fs.accessSync(helperPath(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const ownBundleId = () => (app.isPackaged ? 'studio.cutaway.app' : 'com.github.Electron');

/** Run a one-shot helper command and parse its JSON result. */
export function runJson<T>(args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!helperAvailable()) return reject(new NativeError('helper-missing', 'The capture helper is not built. Run "pnpm native:build".'));
    const child = spawn(helperPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)));
    child.on('error', (e) => reject(new NativeError('helper-failed', e.message)));
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* handled below */
      }
      const e = (json as { error?: { code: string; message: string } } | null)?.error;
      if (code === 0 && json !== null && !e) return resolve(json as T);
      if (e) return reject(new NativeError(e.code, e.message));
      reject(new NativeError(signal === 'SIGKILL' ? 'timeout' : 'helper-failed', err.trim().split('\n').pop() || `Helper exited with code ${code}`));
    });
  });
}

/** Screen Recording state as a fresh process sees it (Electron's own answer is cached until relaunch). */
export const screenAccess = (request: boolean) => runJson<{ screen: 'granted' | 'undetermined'; asked: boolean }>(['request-screen', ...(request ? [] : ['--check'])], { timeoutMs: 12000 });

export const devices = () => runJson<DeviceList>(['devices'], { timeoutMs: 15000 });

export function probe(paths: string[]): Promise<ProbeResult[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return runJson<ProbeResult[]>(['probe', ...paths], { timeoutMs: 60000 });
}

export async function preflight(config: RecordConfig, outDir: string): Promise<PreflightResult> {
  const file = path.join(os.tmpdir(), `cutaway-preflight-${crypto.randomUUID()}.json`);
  await fsp.writeFile(file, JSON.stringify(fullConfig(config, outDir)));
  try {
    return await runJson<PreflightResult>(['preflight', '--config', file], { timeoutMs: 20000 });
  } finally {
    fsp.rm(file, { force: true }).catch(() => {});
  }
}

function fullConfig(config: RecordConfig, outDir: string) {
  return {
    ...config,
    outDir,
    screen: config.screen ? { ...config.screen, excludeBundleIds: [ownBundleId()] } : undefined,
    microphone: config.microphone ?? undefined,
    checkpointSeconds: 2,
    minFreeBytes: 2_000_000_000,
  };
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export async function frames(projectPath: string, file: string, times: number[], width: number): Promise<{ t: number; path: string }[]> {
  if (times.length === 0) return [];
  const dir = path.join(projectPath, 'cache', 'frames', `${hash(file)}-${width}`);
  await fsp.mkdir(dir, { recursive: true });
  const res = await runJson<{ t: number; path: string }[]>(['frames', file, '--times', times.map((t) => t.toFixed(3)).join(','), '--width', String(width), '--out-dir', dir], { timeoutMs: 180000 });
  return res.map((r) => ({ t: r.t, path: r.path }));
}

export const activity = (file: string) => runJson<{ fps: number; samples: { t: number; change: number }[] }>(['activity', file, '--fps', '4', '--width', '96'], { timeoutMs: 600000 });

async function pcm(file: string, rate: number): Promise<{ path: string; sampleRate: number; samples: number; duration: number }> {
  const out = path.join(os.tmpdir(), `cutaway-pcm-${crypto.randomUUID()}.f32`);
  return runJson(['pcm', file, '--out', out, '--rate', String(rate)], { timeoutMs: 600000 });
}

// ───────────────────────────── transcription ─────────────────────────────

function whisperCli(): string | null {
  for (const p of ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) if (fs.existsSync(p)) return p;
  return null;
}

export function findWhisperModel(settings: AppSettings): string | null {
  if (settings.transcription.whisperModelPath && fs.existsSync(settings.transcription.whisperModelPath)) return settings.transcription.whisperModelPath;
  const dir = path.join(app.getPath('userData'), 'models');
  try {
    const f = fs.readdirSync(dir).filter((n) => n.endsWith('.bin')).sort()[0];
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

async function f32ToWav(f32Path: string, sampleRate: number): Promise<string> {
  const raw = await fsp.readFile(f32Path);
  const n = Math.floor(raw.length / 4);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(raw.readFloatLE(i * 4) * 32767))), 44 + i * 2);
  const out = f32Path.replace(/\.f32$/, '.wav');
  await fsp.writeFile(out, wav);
  return out;
}

async function transcribeWhisper(file: string, locale: string, model: string): Promise<TranscribeResult> {
  const cli = whisperCli();
  if (!cli) throw new NativeError('speech-model-unavailable', 'whisper-cli is not installed.');
  const p = await pcm(file, 16000);
  const wav = await f32ToWav(p.path, 16000);
  const base = wav.replace(/\.wav$/, '');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cli, ['-m', model, '-f', wav, '-l', locale.slice(0, 2), '-ml', '1', '-sow', '-oj', '-of', base, '-np'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new NativeError('helper-failed', `whisper-cli exited with ${code}`))));
    });
    const json = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')) as { transcription: { offsets: { from: number; to: number }; text: string }[] };
    const words = json.transcription
      .map((s) => ({ text: s.text.trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 }))
      .filter((w) => w.text && !/^\[.*\]$/.test(w.text) && !/^\(.*\)$/.test(w.text) && w.end > w.start);
    // whisper emits punctuation-only tokens at times; glue them to the previous word
    const merged: typeof words = [];
    for (const w of words) {
      if (/^[.,!?;:]+$/.test(w.text) && merged.length) merged[merged.length - 1]!.text += w.text;
      else merged.push(w);
    }
    return { engine: `whisper.cpp (${path.basename(model)})`, locale, onDevice: true, hasSpeech: merged.length > 0, words: merged };
  } finally {
    for (const f of [p.path, wav, `${base}.json`]) fsp.rm(f, { force: true }).catch(() => {});
  }
}

export async function transcribe(file: string, locale: string, settings: AppSettings): Promise<TranscribeResult> {
  const model = findWhisperModel(settings);
  const engine = settings.transcription.engine;
  if (engine === 'whisper') {
    if (!model) throw new NativeError('speech-model-unavailable', 'No Whisper model file is selected in Settings.');
    return transcribeWhisper(file, locale, model);
  }
  try {
    return await runJson<TranscribeResult>(['transcribe', file, '--locale', locale], { timeoutMs: 30 * 60000 });
  } catch (e) {
    const code = (e as NativeError).code;
    if (code === 'no-audio') throw e;
    if (engine === 'auto' && model && whisperCli()) return transcribeWhisper(file, locale, model);
    throw e;
  }
}

// ───────────────────────────── audio analysis (worker) ─────────────────────────────

function runWorker<T>(task: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: task });
    w.once('message', (m: { ok: boolean; result?: T; error?: string }) => (m.ok ? resolve(m.result as T) : reject(new NativeError('analysis-failed', m.error ?? 'Analysis failed'))));
    w.once('error', (e) => reject(new NativeError('analysis-failed', e.message)));
  });
}

export async function analyzeVoice(file: string): Promise<VoiceAnalysis> {
  const p = await pcm(file, 16000);
  try {
    return await runWorker<VoiceAnalysis>({ kind: 'voice', path: p.path, sampleRate: p.sampleRate });
  } finally {
    fsp.rm(p.path, { force: true }).catch(() => {});
  }
}

export async function correlate(refFile: string, otherFile: string, maxOffset: number): Promise<CorrelationResult> {
  const [a, b] = await Promise.all([pcm(refFile, 8000), pcm(otherFile, 8000)]);
  try {
    return await runWorker<CorrelationResult>({ kind: 'correlate', ref: a.path, other: b.path, sampleRate: 8000, maxOffset });
  } finally {
    fsp.rm(a.path, { force: true }).catch(() => {});
    fsp.rm(b.path, { force: true }).catch(() => {});
  }
}

export async function readCursor(file: string): Promise<CursorSample[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: CursorSample[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const s = JSON.parse(line) as CursorSample;
      if (typeof s.t === 'number' && typeof s.x === 'number' && typeof s.y === 'number') out.push(s);
    } catch {
      /* a torn last line after a crash is expected */
    }
  }
  return out;
}

// ───────────────────────────── recording session ─────────────────────────────

let session: { child: ChildProcessWithoutNullStreams; takeDir: string; stopped: Promise<TakeManifest>; done: boolean } | null = null;

function broadcast(e: RecordEvent) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('record:event', e);
}

export const isRecording = () => !!session && !session.done;

export async function nextTakeDir(projectPath: string): Promise<string> {
  const media = path.join(projectPath, 'media');
  await fsp.mkdir(media, { recursive: true });
  const existing = new Set(await fsp.readdir(media));
  for (let i = 1; i < 10000; i++) {
    const name = `take-${String(i).padStart(3, '0')}`;
    if (!existing.has(name)) return path.join(media, name);
  }
  throw new Error('Too many takes');
}

export async function startRecording(projectPath: string, config: RecordConfig): Promise<{ takeDir: string }> {
  if (isRecording()) throw new NativeError('busy', 'A recording is already in progress.');
  if (!helperAvailable()) throw new NativeError('helper-missing', 'The capture helper is not built. Run "pnpm native:build".');
  const takeDir = await nextTakeDir(projectPath);
  await fsp.mkdir(takeDir, { recursive: true });
  const cfg = path.join(takeDir, 'config.json');
  await fsp.writeFile(cfg, JSON.stringify(fullConfig(config, takeDir), null, 2));
  const child = spawn(helperPath(), ['record', '--config', cfg], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let resolveStarted!: () => void;
  let rejectStarted!: (e: Error) => void;
  const started = new Promise<void>((res, rej) => {
    resolveStarted = res;
    rejectStarted = rej;
  });
  let resolveStopped!: (m: TakeManifest) => void;
  let rejectStopped!: (e: Error) => void;
  const stopped = new Promise<TakeManifest>((res, rej) => {
    resolveStopped = res;
    rejectStopped = rej;
  });
  stopped.catch(() => {});
  const current = { child, takeDir, stopped, done: false };
  session = current;
  let sawStopped = false;
  let lastError = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let e: RecordEvent;
      try {
        e = JSON.parse(line) as RecordEvent;
      } catch {
        continue;
      }
      if (e.type === 'started') resolveStarted();
      if (e.type === 'error') {
        lastError = e.message;
        if (e.fatal) rejectStarted(new NativeError(e.code, e.message));
      }
      if (e.type === 'stopped') {
        sawStopped = true;
        resolveStopped(e.manifest);
      }
      broadcast(e);
    }
  });
  child.stderr.on('data', (d: Buffer) => (lastError = d.toString().trim().split('\n').pop() || lastError));
  child.on('close', () => {
    current.done = true;
    sessionEnded?.();
    if (!sawStopped) {
      const message = lastError || 'The recorder stopped unexpectedly.';
      rejectStarted(new NativeError('record-failed', message));
      rejectStopped(new NativeError('record-crashed', message));
      broadcast({ type: 'crashed', takeDir, message });
    }
  });
  child.on('error', (e) => rejectStarted(new NativeError('helper-failed', e.message)));
  const timeout = setTimeout(() => rejectStarted(new NativeError('timeout', 'The recorder did not start within 20 seconds.')), 20000);
  try {
    await started;
  } catch (e) {
    child.kill('SIGKILL');
    // nothing was captured: do not leave an empty take behind
    if (!fs.existsSync(path.join(takeDir, 'manifest.json'))) await fsp.rm(takeDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  return { takeDir };
}

function send(cmd: string) {
  if (!session || session.done) throw new NativeError('not-recording', 'No recording is in progress.');
  session.child.stdin.write(`${cmd}\n`);
}

export const pauseRecording = async () => send('pause');
export const flagRecording = async () => send('flag');

/** Called once whenever a recording session ends, however it ends. */
let sessionEnded: (() => void) | null = null;
export function onSessionEnded(cb: () => void) {
  sessionEnded = cb;
}
export const resumeRecording = async () => send('resume');

export async function stopRecording(): Promise<TakeManifest> {
  if (!session) throw new NativeError('not-recording', 'No recording is in progress.');
  const s = session;
  if (!s.done) s.child.stdin.write('stop\n');
  const timer = setTimeout(() => s.child.kill('SIGTERM'), 30000);
  try {
    return await s.stopped;
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelRecording(): Promise<void> {
  if (!session || session.done) return;
  const s = session;
  s.child.stdin.write('cancel\n');
  await new Promise<void>((r) => {
    const t = setTimeout(() => {
      s.child.kill('SIGKILL');
      r();
    }, 5000);
    s.child.once('close', () => {
      clearTimeout(t);
      r();
    });
  });
}

/** Called on quit: finalize files rather than lose the take. */
export async function shutdownRecording(): Promise<void> {
  if (isRecording()) await stopRecording().catch(() => {});
}

export const recover = (takeDir: string) => runJson<TakeManifest>(['recover', takeDir], { timeoutMs: 120000 });

export const mux = (video: string, audio: string | null, out: string, codec: 'h264' | 'prores422' = 'h264') =>
  runJson<{ path: string; duration: number; sizeBytes: number }>(['mux', '--video', video, ...(audio ? ['--audio', audio] : []), '--out', out, ...(codec === 'h264' ? [] : ['--codec', codec])], { timeoutMs: (codec === 'h264' ? 30 : 180) * 60000 });

// ───────────────────────────── parity additions ─────────────────────────────

export async function readKeys(file: string): Promise<KeyEvent[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: KeyEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const k = JSON.parse(line) as KeyEvent;
      if (typeof k.t === 'number' && (k.e === 'type' || (k.e === 'shortcut' && Array.isArray(k.keys)))) out.push(k);
    } catch {
      /* torn last line */
    }
  }
  return out;
}

export async function faces(projectPath: string, file: string): Promise<FaceTrack> {
  const dir = path.join(projectPath, 'cache', 'faces');
  const cache = path.join(dir, `${hash(file)}.json`);
  try {
    return JSON.parse(await fsp.readFile(cache, 'utf8')) as FaceTrack;
  } catch {
    /* not cached */
  }
  const track = await runJson<FaceTrack>(['faces', file, '--fps', '5'], { timeoutMs: 30 * 60000 });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(cache, JSON.stringify(track));
  return track;
}

export async function matte(projectPath: string, file: string): Promise<{ path: string; duration: number; frames: number; width: number; height: number }> {
  const dir = path.join(projectPath, 'cache', 'matte');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${hash(file)}.mov`);
  const meta = `${out}.json`;
  if (fs.existsSync(out) && fs.existsSync(meta)) return JSON.parse(await fsp.readFile(meta, 'utf8'));
  await fsp.rm(out, { force: true });
  const r = await runJson<{ path: string; duration: number; frames: number; width: number; height: number }>(['matte', file, '--out', out], { timeoutMs: 120 * 60000 });
  await fsp.writeFile(meta, JSON.stringify(r));
  return r;
}

export const resizeWindow = async (windowId: number, width: number, height: number): Promise<void> => {
  await runJson(['resize-window', '--window-id', String(windowId), '--width', String(Math.round(width)), '--height', String(Math.round(height))], { timeoutMs: 10000 });
};

export const voices = () => runJson<VoiceInfo[]>(['voices'], { timeoutMs: 20000 });

export async function speak(projectPath: string, text: string, voiceId: string, rate?: number): Promise<{ path: string; duration: number }> {
  const dir = path.join(projectPath, 'media', 'voiceover');
  await fsp.mkdir(dir, { recursive: true });
  const base = `voiceover-${Date.now().toString(36)}`;
  const txt = path.join(os.tmpdir(), `${base}.txt`);
  const out = path.join(dir, `${base}.wav`);
  await fsp.writeFile(txt, text);
  try {
    const r = await runJson<{ path: string; duration: number }>(['speak', '--text-file', txt, '--voice', voiceId, '--out', out, ...(rate ? ['--rate', String(rate)] : [])], { timeoutMs: 10 * 60000 });
    return { path: path.relative(projectPath, r.path), duration: r.duration };
  } finally {
    fsp.rm(txt, { force: true }).catch(() => {});
  }
}

/** Deletes one synthesised narration file. Only files inside the project's own voiceover folder can be removed. */
export async function removeVoiceover(projectPath: string, relPath: string): Promise<void> {
  const dir = path.join(projectPath, 'media', 'voiceover');
  const file = path.resolve(projectPath, relPath);
  if (path.dirname(file) !== path.resolve(dir) || !/^voiceover-[a-z0-9]+\.wav$/.test(path.basename(file))) throw new Error('Only voiceover takes made in this project can be deleted.');
  await fsp.rm(file, { force: true });
}

export const gif = (video: string, out: string, opts: { fps: number; width: number }) =>
  runJson<{ path: string; frames: number; sizeBytes: number }>(['gif', '--video', video, '--out', out, '--fps', String(opts.fps), '--width', String(opts.width)], { timeoutMs: 60 * 60000 });

/**
 * Sensitive content on a stretch of a screen recording. The helper recognises
 * text on sampled frames; it is classified here, in memory, and dropped: only a
 * category and a box per finding leave this function. Nothing is written or logged.
 */
export async function sensitive(file: string, start: number, end: number, interval: number): Promise<SensitiveScan> {
  const r = await runJson<{ interval: number; start: number; end: number; duration: number; frames: { t: number; lines: TextLine[] }[] }>(
    ['screen-text', file, '--interval', String(interval), '--start', start.toFixed(3), '--end', end.toFixed(3)],
    { timeoutMs: 20 * 60000 },
  );
  return { interval: r.interval, start: r.start, end: r.end, duration: r.duration, frames: r.frames.map((f) => ({ t: f.t, hits: f.lines.flatMap((l) => findSensitive(l)) })) };
}
