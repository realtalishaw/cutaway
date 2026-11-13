import { describe, expect, it } from 'vitest';
import { TimeStretcher, VOICE_CLEANUP, VoiceCleaner, stretch } from './audioDsp';

const SR = 48000;

function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** Dominant frequency from the strongest bin of a Goertzel sweep. */
function pitchOf(x: Float32Array, lo = 100, hi = 1200): number {
  let best = 0;
  let bestPower = -1;
  for (let f = lo; f <= hi; f += 2) {
    const w = (2 * Math.PI * f) / SR;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < x.length; i++) {
      const s0 = x[i]! + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (power > bestPower) {
      bestPower = power;
      best = f;
    }
  }
  return best;
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};
const peak = (x: Float32Array, from = 0, to = x.length) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
};
const dB = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));

/** A deterministic noise source (xorshift), so tests never depend on Math.random. */
function noise(n: number, amp: number, seed = 0x2545f491): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

describe('TimeStretcher', () => {
  for (const speed of [0.5, 0.75, 1.25, 1.5, 2, 4]) {
    it(`changes the length by ${speed}× and keeps the pitch`, async () => {
      const input = sine(220, 3);
      const out = await stretch({ l: input, r: input }, speed, SR);
      expect(out.l.length).toBe(Math.round(input.length / speed));
      // pitch stays at 220 Hz; plain resampling would have moved it to 220 × speed
      const mid = out.l.subarray(Math.floor(out.l.length * 0.1), Math.floor(out.l.length * 0.9));
      expect(Math.abs(pitchOf(mid) - 220)).toBeLessThanOrEqual(4);
      // no dropouts or doubled level where windows overlap
      expect(Math.abs(dB(rms(mid)) - dB(rms(input)))).toBeLessThan(1);
      const step = Math.round(SR * 0.05);
      for (let i = step; i + step < mid.length; i += step) expect(dB(rms(mid, i, i + step)) - dB(rms(input))).toBeGreaterThan(-3);
    });
  }

  it('is deterministic and independent of how output is requested', async () => {
    const a = sine(180, 1.2, 0.4);
    const b = noise(a.length, 0.2);
    const input = { l: a.map((v, i) => v + b[i]!), r: a };
    const whole = await stretch(input, 1.5, SR);
    const s = new TimeStretcher(1.5, input.l.length, (start, count) => ({ l: input.l.subarray(start, start + count), r: input.r.subarray(start, start + count) }), SR);
    const parts: Float32Array[] = [];
    let left = whole.l.length;
    for (const n of [1, 477, 4800, 9999, 123456]) {
      const take = Math.min(n, left);
      if (take <= 0) break;
      parts.push((await s.render(take)).l);
      left -= take;
    }
    const joined = new Float32Array(whole.l.length - left);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    expect(Array.from(joined)).toEqual(Array.from(whole.l.subarray(0, joined.length)));
    const again = await stretch(input, 1.5, SR);
    expect(Array.from(again.r)).toEqual(Array.from(whole.r));
  });

  it('never asks for audio outside the section it was given', async () => {
    const total = SR;
    const spans: [number, number][] = [];
    const s = new TimeStretcher(2, total, (start, count) => {
      spans.push([start, count]);
      return { l: new Float32Array(count), r: new Float32Array(count) };
    }, SR);
    await s.render(total / 2);
    let expected = 0;
    for (const [start, count] of spans) {
      expect(start).toBe(expected); // contiguous, forward only
      expected = start + count;
      expect(start).toBeGreaterThanOrEqual(0);
    }
    expect(expected).toBeLessThanOrEqual(total);
  });

  it('keeps a stereo pair in step', async () => {
    const l = sine(300, 1.5);
    const r = sine(300, 1.5, 0.25);
    const out = await stretch({ l, r }, 1.25, SR);
    const a = Math.floor(out.l.length * 0.2);
    const b = Math.floor(out.l.length * 0.8);
    expect(Math.abs(dB(rms(out.l, a, b)) - dB(rms(out.r, a, b)) - dB(0.5 / 0.25))).toBeLessThan(0.2);
  });
});

describe('VoiceCleaner', () => {
  it('removes DC and rumble but leaves the voice band alone', () => {
    const n = SR;
    const c = new VoiceCleaner(SR);
    const l = new Float32Array(n).fill(0.3);
    const r = new Float32Array(n).fill(0.3);
    c.run(l, r);
    expect(peak(l, n / 2)).toBeLessThan(1e-3);

    const low = sine(30, 1, 0.3);
    const lowR = low.slice();
    new VoiceCleaner(SR).run(low, lowR);
    expect(dB(rms(low, n / 2)) - dB(0.3 / Math.SQRT2)).toBeLessThan(-12);

    const voice = sine(400, 1, 0.3);
    const voiceR = voice.slice();
    new VoiceCleaner(SR).run(voice, voiceR);
    expect(Math.abs(dB(rms(voice, n / 2)) - dB(0.3 / Math.SQRT2))).toBeLessThan(0.3);
  });

  it('applies the makeup gain', () => {
    const x = sine(500, 1, 0.05);
    const y = x.slice();
    new VoiceCleaner(SR, { makeup: 2 }).run(x, y);
    expect(Math.abs(dB(rms(x, SR / 2)) - dB((0.05 * 2) / Math.SQRT2))).toBeLessThan(0.3);
  });

  it('turns quiet background noise down between phrases without touching speech-level sound', () => {
    // 1 s of speech-level tone, then 2 s of low noise at about −60 dBFS
    const tone = sine(300, 1, 0.18);
    const hiss = noise(SR * 2, 0.0017);
    const make = () => {
      const x = new Float32Array(tone.length + hiss.length);
      x.set(tone);
      x.set(hiss, tone.length);
      return x;
    };
    const off = make();
    const on = make();
    new VoiceCleaner(SR, { expander: false }).run(off, off.slice());
    new VoiceCleaner(SR, { expander: true }).run(on, on.slice());
    // speech passes unchanged
    expect(Math.abs(dB(rms(on, SR * 0.3, SR * 0.9)) - dB(rms(off, SR * 0.3, SR * 0.9)))).toBeLessThan(0.1);
    // the noise tail ends up clearly lower, but not silenced (it is an expander, not a gate)
    const drop = dB(rms(on, SR * 2, SR * 3)) - dB(rms(off, SR * 2, SR * 3));
    expect(drop).toBeLessThan(-8);
    expect(drop).toBeGreaterThanOrEqual(VOICE_CLEANUP.expanderFloorDb - 0.5);
  });

  it('holds peaks under the ceiling', () => {
    const x = sine(250, 1, 0.5);
    for (let i = SR * 0.4; i < SR * 0.6; i++) x[i] = x[i]! * 6; // a burst far over full scale
    const y = x.slice();
    new VoiceCleaner(SR).run(x, y);
    const ceiling = Math.pow(10, VOICE_CLEANUP.ceilingDb / 20);
    expect(peak(x)).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(peak(y)).toBeLessThanOrEqual(ceiling + 1e-6);
    // the limiter lets go again afterwards
    expect(Math.abs(dB(rms(x, SR * 0.85, SR)) - dB(0.5 / Math.SQRT2))).toBeLessThan(0.5);
  });

  it('is deterministic and does not depend on block size', () => {
    const src = noise(SR, 0.4).map((v, i) => v + 0.3 * Math.sin(i / 20));
    const whole = src.slice();
    new VoiceCleaner(SR, { makeup: 1.7, expander: true }).run(whole, whole.slice());
    const blocks = src.slice();
    const br = src.slice();
    const c = new VoiceCleaner(SR, { makeup: 1.7, expander: true });
    for (let o = 0; o < blocks.length; ) {
      const n = Math.min(blocks.length - o, 1 + ((o * 7) % 997));
      c.run(blocks.subarray(o, o + n), br.subarray(o, o + n));
      o += n;
    }
    expect(Array.from(blocks)).toEqual(Array.from(whole));
  });

  it('reports the delay it adds', () => {
    const c = new VoiceCleaner(SR);
    expect(c.latency).toBe(Math.round((VOICE_CLEANUP.lookaheadMs / 1000) * SR));
    const x = new Float32Array(1000);
    x[0] = 0.5;
    const y = x.slice();
    // an impulse comes out `latency` samples later (the filter only reshapes it)
    c.run(x, y);
    let first = -1;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > 0.05) { first = i; break; }
    expect(first).toBe(c.latency);
  });
});
