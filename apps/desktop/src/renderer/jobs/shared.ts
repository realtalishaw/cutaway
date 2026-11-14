/**
 * Helpers shared by the processing jobs. Jobs only talk to window.cutaway,
 * @cutaway/core and @cutaway/ai.
 */
import { activeRanges, clipEnd, clipsOf, coverage, covers, playingClips, sentences, sourceAt, toSourceTime, type JobStage, type MediaSource, type Project, type Range, type Seconds } from '@cutaway/core';
import { PROVIDERS, type PromptAsset, type PromptKeyframe, type PromptSentence, type PromptSource, type ProviderId } from '@cutaway/ai';
import { resolveSourcePath, type AiRequest, type AiResult } from '../../shared/api';
import { JobError, type JobContext, type StageState } from './types';

export const STAGE_LABELS: Record<JobStage, string> = {
  validate: 'Check media',
  sync: 'Align sources',
  transcribe: 'Transcribe on this Mac',
  visual: 'Watch the screen',
  assemble: 'Assemble the cut',
  preview: 'Prepare preview',
  packaging: 'Thumbnails and titles',
  export: 'Export',
};

/** Tracks stage states and pushes an immutable copy to the UI on every change. */
export class Stager {
  private stages: StageState[];
  constructor(private ctx: JobContext, ids: JobStage[], remote: Partial<Record<JobStage, boolean>> = {}) {
    this.stages = ids.map((id) => ({ id, label: STAGE_LABELS[id], status: 'pending', detail: '', startedAt: null, endedAt: null, progress: null, remote: !!remote[id] }));
    this.push();
  }
  private push(): void {
    this.ctx.setStages(this.stages.map((s) => ({ ...s })));
  }
  patch(id: JobStage, patch: Partial<StageState>): void {
    this.stages = this.stages.map((s) => (s.id === id ? { ...s, ...patch } : s));
    this.push();
  }
  start(id: JobStage, detail: string): void {
    this.patch(id, { status: 'running', detail, startedAt: Date.now(), endedAt: null, progress: null });
  }
  detail(id: JobStage, detail: string, progress: number | null = null): void {
    this.patch(id, { detail, progress });
  }
  done(id: JobStage, detail: string): void {
    this.patch(id, { status: 'done', detail, endedAt: Date.now(), progress: null });
  }
  skip(id: JobStage, detail: string): void {
    this.patch(id, { status: 'skipped', detail, endedAt: Date.now(), progress: null });
  }
  fail(id: JobStage, detail: string): void {
    this.patch(id, { status: 'failed', detail, endedAt: Date.now(), progress: null });
  }
}

export function checkAbort(ctx: JobContext, stage: JobStage): void {
  if (ctx.signal.aborted) throw new JobError(stage, 'cancelled', 'Cancelled. Finished stages are kept.', true);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

/** Error code carried by a rejected native call, if any. */
export function errorCode(e: unknown): string {
  const direct = (e as { code?: unknown } | null)?.code;
  if (typeof direct === 'string') return direct;
  const m = errorText(e).match(/\b(no-audio|speech-permission-denied|speech-model-unavailable|not-found|corrupt|unsupported-codec|protected|permission-denied)\b/);
  return m?.[1] ?? '';
}

export function filePath(ctx: JobContext, s: MediaSource): string {
  return resolveSourcePath(ctx.projectPath, s.path);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function fmt(t: Seconds): string {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ───────────────────────────── Claude availability ─────────────────────────────

export interface ClaudeGate {
  /** The provider that would answer (Claude Code or Codex). */
  provider: ProviderId;
  /** "Claude" or "Codex": how to name it in a sentence. */
  name: string;
  /** "Claude Code" or "Codex": the app on this Mac. */
  app: string;
  usable: boolean;
  /** Why it will not be used; null when usable. */
  reason: string | null;
  /** The creator allowed it, but it is not available. */
  fellBack: boolean;
}

/**
 * Test hook, honoured only in runs started with CUTAWAY_E2E: canned provider
 * replies, so AI flows can be exercised with the CLIs switched off. A reply
 * is data or a function of the request; `{ error }` makes the call fail.
 */
export interface FakeAi {
  replies: (unknown | ((req: Omit<AiRequest, 'id'>) => unknown))[];
  /** Requests it was asked, for assertions. */
  seen: { purpose: string; prompt: string; images: number }[];
}

function fakeAi(): FakeAi | null {
  if (typeof window === 'undefined' || typeof location === 'undefined') return null;
  if (!new URLSearchParams(location.search).has('e2e')) return null;
  return (window as unknown as { __cutawayFakeAi?: FakeAi }).__cutawayFakeAi ?? null;
}

export async function claudeGate(ctx: JobContext): Promise<ClaudeGate> {
  const named = (id: ProviderId) => ({ provider: id, name: PROVIDERS[id].name, app: PROVIDERS[id].app });
  let who = named(ctx.provider ?? 'claude');
  // Declined: nothing is asked of either app, not even its sign-in state.
  if (!ctx.useClaude) return { ...who, usable: false, reason: `${who.name} was not used for this step, so nothing was sent off this Mac.`, fellBack: false };
  if (fakeAi()) return { ...who, usable: true, reason: null, fellBack: false };
  try {
    const st = await window.cutaway.ai.status();
    if (st.provider) who = named(st.provider);
    if (!st.found) return { ...who, usable: false, reason: `${who.app} is not installed on this Mac.`, fellBack: true };
    if (st.signedIn === false) return { ...who, usable: false, reason: `${who.app} on this Mac is not signed in.`, fellBack: true };
    return { ...who, usable: true, reason: null, fellBack: false };
  } catch (e) {
    return { ...who, usable: false, reason: `${who.app} could not be checked (${errorText(e)}).`, fellBack: true };
  }
}

/**
 * Successful replies, keyed by the exact request. If a later step of the same
 * job fails and the creator retries, the reply is reused instead of paying
 * for the same generation twice.
 */
const replyCache = new Map<string, unknown>();

function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}${s.length.toString(36)}`;
}

export function clearReplyCache(): void {
  replyCache.clear();
}

let seq = 0;

/** One structured Claude call with cancellation and retry-safe caching. */
/** `onProgress` hears how many characters of the answer have been written (Claude, streamed). */
export async function askClaude(ctx: JobContext, req: Omit<AiRequest, 'id'>, onProgress?: (chars: number) => void): Promise<AiResult & { reused: boolean }> {
  const fake = fakeAi();
  if (fake) {
    fake.seen.push({ purpose: req.purpose, prompt: req.prompt, images: req.imagePaths?.length ?? 0 });
    const next = fake.replies.shift();
    const data = typeof next === 'function' ? (next as (r: typeof req) => unknown)(req) : next;
    // the test provider "writes" its reply in a few steps, so progress can be seen
    if (onProgress && data !== undefined) {
      const total = JSON.stringify(data).length;
      for (const f of [0.3, 0.7, 1]) {
        onProgress(Math.round(total * f));
        await new Promise((r) => setTimeout(r, Number((window as unknown as { __cutawayFakeAiDelay?: number }).__cutawayFakeAiDelay ?? 0)));
      }
    }
    if (data === undefined) return { ok: false, error: { code: 'failed', message: 'The test provider has no reply queued.' }, durationMs: 0, reused: false };
    if (data && typeof data === 'object' && 'error' in data) return { ok: false, error: { code: 'failed', message: String((data as { error: unknown }).error) }, durationMs: 0, reused: false };
    return { ok: true, data, durationMs: 1, reused: false };
  }
  const key = hash(`${req.purpose}\n${req.prompt}\n${JSON.stringify(req.schema)}`);
  if (replyCache.has(key)) return { ok: true, data: replyCache.get(key), durationMs: 0, reused: true };
  const id = `ai_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const onAbort = () => void window.cutaway.ai.cancel(id).catch(() => undefined);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const stop = onProgress ? window.cutaway.ai.onProgress((p) => p.id === id && onProgress(p.chars)) : null;
  try {
    const res = await window.cutaway.ai.run({ ...req, id, ...(onProgress ? { progress: true } : {}) });
    if (res.ok && res.data !== undefined) replyCache.set(key, res.data);
    return { ...res, reused: false };
  } catch (e) {
    return { ok: false, error: { code: 'failed', message: errorText(e) }, durationMs: 0, reused: false };
  } finally {
    stop?.();
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

// ───────────────────────────── prompt inputs ─────────────────────────────

export function promptSources(project: Project): PromptSource[] {
  const timeline = project.sources.filter((s) => s.role === 'screen' || s.role === 'cameraA' || s.role === 'cameraB' || s.role === 'voice');
  const describe = (s: MediaSource): PromptSource => ({ id: s.id, role: s.role, name: s.name, duration: s.duration, coverage: coverage(s), hasAudio: s.hasAudio, cursorTelemetry: !s.cursorBaked && !!s.cursorFile });
  const clips = playingClips(clipsOf(project));
  if (clips.length < 2) return timeline.map(describe);
  // Several clips: say which clip each source belongs to, and leave out footage that is off the timeline.
  const out: PromptSource[] = [];
  clips.forEach((c, i) => {
    const range = { start: c.start, end: clipEnd(c) };
    for (const s of timeline) {
      if (!s.window || s.window.start > range.start + 1e-6 || s.window.end < range.end - 1e-6) continue;
      const cov = coverage(s).flatMap((r) => (r.end > range.start && r.start < range.end ? [{ start: Math.max(r.start, range.start), end: Math.min(r.end, range.end) }] : []));
      out.push({ ...describe(s), coverage: cov, clip: { index: i + 1, name: c.name, ...range } });
    }
  });
  return out;
}

export function promptAssets(project: Project): PromptAsset[] {
  return project.sources
    .filter((s) => (s.role === 'broll' || s.role === 'image') && s.available)
    .map((s) => ({ id: s.id, name: s.name, kind: s.kind === 'image' ? ('image' as const) : ('video' as const), duration: s.duration, tags: s.tags ?? [], note: s.note }));
}

export function promptSentences(project: Project, within?: Range): PromptSentence[] {
  const words = project.transcript?.words ?? [];
  return sentences(words)
    .filter((s) => !within || (s.end > within.start && s.start < within.end))
    .map((s) => ({ index: s.index, start: s.start, end: s.end, text: s.wordIds.map((id) => project.edit.wordText[id] ?? words.find((w) => w.id === id)?.text ?? '').join(' ') }));
}

export interface ClickCluster extends Range {
  count: number;
  x: number;
  y: number;
}

export function clusterClicks(clicks: { t: Seconds; x: number; y: number }[]): ClickCluster[] {
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const out: (ClickCluster & { last: { x: number; y: number } })[] = [];
  for (const c of sorted) {
    const cur = out[out.length - 1];
    if (cur && c.t - cur.end <= 3 && Math.hypot(c.x - cur.last.x, c.y - cur.last.y) < 0.35) {
      cur.x = (cur.x * cur.count + c.x) / (cur.count + 1);
      cur.y = (cur.y * cur.count + c.y) / (cur.count + 1);
      cur.count += 1;
      cur.end = c.t;
      cur.last = { x: c.x, y: c.y };
    } else out.push({ start: c.t, end: c.t, count: 1, x: c.x, y: c.y, last: { x: c.x, y: c.y } });
  }
  return out.map(({ last: _last, ...c }) => c);
}

export function screenActivity(project: Project): Range[] {
  const a = project.analysis;
  if (!a) return [];
  return activeRanges({ activity: a.activity, activityHz: a.activityHz || 4, clicks: a.clicks }, 0.4).map((r) => ({ start: r.start, end: Math.min(project.duration, r.end) }));
}

// ───────────────────────────── still frames ─────────────────────────────

export interface FrameWant {
  sessionTime: Seconds;
  role: 'screen' | 'cameraA' | 'cameraB';
}

export interface Still extends PromptKeyframe {
  path: string;
  sourceId: string;
  /** Time inside the source file. */
  sourceTime: Seconds;
}

/** Greedy pick of up to `max` times, highest priority first, at least `spacing` apart. */
export function spread(candidates: { t: Seconds; priority: number }[], max: number, spacing: Seconds): Seconds[] {
  const picked: Seconds[] = [];
  for (const c of [...candidates].sort((a, b) => b.priority - a.priority || a.t - b.t)) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p - c.t) >= spacing)) picked.push(c.t);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Extract stills for the model. Only frames that really exist (inside each
 * source's coverage) are requested; all results must share one directory,
 * which becomes the only place the model may read.
 */
export async function extractStills(ctx: JobContext, project: Project, wants: FrameWant[], width = 640): Promise<{ stills: Still[]; imageDir: string | null }> {
  const stills: Still[] = [];
  // A still comes from the source that plays that role in the clip at that moment. With several clips
  // the stills of all their files go to one folder, since the model may read one folder only.
  const several = !!project.edit.clips && project.sources.some((s) => s.window);
  const bySource = new Map<string, { src: MediaSource; role: FrameWant['role']; list: FrameWant[] }>();
  for (const w of wants) {
    const src = several ? sourceAt(project, w.role, w.sessionTime) : project.sources.find((s) => s.role === w.role && s.available && s.kind === 'video');
    if (!src || !src.available || src.kind !== 'video') continue;
    const key = `${w.role}|${src.id}`;
    const entry = bySource.get(key) ?? { src, role: w.role, list: [] };
    entry.list.push(w);
    bySource.set(key, entry);
  }
  for (const { src, role, list } of bySource.values()) {
    const usable = list.filter((w) => covers(src, w.sessionTime));
    if (usable.length === 0) continue;
    const times = usable.map((w) => Math.min(Math.max(0, toSourceTime(src.sync, w.sessionTime)), Math.max(0, src.duration - 0.05)));
    try {
      const frames = await window.cutaway.native.frames(ctx.projectPath, filePath(ctx, src), times, width, several);
      frames.forEach((f, i) => {
        // Results are matched by requested time; fall back to order.
        const j = times.findIndex((t) => Math.abs(t - f.t) < 1e-3);
        const want = usable[j >= 0 ? j : i];
        if (want && f.path) stills.push({ path: f.path, file: basename(f.path), sessionTime: want.sessionTime, source: role, sourceId: src.id, sourceTime: f.t });
      });
    } catch {
      // Stills are optional: the model is told when none are available.
    }
  }
  if (stills.length === 0) return { stills: [], imageDir: null };
  const imageDir = dirname(stills[0]!.path);
  const same = stills.filter((s) => dirname(s.path) === imageDir).sort((a, b) => a.sessionTime - b.sessionTime);
  return { stills: same, imageDir };
}
