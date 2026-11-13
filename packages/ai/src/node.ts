/**
 * Cutaway AI layer — Node part. Runs the Claude Code CLI that is already
 * installed and signed in on this Mac (`claude -p`), so no API key is needed.
 *
 * Safety properties:
 *  - the model gets no tools, or only `Read` when still frames are supplied,
 *    with the frame directory as its working directory. It can never run
 *    Bash, Write or Edit, and permission prompts are never bypassed;
 *  - the CLI is found and run the way the creator's own terminal runs it:
 *    through their login shell's PATH and environment, so "signed in in my
 *    terminal" and "signed in for Cutaway" are the same thing;
 *  - CLAUDE* and ANTHROPIC* variables inherited from whatever launched
 *    Cutaway are dropped first, so a host session's identity never leaks
 *    into the call (ones the creator's own shell profile sets are kept);
 *  - the reply is constrained by a JSON Schema and returned as plain data.
 */
import { spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve, sep } from 'node:path';

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  /** null = could not be determined. */
  signedIn: boolean | null;
  message: string;
}

export interface ClaudeRunOptions {
  /** Explicit CLI path; otherwise the CLI is searched for. */
  claudePath?: string | null;
  prompt: string;
  schema: Record<string, unknown>;
  /** Directory containing the still frames; becomes the working directory. */
  imageDir?: string | null;
  imagePaths?: string[];
  /** Model alias or id. Empty/undefined = the CLI's own default. */
  model?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ClaudeErrorCode = 'not-found' | 'not-signed-in' | 'cancelled' | 'timeout' | 'bad-output' | 'failed';

export interface ClaudeRunResult {
  ok: boolean;
  data?: unknown;
  error?: { code: ClaudeErrorCode; message: string };
  durationMs: number;
  costUsd?: number | null;
  model?: string | null;
}

export const EXTRA_DIRS = () => [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.claude', 'local')];

export async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── the creator's terminal ─────────────────────────

export interface ShellContext {
  /** Absolute paths the login shell resolves `claude` to, best first. */
  claudePaths: string[];
  /** The same for the `codex` CLI. */
  codexPaths: string[];
  /** The login shell's exported environment, or null if it could not be read. */
  env: Record<string, string> | null;
}

const MARK = { a: '__CUTAWAY_PATHS__', b: '__CUTAWAY_ENV__', c: '__CUTAWAY_END__' };
const SHELLS = new Set(['zsh', 'bash', 'sh', 'ksh', 'fish']);

/** Parse the probe's output. Anything a shell profile prints before the first marker is ignored. Pure. */
export function parseShellProbe(stdout: string): ShellContext {
  const a = stdout.indexOf(MARK.a);
  const b = stdout.indexOf(MARK.b, a + 1);
  const c = stdout.lastIndexOf(MARK.c);
  if (a < 0 || b < 0 || c < b) return { claudePaths: [], codexPaths: [], env: null };
  const found = stdout.slice(a + MARK.a.length, b).split('\n').map((l) => l.trim()).filter((l) => isAbsolute(l));
  const claudePaths = [...new Set(found.filter((l) => basename(l) === 'claude'))];
  const codexPaths = [...new Set(found.filter((l) => basename(l) === 'codex'))];
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(b + MARK.b.length, c).split('\0')) {
    const e = entry.replace(/^\n/, '');
    const i = e.indexOf('=');
    if (i <= 0) continue;
    const k = e.slice(0, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k === '_' || k === 'SHLVL' || k === 'PWD' || k === 'OLDPWD') continue;
    env[k] = e.slice(i + 1);
  }
  return { claudePaths, codexPaths, env: Object.keys(env).length ? env : null };
}

let shellContext: Promise<ShellContext> | null = null;

/** Forget what the login shell said (after the creator changes their setup). */
export function resetShellContext(): void {
  shellContext = null;
}

/**
 * Ask the creator's login shell where `claude` is and what it exports, once
 * per run. A GUI app starts with a bare PATH and none of the shell profile,
 * which is why the CLI can work in Terminal and not from a double-clicked app.
 */
export function loginShellContext(): Promise<ShellContext> {
  if (process.env.VITEST || process.env.CUTAWAY_SHELL_ENV === '0' || process.platform === 'win32') return Promise.resolve({ claudePaths: [], codexPaths: [], env: null });
  shellContext ??= (async () => {
    let shell = process.env.SHELL || '';
    try {
      shell ||= userInfo().shell ?? '';
    } catch {
      /* no passwd entry */
    }
    if (!isAbsolute(shell) || !SHELLS.has(basename(shell)) || !(await isExecutable(shell))) shell = '/bin/zsh';
    const script = `printf '\\n${MARK.a}\\n'; command -v claude; whence -p claude 2>/dev/null; type -P claude 2>/dev/null; command -v codex; whence -p codex 2>/dev/null; type -P codex 2>/dev/null; printf '\\n${MARK.b}\\n'; env -0; printf '\\n${MARK.c}\\n'`;
    const out = await spawnClaude(shell, ['-ilc', script], null, { cwd: homedir(), env: scrubbedEnv(process.env), timeoutMs: 12_000 });
    return parseShellProbe(out.stdout);
  })().catch(() => ({ claudePaths: [], codexPaths: [], env: null }));
  return shellContext;
}

/** Locate the Claude Code CLI: explicit path, then the login shell's answer, then PATH, then the usual install locations. */
export async function findClaude(preferredPath?: string | null, env?: NodeJS.ProcessEnv): Promise<string | null> {
  if (preferredPath && isAbsolute(preferredPath) && (await isExecutable(preferredPath))) return preferredPath;
  if (!env) {
    for (const p of (await loginShellContext()).claudePaths) if (await isExecutable(p)) return p;
  }
  const dirs = [...((env ?? process.env).PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS()];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    const candidate = join(d, 'claude');
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Environment for a CLI call: the login shell's when it could be read, otherwise this process's, scrubbed. */
export async function claudeEnv(claudePath: string): Promise<NodeJS.ProcessEnv> {
  const shell = (await loginShellContext()).env;
  if (!shell) return scrubbedEnv(process.env, claudePath);
  // The shell was started from a scrubbed environment, so any CLAUDE*/ANTHROPIC* variable here is the creator's own.
  const out: NodeJS.ProcessEnv = { ...shell };
  delete out.ELECTRON_RUN_AS_NODE;
  out.PATH = [...new Set([resolve(claudePath, '..'), ...(out.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS(), '/usr/bin', '/bin'])].join(delimiter);
  out.HOME = out.HOME ?? homedir();
  return out;
}

/**
 * Environment for the child: the parent's, minus anything that could carry a
 * host Claude session's identity or routing, with the usual tool directories
 * on PATH (GUI apps start with a minimal PATH).
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env, claudePath?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC|OPENAI_)/i.test(k)) continue;
    // A host Codex session's own variables; CODEX_HOME is where the creator's sign-in lives.
    if (/^CODEX_/i.test(k) && k !== 'CODEX_HOME') continue;
    if (/^ELECTRON_RUN_AS_NODE$/i.test(k)) continue;
    out[k] = v;
  }
  const path = [...(claudePath ? [resolve(claudePath, '..')] : []), ...(out.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS(), '/usr/bin', '/bin'];
  out.PATH = [...new Set(path)].join(delimiter);
  out.HOME = out.HOME ?? homedir();
  return out;
}

interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  spawnError: string | null;
}

/**
 * THE one place a Claude process is started. Everything else in this file is
 * argument building and parsing, which is covered by tests against a fake CLI.
 */
export function spawnClaude(path: string, args: string[], input: string | null, opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }): Promise<SpawnOutcome> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      done({ code, stdout, stderr, aborted, timedOut, spawnError });
    };
    if (opts.signal?.aborted) {
      done({ code: null, stdout, stderr, aborted: true, timedOut: false, spawnError: null });
      return;
    }
    // Own process group, so a cancel also stops anything the CLI started.
    const child = spawn(path, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };
    const kill = () => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 1500).unref();
      // Do not wait for inherited pipes to close once we have given up on the call.
      setTimeout(() => finish(null, null), 2500).unref();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 20_000_000) stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 200_000) stderr += d;
    });
    child.on('error', (e) => finish(null, e.message));
    child.on('exit', (code) => {
      if (aborted || timedOut) finish(code, null);
    });
    child.on('close', (code) => finish(code, null));
    child.stdin.on('error', () => undefined); // EPIPE if the CLI exits before reading
    child.stdin.end(input ?? '');
  });
}

const NOT_SIGNED_IN = /not logged in|please run \/login|oauth (session|token).*(expired|revoked)|failed to authenticate|invalid api key|authentication_error|unauthorized/i;

function signInMessage(): string {
  return 'Claude Code on this Mac is not signed in. Choose Sign in to Claude Code in Settings (or run "claude" in Terminal and type /login), then try again.';
}

/** Arguments for one structured, non-interactive call. Exported for tests. */
export function buildArgs(opts: Pick<ClaudeRunOptions, 'schema' | 'imageDir' | 'imagePaths' | 'model'>): string[] {
  const withImages = !!opts.imageDir && (opts.imagePaths?.length ?? 0) > 0;
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(opts.schema), '--no-session-persistence', '--strict-mcp-config'];
  // Tool surface: nothing, or Read alone so the model can look at stills.
  args.push('--tools', withImages ? 'Read' : '');
  if (withImages) args.push('--add-dir', opts.imageDir!);
  if (opts.model && opts.model.trim()) args.push('--model', opts.model.trim());
  return args;
}

/** Parse the CLI's `--output-format json` envelope into a result. Pure. */
export function parseEnvelope(stdout: string, stderr = '', exitCode: number | null = 0): Omit<ClaudeRunResult, 'durationMs'> {
  const text = stdout.trim();
  let env: Record<string, unknown> | null = null;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      // `json` prints one result object; tolerate an array of messages too.
      const obj = Array.isArray(parsed) ? [...parsed].reverse().find((m) => m && typeof m === 'object' && (m as { type?: unknown }).type === 'result') : parsed;
      if (obj && typeof obj === 'object') env = obj as Record<string, unknown>;
    } catch {
      // Last non-empty line may still be the envelope if something logged before it.
      const last = text.split('\n').reverse().find((l) => l.trim().startsWith('{'));
      if (last) {
        try {
          env = JSON.parse(last) as Record<string, unknown>;
        } catch {
          env = null;
        }
      }
    }
  }
  const combined = `${typeof env?.result === 'string' ? env.result : ''}\n${stderr}\n${env ? '' : text}`;
  if (NOT_SIGNED_IN.test(combined)) return { ok: false, error: { code: 'not-signed-in', message: signInMessage() } };
  if (!env) {
    const hint = (stderr.trim() || text).split('\n').slice(-3).join(' ').slice(0, 300);
    return { ok: false, error: { code: exitCode === 0 ? 'bad-output' : 'failed', message: hint ? `Claude Code did not return a result: ${hint}` : 'Claude Code did not return a result.' } };
  }
  const costUsd = typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null;
  const model = env.modelUsage && typeof env.modelUsage === 'object' ? (Object.keys(env.modelUsage as object)[0] ?? null) : null;
  const subtype = typeof env.subtype === 'string' ? env.subtype : '';
  if (env.is_error === true || (subtype && subtype !== 'success')) {
    const detail = typeof env.result === 'string' && env.result ? env.result : subtype || 'unknown error';
    const code: ClaudeErrorCode = subtype === 'error_max_structured_output_retries' ? 'bad-output' : 'failed';
    return { ok: false, error: { code, message: `Claude Code reported an error: ${String(detail).slice(0, 300)}` }, costUsd, model };
  }
  // With --json-schema the validated object is in `structured_output`.
  if (env.structured_output !== undefined && env.structured_output !== null) return { ok: true, data: env.structured_output, costUsd, model };
  if (typeof env.result === 'string' && env.result.trim()) {
    const s = env.result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return { ok: true, data: JSON.parse(s.slice(a, b + 1)), costUsd, model };
      } catch {
        /* fall through */
      }
    }
  }
  return { ok: false, error: { code: 'bad-output', message: 'Claude replied, but not with the structured data Cutaway asked for.' }, costUsd, model };
}

/** Is every image inside the image directory? */
export function imagesInsideDir(imageDir: string | null | undefined, imagePaths: string[] = []): boolean {
  if (imagePaths.length === 0) return true;
  if (!imageDir || !isAbsolute(imageDir)) return false;
  const root = resolve(imageDir) + sep;
  return imagePaths.every((p) => isAbsolute(p) && resolve(p).startsWith(root));
}

/** Run one structured prompt through the local Claude Code CLI. */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (opts.signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: 0 };
  if (!imagesInsideDir(opts.imageDir, opts.imagePaths)) return { ok: false, error: { code: 'failed', message: 'Still frames must be inside the project cache folder.' }, durationMs: elapsed() };
  const path = await findClaude(opts.claudePath);
  if (!path) return { ok: false, error: { code: 'not-found', message: 'Claude Code is not installed on this Mac (no "claude" command was found).' }, durationMs: elapsed() };
  const out = await spawnClaude(path, buildArgs(opts), opts.prompt, {
    cwd: opts.imageDir && (opts.imagePaths?.length ?? 0) > 0 ? opts.imageDir : tmpdir(),
    env: await claudeEnv(path),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 12 * 60_000,
  });
  if (out.aborted) return { ok: false, error: { code: 'cancelled', message: 'Cancelled.' }, durationMs: elapsed() };
  if (out.timedOut) return { ok: false, error: { code: 'timeout', message: 'Claude Code did not answer in time. Nothing was changed.' }, durationMs: elapsed() };
  if (out.spawnError) return { ok: false, error: { code: 'failed', message: `Could not start Claude Code: ${out.spawnError}` }, durationMs: elapsed() };
  return { ...parseEnvelope(out.stdout, out.stderr, out.code), durationMs: elapsed() };
}

/**
 * Is the CLI installed and signed in? Uses `claude auth status`, which makes
 * no model call and costs nothing.
 */
export async function claudeStatus(preferredPath?: string | null, signal?: AbortSignal): Promise<ClaudeStatus> {
  const path = await findClaude(preferredPath);
  if (!path) return { found: false, path: null, version: null, signedIn: null, message: 'Claude Code is not installed on this Mac. Install it, sign in, and Cutaway will use it. Until then the built-in rules assemble the cut.' };
  const env = await claudeEnv(path);
  const cwd = tmpdir();
  const v = await spawnClaude(path, ['--version'], null, { cwd, env, signal, timeoutMs: 15_000 });
  const version = v.code === 0 ? (v.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null) : null;
  const a = await spawnClaude(path, ['auth', 'status'], null, { cwd, env, signal, timeoutMs: 20_000 });
  let signedIn: boolean | null = null;
  try {
    const j = JSON.parse(a.stdout.trim()) as { loggedIn?: unknown };
    if (typeof j.loggedIn === 'boolean') signedIn = j.loggedIn;
  } catch {
    if (NOT_SIGNED_IN.test(`${a.stdout}\n${a.stderr}`)) signedIn = false;
  }
  const message = signedIn === true ? `Claude Code ${version ?? ''} is signed in.`.replace('  ', ' ') : signedIn === false ? signInMessage() : `Claude Code ${version ?? ''} was found, but its sign-in state could not be read. Cutaway will try it and fall back to built-in rules if it fails.`.replace('  ', ' ');
  return { found: true, path, version, signedIn, message };
}

/**
 * A script that signs a CLI in from the creator's own Terminal. Signing in
 * is theirs to do: this only starts the app's own login command where they
 * can see it.
 */
export function signInScript(cliPath: string, cli: { app: string; login: string[]; status: string[] } = { app: 'Claude Code', login: ['auth', 'login'], status: ['auth', 'status'] }): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const run = (args: string[]) => `${q(cliPath)} ${args.join(' ')}`;
  return ['#!/bin/zsh -il', 'clear', `echo "Signing ${cli.app} in for Cutaway. Follow the prompts; you can close this window when it says you are signed in."`, 'echo', run(cli.login), 'echo', `${run(cli.status)} >/dev/null 2>&1 && echo "Signed in. Go back to Cutaway and choose Check again." || echo "Not signed in yet. Run this again from Cutaway when you are ready."`, ''].join('\n');
}
