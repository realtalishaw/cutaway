import type { Brief, Clip, DecisionMeta, EditOp, EditState, LayoutMode, MediaSource, Project, Range, RevisionRecord, Seconds, SourceRole } from './types';
import { EPS, uid } from './ranges';
import { defaultSync, sessionDuration } from './sync';
import { applyOps, clearAiInRange, defaultAudio, emptyEdit, materialChange, pickMasterVoice, revisionSummary } from './edit';
import { emptyPackaging } from './packaging';
import { validateOps } from './validate';
import { MAIN_TAKE, appendClips, clipLength, clipsDuration, clipsOf, playingClips, removeClip, isTimelineSource, layoutClips, placeSources, projectWithEdit, sessionMap, remapEdit, takeDuration, takeOf } from './clips';

export const DEFAULT_BRIEF: Brief = {
  audience: 'People learning this for the first time',
  targetDuration: 'auto',
  pacing: 'balanced',
  visualIntensity: 'balanced',
  allowBroll: true,
  notes: '',
};

export function createProject(name: string, sources: MediaSource[] = []): Project {
  const now = new Date().toISOString();
  return {
    schema: 1,
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    duration: sessionDuration(sources),
    sources,
    transcript: null,
    analysis: null,
    brief: { ...DEFAULT_BRIEF },
    edit: emptyEdit(sources),
    revision: 1,
    revisions: [],
    firstCut: null,
    packaging: emptyPackaging(),
    exports: [],
    consent: null,
    stages: {},
    ui: { playhead: 0, view: 'sources', expandedTimeline: false },
  };
}

export interface ProbeLike {
  path: string;
  ok: boolean;
  kind?: 'video' | 'audio' | 'image';
  duration?: number;
  sizeBytes?: number;
  createdAt?: string | null;
  video?: { width: number; height: number; fps: number; variableFrameRate?: boolean; codec?: string } | null;
  audio?: { channels: number; sampleRate: number; codec?: string } | null;
  /** Pixel size of a still image. */
  image?: { width: number; height: number } | null;
}

export function suggestRole(probe: ProbeLike, existing: MediaSource[]): SourceRole {
  const has = (r: SourceRole) => existing.some((s) => s.role === r);
  if (probe.kind === 'image') return 'image';
  if (probe.kind === 'audio') return has('voice') || (probe.duration ?? 0) < 20 ? 'music' : 'voice';
  const name = probe.path.toLowerCase();
  if (/b-?roll|cutaway|insert|stock/.test(name)) return 'broll';
  if (/screen|display|capture|recording|demo/.test(name) && !has('screen')) return 'screen';
  if (/cam|face|webcam|selfie|a-?cam|iphone|dslr/.test(name)) return !has('cameraA') ? 'cameraA' : !has('cameraB') ? 'cameraB' : 'broll';
  if (!has('screen') && !has('cameraA')) {
    // Wide desktop-shaped pixels are usually a screen; otherwise a camera.
    const w = probe.video?.width ?? 0;
    const h = probe.video?.height ?? 1;
    const ratio = w / h;
    return ratio > 1.5 && ratio < 1.62 ? 'screen' : w >= 2560 ? 'screen' : 'cameraA';
  }
  if (!has('cameraA')) return 'cameraA';
  if (!has('cameraB')) return 'cameraB';
  return 'broll';
}

export function sourceFromProbe(probe: ProbeLike, role: SourceRole, opts: { managed: boolean; origin: MediaSource['origin']; name?: string }): MediaSource {
  const timeline = role === 'screen' || role === 'cameraA' || role === 'cameraB' || role === 'voice';
  return {
    id: uid('src'),
    role,
    name: opts.name ?? probe.path.split('/').pop() ?? 'media',
    path: probe.path,
    managed: opts.managed,
    origin: opts.origin,
    kind: probe.kind ?? 'video',
    duration: probe.duration ?? 0,
    width: probe.video?.width ?? probe.image?.width,
    height: probe.video?.height ?? probe.image?.height,
    fps: probe.video?.fps,
    variableFrameRate: probe.video?.variableFrameRate,
    codec: probe.video?.codec ?? probe.audio?.codec,
    hasAudio: !!probe.audio,
    audioChannels: probe.audio?.channels,
    sampleRate: probe.audio?.sampleRate,
    fingerprint: { sizeBytes: probe.sizeBytes ?? 0, duration: probe.duration ?? 0, createdAt: probe.createdAt ?? null },
    available: probe.ok,
    // An imported file is flattened: whatever cursor it shows is burned in.
    cursorBaked: opts.origin === 'import',
    sync: timeline ? defaultSync(opts.origin === 'recording' ? 'recorded-clock' : 'reference') : defaultSync('reference'),
    gaps: [],
  };
}

/** Is a candidate file the same media as the missing source? */
export function relinkMatch(source: MediaSource, probe: ProbeLike): { match: 'exact' | 'likely' | 'different'; detail: string } {
  if (!probe.ok) return { match: 'different', detail: 'The selected file cannot be read.' };
  const dDur = Math.abs((probe.duration ?? 0) - source.fingerprint.duration);
  const sameSize = probe.sizeBytes === source.fingerprint.sizeBytes;
  const sameDims = (probe.video?.width ?? source.width) === source.width && (probe.video?.height ?? source.height) === source.height;
  if (sameSize && dDur < 0.05) return { match: 'exact', detail: 'Same size and duration as the original.' };
  if (dDur < 0.1 && sameDims) return { match: 'likely', detail: 'Same duration and dimensions, but a different file size. It may be a re-encoded copy.' };
  return { match: 'different', detail: `This file is ${(probe.duration ?? 0).toFixed(1)}s long; the original was ${source.fingerprint.duration.toFixed(1)}s. Edits would not line up.` };
}

/** Recompute the timeline length and audio defaults after sources change. */
export function withSources(project: Project, sources: MediaSource[]): Project {
  if (project.edit.clips) return withSourcesAndClips(project, sources);
  const audio = project.edit.audio;
  const fresh = defaultAudio(sources);
  // a file whose role changed to music, B-roll or an image is no longer a voice, even though it still has sound
  const masterStillThere = sources.some((s) => s.id === audio.masterVoiceId && s.hasAudio && isTimelineSource(s));
  const tracks = { ...fresh.tracks };
  if (masterStillThere) {
    for (const id of Object.keys(tracks)) {
      const src = sources.find((s) => s.id === id)!;
      tracks[id] = audio.tracks[id] ?? { gain: 1, muted: !(id === audio.masterVoiceId || src.role === 'systemAudio') };
    }
  }
  return {
    ...project,
    sources,
    duration: sessionDuration(sources),
    edit: { ...project.edit, audio: masterStillThere ? { ...audio, tracks } : { ...audio, ...fresh } },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The audible voice of every footage group, and a track entry for every source with sound. Each group
 * has its own voice: in a group, that voice and the system audio are heard and the rest starts muted.
 */
export function audioForTakes(audio: EditState['audio'], sources: MediaSource[]): EditState['audio'] {
  const records = sources.filter((s) => !s.instanceOf);
  const takes = [...new Set(records.filter(isTimelineSource).map(takeOf))];
  let masterVoiceId = audio.masterVoiceId;
  const takeVoices: Record<string, string> = {};
  const tracks: EditState['audio']['tracks'] = {};
  const has = (id: string | null | undefined) => !!id && records.some((s) => s.id === id && s.hasAudio);
  for (const take of takes) {
    const mine = records.filter((s) => isTimelineSource(s) && takeOf(s) === take);
    const chosen = take === MAIN_TAKE ? masterVoiceId : audio.takeVoices?.[take];
    const voice = has(chosen) && mine.some((s) => s.id === chosen) ? chosen! : (pickMasterVoice(mine)?.id ?? null);
    if (take === MAIN_TAKE) masterVoiceId = voice;
    else if (voice) takeVoices[take] = voice;
    for (const s of mine) {
      if (!s.hasAudio) continue;
      const isSystem = s.role === 'systemAudio';
      tracks[s.id] = audio.tracks[s.id] ?? { gain: isSystem ? 0.6 : 1, muted: !(s.id === voice || isSystem) };
    }
  }
  // A project whose first footage came in as a later group still needs one voice for level and cleanup.
  if (!has(masterVoiceId)) masterVoiceId = takes.includes(MAIN_TAKE) ? masterVoiceId : (Object.values(takeVoices)[0] ?? null);
  for (const s of records) {
    if (!s.hasAudio || isTimelineSource(s)) continue;
    tracks[s.id] = audio.tracks[s.id] ?? { gain: 1, muted: true };
  }
  const next: EditState['audio'] = { ...audio, masterVoiceId, tracks };
  if (Object.keys(takeVoices).length) next.takeVoices = takeVoices;
  else delete next.takeVoices;
  return next;
}

/** Is this source the audible voice of its footage group? (Voice cleanup and level apply to these.) */
export function isMasterVoice(audio: Pick<EditState['audio'], 'masterVoiceId' | 'takeVoices'>, source: Pick<MediaSource, 'id' | 'instanceOf'>): boolean {
  const id = source.instanceOf ?? source.id;
  if (id === audio.masterVoiceId) return true;
  return !!audio.takeVoices && Object.values(audio.takeVoices).includes(id);
}

/** Level and mute of a source. A second placement of a file follows the file's own entry. */
export function trackOf(audio: Pick<EditState['audio'], 'tracks'>, source: Pick<MediaSource, 'id' | 'instanceOf'>): { gain: number; muted: boolean } | undefined {
  return audio.tracks[source.id] ?? (source.instanceOf ? audio.tracks[source.instanceOf] : undefined);
}

/**
 * After the source list changed in a project that has clips: a take whose length changed stretches or
 * shrinks its last clip (and everything after it moves), second placements are re-derived, and each
 * footage group keeps its own audible voice.
 */
function withSourcesAndClips(project: Project, sources: MediaSource[]): Project {
  const records = sources.filter((s) => !s.instanceOf);
  let clips = project.edit.clips!;
  const fitted = clips.map((c) => ({ ...c }));
  let changed = false;
  for (const take of new Set(fitted.map((c) => c.take))) {
    const length = takeDuration(records, take);
    if (length <= 0) continue;
    const last = fitted.filter((c) => c.take === take).reduce((a, b) => (b.out > a.out ? b : a));
    if (Math.abs(last.out - length) > 1e-3 && length - last.in > 0.05) {
      last.out = length;
      changed = true;
    }
  }
  let edit = project.edit;
  if (changed) {
    const to = layoutClips(fitted);
    edit = { ...remapEdit(edit, sessionMap(clips, to)), clips: to };
    clips = to;
  }
  edit = { ...edit, audio: audioForTakes(edit.audio, records) };
  const base: Project = { ...project, sources: records };
  const next = changed ? projectWithEdit(base, edit) : { ...base, edit, sources: placeSources(records, clips), duration: clipsDuration(clips) };
  return { ...next, updatedAt: new Date().toISOString() };
}

/** Choose the single audible voice; every other voice-bearing source is muted. */
export function setMasterVoice(edit: EditState, sources: MediaSource[], id: string): EditState {
  const tracks: EditState['audio']['tracks'] = {};
  const chosen = sources.find((s) => s.id === id);
  const take = chosen ? takeOf(chosen) : MAIN_TAKE;
  for (const s of sources) {
    if (!s.hasAudio || s.instanceOf) continue;
    const prev = edit.audio.tracks[s.id] ?? { gain: 1, muted: true };
    const voiceLike = s.role === 'voice' || s.role === 'cameraA' || s.role === 'cameraB' || s.role === 'screen';
    // Each footage group has its own voice: choosing one leaves the other groups as they are.
    tracks[s.id] = voiceLike && takeOf(s) === take ? { ...prev, muted: s.id !== id } : prev;
  }
  if (take !== MAIN_TAKE) return { ...edit, audio: { ...edit.audio, takeVoices: { ...edit.audio.takeVoices, [take]: id }, tracks } };
  return { ...edit, audio: { ...edit.audio, masterVoiceId: id, tracks } };
}

// ───────────────────────────── adding footage as a clip ─────────────────────────────

export interface NewTake {
  /** Group key for the new sources (a recorder take id, or a fresh id for an import). */
  take: string;
  name: string;
  /** Timeline sources of the take, on the take's own clock (as recorded or as imported). */
  sources: MediaSource[];
  baseLayout?: LayoutMode;
  /** Flags dropped while recording, in take seconds. */
  flags?: Seconds[];
}

/**
 * Add footage as a new clip at the end of the timeline. Not an undoable edit (like any other change
 * to the source list); removing the clip afterwards is.
 */
export function addTakeAsClip(project: Project, take: NewTake): Project {
  const sources = take.sources.map((s) => ({ ...s, take: take.take }));
  const length = takeDuration(sources, take.take);
  if (length <= EPS) return project;
  // An empty project's placeholder clip has no length and is not carried along.
  const clips = clipsOf(project).filter((c) => clipLength(c) > EPS);
  if (clips.some((c) => c.take === take.take)) return project;
  const withAll: Project = { ...project, sources: [...project.sources, ...sources] };
  const clip: Omit<Clip, 'start'> = { id: take.take, take: take.take, name: take.name, in: 0, out: length, ...(take.baseLayout ? { baseLayout: take.baseLayout } : {}) };
  const edit = appendClips({ edit: { ...project.edit, clips }, duration: project.duration }, [clip]);
  const next = projectWithEdit({ ...withAll, edit: { ...project.edit, clips } }, edit);
  const at = next.edit.clips!.find((c) => c.id === take.take)!.start;
  const flags = (take.flags ?? []).filter((t) => Number.isFinite(t) && t >= 0 && t <= length + 1e-3).map((t) => ({ id: uid('flag'), t: t + at, takeId: take.take }));
  // the new group gets its own audible voice; the groups already there keep theirs
  const audio = audioForTakes(next.edit.audio, next.sources);
  return { ...next, edit: { ...next.edit, audio }, ...(flags.length ? { flags: [...(next.flags ?? []), ...flags].sort((a, b) => a.t - b.t) } : {}), updatedAt: new Date().toISOString() };
}

/**
 * The project with only one footage group on its timeline: every other clip is taken off, as if it
 * had been removed. For showing or rendering one take by itself; the result is never saved.
 */
export function projectOfTake(project: Project, take: string): Project {
  const clips = clipsOf(project);
  if (!project.edit.clips || !clips.some((c) => c.take === take && !c.removed)) return project;
  let p = project;
  for (const c of clips) {
    if (c.removed || c.take === take) continue;
    if (playingClips(clipsOf(p)).length < 2) break;
    p = projectWithEdit(p, removeClip(p, c.id));
  }
  return p;
}

/**
 * Take a footage group out of the project altogether: its clips, its sources, and what was written
 * about it (words, flags). Not an undoable edit. Used when a take is deleted, or kept as B-roll instead.
 */
export function dropTake(project: Project, take: string): Project {
  const mine = (s: MediaSource) => isTimelineSource(s) && takeOf(s) === take;
  if (!project.edit.clips || !project.edit.clips.some((c) => c.take === take)) return project;
  // first off the timeline (this moves the rest together and parks the clip's decisions), then out of the list
  let p = project;
  for (const c of clipsOf(project).filter((x) => x.take === take && !x.removed)) {
    if (playingClips(clipsOf(p)).length < 2) break;
    p = projectWithEdit(p, removeClip(p, c.id));
  }
  const gone = clipsOf(p).filter((c) => c.take === take).map((c) => ({ start: c.start, end: c.start + clipLength(c) }));
  const inGone = (t: Seconds) => gone.some((r) => t >= r.start - EPS && t < r.end - EPS);
  const rest = clipsOf(p).filter((c) => c.take !== take);
  const sources = p.sources.filter((s) => !mine(s));
  const transcript = p.transcript ? { ...p.transcript, words: p.transcript.words.filter((w) => !inGone(w.start)), ...(p.transcript.parked ? { parked: p.transcript.parked.filter((w) => !inGone(w.start)) } : {}) } : p.transcript;
  const analysis = p.analysis?.parked ? { ...p.analysis, parked: { silences: p.analysis.parked.silences.filter((r) => !inGone(r.start)), clicks: p.analysis.parked.clicks.filter((c) => !inGone(c.t)) } } : p.analysis;
  const flags = p.flags?.filter((f) => !inGone(f.t));
  const audio = { ...p.edit.audio, tracks: Object.fromEntries(Object.entries(p.edit.audio.tracks).filter(([id]) => sources.some((s) => s.id === id))) };
  if (audio.takeVoices) {
    const { [take]: _dropped, ...others } = audio.takeVoices;
    void _dropped;
    if (Object.keys(others).length) audio.takeVoices = others;
    else delete audio.takeVoices;
  }
  const base: Project = { ...p, sources, transcript, analysis, ...(flags ? { flags } : {}), edit: { ...p.edit, audio } };
  if (rest.length === 0) {
    // nothing left on the timeline: back to an empty project
    const edit = { ...base.edit };
    delete edit.clips;
    return { ...base, edit, sources: sources.filter((s) => !s.instanceOf), duration: 0, updatedAt: new Date().toISOString() };
  }
  const next = projectWithEdit(base, { ...base.edit, clips: layoutClips(rest) });
  return { ...next, updatedAt: new Date().toISOString() };
}

// ───────────────────────────── revisions ─────────────────────────────

const MAX_REVISIONS = 40;

/** Save a named checkpoint of the current edit so it can be restored later. */
export function checkpoint(project: Project, label: string, origin: DecisionMeta['origin'], extra: Pick<RevisionRecord, 'via' | 'messageId'> = {}): Project {
  const rec: RevisionRecord = { revision: project.revision, label, origin, createdAt: new Date().toISOString(), summary: revisionSummary(project), snapshot: project.edit, ...(extra.via ? { via: extra.via } : {}), ...(extra.messageId ? { messageId: extra.messageId } : {}) };
  // one checkpoint per (revision, label): a later checkpoint at the same revision must not erase an AI cut
  const revisions = [...project.revisions.filter((r) => !(r.revision === project.revision && r.label === label)), rec];
  // Keep AI checkpoints longest: they are the ones a creator wants to get back to.
  while (revisions.length > MAX_REVISIONS) {
    const i = revisions.findIndex((r) => r.origin === 'creator');
    revisions.splice(i >= 0 ? i : 0, 1);
  }
  return { ...project, revisions };
}

/** Replace the edit, bump the revision and mark dependent packaging stale when the change is material. */
export function commitEdit(project: Project, edit: EditState): Project {
  if (edit === project.edit) return project;
  const revision = project.revision + 1;
  let packaging = project.packaging;
  if (packaging.concepts.length > 0 && !packaging.stale) {
    const base = project.revisions.find((r) => r.revision === packaging.basedOnRevision)?.snapshot ?? project.edit;
    const m = materialChange(base, edit, project.duration);
    if (m.material) packaging = { ...packaging, stale: true, staleReason: m.reason, reviewed: false };
  }
  // When the clip order differs, everything outside the edit that is in session time is re-laid to match.
  const placed = projectWithEdit(project, edit);
  if (placed.packaging !== project.packaging) packaging = { ...placed.packaging, stale: packaging.stale, staleReason: packaging.staleReason, reviewed: packaging.reviewed };
  return { ...placed, revision, packaging, updatedAt: new Date().toISOString() };
}

export function restoreRevision(project: Project, revision: number): Project {
  const rec = project.revisions.find((r) => r.revision === revision);
  if (!rec) return project;
  const saved = checkpoint(project, 'Before restore', 'creator');
  return commitEdit(saved, rec.snapshot);
}

export interface ProposalOutcome {
  project: Project;
  accepted: number;
  rejected: ReturnType<typeof validateOps>['rejected'];
  adjusted: ReturnType<typeof validateOps>['adjusted'];
}

/**
 * The single entry point for AI edits. Validates the untrusted proposal,
 * checkpoints the current edit, optionally clears earlier AI decisions inside
 * `scope`, then applies what survived. Creator decisions and locks are never
 * overwritten.
 */
export function applyProposal(project: Project, rawOps: unknown, opts: { label: string; scope?: Range; replaceAi?: ('cuts' | 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll')[] }): ProposalOutcome {
  const res = validateOps(project, rawOps, { origin: 'ai', scope: opts.scope });
  const saved = checkpoint(project, `Before: ${opts.label}`, 'creator');
  const revision = saved.revision + 1;
  let edit = saved.edit;
  if (opts.replaceAi?.length) {
    edit = clearAiInRange(edit, opts.scope ?? { start: 0, end: project.duration }, opts.replaceAi);
    if (!opts.scope) edit = { ...edit, suggestions: edit.suggestions.filter((s) => s.status !== 'open') };
  }
  edit = applyOps(edit, res.accepted as EditOp[], 'ai', revision);
  let next = commitEdit(saved, edit);
  next = checkpoint(next, opts.label, 'ai');
  return { project: next, accepted: res.accepted.length, rejected: res.rejected, adjusted: res.adjusted };
}

/** Stable key of the inputs to a processing stage, so finished stages are not repeated. */
export function stageKey(project: Project, stage: string): string {
  // Where a clip sits on the timeline is not an input: moving clips must not repeat transcription or analysis.
  const src = project.sources
    .filter((s) => !s.instanceOf)
    .map((s) => `${s.id}:${s.fingerprint.sizeBytes}:${(s.sync.offset - (s.shift ?? 0)).toFixed(3)}:${s.sync.rate.toFixed(6)}`)
    .join('|');
  const voices = project.edit.audio.takeVoices ? `${project.edit.audio.masterVoiceId}+${Object.values(project.edit.audio.takeVoices).join('+')}` : project.edit.audio.masterVoiceId;
  if (stage === 'transcribe' || stage === 'visual' || stage === 'sync') return `${stage}#${src}#${voices}`;
  return `${stage}#${src}#${JSON.stringify(project.brief)}`;
}
