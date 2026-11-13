/**
 * IPC surface for the local Claude Code bridge: 'ai:status', 'ai:run',
 * 'ai:cancel'. The renderer supplies a prompt, a JSON Schema and (optionally)
 * still frames; it gets plain data back. The model is never given a tool
 * that can change anything, and its reply is validated again in the renderer
 * by @cutaway/core before it can touch a project.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, type IpcMain } from 'electron';
import { claudeStatus, findClaude, imagesInsideDir, resetShellContext, runClaude, signInScript } from '@cutaway/ai/node';
import type { AiRequest, AiResult, AppSettings, ClaudeStatus } from '../shared/api';

const STATUS_TTL_MS = 60_000;
const TIMEOUTS: Record<AiRequest['purpose'], number> = { 'first-cut': 15 * 60_000, 'local-revision': 6 * 60_000, packaging: 8 * 60_000 };
const MAX_PROMPT_CHARS = 1_500_000;

export function registerAi(ipcMain: IpcMain, getSettings: () => AppSettings): void {
  const running = new Map<string, AbortController>();
  let cached: { at: number; path: string | null; status: ClaudeStatus } | null = null;

  /** Test runs set CUTAWAY_CLAUDE=off so they never depend on, or spend, the creator's Claude account. */
  const disabled = process.env.CUTAWAY_CLAUDE === 'off';
  const OFF: ClaudeStatus = { found: false, path: null, version: null, signedIn: null, message: 'Claude Code is switched off for this run.' };

  ipcMain.handle('ai:status', async (_e, force?: boolean): Promise<ClaudeStatus> => {
    if (disabled) return OFF;
    const preferred = getSettings().claudePath;
    if (force) resetShellContext();
    if (!force && cached && cached.path === preferred && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
    const status = await claudeStatus(preferred);
    cached = { at: Date.now(), path: preferred, status };
    return status;
  });

  // Opens Terminal on `claude auth login`. The creator signs in there; Cutaway never sees the credentials.
  ipcMain.handle('ai:signIn', async (): Promise<{ ok: boolean; message: string }> => {
    if (disabled) return { ok: false, message: OFF.message };
    const path = await findClaude(getSettings().claudePath);
    if (!path) return { ok: false, message: 'Claude Code is not installed on this Mac.' };
    const dir = join(app.getPath('userData'), 'scripts');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'Sign in to Claude Code.command');
    await writeFile(file, signInScript(path), 'utf8');
    await chmod(file, 0o755);
    cached = null;
    return new Promise((done) => execFile('/usr/bin/open', ['-a', 'Terminal', file], (err) => done(err ? { ok: false, message: `Terminal could not be opened: ${err.message}` } : { ok: true, message: 'Terminal is open. Finish signing in there, then choose Check again.' })));
  });

  ipcMain.handle('ai:run', async (_e, req: AiRequest): Promise<AiResult> => {
    const bad = (message: string): AiResult => ({ ok: false, error: { code: 'failed', message }, durationMs: 0 });
    if (disabled) return { ok: false, error: { code: 'not-found', message: OFF.message }, durationMs: 0 };
    if (!req || typeof req.id !== 'string' || typeof req.prompt !== 'string' || !req.prompt.trim()) return bad('Malformed AI request.');
    if (req.prompt.length > MAX_PROMPT_CHARS) return bad('The request is too large to send.');
    if (!req.schema || typeof req.schema !== 'object' || Array.isArray(req.schema)) return bad('AI request has no reply schema.');
    const imagePaths = Array.isArray(req.imagePaths) ? req.imagePaths.filter((p): p is string => typeof p === 'string') : [];
    const imageDir = typeof req.imageDir === 'string' && req.imageDir ? req.imageDir : null;
    // Stills may only come from the single directory the model is allowed to read.
    if (!imagesInsideDir(imageDir, imagePaths)) return bad('Still frames must all be inside the project cache folder.');
    if (running.has(req.id)) return bad('This AI request is already running.');

    const controller = new AbortController();
    running.set(req.id, controller);
    try {
      const settings = getSettings();
      const res = await runClaude({
        claudePath: settings.claudePath,
        model: settings.claudeModel,
        prompt: req.prompt,
        schema: req.schema,
        imageDir,
        imagePaths,
        signal: controller.signal,
        timeoutMs: TIMEOUTS[req.purpose] ?? 10 * 60_000,
      });
      if (res.error?.code === 'not-signed-in' || res.error?.code === 'not-found') cached = null;
      return res;
    } catch (e) {
      return { ok: false, error: { code: 'failed', message: e instanceof Error ? e.message : 'Claude Code failed.' }, durationMs: 0 };
    } finally {
      running.delete(req.id);
    }
  });

  ipcMain.handle('ai:cancel', async (_e, id: string): Promise<void> => {
    running.get(id)?.abort();
  });
}
