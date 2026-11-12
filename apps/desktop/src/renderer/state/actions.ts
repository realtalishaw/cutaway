import { sourceFromProbe, suggestRole, withSources, type MediaSource, type Project } from '@cutaway/core';
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
  accepted: { probe: ProbeResult; source: MediaSource }[];
  rejected: ProbeResult[];
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
