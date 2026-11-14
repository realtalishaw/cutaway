/**
 * Loudness peaks of an audio file, for drawing music on the timeline. Decoded once per file and kept
 * for the session; only the drawing uses them, never the mix.
 */
import { useEffect, useState } from 'react';
import type { MediaSource } from '@cutaway/core';
import { sourceUrl } from './media';

/** Peaks per second of the file. */
export const PEAKS_HZ = 50;

const cache = new Map<string, Promise<Float32Array | null>>();

async function decode(url: string): Promise<Float32Array | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ctx = new OfflineAudioContext(1, 1, 22050);
  const buf = await ctx.decodeAudioData(await res.arrayBuffer());
  const step = Math.max(1, Math.floor(buf.sampleRate / PEAKS_HZ));
  const n = Math.ceil(buf.length / step);
  const out = new Float32Array(n);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  let top = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = i * step;
    const b = Math.min(buf.length, a + step);
    for (const d of chans) for (let k = a; k < b; k++) m = Math.max(m, Math.abs(d[k]!));
    out[i] = m;
    top = Math.max(top, m);
  }
  // scale so the loudest moment of the file fills the block
  if (top > 0) for (let i = 0; i < n; i++) out[i] = out[i]! / top;
  return out;
}

export function musicPeaks(projectPath: string, file: MediaSource): Promise<Float32Array | null> {
  const url = sourceUrl(projectPath, file);
  let p = cache.get(url);
  if (!p) {
    p = decode(url).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** Peaks of a file once they are ready (null until then, or when the file cannot be read). */
export function useMusicPeaks(projectPath: string | null, file: MediaSource | undefined): Float32Array | null {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!projectPath || !file || !file.available) return;
    let live = true;
    void musicPeaks(projectPath, file).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [projectPath, file?.id, file?.path, file?.available]);
  return peaks;
}
