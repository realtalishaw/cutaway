import type { ExportRecord, Packaging, PackagingConcept, Project, Seconds, ThumbnailLayer } from './types';
import { uid } from './ranges';
import { TimeMap } from './timemap';
import { buildCues, chaptersToOutput, checkChapters } from './captions';
import { unresolvedGaps } from './frame';

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const THUMB_MASTER = { width: 3840, height: 2160 };
export const THUMB_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

export function checkTitle(title: string): { ok: boolean; problem: string | null } {
  const t = title.trim();
  if (!t) return { ok: false, problem: 'Title is empty.' };
  if (t.length > TITLE_MAX) return { ok: false, problem: `Title is ${t.length} characters; YouTube allows ${TITLE_MAX}.` };
  if (/[<>]/.test(t)) return { ok: false, problem: 'Titles cannot contain < or >.' };
  return { ok: true, problem: null };
}

export function checkDescription(d: string): { ok: boolean; problem: string | null } {
  if (d.length > DESCRIPTION_MAX) return { ok: false, problem: `Description is ${d.length} characters; YouTube allows ${DESCRIPTION_MAX}.` };
  if (/[<>]/.test(d)) return { ok: false, problem: 'Descriptions cannot contain < or >.' };
  return { ok: true, problem: null };
}

export function emptyPackaging(): Packaging {
  return { concepts: [], selectedId: null, description: '', chapters: [], basedOnRevision: null, stale: false, staleReason: null, reviewed: false };
}

export type ThumbTemplate = 'headline' | 'banner' | 'badge';

export interface ThumbPalette {
  accent: string;
  ink: string;
  paper: string;
}

export const PALETTES: ThumbPalette[] = [
  { accent: '#ff5a36', ink: '#120d0b', paper: '#fff6ea' },
  { accent: '#f5c84b', ink: '#14110a', paper: '#fffdf5' },
  { accent: '#6fd3c0', ink: '#08130f', paper: '#f2fffb' },
  { accent: '#ff7ab6', ink: '#16090f', paper: '#fff4f9' },
];

/**
 * A real, editable thumbnail composition: an actual frame of the footage plus
 * typography. Everything is a layer the creator can move, restyle or delete.
 */
export function buildThumbnail(template: ThumbTemplate, frame: { sourceId: string; time: Seconds } | null, text: string, palette: ThumbPalette): ThumbnailLayer[] {
  const layers: ThumbnailLayer[] = [];
  const f = (x: number, y: number, scale: number, brightness = 1, saturation = 1.08, blur = 0): ThumbnailLayer | null =>
    frame ? { id: uid('tl'), kind: 'frame', sourceId: frame.sourceId, time: frame.time, x, y, scale, brightness, saturation, blur, mirror: false } : null;
  const txt = (o: Partial<Extract<ThumbnailLayer, { kind: 'text' }>>): ThumbnailLayer => ({
    id: uid('tl'),
    kind: 'text',
    text,
    x: 0.5,
    y: 0.5,
    size: 0.16,
    maxWidth: 0.8,
    font: 'display',
    weight: 800,
    color: palette.paper,
    stroke: null,
    strokeWidth: 0,
    background: null,
    rotation: 0,
    align: 'center',
    uppercase: true,
    ...o,
  });
  const add = (l: ThumbnailLayer | null) => l && layers.push(l);
  if (template === 'headline') {
    add(f(0.62, 0.5, 1.12));
    layers.push({ id: uid('tl'), kind: 'scrim', from: palette.ink, to: 'transparent', angle: 90, opacity: 0.94 });
    layers.push({ id: uid('tl'), kind: 'shape', shape: 'rect', x: 0.06, y: 0.2, w: 0.09, h: 0.022, color: palette.accent, rotation: 0, opacity: 1 });
    layers.push(txt({ x: 0.06, y: 0.52, size: 0.165, maxWidth: 0.5, align: 'left' }));
  } else if (template === 'banner') {
    add(f(0.5, 0.44, 1.04));
    layers.push({ id: uid('tl'), kind: 'scrim', from: 'transparent', to: palette.ink, angle: 180, opacity: 0.55 });
    layers.push({ id: uid('tl'), kind: 'shape', shape: 'rect', x: -0.02, y: 0.68, w: 1.04, h: 0.25, color: palette.accent, rotation: -2.2, opacity: 1 });
    layers.push(txt({ x: 0.5, y: 0.805, size: 0.135, maxWidth: 0.9, color: palette.ink, rotation: -2.2, weight: 900 }));
  } else {
    add(f(0.5, 0.5, 1.06, 0.62, 0.9, 0.004));
    layers.push({ id: uid('tl'), kind: 'shape', shape: 'pill', x: 0.38, y: 0.12, w: 0.24, h: 0.085, color: palette.accent, rotation: 0, opacity: 1 });
    layers.push(txt({ x: 0.5, y: 0.56, size: 0.19, maxWidth: 0.86, stroke: palette.ink, strokeWidth: 0.012, weight: 900 }));
  }
  return layers;
}

export function conceptFromTemplate(template: ThumbTemplate, title: string, thumbText: string, frame: { sourceId: string; time: Seconds } | null, palette: ThumbPalette, rationale: string, evidence: PackagingConcept['evidence'], origin: PackagingConcept['origin']): PackagingConcept {
  return { id: uid('pc'), title: title.slice(0, TITLE_MAX), layers: buildThumbnail(template, frame, thumbText, palette), rationale, evidence, origin, editedByCreator: false };
}

// ───────────────────────────── export package ─────────────────────────────

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'untitled'
  );
}

/** Folder name that identifies the revision and never collides with an existing export. */
export function packageFolderName(projectName: string, revision: number, existing: string[], draft = false): string {
  const base = `${slugify(projectName)}-youtube${draft ? '-draft' : ''}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  const rev = `${base}-rev${revision}`;
  if (!taken.has(rev)) return rev;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${rev}-${i}`)) return `${rev}-${i}`;
  return `${rev}-${Date.now()}`;
}

export interface PreflightCheck {
  id: string;
  level: 'ok' | 'warn' | 'block';
  title: string;
  detail: string;
  action?: 'relink' | 'sync' | 'packaging' | 'free-space' | 'chapters';
  sourceId?: string;
}

export interface PreflightInput {
  freeBytes: number | null;
  /** Rough size of the video about to be written. */
  estimatedBytes: number;
}

/** Bitrate targets follow YouTube's SDR upload guidance. */
export function estimateVideoBitrate(width: number, height: number, fps: number): number {
  const high = fps > 30;
  if (height >= 2160) return high ? 60_000_000 : 40_000_000;
  if (height >= 1440) return high ? 24_000_000 : 16_000_000;
  if (height >= 1080) return high ? 12_000_000 : 8_000_000;
  return high ? 7_500_000 : 5_000_000;
}

export function exportPreflight(project: Project, input: PreflightInput): { checks: PreflightCheck[]; canExport: boolean; canExportDraft: boolean } {
  const checks: PreflightCheck[] = [];
  const map = TimeMap.fromEdit(project.duration, project.edit);
  const used = new Set<string>(['screen', 'cameraA', 'cameraB']);
  for (const s of project.sources) {
    const needed = used.has(s.role) || s.id === project.edit.audio.masterVoiceId || project.edit.broll.some((b) => b.assetId === s.id) || project.edit.audio.music?.sourceId === s.id;
    if (!needed) continue;
    if (!s.available) checks.push({ id: `missing-${s.id}`, level: 'block', title: `"${s.name}" is missing`, detail: 'The file has moved or the drive is offline. Relink it to export.', action: 'relink', sourceId: s.id });
  }
  if (!checks.some((c) => c.level === 'block')) checks.push({ id: 'sources', level: 'ok', title: 'All source media is available', detail: `${project.sources.length} file${project.sources.length === 1 ? '' : 's'} checked.` });

  if (map.outDuration < 0.5) checks.push({ id: 'empty', level: 'block', title: 'The edit is empty', detail: 'Everything has been cut. Restore some footage first.' });

  const unsynced = project.sources.filter((s) => ['cameraA', 'cameraB', 'voice'].includes(s.role) && (s.sync.status !== 'aligned' || !s.sync.confirmedByCreator));
  for (const s of unsynced) {
    checks.push({ id: `sync-${s.id}`, level: 'warn', title: `"${s.name}" sync is not confirmed`, detail: s.sync.status === 'unsynced' ? 'It has no alignment and is not used in the edit.' : 'Review the alignment before a final export.', action: 'sync', sourceId: s.id });
  }

  const gaps = unresolvedGaps(project, map);
  if (gaps.length) {
    const total = gaps.reduce((s, g) => s + (g.end - g.start), 0);
    checks.push({ id: 'gaps', level: 'warn', title: 'Some moments have no usable picture', detail: `${total.toFixed(1)}s across ${gaps.length} range${gaps.length === 1 ? '' : 's'} ask for a source that has no footage there.` });
  }

  const cues = buildCues(project.transcript, project.edit, map);
  if (project.transcript?.hasSpeech) {
    const bad = cues.some((c, i) => c.end <= c.start || (i > 0 && c.start < cues[i - 1]!.end - 1e-3));
    checks.push(bad ? { id: 'captions', level: 'warn', title: 'Caption timing needs review', detail: 'Some caption intervals overlap.' } : { id: 'captions', level: 'ok', title: 'Captions match the edit', detail: `${cues.length} captions timed to the final cut.` });
  } else {
    checks.push({ id: 'captions', level: 'ok', title: 'No captions', detail: project.transcript ? 'No speech was found, so no caption file will be written.' : 'The project has not been transcribed, so no caption file will be written.' });
  }

  const sel = project.packaging.concepts.find((c) => c.id === project.packaging.selectedId);
  if (!sel) checks.push({ id: 'packaging', level: 'warn', title: 'No thumbnail and title selected', detail: 'Choose a pair in Package, or export a draft without them.', action: 'packaging' });
  else {
    const t = checkTitle(sel.title);
    if (!t.ok) checks.push({ id: 'title', level: 'block', title: 'Title needs fixing', detail: t.problem!, action: 'packaging' });
    else if (project.packaging.stale) checks.push({ id: 'packaging', level: 'warn', title: 'Thumbnail and title were made for an earlier cut', detail: project.packaging.staleReason ?? 'Review them against the current edit.', action: 'packaging' });
    else checks.push({ id: 'packaging', level: 'ok', title: 'Thumbnail and title selected', detail: sel.title });
  }
  const d = checkDescription(project.packaging.description);
  if (!d.ok) checks.push({ id: 'description', level: 'block', title: 'Description needs fixing', detail: d.problem!, action: 'packaging' });

  const ch = chaptersToOutput(project.packaging.chapters, map);
  if (ch.length) {
    const cc = checkChapters(ch, map.outDuration);
    checks.push(cc.valid ? { id: 'chapters', level: 'ok', title: `${ch.length} chapters`, detail: 'Timestamps follow the final cut.' } : { id: 'chapters', level: 'warn', title: 'Chapters do not meet YouTube rules', detail: `${cc.problems[0]} They will be exported as plain section notes.`, action: 'chapters' });
  }

  const { width, height, fps } = project.edit.appearance.output;
  checks.push({ id: 'video', level: 'ok', title: `${height === 2160 ? '4K' : `${height}p`} · ${fps} fps · H.264 + AAC`, detail: `${width}×${height}, SDR BT.709, about ${(input.estimatedBytes / 1e6).toFixed(0)} MB.` });

  if (input.freeBytes !== null) {
    const need = input.estimatedBytes * 1.3 + 200e6;
    if (input.freeBytes < need) checks.push({ id: 'disk', level: 'block', title: 'Not enough free space', detail: `Export needs about ${(need / 1e9).toFixed(1)} GB; ${(input.freeBytes / 1e9).toFixed(1)} GB is free at the destination.`, action: 'free-space' });
    else checks.push({ id: 'disk', level: 'ok', title: 'Enough free space', detail: `${(input.freeBytes / 1e9).toFixed(1)} GB free.` });
  }

  const blocked = checks.some((c) => c.level === 'block');
  const warned = checks.some((c) => c.level === 'warn');
  return { checks, canExport: !blocked && !warned, canExportDraft: !blocked };
}

export interface PackageManifest {
  app: 'Cutaway';
  project: { id: string; name: string };
  editRevision: number;
  createdAt: string;
  draft: boolean;
  status: ExportRecord['status'];
  video: { file: string; width: number; height: number; fps: number; duration: Seconds; codec: string; audio: string; color: string } | null;
  title: string | null;
  titleOptions: string[];
  thumbnail: { file: string; master: string | null; width: number; height: number; variant: string; /** Present when the thumbnail contains AI-generated pictures. */ aiGenerated?: { provider: string; layers: number } } | null;
  captions: { file: string | null; language: string | null; cues: number; omittedReason: string | null };
  chapters: { file: string | null; count: number; youtubeValid: boolean; note: string | null };
  files: ExportRecord['files'];
  validation: { ok: boolean; notes: string[] };
  uploadedToYouTube: false;
}
