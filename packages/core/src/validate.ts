import type { CameraSlot, Confidence, EditOp, LayoutMode, Project, Range, RejectedOp, ValidationResult, Word } from './types';
import { clamp, intersectAll, subtractAll } from './ranges';
import { cameraSource, coverage, sourceByRole } from './sync';

const CUT_KINDS = ['trim', 'silence', 'filler', 'retake', 'transcript', 'manual', 'pacing'] as const;
const LAYOUTS: LayoutMode[] = ['screen', 'camera', 'overlay', 'split', 'presenter'];
const OVERLAYS = ['callout', 'section-card', 'lower-third'] as const;
const SUGGESTIONS = ['retake', 'reorder', 'hook', 'cut', 'broll', 'note'] as const;
const CONF: Confidence[] = ['high', 'medium', 'low'];

export const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);

/** Words whose removal can flip or distort what was said. */
const MEANING_WORDS = /^(no|not|never|none|nothing|don't|dont|doesn't|doesnt|didn't|didnt|won't|wont|can't|cant|cannot|shouldn't|shouldnt|isn't|isnt|aren't|arent|wasn't|wasnt|without|unless|except|only|always|must|every|all|half|double|twice)$/i;

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9']/g, '');
}

export function isFillerWord(text: string): boolean {
  return FILLERS.has(normalizeWord(text));
}

function carriesMeaning(w: Word): boolean {
  const n = normalizeWord(w.text);
  return MEANING_WORDS.test(n) || /\d/.test(n);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v: unknown, max = 400): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

export interface ValidateOptions {
  origin: 'ai' | 'creator';
  /** Local regeneration: operations are confined to this range. */
  scope?: Range;
}

type P = Pick<Project, 'duration' | 'sources' | 'edit' | 'transcript' | 'name'>;

/**
 * Gatekeeper between a proposal and a project. Input is untrusted JSON: only
 * the known operation shapes pass, clipped to real source ranges, locks,
 * creator "keeps" and camera coverage. Nothing here can touch files, settings
 * or anything outside the edit model.
 */
export function validateOps(project: P, raw: unknown, opts: ValidateOptions): ValidationResult {
  const result: ValidationResult = { accepted: [], rejected: [], adjusted: [] };
  if (!Array.isArray(raw)) {
    result.rejected.push({ op: raw, code: 'bad-shape', message: 'Proposal is not a list of operations.' });
    return result;
  }
  for (const item of raw.slice(0, 2000)) {
    for (const outcome of validateOne(project, item, opts)) {
      if ('code' in outcome) result.rejected.push(outcome);
      else {
        result.accepted.push(outcome.op);
        if (outcome.note) result.adjusted.push({ op: outcome.op, note: outcome.note });
      }
    }
  }
  return result;
}

type Outcome = RejectedOp | { op: EditOp; note?: string };

function reject(op: unknown, code: RejectedOp['code'], message: string): RejectedOp[] {
  return [{ op, code, message }];
}

function validateOne(project: P, item: unknown, opts: ValidateOptions): Outcome[] {
  if (!item || typeof item !== 'object') return reject(item, 'bad-shape', 'Operation is not an object.');
  const o = item as Record<string, unknown>;
  const kind = o.op;
  if (typeof kind !== 'string' || !['cut', 'speed', 'layout', 'zoom', 'overlay', 'broll', 'suggest'].includes(kind)) {
    return reject(item, 'unknown-op', `"${String(kind)}" is not an allowed edit operation.`);
  }
  if (!num(o.start) || !num(o.end)) return reject(item, 'bad-shape', 'start and end must be numbers.');
  let range: Range = { start: clamp(o.start, 0, project.duration), end: clamp(o.end, 0, project.duration) };
  if (range.end - range.start <= 0) return reject(item, 'out-of-range', 'Range is empty or outside the recording.');
  if (opts.scope) {
    const s = { start: Math.max(range.start, opts.scope.start), end: Math.min(range.end, opts.scope.end) };
    if (s.end - s.start <= 0.01) return reject(item, 'out-of-range', 'Operation is outside the section being revised.');
    range = s;
  }
  const reason = str(o.reason);
  const confidence = CONF.includes(o.confidence as Confidence) ? (o.confidence as Confidence) : undefined;
  const ai = opts.origin === 'ai';
  const locks = project.edit.locks;
  /** AI operations are carved around locked ranges. */
  const free = (r: Range, min: number): Range[] => (ai ? subtractAll([r], locks) : [r]).filter((p) => p.end - p.start >= min);
  const lockedNote = (pieces: Range[], r: Range) => (pieces.length !== 1 || pieces[0]!.start !== r.start || pieces[0]!.end !== r.end ? 'Clipped around a locked range.' : undefined);

  switch (kind) {
    case 'cut': {
      const cutKind = CUT_KINDS.includes(o.kind as (typeof CUT_KINDS)[number]) ? (o.kind as (typeof CUT_KINDS)[number]) : 'pacing';
      let pieces = free(range, 0.06);
      if (pieces.length === 0) return reject(item, 'locked', 'The range is locked by the creator.');
      if (ai) {
        const beforeKeeps = pieces;
        pieces = subtractAll(pieces, project.edit.keeps).filter((p) => p.end - p.start >= 0.06);
        if (pieces.length === 0 && beforeKeeps.length > 0) return reject(item, 'kept-by-creator', 'The creator restored or kept this passage.');
      }
      const words = project.transcript?.words ?? [];
      const out: Outcome[] = [];
      for (const piece of pieces) {
        // Never cut through the middle of a spoken word.
        const snapped = snapToWords(piece, words);
        if (!snapped) continue;
        const removed = words.filter((w) => w.start >= snapped.start - 0.02 && w.end <= snapped.end + 0.02);
        const spoken = removed.filter((w) => w.kind !== 'filler' && !isFillerWord(w.text));
        const note = lockedNote(pieces, range) ?? (snapped.start !== piece.start || snapped.end !== piece.end ? 'Moved to word boundaries.' : undefined);
        if (ai && spoken.length > 0) {
          const risky = spoken.some(carriesMeaning);
          if (cutKind === 'filler' || cutKind === 'silence') {
            out.push({ op: item, code: 'bad-value', message: `A ${cutKind} cut may not remove spoken words ("${spoken.slice(0, 4).map((w) => w.text).join(' ')}").` });
            continue;
          }
          if (confidence !== 'high' || risky) {
            // Uncertain or meaning-bearing removal → the creator decides.
            out.push({
              op: {
                op: 'suggest',
                kind: cutKind === 'retake' ? 'retake' : 'cut',
                start: snapped.start,
                end: snapped.end,
                title: cutKind === 'retake' ? 'Possible retake' : 'Possible trim',
                reason: reason ?? 'Removing this would drop spoken words.',
                confidence: risky ? 'low' : (confidence ?? 'medium'),
                apply: [{ op: 'cut', start: snapped.start, end: snapped.end, kind: cutKind, reason, confidence }],
              },
              note: risky ? 'Contains a negation, quantity or absolute; left for the creator to decide.' : 'Removes speech without high confidence; left as a suggestion.',
            });
            continue;
          }
        }
        out.push({ op: { op: 'cut', start: snapped.start, end: snapped.end, kind: cutKind, reason, confidence }, note });
      }
      return out.length ? out : reject(item, 'too-short', 'Nothing left to cut after protecting words and locks.');
    }

    case 'speed': {
      if (!num(o.speed) || o.speed < 0.25 || o.speed > 8) return reject(item, 'bad-value', 'Speed must be between 0.25× and 8×.');
      const pieces = free(range, 0.3);
      if (pieces.length === 0) return reject(item, 'locked', 'The range is locked or too short.');
      return pieces.map((p) => ({ op: { op: 'speed', start: p.start, end: p.end, speed: o.speed as number, reason, confidence }, note: lockedNote(pieces, range) }));
    }

    case 'layout': {
      if (!LAYOUTS.includes(o.mode as LayoutMode)) return reject(item, 'bad-value', 'Unknown layout.');
      const mode = o.mode as LayoutMode;
      const screen = sourceByRole(project, 'screen');
      const needsScreen = mode !== 'camera';
      const needsCam = mode !== 'screen';
      let allowed: Range[] = free(range, 0.5);
      let note = lockedNote(allowed, range);
      if (needsScreen) {
        if (!screen) return reject(item, 'no-coverage', 'This project has no screen source.');
        allowed = intersectAll(allowed, coverage(screen));
      }
      let camera: CameraSlot = o.camera === 'B' ? 'B' : 'A';
      if (needsCam) {
        let cam = cameraSource(project, camera);
        if (!cam) {
          const other: CameraSlot = camera === 'A' ? 'B' : 'A';
          cam = cameraSource(project, other);
          if (!cam) return reject(item, 'no-coverage', 'This project has no camera source.');
          camera = other;
          note = `Camera ${camera === 'A' ? 'B' : 'A'} does not exist; used camera ${camera}.`;
        }
        const before = allowed;
        allowed = intersectAll(allowed, coverage(cam));
        if (JSON.stringify(before) !== JSON.stringify(allowed)) note = `Clipped to where camera ${camera} has footage.`;
      }
      allowed = allowed.filter((p) => p.end - p.start >= 0.5);
      if (allowed.length === 0) return reject(item, 'no-coverage', `Camera ${camera} has no footage in this range.`);
      const transition = o.transition === 'cut' ? 'cut' : 'smooth';
      return allowed.map((p) => ({ op: { op: 'layout', start: p.start, end: p.end, mode, camera, transition, reason, confidence }, note }));
    }

    case 'zoom': {
      if (!sourceByRole(project, 'screen')) return reject(item, 'no-coverage', 'Zooms need a screen source.');
      if (!num(o.scale)) return reject(item, 'bad-shape', 'Zoom needs a scale.');
      const scale = clamp(o.scale, 1.1, 4);
      const pieces = free(range, 0.6);
      if (pieces.length === 0) return reject(item, 'too-short', 'Zoom is too short or locked.');
      const x = num(o.x) ? clamp(o.x, 0, 1) : undefined;
      const y = num(o.y) ? clamp(o.y, 0, 1) : undefined;
      const follow = typeof o.follow === 'boolean' ? o.follow : x === undefined;
      return pieces.map((p) => ({ op: { op: 'zoom', start: p.start, end: p.end, scale, x, y, follow, reason, confidence }, note: lockedNote(pieces, range) ?? (scale !== o.scale ? 'Scale limited to 1.1–4×.' : undefined) }));
    }

    case 'overlay': {
      if (!OVERLAYS.includes(o.kind as (typeof OVERLAYS)[number])) return reject(item, 'bad-value', 'Unknown graphic type.');
      const text = str(o.text, 90)?.trim();
      if (!text) return reject(item, 'bad-shape', 'Graphic needs text.');
      const subtext = str(o.subtext, 120)?.trim() || undefined;
      const unsupported = unsupportedNumbers(`${text} ${subtext ?? ''}`, project);
      if (ai && unsupported.length) {
        return reject(item, 'unsupported-fact', `The figure "${unsupported[0]}" does not appear in the recording, so it cannot be shown as a graphic.`);
      }
      const maxLen = o.kind === 'section-card' ? 6 : 12;
      const clipped = { start: range.start, end: Math.min(range.end, range.start + maxLen) };
      const pieces = free(clipped, 0.8);
      if (pieces.length === 0) return reject(item, 'too-short', 'Graphic is too short or locked.');
      const p = pieces[0]!;
      return [
        {
          op: { op: 'overlay', kind: o.kind as (typeof OVERLAYS)[number], start: p.start, end: p.end, text, subtext, x: num(o.x) ? clamp(o.x, 0.05, 0.95) : undefined, y: num(o.y) ? clamp(o.y, 0.05, 0.95) : undefined, reason, confidence },
          note: lockedNote(pieces, range),
        },
      ];
    }

    case 'broll': {
      const asset = project.sources.find((s) => s.id === o.assetId && (s.role === 'broll' || s.role === 'image'));
      if (!asset) return reject(item, 'missing-asset', 'That supporting asset is not in this project.');
      if (!asset.available) return reject(item, 'missing-asset', `"${asset.name}" is offline.`);
      const assetIn = num(o.assetIn) ? Math.max(0, o.assetIn) : 0;
      let r = range;
      let note: string | undefined;
      if (asset.kind === 'video') {
        const room = asset.duration - assetIn;
        if (room < 0.8) return reject(item, 'out-of-range', 'The asset is shorter than the requested start point.');
        if (r.end - r.start > room) {
          r = { start: r.start, end: r.start + room };
          note = 'Shortened to the length of the asset.';
        }
      }
      const pieces = free(r, 0.8);
      if (pieces.length === 0) return reject(item, 'too-short', 'B-roll is too short or locked.');
      return pieces.slice(0, 1).map((p) => ({ op: { op: 'broll', assetId: asset.id, start: p.start, end: p.end, assetIn, reason, confidence }, note: note ?? lockedNote(pieces, r) }));
    }

    case 'suggest': {
      if (!SUGGESTIONS.includes(o.kind as (typeof SUGGESTIONS)[number])) return reject(item, 'bad-value', 'Unknown suggestion type.');
      const title = str(o.title, 120)?.trim();
      const why = str(o.reason, 400)?.trim();
      if (!title || !why) return reject(item, 'bad-shape', 'Suggestion needs a title and reason.');
      const nested = Array.isArray(o.apply) ? o.apply : [];
      const apply: EditOp[] = [];
      for (const n of nested.slice(0, 20)) {
        if (n && typeof n === 'object' && (n as { op?: unknown }).op === 'suggest') continue;
        // Nested ops are validated as creator ops: they only run if the creator accepts.
        for (const res of validateOne(project, n, { origin: 'creator', scope: opts.scope })) if (!('code' in res)) apply.push(res.op);
      }
      // A suggestion that would remove locked content is not offered at all.
      if (ai && apply.some((a) => a.op === 'cut' && subtractAll([a], locks).reduce((s, r) => s + r.end - r.start, 0) < a.end - a.start - 1e-3)) {
        return reject(item, 'locked', 'Suggestion touches a locked range.');
      }
      return [{ op: { op: 'suggest', kind: o.kind as (typeof SUGGESTIONS)[number], start: range.start, end: range.end, title, reason: why, confidence: confidence ?? 'low', apply } }];
    }
  }
  return reject(item, 'unknown-op', 'Unhandled operation.');
}

/** Shrink a cut so it never slices a word; null when nothing useful remains. */
export function snapToWords(r: Range, words: Word[]): Range | null {
  let { start, end } = r;
  for (const w of words) {
    if (w.end <= start || w.start >= end) continue;
    const inside = w.start >= start - 0.02 && w.end <= end + 0.02;
    if (inside) continue;
    // partially covered word: back the cut off it
    if (w.start < start) start = Math.max(start, w.end);
    else end = Math.min(end, w.start);
  }
  return end - start >= 0.06 ? { start, end } : null;
}

/** Numeric tokens in a graphic that the recording never says. */
export function unsupportedNumbers(text: string, project: Pick<Project, 'transcript' | 'name'>): string[] {
  const tokens = text.match(/\d[\d,.]*%?/g) ?? [];
  if (tokens.length === 0) return [];
  const spoken = new Set<string>();
  const add = (s: string) => (s.match(/\d[\d,.]*/g) ?? []).forEach((d) => spoken.add(d.replace(/[,.]$/, '').replace(/,/g, '')));
  for (const w of project.transcript?.words ?? []) add(w.text);
  add(project.name);
  const WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', twenty: '20', thirty: '30', forty: '40', fifty: '50', hundred: '100', thousand: '1000' };
  for (const w of project.transcript?.words ?? []) {
    const d = WORDS[normalizeWord(w.text)];
    if (d) spoken.add(d);
  }
  return tokens.filter((t) => {
    const bare = t.replace(/%$/, '').replace(/[,.]$/, '').replace(/,/g, '');
    // Small ordinals used as step numbers ("Step 2") are structure, not claims.
    if (/^[1-9]$/.test(bare) && !t.endsWith('%')) return false;
    return !spoken.has(bare);
  });
}
