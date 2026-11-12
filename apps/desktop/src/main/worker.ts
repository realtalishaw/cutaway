/** Worker thread: CPU-heavy audio maths kept off the main process loop. */
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { correlateAudio, detectSilences, rmsEnvelope, waveform } from '@cutaway/core';

function readF32(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

try {
  const task = workerData as { kind: string; path?: string; ref?: string; other?: string; sampleRate: number; maxOffset?: number };
  if (task.kind === 'voice') {
    const pcm = readF32(task.path!);
    const hz = 50;
    const env = rmsEnvelope(pcm, task.sampleRate, hz);
    const { silences, hasSignal } = detectSilences(env, hz);
    const sorted = Float32Array.from(env).sort();
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)]! : 0;
    const levelDb = hasSignal && p95 > 0 ? 20 * Math.log10(p95) : null;
    parentPort!.postMessage({ ok: true, result: { silences, hasSignal, waveform: waveform(env, hz, 20), waveformHz: 20, duration: pcm.length / task.sampleRate, levelDb } });
  } else if (task.kind === 'correlate') {
    const result = correlateAudio(readF32(task.ref!), readF32(task.other!), task.sampleRate, task.maxOffset ?? 600);
    parentPort!.postMessage({ ok: true, result });
  } else {
    parentPort!.postMessage({ ok: false, error: `Unknown task ${task.kind}` });
  }
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
