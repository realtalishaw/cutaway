import type { Chapter, EditState, Seconds, Transcript, Word } from './types';
import type { TimeMap } from './timemap';

export interface Cue {
  index: number;
  start: Seconds;
  end: Seconds;
  text: string;
  wordIds: string[];
}

export interface CaptionOptions {
  maxChars: number;
  maxDuration: Seconds;
  /** A pause this long (in output time) starts a new cue. */
  gapBreak: Seconds;
}

export const CAPTION_DEFAULTS: CaptionOptions = { maxChars: 42, maxDuration: 4.2, gapBreak: 0.7 };

export function displayText(w: Word, edit: Pick<EditState, 'wordText'>): string {
  return edit.wordText[w.id] ?? w.text;
}

/** Words that survive the edit, with their output-time positions. */
export function keptWords(transcript: Transcript | null, map: TimeMap): { word: Word; start: Seconds; end: Seconds }[] {
  if (!transcript) return [];
  const out: { word: Word; start: Seconds; end: Seconds }[] = [];
  for (const w of transcript.words) {
    const mid = (w.start + w.end) / 2;
    if (!map.isKept(mid)) continue;
    const start = map.toOutput(w.start);
    const end = Math.max(start + 0.04, map.toOutput(w.end));
    out.push({ word: w, start, end });
  }
  return out;
}

/**
 * Caption cues in OUTPUT time. Built from the time map, so trims, transcript
 * cuts and speed changes are always reflected; nothing is cached.
 */
export function buildCues(transcript: Transcript | null, edit: Pick<EditState, 'wordText'>, map: TimeMap, opts: CaptionOptions = CAPTION_DEFAULTS): Cue[] {
  const words = keptWords(transcript, map);
  const cues: Cue[] = [];
  let cur: { start: number; end: number; parts: string[]; ids: string[] } | null = null;
  const flush = () => {
    if (cur && cur.parts.length) cues.push({ index: cues.length + 1, start: cur.start, end: cur.end, text: cur.parts.join(' '), wordIds: cur.ids });
    cur = null;
  };
  for (const { word, start, end } of words) {
    const text = displayText(word, edit).trim();
    if (!text) continue;
    if (cur) {
      const chars = cur.parts.join(' ').length + 1 + text.length;
      const sentenceEnd = /[.!?]$/.test(cur.parts[cur.parts.length - 1] ?? '');
      if (chars > opts.maxChars || end - cur.start > opts.maxDuration || start - cur.end > opts.gapBreak || (sentenceEnd && chars > opts.maxChars * 0.55)) flush();
    }
    if (!cur) cur = { start, end, parts: [], ids: [] };
    cur.parts.push(text);
    cur.ids.push(word.id);
    cur.end = Math.max(cur.end, end);
  }
  flush();
  // Readability: hold short cues, never overlap, stay ordered.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const next = cues[i + 1];
    const limit = next ? next.start - 0.02 : map.outDuration;
    if (c.end - c.start < 0.9) c.end = Math.min(limit, c.start + 0.9);
    if (c.end > limit) c.end = Math.max(c.start + 0.05, limit);
  }
  return cues.filter((c) => c.end > c.start);
}

export function srtTime(t: Seconds): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

export function cueAt(cues: Cue[], out: Seconds): Cue | null {
  for (const c of cues) if (out >= c.start && out < c.end) return c;
  return null;
}

// ───────────────────────────── chapters ─────────────────────────────

export interface OutputChapter {
  time: Seconds;
  title: string;
}

export function chapterStamp(t: Seconds): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Chapters in output time. A chapter whose start was cut lands on the next surviving frame. */
export function chaptersToOutput(chapters: Chapter[], map: TimeMap): OutputChapter[] {
  const mapped = chapters
    .map((c) => ({ time: Math.floor(map.toOutput(c.sessionTime)), title: c.title.trim() }))
    .filter((c) => c.title.length > 0)
    .sort((a, b) => a.time - b.time);
  const out: OutputChapter[] = [];
  for (const c of mapped) {
    const last = out[out.length - 1];
    if (last && c.time - last.time < 1) continue; // two chapters collapsed onto one moment by a cut
    out.push(c);
  }
  if (out.length && out[0]!.time <= 3) out[0]!.time = 0;
  return out;
}

export interface ChapterCheck {
  valid: boolean;
  problems: string[];
}

/** YouTube chapter rules: first at 00:00, at least three, ascending, each ≥ 10 s. */
export function checkChapters(chapters: OutputChapter[], outDuration: Seconds): ChapterCheck {
  const problems: string[] = [];
  if (chapters.length < 3) problems.push('YouTube needs at least three chapters.');
  if (chapters.length && chapters[0]!.time !== 0) problems.push('The first chapter must start at 00:00.');
  for (let i = 0; i < chapters.length; i++) {
    const end = i + 1 < chapters.length ? chapters[i + 1]!.time : outDuration;
    if (end - chapters[i]!.time < 10) problems.push(`"${chapters[i]!.title}" is shorter than 10 seconds.`);
    if (i > 0 && chapters[i]!.time <= chapters[i - 1]!.time) problems.push('Chapters must be in ascending order.');
  }
  return { valid: problems.length === 0, problems };
}

export function formatChapters(chapters: OutputChapter[]): string {
  return chapters.map((c) => `${chapterStamp(c.time)} ${c.title}`).join('\n') + (chapters.length ? '\n' : '');
}
