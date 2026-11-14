/**
 * What AI tools (through cutaway-mcp) can do in Cutaway. Every handler uses the same functions as the app's own
 * buttons, so changes are validated, undoable, saved as versions and shown live in the window.
 *
 * Times: "recording seconds" are the footage's own timeline (what the transcript and edit decisions use); "video
 * seconds" are the finished video's timeline (what music, voiceovers, frames and exports use). `get_project`
 * lists how the two line up.
 */
import {
  DEFAULT_BOX,
  MOTION_META_ID,
  TEXT_TEMPLATES,
  TimeMap,
  applyProposal,
  clampBox,
  clipsOf,
  fmtTime,
  historyOf,
  meta,
  motionPixels,
  musicClipsOf,
  overlaysFromTemplate,
  parseMotionMeta,
  withMusic,
  type Brief,
  type EditState,
  type Project,
} from '@cutaway/core';
import type { GenKind, GenProvider } from '@shared/api';
import { runFileExport } from '../engine/packageExport';
import { runFirstCut } from '../jobs/firstCut';
import { addMotion, setMotionBox } from '../motion/actions';
import { motionContract } from '../motion/author';
import { MOTION_TEMPLATES, ownTemplates } from '../motion/templates';
import { ASPECTS, sizeFor } from '../screens/Editor';
import { importFiles, openProjectAt, photosToClips, placeMusic, setPhotoLength } from '../state/actions';
import { placeGenerated } from '../state/generated';
import { jobContext, startFirstCut } from '../state/jobs';
import { saveNow, timeMapOf, useApp, usePlayback } from '../state/store';

type Params = Record<string, unknown>;
export type ToolResult = unknown;

const app = () => useApp.getState();
const r2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required.`);
  return v.trim();
};
const num = (v: unknown, name: string, opt = false): number | undefined => {
  if (v === undefined || v === null) {
    if (opt) return undefined;
    throw new Error(`"${name}" is required.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${name}" must be a number.`);
  return n;
};
function project(): { p: Project; path: string } {
  const { project: p, projectPath } = app();
  if (!p || !projectPath) throw new Error('No project is open. Use create_project or open_project first.');
  return { p, path: projectPath };
}
/** Show the editor, so the creator sees what is happening. */
function showEditor() {
  const a = app();
  if (a.route !== 'project') a.go('project');
  if (a.project && a.project.ui.view !== 'edit') a.setView('edit');
}
const label = (s: unknown, fallback: string) => `AI tool: ${typeof s === 'string' && s.trim() ? s.trim().slice(0, 60) : fallback}`;

// ───────────────────────────── reading ─────────────────────────────

function summary(p: Project, path: string) {
  const map = timeMapOf(p);
  const clips = clipsOf(p);
  const e = p.edit;
  // which stretches of the recording are kept, and where each lands in the finished video
  const kept: { recording: [number, number]; video: [number, number]; speed?: number }[] = [];
  for (const seg of map.segments ?? []) kept.push({ recording: [r2(seg.srcStart), r2(seg.srcEnd)], video: [r2(seg.outStart), r2(seg.outEnd)], ...(seg.speed !== 1 ? { speed: seg.speed } : {}) });
  return {
    name: p.name,
    path,
    recordingSeconds: r2(p.duration),
    videoSeconds: r2(map.outDuration),
    output: e.appearance.output,
    sources: p.sources.map((s) => ({ id: s.id, role: s.role, name: s.name, kind: s.kind, seconds: r2(s.duration) })),
    clips: clips.map((c) => ({ id: c.id, name: c.name, start: r2(c.start), seconds: r2((c as { length?: number }).length ?? 0) })),
    transcript: p.transcript ? (p.transcript.hasSpeech ? `${p.transcript.words.length} words (get_transcript)` : 'no speech') : 'not made yet (run prepare)',
    keptStretches: kept.slice(0, 200),
    decisions: {
      cuts: e.cuts.map((c) => ({ id: c.id, start: r2(c.start), end: r2(c.end), kind: c.kind })),
      zooms: e.zooms.map((z) => ({ id: z.id, start: r2(z.start), end: r2(z.end), scale: z.scale })),
      layouts: e.layouts.map((l) => ({ id: l.id, start: r2(l.start), end: r2(l.end), mode: l.mode })),
      speeds: e.speeds.map((s) => ({ id: s.id, start: r2(s.start), end: r2(s.end), speed: s.speed })),
      text: e.overlays.filter((o) => !o.motion).map((o) => ({ id: o.id, start: r2(o.start), end: r2(o.end), kind: o.kind, text: o.text })),
      animations: e.overlays.filter((o) => o.motion).map((o) => ({ id: o.id, start: r2(o.start), end: r2(o.end), name: o.motion!.name, box: o.motion!.box ?? null })),
      broll: e.broll.map((b) => ({ id: b.id, start: r2(b.start), end: r2(b.end), assetId: b.assetId })),
      audio: musicClipsOf(e, p.sources).map((m) => ({ id: m.id, sourceId: m.sourceId, videoStart: r2(m.start), seconds: r2(m.length), gain: m.gain, duckUnderSpeech: m.duck })),
    },
    captions: e.appearance.captions,
    suggestionsOpen: e.suggestions.filter((s) => s.status === 'open').length,
    note: 'Edit decisions, text and animations use recording seconds; audio, frames and exports use video seconds.',
  };
}

function transcript(params: Params) {
  const { p } = project();
  const t = p.transcript;
  if (!t) throw new Error('There is no transcript yet. Run prepare first (it transcribes on this Mac).');
  if (!t.hasSpeech) return { text: '', sentences: [], note: 'There is no speech in this recording.' };
  const a = num(params.start, 'start', true) ?? 0;
  const b = num(params.end, 'end', true) ?? p.duration;
  const cut = (x: number) => p.edit.cuts.some((c) => x >= c.start && x < c.end);
  const words = t.words.filter((w) => w.start >= a && w.end <= b);
  // grouped into lines at sentence ends and pauses, each with its recording time
  const lines: { start: number; end: number; text: string; cut: boolean }[] = [];
  let cur: typeof lines[number] | null = null;
  for (const w of words) {
    const text = p.edit.wordText?.[w.id] ?? w.text;
    if (!cur || w.start - cur.end > 0.7 || /[.!?]$/.test(cur.text)) {
      if (cur) lines.push(cur);
      cur = { start: r2(w.start), end: r2(w.end), text, cut: cut((w.start + w.end) / 2) };
    } else {
      cur.text += ` ${text}`;
      cur.end = r2(w.end);
    }
  }
  if (cur) lines.push(cur);
  return {
    lines,
    ...(params.words ? { words: words.map((w) => ({ t: r2(w.start), e: r2(w.end), w: w.text, filler: w.kind === 'filler' || undefined })) } : {}),
    note: 'Times are recording seconds. "cut": true = currently cut out of the video.',
  };
}

/** A still of the finished video at a moment, as the preview draws it (PNG data URL). */
async function frame(params: Params) {
  const { p } = project();
  showEditor();
  const map = timeMapOf(p);
  const t = Math.max(0, Math.min(num(params.time, 'time') ?? 0, Math.max(0, map.outDuration - 0.04)));
  const pb = usePlayback.getState();
  pb.setPlaying(false);
  pb.seek(t);
  // let the preview (and any animation frames) catch up
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 120));
    if (document.querySelector('.preview-canvas')) break;
  }
  await new Promise((r) => setTimeout(r, 700));
  const canvas = document.querySelector<HTMLCanvasElement>('.preview-canvas');
  if (!canvas) throw new Error('The preview is not showing.');
  const width = Math.max(160, Math.min(1280, num(params.width, 'width', true) ?? 960));
  const k = document.createElement('canvas');
  k.width = width;
  k.height = Math.round((canvas.height / canvas.width) * width);
  k.getContext('2d')!.drawImage(canvas, 0, 0, k.width, k.height);
  return { image: k.toDataURL('image/png'), time: r2(t), note: `The finished video at ${fmtTime(t, true)}.` };
}

// ───────────────────────────── projects and media ─────────────────────────────

async function createProject(params: Params) {
  const name = str(params.name, 'name').slice(0, 80);
  await saveNow();
  const { path, project: p } = await window.cutaway.library.create(name);
  app().openProject(path, p);
  showEditor();
  return { path, name: p.name };
}

async function openProject(params: Params) {
  const want = str(params.project, 'project');
  const list = await window.cutaway.library.list();
  const hit = list.find((x) => x.path === want) ?? list.find((x) => x.name.toLowerCase() === want.toLowerCase()) ?? list.find((x) => x.name.toLowerCase().includes(want.toLowerCase()));
  if (!hit) throw new Error(`No project matches "${want}". Use list_projects.`);
  await openProjectAt(hit.path);
  showEditor();
  return summary(project().p, hit.path);
}

async function importMedia(params: Params) {
  project();
  const paths = Array.isArray(params.paths) ? params.paths.filter((x): x is string => typeof x === 'string' && x.startsWith('/')) : [];
  if (!paths.length) throw new Error('"paths" needs one or more absolute file paths.');
  const as = typeof params.as === 'string' ? params.as : 'auto';
  const before = new Set(project().p.sources.map((s) => s.id));
  const report = await importFiles(paths, { audioAsMusic: as === 'music', asOverlay: as === 'over' });
  const added = project().p.sources.filter((s) => !before.has(s.id));
  // pictures asked for as clips go on the video row
  if (as === 'clips') {
    const pics = added.filter((s) => s.kind === 'image').map((s) => s.id);
    if (pics.length) photosToClips(pics);
  }
  if (as === 'music') for (const s of added.filter((x) => x.kind === 'audio')) placeMusic(s.id);
  showEditor();
  return { added: added.map((s) => ({ id: s.id, role: s.role, name: s.name, kind: s.kind, seconds: r2(s.duration) })), report: report ? { skipped: (report as { skipped?: unknown }).skipped ?? [] } : null, project: summary(project().p, project().path) };
}

async function prepare() {
  project();
  const r = await runFirstCut(jobContext(new AbortController().signal, false), { prepareOnly: true });
  return { done: r.ran, alreadyUpToDate: r.skipped, transcript: project().p.transcript?.hasSpeech ? `${project().p.transcript!.words.length} words` : 'no speech' };
}

// ───────────────────────────── editing ─────────────────────────────

async function firstCut(params: Params) {
  const { p } = project();
  const brief: Partial<Brief> = {};
  if (params.pacing === 'relaxed' || params.pacing === 'balanced' || params.pacing === 'energetic') brief.pacing = params.pacing;
  if (params.target_seconds !== undefined) brief.targetDuration = Math.max(10, num(params.target_seconds, 'target_seconds')!);
  if (typeof params.notes === 'string') brief.notes = params.notes.slice(0, 2000);
  if (Object.keys(brief).length) app().patch((q) => ({ ...q, brief: { ...q.brief, ...brief } }));
  // The calling AI is already the editor: by default the built-in rules do the mechanical pass (pauses, fillers,
  // retakes, zooms on clicks); `use_ai` hands it to the creator's own Claude Code or Codex instead.
  await startFirstCut(params.use_ai === true, true);
  const job = app().job;
  if (job?.status === 'failed') throw new Error(job.error?.message ?? 'The first cut failed.');
  void p;
  return summary(project().p, project().path);
}

function applyEdits(params: Params) {
  const { p } = project();
  if (!Array.isArray(params.ops) || !params.ops.length) throw new Error('"ops" needs at least one edit operation.');
  const name = label(params.label, 'edits');
  const out = applyProposal(p, params.ops, { label: name });
  if (out.accepted) app().replace(out.project, name);
  showEditor();
  return {
    applied: out.accepted,
    refused: out.rejected.map((r) => ({ op: r.op, why: r.message })),
    adjusted: out.adjusted.map((a) => a.note),
    videoSeconds: r2(TimeMap.fromEdit(project().p.duration, project().p.edit).outDuration),
  };
}

const LANES = ['cuts', 'zooms', 'layouts', 'speeds', 'overlays', 'broll', 'masks'] as const;
function removeItems(params: Params) {
  project();
  const ids = new Set(Array.isArray(params.ids) ? params.ids.filter((x): x is string => typeof x === 'string') : []);
  if (!ids.size) throw new Error('"ids" needs the ids of the decisions to remove (from get_project).');
  let removed = 0;
  app().edit((e, p) => {
    const next = { ...e } as EditState;
    for (const lane of LANES) {
      const list = (e[lane] ?? []) as { id: string }[];
      const kept = list.filter((x) => !ids.has(x.id));
      removed += list.length - kept.length;
      (next as unknown as Record<string, unknown>)[lane] = kept;
    }
    const music = musicClipsOf(e, p.sources);
    const keptMusic = music.filter((m) => !ids.has(m.id));
    removed += music.length - keptMusic.length;
    return keptMusic.length !== music.length ? withMusic(next, keptMusic) : next;
  }, label(params.label, 'remove items'));
  return { removed };
}

function addText(params: Params) {
  const { p } = project();
  const text = str(params.text, 'text').slice(0, 300);
  const template = typeof params.template === 'string' && TEXT_TEMPLATES.some((t) => t.id === params.template) ? params.template : 'plain';
  const start = Math.max(0, Math.min(num(params.start, 'start')!, p.duration - 0.5));
  const end = num(params.end, 'end', true);
  let ids: string[] = [];
  app().edit((e, q) => {
    const made = overlaysFromTemplate(template, start, q.duration, meta('ai', q.revision + 1)).map((o, i) => ({
      ...o,
      ...(i === 0 ? { text, ...(typeof params.subtext === 'string' ? { subtext: params.subtext.slice(0, 200) } : {}) } : {}),
      ...(end !== undefined ? { end: Math.max(o.start + 0.5, Math.min(q.duration, end)) } : {}),
      ...(typeof params.x === 'number' ? { x: Math.max(0.02, Math.min(0.98, params.x)) } : {}),
      ...(typeof params.y === 'number' ? { y: Math.max(0.02, Math.min(0.98, params.y)) } : {}),
    }));
    ids = made.map((o) => o.id);
    return { ...e, overlays: [...e.overlays, ...made].sort((a, b) => a.start - b.start) };
  }, label(params.label, `add text “${text.slice(0, 30)}”`));
  showEditor();
  return { ids };
}

async function addAudioFile(params: Params) {
  project();
  const path = str(params.path, 'path');
  const before = new Set(project().p.sources.map((s) => s.id));
  await importFiles([path], { audioAsMusic: true });
  const s = project().p.sources.find((x) => !before.has(x.id) && x.kind === 'audio');
  if (!s) throw new Error('That file could not be added as audio.');
  const at = num(params.at, 'at', true);
  const gain = num(params.volume, 'volume', true);
  let id = '';
  app().edit((e, p) => {
    const map = timeMapOf(p);
    const start = Math.max(0, Math.min(at ?? 0, Math.max(0, map.outDuration - 0.3)));
    const isMusic = params.kind !== 'voice' && params.kind !== 'sound';
    const clip = { id: `mus_${Date.now().toString(36)}`, sourceId: s.id, start, sourceIn: 0, length: Math.max(0.2, Math.min(s.duration, map.outDuration - start)), gain: gain ?? (isMusic ? 0.35 : 1), fadeIn: isMusic ? 1 : 0, fadeOut: isMusic ? 2 : 0, duck: isMusic && params.duck !== false, ...(isMusic && params.loop ? { loop: true, length: Math.max(0.2, map.outDuration - start) } : {}), meta: meta('ai', p.revision + 1) };
    id = clip.id;
    return withMusic(e, [...musicClipsOf(e, p.sources), clip]);
  }, label(params.label, `add audio ${s.name}`));
  return { id, sourceId: s.id };
}

async function addPhotos(params: Params) {
  project();
  const paths = Array.isArray(params.paths) ? params.paths.filter((x): x is string => typeof x === 'string' && x.startsWith('/')) : [];
  if (!paths.length) throw new Error('"paths" needs one or more absolute image paths.');
  const seconds = num(params.seconds_each, 'seconds_each', true);
  const before = new Set(clipsOf(project().p).map((c) => c.id));
  const beforeSrc = new Set(project().p.sources.map((s) => s.id));
  await importFiles(paths);
  const pics = project().p.sources.filter((s) => !beforeSrc.has(s.id) && s.kind === 'image').map((s) => s.id);
  if (pics.length) photosToClips(pics);
  const made = clipsOf(project().p).filter((c) => !before.has(c.id));
  if (seconds) for (const c of made) setPhotoLength(c.id, Math.max(0.5, Math.min(60, seconds)));
  showEditor();
  return { clips: made.map((c) => c.id), project: summary(project().p, project().path) };
}

async function templates() {
  const own = await ownTemplates();
  return [...MOTION_TEMPLATES, ...own].map((t) => {
    const m = parseMotionMeta(t.html).meta;
    return { id: t.id, name: t.name, description: t.description, seconds: m?.duration, boxed: t.boxed, yours: !!t.own, fields: (m?.fields ?? []).map((f) => ({ id: f.id, label: f.label, type: f.type, default: f.value })) };
  });
}

function animationGuide() {
  const { p } = project();
  const { width, height } = p.edit.appearance.output;
  return {
    contract: motionContract(width, height),
    example: MOTION_TEMPLATES.find((t) => t.id === 'subscribe')!.html,
    boxedExample: MOTION_TEMPLATES.find((t) => t.id === 'circle')!.html,
    note: `Write one HTML page following the contract and pass it to add_animation as "html". Cutaway tests it in its renderer before adding it and tells you what to fix. The JSON block's id must be "${MOTION_META_ID}".`,
  };
}

async function addAnimation(params: Params) {
  const { p } = project();
  const start = Math.max(0, Math.min(num(params.start, 'start')!, Math.max(0, p.duration - 0.5)));
  const fields = (params.fields && typeof params.fields === 'object' ? Object.fromEntries(Object.entries(params.fields as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}) as Record<string, string>;
  let html: string;
  let origin: Parameters<typeof addMotion>[1];
  if (typeof params.template === 'string') {
    const all = [...MOTION_TEMPLATES, ...(await ownTemplates())];
    const t = all.find((x) => x.id === params.template);
    if (!t) throw new Error(`No animation template "${params.template}". Use list_animation_templates.`);
    html = t.html;
    origin = { kind: 'template', template: t.id };
  } else if (typeof params.html === 'string') {
    html = params.html;
    const { meta: m, problems } = parseMotionMeta(html);
    if (!m) throw new Error(`The page cannot be used: ${problems.join(' ')}`);
    // the same test an AI-written animation gets inside Cutaway
    const { width, height } = p.edit.appearance.output;
    const px = motionPixels({ box: m.placement === 'box' ? (m.box ?? DEFAULT_BOX) : undefined }, width, height);
    const check = await window.cutaway.motion.check(html, null, px.width, px.height);
    if (!check.ok) return { added: false, problems: check.errors, note: 'Fix these and call add_animation again with the corrected page.' };
    origin = { kind: 'ai', provider: 'AI tool', prompt: typeof params.description === 'string' ? params.description.slice(0, 300) : 'Written by an AI tool' };
  } else throw new Error('Give a "template" id, or an "html" page (see get_animation_guide).');
  const id = await addMotion(html, origin, fields, start, undefined, false);
  if (params.box && typeof params.box === 'object') {
    const b = params.box as Record<string, unknown>;
    setMotionBox(id, clampBox({ x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) }), 'mcp');
  }
  showEditor();
  const o = project().p.edit.overlays.find((x) => x.id === id);
  return { added: true, id, start: r2(o?.start ?? start), end: r2(o?.end ?? start), box: o?.motion?.box ?? null };
}

async function generate(params: Params) {
  const { path } = project();
  const kind = str(params.kind, 'kind') as GenKind;
  if (!['voice', 'music', 'sound', 'image', 'video'].includes(kind)) throw new Error('"kind" is voice, music, sound, image or video.');
  const status = await window.cutaway.gen.status();
  const want = typeof params.provider === 'string' ? (params.provider as GenProvider) : null;
  const provider: GenProvider | null = want ?? (kind === 'image' || kind === 'video' ? (status.fal.set ? 'fal' : null) : status.elevenlabs.set ? 'elevenlabs' : status.fal.set ? 'fal' : null);
  if (!provider || !status[provider]?.set) throw new Error('No generation key is set. Add an ElevenLabs or fal.ai key in Cutaway › Settings › AI generation (images and video need fal.ai).');
  const jobId = `mcp_${Date.now().toString(36)}`;
  const seconds = num(params.seconds, 'seconds', true);
  const aspect = params.aspect === '9:16' || params.aspect === '1:1' ? params.aspect : '16:9';
  const made = await window.cutaway.gen.generate(path, { jobId, provider, kind, prompt: str(params.prompt, 'prompt'), voiceId: typeof params.voice === 'string' ? params.voice : undefined, seconds: kind === 'voice' || kind === 'image' ? undefined : seconds, instrumental: params.instrumental !== false, aspect });
  const placed = await placeGenerated({ path: made.path, kind, provider, model: made.model, prompt: String(params.prompt), target: params.place === 'clip' ? 'clip' : 'over', at: num(params.at, 'at', true) ?? null, gain: num(params.volume, 'volume', true) });
  showEditor();
  return { file: made.path, model: made.model, ...placed };
}

function setCaptions(params: Params) {
  project();
  app().edit((e) => {
    const c = e.appearance.captions;
    return {
      ...e,
      appearance: {
        ...e.appearance,
        captions: {
          ...c,
          ...(typeof params.burn_in === 'boolean' ? { burnIn: params.burn_in } : {}),
          ...(params.style === 'pill' || params.style === 'plain' || params.style === 'bold' ? { style: params.style } : {}),
          ...(params.position === 'top' || params.position === 'bottom' ? { position: params.position } : {}),
          ...(typeof params.size === 'number' ? { size: Math.max(0.5, Math.min(2, params.size)) } : {}),
        },
      },
    };
  }, label(params.label, 'captions'));
  return { captions: project().p.edit.appearance.captions };
}

function setLook(params: Params) {
  project();
  app().edit((e) => {
    const a = e.appearance;
    let next = { ...a };
    if (typeof params.shape === 'string') {
      const asp = ASPECTS.find((x) => x.id === params.shape || x.ratio === params.shape);
      if (!asp) throw new Error('"shape" is one of 16:9, 9:16, 1:1, 4:3, 4:5.');
      next = { ...next, output: { ...next.output, ...sizeFor(asp, next.output) } };
    }
    if (typeof params.background === 'string' && /^#[0-9a-f]{6}$/i.test(params.background)) next = { ...next, background: { type: 'solid', color: params.background } };
    if (Array.isArray(params.gradient) && params.gradient.length >= 2) next = { ...next, background: { type: 'gradient', colors: params.gradient.map(String).slice(0, 4), angle: 135 } };
    const f = { ...next.frame };
    if (typeof params.padding === 'number') f.padding = Math.max(0, Math.min(0.3, params.padding));
    if (typeof params.corner_radius === 'number') f.radius = Math.max(0, Math.min(0.2, params.corner_radius));
    if (typeof params.shadow === 'number') f.shadow = Math.max(0, Math.min(1, params.shadow));
    return { ...e, appearance: { ...next, frame: f } };
  }, label(params.label, 'look'));
  const a = project().p.edit.appearance;
  return { output: a.output, background: a.background, frame: a.frame };
}

function versions() {
  const { p } = project();
  return historyOf(p)
    .filter((h) => !h.redundant)
    .slice(0, 40)
    .map((h) => ({ revision: h.record.revision, label: h.record.label, by: h.origin, at: h.record.createdAt, changes: h.diff, current: h.current }));
}

function restoreVersion(params: Params) {
  project();
  const revision = num(params.revision, 'revision')!;
  const ok = app().viewVersion({ revision, label: typeof params.label === 'string' ? params.label : undefined });
  if (!ok) throw new Error('No such version. Use list_versions.');
  app().restoreViewed();
  return { restored: revision };
}

async function exportVideo(params: Params) {
  const { p, path } = project();
  await saveNow();
  const format = params.format === 'gif' ? 'gif' : 'mp4';
  const dest = typeof params.folder === 'string' && params.folder.startsWith('/') ? params.folder : (app().settings?.exportDir ?? '');
  let last = '';
  const r = await runFileExport({
    project: p,
    projectPath: path,
    destDir: dest,
    format,
    target: 'file',
    filePath: typeof params.path === 'string' && params.path.startsWith('/') ? params.path : null,
    gif: { fps: 15, short: 480 },
    onProgress: (x) => (last = JSON.stringify(x).slice(0, 80)),
    signal: new AbortController().signal,
  });
  if (r.status !== 'complete') throw new Error(r.error?.message ?? `The export did not finish (${r.status}). ${last}`);
  const file = r.files.find((f) => f.ok);
  return { file: file ? `${r.folder}/${file.name}` : r.folder, bytes: file?.bytes ?? null, seconds: r2(timeMapOf(p).outDuration) };
}

// ───────────────────────────── dispatch ─────────────────────────────

export const HANDLERS: Record<string, (params: Params) => ToolResult | Promise<ToolResult>> = {
  status: () => {
    const a = app();
    return { project: a.project ? { name: a.project.name, path: a.projectPath } : null, view: a.route === 'project' ? a.project?.ui.view : a.route, busy: a.job?.status === 'running' ? a.job.kind : null };
  },
  list_projects: async () => (await window.cutaway.library.list()).map((x) => ({ name: x.name, path: x.path, updated: (x as { updatedAt?: string }).updatedAt })),
  create_project: createProject,
  open_project: openProject,
  get_project: () => summary(project().p, project().path),
  import_media: importMedia,
  prepare,
  get_transcript: transcript,
  get_frame: frame,
  first_cut: firstCut,
  apply_edits: applyEdits,
  remove_items: removeItems,
  add_text: addText,
  add_audio: addAudioFile,
  add_photos: addPhotos,
  list_animation_templates: templates,
  get_animation_guide: animationGuide,
  add_animation: addAnimation,
  generate,
  set_captions: setCaptions,
  set_look: setLook,
  undo: (params) => {
    const n = Math.max(1, Math.min(20, num(params.steps, 'steps', true) ?? 1));
    for (let i = 0; i < n; i++) app().undo();
    return { undone: n };
  },
  redo: () => (app().redo(), { redone: 1 }),
  list_versions: versions,
  restore_version: restoreVersion,
  export_video: exportVideo,
  show: (params) => {
    if (params.view === 'library') app().go('library');
    else showEditor();
    return { shown: true };
  },
};

/** Listen for commands from the main process and answer each one. */
export function startControl(): () => void {
  return window.cutaway.control.onCall(async ({ id, method, params }) => {
    const h = HANDLERS[method];
    if (!h) return window.cutaway.control.respond({ id, ok: false, error: `Unknown tool "${method}".` });
    try {
      const result = await h(params ?? {});
      window.cutaway.control.respond({ id, ok: true, result });
    } catch (e) {
      window.cutaway.control.respond({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
