/**
 * Renders animations ("motion") into transparent PNG frames, in a hidden off-screen window of this app's own
 * Chromium. The page is locked down: its own session, no Node, no preload, no permissions, no navigation, no
 * new windows, and every request refused except the one page file being shown (its policy also forbids
 * the network). Frames are cached in the project's cache folder, keyed by everything that changes a frame.
 */
import { BrowserWindow, protocol, session, type Session } from 'electron';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMotionMeta, type MotionMeta } from '@cutaway/core';
import { MOTION_RUNTIME_VERSION, wrapMotion } from '../shared/motionRuntime';
import type { MotionCheck, MotionRenderRequest, MotionRenderResult } from '../shared/api';

const PARTITION = 'cutaway-motion';
const LOAD_TIMEOUT = 15_000;
const FRAME_TIMEOUT = 4_000;
/** Pages allowed to load right now (one per window). */
const allowed = new Set<string>();
let sandbox: Session | null = null;

function sandboxSession(): Session {
  if (sandbox) return sandbox;
  const s = session.fromPartition(PARTITION, { cache: false });
  s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(allowed.has(d.url) || d.url.startsWith('data:') || d.url.startsWith('blob:')) }));
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  sandbox = s;
  return s;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} took too long.`)), ms))]);

/** Open a page in a hidden transparent window of exactly `width`×`height` pixels. */
async function open(file: string, width: number, height: number): Promise<{ win: BrowserWindow; errors: string[]; close(): void }> {
  const url = `file://${file.split(path.sep).map(encodeURIComponent).join('/')}`;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: sandboxSession(), backgroundThrottling: false, spellcheck: false, webgl: true },
  });
  const errors: string[] = [];
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (e) => {
    const { level, message } = e as unknown as { level: string; message: string };
    if (level === 'error') errors.push(message);
  });
  win.webContents.setFrameRate(60);
  allowed.add(url);
  const close = () => {
    allowed.delete(url);
    if (!win.isDestroyed()) win.destroy();
  };
  try {
    await withTimeout(win.loadURL(url), LOAD_TIMEOUT, 'Loading the animation');
    await withTimeout(win.webContents.executeJavaScript('window.__cutaway.ready()'), LOAD_TIMEOUT, 'Starting the animation');
  } catch (e) {
    close();
    throw e;
  }
  return { win, errors, close };
}

const pageErrors = async (win: BrowserWindow): Promise<string[]> => ((await win.webContents.executeJavaScript('window.__errors || []').catch(() => [])) as string[]).slice(0, 10);

async function frameAt(win: BrowserWindow, t: number) {
  // the app can quit while frames are being prepared: say so plainly instead of "object has been destroyed"
  if (win.isDestroyed()) throw new Error('Preparing the animation was stopped.');
  await withTimeout(win.webContents.executeJavaScript(`window.__cutaway.seek(${t.toFixed(5)})`), FRAME_TIMEOUT, 'Drawing a frame');
  return win.webContents.capturePage();
}

/** Fraction of pixels that are not fully transparent, from a sparse sample. */
function coverage(bmp: Buffer, w: number, h: number): number {
  let on = 0;
  let n = 0;
  for (let y = 4; y < h; y += 16)
    for (let x = 4; x < w; x += 16) {
      n++;
      if (bmp[(y * w + x) * 4 + 3]! > 8) on++;
    }
  return n ? on / n : 0;
}

/**
 * Load an animation and look at it: its JSON block, script errors, whether anything shows, whether it moves,
 * whether it leaves the frame see-through (an overlay must not hide the video). Returns three small stills.
 */
export async function checkMotion(html: string, fields: Record<string, string> | null, width: number, height: number): Promise<MotionCheck> {
  const { meta, problems } = parseMotionMeta(html);
  const errors = [...problems];
  if (!meta) return { ok: false, errors, meta: null, stills: [] };
  const values = fields ?? Object.fromEntries(meta.fields.map((f) => [f.id, f.value]));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cutaway-motion-check-'));
  const file = path.join(dir, 'page.html');
  await fsp.writeFile(file, wrapMotion(html, values));
  const stills: string[] = [];
  let page: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // checked at a quarter size: fast, and enough to see
    const w = Math.round(width / 2);
    const h = Math.round(height / 2);
    page = await open(file, w, h);
    await page.win.webContents.setZoomFactor(0.5);
    const times = [Math.min(0.25, meta.duration / 4), meta.duration * 0.55, Math.max(0, meta.duration - 0.05)];
    const covers: number[] = [];
    const sums: string[] = [];
    for (const t of times) {
      const img = await frameAt(page.win, t);
      const size = img.getSize();
      const bmp = img.toBitmap();
      covers.push(coverage(bmp, size.width, size.height));
      sums.push(crypto.createHash('sha1').update(bmp).digest('hex'));
      stills.push(`data:image/png;base64,${img.resize({ width: 480 }).toPNG().toString('base64')}`);
    }
    errors.push(...page.errors.map((e) => `Script error: ${e}`), ...(await pageErrors(page.win)).map((e) => `Script error: ${e}`));
    if (covers.every((c) => c < 0.002)) errors.push('Nothing is visible at any moment: the animation draws nothing, or draws it outside the frame.');
    if (new Set(sums).size === 1 && covers.some((c) => c > 0)) errors.push('Nothing moves: the three moments look identical. Use CSS animations, element.animate(), or window.__render(t).');
    if (covers.some((c) => c > 0.92)) errors.push('The background is not transparent: it covers the whole frame and would hide the video. Leave the page background transparent.');
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    page?.close();
    void fsp.rm(dir, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], meta, stills };
}

// ───────────────────────────── live previews ─────────────────────────────

export const PREVIEW_SCHEME = 'cutaway-motion';
const previews = new Map<string, string>();
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:";

/** A looping preview page, served from its own scheme with the same locked-down policy as the renderer. */
export function previewUrl(html: string, fields: Record<string, string>, duration: number): string {
  const id = crypto.createHash('sha1').update(JSON.stringify([html, fields, duration])).digest('hex').slice(0, 16);
  if (!previews.has(id)) {
    // the editor is dark: a preview in the same colour scheme is drawn see-through over it, not on white
    previews.set(id, wrapMotion(html, fields, { duration }).replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="color-scheme" content="dark"><style>:root{color-scheme:dark}</style>'));
    while (previews.size > 40) previews.delete(previews.keys().next().value!);
  }
  return `${PREVIEW_SCHEME}://preview/${id}.html`;
}

export function registerPreviewProtocol() {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const id = new URL(request.url).pathname.replace(/^\/|\.html$/g, '');
    const html = previews.get(id);
    if (!html) return new Response('gone', { status: 404 });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_CSP, 'cache-control': 'no-store' } });
  });
}

const renders = new Map<string, Promise<MotionRenderResult>>();

/** Render an animation's frames (or reuse them). `onProgress` gets the fraction done. */
export function renderMotion(projectPath: string, req: MotionRenderRequest, onProgress: (done: number, total: number, key: string) => void): Promise<MotionRenderResult> {
  return (async () => {
    const pageFile = path.resolve(projectPath, req.file);
    if (!pageFile.startsWith(path.resolve(projectPath, 'media', 'motion') + path.sep)) throw new Error('Animations are read from the project’s media/motion folder only.');
    const html = await fsp.readFile(pageFile, 'utf8');
    // the tag only labels progress; it does not change a frame
    const key = crypto.createHash('sha1').update(JSON.stringify([MOTION_RUNTIME_VERSION, html, req.fields, req.width, req.height, req.fps, req.duration])).digest('hex').slice(0, 20);
    const dir = path.join(projectPath, 'cache', 'motion', key);
    const total = Math.max(1, Math.ceil(req.duration * req.fps));
    const result: MotionRenderResult = { key, dir, count: total, fps: req.fps, width: req.width, height: req.height };
    if (await fsp.stat(path.join(dir, 'done')).then(() => true, () => false)) return result;
    const running = renders.get(key);
    if (running) return running;
    const job = (async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'page.html');
      await fsp.writeFile(file, wrapMotion(html, req.fields));
      const page = await open(file, req.width, req.height);
      try {
        for (let i = 0; i < total; i++) {
          const img = await frameAt(page.win, Math.min(req.duration, i / req.fps));
          await fsp.writeFile(path.join(dir, `f${String(i).padStart(5, '0')}.png`), img.toPNG());
          if (i % 5 === 0 || i === total - 1) onProgress(i + 1, total, key);
        }
      } finally {
        page.close();
      }
      await fsp.writeFile(path.join(dir, 'done'), new Date().toISOString());
      return result;
    })();
    renders.set(key, job);
    try {
      return await job;
    } finally {
      renders.delete(key);
    }
  })();
}

/** Save an animation page into the project (a new file each time, so earlier versions stay for undo). */
export async function saveMotion(projectPath: string, html: string, name: string): Promise<{ file: string; meta: MotionMeta | null; problems: string[] }> {
  if (html.length > 512 * 1024) throw new Error('The animation page is too large (over 512 KB).');
  const dir = path.join(projectPath, 'media', 'motion');
  await fsp.mkdir(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'animation';
  const file = path.join(dir, `${slug}-${Date.now().toString(36)}.html`);
  await fsp.writeFile(file, html);
  const { meta, problems } = parseMotionMeta(html);
  return { file: path.relative(projectPath, file), meta, problems };
}

// ───────────────────────────── the creator's own templates ─────────────────────────────

let templatesDir = '';
export function initMotionTemplates(userData: string) {
  templatesDir = path.join(userData, 'motion-templates');
}

/** Saved templates, newest first. They live with the app, so every project can use them. */
export async function listTemplates(): Promise<{ id: string; html: string }[]> {
  const files = await fsp.readdir(templatesDir).catch(() => [] as string[]);
  const out: { id: string; html: string; at: number }[] = [];
  for (const f of files.filter((x) => /^[a-z0-9-]+\.html$/.test(x))) {
    const file = path.join(templatesDir, f);
    out.push({ id: f.slice(0, -5), html: await fsp.readFile(file, 'utf8'), at: (await fsp.stat(file)).mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).map(({ id, html }) => ({ id, html }));
}

/** Keep an animation as a template. Its current field values become the template's defaults. */
export async function saveTemplate(html: string, name: string): Promise<{ id: string }> {
  const { meta, problems } = parseMotionMeta(html);
  if (!meta) throw new Error(problems[0] ?? 'This animation cannot be saved as a template.');
  if (html.length > 512 * 1024) throw new Error('The animation is too large to save as a template.');
  await fsp.mkdir(templatesDir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'animation';
  const id = `${slug}-${Date.now().toString(36)}`;
  await fsp.writeFile(path.join(templatesDir, `${id}.html`), html);
  return { id };
}

export async function removeTemplate(id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Not a saved template.');
  await fsp.rm(path.join(templatesDir, `${id}.html`), { force: true });
}

export async function readMotion(projectPath: string, rel: string): Promise<string> {
  const file = path.resolve(projectPath, rel);
  if (!file.startsWith(path.resolve(projectPath, 'media', 'motion') + path.sep)) throw new Error('Animations are read from the project’s media/motion folder only.');
  return fsp.readFile(file, 'utf8');
}
