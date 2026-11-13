import { app, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TimeMap, createProject, slugify, type Project } from '@cutaway/core';
import { mediaUrl, type AppSettings, type CacheInfo, type ProbeResult, type ProjectSummary, type RecoverableTake, type TakeManifest } from '../shared/api';
import * as native from './native';

export const PROJECT_EXT = '.cutaway';

// ───────────────────────────── settings ─────────────────────────────

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

export function defaultSettings(): AppSettings {
  return {
    libraryDir: path.join(app.getPath('videos'), 'Cutaway'),
    exportDir: path.join(app.getPath('videos'), 'Cutaway Exports'),
    countdownSeconds: 3,
    claudePath: null,
    claudeModel: 'sonnet',
    transcription: { engine: 'auto', whisperModelPath: null, locale: 'en-US' },
    reduceMotion: false,
    transcriptTextSize: 15,
    importMode: 'copy',
    presets: [],
    defaultPresetId: null,
    unsplashKey: null,
    analytics: false,
  };
}

let cached: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cached) return cached;
  let stored: Partial<AppSettings> = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>;
  } catch {
    /* first run */
  }
  const d = defaultSettings();
  cached = { ...d, ...stored, transcription: { ...d.transcription, ...stored.transcription }, analytics: false };
  return cached;
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  cached = { ...getSettings(), ...patch, analytics: false };
  await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
  await atomicWrite(settingsFile(), JSON.stringify(cached, null, 2));
  return cached;
}

// ───────────────────────────── files ─────────────────────────────

async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const s = await dirSize(p);
      bytes += s.bytes;
      files += s.files;
    } else if (e.isFile()) {
      try {
        bytes += (await fsp.stat(p)).size;
        files++;
      } catch {
        /* vanished */
      }
    }
  }
  return { bytes, files };
}

const projectFile = (p: string) => path.join(p, 'project.json');
const resolve = (projectPath: string, sourcePath: string) => (path.isAbsolute(sourcePath) ? sourcePath : path.join(projectPath, sourcePath));

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} ${i}${ext}`);
  return candidate;
}

const safeName = (name: string) => name.replace(/[/:\\]/g, '-').trim().slice(0, 80) || 'Untitled';

// ───────────────────────────── library ─────────────────────────────

export async function list(): Promise<ProjectSummary[]> {
  const dir = getSettings().libraryDir;
  await fsp.mkdir(dir, { recursive: true });
  const out: ProjectSummary[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith(PROJECT_EXT)) continue;
    const p = path.join(dir, e.name);
    try {
      const project = JSON.parse(await fsp.readFile(projectFile(p), 'utf8')) as Project;
      const poster = path.join(p, 'poster.jpg');
      const missing = project.sources.filter((s) => !fs.existsSync(resolve(p, s.path))).length;
      let posterUrl: string | null = null;
      if (fs.existsSync(poster)) posterUrl = `${mediaUrl(poster)}?v=${Math.round((await fsp.stat(poster)).mtimeMs)}`;
      out.push({
        path: p,
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        createdAt: project.createdAt,
        duration: project.duration,
        outDuration: TimeMap.fromEdit(project.duration, project.edit).outDuration,
        sourceRoles: project.sources.map((s) => s.role),
        hasFirstCut: !!project.firstCut,
        exported: project.exports.some((x) => x.status === 'complete'),
        missingSources: missing,
        poster: posterUrl,
        sizeBytes: (await dirSize(path.join(p, 'media'))).bytes,
      });
    } catch {
      /* unreadable bundle: leave it alone, never delete */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function create(name: string): Promise<{ path: string; project: Project }> {
  const dir = getSettings().libraryDir;
  await fsp.mkdir(dir, { recursive: true });
  const p = await uniquePath(dir, safeName(name), PROJECT_EXT);
  await fsp.mkdir(path.join(p, 'media'), { recursive: true });
  await fsp.mkdir(path.join(p, 'cache'), { recursive: true });
  const project = createProject(path.basename(p, PROJECT_EXT));
  await atomicWrite(projectFile(p), JSON.stringify(project));
  return { path: p, project };
}

export async function open(p: string): Promise<{ path: string; project: Project; missing: string[] }> {
  const project = JSON.parse(await fsp.readFile(projectFile(p), 'utf8')) as Project;
  const missing: string[] = [];
  project.sources = project.sources.map((s) => {
    const available = fs.existsSync(resolve(p, s.path));
    if (!available) missing.push(s.id);
    return { ...s, available };
  });
  return { path: p, project, missing };
}

const saveCounts = new Map<string, number>();

export async function save(p: string, project: Project): Promise<{ savedAt: string }> {
  const file = projectFile(p);
  const n = (saveCounts.get(p) ?? 0) + 1;
  saveCounts.set(p, n);
  // Rolling backups: a bad write or bad edit never costs the whole project.
  if (n % 20 === 1 && fs.existsSync(file)) {
    const backups = path.join(p, 'backups');
    await fsp.mkdir(backups, { recursive: true });
    await fsp.copyFile(file, path.join(backups, `project-${Date.now()}.json`)).catch(() => {});
    const all = (await fsp.readdir(backups)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 5))) await fsp.rm(path.join(backups, old), { force: true });
  }
  const savedAt = new Date().toISOString();
  await atomicWrite(file, JSON.stringify({ ...project, updatedAt: savedAt }));
  return { savedAt };
}

export async function rename(p: string, name: string): Promise<{ path: string }> {
  const target = await uniquePath(path.dirname(p), safeName(name), PROJECT_EXT);
  await fsp.rename(p, target);
  const project = JSON.parse(await fsp.readFile(projectFile(target), 'utf8')) as Project;
  await atomicWrite(projectFile(target), JSON.stringify({ ...project, name: path.basename(target, PROJECT_EXT) }));
  return { path: target };
}

/** Only the project bundle goes to the Trash. Referenced originals elsewhere are never touched. */
export async function trash(p: string): Promise<void> {
  if (!p.endsWith(PROJECT_EXT)) throw new Error('Not a Cutaway project.');
  await shell.trashItem(p);
}

export async function savePoster(p: string, jpeg: Uint8Array): Promise<void> {
  await atomicWrite(path.join(p, 'poster.jpg'), jpeg);
}

export async function importMedia(projectPath: string, files: string[], mode: 'copy' | 'reference'): Promise<ProbeResult[]> {
  const probes = await native.probe(files);
  if (mode === 'reference') return probes;
  const dir = path.join(projectPath, 'media', 'imports');
  await fsp.mkdir(dir, { recursive: true });
  const out: ProbeResult[] = [];
  for (const pr of probes) {
    if (!pr.ok) {
      out.push(pr);
      continue;
    }
    const ext = path.extname(pr.path);
    const dest = await uniquePath(dir, safeName(path.basename(pr.path, ext)), ext);
    try {
      // APFS clone when possible: instant and takes no extra space; the original is never modified.
      await fsp.copyFile(pr.path, dest, fs.constants.COPYFILE_FICLONE);
      out.push({ ...pr, path: path.relative(projectPath, dest) });
    } catch (e) {
      out.push({ ...pr, ok: false, error: { code: (e as NodeJS.ErrnoException).code === 'ENOSPC' ? 'disk-full' : 'copy-failed', message: `Could not copy into the project: ${(e as Error).message}` } });
    }
  }
  return out;
}

export async function recoverable(): Promise<RecoverableTake[]> {
  const dir = getSettings().libraryDir;
  const out: RecoverableTake[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(PROJECT_EXT)) continue;
    const p = path.join(dir, e.name);
    const media = path.join(p, 'media');
    let takes: string[] = [];
    try {
      takes = (await fsp.readdir(media)).filter((n) => n.startsWith('take-'));
    } catch {
      continue;
    }
    let referenced = new Set<string>();
    try {
      const project = JSON.parse(await fsp.readFile(projectFile(p), 'utf8')) as Project;
      referenced = new Set(project.sources.map((s) => s.takeId).filter(Boolean) as string[]);
    } catch {
      /* project file unreadable: every take is recoverable */
    }
    for (const t of takes) {
      const takeDir = path.join(media, t);
      if (native.isRecording() && fs.existsSync(path.join(takeDir, 'config.json')) && !fs.existsSync(path.join(takeDir, '.done'))) {
        // the live take is not "interrupted work"
        const st = await fsp.stat(takeDir);
        if (Date.now() - st.mtimeMs < 5000) continue;
      }
      let manifest: TakeManifest | null = null;
      try {
        manifest = JSON.parse(await fsp.readFile(path.join(takeDir, 'manifest.json'), 'utf8')) as TakeManifest;
      } catch {
        /* crashed before the first manifest write */
      }
      const interrupted = !manifest || manifest.complete === false;
      const orphan = !referenced.has(t);
      if (!interrupted && !orphan) continue;
      const size = await dirSize(takeDir);
      if (size.bytes < 50_000) continue; // nothing usable was captured
      out.push({ projectPath: p, takeDir, startedAt: manifest?.startedAt ?? null, sizeBytes: size.bytes });
    }
  }
  return out;
}

export async function discardTake(takeDir: string): Promise<void> {
  if (!/\/media\/take-\d+$/.test(takeDir)) throw new Error('Not a take folder.');
  await shell.trashItem(takeDir);
}

export async function cacheInfo(projectPath: string): Promise<CacheInfo> {
  return dirSize(path.join(projectPath, 'cache'));
}

/** Clears derived data only: stills, proxies, analysis caches. Originals and project.json stay. */
export async function clearCache(projectPath: string): Promise<CacheInfo> {
  const dir = path.join(projectPath, 'cache');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return { bytes: 0, files: 0 };
}

/**
 * A copy of the project someone else can open: media that was only referenced
 * is gathered inside the copy, then the bundle is zipped with ditto. The
 * original project and the original files are not modified.
 */
export async function exportBundle(projectPath: string, destDir: string): Promise<{ path: string; bytes: number }> {
  const { execFile } = await import('node:child_process');
  const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, (err) => (err ? rej(err) : res())));
  await fsp.mkdir(destDir, { recursive: true });
  const name = path.basename(projectPath, PROJECT_EXT);
  const work = await fsp.mkdtemp(path.join(destDir, '.cutaway-share-'));
  const copy = path.join(work, `${name}${PROJECT_EXT}`);
  try {
    await run('/bin/cp', ['-Rc', projectPath, copy]);
    await fsp.rm(path.join(copy, 'cache'), { recursive: true, force: true });
    await fsp.rm(path.join(copy, 'backups'), { recursive: true, force: true });
    const project = JSON.parse(await fsp.readFile(projectFile(copy), 'utf8')) as Project;
    const linked = path.join(copy, 'media', 'linked');
    for (const s of project.sources) {
      if (!path.isAbsolute(s.path)) continue;
      if (!fs.existsSync(s.path)) continue;
      await fsp.mkdir(linked, { recursive: true });
      const dest = await uniquePath(linked, safeName(path.basename(s.path, path.extname(s.path))), path.extname(s.path));
      await fsp.copyFile(s.path, dest, fs.constants.COPYFILE_FICLONE);
      s.path = path.relative(copy, dest);
      s.managed = true;
    }
    project.consent = null;
    await atomicWrite(projectFile(copy), JSON.stringify(project));
    const zip = await uniquePath(destDir, `${safeName(name)} (Cutaway project)`, '.zip');
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', copy, zip]);
    return { path: zip, bytes: (await fsp.stat(zip)).size };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

export const exists = async (p: string) => fs.existsSync(p);

export async function freeBytes(p: string): Promise<number | null> {
  let dir = p;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export { slugify };
