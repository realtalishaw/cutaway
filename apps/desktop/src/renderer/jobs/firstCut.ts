/**
 * First cut: validate → sync → transcribe → visual → assemble → preview.
 *
 * Every stage writes a checkpoint keyed by its inputs, so a retry after a
 * failure resumes instead of repeating finished (or paid) work. Whatever the
 * model proposes goes through core.applyProposal, which validates each
 * operation against real source ranges, locks and creator decisions.
 */
import {
  AiParseError,
  FIRST_CUT_SCHEMA,
  buildFirstCutPrompt,
  parseFirstCut,
  type PromptKeyframe,
} from '@cutaway/ai';
import {
  TimeMap,
  applyProposal,
  flagsOf,
  inWindow,
  isMasterVoice,
  takeOf,
  keepFlaggedMoments,
  markFillers,
  proposeLayouts,
  proposePacing,
  proposeRetakes,
  proposeZooms,
  sourceByRole,
  stageKey,
  toSessionTime,
  zoomLevelOf,
  uid,
  unresolvedGaps,
  withSources,
  type Analysis,
  type EditOp,
  type JobStage,
  type MediaSource,
  type Project,
  type Range,
  type RejectedOp,
  type Transcript,
  type Word,
} from '@cutaway/core';
import { JobError, type AiUse, type JobContext } from './types';
import { Stager, askClaude, checkAbort, claudeGate, clusterClicks, errorCode, errorText, extractStills, filePath, fmt, promptAssets, promptSentences, promptSources, screenActivity, spread, type FrameWant } from './shared';
import { resolveSourcePath } from '../../shared/api';

export const FIRST_CUT_LABEL = 'AI first cut';
const STAGES: JobStage[] = ['validate', 'sync', 'transcribe', 'visual', 'assemble', 'preview'];
const ALL_LANES = ['cuts', 'speeds', 'layouts', 'zooms', 'overlays', 'broll'] as const;
const TIMELINE_ROLES: MediaSource['role'][] = ['screen', 'cameraA', 'cameraB', 'voice'];

export interface FirstCutResult {
  mode: 'claude' | 'local-rules';
  ai: AiUse;
  summary: string;
  /** Operations that passed validation and were applied. */
  accepted: number;
  rejected: RejectedOp[];
  adjusted: { op: EditOp; note: string }[];
  /** Things the creator should double-check. */
  notes: string[];
  ran: JobStage[];
  skipped: JobStage[];
}

export interface FirstCutOptions {
  /** Re-run assembly even when a first cut for the same inputs already exists. */
  regenerate?: boolean;
  /** Stop after transcription and analysis, changing nothing in the edit (an AI tool reads the result and edits itself). */
  prepareOnly?: boolean;
}

function mark(ctx: JobContext, stage: JobStage): void {
  ctx.update((p) => ({ ...p, stages: { ...p.stages, [stage]: { doneAt: new Date().toISOString(), inputKey: stageKey(p, stage) } } }));
}

function isCurrent(p: Project, stage: JobStage): boolean {
  return p.stages[stage]?.inputKey === stageKey(p, stage);
}

export async function runFirstCut(ctx: JobContext, opts: FirstCutOptions = {}): Promise<FirstCutResult> {
  const st = new Stager(ctx, STAGES, { assemble: ctx.useClaude });
  const ran: JobStage[] = [];
  const skipped: JobStage[] = [];
  const api = window.cutaway;

  const run = async (id: JobStage, startDetail: string, fn: () => Promise<string>): Promise<void> => {
    checkAbort(ctx, id);
    st.start(id, startDetail);
    try {
      const detail = await fn();
      checkAbort(ctx, id);
      st.done(id, detail);
      ran.push(id);
    } catch (e) {
      const je = e instanceof JobError ? e : new JobError(id, ctx.signal.aborted ? 'cancelled' : 'failed', errorText(e), true);
      st.fail(id, je.message);
      throw je;
    }
  };
  const skip = (id: JobStage, detail: string) => {
    st.skip(id, detail);
    skipped.push(id);
  };

  // ── validate ────────────────────────────────────────────────────────────
  await run('validate', 'Checking that every file is readable…', async () => {
    const p = ctx.get();
    const timeline = p.sources.filter((s) => TIMELINE_ROLES.includes(s.role));
    if (!timeline.some((s) => s.kind === 'video')) throw new JobError('validate', 'no-sources', 'Add a screen recording or a camera video before creating a first cut.', false);
    let note = '';
    try {
      const probes = await api.native.probe(p.sources.map((s) => filePath(ctx, s)));
      const ok = new Map(p.sources.map((s, i) => [s.id, probes[i]?.ok ?? s.available]));
      if (p.sources.some((s) => s.available !== ok.get(s.id))) ctx.update((q) => withSources(q, q.sources.map((s) => (ok.has(s.id) ? { ...s, available: ok.get(s.id)! } : s))));
    } catch (e) {
      note = ` Files could not be re-checked (${errorText(e)}).`;
    }
    const now = ctx.get();
    const missing = now.sources.filter((s) => TIMELINE_ROLES.includes(s.role) && !s.available);
    if (missing.length) throw new JobError('validate', 'missing-source', `${missing.map((s) => `"${s.name}"`).join(', ')} cannot be found. Relink ${missing.length === 1 ? 'it' : 'them'} and try again.`, true);
    const offline = now.sources.filter((s) => !TIMELINE_ROLES.includes(s.role) && !s.available).length;
    return `${now.sources.length} file${now.sources.length === 1 ? '' : 's'} ready.${offline ? ` ${offline} supporting asset${offline === 1 ? ' is' : 's are'} offline and will not be used.` : ''}${note}`;
  });

  // ── sync ────────────────────────────────────────────────────────────────
  if (isCurrent(ctx.get(), 'sync')) skip('sync', 'Alignment unchanged since the last run.');
  else
    await run('sync', 'Checking how the sources line up…', async () => {
      const p = ctx.get();
      // Each footage group lines up against its own voice.
      const masterOf = (s: MediaSource) => p.sources.find((x) => !x.instanceOf && isMasterVoice(p.edit.audio, x) && takeOf(x) === takeOf(s));
      const notes: string[] = [];
      let sources = p.sources;
      for (const s of p.sources) {
        const master = masterOf(s);
        if (!TIMELINE_ROLES.includes(s.role) || s.instanceOf || s.id === master?.id) continue;
        if (s.sync.status !== 'needs-review' || s.sync.method === 'manual' || s.sync.confirmedByCreator) continue;
        if (!master || !s.hasAudio) {
          notes.push(`"${s.name}" has no shared audio to align with; align it by hand in Sources.`);
          continue;
        }
        checkAbort(ctx, 'sync');
        try {
          const r = await api.native.correlate(filePath(ctx, master), filePath(ctx, s), 600);
          if (r.reliable) {
            const offset = toSessionTime(master.sync, r.offset);
            const rate = r.rate * master.sync.rate;
            // the offset is measured against the voice where it sits on the timeline now
            sources = sources.map((x) => (x.id === s.id ? { ...x, ...(master.shift !== undefined ? { shift: master.shift } : {}), sync: { ...x.sync, offset, rate, method: 'audio-correlation' as const, confidence: r.confidence, status: 'aligned' as const, checkpoints: r.checkpoints, confirmedByCreator: false } } : x));
            notes.push(`"${s.name}" aligned from shared audio (confidence ${Math.round(r.confidence * 100)}%).`);
          } else notes.push(`"${s.name}" could not be aligned automatically; align it by hand in Sources.`);
        } catch (e) {
          notes.push(`"${s.name}" could not be compared (${errorText(e)}).`);
        }
      }
      if (sources !== p.sources) ctx.update((q) => withSources(q, sources));
      const unsynced = ctx.get().sources.filter((s) => TIMELINE_ROLES.includes(s.role) && s.sync.status === 'unsynced');
      for (const s of unsynced) notes.push(`"${s.name}" is not aligned and will not appear in the cut.`);
      mark(ctx, 'sync');
      return notes.length ? notes.join(' ') : 'Sources are aligned.';
    });

  // ── transcribe ──────────────────────────────────────────────────────────
  if (isCurrent(ctx.get(), 'transcribe') && ctx.get().transcript) skip('transcribe', 'Transcript is up to date.');
  else
    await run('transcribe', 'Transcribing speech on this Mac. Audio is not sent anywhere.', async () => {
      const p = ctx.get();
      // One voice per footage group (a project that is one clip has exactly one, as before).
      const voices = p.sources.filter((s) => isMasterVoice(p.edit.audio, s) && s.hasAudio && s.available);
      const master = voices[0];
      const locale = ctx.settings.transcription.locale || 'en-US';
      const empty = (engine: string): Transcript => ({ engine, locale, onDevice: true, sourceId: master?.id ?? '', hasSpeech: false, words: [], generatedAt: new Date().toISOString() });
      let transcript: Transcript;
      let detail: string;
      if (!master) {
        transcript = empty('none');
        detail = 'This project has no voice track, so there is nothing to transcribe.';
      } else {
        const heard = new Map<string, Awaited<ReturnType<typeof api.native.transcribe>> | null>();
        const words: Word[] = [];
        let first: Awaited<ReturnType<typeof api.native.transcribe>> | null = null;
        let silentFiles = 0;
        for (const voice of voices) {
          checkAbort(ctx, 'transcribe');
          const file = filePath(ctx, voice);
          if (!heard.has(file)) {
            try {
              heard.set(file, await api.native.transcribe(file, locale));
            } catch (e) {
              const code = errorCode(e);
              if (code === 'no-audio') heard.set(file, null);
              else if (code === 'speech-permission-denied') throw new JobError('transcribe', 'permission', 'Speech recognition is not allowed for Cutaway. Allow it in System Settings › Privacy & Security › Speech Recognition, then retry.', true);
              else throw new JobError('transcribe', 'native-failed', `Transcription failed: ${errorText(e)}`, true);
            }
          }
          const res = heard.get(file);
          if (!res) {
            silentFiles += 1;
            continue;
          }
          first ??= res;
          if (!res.hasSpeech) continue;
          for (const w of res.words) {
            if (!w.text.trim() || !Number.isFinite(w.start) || !Number.isFinite(w.end) || !(w.end > w.start)) continue;
            const start = toSessionTime(voice.sync, w.start);
            const end = toSessionTime(voice.sync, w.end);
            // a voice placed for one clip only speaks inside it
            if (voice.window ? !inWindow(voice, start) : !(end > 0 && start < p.duration)) continue;
            words.push({ id: uid('w'), text: w.text.trim(), start, end, confidence: w.confidence, kind: 'word' as const });
          }
        }
        words.sort((x, y) => x.start - y.start);
        if (!first) {
          transcript = empty('none');
          detail = 'The voice track has no audio, so there is nothing to transcribe.';
        } else {
          const marked = words.length ? markFillers(words) : [];
          const shown = marked.filter((w) => w.start < p.duration);
          const parked = marked.filter((w) => w.start >= p.duration);
          const hasSpeech = shown.length > 0;
          transcript = { engine: first.engine, locale: first.locale || locale, onDevice: first.onDevice, sourceId: master.id, hasSpeech, words: shown, ...(parked.length ? { parked } : {}), generatedAt: new Date().toISOString() };
          detail = hasSpeech ? `${shown.length} words transcribed on this Mac (${first.engine}).` : 'No speech was found, so no transcript was written.';
          if (voices.length > 1 && silentFiles) detail += ` ${silentFiles} clip${silentFiles === 1 ? ' has' : 's have'} no sound.`;
        }
      }
      ctx.update((q) => ({ ...q, transcript }));
      mark(ctx, 'transcribe');
      return detail;
    });

  // ── visual ──────────────────────────────────────────────────────────────
  if (isCurrent(ctx.get(), 'visual') && ctx.get().analysis) skip('visual', 'Screen activity is up to date.');
  else
    await run('visual', 'Finding where things happen on screen…', async () => {
      const p = ctx.get();
      // Every clip's screen and voice, each written into its own stretch of the session timeline.
      // photo clips have nothing to watch: only screen recordings are analysed
      const screens = p.sources.filter((s) => s.role === 'screen' && s.available && s.kind === 'video');
      const screen = screens[0];
      const voices = p.sources.filter((s) => isMasterVoice(p.edit.audio, s) && s.hasAudio && s.available);
      // footage that is off the timeline sits after the end of the video and is analysed too, so it is ready when put back
      const total = Math.max(p.duration, ...p.sources.map((s) => s.window?.end ?? 0));
      let activity: number[] = [];
      let activityHz = 4;
      let clicks: Analysis['clicks'] = [];
      const parts: string[] = [];
      if (screen) {
        const seen = new Map<string, Awaited<ReturnType<typeof api.native.activity>>>();
        for (const sc of screens) {
          const file = filePath(ctx, sc);
          try {
            if (!seen.has(file)) seen.set(file, await api.native.activity(file));
            const res = seen.get(file)!;
            if (activity.length === 0) {
              activityHz = res.fps > 0 ? res.fps : 4;
              activity = new Array<number>(Math.ceil(total * activityHz) + 1).fill(0);
            }
            for (const s of res.samples) {
              const t = toSessionTime(sc.sync, s.t);
              if (!inWindow(sc, t)) continue;
              const i = Math.round(t * activityHz);
              if (i >= 0 && i < activity.length) activity[i] = Math.max(activity[i]!, s.change);
            }
          } catch (e) {
            throw new JobError('visual', 'native-failed', `The screen recording could not be analysed: ${errorText(e)}`, true);
          }
          checkAbort(ctx, 'visual');
          if (sc.cursorFile && !sc.cursorBaked) {
            try {
              const samples = await api.native.readCursor(resolveSourcePath(ctx.projectPath, sc.cursorFile));
              clicks.push(...samples.filter((s) => s.e === 'down').map((s) => ({ t: s.t + sc.sync.offset, x: s.x, y: s.y })).filter((c) => c.t >= 0 && c.t <= total && inWindow(sc, c.t)));
            } catch {
              parts.push('cursor data could not be read');
            }
          }
        }
        clicks.sort((x, y) => x.t - y.t);
        if (screens.some((sc) => sc.cursorFile && !sc.cursorBaked)) parts.push(`${clicks.length} click${clicks.length === 1 ? '' : 's'} from the recorded cursor`);
        else parts.push('imported video: the cursor is part of the picture, so clicks are unknown');
      } else parts.push('no screen source');
      checkAbort(ctx, 'visual');
      let silences: Range[] = [];
      let waveform: number[] = [];
      let waveformHz = 20;
      let voiceLevelDb: number | null = null;
      const measured = new Map<string, Awaited<ReturnType<typeof api.native.analyzeVoice>>>();
      for (const voice of voices) {
        const file = filePath(ctx, voice);
        try {
          if (!measured.has(file)) measured.set(file, await api.native.analyzeVoice(file));
          const v = measured.get(file)!;
          silences.push(...v.silences.map((r) => ({ start: toSessionTime(voice.sync, r.start), end: toSessionTime(voice.sync, r.end) })).filter((r) => r.end > 0 && (!voice.window || (r.end > voice.window.start && r.start < voice.window.end))).map((r) => (voice.window ? { start: Math.max(r.start, voice.window.start), end: Math.min(r.end, voice.window.end) } : r)));
          voiceLevelDb ??= v.levelDb ?? null;
          if (!voice.window && voices.length === 1) {
            waveformHz = v.waveformHz || 20;
            const pad = Math.round(voice.sync.offset * waveformHz);
            waveform = pad >= 0 ? [...new Array<number>(pad).fill(0), ...v.waveform] : v.waveform.slice(-pad);
          } else {
            if (waveform.length === 0) {
              waveformHz = v.waveformHz || 20;
              waveform = new Array<number>(Math.ceil(total * waveformHz) + 1).fill(0);
            }
            const hz = v.waveformHz || 20;
            v.waveform.forEach((level, k) => {
              const t = toSessionTime(voice.sync, k / hz);
              if (!inWindow(voice, t)) return;
              const i = Math.round(t * waveformHz);
              if (i >= 0 && i < waveform.length) waveform[i] = level;
            });
          }
        } catch {
          parts.push('voice level could not be measured');
        }
      }
      silences.sort((x, y) => x.start - y.start);
      // what belongs to footage that is off the timeline is kept aside
      const parked = { silences: silences.filter((r) => r.start >= p.duration && !!p.edit.clips), clicks: clicks.filter((c) => c.t >= p.duration && !!p.edit.clips) };
      if (p.edit.clips) {
        silences = silences.filter((r) => r.start < p.duration);
        clicks = clicks.filter((c) => c.t < p.duration);
      }
      const analysis: Analysis = { silences, activity, activityHz, clicks, waveform, waveformHz, voiceLevelDb, ...(parked.silences.length || parked.clicks.length ? { parked } : {}), computedAt: new Date().toISOString() };
      ctx.update((q) => ({ ...q, analysis }));
      mark(ctx, 'visual');
      const active = screenActivity(ctx.get()).reduce((s, r) => s + (r.end - r.start), 0);
      return `${screen ? `${fmt(active)} of visible screen activity; ` : ''}${parts.join('; ')}.`;
    });

  if (opts.prepareOnly) return { mode: 'local-rules', ai: { mode: 'local-rules', reason: null, fellBack: false }, summary: 'Transcribed and analysed. The edit was not changed.', accepted: 0, rejected: [], adjusted: [], notes: [], ran, skipped };

  // ── assemble ────────────────────────────────────────────────────────────
  let result: Omit<FirstCutResult, 'ran' | 'skipped'> | null = null;
  const existing = ctx.get().firstCut;
  if (!opts.regenerate && existing && isCurrent(ctx.get(), 'assemble')) {
    skip('assemble', 'A first cut already exists for this footage and brief.');
    result = { mode: existing.mode, ai: { mode: existing.mode, reason: null, fellBack: false }, summary: existing.summary, accepted: 0, rejected: [], adjusted: [], notes: [] };
  } else
    await run('assemble', 'Applying the built-in editing rules…', async () => {
      result = await assemble(ctx, st);
      mark(ctx, 'assemble');
      return result.summary;
    });

  // ── preview ─────────────────────────────────────────────────────────────
  await run('preview', 'Checking the cut plays from start to finish…', async () => {
    const p = ctx.get();
    const map = TimeMap.fromEdit(p.duration, p.edit);
    if (map.outDuration < 0.5) throw new JobError('preview', 'failed', 'The assembled cut is empty. Restore some footage or relax the brief, then try again.', true);
    const gaps = unresolvedGaps(p, map);
    ctx.update((q) => ({ ...q, ui: { ...q.ui, view: 'edit', playhead: map.toSource(0) } }));
    mark(ctx, 'preview');
    const gapNote = gaps.length ? ` ${gaps.length} moment${gaps.length === 1 ? '' : 's'} ask for a source that has no footage there.` : '';
    return `Playable cut: ${fmt(map.outDuration)} from ${fmt(p.duration)} of footage.${gapNote}`;
  });

  return { ...result!, ran, skipped };
}

// ───────────────────────────── assembly ─────────────────────────────

function keyframeWants(p: Project): FrameWant[] {
  const a = p.analysis;
  const words = p.transcript?.words ?? [];
  const hasScreen = !!sourceByRole(p, 'screen');
  const spacing = Math.max(3, p.duration / 30);
  const wants: FrameWant[] = [];
  const sentenceStarts = promptSentences(p).map((s) => ({ t: Math.min(p.duration, s.start + 0.6), priority: 1 }));
  if (hasScreen) {
    const cands: { t: number; priority: number }[] = [];
    for (const c of clusterClicks(a?.clicks ?? [])) cands.push({ t: Math.min(p.duration, c.start + 0.4), priority: 3 + Math.min(1, c.count / 10) });
    if (a && a.activity.length) {
      const hz = a.activityHz || 4;
      for (let i = 1; i < a.activity.length - 1; i++) {
        const v = a.activity[i]!;
        if (v > 0.02 && v >= a.activity[i - 1]! && v >= a.activity[i + 1]!) cands.push({ t: Math.min(p.duration, i / hz + 0.5), priority: 2 + Math.min(0.9, v * 5) });
      }
    }
    // Moments the creator flagged while recording are looked at first.
    for (const f of flagsOf(p)) cands.push({ t: Math.min(p.duration, f.t), priority: 5 });
    cands.push(...sentenceStarts, { t: Math.min(1, p.duration / 2), priority: 1.5 }, { t: Math.max(0, p.duration - 1), priority: 1.2 });
    for (const t of spread(cands, 18, spacing)) wants.push({ sessionTime: t, role: 'screen' });
  }
  const camCands = words.length ? sentenceStarts : [0.1, 0.35, 0.6, 0.85].map((f) => ({ t: p.duration * f, priority: 1 }));
  for (const t of spread(camCands, hasScreen ? 4 : 14, Math.max(spacing, p.duration / 8))) wants.push({ sessionTime: t, role: 'cameraA' });
  for (const t of spread(camCands, hasScreen ? 2 : 6, Math.max(spacing, p.duration / 4))) wants.push({ sessionTime: Math.min(p.duration, t + 0.2), role: 'cameraB' });
  return wants.slice(0, 24);
}

function countAi(p: Project): { pauses: number; fillers: number; otherCuts: number; removed: number; views: number; zooms: number; graphics: number; broll: number; speeds: number; open: number } {
  const rev = p.revision;
  const mine = <T extends { meta: { origin: string; revision: number } }>(xs: T[]) => xs.filter((x) => x.meta.origin === 'ai' && x.meta.revision === rev);
  const cuts = mine(p.edit.cuts);
  return {
    pauses: cuts.filter((c) => c.kind === 'silence' || c.kind === 'trim').length,
    fillers: cuts.filter((c) => c.kind === 'filler').length,
    otherCuts: cuts.filter((c) => !['silence', 'trim', 'filler'].includes(c.kind)).length,
    removed: cuts.reduce((s, c) => s + (c.end - c.start), 0),
    views: mine(p.edit.layouts).length,
    zooms: mine(p.edit.zooms).length,
    graphics: mine(p.edit.overlays).length,
    broll: mine(p.edit.broll).length,
    speeds: mine(p.edit.speeds).length,
    open: p.edit.suggestions.filter((s) => s.status === 'open').length,
  };
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

async function assemble(ctx: JobContext, st: Stager): Promise<Omit<FirstCutResult, 'ran' | 'skipped'>> {
  const p = ctx.get();
  const a = p.analysis;
  const words = p.transcript?.words ?? [];
  const hasSpeech = !!p.transcript?.hasSpeech && words.length > 0;
  const screen = sourceByRole(p, 'screen');
  const activityInput = { activity: a?.activity ?? [], activityHz: a?.activityHz || 4, clicks: a?.clicks ?? [] };

  // Built-in rules. Without speech they need real screen-activity data: a
  // silent camera-only take has nothing safe to cut on.
  const canPace = hasSpeech || (!!screen && activityInput.activity.length > 0);
  const flagTimes = flagsOf(p).map((f) => f.t);
  // A moment the creator flagged while recording is never trimmed away by the automatic cleanup.
  const guarded = keepFlaggedMoments([...(canPace ? proposePacing({ ...activityInput, duration: p.duration, words, hasSpeech, brief: p.brief, silences: p.analysis?.voiceLevelDb != null ? p.analysis.silences : undefined }) : []), ...(hasSpeech ? proposeRetakes(words) : [])], flagTimes);
  const pacing: EditOp[] = guarded.ops;
  const retakes: EditOp[] = [];
  const zooms: EditOp[] = screen ? proposeZooms(activityInput.clicks, p.duration, p.brief.visualIntensity, zoomLevelOf(p.edit.appearance)) : [];
  const layouts: EditOp[] = proposeLayouts({ ...activityInput, duration: p.duration, words, sources: p.sources, brief: p.brief });

  const gate = await claudeGate(ctx);
  st.patch('assemble', { remote: gate.usable });
  let ai: AiUse = { mode: 'local-rules', reason: gate.reason, fellBack: gate.fellBack };
  let claudeOps: unknown[] | null = null;
  let claudeSummary = '';
  let notes: string[] = [];
  let chapters: { sessionTime: number; title: string }[] = [];

  if (gate.usable) {
    checkAbort(ctx, 'assemble');
    st.detail('assemble', `Picking still frames for ${gate.name} to look at…`);
    const { stills, imageDir } = await extractStills(ctx, p, keyframeWants(p));
    checkAbort(ctx, 'assemble');
    const keyframes: PromptKeyframe[] = stills.map((s) => ({ file: s.file, sessionTime: s.sessionTime, source: s.source }));
    const prompt = buildFirstCutPrompt({
      projectName: p.name,
      playbookNotes: ctx.settings.playbookNotes,
      duration: p.duration,
      brief: p.brief,
      zoomLevel: zoomLevelOf(p.edit.appearance),
      sources: promptSources(p),
      hasSpeech,
      sentences: hasSpeech ? promptSentences(p) : [],
      localOps: [...pacing, ...retakes],
      hints: [...zooms, ...layouts],
      activeRanges: screenActivity(p),
      clickClusters: clusterClicks(activityInput.clicks),
      assets: p.brief.allowBroll ? promptAssets(p) : [],
      locks: p.edit.locks.map((l) => ({ start: l.start, end: l.end, note: l.note })),
      keeps: p.edit.keeps,
      flags: flagTimes,
      keyframes,
    });
    st.detail('assemble', `${gate.name} is reviewing the transcript${keyframes.length ? ` and ${n(keyframes.length, 'still frame')}` : ''}. Video and audio stay on this Mac.`);
    const res = await askClaude(ctx, { purpose: 'first-cut', prompt, schema: FIRST_CUT_SCHEMA as unknown as Record<string, unknown>, imagePaths: stills.map((s) => s.path), imageDir });
    if (!res.ok && (res.error?.code === 'cancelled' || ctx.signal.aborted)) throw new JobError('assemble', 'cancelled', 'Cancelled. Finished stages are kept.', true);
    if (res.ok) {
      try {
        const reply = parseFirstCut(res.data);
        claudeOps = reply.ops;
        claudeSummary = reply.summary;
        notes = reply.notes;
        chapters = reply.chapters.filter((c) => c.sessionTime <= p.duration);
        ai = { mode: 'claude', provider: res.provider ?? gate.provider, reason: null, fellBack: false };
      } catch (e) {
        ai = { mode: 'local-rules', reason: e instanceof AiParseError ? `${gate.name}'s reply could not be used (${e.message})` : errorText(e), fellBack: true };
      }
    } else ai = { mode: 'local-rules', reason: res.error?.message ?? `${gate.app} failed.`, fellBack: true };
  }

  checkAbort(ctx, 'assemble');
  // The model is told to leave flagged moments alone; this makes sure of it.
  const claudeSafe = (claudeOps ?? []).flatMap((o) => (o && typeof o === 'object' && (o as EditOp).op === 'cut' ? keepFlaggedMoments([o as EditOp], flagTimes).ops : [o]));
  const ops: unknown[] = ai.mode === 'claude' ? [...pacing, ...retakes, ...claudeSafe] : [...pacing, ...retakes, ...zooms, ...layouts];
  // No await between reading and writing the project: the proposal is applied to the latest state.
  const q = ctx.get();
  const outcome = applyProposal(q, ops, { label: FIRST_CUT_LABEL, replaceAi: [...ALL_LANES] });
  let summary = '';
  {
    const next = outcome.project;
    const c = countAi(next);
    const map = TimeMap.fromEdit(next.duration, next.edit);
    const parts: string[] = [];
    const removedBits = [c.pauses ? n(c.pauses, 'pause') : '', c.fillers ? n(c.fillers, 'filler word') : '', c.otherCuts ? n(c.otherCuts, 'other trim') : ''].filter(Boolean);
    parts.push(removedBits.length ? `Removed ${removedBits.join(', ')} (${fmt(c.removed)}).` : 'No footage was removed.');
    const hasAssets = q.sources.some((s) => (s.role === 'broll' || s.role === 'image') && s.available);
    const brollText = c.broll ? n(c.broll, 'B-roll insert') : hasAssets ? 'no B-roll (no supplied asset fit)' : 'no B-roll (none supplied)';
    parts.push(`Chose ${n(c.views, 'view change')}, ${n(c.zooms, 'zoom')}, ${n(c.graphics, 'graphic')}${c.speeds ? `, ${n(c.speeds, 'speed change')}` : ''} and ${brollText}.`);
    if (c.open) parts.push(`${n(c.open, 'uncertain choice')} ${c.open === 1 ? 'is' : 'are'} waiting for your review; nothing was removed for ${c.open === 1 ? 'it' : 'them'}.`);
    if (flagTimes.length) parts.push(`${n(flagTimes.length, 'flagged moment')} from the recording ${flagTimes.length === 1 ? 'was' : 'were'} kept${guarded.protectedCount ? ` (${n(guarded.protectedCount, 'automatic trim')} held back for ${guarded.protectedCount === 1 ? 'it' : 'them'})` : ''}.`);
    if (!hasSpeech) parts.push('No speech was found, so the cut follows what happens on screen and there are no captions.');
    if (typeof q.brief.targetDuration === 'number' && map.outDuration > q.brief.targetDuration * 1.15) parts.push(`The cut runs ${fmt(map.outDuration)}; the ${fmt(q.brief.targetDuration)} target could not be reached without removing speech.`);
    if (ai.mode === 'claude') {
      if (claudeSummary) parts.push(`${gate.name}: ${claudeSummary}`);
    } else if (ai.fellBack) parts.push(`${gate.name} was not used: ${ai.reason} This cut was assembled by Cutaway's built-in rules on this Mac.`);
    else parts.push(`${ai.reason ?? ''} This cut was assembled by Cutaway's built-in rules on this Mac.`.trim());
    if (outcome.rejected.length) parts.push(`${n(outcome.rejected.length, 'proposed change')} did not pass Cutaway's checks and ${outcome.rejected.length === 1 ? 'was' : 'were'} left out.`);
    summary = parts.join(' ');
    const packaging = chapters.length >= 3 && next.packaging.chapters.length === 0 ? { ...next.packaging, chapters } : next.packaging;
    const built: Project = { ...next, packaging, firstCut: { at: new Date().toISOString(), mode: ai.mode, ...(ai.provider ? { provider: ai.provider } : {}), summary } };
    ctx.update(() => built);
  }
  return { mode: ai.mode, ai, summary, accepted: outcome.accepted, rejected: outcome.rejected, adjusted: outcome.adjusted, notes };
}
