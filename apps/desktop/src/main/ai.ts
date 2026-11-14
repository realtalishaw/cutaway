/**
 * IPC surface for the local AI bridge. Two providers, both command-line apps
 * the creator already has and is signed in to: Claude Code (`claude`) and
 * Codex (`codex`). The renderer supplies a prompt, a JSON Schema and
 * (optionally) still frames; it gets plain data back. The model is never
 * given a tool that can change anything, and its reply is validated again in
 * the renderer by @cutaway/core before it can touch a project.
 *
 * Which provider answers is decided here, from settings (`aiProvider`):
 * a named one is used as it is; 'auto' takes the first that is signed in.
 * Thumbnail pictures come from Codex only (its built-in image tool).
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app, type IpcMain } from 'electron';
import { PROVIDERS, pickProvider, providerChoice, type ProviderId } from '@cutaway/ai';
import { codexStatus, findCodex, generateCodexImage, runCodex } from '@cutaway/ai/codex';
import { claudeStatus, findClaude, imagesInsideDir, resetShellContext, runClaude, signInScript } from '@cutaway/ai/node';
import type { AiImageRequest, AiImageResult, AiProviders, AiRequest, AiResult, AppSettings, ClaudeStatus } from '../shared/api';

const STATUS_TTL_MS = 60_000;
const TIMEOUTS: Partial<Record<string, number>> = { 'first-cut': 15 * 60_000, 'local-revision': 6 * 60_000, packaging: 8 * 60_000, motion: 6 * 60_000 };
/**
 * Thinking caps. Uncapped, a first cut of a few minutes of video was seen thinking past the 15-minute limit
 * and falling back to the built-in rules; the cut itself is checked by Cutaway after the reply.
 */
const THINKING: Partial<Record<string, number>> = { 'first-cut': 8000, 'local-revision': 6000, packaging: 6000 };
/** Low effort for the long editorial requests: measured 101 s for a 3-minute recording, against a 15-minute timeout at the default. */
const EFFORT: Partial<Record<string, 'low' | 'medium' | 'high'>> = { 'first-cut': 'low', 'local-revision': 'low', packaging: 'low' };
const MAX_PROMPT_CHARS = 1_500_000;
const GENERATED_DIR = join('media', 'generated');

export function registerAi(ipcMain: IpcMain, getSettings: () => AppSettings): void {
  const running = new Map<string, AbortController>();
  const cached: Partial<Record<ProviderId, { at: number; path: string | null; status: ClaudeStatus }>> = {};

  /** Test runs set these to "off" so they never depend on, or spend, the creator's own accounts. */
  const disabled: Record<ProviderId, boolean> = { claude: process.env.CUTAWAY_CLAUDE === 'off', codex: process.env.CUTAWAY_CODEX === 'off' };
  const off = (id: ProviderId): ClaudeStatus => ({ found: false, path: null, version: null, signedIn: null, message: `${PROVIDERS[id].app} is switched off for this run.`, provider: id });
  const preferredPath = (id: ProviderId): string | null => (id === 'claude' ? getSettings().claudePath : (getSettings().codexPath ?? null));
  const modelFor = (id: ProviderId): string => (id === 'claude' ? getSettings().claudeModel : (getSettings().codexModel ?? ''));

  async function statusOf(id: ProviderId, force?: boolean): Promise<ClaudeStatus> {
    if (disabled[id]) return off(id);
    const preferred = preferredPath(id);
    const hit = cached[id];
    if (!force && hit && hit.path === preferred && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
    const status: ClaudeStatus = { ...(id === 'claude' ? await claudeStatus(preferred) : await codexStatus(preferred)), provider: id };
    cached[id] = { at: Date.now(), path: preferred, status };
    return status;
  }

  async function providers(force?: boolean): Promise<AiProviders> {
    if (force) resetShellContext();
    const choice = providerChoice(getSettings().aiProvider);
    // A named choice does not need the other app checked at all.
    const [claude, codex] = await Promise.all([statusOf('claude', force), statusOf('codex', force)]);
    return { choice, active: pickProvider(choice, { claude, codex }), claude, codex };
  }

  ipcMain.handle('ai:providers', (_e, force?: boolean): Promise<AiProviders> => providers(force));

  ipcMain.handle('ai:status', async (_e, force?: boolean): Promise<ClaudeStatus> => {
    const all = await providers(force);
    return all[all.active];
  });

  // Opens Terminal on the app's own login command. The creator signs in there; Cutaway never sees the credentials.
  ipcMain.handle('ai:signIn', async (_e, which?: ProviderId): Promise<{ ok: boolean; message: string }> => {
    const id: ProviderId = which === 'claude' || which === 'codex' ? which : (await providers()).active;
    const info = PROVIDERS[id];
    if (disabled[id]) return { ok: false, message: off(id).message };
    const path = id === 'claude' ? await findClaude(preferredPath(id)) : await findCodex(preferredPath(id));
    if (!path) return { ok: false, message: `${info.app} is not installed on this Mac.` };
    const dir = join(app.getPath('userData'), 'scripts');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `Sign in to ${info.app}.command`);
    await writeFile(file, signInScript(path, { app: info.app, login: info.signIn, status: id === 'claude' ? ['auth', 'status'] : ['login', 'status'] }), 'utf8');
    await chmod(file, 0o755);
    delete cached[id];
    return new Promise((done) => execFile('/usr/bin/open', ['-a', 'Terminal', file], (err) => done(err ? { ok: false, message: `Terminal could not be opened: ${err.message}` } : { ok: true, message: 'Terminal is open. Finish signing in there, then choose Check again.' })));
  });

  ipcMain.handle('ai:run', async (e, req: AiRequest): Promise<AiResult> => {
    const bad = (message: string): AiResult => ({ ok: false, error: { code: 'failed', message }, durationMs: 0 });
    if (!req || typeof req.id !== 'string' || typeof req.prompt !== 'string' || !req.prompt.trim()) return bad('Malformed AI request.');
    if (req.prompt.length > MAX_PROMPT_CHARS) return bad('The request is too large to send.');
    if (!req.schema || typeof req.schema !== 'object' || Array.isArray(req.schema)) return bad('AI request has no reply schema.');
    const imagePaths = Array.isArray(req.imagePaths) ? req.imagePaths.filter((p): p is string => typeof p === 'string') : [];
    const imageDir = typeof req.imageDir === 'string' && req.imageDir ? req.imageDir : null;
    // Stills may only come from the single directory the model is allowed to read.
    if (!imagesInsideDir(imageDir, imagePaths)) return bad('Still frames must all be inside the project cache folder.');
    if (running.has(req.id)) return bad('This AI request is already running.');

    const id = (await providers()).active;
    if (disabled[id]) return { ok: false, error: { code: 'not-found', message: off(id).message }, durationMs: 0, provider: id };
    const controller = new AbortController();
    running.set(req.id, controller);
    try {
      // An animation is mostly writing: extended thinking made it take minutes, and the renderer check after the reply catches mistakes.
      const fast = req.purpose === 'motion';
      const onProgress = req.progress ? (p: { chars: number; thinking: number; ops: Record<string, number> }) => !e.sender.isDestroyed() && e.sender.send('ai:progress', { id: req.id, chars: p.chars, thinking: p.thinking, ops: p.ops }) : undefined;
      const opts = { claudePath: preferredPath(id), model: modelFor(id), prompt: req.prompt, schema: req.schema, imageDir, imagePaths, signal: controller.signal, timeoutMs: TIMEOUTS[req.purpose] ?? 10 * 60_000, fast, thinkingTokens: THINKING[req.purpose], effort: EFFORT[req.purpose], onProgress };
      const res = id === 'claude' ? await runClaude(opts) : await runCodex(opts);
      if (res.error?.code === 'not-signed-in' || res.error?.code === 'not-found') delete cached[id];
      return { ...res, provider: id };
    } catch (e) {
      return { ok: false, error: { code: 'failed', message: e instanceof Error ? e.message : `${PROVIDERS[id].app} failed.` }, durationMs: 0, provider: id };
    } finally {
      running.delete(req.id);
    }
  });

  ipcMain.handle('ai:cancel', async (_e, id: string): Promise<void> => {
    running.get(id)?.abort();
  });

  /** A project folder: absolute, named *.cutaway, holding a project.json. */
  async function projectRoot(p: unknown): Promise<string | null> {
    if (typeof p !== 'string' || !isAbsolute(p) || !p.endsWith('.cutaway')) return null;
    const st = await stat(join(p, 'project.json')).catch(() => null);
    return st?.isFile() ? resolve(p) : null;
  }

  // Thumbnail art. Only Codex can make pictures; the request never falls through to another provider.
  ipcMain.handle('ai:generateImage', async (_e, req: AiImageRequest): Promise<AiImageResult> => {
    const bad = (message: string, code: NonNullable<AiResult['error']>['code'] = 'failed'): AiImageResult => ({ ok: false, error: { code, message }, durationMs: 0, provider: 'codex' });
    if (!req || typeof req.id !== 'string' || typeof req.prompt !== 'string' || !req.prompt.trim()) return bad('Malformed picture request.');
    if (req.prompt.length > 20_000) return bad('The picture request is too long.');
    const root = await projectRoot(req.projectPath);
    if (!root) return bad('Pictures can only be made for an open project.');
    const refs = (Array.isArray(req.referencePaths) ? req.referencePaths : []).filter((p): p is string => typeof p === 'string').slice(0, 2);
    if (!imagesInsideDir(join(root, 'cache'), refs)) return bad('Reference stills must be inside the project cache folder.');
    if (disabled.codex) return bad(off('codex').message, 'not-found');
    if (running.has(req.id)) return bad('This picture is already being made.');
    const controller = new AbortController();
    running.set(req.id, controller);
    try {
      const name = `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.png`;
      const res = await generateCodexImage({ codexPath: preferredPath('codex'), model: modelFor('codex'), prompt: req.prompt, referenceImages: refs, outFile: join(root, GENERATED_DIR, name), signal: controller.signal, timeoutMs: 8 * 60_000 });
      if (res.error?.code === 'not-signed-in' || res.error?.code === 'not-found') delete cached.codex;
      if (!res.ok || !res.path) return { ok: false, error: res.error ?? { code: 'failed', message: 'No picture was made.' }, durationMs: res.durationMs, provider: 'codex' };
      return { ok: true, path: relative(root, res.path).split(sep).join('/'), note: res.note, durationMs: res.durationMs, provider: 'codex' };
    } catch (e) {
      return bad(e instanceof Error ? e.message : 'Codex failed.');
    } finally {
      running.delete(req.id);
    }
  });

  ipcMain.handle('ai:removeImage', async (_e, projectPath: string, relPath: string): Promise<void> => {
    const root = await projectRoot(projectPath);
    if (!root || typeof relPath !== 'string') return;
    const dir = join(root, GENERATED_DIR) + sep;
    const file = resolve(root, relPath);
    // Only pictures this feature made, never anything else in the project.
    if (!file.startsWith(dir) || !/^art-[a-z0-9-]+\.(png|jpe?g|webp)$/i.test(file.slice(dir.length))) return;
    await rm(file, { force: true });
  });
}
