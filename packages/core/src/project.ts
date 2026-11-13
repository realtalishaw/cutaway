import type { Brief, DecisionMeta, EditOp, EditState, MediaSource, Project, Range, RevisionRecord, SourceRole } from './types';
import { uid } from './ranges';
import { defaultSync, sessionDuration } from './sync';
import { applyOps, clearAiInRange, defaultAudio, emptyEdit, materialChange, revisionSummary } from './edit';
import { emptyPackaging } from './packaging';
import { validateOps } from './validate';

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
    width: probe.video?.width,
    height: probe.video?.height,
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
  const audio = project.edit.audio;
  const fresh = defaultAudio(sources);
  const masterStillThere = sources.some((s) => s.id === audio.masterVoiceId && s.hasAudio);
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

/** Choose the single audible voice; every other voice-bearing source is muted. */
export function setMasterVoice(edit: EditState, sources: MediaSource[], id: string): EditState {
  const tracks: EditState['audio']['tracks'] = {};
  for (const s of sources) {
    if (!s.hasAudio) continue;
    const prev = edit.audio.tracks[s.id] ?? { gain: 1, muted: true };
    const voiceLike = s.role === 'voice' || s.role === 'cameraA' || s.role === 'cameraB' || s.role === 'screen';
    tracks[s.id] = voiceLike ? { ...prev, muted: s.id !== id } : prev;
  }
  return { ...edit, audio: { ...edit.audio, masterVoiceId: id, tracks } };
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
  return { ...project, edit, revision, packaging, updatedAt: new Date().toISOString() };
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
  const src = project.sources.map((s) => `${s.id}:${s.fingerprint.sizeBytes}:${s.sync.offset.toFixed(3)}:${s.sync.rate.toFixed(6)}`).join('|');
  if (stage === 'transcribe' || stage === 'visual' || stage === 'sync') return `${stage}#${src}#${project.edit.audio.masterVoiceId}`;
  return `${stage}#${src}#${JSON.stringify(project.brief)}`;
}
