/**
 * Audio processing shared by the exporter and the preview. Pure number
 * crunching: no DOM, no WebAudio, no randomness, so the same input always
 * gives the same samples and the file can be loaded inside an AudioWorklet.
 */

// ───────────────────────────── time stretch (WSOLA) ─────────────────────────────

export interface StereoBlock {
  l: Float32Array;
  r: Float32Array;
}

/** Supplies `count` input frames starting at `start`. Called with strictly increasing, contiguous spans. */
export type StretchFetch = (start: number, count: number) => Promise<StereoBlock> | StereoBlock;

/**
 * Changes the speed of audio without changing its pitch (waveform-similarity
 * overlap-add). Input is pulled on demand, so a long section never has to sit
 * in memory, and nothing outside [0, inputFrames) is ever requested: audio from
 * a neighbouring cut cannot leak in.
 */
export class TimeStretcher {
  readonly window: number;
  readonly hop: number;
  readonly search: number;
  private readonly win: Float32Array;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  private bufStart = 0;
  private fetched = 0;
  /** Overlap-add accumulator; index 0 is output frame `accStart`. */
  private accL: Float32Array;
  private accR: Float32Array;
  private accStart = 0;
  private frame = 0;
  private prevChosen = 0;
  private ready = 0; // finished output frames waiting in the accumulator

  constructor(
    readonly speed: number,
    readonly inputFrames: number,
    private fetch: StretchFetch,
    sampleRate = 48000,
  ) {
    // 30 ms windows with half overlap suit speech; the search covers one pitch period of a low voice.
    this.hop = Math.max(64, Math.round(sampleRate * 0.015));
    this.window = this.hop * 2;
    this.search = Math.max(32, Math.round(sampleRate * 0.01));
    this.win = new Float32Array(this.window);
    for (let i = 0; i < this.window; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.window);
    this.accL = new Float32Array(this.window * 4);
    this.accR = new Float32Array(this.window * 4);
  }

  /** Make input frames [a, b) available in the sliding buffer. */
  private async ensure(a: number, b: number) {
    const from = Math.max(0, a);
    if (b > this.fetched) {
      const want = Math.min(this.inputFrames, Math.max(b, this.fetched + this.window * 8));
      const count = Math.max(0, want - this.fetched);
      if (count > 0) {
        const got = await this.fetch(this.fetched, count);
        // slow speeds can step slightly backwards, so a little history stays in the buffer
        const keepFrom = Math.max(this.bufStart, Math.min(from, this.fetched) - this.window - 2 * this.search);
        const keep = this.fetched - keepFrom;
        const nl = new Float32Array(keep + count);
        const nr = new Float32Array(keep + count);
        nl.set(this.bufL.subarray(keepFrom - this.bufStart, keepFrom - this.bufStart + keep));
        nr.set(this.bufR.subarray(keepFrom - this.bufStart, keepFrom - this.bufStart + keep));
        nl.set(got.l.subarray(0, count), keep);
        nr.set(got.r.subarray(0, count), keep);
        this.bufL = nl;
        this.bufR = nr;
        this.bufStart = keepFrom;
        this.fetched += count;
      }
    }
  }

  private at(buf: Float32Array, i: number): number {
    const k = i - this.bufStart;
    return k >= 0 && k < buf.length ? buf[k]! : 0;
  }

  /** Where to take the next window from: near `target`, where it best continues the previous window. */
  private choose(target: number): number {
    const natural = this.prevChosen + this.hop;
    const lo = Math.max(0, target - this.search);
    const hi = Math.max(lo, Math.min(target + this.search, Math.max(0, this.inputFrames - this.hop)));
    if (natural >= lo && natural <= hi && Math.abs(natural - target) <= 1) return natural;
    const STEP = 4; // compare every fourth sample; plenty for speech
    const n = this.hop;
    const ref = new Float32Array(Math.ceil(n / STEP));
    for (let i = 0, j = 0; i < n; i += STEP, j++) ref[j] = this.at(this.bufL, natural + i) + this.at(this.bufR, natural + i);
    let best = Math.min(hi, Math.max(lo, target));
    let bestScore = -Infinity;
    for (let c = lo; c <= hi; c++) {
      let dot = 0;
      let energy = 1e-9;
      for (let i = 0, j = 0; i < n; i += STEP, j++) {
        const v = this.at(this.bufL, c + i) + this.at(this.bufR, c + i);
        dot += v * ref[j]!;
        energy += v * v;
      }
      const score = dot / Math.sqrt(energy);
      // prefer the nominal position when candidates are equally good (silence, steady tones)
      if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && Math.abs(c - target) < Math.abs(best - target))) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private async synthesise() {
    const { hop, window: N } = this;
    const target = Math.round(this.frame * hop * this.speed);
    await this.ensure(Math.min(target - this.search, this.prevChosen), Math.max(target + this.search, this.prevChosen + hop) + N + 1);
    const chosen = this.frame === 0 ? 0 : this.choose(target);
    const at = this.frame * hop - this.accStart;
    if (at + N > this.accL.length) {
      const nl = new Float32Array(Math.max(this.accL.length * 2, at + N));
      const nr = new Float32Array(nl.length);
      nl.set(this.accL);
      nr.set(this.accR);
      this.accL = nl;
      this.accR = nr;
    }
    for (let i = 0; i < N; i++) {
      // the very first half-window has nothing to overlap with, so it is not faded in
      const w = this.frame === 0 && i < hop ? 1 : this.win[i]!;
      this.accL[at + i] = this.accL[at + i]! + this.at(this.bufL, chosen + i) * w;
      this.accR[at + i] = this.accR[at + i]! + this.at(this.bufR, chosen + i) * w;
    }
    this.prevChosen = chosen;
    this.frame++;
    this.ready = this.frame * hop - this.accStart;
  }

  /** The next `n` output frames. */
  async render(n: number): Promise<StereoBlock> {
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    let done = 0;
    while (done < n) {
      if (this.ready <= 0) await this.synthesise();
      const take = Math.min(this.ready, n - done);
      l.set(this.accL.subarray(0, take), done);
      r.set(this.accR.subarray(0, take), done);
      this.accL.copyWithin(0, take);
      this.accR.copyWithin(0, take);
      this.accL.fill(0, this.accL.length - take);
      this.accR.fill(0, this.accR.length - take);
      this.accStart += take;
      this.ready -= take;
      done += take;
    }
    return { l, r };
  }
}

/** Stretch a whole buffer at once. `speed` 2 halves the length; 0.5 doubles it. */
export async function stretch(input: StereoBlock, speed: number, sampleRate = 48000): Promise<StereoBlock> {
  const total = input.l.length;
  const s = new TimeStretcher(speed, total, (start, count) => ({ l: input.l.subarray(start, start + count), r: input.r.subarray(start, start + count) }), sampleRate);
  return s.render(Math.round(total / speed));
}

// ───────────────────────────── voice cleanup ─────────────────────────────

export interface VoiceCleanerOptions {
  /** Linear gain that brings loud speech to about −18 dBFS. */
  makeup?: number;
  /**
   * Turn background noise down between phrases. Only meaningful when `makeup`
   * came from a measured speech level, because the threshold sits a fixed
   * distance below normal speech.
   */
  expander?: boolean;
}

export const VOICE_CLEANUP = {
  highPassHz: 85,
  /** Below this level (dBFS, after makeup) the expander starts to turn the signal down. */
  expanderThresholdDb: -48,
  /** 2:1 downward: every dB below the threshold becomes two. */
  expanderRatio: 2,
  /** Never more than this much reduction, so room tone fades rather than vanishes. */
  expanderFloorDb: -12,
  /** Peaks are held under this level (dBFS). */
  ceilingDb: -1,
  /** Look-ahead of the limiter, which is also the delay the chain adds. */
  lookaheadMs: 3,
} as const;

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));
const lin = (d: number) => Math.pow(10, d / 20);

/**
 * The cleanup chain for the master voice: rumble filter, level makeup, a gentle
 * downward expander, and a look-ahead limiter. Stateful and streaming: feed it
 * consecutive blocks. Adds `lookaheadMs` of delay.
 */
export class VoiceCleaner {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private zl1 = 0;
  private zl2 = 0;
  private zr1 = 0;
  private zr2 = 0;
  private readonly makeup: number;
  private readonly expander: boolean;
  private env = 0;
  private expGain = 1;
  private readonly envAttack: number;
  private readonly envRelease: number;
  private readonly gainOpen: number;
  private readonly gainClose: number;
  private readonly ceiling: number;
  private readonly look: number;
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  private readonly need: Float32Array;
  private pos = 0;
  private limGain = 1;
  private readonly limAttack: number;
  private readonly limRelease: number;

  constructor(sampleRate = 48000, opts: VoiceCleanerOptions = {}) {
    // RBJ high-pass, Q = 1/√2: the same response as the BiquadFilterNode default.
    const w0 = (2 * Math.PI * VOICE_CLEANUP.highPassHz) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.makeup = opts.makeup ?? 1;
    this.expander = opts.expander ?? false;
    const coef = (ms: number) => 1 - Math.exp(-1 / ((ms / 1000) * sampleRate));
    // The detector falls 30 dB in about 140 ms, so the gaps between words are left alone and only
    // real pauses are turned down; the gain itself then eases shut and snaps open.
    this.envAttack = coef(4);
    this.envRelease = coef(40);
    this.gainOpen = coef(6);
    this.gainClose = coef(120);
    this.ceiling = lin(VOICE_CLEANUP.ceilingDb);
    this.look = Math.max(1, Math.round((VOICE_CLEANUP.lookaheadMs / 1000) * sampleRate));
    this.dl = new Float32Array(this.look);
    this.dr = new Float32Array(this.look);
    this.need = new Float32Array(this.look).fill(1);
    this.limAttack = 1 - Math.exp(-1 / (this.look / 5));
    this.limRelease = coef(90);
  }

  /** Delay added by the chain, in samples. */
  get latency(): number {
    return this.look;
  }

  /**
   * Empty the look-ahead delay line. Called at a cut, so the last few
   * milliseconds before the cut cannot come out after it.
   */
  flush(): void {
    this.dl.fill(0);
    this.dr.fill(0);
    this.need.fill(1);
  }

  /** Process in place. */
  run(l: Float32Array, r: Float32Array): void {
    const { b0, b1, b2, a1, a2, makeup, look } = this;
    const T = VOICE_CLEANUP.expanderThresholdDb;
    const slope = VOICE_CLEANUP.expanderRatio - 1;
    const floor = VOICE_CLEANUP.expanderFloorDb;
    for (let i = 0; i < l.length; i++) {
      // 1. rumble filter (transposed direct form II)
      const xl = l[i]!;
      let yl = b0 * xl + this.zl1;
      this.zl1 = b1 * xl - a1 * yl + this.zl2;
      this.zl2 = b2 * xl - a2 * yl;
      const xr = r[i]!;
      let yr = b0 * xr + this.zr1;
      this.zr1 = b1 * xr - a1 * yr + this.zr2;
      this.zr2 = b2 * xr - a2 * yr;
      // 2. level
      yl *= makeup;
      yr *= makeup;
      // 3. downward expander on the louder channel, so the stereo image does not move
      if (this.expander) {
        const peak = Math.max(Math.abs(yl), Math.abs(yr));
        this.env += (peak - this.env) * (peak > this.env ? this.envAttack : this.envRelease);
        const level = db(this.env);
        const want = level >= T ? 1 : lin(Math.max(floor, (level - T) * slope));
        this.expGain += (want - this.expGain) * (want > this.expGain ? this.gainOpen : this.gainClose);
        yl *= this.expGain;
        yr *= this.expGain;
      }
      // 4. look-ahead limiter: the gain is already down when the peak leaves the delay line
      const peak = Math.max(Math.abs(yl), Math.abs(yr));
      const p = this.pos;
      const outL = this.dl[p]!;
      const outR = this.dr[p]!;
      this.dl[p] = yl;
      this.dr[p] = yr;
      this.need[p] = peak > this.ceiling ? this.ceiling / peak : 1;
      this.pos = p + 1 === look ? 0 : p + 1;
      let min = 1;
      for (let k = 0; k < look; k++) if (this.need[k]! < min) min = this.need[k]!;
      this.limGain += (min - this.limGain) * (min < this.limGain ? this.limAttack : this.limRelease);
      let ol = outL * this.limGain;
      let or = outR * this.limGain;
      // whatever the smoothing let through is clamped, so the ceiling is a guarantee
      if (ol > this.ceiling) ol = this.ceiling;
      else if (ol < -this.ceiling) ol = -this.ceiling;
      if (or > this.ceiling) or = this.ceiling;
      else if (or < -this.ceiling) or = -this.ceiling;
      l[i] = ol;
      r[i] = or;
    }
    // keep denormals out of the recursive state
    if (Math.abs(this.zl1) < 1e-20) this.zl1 = 0;
    if (Math.abs(this.zl2) < 1e-20) this.zl2 = 0;
    if (Math.abs(this.zr1) < 1e-20) this.zr1 = 0;
    if (Math.abs(this.zr2) < 1e-20) this.zr2 = 0;
  }
}
