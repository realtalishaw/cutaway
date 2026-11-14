import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildArgs, claudeStatus, findClaude, imagesInsideDir, parseEnvelope, runClaude, scrubbedEnv } from '../src/node';

/**
 * A fake `claude` executable. It records how it was called (args, env,
 * stdin) and prints whatever reply.json holds, so the whole spawn → envelope
 * path is exercised without a signed-in CLI or a model call.
 */
let dir: string;
let fake: string;
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

function setReply(reply: unknown, opts: { sleep?: number; loggedIn?: boolean } = {}): void {
  writeFileSync(join(dir, 'reply.json'), typeof reply === 'string' ? reply : JSON.stringify(reply));
  writeFileSync(join(dir, 'sleep.txt'), String(opts.sleep ?? 0));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ loggedIn: opts.loggedIn ?? true, authMethod: 'claude.ai' }));
  for (const f of ['args.txt', 'env.txt', 'stdin.txt', 'cwd.txt']) if (existsSync(join(dir, f))) rmSync(join(dir, f));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cutaway-fake-claude-'));
  fake = join(dir, 'claude');
  writeFileSync(
    fake,
    `#!/bin/bash
D="${dir}"
if [ "$1" = "--version" ]; then echo "9.8.7 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then cat "$D/auth.json"; exit 0; fi
printf '%s\\n' "$@" > "$D/args.txt"
env > "$D/env.txt"
pwd > "$D/cwd.txt"
cat > "$D/stdin.txt"
S=$(cat "$D/sleep.txt")
if [ "$S" != "0" ]; then sleep "$S"; fi
cat "$D/reply.json"
`,
  );
  chmodSync(fake, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const envelope = (over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, result: '', total_cost_usd: 0.0123, modelUsage: { 'claude-sonnet-5-5': {} }, ...over });

describe('parseEnvelope', () => {
  it('reads structured_output', () => {
    const r = parseEnvelope(JSON.stringify(envelope({ structured_output: { ok: true } })));
    expect(r).toMatchObject({ ok: true, data: { ok: true }, costUsd: 0.0123, model: 'claude-sonnet-5-5' });
  });
  it('falls back to JSON in the result text', () => {
    expect(parseEnvelope(JSON.stringify(envelope({ result: '```json\n{"ok":true}\n```' }))).data).toEqual({ ok: true });
  });
  it('maps sign-in failures', () => {
    for (const msg of ['Not logged in · Please run /login', 'Failed to authenticate: OAuth session expired and could not be refreshed']) {
      const r = parseEnvelope(JSON.stringify(envelope({ is_error: true, result: msg })));
      expect(r.ok).toBe(false);
      expect(r.error!.code).toBe('not-signed-in');
      expect(r.error!.message).toContain('/login');
    }
  });
  it('rejects malformed envelopes', () => {
    expect(parseEnvelope('').error!.code).toBe('bad-output');
    expect(parseEnvelope('Segmentation fault', '', 139).error!.code).toBe('failed');
    expect(parseEnvelope(JSON.stringify(envelope({ result: 'Sure! Here is your edit.' }))).error!.code).toBe('bad-output');
    expect(parseEnvelope(JSON.stringify(envelope({ subtype: 'error_max_structured_output_retries', is_error: true }))).error!.code).toBe('bad-output');
    expect(parseEnvelope(JSON.stringify(envelope({ subtype: 'error_during_execution', is_error: true, result: 'boom' }))).error!.code).toBe('failed');
  });
});

describe('argument and environment safety', () => {
  it('gives the model no tools, and sends still frames inside a streamed message', () => {
    const none = buildArgs({ schema, imageDir: null, imagePaths: [], model: 'sonnet' });
    const some = buildArgs({ schema, imageDir: '/p/cache/frames', imagePaths: ['/p/cache/frames/a.jpg'], model: '' });
    for (const args of [none, some]) {
      expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
      expect(args).not.toContain('--add-dir');
      expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', '--json-schema', '--no-session-persistence', '--strict-mcp-config']));
      expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions|Bash|Write|Edit|Read/);
    }
    expect(none).not.toContain('--input-format');
    expect(none[none.indexOf('--output-format') + 1]).toBe('json');
    expect(some.slice(some.indexOf('--input-format'), some.indexOf('--input-format') + 2)).toEqual(['--input-format', 'stream-json']);
    expect(some[some.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(some).not.toContain('--model');
  });
  it('drops every CLAUDE*/ANTHROPIC* variable', () => {
    const env = scrubbedEnv({ PATH: '/usr/bin', HOME: '/Users/x', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', claude_config_dir: '/x', LANG: 'en_US.UTF-8' });
    expect(Object.keys(env).filter((k) => /^(claude|anthropic)/i.test(k))).toEqual([]);
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.PATH).toContain('/opt/homebrew/bin');
  });
  it('refuses images outside the image directory', () => {
    expect(imagesInsideDir('/p/cache/frames', ['/p/cache/frames/a.jpg'])).toBe(true);
    expect(imagesInsideDir('/p/cache/frames', ['/p/cache/frames/../../secret.jpg'])).toBe(false);
    expect(imagesInsideDir('/p/cache/frames', ['/etc/passwd'])).toBe(false);
    expect(imagesInsideDir(null, ['/p/a.jpg'])).toBe(false);
    expect(imagesInsideDir(null, [])).toBe(true);
  });
});

describe('runClaude against a fake CLI', () => {
  it('finds an explicit path', async () => {
    expect(await findClaude(fake)).toBe(fake);
    expect(await findClaude(null, { PATH: dir })).toBe(fake);
  });

  it('succeeds: prompt on stdin, scrubbed env, structured output back', async () => {
    setReply(envelope({ structured_output: { ok: true } }));
    process.env.CLAUDE_CODE_FAKE_HOST_SECRET = 'leak';
    process.env.ANTHROPIC_FAKE = 'leak';
    try {
      const r = await runClaude({ claudePath: fake, prompt: 'PROMPT BODY', schema, model: 'sonnet' });
      expect(r.ok).toBe(true);
      expect(r.data).toEqual({ ok: true });
      expect(r.costUsd).toBeCloseTo(0.0123);
    } finally {
      delete process.env.CLAUDE_CODE_FAKE_HOST_SECRET;
      delete process.env.ANTHROPIC_FAKE;
    }
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe('PROMPT BODY');
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\n');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!)).toEqual(schema);
    const env = readFileSync(join(dir, 'env.txt'), 'utf8');
    expect(env).not.toMatch(/^(CLAUDE|ANTHROPIC)/m);
    expect(env).not.toContain('leak');
  });

  it('attaches still frames to the message, each after its file name, and refuses files outside the folder', async () => {
    setReply(envelope({ structured_output: { ok: true } }));
    const frames = join(dir, 'frames');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(frames, { recursive: true });
    writeFileSync(join(frames, 'a.jpg'), 'x');
    const r = await runClaude({ claudePath: fake, prompt: 'PROMPT', schema, imageDir: frames, imagePaths: [join(frames, 'a.jpg')] });
    expect(r.ok).toBe(true);
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\n');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    const msg = JSON.parse(readFileSync(join(dir, 'stdin.txt'), 'utf8'));
    expect(msg.type).toBe('user');
    const content = msg.message.content;
    expect(content[0].text).toMatch(/^PROMPT[\s\S]*attached to this message as an image/);
    expect(content[1]).toEqual({ type: 'text', text: 'a.jpg' });
    expect(content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('x').toString('base64') } });
    const outside = await runClaude({ claudePath: fake, prompt: 'p', schema, imageDir: frames, imagePaths: ['/etc/hosts'] });
    expect(outside.ok).toBe(false);
  });

  it('reports not-signed-in', async () => {
    setReply(envelope({ is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0 }));
    const r = await runClaude({ claudePath: fake, prompt: 'p', schema });
    expect(r).toMatchObject({ ok: false, error: { code: 'not-signed-in' } });
  });

  it('times out and kills the process', async () => {
    setReply(envelope({ structured_output: { ok: true } }), { sleep: 20 });
    const t0 = Date.now();
    const r = await runClaude({ claudePath: fake, prompt: 'p', schema, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('can be cancelled', async () => {
    setReply(envelope({ structured_output: { ok: true } }), { sleep: 20 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    const r = await runClaude({ claudePath: fake, prompt: 'p', schema, signal: ac.signal });
    expect(r).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(Date.now() - t0).toBeLessThan(5000);
    const pre = new AbortController();
    pre.abort();
    expect((await runClaude({ claudePath: fake, prompt: 'p', schema, signal: pre.signal })).error!.code).toBe('cancelled');
  });

  it('reports bad output when the CLI prints something else', async () => {
    setReply('Welcome to Claude Code!');
    expect((await runClaude({ claudePath: fake, prompt: 'p', schema })).error!.code).toBe('bad-output');
  });

  it('reads sign-in state without a model call', async () => {
    setReply(envelope(), { loggedIn: true });
    expect(await claudeStatus(fake)).toMatchObject({ found: true, path: fake, version: '9.8.7', signedIn: true });
    setReply(envelope(), { loggedIn: false });
    const off = await claudeStatus(fake);
    expect(off.signedIn).toBe(false);
    expect(off.message).toContain('/login');
    expect(existsSync(join(dir, 'stdin.txt'))).toBe(false); // no prompt was ever sent
  });
});

describe('the creator\'s terminal', () => {
  it('reads claude paths and the exported environment from a noisy login shell', async () => {
    const { parseShellProbe } = await import('../src/node');
    const out = `/Users/x/.zshrc:87: command not found: thing\n\n__CUTAWAY_PATHS__\n/opt/homebrew/bin/claude\nalias claude='claude --x'\n/opt/homebrew/bin/claude\n/Users/x/.local/bin/claude\n\n__CUTAWAY_ENV__\nPATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/x\0MULTI=a\nb\0_=/usr/bin/env\0SHLVL=2\0ANTHROPIC_API_KEY=mine\0\n__CUTAWAY_END__\n`;
    const ctx = parseShellProbe(out);
    expect(ctx.claudePaths).toEqual(['/opt/homebrew/bin/claude', '/Users/x/.local/bin/claude']);
    expect(ctx.codexPaths).toEqual([]);
    expect(ctx.env).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x', MULTI: 'a\nb', ANTHROPIC_API_KEY: 'mine' });
  });

  it('gives nothing when the shell printed no markers', async () => {
    const { parseShellProbe } = await import('../src/node');
    expect(parseShellProbe('zsh: something went wrong')).toEqual({ claudePaths: [], codexPaths: [], env: null });
  });

  it('writes a sign-in script that quotes the CLI path and only runs auth commands', async () => {
    const { signInScript } = await import('../src/node');
    const s = signInScript("/Users/o'brien/bin/claude");
    expect(s.startsWith('#!/bin/zsh -il\n')).toBe(true);
    expect(s).toContain(`'/Users/o'\\''brien/bin/claude' auth login`);
    expect(s.split('\n').filter((l) => l.includes('claude')).every((l) => /auth (login|status)/.test(l) || l.startsWith('echo'))).toBe(true);
  });
});

import { buildArgs as buildArgsFast, streamProgress } from '../src/node';

describe('fast, streamed calls (animations)', () => {
  it('turns extended thinking off and streams the reply when asked', () => {
    const plain = buildArgsFast({ schema: {} });
    expect(plain).toContain('json');
    expect(plain).not.toContain('--settings');
    const fast = buildArgsFast({ schema: {}, fast: true, stream: true });
    expect(fast.slice(fast.indexOf('--output-format'), fast.indexOf('--output-format') + 4)).toEqual(['--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
    expect(JSON.parse(fast[fast.indexOf('--settings') + 1]!)).toEqual({ alwaysThinkingEnabled: false });
  });

  it('counts thinking and the answer separately, across split chunks', async () => {
    const seen: { chars: number; thinking: number }[] = [];
    const feed = streamProgress((p) => seen.push({ chars: p.chars, thinking: p.thinking }));
    const ev = (delta: object) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta } }) + '\n';
    feed(ev({ type: 'thinking_delta', thinking: 'x'.repeat(500) }));
    expect(seen).toEqual([{ chars: 0, thinking: 500 }]);
    await new Promise((r) => setTimeout(r, 260));
    const line = ev({ type: 'input_json_delta', partial_json: '{"html":"<!doctype' });
    feed(line.slice(0, 30));
    feed(line.slice(30));
    expect(seen.at(-1)).toEqual({ chars: 18, thinking: 500 });
    await new Promise((r) => setTimeout(r, 260));
    feed(ev({ type: 'text_delta', text: 'abc' }) + '{"type":"result"}\n');
    expect(seen.at(-1)).toEqual({ chars: 21, thinking: 500 });
  });

  it('tallies the edits as they are written, even when an op is split across events', () => {
    let last: Record<string, number> = {};
    const feed = streamProgress((p) => (last = p.ops));
    const ev = (partial_json: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } } }) + '\n';
    feed(ev('{"ops":[{"op":"cut","start":1},{"o') + ev('p": "zoom"},{"op":"cut"}]'));
    expect(last).toEqual({ cut: 2, zoom: 1 });
  });
});

describe('effort', () => {
  it('passes --effort when asked, and leaves it out otherwise', () => {
    const schema = {};
    const low = buildArgsFast({ schema, effort: 'low' });
    expect(low.slice(low.indexOf('--effort'), low.indexOf('--effort') + 2)).toEqual(['--effort', 'low']);
    expect(buildArgsFast({ schema })).not.toContain('--effort');
  });
});
