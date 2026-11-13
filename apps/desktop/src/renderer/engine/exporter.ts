import { ALL_FORMATS, AudioSampleSink, CanvasSource, Input, Mp4OutputFormat, Output, StreamTarget, UrlSource, VideoSampleSink, type InputAudioTrack, type StreamTargetChunk, type VideoSample } from 'mediabunny';
import { TimeMap, buildCues, buildCursorTrack, clickSoundOf, clickTick, coverage, cueAt, cursorExtrasOf, cutoutOf, deviceKindFor, deviceOf, estimateVideoBitrate, evaluateFrame, faceOf, shortcutsOf, toSourceTime, type CameraSlot, type CursorSample, type FaceTrackSmooth, type KeyStroke, type MediaSource, type Project } from '@cutaway/core';
import { resolveSourcePath } from '@shared/api';
import { TimeStretcher, VoiceCleaner, type StereoBlock } from './audioDsp';
import { drawFrame, neededSources, type Drawable, type FrameResources } from './compositor';
import { loadCursor, voiceGain } from './media';
import { ensureFaces, ensureKeys, ensureMatte } from './parityData';
import { ensureGrade, gradeLuts } from './lut';

export interface RenderProgress {
  stage: 'prepare' | 'video' | 'audio' | 'finalize';
  /** Frames encoded so far / total. Real counts, never estimated. */
  frames: number;
  totalFrames: number;
  /** Encoding speed in frames per second (measured). */
  fps: number;
}

export interface RenderResult {
  fileName: string;
  bytes: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string | null;
}

export interface RenderArgs {
  project: Project;
  projectPath: string;
  /** Export session from window.cutaway.export.begin(); the video is written into its working folder. */
  sessionId: string;
  /** Final file name inside the session folder, e.g. "video.mp4". */
  fileName: string;
  onProgress(p: RenderProgress): void;
  signal: AbortSignal;
  /** Video bitrate in bits per second. Defaults to YouTube's recommendation for the size and frame rate. */
  bitrate?: number | null;
  /**
   * 'h264' (default) writes an MP4 with H.264 + AAC. 'prores422' writes a
   * QuickTime movie with ProRes 422 + uncompressed sound, for editing elsewhere;
   * `fileName` should then end in .mov and `bitrate` is ignored.
   */
  codec?: 'h264' | 'prores422';
}

/** The renderer honours RenderArgs.codec. */
export const RENDER_SUPPORTS_PRORES = true;

/**
 * ProRes is encoded by the native helper from a rendered H.264 pass, so that
 * pass is made at a bitrate high enough to be visually transparent.
 */
export function proresIntermediateBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(240e6, Math.max(60e6, estimateVideoBitrate(width, height, fps) * 8)));
}

/** The renderer honours RenderArgs.bitrate. */
export const RENDER_SUPPORTS_BITRATE = true;

class RenderError extends Error {
  constructor(public code: 'cancelled' | 'disk-full' | 'missing-source' | 'encode-failed', message: string) {
    super(message);
  }
}

const SAMPLE_RATE = 48000;

/** Sequential frame access for one source: decode forward, re-seek only on big jumps. */
class FrameCursor {
  private gen: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private current: VideoSample | null = null;
  private next: VideoSample | null = null;
  private ended = false;
  constructor(private sink: VideoSampleSink) {}

  private async restart(t: number) {
    await this.dispose();
    this.gen = this.sink.samples(Math.max(0, t));
    this.ended = false;
    this.current = await this.pull();
    this.next = await this.pull();
  }

  private async pull(): Promise<VideoSample | null> {
    if (!this.gen || this.ended) return null;
    const r = await this.gen.next();
    if (r.done) {
      this.ended = true;
      return null;
    }
    return r.value;
  }

  /** The frame visible at source time `t`. */
  async at(t: number): Promise<VideoSample | null> {
    if (!this.gen || !this.current || t < this.current.timestamp - 1e-3 || (this.next && t > this.next.timestamp + 2)) await this.restart(t);
    while (this.next && this.next.timestamp <= t + 1e-4) {
      this.current?.close();
      this.current = this.next;
      this.next = await this.pull();
    }
    return this.current;
  }

  async dispose() {
    this.current?.close();
    this.next?.close();
    this.current = this.next = null;
    if (this.gen) await this.gen.return().catch(() => {});
    this.gen = null;
  }
}

function sampleDrawable(s: VideoSample): Drawable {
  return { width: s.displayWidth, height: s.displayHeight, draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => s.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh) };
}

async function loadImage(url: string): Promise<Drawable | null> {
  try {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    return { width: bmp.width, height: bmp.height, draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(bmp, sx, sy, sw, sh, dx, dy, dw, dh) };
  } catch {
    return null;
  }
}

// ───────────────────────────── audio ─────────────────────────────

/** Streams one audio track as resampled stereo, continuing where the last read ended when possible. */
class TrackReader {
  private gen: AsyncGenerator<import('mediabunny').AudioSample, void, unknown> | null = null;
  private chunks: { start: number; l: Float32Array; r: Float32Array }[] = [];
  private bufferedEnd = 0; // source frame index (exclusive)
  private ended = false;
  private sink: AudioSampleSink;
  readonly rate: number;
  constructor(private track: InputAudioTrack) {
    this.sink = new AudioSampleSink(track);
    this.rate = track.sampleRate;
  }

  private async seek(frame: number) {
    if (this.gen) await this.gen.return().catch(() => {});
    this.chunks = [];
    this.ended = false;
    this.gen = this.sink.samples(Math.max(0, frame / this.rate - 0.05));
    this.bufferedEnd = -1;
  }

  private async fill(untilFrame: number) {
    while (!this.ended && (this.bufferedEnd < 0 || this.bufferedEnd <= untilFrame)) {
      const r = await this.gen!.next();
      if (r.done) {
        this.ended = true;
        break;
      }
      const s = r.value;
      const n = s.numberOfFrames;
      const l = new Float32Array(n);
      s.copyTo(l, { planeIndex: 0, format: 'f32-planar' });
      let rr = l;
      if (s.numberOfChannels > 1) {
        rr = new Float32Array(n);
        s.copyTo(rr, { planeIndex: 1, format: 'f32-planar' });
      }
      const start = Math.round(s.timestamp * this.rate);
      s.close();
      this.chunks.push({ start, l, r: rr });
      this.bufferedEnd = start + n;
    }
  }

  private sampleAt(frame: number, ch: 0 | 1): number {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]!;
      if (frame >= c.start && frame < c.start + c.l.length) return (ch === 0 ? c.l : c.r)[frame - c.start]!;
      if (frame >= c.start + c.l.length) break;
    }
    return 0;
  }

  /** `frames` output samples starting at source time `t0`, advancing `ratio` source frames per output frame. */
  async read(t0: number, ratio: number, frames: number, outL: Float32Array, outR: Float32Array, gain: number) {
    const first = t0 * this.rate;
    const last = first + frames * ratio + 2;
    const have = this.chunks[0];
    if (!this.gen || !have || first < have.start || first > this.bufferedEnd + this.rate) await this.seek(Math.floor(first));
    await this.fill(Math.ceil(last));
    // drop chunks entirely before this read
    while (this.chunks.length > 1 && this.chunks[0]!.start + this.chunks[0]!.l.length < first - 4) this.chunks.shift();
    for (let i = 0; i < frames; i++) {
      const p = first + i * ratio;
      const a = Math.floor(p);
      const f = p - a;
      outL[i] = outL[i]! + (this.sampleAt(a, 0) * (1 - f) + this.sampleAt(a + 1, 0) * f) * gain;
      outR[i] = outR[i]! + (this.sampleAt(a, 1) * (1 - f) + this.sampleAt(a + 1, 1) * f) * gain;
    }
  }

  async dispose() {
    if (this.gen) await this.gen.return().catch(() => {});
  }
}

function wavHeader(dataBytes: number): Uint8Array {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(b);
}

interface AudioTrackPlan {
  source: MediaSource;
  reader: TrackReader;
  gain: number;
  /** 'session' tracks follow cuts; 'output' tracks (music) run straight through. */
  clock: 'session' | 'output';
  /** Rumble filter, level, expander and limiter for the master voice. */
  cleanup: VoiceCleaner | null;
  /** Pitch-preserving stretcher for the speed section being rendered. */
  stretch: { seg: object; stretcher: TimeStretcher } | null;
  duck: boolean;
  coverage: { start: number; end: number }[];
  input: Input;
}

async function openInput(projectPath: string, source: MediaSource): Promise<Input> {
  return new Input({ source: new UrlSource(window.cutaway.media.url(resolveSourcePath(projectPath, source.path))), formats: ALL_FORMATS });
}

function ipcError(e: unknown): RenderError {
  const code = (e as { code?: string }).code;
  if (code === 'disk-full') return new RenderError('disk-full', 'The destination ran out of space.');
  return new RenderError('encode-failed', (e as Error).message);
}

async function renderAudio(args: RenderArgs, map: TimeMap, wavName: string, clickTimes: number[] = []): Promise<boolean> {
  const { project, projectPath } = args;
  const audio = project.edit.audio;
  const plans: AudioTrackPlan[] = [];
  const speechGain = voiceGain(project);
  for (const s of project.sources) {
    if (!s.hasAudio || !s.available) continue;
    const isMusic = audio.music?.sourceId === s.id;
    const t = audio.tracks[s.id];
    const brollWithAudio = project.edit.broll.some((b) => b.assetId === s.id && b.useAssetAudio);
    if (!isMusic && !brollWithAudio && (!t || t.muted)) continue;
    if (s.sync.status === 'unsynced' && !isMusic) continue;
    let input: Input;
    try {
      input = await openInput(projectPath, s);
    } catch {
      continue;
    }
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) continue;
    const isVoice = s.id === audio.masterVoiceId;
    const clean = isVoice && audio.voiceCleanup.enabled && !audio.voiceCleanup.bypass;
    plans.push({
      source: s,
      reader: new TrackReader(track),
      // the cleanup chain applies the speech level itself, so its expander and limiter see the final level
      gain: isMusic ? audio.music!.gain : (t?.gain ?? 1),
      clock: isMusic ? 'output' : 'session',
      cleanup: clean ? new VoiceCleaner(SAMPLE_RATE, { makeup: speechGain, expander: project.analysis?.voiceLevelDb != null }) : null,
      stretch: null,
      duck: isMusic && !!audio.music?.duck,
      coverage: isMusic ? [{ start: 0, end: Infinity }] : brollWithAudio ? project.edit.broll.filter((b) => b.assetId === s.id).map((b) => ({ start: b.start, end: b.end })) : coverage(s),
      input,
    });
  }
  // click sound: the same synthesised tick the preview plays, at each kept click's output position
  const cs = clickSoundOf(project.edit.appearance);
  const tickData = clickTick(SAMPLE_RATE);
  const tickAt = cs.enabled ? clickTimes.filter((t) => map.isKept(t)).map((t) => Math.round(map.toOutput(t) * SAMPLE_RATE)).sort((a, b) => a - b) : [];
  if (plans.length === 0 && tickAt.length === 0) return false;

  const totalFrames = Math.round(map.outDuration * SAMPLE_RATE);
  const speech = (project.transcript?.words ?? []).map((w) => ({ start: w.start - 0.25, end: w.end + 0.35 }));
  let written = 0;
  let pos = 44;
  await window.cutaway.export.write(args.sessionId, wavName, 0, wavHeader(totalFrames * 4)).catch((e) => {
    throw ipcError(e);
  });
  const BLOCK = SAMPLE_RATE; // one second
  const FADE = Math.round(SAMPLE_RATE * 0.006);
  let duckLevel = 1;
  /** `frames` frames of a session-clock track at normal speed, starting at session time `t0`. Silent outside its coverage. */
  const readSession = async (p: AudioTrackPlan, t0: number, frames: number): Promise<StereoBlock> => {
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    const t1 = t0 + frames / SAMPLE_RATE;
    const spans = p.coverage.filter((c) => t0 < c.end && t1 > c.start);
    if (spans.length === 0) return { l, r };
    const insert = project.edit.broll.find((b) => b.assetId === p.source.id && t0 >= b.start - 1 && t0 < b.end);
    const local = insert ? insert.assetIn + (t0 - insert.start) : toSourceTime(p.source.sync, t0);
    const ratio = ((insert ? 1 : p.source.sync.rate) * p.reader.rate) / SAMPLE_RATE;
    await p.reader.read(local, ratio, frames, l, r, 1);
    // silence anything outside real coverage inside this block
    if (!spans.some((c) => c.start <= t0 && c.end >= t1)) {
      for (let i = 0; i < frames; i++) {
        const t = t0 + i / SAMPLE_RATE;
        if (!spans.some((c) => t >= c.start && t < c.end)) l[i] = r[i] = 0;
      }
    }
    return { l, r };
  };
  try {
    for (const seg of map.segments) {
      const segFrames = Math.max(0, Math.round(seg.outEnd * SAMPLE_RATE) - Math.round(seg.outStart * SAMPLE_RATE));
      const stretched = Math.abs(seg.speed - 1) > 1e-3;
      // the limiter's look-ahead must not carry sound across a cut
      for (const p of plans) if (p.clock === 'session') p.cleanup?.flush();
      for (let off = 0; off < segFrames; off += BLOCK) {
        if (args.signal.aborted) throw new RenderError('cancelled', 'Export cancelled.');
        const n = Math.min(BLOCK, segFrames - off);
        const mixL = new Float32Array(n);
        const mixR = new Float32Array(n);
        const sessionT = seg.srcStart + (off / SAMPLE_RATE) * seg.speed;
        const outT = seg.outStart + off / SAMPLE_RATE;
        for (const p of plans) {
          let l: Float32Array = new Float32Array(n);
          let r: Float32Array = new Float32Array(n);
          if (p.clock === 'output') {
            if (outT >= p.source.duration) continue;
            await p.reader.read(outT, p.reader.rate / SAMPLE_RATE, n, l, r, 1);
          } else if (!stretched) {
            const blockEnd = sessionT + n / SAMPLE_RATE;
            if (!p.coverage.some((c) => sessionT < c.end && blockEnd > c.start)) continue;
            ({ l, r } = await readSession(p, sessionT, n));
          } else {
            // A sped-up or slowed-down section: the sound is time-stretched so voices keep their pitch.
            if (!p.coverage.some((c) => seg.srcStart < c.end && seg.srcEnd > c.start)) continue;
            if (p.stretch?.seg !== seg) {
              const inputFrames = Math.max(0, Math.round((seg.srcEnd - seg.srcStart) * SAMPLE_RATE));
              p.stretch = { seg, stretcher: new TimeStretcher(seg.speed, inputFrames, (start, count) => readSession(p, seg.srcStart + start / SAMPLE_RATE, count), SAMPLE_RATE) };
            }
            ({ l, r } = await p.stretch.stretcher.render(n));
          }
          p.cleanup?.run(l, r);
          for (let i = 0; i < n; i++) {
            let g = p.gain;
            if (p.duck) {
              const t = sessionT + (i / SAMPLE_RATE) * seg.speed;
              const target = speech.some((w) => t >= w.start && t < w.end) ? 0.22 : 1;
              duckLevel += (target - duckLevel) * 0.0004;
              g *= duckLevel;
            }
            if (p.clock === 'session') {
              // short fades at every cut so joins never click
              const fromStart = off + i;
              const fromEnd = segFrames - 1 - (off + i);
              if (fromStart < FADE) g *= fromStart / FADE;
              if (fromEnd < FADE) g *= fromEnd / FADE;
            }
            mixL[i] = mixL[i]! + l[i]! * g;
            mixR[i] = mixR[i]! + r[i]! * g;
          }
        }
        if (tickAt.length) {
          const blockStart = Math.round(seg.outStart * SAMPLE_RATE) + off;
          for (const at of tickAt) {
            if (at >= blockStart + n || at + tickData.length <= blockStart) continue;
            for (let k = Math.max(0, blockStart - at); k < tickData.length; k++) {
              const i = at + k - blockStart;
              if (i >= n) break;
              mixL[i] = mixL[i]! + tickData[k]! * cs.volume;
              mixR[i] = mixR[i]! + tickData[k]! * cs.volume;
            }
          }
        }
        const pcm = new Int16Array(n * 2);
        for (let i = 0; i < n; i++) {
          // soft clip rather than wrap
          const a = Math.tanh(mixL[i]! * 0.98);
          const b = Math.tanh(mixR[i]! * 0.98);
          pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(a * 32767)));
          pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(b * 32767)));
        }
        await window.cutaway.export.write(args.sessionId, wavName, pos, new Uint8Array(pcm.buffer)).catch((e) => {
          throw ipcError(e);
        });
        pos += pcm.byteLength;
        written += n;
      }
    }
    if (written !== totalFrames) await window.cutaway.export.write(args.sessionId, wavName, 0, wavHeader(written * 4)).catch(() => {});
  } finally {
    for (const p of plans) {
      await p.reader.dispose();
      p.input.dispose();
    }
  }
  return written > 0;
}

// ───────────────────────────── video ─────────────────────────────

/**
 * Renders the finished video with the same frame evaluator and compositor the
 * preview uses. Rejects with an Error whose `code` is 'cancelled', 'disk-full',
 * 'missing-source' or 'encode-failed'.
 */
export async function renderVideo(args: RenderArgs): Promise<RenderResult> {
  const { project, projectPath, signal } = args;
  const ap = project.edit.appearance;
  const { width: W, height: H, fps } = ap.output;
  const map = TimeMap.fromEdit(project.duration, project.edit);
  const totalFrames = Math.max(1, Math.round(map.outDuration * fps));
  const check = () => {
    if (signal.aborted) throw new RenderError('cancelled', 'Export cancelled.');
  };
  args.onProgress({ stage: 'prepare', frames: 0, totalFrames, fps: 0 });

  const byRole = (role: MediaSource['role']) => project.sources.find((s) => s.role === role);
  const screen = byRole('screen');
  const camA = byRole('cameraA');
  const camB = byRole('cameraB');
  const inputs: Input[] = [];
  const cursors = new Map<string, FrameCursor>();
  const stills = new Map<string, Drawable>();
  const open = async (s: MediaSource | undefined) => {
    if (!s) return;
    if (!s.available) throw new RenderError('missing-source', `"${s.name}" is missing. Relink it before exporting.`);
    if (s.kind === 'image') {
      const d = await loadImage(window.cutaway.media.url(resolveSourcePath(projectPath, s.path)));
      if (d) stills.set(s.id, d);
      return;
    }
    const input = await openInput(projectPath, s);
    inputs.push(input);
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new RenderError('missing-source', `"${s.name}" has no video track.`);
    if (!(await track.canDecode())) throw new RenderError('encode-failed', `"${s.name}" uses a codec this Mac cannot decode (${track.codec ?? 'unknown'}).`);
    cursors.set(s.id, new FrameCursor(new VideoSampleSink(track)));
  };

  let clickTimes: number[] = [];
  const tmpVideo = `.${args.fileName}.video.mp4`;
  const tmpAudio = `.${args.fileName}.audio.wav`;
  let output: Output | null = null;
  try {
    await document.fonts.ready;
    await Promise.all([document.fonts.load("650 40px 'Inter Variable'"), document.fonts.load("500 40px 'Inter Variable'")]).catch(() => {});
    for (const s of [screen, camA, camB]) await open(s);
    for (const id of new Set(project.edit.broll.map((b) => b.assetId))) await open(project.sources.find((s) => s.id === id));
    let backgroundImage: Drawable | null = null;
    if (ap.background.type === 'image') backgroundImage = await loadImage(window.cutaway.media.url(resolveSourcePath(projectPath, ap.background.path)));
    await ensureGrade(projectPath, ap); // colour LUTs parsed before the first frame

    const samples: CursorSample[] = screen && !screen.cursorBaked && screen.cursorFile ? await loadCursor(projectPath, screen) : [];
    const extra = cursorExtrasOf(ap);
    const cursorTrack = samples.length ? buildCursorTrack(samples, ap.cursor.smoothing, 120, { antiShake: extra.antiShake, loop: extra.loop }) : null;
    const followTrack = samples.length ? buildCursorTrack(samples, 0.97) : null;
    clickTimes = cursorTrack ? cursorTrack.clicks.map((c) => c.t) : [];
    // derived data the preview may still be computing: wait for it so the export matches what was approved
    const keys: KeyStroke[] = shortcutsOf(ap).show ? await ensureKeys(projectPath, screen) : [];
    const faceOpt = faceOf(ap);
    const faces: Partial<Record<CameraSlot, FaceTrackSmooth | null>> = {};
    const mattes: Partial<Record<CameraSlot, FrameCursor>> = {};
    for (const [slot, cam] of [['A', camA], ['B', camB]] as [CameraSlot, MediaSource | undefined][]) {
      if (!cam) continue;
      if (faceOpt.zoom || faceOpt.follow) faces[slot] = await ensureFaces(projectPath, cam);
      if (cutoutOf(ap).enabled) {
        const mp = await ensureMatte(projectPath, cam);
        if (mp) {
          const input = new Input({ source: new UrlSource(window.cutaway.media.url(mp)), formats: ALL_FORMATS });
          inputs.push(input);
          const track = await input.getPrimaryVideoTrack();
          if (track && (await track.canDecode())) {
            const fc = new FrameCursor(new VideoSampleSink(track));
            mattes[slot] = fc;
            cursors.set(`matte:${cam.id}`, fc);
          }
        }
      }
    }
    check();
    const device = deviceOf(ap).frame ? deviceKindFor(screen) : null;
    const ctxFrame = { project, map, cursor: cursorTrack, follow: followTrack, screenAspect: screen?.width && screen.height ? (screen.width * ap.crop.w) / (screen.height * ap.crop.h) : null, keys, faces, quality: 'export' as const, device };
    const cues = ap.captions.burnIn ? buildCues(project.transcript, project.edit, map) : [];

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    let writeError: unknown = null;
    let chain = Promise.resolve();
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        // keep writes ordered; surface the first failure (e.g. disk full)
        chain = chain.then(() => window.cutaway.export.write(args.sessionId, tmpVideo, chunk.position, chunk.data)).catch((e) => {
          writeError ??= e;
        });
        return chain;
      },
    });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) });
    const prores = args.codec === 'prores422';
    const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: prores ? proresIntermediateBitrate(W, H, fps) : (args.bitrate ?? estimateVideoBitrate(W, H, fps)), keyFrameInterval: prores ? 0.5 : 2, latencyMode: 'quality' });
    output.addVideoTrack(videoSource, { frameRate: fps });
    await output.start();

    const started = performance.now();
    for (let i = 0; i < totalFrames; i++) {
      check();
      if (writeError) throw ipcError(writeError);
      // sample at the middle of the frame interval so a cut never shows a frame from the removed side
      const out = Math.min(map.outDuration - 1e-4, (i + 0.5) / fps);
      const state = evaluateFrame(ctxFrame, out);
      const need = neededSources(state);
      const res: FrameResources = { screen: null, cameraA: null, cameraB: null, broll: null, backgroundImage };
      const grab = async (s: MediaSource | undefined, local: number): Promise<Drawable | null> => {
        if (!s) return null;
        const still = stills.get(s.id);
        if (still) return still;
        const cur = cursors.get(s.id);
        if (!cur) return null;
        const sample = await cur.at(Math.max(0, Math.min(s.duration - 1e-3, local)));
        return sample ? sampleDrawable(sample) : null;
      };
      if (need.screen && screen) res.screen = await grab(screen, toSourceTime(screen.sync, state.src));
      if (need.cameras.includes('A') && camA) res.cameraA = await grab(camA, toSourceTime(camA.sync, state.src));
      if (need.cameras.includes('B') && camB) res.cameraB = await grab(camB, toSourceTime(camB.sync, state.src));
      for (const [slot, cam] of [['A', camA], ['B', camB]] as [CameraSlot, MediaSource | undefined][]) {
        const mc = mattes[slot];
        if (!mc || !cam || !need.cameras.includes(slot)) continue;
        const sample = await mc.at(Math.max(0, Math.min(cam.duration - 1e-3, toSourceTime(cam.sync, state.src))));
        if (slot === 'A') res.matteA = sample ? sampleDrawable(sample) : null;
        else res.matteB = sample ? sampleDrawable(sample) : null;
      }
      if (need.broll && state.broll) res.broll = await grab(project.sources.find((s) => s.id === need.broll), state.broll.assetTime);
      drawFrame(ctx, state, res, { appearance: ap, screenPoints: screen?.pointWidth && screen.pointHeight ? { width: screen.pointWidth, height: screen.pointHeight } : null, cue: cues.length ? cueAt(cues, out) : null, device, luts: gradeLuts(projectPath, ap) });
      await videoSource.add(i / fps, 1 / fps);
      if (i % 5 === 0 || i === totalFrames - 1) {
        const elapsed = (performance.now() - started) / 1000;
        args.onProgress({ stage: 'video', frames: i + 1, totalFrames, fps: elapsed > 0 ? (i + 1) / elapsed : 0 });
      }
    }
    await output.finalize();
    output = null;
    await chain;
    if (writeError) throw ipcError(writeError);

    args.onProgress({ stage: 'audio', frames: totalFrames, totalFrames, fps: 0 });
    const hasAudio = await renderAudio(args, map, tmpAudio, clickTimes);
    check();

    args.onProgress({ stage: 'finalize', frames: totalFrames, totalFrames, fps: 0 });
    // Native pass. MP4: AAC-LC 48 kHz stereo, BT.709 in the stream and the container, moov at the front; the video
    // samples are not re-encoded. ProRes: the rendered pass is decoded and written as ProRes 422 with PCM sound.
    const muxed = await window.cutaway.export.mux(args.sessionId, tmpVideo, hasAudio ? tmpAudio : null, args.fileName, prores ? 'prores422' : 'h264').catch((e) => {
      throw ipcError(e);
    });
    return { fileName: args.fileName, bytes: muxed.bytes, duration: muxed.duration, width: W, height: H, fps, hasAudio, videoCodec: prores ? 'ProRes 422' : 'H.264', audioCodec: hasAudio ? (prores ? 'PCM' : 'AAC-LC') : null };
  } catch (e) {
    if (output) await output.cancel().catch(() => {});
    if (e instanceof RenderError) throw e;
    if (signal.aborted) throw new RenderError('cancelled', 'Export cancelled.');
    throw new RenderError('encode-failed', (e as Error).message || 'The video could not be encoded.');
  } finally {
    for (const c of cursors.values()) await c.dispose();
    for (const i of inputs) i.dispose();
  }
}
