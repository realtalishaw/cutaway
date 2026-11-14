import { addTakeAsClip, defaultSync, dropTake, isTimelineSource, nextClipName, sourceFromProbe, suggestRole, takeOf, uid, withSources, type MediaSource, type Project, type SourceRole } from '@cutaway/core';
import type { ProbeResult } from '@shared/api';
import { saveNow, useApp } from './store';

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

export async function backToLibrary() {
  if (recordingActive) return useApp.getState().toast('Stop the recording first. It keeps running until you do.');
  await saveNow();
  const { project, projectPath } = useApp.getState();
  useApp.getState().closeProject();
  // A project that never received any media is not worth keeping.
  if (project && projectPath && project.sources.length === 0) await api().library.trash(projectPath).catch(() => {});
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
  const fresh: MediaSource = { ...s, role: clipRole(s), sync: defaultSync('reference'), gaps: [] };
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
    if (!s || s.kind !== 'video' || isTimelineSource(s) || !s.available) return p;
    const rest = p.sources.filter((x) => x.id !== sourceId);
    const base = withSources({ ...p, edit: { ...p.edit, broll: p.edit.broll.filter((b) => b.assetId !== sourceId) } }, rest);
    if (!hasFootage(rest)) {
      name = 'Clip 1';
      return withSources(base, [...rest, asClipSource(s)]);
    }
    name = nextClipName(base);
    return addTakeAsClip(base, { take: uid('take'), name, sources: [asClipSource(s)] });
  });
  return name;
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
export async function importFiles(paths: string[]): Promise<ImportReport | null> {
  const app = useApp.getState();
  const { projectPath, project, settings } = app;
  if (!projectPath || !project || paths.length === 0) return null;
  const mode = settings?.importMode ?? 'copy';
  try {
    const probes = await api().library.importMedia(projectPath, paths, mode);
    const report = sourcesFromProbes(probes, project.sources, mode === 'copy');
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
