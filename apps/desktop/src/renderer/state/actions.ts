import { PHOTO_SECONDS, addTakeAsClip, clipsOf, defaultSync, isPhotoClip, photoSourcesLongEnough, setClipLength, dropTake, isTimelineSource, meta, musicClipsOf, newMusicClip, nextClipName, sourceFromProbe, suggestRole, takeOf, uid, withMusic, withSources, type MediaSource, type Project, type SourceRole } from '@cutaway/core';
import type { ProbeResult } from '@shared/api';
import { create } from 'zustand';
import { saveNow, timeMapOf, useApp, usePlayback } from './store';

const api = () => window.cutaway;

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function openProjectAt(path: string) {
  const app = useApp.getState();
  try {
    await saveNow();
    const { project, missing } = await api().library.open(path);
    app.openProject(path, project);
    if (missing.length) app.toast(`${missing.length} source file${missing.length === 1 ? ' is' : 's are'} missing. Relink in Sources.`, 'error');
  } catch (e) {
    app.toast(`Could not open the project: ${errorText(e)}`, 'error');
  }
}

/** Set by the recorder while a take is in progress, so navigation cannot orphan it. */
let recordingActive = false;
export function setRecordingActive(on: boolean) {
  recordingActive = on;
}
export const isRecordingActive = () => recordingActive;

/**
 * A take recording a demo of Cutaway itself: the creator moves around the app while it runs. `projectPath` is
 * the project the take belongs to, whatever is open when it ends.
 */
export const useDemoTake = create<{ projectPath: string | null }>(() => ({ projectPath: null }));

export async function backToLibrary() {
  const demo = useDemoTake.getState().projectPath;
  if (recordingActive && !demo) return useApp.getState().toast('Stop the recording first. It keeps running until you do.');
  await saveNow();
  const { project, projectPath } = useApp.getState();
  useApp.getState().closeProject();
  // A project that never received any media is not worth keeping (unless a demo take is being written into it).
  if (project && projectPath && project.sources.length === 0 && projectPath !== demo) await api().library.trash(projectPath).catch(() => {});
}

/** New projects start from the creator's default style preset, when one is set. */
function withDefaultPreset(project: Project): Project {
  const settings = useApp.getState().settings;
  const preset = settings?.presets.find((p) => p.id === settings.defaultPresetId);
  if (!preset) return project;
  return { ...project, brief: { ...project.brief, ...preset.brief }, edit: { ...project.edit, appearance: { ...preset.appearance, output: project.edit.appearance.output, crop: project.edit.appearance.crop } } };
}

function stamp(): string {
  const d = new Date();
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/:/g, '.')}`;
}

export async function newRecording() {
  const app = useApp.getState();
  if (recordingActive) return app.toast('A recording is already in progress.');
  try {
    await saveNow();
    const { path, project } = await api().library.create(`Recording ${stamp()}`);
    app.openProject(path, withDefaultPreset(project));
    app.go('record');
  } catch (e) {
    app.toast(`Could not start a project: ${errorText(e)}`, 'error');
  }
}

/** Results of inspecting files before they become sources. */
export interface ImportReport {
  /** `clip`: the clip a video became when it was added after footage that was already on the timeline. */
  accepted: { probe: ProbeResult; source: MediaSource; clip?: string }[];
  rejected: ProbeResult[];
}

const hasFootage = (sources: MediaSource[]) => sources.some((s) => isTimelineSource(s) && s.kind === 'video' && !s.instanceOf);

/** The role a video plays as a clip of its own: a screen recording or a camera, judged from the file alone. */
function clipRole(s: Pick<MediaSource, 'path' | 'duration' | 'width' | 'height' | 'fps'>): SourceRole {
  const role = suggestRole({ path: s.path, ok: true, kind: 'video', duration: s.duration, video: { width: s.width ?? 0, height: s.height ?? 0, fps: s.fps ?? 30 } }, []);
  return role === 'screen' ? 'screen' : 'cameraA';
}

/** A video as a source that can be a clip of its own: placed at the start of its own clock. */
function asClipSource(s: MediaSource): MediaSource {
  // a photo is the picture of its clip, shown for PHOTO_SECONDS until its length is changed
  const fresh: MediaSource = s.kind === 'image' ? { ...s, role: 'screen', duration: Math.max(s.duration, PHOTO_SECONDS), hasAudio: false, cursorBaked: true, sync: defaultSync('reference'), gaps: [] } : { ...s, role: clipRole(s), sync: defaultSync('reference'), gaps: [] };
  delete fresh.shift;
  delete fresh.window;
  delete fresh.take;
  return fresh;
}

/**
 * Put a supporting video on the timeline as a clip of its own, after what is already there.
 * Returns the clip's name, or null when nothing changed.
 */
export function sourceToClip(sourceId: string): string | null {
  let name: string | null = null;
  useApp.getState().patch((p: Project) => {
    const s = p.sources.find((x) => x.id === sourceId);
    if (!s || (s.kind !== 'video' && s.kind !== 'image') || isTimelineSource(s) || !s.available) return p;
    const rest = p.sources.filter((x) => x.id !== sourceId);
    const base = withSources({ ...p, edit: { ...p.edit, broll: p.edit.broll.filter((b) => b.assetId !== sourceId) } }, rest);
    if (!hasFootage(rest)) {
      name = s.kind === 'image' ? photoName(s) : 'Clip 1';
      return withSources(base, [...rest, asClipSource(s)]);
    }
    name = s.kind === 'image' ? photoName(s) : nextClipName(base);
    return addTakeAsClip(base, { take: uid('take'), name, sources: [asClipSource(s)] });
  });
  return name;
}

const photoName = (s: MediaSource) => s.name.replace(/\.[^.]+$/, '') || 'Photo';

/** Put pictures from the project's media on the timeline, each as a clip of its own after what is there. */
export function photosToClips(sourceIds: string[]): number {
  let n = 0;
  for (const id of sourceIds) if (sourceToClip(id)) n++;
  return n;
}

/**
 * How long a photo clip plays. Changes made with the same `gesture` (one drag, one slider) are one undo
 * step; the photo's picture is only ever made longer.
 */
export function setPhotoLength(clipId: string, seconds: number, gesture = 'set') {
  const app = useApp.getState();
  const p = app.project;
  const clip = p ? clipsOf(p).find((c) => c.id === clipId) : undefined;
  if (!p || !clip || !isPhotoClip(p, clip)) return;
  const sources = photoSourcesLongEnough(p.sources, clip.take, clip.in + seconds);
  if (sources !== p.sources) app.patch((q) => ({ ...q, sources: photoSourcesLongEnough(q.sources, clip.take, clip.in + seconds) }));
  app.edit((_e, q) => setClipLength(q, clipId, seconds), 'Photo length', `photo-length:${clipId}:${gesture}`);
}

/** Take a clip's footage off the timeline for good and keep its video among the supporting media as B-roll. */
export function takeToBroll(take: string): void {
  useApp.getState().patch((p: Project) => {
    const mine = p.sources.filter((s) => !s.instanceOf && isTimelineSource(s) && takeOf(s) === take);
    if (mine.length === 0 || !p.edit.clips) return p;
    const dropped = dropTake(p, take);
    const back = mine.map((s) => {
      const role: SourceRole = s.kind === 'video' ? 'broll' : 'music';
      const kept: MediaSource = { ...s, role, sync: defaultSync('reference'), gaps: [] };
      delete kept.shift;
      delete kept.window;
      delete kept.take;
      return kept;
    });
    const all = [...dropped.sources, ...back];
    return withSources({ ...dropped, sources: all }, all);
  });
}

/** Turn probed files into sources with suggested roles. Unsupported files are reported, never silently dropped. */
export function sourcesFromProbes(probes: ProbeResult[], existing: MediaSource[], managed: boolean): ImportReport {
  const accepted: ImportReport['accepted'] = [];
  const rejected: ProbeResult[] = [];
  const all = [...existing];
  for (const probe of probes) {
    if (!probe.ok) {
      rejected.push(probe);
      continue;
    }
    const role = suggestRole(probe, all);
    const source = sourceFromProbe(probe, role, { managed, origin: 'import' });
    all.push(source);
    accepted.push({ probe, source });
  }
  return { accepted, rejected };
}

/** Add files to the open project. Returns what happened so the UI can show the inspection. */
export interface ImportOptions {
  /** Treat every audio file as music (Add audio on the timeline), whatever its length suggests. */
  audioAsMusic?: boolean;
  /** Treat every video as B-roll and every picture as an image over the video (Add photo / B-roll). */
  asOverlay?: boolean;
}

export async function importFiles(paths: string[], opts: ImportOptions = {}): Promise<ImportReport | null> {
  const app = useApp.getState();
  const { projectPath, project, settings } = app;
  if (!projectPath || !project || paths.length === 0) return null;
  const mode = settings?.importMode ?? 'copy';
  try {
    const probes = await api().library.importMedia(projectPath, paths, mode);
    const report = sourcesFromProbes(probes, project.sources, mode === 'copy');
    for (const a of report.accepted) {
      const role: SourceRole | null = opts.audioAsMusic && a.source.kind === 'audio' ? 'music' : opts.asOverlay ? (a.source.kind === 'video' ? 'broll' : a.source.kind === 'image' ? 'image' : null) : null;
      if (role && a.source.role !== role) a.source = { ...a.source, role, sync: defaultSync('reference') };
    }
    if (opts.asOverlay) {
      app.patch((p: Project) => withSources(p, [...p.sources, ...report.accepted.map((a) => a.source)]));
      recordImportReport(report);
      return report;
    }
    // A project that already has footage on its timeline: each new video becomes a clip after it, unless
    // its name says it is B-roll. (It can be moved to the supporting media, or back, in Sources.)
    if (hasFootage(project.sources)) {
      const clips = report.accepted.filter(({ source, probe }) => source.kind === 'video' && suggestRole(probe, []) !== 'broll');
      const rest = report.accepted.filter((a) => !clips.includes(a)).map(({ source }) =>
        source.kind === 'video' ? { ...source, role: 'broll' as const, sync: defaultSync('reference') } : isTimelineSource(source) ? { ...source, sync: { ...source.sync, method: 'unsynced' as const, status: 'needs-review' as const, confirmedByCreator: false } } : source,
      );
      for (const a of report.accepted) if (!clips.includes(a) && a.source.kind === 'video') a.source = { ...a.source, role: 'broll' };
      app.patch((p: Project) => {
        let next = rest.length ? withSources(p, [...p.sources, ...rest]) : p;
        for (const a of clips) {
          a.clip = nextClipName(next);
          a.source = asClipSource(a.source);
          next = addTakeAsClip(next, { take: uid('take'), name: a.clip, sources: [a.source] });
        }
        return next;
      });
      recordImportReport(report);
      return report;
    }
    if (report.accepted.length) {
      // Secondary cameras and voice files from another device start unsynced until reviewed.
      const hasTimeline = project.sources.some((s) => ['screen', 'cameraA', 'cameraB'].includes(s.role));
      let first = !hasTimeline;
      const added = report.accepted.map(({ source }) => {
        const timeline = ['screen', 'cameraA', 'cameraB', 'voice'].includes(source.role);
        if (!timeline) return source;
        if (first) {
          first = false;
          return source;
        }
        return { ...source, sync: { ...source.sync, method: 'unsynced' as const, status: 'needs-review' as const, confirmedByCreator: false } };
      });
      app.patch((p: Project) => withSources(p, [...p.sources, ...added]));
    }
    recordImportReport(report);
    return report;
  } catch (e) {
    app.toast(`Import failed: ${errorText(e)}`, 'error');
    return null;
  }
}

export async function importIntoNewProject(paths: string[]): Promise<ImportReport | null> {
  if (paths.length === 0) return null;
  const app = useApp.getState();
  try {
    await saveNow();
    const base = (paths[0]!.split('/').pop() ?? 'Import').replace(/\.[^.]+$/, '');
    const { path, project } = await api().library.create(base);
    app.openProject(path, withDefaultPreset(project));
    return await importFiles(paths);
  } catch (e) {
    app.toast(`Could not import: ${errorText(e)}`, 'error');
    return null;
  }
}

export async function pickAndImport(intoNew: boolean): Promise<ImportReport | null> {
  const paths = await api().app.pickFiles({ title: 'Import media', kinds: ['video', 'audio', 'image'], multiple: true });
  if (paths.length === 0) return null;
  return intoNew ? importIntoNewProject(paths) : importFiles(paths);
}

/**
 * Put a music file on the audio row at the playhead (or at the start of the video when it has no music
 * yet) and select it. Returns the new clip's id.
 */
export function placeMusic(sourceId: string): string | null {
  const app = useApp.getState();
  const p0 = app.project;
  const file = p0?.sources.find((s) => s.id === sourceId);
  if (!p0 || !file) return null;
  let id = '';
  app.edit((e, p) => {
    const clips = musicClipsOf(e, p.sources);
    const map = timeMapOf(p);
    const at = clips.length ? Math.min(usePlayback.getState().time, Math.max(0, map.outDuration - 0.5)) : 0;
    const clip = newMusicClip(file, at, map.outDuration, meta('creator', p.revision + 1));
    id = clip.id;
    return withMusic(e, [...clips, clip]);
  }, 'Add audio');
  if (id) app.select({ kind: 'music', id });
  return id || null;
}

/** Import audio files as music and place each on the audio row, one after another from the playhead. */
export async function importAudioToTimeline(paths: string[]): Promise<number> {
  const report = await importFiles(paths, { audioAsMusic: true });
  const added = report?.accepted.filter((a) => a.source.role === 'music') ?? [];
  let placed = 0;
  for (const a of added) {
    if (!placeMusic(a.source.id)) continue;
    placed++;
    // the next file starts where this one ends
    const p = useApp.getState().project!;
    const last = musicClipsOf(p.edit, p.sources).find((c) => c.sourceId === a.source.id);
    if (last) usePlayback.getState().seek(Math.min(timeMapOf(p).outDuration, last.start + last.length));
  }
  if (added.length < (report?.accepted.length ?? 0)) useApp.getState().toast('Only sound files go on the audio row; the rest were added to your media.');
  return placed;
}

export async function pickAudioToTimeline(): Promise<number> {
  const paths = await api().app.pickFiles({ title: 'Add audio', kinds: ['audio'], multiple: true });
  return paths.length ? importAudioToTimeline(paths) : 0;
}

/**
 * Add files dropped on (or picked for) the video row: videos and photos become clips at the end of the
 * timeline. Videos named as B-roll are returned for the caller to show over the footage.
 */
export async function importVideosToTimeline(paths: string[]): Promise<string[]> {
  const report = await importFiles(paths);
  // photos become clips of their own, like videos; a video named as B-roll still goes over the footage
  photosToClips(report?.accepted.filter((a) => a.source.kind === 'image').map((a) => a.source.id) ?? []);
  return report?.accepted.filter((a) => a.source.kind === 'video' && a.source.role === 'broll').map((a) => a.source.id) ?? [];
}

export async function pickVideosToTimeline(): Promise<string[]> {
  const paths = await api().app.pickFiles({ title: 'Add video', kinds: ['video', 'image'], multiple: true });
  return paths.length ? importVideosToTimeline(paths) : [];
}

/** Import pictures or videos and show them over the footage at the playhead. Returns the new source ids. */
export async function pickOverlayMedia(): Promise<string[]> {
  const paths = await api().app.pickFiles({ title: 'Add photo or B-roll', kinds: ['image', 'video'], multiple: true });
  if (!paths.length) return [];
  const report = await importFiles(paths, { asOverlay: true });
  return report?.accepted.map((a) => a.source.id) ?? [];
}

export function droppedPaths(e: DragEvent | React.DragEvent): string[] {
  const files = Array.from(e.dataTransfer?.files ?? []);
  return files.map((f) => api().app.pathForFile(f)).filter(Boolean);
}

// ───────────────────────────── import inspection (appended) ─────────────────────────────

/**
 * The most recent import inspection, kept so the Sources screen can show what
 * was accepted and what was refused even when the import started elsewhere.
 * Callers of importFiles/importIntoNewProject pass their result to
 * recordImportReport().
 */
let lastImportReport: { report: ImportReport; projectPath: string; at: number } | null = null;
const importListeners = new Set<() => void>();

export function recordImportReport(report: ImportReport | null): void {
  const projectPath = useApp.getState().projectPath;
  if (!report || !projectPath) return;
  lastImportReport = { report, projectPath, at: Date.now() };
  importListeners.forEach((l) => l());
}

export function clearImportReport(): void {
  lastImportReport = null;
  importListeners.forEach((l) => l());
}

export function getImportReport(): { report: ImportReport; projectPath: string; at: number } | null {
  return lastImportReport;
}

export function subscribeImportReport(listener: () => void): () => void {
  importListeners.add(listener);
  return () => importListeners.delete(listener);
}

/** Paths of File objects from a file input or a drop. */
export function filePaths(files: FileList | File[] | null | undefined): string[] {
  return Array.from(files ?? [])
    .map((f) => api().app.pathForFile(f))
    .filter(Boolean);
}
