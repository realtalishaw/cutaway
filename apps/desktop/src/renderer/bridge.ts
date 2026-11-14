/**
 * Builds window.cutaway from the preload's raw bridge. Async calls arrive as
 * { __ok, value | code, message } envelopes (contextBridge cannot carry error
 * codes); failures are rethrown here as Errors with a `code` property.
 */
import type { CutawayApi } from '@shared/api';

const SYNC = new Set(['app.onMenu', 'app.pathForFile', 'record.onEvent', 'media.url', 'app.onCountdown', 'app.onCountdownCancel', 'app.onSelfView', 'record.onPreview', 'gen.onStatus', 'motion.onProgress', 'ai.onProgress', 'app.onPrompter']);

interface Envelope {
  __ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

const raw = (window as unknown as { cutawayBridge?: Record<string, Record<string, (...a: unknown[]) => unknown>> }).cutawayBridge;

if (raw && !(window as unknown as { cutaway?: unknown }).cutaway) {
  const api: Record<string, Record<string, unknown>> = {};
  for (const [nsName, ns] of Object.entries(raw)) {
    api[nsName] = {};
    for (const [name, fn] of Object.entries(ns)) {
      api[nsName]![name] = SYNC.has(`${nsName}.${name}`)
        ? fn
        : async (...args: unknown[]) => {
            const r = (await fn(...args)) as Envelope;
            if (r && r.__ok === false) throw Object.assign(new Error(r.message ?? 'Something went wrong.'), { code: r.code ?? 'error' });
            return r?.value;
          };
    }
  }
  (window as unknown as { cutaway: CutawayApi }).cutaway = api as unknown as CutawayApi;
}
