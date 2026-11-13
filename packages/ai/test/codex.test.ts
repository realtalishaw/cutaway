import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attachmentNote, buildCodexArgs, codexStatus, findCodex, generateCodexImage, generatedImagesDir, parseCodexEvents, parseCodexRun, runCodex } from '../src/codex';
import { FIRST_CUT_SCHEMA, PACKAGING_SCHEMA, REVISION_SCHEMA, disclosure } from '../src/index';
import { PROVIDERS, buildArtPrompt, pickProvider, providerOfConsent, stripNulls, toStrictSchema } from '../src/provider';
// @ts-expect-error plain JS test helper shared with the desktop e2e runs
import { makeFakeCodex } from './fake-codex.mjs';

let dir: string;
let fake: string;
let home: string;
const schema = { type: 'object', properties: { ok: { type: 'boolean' }, why: { type: 'string' } }, required: ['ok'] };
const set = (name: string, value: string | null) => (value === null ? rmSync(join(dir, name), { force: true }) : writeFileSync(join(dir, name), value));
const args = () => JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cutaway-fake-codex-'));
  home = join(dir, 'codex-home');
  mkdirSync(home);
  fake = makeFakeCodex(dir) as string;
  process.env.CODEX_HOME = home;
});
afterAll(() => {
  delete process.env.CODEX_HOME;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of ['reply.json', 'status.txt', 'sleep.txt', 'fail.txt', 'image.txt', 'args.json', 'stdin.txt', 'env.txt', 'cwd.txt', 'schema.json']) set(f, null);
});

describe('providers', () => {
  it('uses a named choice as it is and picks the first signed-in one on auto', () => {
    const both = { claude: { found: true, signedIn: true }, codex: { found: true, signedIn: true } };
    expect(pickProvider('auto', both)).toBe('claude');
    expect(pickProvider('codex', both)).toBe('codex');
    expect(pickProvider('auto', { claude: { found: true, signedIn: false }, codex: { found: true, signedIn: true } })).toBe('codex');
    expect(pickProvider('auto', { claude: { found: false, signedIn: null }, codex: { found: true, signedIn: false } })).toBe('codex');
    expect(pickProvider('auto', {})).toBe('claude');
    // never silently swapped for the other one
    expect(pickProvider('claude', { claude: { found: true, signedIn: false }, codex: { found: true, signedIn: true } })).toBe('claude');
  });

  it('keeps consent separate per provider and says where the data goes', () => {
    expect(PROVIDERS.claude.consent).not.toBe(PROVIDERS.codex.consent);
    expect(providerOfConsent(PROVIDERS.codex.consent)).toBe('codex');
    expect(providerOfConsent('somewhere else')).toBeNull();
    const a = disclosure(['transcript', 'frames'], 'claude');
    const o = disclosure(['transcript', 'frames'], 'codex', { images: true });
    expect(a.destination).toMatch(/^Anthropic, through the Claude Code app/);
    expect(a.text).not.toMatch(/OpenAI|Codex/);
    expect(o.destination).toMatch(/^OpenAI, through the Codex app/);
    expect(o.text).not.toMatch(/Anthropic|Claude/);
    expect(o.provider).toBe('OpenAI via local Codex');
    expect(o.leaves.some((l) => /thumbnail art/i.test(l))).toBe(true);
    expect(o.purpose).toMatch(/labelled as AI-generated/);
    expect(disclosure(['transcript']).provider).toBe('Anthropic via local Claude Code');
  });

  it('closes every object and turns optional properties into nullable ones', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: { op: { type: 'string', enum: ['cut', 'zoom'] }, scale: { type: 'number' }, mode: { type: 'string', enum: ['a', 'b'] }, apply: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x'] } } },
      required: ['op'],
    }) as Record<string, any>;
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(['op', 'scale', 'mode', 'apply']);
    expect(strict.properties.op).toEqual({ type: 'string', enum: ['cut', 'zoom'] });
    expect(strict.properties.scale).toEqual({ type: ['number', 'null'] });
    expect(strict.properties.mode).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
    expect(strict.properties.apply.type).toEqual(['array', 'null']);
    expect(strict.properties.apply.items).toMatchObject({ additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: ['number', 'null'] } } });
  });

  it('makes the real reply schemas strict all the way down', () => {
    const open: string[] = [];
    const walk = (s: unknown, at: string) => {
      if (Array.isArray(s)) return s.forEach((x, i) => walk(x, `${at}[${i}]`));
      if (!s || typeof s !== 'object') return;
      const o = s as Record<string, unknown>;
      if (o.properties && typeof o.properties === 'object') {
        const keys = Object.keys(o.properties as object);
        if (o.additionalProperties !== false || JSON.stringify(o.required) !== JSON.stringify(keys)) open.push(at);
        for (const k of keys) walk((o.properties as Record<string, unknown>)[k], `${at}.${k}`);
      }
      walk(o.items, `${at}[]`);
    };
    for (const [name, s] of Object.entries({ FIRST_CUT_SCHEMA, REVISION_SCHEMA, PACKAGING_SCHEMA })) walk(toStrictSchema(s), name);
    expect(open).toEqual([]);
  });

  it('drops nulls from a reply so "not given" looks the same from both providers', () => {
    expect(stripNulls({ op: 'zoom', scale: null, apply: [{ x: 1, y: null }, null], text: '' })).toEqual({ op: 'zoom', apply: [{ x: 1 }], text: '' });
  });

  it('builds an art prompt from the thumbnail playbook, with the fixed rules last', () => {
    const p = buildArtPrompt({ title: 'Export  settings\nexplained', rationale: 'Shows the export panel.', quotes: ['do not delete this file'], overlayText: ['EXPORT RIGHT'], palette: ['#4d2ef5', 'red'], direction: 'a desk at night', referenceCount: 2, variation: 5, template: 'banner', notes: 'I like teal.' });
    expect(p).toContain('exactly once');
    expect(p).toContain('Its title is "Export settings explained" and the words "EXPORT RIGHT" will be laid over the picture later.');
    expect(p).toContain('The video: Shows the export panel.');
    expect(p).toContain('Keep the bottom third calm'); // the banner layout's space
    expect(p).toContain('accent colours #4d2ef5');
    expect(p).not.toContain('red against');
    expect(p).toContain("The creator's own notes: I like teal.");
    expect(p).toContain('- "do not delete this file"');
    expect(p).toContain('a desk at night');
    expect(p).toContain('2 attached images are stills');
    expect(p).toMatch(/No words, letters, numbers/);
    expect(p).toMatch(/do not draw it yourself/);
    expect(p).toMatch(/No recognisable real people and no realistic human faces/);
    expect(p).toMatch(/No logos, brand marks/);
    expect(p.indexOf('RULES (never break these')).toBeGreaterThan(p.indexOf('I like teal.'));
    expect(p).not.toMatch(/\n\n\n/);
    const bare = buildArtPrompt({ title: 't', rationale: '', quotes: [], overlayText: [], palette: [], direction: '', referenceCount: 0, variation: 0 });
    expect(bare).not.toMatch(/attached|Things the creator says|direction for this picture/);
    expect(bare).toContain('The video: t');
  });
});

describe('codex arguments and events', () => {
  it('is read-only, isolated from the creator\'s Codex setup, and never bypasses approvals', () => {
    const a = buildCodexArgs({ cwd: '/w', schemaFile: '/t/schema.json', outFile: '/t/reply.json', images: ['/w/a.jpg', '/w/b.jpg'], model: ' gpt-x ' });
    expect(a[0]).toBe('exec');
    expect(a.slice(1, 5)).toEqual(['--image', '/w/a.jpg', '--image', '/w/b.jpg']);
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only');
    for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) expect(a).toContain(flag);
    expect(a[a.indexOf('--model') + 1]).toBe('gpt-x');
    expect(a[a.length - 1]).toBe('-');
    expect(a.join(' ')).not.toMatch(/dangerously|approve-for-me|workspace-write|full-access|add-dir/);
    expect(buildCodexArgs({ cwd: '/w', schemaFile: 's', outFile: 'o' })).not.toContain('--model');
  });

  it('reads the event stream: thread, last message, failure, usage', () => {
    const ev = parseCodexEvents(['noise', '{"type":"thread.started","thread_id":"T1"}', '{"type":"item.completed","item":{"type":"error","message":"warning only"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}', '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'].join('\n'));
    expect(ev).toEqual({ threadId: 'T1', lastMessage: '{"ok":true}', error: null, tokens: { input: 10, output: 2 } });
    expect(parseCodexEvents('{"type":"turn.failed","error":{"message":"boom"}}').error).toBe('boom');
  });

  it('turns a run into a result', () => {
    const ok = '{"type":"thread.started","thread_id":"T"}\n{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true,\\"why\\":null}"}}';
    expect(parseCodexRun(ok, '', 0, null)).toMatchObject({ ok: true, data: { ok: true }, threadId: 'T' });
    expect(parseCodexRun(ok, 'ERROR rmcp::transport: noise', 0, '```json\n{"ok":false}\n```')).toMatchObject({ ok: true, data: { ok: false } });
    expect(parseCodexRun('{"type":"turn.failed","error":{"message":"401 Unauthorized: token expired"}}', '', 1, null)).toMatchObject({ ok: false, error: { code: 'not-signed-in' } });
    expect(parseCodexRun('', 'Not logged in. Please run `codex login`.', 1, null)).toMatchObject({ ok: false, error: { code: 'not-signed-in' } });
    expect(parseCodexRun('{"type":"turn.failed","error":{"message":"model overloaded"}}', '', 1, null).error).toMatchObject({ code: 'failed', message: expect.stringContaining('model overloaded') });
    expect(parseCodexRun('{"type":"item.completed","item":{"type":"agent_message","text":"sorry"}}', '', 0, null).error!.code).toBe('bad-output');
    expect(parseCodexRun('', 'something broke', 2, null).error).toMatchObject({ code: 'failed', message: expect.stringContaining('something broke') });
  });

  it('tells the model the stills are attachments', () => {
    expect(attachmentNote(0)).toMatch(/cannot and need not run commands/);
    expect(attachmentNote(3)).toMatch(/3 still frames listed above are attached/);
  });
});

describe('runCodex against a fake CLI', () => {
  it('finds an explicit path or one on PATH', async () => {
    expect(await findCodex(fake)).toBe(fake);
    expect(await findCodex(null, { PATH: dir })).toBe(fake);
  });

  it('succeeds: prompt on stdin, strict schema file, scrubbed env, nulls dropped', async () => {
    set('reply.json', '{"ok":true,"why":null}');
    process.env.CODEX_THREAD_ID = 'host-session';
    process.env.OPENAI_FAKE = 'leak';
    process.env.CLAUDE_CODE_FAKE = 'leak';
    try {
      const r = await runCodex({ claudePath: fake, prompt: 'PROMPT BODY', schema, model: 'gpt-x' });
      expect(r).toMatchObject({ ok: true, data: { ok: true } });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      delete process.env.CODEX_THREAD_ID;
      delete process.env.OPENAI_FAKE;
      delete process.env.CLAUDE_CODE_FAKE;
    }
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe(`PROMPT BODY${attachmentNote(0)}`);
    const a = args();
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(a[a.indexOf('--model') + 1]).toBe('gpt-x');
    expect(JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'))).toEqual(toStrictSchema(schema));
    const env = readFileSync(join(dir, 'env.txt'), 'utf8').split('\n');
    expect(env).toContain('CODEX_HOME');
    expect(env.filter((k) => /^(CLAUDE|ANTHROPIC|OPENAI_)/.test(k) || (/^CODEX_/.test(k) && k !== 'CODEX_HOME'))).toEqual([]);
    // the working files are gone afterwards
    expect(existsSync(a[a.indexOf('--output-schema') + 1]!)).toBe(false);
  });

  it('attaches stills and works from their folder; refuses stills from elsewhere', async () => {
    const frames = join(dir, 'frames');
    mkdirSync(frames, { recursive: true });
    writeFileSync(join(frames, 'a.jpg'), 'x');
    const r = await runCodex({ claudePath: fake, prompt: 'p', schema, imageDir: frames, imagePaths: [join(frames, 'a.jpg')] });
    expect(r.ok).toBe(true);
    const a = args();
    expect(a.slice(1, 3)).toEqual(['--image', join(frames, 'a.jpg')]);
    expect(realpathSync(a[a.indexOf('--cd') + 1]!)).toBe(realpathSync(frames));
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toMatch(/still frame listed above is attached/);
    expect((await runCodex({ claudePath: fake, prompt: 'p', schema, imageDir: frames, imagePaths: ['/etc/hosts'] })).ok).toBe(false);
  });

  it('reports a CLI failure, a missing CLI, a timeout and a cancel', async () => {
    set('fail.txt', '401 Unauthorized');
    expect(await runCodex({ claudePath: fake, prompt: 'p', schema })).toMatchObject({ ok: false, error: { code: 'not-signed-in' } });
    set('fail.txt', 'usage limit reached');
    expect((await runCodex({ claudePath: fake, prompt: 'p', schema })).error).toMatchObject({ code: 'failed', message: expect.stringContaining('usage limit reached') });
    set('fail.txt', null);
    set('sleep.txt', '20');
    let t0 = Date.now();
    expect(await runCodex({ claudePath: fake, prompt: 'p', schema, timeoutMs: 300 })).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(Date.now() - t0).toBeLessThan(5000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    t0 = Date.now();
    expect(await runCodex({ claudePath: fake, prompt: 'p', schema, signal: ac.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('reads version and sign-in state without a model call', async () => {
    expect(await codexStatus(fake)).toMatchObject({ found: true, path: fake, version: '9.9.9', signedIn: true });
    set('status.txt', 'Not logged in');
    const off = await codexStatus(fake);
    expect(off.signedIn).toBe(false);
    expect(off.message).toMatch(/codex login/);
    expect(existsSync(join(dir, 'args.json'))).toBe(false);
  });
});

describe('thumbnail art through the fake CLI', () => {
  it('picks the picture up from the Codex folder and copies it to the destination', async () => {
    set('image.txt', '1');
    set('reply.json', '{"generated":true,"note":"A desk at night."}');
    const out = join(dir, 'project', 'media', 'generated', 'art.png');
    const r = await generateCodexImage({ codexPath: fake, prompt: 'make it', outFile: out, referenceImages: [join(dir, 'frames', 'a.jpg')] });
    expect(r).toMatchObject({ ok: true, path: out, note: 'A desk at night.' });
    expect(readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
    const a = args();
    expect(a[a.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(a.slice(1, 3)).toEqual(['--image', join(dir, 'frames', 'a.jpg')]);
    expect(generatedImagesDir({ CODEX_HOME: home }, 'T')).toBe(join(home, 'generated_images', 'T'));
    expect(generatedImagesDir({ HOME: '/Users/x' }, 'T')).toBe('/Users/x/.codex/generated_images/T');
  });

  it('says so when no picture was made', async () => {
    set('reply.json', '{"generated":false,"note":"image generation is not enabled"}');
    const r = await generateCodexImage({ codexPath: fake, prompt: 'make it', outFile: join(dir, 'none.png') });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toMatch(/did not make a picture: image generation is not enabled/);
    expect(existsSync(join(dir, 'none.png'))).toBe(false);
    set('reply.json', '{"generated":true,"note":"done"}');
    expect((await generateCodexImage({ codexPath: fake, prompt: 'make it', outFile: join(dir, 'none.png') })).error!.message).toMatch(/no picture was made/);
    expect((await generateCodexImage({ codexPath: fake, prompt: 'p', outFile: 'relative.png' })).ok).toBe(false);
  });
});
