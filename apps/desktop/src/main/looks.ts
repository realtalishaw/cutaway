/**
 * Look assets that live inside a project folder: colour LUTs (.cube) and
 * background photos found through Unsplash.
 *
 * Unsplash is the only place this file talks to the network, and only when the
 * creator searches or picks a photo. The access key comes from Settings, goes
 * out in a request header, and is never written to a project or a log.
 */
import { BrowserWindow, dialog, net, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseCube, type ImageCredit, type LutRef } from '@cutaway/core';
import type { ImageSearchPhoto, ImageSearchResult } from '../shared/api';
import { getSettings } from './library';

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

const safeName = (name: string) => name.replace(/[^\w .()-]+/g, '-').replace(/^[.\s-]+/, '').trim().slice(0, 60) || 'file';

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} ${i}${ext}`);
  return candidate;
}

function assertProject(projectPath: string) {
  if (!path.isAbsolute(projectPath) || !fs.existsSync(path.join(projectPath, 'project.json'))) throw coded('no-project', 'The project folder could not be found.');
}

// ───────────────────────────── LUTs ─────────────────────────────

const LUT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Validate a .cube file and copy it into the project. `file` null asks the
 * creator to choose one; resolves null if they cancel.
 */
export async function importLut(projectPath: string, file: string | null): Promise<LutRef | null> {
  assertProject(projectPath);
  let src = file;
  if (!src) {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = { title: 'Choose a LUT', properties: ['openFile'], filters: [{ name: 'Colour LUT (.cube)', extensions: ['cube'] }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    src = r.filePaths[0];
  }
  if (!path.isAbsolute(src)) throw coded('bad-lut', 'The LUT file path is not valid.');
  let st: fs.Stats;
  try {
    st = await fsp.stat(src);
  } catch {
    throw coded('bad-lut', 'The LUT file could not be found.');
  }
  if (!st.isFile()) throw coded('bad-lut', 'That is not a file.');
  if (st.size > LUT_MAX_BYTES) throw coded('bad-lut', 'This file is too large to be a .cube LUT Cutaway can read (limit 64 MB).');
  const text = await fsp.readFile(src, 'utf8');
  const lut = parseCube(text); // throws LutError (code "bad-lut") with a line-level reason
  const dir = path.join(projectPath, 'media', 'luts');
  await fsp.mkdir(dir, { recursive: true });
  const base = safeName(path.basename(src, path.extname(src)));
  const dest = await uniquePath(dir, base, '.cube');
  await fsp.copyFile(src, dest, fs.constants.COPYFILE_FICLONE);
  return { file: path.relative(projectPath, dest), name: lut.title.trim() || base, kind: lut.kind, size: lut.size };
}

// ───────────────────────────── Unsplash ─────────────────────────────

const API = 'https://api.unsplash.com';
const IMAGE_HOSTS = new Set(['images.unsplash.com', 'plus.unsplash.com']);
const UTM = 'utm_source=cutaway&utm_medium=referral';
const IMAGE_MAX_BYTES = 40 * 1024 * 1024;

/** Tests point this at a local mock server; outside tests the variable is ignored. */
function apiBase(): string {
  const override = process.env.CUTAWAY_E2E === '1' ? process.env.CUTAWAY_UNSPLASH_BASE : undefined;
  return override && /^http:\/\/127\.0\.0\.1:\d+$/.test(override) ? override : API;
}

/** Only Unsplash's own image hosts (or the test mock) are ever fetched. */
function allowedImageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    const base = apiBase();
    if (base !== API) return u.origin === base ? u : null;
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

function key(): string {
  const k = getSettings().unsplashKey?.trim();
  if (!k) throw coded('no-key', 'Add your Unsplash access key in Settings to search for photos.');
  return k;
}

async function call(url: string, accessKey: string): Promise<Response> {
  let r: Response;
  try {
    r = await net.fetch(url, { headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw coded('offline', 'Unsplash could not be reached. Check the internet connection and try again.');
  }
  if (r.status === 401) throw coded('bad-key', 'Unsplash did not accept the access key. Check it in Settings.');
  if (r.status === 403 || r.status === 429) throw coded('rate-limit', 'Unsplash is limiting requests for this access key right now. Try again in a while.');
  if (!r.ok) throw coded('search-failed', `Unsplash answered with an error (${r.status}).`);
  return r;
}

interface Remembered {
  credit: ImageCredit;
  raw: string;
  downloadLocation: string | null;
}
/** Photos from recent searches, so "use this one" never takes a URL from the renderer. */
const remembered = new Map<string, Remembered>();

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

function withUtm(link: string): string {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || !/(^|\.)unsplash\.com$/.test(u.hostname)) return '';
    return `${u.origin}${u.pathname}?${UTM}`;
  } catch {
    return '';
  }
}

export async function searchImages(query: string, page: number): Promise<ImageSearchResult> {
  const q = String(query ?? '').trim().slice(0, 120);
  if (!q) return { photos: [], page: 1, totalPages: 0 };
  const accessKey = key();
  const pg = Math.max(1, Math.min(50, Math.floor(page) || 1));
  const r = await call(`${apiBase()}/search/photos?query=${encodeURIComponent(q)}&page=${pg}&per_page=18&orientation=landscape&content_filter=high`, accessKey);
  let body: { total_pages?: unknown; results?: unknown };
  try {
    body = (await r.json()) as typeof body;
  } catch {
    throw coded('search-failed', 'Unsplash sent a reply Cutaway could not read.');
  }
  const results = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
  const photos = await Promise.all(
    results.map(async (p): Promise<ImageSearchPhoto | null> => {
      const id = str(p.id, 40);
      const urls = (p.urls ?? {}) as Record<string, unknown>;
      const links = (p.links ?? {}) as Record<string, unknown>;
      const user = (p.user ?? {}) as Record<string, unknown>;
      const raw = allowedImageUrl(urls.raw);
      const thumbUrl = allowedImageUrl(urls.thumb ?? urls.small);
      if (!/^[\w-]+$/.test(id) || !raw || !thumbUrl) return null;
      const credit: ImageCredit = { source: 'unsplash', id, author: str(user.name, 80) || 'Unknown', authorUrl: withUtm(str(((user.links ?? {}) as Record<string, unknown>).html, 300)), pageUrl: withUtm(str(links.html, 300)) };
      const dl = str(links.download_location, 400);
      remembered.set(id, { credit, raw: raw.toString(), downloadLocation: dl.startsWith(`${apiBase()}/`) ? dl : null });
      let thumb = '';
      try {
        const t = await net.fetch(thumbUrl.toString(), { signal: AbortSignal.timeout(15_000) });
        const buf = Buffer.from(await t.arrayBuffer());
        if (t.ok && buf.length < 2_000_000) thumb = `data:${t.headers.get('content-type')?.startsWith('image/') ? t.headers.get('content-type') : 'image/jpeg'};base64,${buf.toString('base64')}`;
      } catch {
        /* a missing thumbnail shows the photo's colour instead */
      }
      return { id, thumb, width: Number(p.width) || 0, height: Number(p.height) || 0, color: /^#[0-9a-f]{6}$/i.test(str(p.color)) ? str(p.color) : '#2a2b30', description: str(p.alt_description ?? p.description, 140), author: credit.author, authorUrl: credit.authorUrl, pageUrl: credit.pageUrl };
    }),
  );
  if (remembered.size > 400) for (const k of [...remembered.keys()].slice(0, remembered.size - 400)) remembered.delete(k);
  return { photos: photos.filter((p): p is ImageSearchPhoto => !!p), page: pg, totalPages: Math.max(0, Math.min(50, Number(body.total_pages) || 0)) };
}

/** Download a photo from the last searches into the project and return its path and credit. */
export async function useImage(projectPath: string, id: string): Promise<{ path: string; credit: ImageCredit }> {
  assertProject(projectPath);
  const photo = remembered.get(id);
  if (!photo) throw coded('unknown-photo', 'Search again and pick the photo once more.');
  const accessKey = key();
  // Unsplash asks apps to report a download when a photo is actually used.
  if (photo.downloadLocation) await call(photo.downloadLocation, accessKey).catch(() => undefined);
  const url = new URL(photo.raw);
  if (apiBase() === API) {
    url.searchParams.set('w', '3840');
    url.searchParams.set('q', '85');
    url.searchParams.set('fm', 'jpg');
    url.searchParams.set('fit', 'max');
  }
  let r: Response;
  try {
    r = await net.fetch(url.toString(), { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw coded('offline', 'The photo could not be downloaded. Check the internet connection and try again.');
  }
  if (!r.ok) throw coded('download-failed', `The photo could not be downloaded (${r.status}).`);
  const type = r.headers.get('content-type') ?? '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0 || buf.length > IMAGE_MAX_BYTES) throw coded('download-failed', 'The photo is empty or too large to use.');
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!png && !jpg) throw coded('download-failed', `Unsplash did not send a JPEG or PNG (${type.slice(0, 40) || 'unknown type'}).`);
  const dir = path.join(projectPath, 'media', 'backgrounds');
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `unsplash-${id}${png ? '.png' : '.jpg'}`);
  const tmp = `${dest}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  return { path: path.relative(projectPath, dest), credit: photo.credit };
}

/** Open a photo or photographer page. Only unsplash.com links are opened. */
export async function openCredit(url: string): Promise<void> {
  const safe = withUtm(String(url ?? ''));
  if (!safe) throw coded('bad-link', 'That link cannot be opened.');
  await shell.openExternal(safe);
}
