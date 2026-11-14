/**
 * Cutaway AI layer — the OpenAI Codex CLI as a second provider. Like the
 * Claude runner it uses the app already installed and signed in on this Mac
 * (`codex exec`), so there is no API key.
 *
 * Safety properties:
 *  - always `--sandbox read-only`; the approval and sandbox bypass flags are
 *    never passed, and a non-interactive run cannot ask for approval, so the
 *    model cannot change a file or run a command that writes;
 *  - `--ignore-user-config`, `--ignore-rules` and `--ephemeral`: the creator's
 *    own Codex plugins, MCP servers and saved sessions are left out of it;
 *  - still frames are attached as images, the reply is constrained by a JSON
 *    Schema and comes back as plain data;
 *  - the same environment rules as the Claude runner (the creator's login
 *    shell, minus anything a host session set).
 *
 * Image generation uses the CLI's built-in image tool. That tool does not
 * take a destination: it writes under $CODEX_HOME/generated_images/<thread>/,
 * so the picture is picked up there and copied into the project.
 */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { EXTRA_DIRS, claudeEnv, imagesInsideDir, isExecutable, loginShellContext, spawnClaude, type ClaudeRunOptions, type ClaudeRunResult, type ClaudeStatus } from './node';
import { ART_REPLY_SCHEMA, stripNulls, toStrictSchema } from './provider';

/** Locate the Codex CLI: explicit path, then the login shell's answer, then PATH, then the usual install locations. */
export async function findCodex(preferredPath?: string | null, env?: NodeJS.ProcessEnv): Promise<string | null> {
  if (preferredPath && isAbsolute(preferredPath) && (await isExecutable(preferredPath))) return preferredPath;
  if (!env) {
    for (const p of (await loginShellContext()).codexPaths) if (await isExecutable(p)) return p;
  }
  const dirs = [...((env ?? process.env).PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS()];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    const candidate = join(d, 'codex');
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

const NOT_SIGNED_IN = /not logged in|not signed in|please (run|use) [`'"]?codex login|login required|401 unauthorized|invalid[_ ]api[_ ]key|token (is )?(expired|invalid|revoked)|refresh token/i;

function signInMessage(): string {
  return 'Codex on this Mac is not signed in. Choose Sign in to Codex in Settings (or run "codex login" in Terminal), then try again.';
}

export interface CodexArgs {
  cwd: string;
  schemaFile: string;
  outFile: string;
  images?: string[];
  model?: string | null;
  /** Low reasoning effort, for requests that are mostly writing. */
  fast?: boolean;
}

/** Arguments for one structured, non-interactive call. The prompt is read from stdin. Exported for tests. */
export function buildCodexArgs(a: CodexArgs): string[] {
  const args = ['exec'];
  // `--image` takes several values, so each still gets its own flag and other options follow it.
  for (const img of a.images ?? []) args.push('--image', img);
  args.push('--json', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--cd', a.cwd, '--output-schema', a.schemaFile, '--output-last-message', a.outFile);
  if (a.model && a.model.trim()) args.push('--model', a.model.trim());
  if (a.fast) args.push('-c', 'model_reasoning_effort="low"');
  args.push('-');
  return args;
}

export interface CodexEvents {
  threadId: string | null;
  /** Text of the last agent message. */
  lastMessage: string | null;
  /** Failure reported by the CLI, if any. */
  error: string | null;
  tokens: { input: number; output: number } | null;
}

/** Read the `--json` event stream. Pure. */
export function parseCodexEvents(stdout: string): CodexEvents {
  const out: CodexEvents = { threadId: null, lastMessage: null, error: null, tokens: null };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = e.item && typeof e.item === 'object' ? (e.item as Record<string, unknown>) : null;
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') out.threadId = e.thread_id;
    else if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') out.lastMessage = item.text;
    else if (e.type === 'turn.failed') {
      const err = e.error && typeof e.error === 'object' ? (e.error as Record<string, unknown>).message : e.error;
      out.error = typeof err === 'string' && err ? err : 'The request failed.';
    } else if (e.type === 'error' && typeof e.message === 'string') out.error = e.message;
    else if (e.type === 'turn.completed' && e.usage && typeof e.usage === 'object') {
      const u = e.usage as Record<string, unknown>;
      out.tokens = { input: typeof u.input_tokens === 'number' ? u.input_tokens : 0, output: typeof u.output_tokens === 'number' ? u.output_tokens : 0 };
    }
    // An `item.completed` of type "error" before the turn is a warning (for example about preview features), not a failure.
  }
  return out;
}

function parseJsonReply(text: string | null): unknown {
  if (!text) return undefined;
  const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return undefined;
}

/** Turn a finished run into a result. Pure, apart from the reply text being passed in. */
export function parseCodexRun(stdout: string, stderr: string, exitCode: number | null, lastMessageFile: string | null): Omit<ClaudeRunResult, 'durationMs'> & { threadId: string | null } {
  const ev = parseCodexEvents(stdout);
  const threadId = ev.threadId;
  const failure = `${ev.error ?? ''}\n${exitCode === 0 ? '' : stderr}`;
  if (NOT_SIGNED_IN.test(failure)) return { ok: false, error: { code: 'not-signed-in', message: signInMessage() }, threadId };
  if (ev.error) return { ok: false, error: { code: 'failed', message: `Codex reported an error: ${ev.error.slice(0, 300)}` }, threadId };
  const data = parseJsonReply(lastMessageFile && lastMessageFile.trim() ? lastMessageFile : ev.lastMessage);
  if (data === undefined || data === null || typeof data !== 'object') {
    if (exitCode !== 0) {
      const hint = stderr.trim().split('\n').filter((l) => !/ERROR (codex_core::session|rmcp|codex_rmcp_client)/.test(l)).slice(-2).join(' ').slice(0, 300);
      return { ok: false, error: { code: 'failed', message: hint ? `Codex did not return a result: ${hint}` : 'Codex did not return a result.' }, threadId };
    }
    return { ok: false, error: { code: 'bad-output', message: 'Codex replied, but not with the structured data Cutaway asked for.' }, threadId };
  }
  return { ok: true, data: stripNulls(data), costUsd: null, model: null, threadId };
}

/** Appended to prompts written for a file-reading model: with Codex the stills arrive as attachments. */
export function attachmentNote(count: number): string {
  if (count === 0) return '\n\nYou cannot and need not run commands or read files: everything you need is in this message.';
  return `\n\nNOTE ON THE STILL FRAMES: the ${count === 1 ? 'still frame listed above is attached to this message as an image' : `${count} still frames listed above are attached to this message as images, in the order listed`}. Look at the attachments instead of reading files. Do not run commands.`;
}

interface RawRun {
  result: Omit<ClaudeRunResult, 'durationMs'> & { threadId: string | null };
  env: NodeJS.ProcessEnv;
}

async function execCodex(path: string, opts: { prompt: string; schema: unknown; cwd: string | null; images: string[]; model?: string | null; fast?: boolean; signal?: AbortSignal; timeoutMs: number }): Promise<RawRun | { stopped: 'cancelled' | 'timeout' | 'spawn'; message: string }> {
  const work = await mkdtemp(join(tmpdir(), 'cutaway-codex-'));
  try {
    const schemaFile = join(work, 'schema.json');
    const outFile = join(work, 'reply.json');
    await writeFile(schemaFile, JSON.stringify(toStrictSchema(opts.schema)));
    const env = await claudeEnv(path);
    const run = await spawnClaude(path, buildCodexArgs({ cwd: opts.cwd ?? work, schemaFile, outFile, images: opts.images, model: opts.model, fast: opts.fast }), opts.prompt, { cwd: opts.cwd ?? work, env, signal: opts.signal, timeoutMs: opts.timeoutMs });
    if (run.aborted) return { stopped: 'cancelled', message: 'Cancelled.' };
    if (run.timedOut) return { stopped: 'timeout', message: 'Codex did not answer in time. Nothing was changed.' };
    if (run.spawnError) return { stopped: 'spawn', message: `Could not start Codex: ${run.spawnError}` };
    const last = await readFile(outFile, 'utf8').catch(() => null);
    return { result: parseCodexRun(run.stdout, run.stderr, run.code, last), env };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Run one structured prompt through the local Codex CLI. Same contract as `runClaude`. */
export async function runCodex(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (opts.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 0 };
  const images = opts.imagePaths ?? [];
  if (!imagesInsideDir(opts.imageDir, images)) return { ok: false, error: { code: 'failed', message: 'Still frames must be inside the project cache folder.' }, durationMs: elapsed() };
  const path = await findCodex(opts.claudePath);
  if (!path) return { ok: false, error: { code: 'not-found', message: 'Codex is not installed on this Mac (no "codex" command was found).' }, durationMs: elapsed() };
  const r = await execCodex(path, { prompt: opts.prompt + attachmentNote(images.length), schema: opts.schema, cwd: images.length ? opts.imageDir! : null, images, model: opts.model, fast: opts.fast, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 12 * 60_000 });
  if ('stopped' in r) return { ok: false, error: { code: r.stopped === 'spawn' ? 'failed' : r.stopped, message: r.message }, durationMs: elapsed() };
  const { threadId: _thread, ...result } = r.result;
  return { ...result, durationMs: elapsed() };
}

/** Is the CLI installed and signed in? `codex login status` makes no model call. */
export async function codexStatus(preferredPath?: string | null, signal?: AbortSignal): Promise<ClaudeStatus> {
  const path = await findCodex(preferredPath);
  if (!path) return { found: false, path: null, version: null, signedIn: null, message: 'Codex is not installed on this Mac. Install it and sign in, and Cutaway can use it.' };
  const env = await claudeEnv(path);
  const cwd = tmpdir();
  const v = await spawnClaude(path, ['--version'], null, { cwd, env, signal, timeoutMs: 15_000 });
  const version = v.code === 0 ? (v.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
  const a = await spawnClaude(path, ['login', 'status'], null, { cwd, env, signal, timeoutMs: 20_000 });
  const text = `${a.stdout}\n${a.stderr}`;
  const signedIn = /not logged in|not signed in/i.test(text) ? false : /logged in/i.test(text) ? true : null;
  const message = signedIn === true ? `Codex ${version ?? ''} is signed in.`.replace('  ', ' ') : signedIn === false ? signInMessage() : `Codex ${version ?? ''} was found, but its sign-in state could not be read. Cutaway will try it and fall back to built-in rules if it fails.`.replace('  ', ' ');
  return { found: true, path, version, signedIn, message };
}

// ───────────────────────── image generation ─────────────────────────

export interface CodexImageOptions {
  codexPath?: string | null;
  /** The whole instruction, including the rules. See `buildArtPrompt`. */
  prompt: string;
  /** Stills attached for context. */
  referenceImages?: string[];
  /** Where the picture is copied to. Its folder is created. */
  outFile: string;
  model?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CodexImageResult {
  ok: boolean;
  /** `outFile`, when a picture was made. */
  path?: string;
  /** The model's one-line description of the picture. */
  note?: string;
  error?: ClaudeRunResult['error'];
  durationMs: number;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Where the CLI keeps what its image tool makes, for one run. */
export function generatedImagesDir(env: NodeJS.ProcessEnv, threadId: string): string {
  const home = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(env.HOME ?? homedir(), '.codex');
  return join(home, 'generated_images', threadId);
}

async function newestImage(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let best: { file: string; at: number } | null = null;
  for (const n of names) {
    if (!IMAGE_EXT.has(extname(n).toLowerCase())) continue;
    const file = join(dir, n);
    const st = await stat(file).catch(() => null);
    if (st?.isFile() && st.size > 0 && (!best || st.mtimeMs > best.at)) best = { file, at: st.mtimeMs };
  }
  return best?.file ?? null;
}

/**
 * Make one picture with the CLI's built-in image tool and copy it to
 * `outFile`. The original stays where Codex put it; that folder is the
 * creator's own Codex data.
 */
export async function generateCodexImage(opts: CodexImageOptions): Promise<CodexImageResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (opts.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 0 };
  if (!isAbsolute(opts.outFile)) return { ok: false, error: { code: 'failed', message: 'The picture needs an absolute destination.' }, durationMs: 0 };
  const path = await findCodex(opts.codexPath);
  if (!path) return { ok: false, error: { code: 'not-found', message: 'Codex is not installed on this Mac (no "codex" command was found).' }, durationMs: elapsed() };
  const r = await execCodex(path, { prompt: opts.prompt, schema: ART_REPLY_SCHEMA, cwd: null, images: opts.referenceImages ?? [], model: opts.model, signal: opts.signal, timeoutMs: opts.timeoutMs ?? 6 * 60_000 });
  if ('stopped' in r) return { ok: false, error: { code: r.stopped === 'spawn' ? 'failed' : r.stopped, message: r.message }, durationMs: elapsed() };
  if (!r.result.ok) return { ok: false, error: r.result.error, durationMs: elapsed() };
  const reply = r.result.data as { generated?: unknown; note?: unknown };
  const note = typeof reply.note === 'string' ? reply.note.slice(0, 300) : '';
  const made = r.result.threadId ? await newestImage(generatedImagesDir(r.env, r.result.threadId)) : null;
  if (!made) {
    return { ok: false, error: { code: 'failed', message: reply.generated === false && note ? `Codex did not make a picture: ${note}` : 'Codex answered, but no picture was made. Image generation may not be available on this account.' }, durationMs: elapsed() };
  }
  // Keep the file type the tool produced.
  const dest = opts.outFile.replace(/\.[a-z0-9]+$/i, '') + extname(made).toLowerCase();
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(made, dest);
  return { ok: true, path: dest, note, durationMs: elapsed() };
}
