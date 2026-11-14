/**
 * Turning a finished (or recovered) take into project sources.
 *
 * Importing this module installs one window listener for the
 * 'cutaway-recovered-take' event the Library dispatches after recovering an
 * interrupted recording, so no wiring is needed elsewhere.
 */
import { addTakeAsClip, dropTake, isTimelineSource, nextClipName, uid, withSources, withTakeFlags, type LayoutMode, type MediaSource, type Project, type SourceRole } from '@cutaway/core';
import type { ProbeResult, TakeManifest, TakeSource } from '@shared/api';
import { useApp } from './store';

const api = () => window.cutaway;

const ROLE_NAME: Record<TakeSource['role'], string> = {
  screen: 'Screen',
  cameraA: 'Camera A',
  cameraB: 'Camera B',
  voice: 'Microphone',
  systemAudio: 'System audio',
};

/** Project-relative folder of a take ("media/take-001"), or the absolute path if it lives elsewhere. */
export function takeRelativeDir(takeDir: string, projectPath: string): string {
  const base = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return takeDir.startsWith(base) ? takeDir.slice(base.length) : takeDir;
}

/**
 * Sources of one take. Every file stays its own independently editable track,
 * placed on the session clock by the start offset the recorder measured, so
 * sources recorded together need no audio sync.
 */
export async function takeToSources(manifest: TakeManifest, takeDir: string, projectPath: string): Promise<MediaSource[]> {
  const rel = takeRelativeDir(takeDir, projectPath);
  const usable = manifest.sources.filter((s) => s.file && s.duration > 0.05);
  let probes: ProbeResult[] = [];
  try {
    probes = await api().native.probe(usable.map((s) => `${takeDir}/${s.file}`));
  } catch {
    // Probing is only for identity/metadata; the manifest is enough to build the sources.
  }
  const takeLabel = manifest.takeId.replace(/^take-0*/, 'Take ');
  return usable.map((s, i) => {
    const probe = probes[i]?.ok ? probes[i]! : null;
    const isVideo = s.role === 'screen' || s.role === 'cameraA' || s.role === 'cameraB';
    const duration = probe?.duration && Math.abs(probe.duration - s.duration) < 1 ? s.duration : (probe?.duration ?? s.duration);
    const source: MediaSource = {
      id: uid('src'),
      role: s.role as SourceRole,
      name: `${ROLE_NAME[s.role]}${s.deviceName ? ` · ${s.deviceName}` : ''} (${takeLabel})`,
      path: `${rel}/${s.file}`,
      managed: true,
      origin: 'recording',
      kind: isVideo ? 'video' : 'audio',
      duration,
      width: s.width ?? probe?.video?.width,
      height: s.height ?? probe?.video?.height,
      fps: s.fps ?? probe?.video?.fps,
      variableFrameRate: probe?.video?.variableFrameRate,
      codec: probe?.video?.codec ?? probe?.audio?.codec,
      hasAudio: isVideo ? !!probe?.audio : true,
      audioChannels: s.channels ?? probe?.audio?.channels,
      sampleRate: s.sampleRate ?? probe?.audio?.sampleRate,
      fingerprint: { sizeBytes: probe?.sizeBytes ?? 0, duration, createdAt: probe?.createdAt ?? manifest.startedAt ?? null },
      available: probe ? true : probes.length === 0,
      takeId: manifest.takeId,
      // Only the screen can carry a cursor; cameras never have one burned in.
      cursorBaked: s.role === 'screen' ? !!s.cursorBaked : false,
      cursorFile: s.role === 'screen' && !s.cursorBaked && manifest.cursor?.file ? `${rel}/${manifest.cursor.file}` : undefined,
      // Keyboard telemetry (shortcuts and typing ticks, never characters) belongs to the screen source.
      keysFile: s.role === 'screen' && manifest.keys?.file ? `${rel}/${manifest.keys.file}` : undefined,
      // A USB iPhone / iPad recorded as the screen: no cursor data, optional device frame.
      deviceKind: s.role === 'screen' ? (s.deviceKind ?? undefined) : undefined,
      pointWidth: s.pointWidth,
      pointHeight: s.pointHeight,
      sync: { offset: s.start, rate: 1, method: 'recorded-clock', confidence: null, status: 'aligned', checkpoints: [], calibration: [], confirmedByCreator: true },
      gaps: (s.gaps ?? []).map((g) => ({ start: g.start, end: g.end, reason: g.reason })),
      note: manifest.recovered ? 'Recovered after an interrupted recording.' : undefined,
    };
    return source;
  });
}

export interface AddTakeResult {
  added: MediaSource[];
  /** Sources that were added as supporting media (B-roll, music) instead of going on the timeline. */
  demoted: string[];
  alreadyPresent: boolean;
  /** Name of the clip the take became, when it went on the timeline after footage that was already there. */
  clip?: string;
}

/** Where a take goes when the project already has footage: after it on the timeline, or among the supporting media. */
export type TakeUse = 'clip' | 'broll';

const SINGLE: SourceRole[] = ['screen', 'cameraA', 'cameraB'];

/** Add a take to the open project. Safe to call twice for the same take. */
/**
 * The layout chosen in the recorder, as the editor's base view for this take. A layout that
 * needs both pictures is only kept when the take has both; otherwise the sources decide.
 */
export function baseLayoutFor(layout: LayoutMode | undefined, roles: SourceRole[]): LayoutMode | undefined {
  if (!layout) return undefined;
  const screen = roles.includes('screen');
  const camera = roles.includes('cameraA') || roles.includes('cameraB');
  if (layout === 'screen') return screen ? 'screen' : undefined;
  if (layout === 'camera') return camera ? 'camera' : undefined;
  return screen && camera ? layout : undefined;
}

export async function addTakeToProject(manifest: TakeManifest, takeDir: string, opts: { layout?: LayoutMode; as?: TakeUse } = {}): Promise<AddTakeResult> {
  const app = useApp.getState();
  const { projectPath, project } = app;
  if (!projectPath || !project) throw new Error('No project is open.');
  if (project.sources.some((s) => s.takeId === manifest.takeId && s.origin === 'recording')) return { added: [], demoted: [], alreadyPresent: true };
  const fresh = await takeToSources(manifest, takeDir, projectPath);
  if (fresh.length === 0) throw new Error('The take contains no usable media.');
  // A project that already has footage on its timeline gets the take as a new clip after it (or, if
  // asked, as supporting media). Nothing is quietly turned into B-roll any more.
  const hasFootage = project.sources.some((s) => isTimelineSource(s) && s.kind === 'video');
  if (hasFootage && opts.as !== 'broll' && fresh.some((s) => s.kind === 'video')) {
    let clip: string | undefined;
    useApp.getState().patch((p: Project) => {
      if (p.sources.some((s) => s.takeId === manifest.takeId && s.origin === 'recording')) return p;
      clip = nextClipName(p);
      return addTakeAsClip(p, { take: manifest.takeId, name: clip, sources: fresh, baseLayout: baseLayoutFor(opts.layout, fresh.map((s) => s.role)), flags: (manifest.flags ?? []).filter((t) => t <= manifest.duration + 0.001) });
    });
    return { added: fresh, demoted: [], alreadyPresent: false, clip };
  }
  const demoted: string[] = [];
  const taken = new Set(project.sources.map((s) => s.role));
  const added = fresh.map((s) => {
    if (hasFootage || ((SINGLE.includes(s.role) || s.role === 'voice') && taken.has(s.role))) {
      demoted.push(s.name);
      const role: SourceRole = s.kind === 'video' ? 'broll' : 'music';
      return { ...s, role };
    }
    return s;
  });
  useApp.getState().patch((p: Project) => {
    if (p.sources.some((s) => s.takeId === manifest.takeId && s.origin === 'recording')) return p;
    // Flags are take seconds; a take's clock is the session clock.
    const next = withTakeFlags(withSources(p, [...p.sources, ...added]), manifest.takeId, (manifest.flags ?? []).filter((t) => t <= manifest.duration + 0.001));
    // The recorder's layout becomes the starting view, unless this take only added supporting media.
    const base = baseLayoutFor(opts.layout, added.map((s) => s.role));
    return base ? { ...next, edit: { ...next.edit, baseLayout: base } } : next;
  });
  return { added, demoted, alreadyPresent: false };
}

/**
 * Change your mind about a take that was just added: move it from the timeline to the supporting
 * media, or from there onto the timeline as a clip. The files are not touched.
 */
export async function setTakeUse(manifest: TakeManifest, takeDir: string, use: TakeUse, opts: { layout?: LayoutMode } = {}): Promise<AddTakeResult> {
  useApp.getState().patch((p: Project) => {
    const mine = (s: MediaSource) => s.takeId === manifest.takeId && s.origin === 'recording';
    if (!p.sources.some(mine)) return p;
    const dropped = dropTake(p, manifest.takeId);
    const kept = dropped.sources.filter((s) => !mine(s));
    return { ...withSources({ ...dropped, sources: kept }, kept), flags: (dropped.flags ?? []).filter((f) => f.takeId !== manifest.takeId) };
  });
  return addTakeToProject(manifest, takeDir, { ...opts, as: use });
}

export function describeTake(manifest: TakeManifest): string {
  const names = manifest.sources.filter((s) => s.duration > 0.05).map((s) => ROLE_NAME[s.role].toLowerCase());
  const gaps = manifest.sources.reduce((n, s) => n + (s.gaps?.length ?? 0), 0);
  const list = names.length <= 1 ? (names[0] ?? 'nothing') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list}${gaps ? ` (${gaps} gap${gaps === 1 ? '' : 's'} marked)` : ''}`;
}

/** Handler for the Library's "recovered take" event. */
export async function onRecoveredTake(detail: { takeDir: string; manifest: TakeManifest }): Promise<void> {
  const app = useApp.getState();
  try {
    const r = await addTakeToProject(detail.manifest, detail.takeDir);
    useApp.getState().go('project');
    useApp.getState().setView('sources');
    if (r.alreadyPresent) app.toast('That recording is already in this project.');
    else app.toast(`Recovered ${detail.manifest.duration.toFixed(0)}s of ${describeTake(detail.manifest)}.`);
  } catch (e) {
    app.toast(`The recovered take could not be added: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}

let installed = false;
/** Idempotent. Called at module load; exported in case a host wants to be explicit. */
export function initRecordingListeners(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('cutaway-recovered-take', (e) => {
    const detail = (e as CustomEvent<{ takeDir: string; manifest: TakeManifest }>).detail;
    if (detail?.takeDir && detail.manifest) void onRecoveredTake(detail);
  });
}
initRecordingListeners();
