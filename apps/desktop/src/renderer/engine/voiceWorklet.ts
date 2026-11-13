/**
 * AudioWorklet that runs the export's voice cleanup chain on the preview's
 * master voice, so what you hear while editing is what the export contains.
 * Loaded as its own module; talks to the page only through its message port.
 */
import { VoiceCleaner } from './audioDsp';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

interface Params {
  on: boolean;
  makeup: number;
  expander: boolean;
}

class VoiceCleanerProcessor extends AudioWorkletProcessor {
  private cleaner: VoiceCleaner | null = null;
  private params: Params = { on: false, makeup: 1, expander: false };
  private scratch = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Params>) => {
      const next = e.data;
      // a new level or mode needs fresh state; switching on and off does not
      if (!this.cleaner || next.makeup !== this.params.makeup || next.expander !== this.params.expander) this.cleaner = new VoiceCleaner(sampleRate, { makeup: next.makeup, expander: next.expander });
      this.params = next;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const l = output[0];
    const r = output[1];
    if (input && input[0]) {
      l.set(input[0]);
      r?.set(input[1] ?? input[0]);
    }
    if (this.params.on && this.cleaner) {
      if (r) this.cleaner.run(l, r);
      else {
        if (this.scratch.length !== l.length) this.scratch = new Float32Array(l.length);
        this.scratch.set(l);
        this.cleaner.run(l, this.scratch);
      }
    }
    return true;
  }
}

registerProcessor('cutaway-voice-cleaner', VoiceCleanerProcessor);
