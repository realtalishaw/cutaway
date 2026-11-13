import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ExportSession } from '../shared/api';
import * as native from './native';

interface Live extends ExportSession {
  destDir: string;
  folderName: string;
  handles: Map<string, fsp.FileHandle>;
  /** Single-file sessions end in one file at this path instead of a folder. */
  filePath?: string;
}

const sessions = new Map<string, Live>();

function get(id: string): Live {
  const s = sessions.get(id);
  if (!s) throw new Error('Export session not found.');
  return s;
}

const inside = (s: Live, name: string) => {
  if (name.includes('/') || name.includes('..')) throw new Error('Invalid export file name.');
  return path.join(s.workDir, name);
};

export async function existingFolders(destDir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(destDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Exports are assembled in a hidden working folder and only moved into place
 * when complete, so a finished package can never be half-written and an
 * existing package is never overwritten.
 */
export async function begin(destDir: string, folderName: string): Promise<ExportSession> {
  await fsp.mkdir(destDir, { recursive: true });
  const folder = path.join(destDir, folderName);
  if (fs.existsSync(folder)) throw Object.assign(new Error(`"${folderName}" already exists.`), { code: 'exists' });
  const id = crypto.randomUUID();
  const workDir = path.join(destDir, `.${folderName}.working-${id.slice(0, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const live: Live = { id, folder, workDir, destDir, folderName, handles: new Map() };
  sessions.set(id, live);
  return { id, folder, workDir };
}

/** A path in `dir` for `fileName` that does not exist yet: name.mp4, name-2.mp4, … */
export async function freeFilePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let taken: Set<string>;
  try {
    taken = new Set(await fsp.readdir(dir));
  } catch {
    taken = new Set();
  }
  if (!taken.has(fileName)) return path.join(dir, fileName);
  for (let i = 2; i < 10000; i++) if (!taken.has(`${stem}-${i}${ext}`)) return path.join(dir, `${stem}-${i}${ext}`);
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/**
 * Start an export that ends in one file at `filePath`. The file is assembled
 * in a hidden working folder beside its destination and moved into place by
 * commitFile, so a file with the final name is always complete.
 */
export async function beginFile(filePath: string): Promise<ExportSession> {
  if (!path.isAbsolute(filePath)) throw new Error('The export path must be absolute.');
  const destDir = path.dirname(filePath);
  await fsp.mkdir(destDir, { recursive: true });
  const id = crypto.randomUUID();
  const name = path.basename(filePath);
  const workDir = path.join(destDir, `.${name}.working-${id.slice(0, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  sessions.set(id, { id, folder: destDir, workDir, destDir, folderName: name, handles: new Map(), filePath });
  return { id, folder: destDir, workDir };
}

function diskError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return Object.assign(new Error('The destination ran out of space.'), { code: 'disk-full' });
  return e as Error;
}

export async function write(id: string, name: string, position: number, data: Uint8Array): Promise<void> {
  const s = get(id);
  let fh = s.handles.get(name);
  try {
    if (!fh) {
      fh = await fsp.open(inside(s, name), 'w+');
      s.handles.set(name, fh);
    }
    await fh.write(data, 0, data.byteLength, position);
  } catch (e) {
    throw diskError(e);
  }
}

export async function writeFile(id: string, name: string, data: Uint8Array | string): Promise<{ bytes: number }> {
  const s = get(id);
  try {
    await fsp.writeFile(inside(s, name), data);
  } catch (e) {
    throw diskError(e);
  }
  return { bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength };
}

async function closeHandles(s: Live) {
  for (const fh of s.handles.values()) await fh.close().catch(() => {});
  s.handles.clear();
}

export async function mux(id: string, video: string, audio: string | null, out: string, codec: 'h264' | 'prores422' = 'h264'): Promise<{ bytes: number; duration: number }> {
  const s = get(id);
  await closeHandles(s);
  try {
    const r = await native.mux(inside(s, video), audio ? inside(s, audio) : null, inside(s, out), codec === 'prores422' ? 'prores422' : 'h264');
    return { bytes: r.sizeBytes, duration: r.duration };
  } catch (e) {
    throw diskError(e);
  }
}

export async function gif(id: string, video: string, out: string, opts: { fps: number; width: number }): Promise<{ bytes: number; frames: number }> {
  const s = get(id);
  await closeHandles(s);
  try {
    const r = await native.gif(inside(s, video), inside(s, out), opts);
    return { bytes: r.sizeBytes, frames: r.frames };
  } catch (e) {
    throw diskError(e);
  }
}

export async function stat(id: string, name: string): Promise<{ bytes: number } | null> {
  const s = get(id);
  const fh = s.handles.get(name);
  if (fh) await fh.sync().catch(() => {});
  try {
    return { bytes: (await fsp.stat(inside(s, name))).size };
  } catch {
    return null;
  }
}

export async function commit(id: string, keep: string[]): Promise<{ folder: string; files: { name: string; bytes: number }[] }> {
  const s = get(id);
  await closeHandles(s);
  const keepSet = new Set(keep);
  for (const name of await fsp.readdir(s.workDir)) if (!keepSet.has(name)) await fsp.rm(path.join(s.workDir, name), { recursive: true, force: true });
  if (fs.existsSync(s.folder)) throw Object.assign(new Error('The export folder appeared while exporting; nothing was overwritten.'), { code: 'exists' });
  await fsp.rename(s.workDir, s.folder);
  sessions.delete(id);
  const files: { name: string; bytes: number }[] = [];
  for (const name of (await fsp.readdir(s.folder)).sort()) files.push({ name, bytes: (await fsp.stat(path.join(s.folder, name))).size });
  return { folder: s.folder, files };
}

/**
 * Finish a single-file export: move `name` out of the working folder to the
 * session's file path and remove the working folder. An existing file is only
 * replaced when the creator already agreed to that in the save dialog.
 */
export async function commitFile(id: string, name: string, replace = false): Promise<{ path: string; bytes: number }> {
  const s = get(id);
  if (!s.filePath) throw new Error('This export session is not a single-file export.');
  await closeHandles(s);
  const from = inside(s, name);
  const bytes = (await fsp.stat(from)).size;
  if (bytes <= 0) throw Object.assign(new Error(`${name} is empty.`), { code: 'validation-failed' });
  if (!replace && fs.existsSync(s.filePath)) throw Object.assign(new Error(`"${path.basename(s.filePath)}" appeared while exporting; nothing was overwritten.`), { code: 'exists' });
  try {
    // Same folder, so this is an atomic rename: the final name never points at a half-written file.
    await fsp.rename(from, s.filePath);
  } catch (e) {
    throw diskError(e);
  }
  sessions.delete(id);
  await fsp.rm(s.workDir, { recursive: true, force: true }).catch(() => {});
  return { path: s.filePath, bytes };
}

export async function abort(id: string, keepPartial: boolean): Promise<{ folder: string | null }> {
  const s = sessions.get(id);
  if (!s) return { folder: null };
  await closeHandles(s);
  sessions.delete(id);
  if (!keepPartial || s.filePath) {
    await fsp.rm(s.workDir, { recursive: true, force: true });
    return { folder: null };
  }
  // Partial results stay visible but are unmistakably not a finished package.
  let target = path.join(s.destDir, `${s.folderName}-PARTIAL`);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(s.destDir, `${s.folderName}-PARTIAL-${i}`);
  await fsp.rename(s.workDir, target);
  await fsp.writeFile(path.join(target, 'INCOMPLETE.txt'), 'This export did not finish. Files here may be unplayable.\nOpen the project in Cutaway and export again.\n').catch(() => {});
  return { folder: target };
}
