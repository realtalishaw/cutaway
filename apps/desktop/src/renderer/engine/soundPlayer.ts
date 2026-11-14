/**
 * Plays one-shot sounds in the editor: sound effects as the playhead passes them, and the "listen"
 * buttons in the inspector. The built-in sounds are the same samples the exporter mixes
 * (core.synthSound); nothing here affects an export.
 */
import { MAX_FILE_SOUND, synthSound } from '@cutaway/core';

let ctx: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();
const live = new Set<() => void>();

function context(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null; // no audio device: the editor stays silent, exports are unaffected
  }
}

/** Plays a built-in sound once. `skip` seconds of it are left out. Returns a function that stops it. */
export function playBuiltin(id: string, gain: number, skip = 0): () => void {
  const ac = context();
  if (!ac) return () => {};
  let buffer = buffers.get(id);
  if (!buffer) {
    const data = synthSound(id, ac.sampleRate);
    buffer = ac.createBuffer(1, data.length, ac.sampleRate);
    buffer.getChannelData(0).set(data);
    buffers.set(id, buffer);
  }
  const node = ac.createBufferSource();
  node.buffer = buffer;
  const g = ac.createGain();
  g.gain.value = Math.max(0, gain);
  node.connect(g).connect(ac.destination);
  const stop = () => {
    live.delete(stop);
    try {
      node.stop();
    } catch {
      /* already ended */
    }
  };
  node.onended = () => live.delete(stop);
  live.add(stop);
  node.start(0, Math.max(0, skip));
  return stop;
}

/** Plays the creator's own sound file once, for at most MAX_FILE_SOUND seconds. */
export function playFile(url: string, gain: number, skip = 0): () => void {
  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';
  el.src = url;
  el.volume = Math.max(0, Math.min(1, gain));
  let timer = 0;
  const stop = () => {
    live.delete(stop);
    window.clearTimeout(timer);
    el.pause();
    el.removeAttribute('src');
    el.load();
  };
  live.add(stop);
  el.addEventListener('ended', stop, { once: true });
  el.addEventListener('error', stop, { once: true });
  if (skip > 0) el.currentTime = skip;
  timer = window.setTimeout(stop, Math.max(0.1, MAX_FILE_SOUND - skip) * 1000);
  void el.play().catch(stop);
  return stop;
}

/** Stops everything this module started (pause, seek, leaving the editor). */
export function stopSounds() {
  for (const stop of [...live]) stop();
}

export const soundsPlaying = () => live.size;
