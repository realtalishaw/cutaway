/**
 * Assembles the YouTube package folder:
 *
 *   project-name-youtube/
 *     video.mp4  thumbnail.jpg  thumbnail-master.jpg  title.txt  title-options.txt
 *     description.txt  chapters.txt  captions.srt  credits.txt  package.json
 *
 * Everything is written into a hidden working folder and only moved into
 * place once every file validates, so a folder with the final name is always
 * a complete package and an existing export is never overwritten. Nothing is
 * uploaded anywhere.
 */
import { create } from 'zustand';
import {
  THUMB_MASTER,
  THUMB_UPLOAD_MAX_BYTES,
  TimeMap,
  buildCues,
  chaptersToOutput,
  checkChapters,
  checkDescription,
  checkTitle,
  estimateVideoBitrate,
  formatChapters,
  chapterStamp,
  packageFolderName,
  toSrt,
  uid,
  type ExportRecord,
  type PackageManifest,
  type Project,
} from '@cutaway/core';
import { renderVideo, type RenderArgs, type RenderProgress, type RenderResult } from './exporter';
import { thumbnailJpeg } from './thumb';

export type ExportStage = 'prepare' | 'video' | 'thumbnail' | 'text' | 'validate' | 'commit';

export const EXPORT_STAGES: { id: ExportStage; label: string }[] = [
  { id: 'prepare', label: 'Reserve the folder' },
  { id: 'video', label: 'Render the video' },
  { id: 'thumbnail', label: 'Render the thumbnail' },
  { id: 'text', label: 'Write title, captions and chapters' },
  { id: 'validate', label: 'Check every file' },
  { id: 'commit', label: 'Move the package into place' },
];

export interface PackageProgress {
  stage: ExportStage;
  /** Real encoder counts while the video renders, else null. */
  render: RenderProgress | null;
  detail: string;
}

export interface PackageExportArgs {
  project: Project;
  projectPath: string;
  destDir: string;
  /** Draft = exported with acknowledged warnings; the folder name says so. */
  draft: boolean;
  onProgress(p: PackageProgress): void;
  signal: AbortSignal;
  /** Injectable for tests; defaults to the real renderer. */
  render?: (args: RenderArgs) => Promise<RenderResult>;
}

export interface PackageExportResult {
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  /** Final folder, or the clearly marked -PARTIAL folder, or null when nothing was kept. */
  folder: string | null;
  folderName: string;
  files: ExportRecord['files'];
  failedStage: ExportStage | null;
  error: { code: string; message: string } | null;
  /** What to append to project.exports; null when a cancel left nothing behind. */
  record: ExportRecord | null;
  notes: string[];
  video: RenderResult | null;
}

/** Rough size of the package about to be written (video at the YouTube bitrate target + 192 kbps audio + stills). */
export function estimateExportBytes(project: Project): number {
  const { width, height, fps } = project.edit.appearance.output;
  const out = TimeMap.fromEdit(project.duration, project.edit).outDuration;
  return Math.round(((estimateVideoBitrate(width, height, fps) + 192_000) / 8) * out + 6_000_000);
}

/**
 * Machine-readable failure code. Custom error properties do not survive
 * Electron's context bridge, so when `code` is missing it is recovered from
 * the message text.
 */
function codeOf(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code && code !== 'error') return code;
  const m = e instanceof Error ? e.message : String(e);
  if (/ENOSPC|EDQUOT|ran out of space|no space left/i.test(m)) return 'disk-full';
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(m)) return 'EACCES';
  if (/EROFS|read-only file system/i.test(m)) return 'EROFS';
  if (/ENOENT|no such file or directory/i.test(m)) return 'ENOENT';
  if (/already exists|appeared while exporting/i.test(m)) return 'exists';
  if (/cancel/i.test(m)) return 'cancelled';
  return code ?? 'error';
}

function messageFor(code: string, e: unknown): string {
  if (code === 'disk-full') return 'The destination ran out of space before the package was complete. Free some space or choose another folder, then export again.';
  if (code === 'cancelled') return 'Export cancelled.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'Cutaway is not allowed to write to this folder. Choose another folder and export again.';
  if (code === 'ENOENT') return 'The destination folder is no longer there (a drive may have been unplugged). Choose another folder and export again.';
  if (code === 'missing-source') return `A source file is missing: ${e instanceof Error ? e.message : String(e)}`;
  if (code === 'exists') return 'A folder with this name appeared while exporting. Nothing was overwritten; export again to use a new name.';
  return e instanceof Error ? e.message : String(e);
}

function creditsText(project: Project): string | null {
  const used = new Map<string, string[]>();
  const add = (id: string, use: string) => used.set(id, [...(used.get(id) ?? []), use]);
  for (const b of project.edit.broll) add(b.assetId, 'B-roll');
  if (project.edit.audio.music) add(project.edit.audio.music.sourceId, 'Music');
  if (used.size === 0) return null;
  const lines = ['Supporting material used in this video', ''];
  for (const [id, uses] of used) {
    const s = project.sources.find((x) => x.id === id);
    if (!s) continue;
    const ai = project.edit.broll.some((b) => b.assetId === id && b.meta.origin === 'ai');
    lines.push(`${s.name}`);
    lines.push(`  Used as: ${[...new Set(uses)].join(', ')}${ai ? ' (placed by the AI editor, reviewable in the project)' : ''}`);
    lines.push(`  Origin: supplied by the creator (${s.managed ? 'copied into the project' : `referenced at ${s.path}`})`);
    lines.push(`  License: ${s.license?.trim() || 'not recorded — confirm you have the right to publish this'}`);
    if (s.note?.trim()) lines.push(`  Note: ${s.note.trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Export one package. Never throws: failures come back as a result naming the
 * stage that failed. Retrying is always safe — a retry starts a fresh working
 * folder and nothing already on disk is overwritten.
 */
export async function runPackageExport(args: PackageExportArgs): Promise<PackageExportResult> {
  const { project, projectPath, destDir, draft, signal } = args;
  const api = window.cutaway.export;
  const render = args.render ?? renderVideo;
  const { width, height, fps } = project.edit.appearance.output;
  const notes: string[] = [];
  const written: ExportRecord['files'] = [];
  let stage: ExportStage = 'prepare';
  let sessionId: string | null = null;
  let folderName = packageFolderName(project.name, project.revision, [], draft);
  let video: RenderResult | null = null;
  const createdAt = new Date().toISOString();
  const step = (s: ExportStage, detail: string, r: RenderProgress | null = null) => {
    stage = s;
    args.onProgress({ stage: s, render: r, detail });
  };
  const guard = () => {
    if (signal.aborted) throw Object.assign(new Error('Export cancelled.'), { code: 'cancelled' });
  };
  const put = async (name: string, data: string | Uint8Array, note?: string) => {
    const r = await api.writeFile(sessionId!, name, data);
    written.push({ name, bytes: r.bytes, ok: r.bytes > 0, note });
  };
  const record = (status: ExportRecord['status'], folder: string, files: ExportRecord['files'], failedStage?: ExportStage): ExportRecord => ({
    id: uid('exp'),
    revision: project.revision,
    folder,
    createdAt,
    status,
    draft,
    files,
    settings: { width, height, fps },
    failedStage,
  });

  try {
    guard();
    step('prepare', 'Choosing a folder name that does not collide with an earlier export…');
    const existing = await api.existingFolders(destDir);
    folderName = packageFolderName(project.name, project.revision, existing, draft);
    const session = await api.begin(destDir, folderName);
    sessionId = session.id;

    // ── video ──
    guard();
    step('video', 'Starting the encoder…');
    video = await render({
      project,
      projectPath,
      sessionId,
      fileName: 'video.mp4',
      signal,
      onProgress: (r) => step('video', r.stage === 'audio' ? 'Mixing audio…' : r.stage === 'finalize' ? 'Finalising the MP4…' : r.stage === 'prepare' ? 'Opening the sources…' : 'Encoding frames…', r),
    });
    written.push({ name: 'video.mp4', bytes: video.bytes, ok: video.bytes > 0 });
    guard();

    // ── thumbnail ──
    const map = TimeMap.fromEdit(project.duration, project.edit);
    const selected = project.packaging.concepts.find((c) => c.id === project.packaging.selectedId) ?? null;
    let thumb: PackageManifest['thumbnail'] = null;
    step('thumbnail', selected ? 'Rendering the selected thumbnail at upload and master sizes…' : 'No thumbnail is selected.');
    if (selected) {
      const res = { projectPath, sources: project.sources };
      const upload = await thumbnailJpeg(selected.layers, res, { width: 1920, height: 1080, maxBytes: THUMB_UPLOAD_MAX_BYTES });
      await put('thumbnail.jpg', upload.data, `1920×1080 upload variant, JPEG quality ${Math.round(upload.quality * 100)}`);
      guard();
      const master = await thumbnailJpeg(selected.layers, res, { ...THUMB_MASTER, maxBytes: 48 * 1024 * 1024 });
      await put('thumbnail-master.jpg', master.data, `${THUMB_MASTER.width}×${THUMB_MASTER.height} master`);
      thumb = { file: 'thumbnail.jpg', master: 'thumbnail-master.jpg', width: 1920, height: 1080, variant: `upload JPEG under ${(THUMB_UPLOAD_MAX_BYTES / 1e6).toFixed(0)} MB` };
    } else notes.push('No thumbnail or title was selected, so thumbnail.jpg and title.txt were not written (draft export).');
    guard();

    // ── text files ──
    step('text', 'Writing title, description, chapters, captions and credits…');
    const titleOptions = [...new Set([selected?.title, ...project.packaging.concepts.map((c) => c.title)].map((t) => t?.trim()).filter((t): t is string => !!t))];
    if (selected) {
      const t = checkTitle(selected.title);
      if (!t.ok) throw Object.assign(new Error(t.problem ?? 'The title is not valid.'), { code: 'bad-title' });
      await put('title.txt', `${selected.title.trim()}\n`);
      await put('title-options.txt', `${titleOptions.join('\n')}\n`, `${titleOptions.length} option${titleOptions.length === 1 ? '' : 's'}, selected title first`);
    }

    const description = project.packaging.description.trim();
    if (description) {
      const d = checkDescription(description);
      if (!d.ok) throw Object.assign(new Error(d.problem ?? 'The description is not valid.'), { code: 'bad-description' });
      await put('description.txt', `${description}\n`);
    } else notes.push('description.txt omitted: no description was written.');

    const chapters = chaptersToOutput(project.packaging.chapters, map);
    let chapterInfo: PackageManifest['chapters'] = { file: null, count: 0, youtubeValid: false, note: 'No chapters were defined.' };
    if (chapters.length) {
      const cc = checkChapters(chapters, map.outDuration);
      if (cc.valid) {
        await put('chapters.txt', formatChapters(chapters), 'YouTube chapters (paste into the description)');
        chapterInfo = { file: 'chapters.txt', count: chapters.length, youtubeValid: true, note: null };
      } else {
        const body = `Section notes — not YouTube chapters (${cc.problems[0]})\n\n${chapters.map((c) => `${chapterStamp(c.time)} ${c.title}`).join('\n')}\n`;
        await put('chapters.txt', body, 'Plain section notes; these do not meet YouTube chapter rules');
        chapterInfo = { file: 'chapters.txt', count: chapters.length, youtubeValid: false, note: cc.problems[0] ?? null };
        notes.push(`chapters.txt holds plain section notes: ${cc.problems[0]}`);
      }
    } else notes.push('chapters.txt omitted: no chapters were defined.');

    const cues = buildCues(project.transcript, project.edit, map);
    let captions: PackageManifest['captions'];
    if (project.transcript?.hasSpeech && cues.length) {
      await put('captions.srt', toSrt(cues), `${cues.length} captions timed to the final cut`);
      captions = { file: 'captions.srt', language: project.transcript.locale, cues: cues.length, omittedReason: null };
    } else {
      const why = !project.transcript ? 'The project was not transcribed.' : !project.transcript.hasSpeech ? 'No speech was found in the recording.' : 'Every spoken passage was cut from the edit.';
      captions = { file: null, language: null, cues: 0, omittedReason: why };
      notes.push(`captions.srt omitted: ${why}`);
    }

    const credits = creditsText(project);
    if (credits) await put('credits.txt', credits);
    else notes.push('credits.txt omitted: the edit uses no B-roll or music.');
    guard();

    // ── validate ──
    step('validate', 'Confirming every file is on disk and not empty…');
    const checked: ExportRecord['files'] = [];
    for (const f of written) {
      const st = await api.stat(sessionId, f.name);
      checked.push({ ...f, bytes: st?.bytes ?? 0, ok: !!st && st.bytes > 0 });
    }
    const bad = checked.filter((f) => !f.ok);
    if (bad.length) throw Object.assign(new Error(`${bad.map((f) => f.name).join(', ')} ${bad.length === 1 ? 'is' : 'are'} missing or empty.`), { code: 'validation-failed' });
    if (Math.abs(video.duration - map.outDuration) > Math.max(0.5, 2 / fps)) notes.push(`The video is ${video.duration.toFixed(2)}s but the edit is ${map.outDuration.toFixed(2)}s; check the end of the video.`);

    const manifest: PackageManifest = {
      app: 'Cutaway',
      project: { id: project.id, name: project.name },
      editRevision: project.revision,
      createdAt,
      draft,
      status: 'complete',
      video: { file: 'video.mp4', width: video.width, height: video.height, fps: video.fps, duration: video.duration, codec: video.videoCodec, audio: video.audioCodec ?? 'none', color: 'SDR BT.709' },
      title: selected?.title.trim() ?? null,
      titleOptions,
      thumbnail: thumb,
      captions,
      chapters: chapterInfo,
      files: checked,
      validation: { ok: true, notes },
      uploadedToYouTube: false,
    };
    await put('package.json', `${JSON.stringify(manifest, null, 2)}\n`, 'Revision, settings, file list and validation outcome');
    guard();

    // ── commit ──
    step('commit', 'Moving the finished package into place…');
    const done = await api.commit(sessionId, written.map((f) => f.name));
    sessionId = null;
    const files: ExportRecord['files'] = done.files.map((f) => ({ name: f.name, bytes: f.bytes, ok: f.bytes > 0, note: written.find((w) => w.name === f.name)?.note }));
    return { status: 'complete', folder: done.folder, folderName, files, failedStage: null, error: null, record: record('complete', done.folder, files), notes, video };
  } catch (e) {
    const code = signal.aborted ? 'cancelled' : codeOf(e);
    const error = { code, message: messageFor(code, e) };
    const failedStage = stage;
    // A finished video is worth keeping; anything less is removed so nothing half-written looks usable.
    const keepPartial = !!video && video.bytes > 0;
    let folder: string | null = null;
    if (sessionId) {
      try {
        folder = (await api.abort(sessionId, keepPartial)).folder;
      } catch {
        folder = null;
      }
    }
    if (code === 'cancelled' && !folder) return { status: 'cancelled', folder: null, folderName, files: [], failedStage, error, record: null, notes, video };
    const status: ExportRecord['status'] = folder ? 'partial' : 'failed';
    const files = folder ? written : [];
    return { status: code === 'cancelled' ? 'cancelled' : status, folder, folderName, files, failedStage, error, record: record(status, folder ?? `${destDir}/${folderName}`, files, failedStage), notes, video };
  }
}

// ───────────────────────────── running export (survives navigation) ─────────────────────────────

export interface ExportJob {
  projectId: string;
  status: 'running' | 'done';
  stage: ExportStage;
  render: RenderProgress | null;
  detail: string;
  startedAt: number;
  destDir: string;
  draft: boolean;
  result: PackageExportResult | null;
  abort: AbortController;
}

/**
 * The export keeps running when the creator navigates to another screen, so
 * its state lives outside the Export component.
 */
export const useExportJob = create<{ job: ExportJob | null; set(job: ExportJob | null): void; patch(p: Partial<ExportJob>): void }>((set, get) => ({
  job: null,
  set: (job) => set({ job }),
  patch: (p) => {
    const job = get().job;
    if (job) set({ job: { ...job, ...p } });
  },
}));

export function startPackageExport(args: Omit<PackageExportArgs, 'onProgress' | 'signal'>, onFinished: (r: PackageExportResult) => void): void {
  const store = useExportJob.getState();
  if (store.job?.status === 'running') return;
  const abort = new AbortController();
  store.set({ projectId: args.project.id, status: 'running', stage: 'prepare', render: null, detail: 'Starting…', startedAt: Date.now(), destDir: args.destDir, draft: args.draft, result: null, abort });
  void runPackageExport({ ...args, signal: abort.signal, onProgress: (p) => useExportJob.getState().patch({ stage: p.stage, render: p.render, detail: p.detail }) }).then((result) => {
    useExportJob.getState().patch({ status: 'done', result });
    onFinished(result);
  });
}
