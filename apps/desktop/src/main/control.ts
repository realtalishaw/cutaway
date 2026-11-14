/**
 * Local control for AI tools (the cutaway-mcp server that Claude Code or Codex start). A small HTTP server on
 * 127.0.0.1 only, behind a random token written to a file only this user can read. Each call is handed to the
 * main window, which carries it out with the same functions the app's own buttons use, so every change is
 * undoable, saved as a version, and visible live. Turned off in Settings › AI tools.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

export interface ControlInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
}

/** Where the address and token live: `~/Library/Application Support/Cutaway/control.json`. */
export const controlFile = () => path.join(app.getPath('userData'), 'control.json');

/** How long one call may take before the tool is told it timed out (an export can take a while). */
const TIMEOUTS: Record<string, number> = { export_video: 45 * 60_000, first_cut: 20 * 60_000, generate: 10 * 60_000, add_animation: 8 * 60_000, import_media: 10 * 60_000 };
const MAX_BODY = 4 * 1024 * 1024;

let server: http.Server | null = null;
let info: ControlInfo | null = null;
let seq = 0;
const waiting = new Map<string, { done(r: { ok: boolean; result?: unknown; error?: string }): void }>();

ipcMain.on('control:result', (_e, r: { id: string; ok: boolean; result?: unknown; error?: string }) => {
  const w = r && waiting.get(r.id);
  if (!w) return;
  waiting.delete(r.id);
  w.done(r);
});

export function controlStatus(): { running: boolean; port: number | null; file: string } {
  return { running: !!server, port: info?.port ?? null, file: controlFile() };
}

/** Start listening (idempotent). `win` returns the main window, creating it when needed. */
export async function startControl(win: () => BrowserWindow | null): Promise<void> {
  if (server) return;
  const token = crypto.randomBytes(32).toString('hex');
  const srv = http.createServer((req, res) => void handle(req, res, token, win));
  // a call can take many minutes (transcription, export): never drop it for being slow
  srv.requestTimeout = 0;
  srv.timeout = 0;
  // local only: never reachable from the network
  await new Promise<void>((ok, fail) => srv.once('error', fail).listen(0, '127.0.0.1', () => ok()));
  server = srv;
  const port = (srv.address() as { port: number }).port;
  info = { port, token, pid: process.pid, version: app.getVersion() };
  const file = controlFile();
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(info), { mode: 0o600 });
  await fsp.rename(`${file}.tmp`, file);
  await fsp.chmod(file, 0o600).catch(() => {});
}

export async function stopControl(): Promise<void> {
  const srv = server;
  server = null;
  info = null;
  for (const [id, w] of waiting) (waiting.delete(id), w.done({ ok: false, error: 'Cutaway stopped accepting AI tool commands.' }));
  if (srv) await new Promise<void>((ok) => srv.close(() => ok()));
  await fsp.rm(controlFile(), { force: true }).catch(() => {});
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, win: () => BrowserWindow | null) {
  // Only our own local client: no browser page can call this (no CORS headers, a secret token, JSON only).
  const auth = req.headers.authorization ?? '';
  const given = Buffer.from(auth.replace(/^Bearer /, ''));
  const want = Buffer.from(token);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, { ok: false, error: 'Not authorised.' });
  if (req.method !== 'POST' || req.url !== '/call' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 404, { ok: false, error: 'Not found.' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return send(res, 413, { ok: false, error: 'The request is too large.' });
  }
  let call: { method?: unknown; params?: unknown };
  try {
    call = JSON.parse(body) as typeof call;
  } catch {
    return send(res, 400, { ok: false, error: 'The request is not JSON.' });
  }
  const method = typeof call.method === 'string' ? call.method : '';
  if (!/^[a-z_]{2,40}$/.test(method)) return send(res, 400, { ok: false, error: 'Unknown method.' });
  if (method === 'ping') return send(res, 200, { ok: true, result: { app: 'Cutaway', version: app.getVersion() } });

  const w = win();
  if (!w || w.isDestroyed()) return send(res, 503, { ok: false, error: 'Cutaway has no window open.' });
  // wait for the window's page to be ready to take commands
  if (w.webContents.isLoading()) await new Promise<void>((ok) => w.webContents.once('did-finish-load', () => ok()));
  const id = `c${Date.now().toString(36)}${(seq++).toString(36)}`;
  const result = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((done) => {
    const timer = setTimeout(() => (waiting.delete(id), done({ ok: false, error: `Cutaway did not finish "${method}" in time.` })), TIMEOUTS[method] ?? 2 * 60_000);
    waiting.set(id, { done: (r) => (clearTimeout(timer), done(r)) });
    w.webContents.send('control:call', { id, method, params: call.params ?? {} });
  });
  send(res, 200, result);
}
