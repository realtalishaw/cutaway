import { describe, expect, it } from 'vitest';
import { downmix, encodeWav } from './wav';

describe('voiceover WAV', () => {
  it('writes a mono 16-bit PCM file with the right header and samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), 48000);
    const v = new DataView(wav.buffer);
    const text = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(10);
    expect(wav.length).toBe(54);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16384, 32767]);
  });

  it('averages a stereo microphone into one channel', () => {
    expect([...downmix([new Float32Array([1, 0]), new Float32Array([0, 0.5])])]).toEqual([0.5, 0.25]);
  });
});
