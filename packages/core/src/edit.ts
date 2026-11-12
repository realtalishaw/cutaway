import type {
  Appearance,
  AudioSettings,
  BrollInsert,
  Cut,
  DecisionMeta,
  EditOp,
  EditState,
  LayoutMode,
  LayoutSegment,
  MediaSource,
  Overlay,
  Project,
  Range,
  Suggestion,
  Zoom,
} from './types';
import { EPS, overlaps, subtract, uid, union } from './ranges';

export const BACKGROUNDS: { id: string; name: string; colors: string[]; angle: number }[] = [
  { id: 'ember', name: 'Ember', colors: ['#2a1410', '#8c2f16', '#f0703a'], angle: 135 },
  { id: 'tungsten', name: 'Tungsten', colors: ['#1b1712', '#6b4a1f', '#e9b44c'], angle: 140 },
  { id: 'harbor', name: 'Harbor', colors: ['#0d1b24', '#1d4e5f', '#7fd1c1'], angle: 150 },
  { id: 'dusk', name: 'Dusk', colors: ['#17122b', '#4a2f6b', '#e58fb0'], angle: 130 },
  { id: 'moss', name: 'Moss', colors: ['#10190f', '#2f5233', '#b9d98a'], angle: 145 },
  { id: 'paper', name: 'Paper', colors: ['#efe7da', '#e1d3bd', '#cdb898'], angle: 120 },
  { id: 'slate', name: 'Slate', colors: ['#15171a', '#2b3037', '#59626e'], angle: 160 },
  { id: 'signal', name: 'Signal', colors: ['#200b12', '#b3202f', '#ff8a5c'], angle: 125 },
];

export function defaultAppearance(): Appearance {
  return {
    output: { width: 1920, height: 1080, fps: 30 },
    background: { type: 'gradient', colors: BACKGROUNDS[0]!.colors, angle: BACKGROUNDS[0]!.angle },
    frame: { padding: 0.06, radius: 0.018, shadow: 0.6, inset: 0 },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    cursor: { visible: true, size: 1.4, smoothing: 0.6, hideWhenIdle: false, clickEffect: 'ripple' },
    camera: { shape: 'rounded', size: 0.24, corner: 'br', mirror: false, radius: 0.22, shadow: 0.5 },
    captions: { burnIn: false, size: 1, position: 'bottom', style: 'pill' },
    motion: 'balanced',
  };
}

export function defaultAudio(sources: MediaSource[]): AudioSettings {
  const voice = pickMasterVoice(sources);
  const tracks: AudioSettings['tracks'] = {};
  for (const s of sources) {
    if (!s.hasAudio) continue;
    const isMaster = s.id === voice?.id;
    const isSystem = s.role === 'systemAudio';
    // Only one voice is ever audible: camera scratch audio stays muted.
    tracks[s.id] = { gain: isSystem ? 0.6 : 1, muted: !(isMaster || isSystem) };
  }
  return { masterVoiceId: voice?.id ?? null, tracks, voiceCleanup: { enabled: true, bypass: false }, music: null };
}

/**
 * Prefer a dedicated voice track. Otherwise take the voice-bearing source that
 * covers the most of the timeline (a camera that started late would lose the
 * opening words), with camera A winning ties over the screen recording.
 */
export function pickMasterVoice(sources: MediaSource[]): MediaSource | undefined {
  const usable = sources.filter((x) => x.hasAudio && x.sync.status !== 'unsynced' && ['voice', 'cameraA', 'screen', 'cameraB'].includes(x.role));
  const voice = usable.find((x) => x.role === 'voice');
  if (voice) return voice;
  const order = ['cameraA', 'screen', 'cameraB'];
  const span = (x: MediaSource) => x.duration / x.sync.rate - Math.max(0, x.sync.offset);
  return [...usable].sort((a, b) => (Math.abs(span(b) - span(a)) > 0.75 ? span(b) - span(a) : order.indexOf(a.role) - order.indexOf(b.role)))[0];
}

export function emptyEdit(sources: MediaSource[]): EditState {
  return {
    cuts: [],
    keeps: [],
    speeds: [],
    layouts: [],
    zooms: [],
    overlays: [],
    broll: [],
    masks: [],
    locks: [],
    suggestions: [],
    wordText: {},
    audio: defaultAudio(sources),
    appearance: defaultAppearance(),
  };
}

/** Layout used where no explicit layout decision exists. */
export function defaultLayoutMode(sources: MediaSource[]): LayoutMode {
  const hasScreen = sources.some((s) => s.role === 'screen');
  const hasCam = sources.some((s) => s.role === 'cameraA' || s.role === 'cameraB');
  if (hasScreen && hasCam) return 'overlay';
  if (hasScreen) return 'screen';
  return 'camera';
}

export function meta(origin: DecisionMeta['origin'], revision: number, extra: Partial<DecisionMeta> = {}): DecisionMeta {
  return { origin, revision, ...extra };
}

// ───────────────────────────── lane helpers ─────────────────────────────

/**
 * Write `seg` into a lane of non-overlapping segments. Existing items are
 * trimmed or split around it. Items for which `protect` returns true are left
 * untouched and the new segment is carved around them instead.
 */
export function writeLane<T extends Range & { id: string }>(lane: T[], seg: T, protect: (existing: T) => boolean = () => false): T[] {
  const guarded = lane.filter((l) => protect(l) && overlaps(l, seg));
  const pieces = subtract(seg, guarded).filter((p) => p.end - p.start > 0.05);
  let out = [...lane];
  for (const piece of pieces) {
    const next: T[] = [];
    for (const l of out) {
      if (!overlaps(l, piece)) {
        next.push(l);
        continue;
      }
      if (piece.start - l.start > 0.05) next.push({ ...l, end: piece.start });
      if (l.end - piece.end > 0.05) next.push({ ...l, id: piece.start - l.start > 0.05 ? uid(l.id.split('_')[0]) : l.id, start: piece.end });
    }
    next.push({ ...seg, id: pieces.length > 1 ? uid(seg.id.split('_')[0]) : seg.id, start: piece.start, end: piece.end });
    out = next;
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Merge a new cut with neighbours of the same origin so the lane stays tidy. */
export function addCut(cuts: Cut[], cut: Cut): Cut[] {
  const out: Cut[] = [];
  let merged = { ...cut };
  for (const c of cuts) {
    if (c.start <= merged.end + EPS && merged.start <= c.end + EPS && c.meta.origin === merged.meta.origin && c.kind === merged.kind) {
      merged = { ...merged, start: Math.min(c.start, merged.start), end: Math.max(c.end, merged.end) };
    } else out.push(c);
  }
  out.push(merged);
  return out.sort((a, b) => a.start - b.start);
}

// ───────────────────────────── applying operations ─────────────────────────────

/**
 * Apply already-validated operations. AI-origin operations never overwrite
 * creator-origin or locked decisions; the creator can overwrite anything.
 */
export function applyOps(edit: EditState, ops: EditOp[], origin: DecisionMeta['origin'], revision: number): EditState {
  let next: EditState = { ...edit };
  const protect = <T extends { meta: DecisionMeta }>(x: T) => origin === 'ai' && (x.meta.origin === 'creator' || !!x.meta.locked);
  for (const op of ops) {
    const m = meta(origin, revision, { reason: 'reason' in op ? op.reason : undefined, confidence: 'confidence' in op ? op.confidence : undefined });
    switch (op.op) {
      case 'cut':
        next = { ...next, cuts: addCut(next.cuts, { id: uid('cut'), start: op.start, end: op.end, kind: op.kind, meta: m }) };
        break;
      case 'speed':
        next = { ...next, speeds: writeLane(next.speeds, { id: uid('spd'), start: op.start, end: op.end, speed: op.speed, meta: m }, protect) };
        break;
      case 'layout':
        next = {
          ...next,
          layouts: writeLane<LayoutSegment>(next.layouts, { id: uid('lay'), start: op.start, end: op.end, mode: op.mode, camera: op.camera ?? 'A', transition: op.transition ?? 'smooth', meta: m }, protect),
        };
        break;
      case 'zoom':
        next = {
          ...next,
          zooms: writeLane<Zoom>(next.zooms, { id: uid('zm'), start: op.start, end: op.end, scale: op.scale, follow: op.follow ?? op.x === undefined, x: op.x ?? 0.5, y: op.y ?? 0.5, meta: m }, protect),
        };
        break;
      case 'overlay': {
        const o: Overlay = { id: uid('ov'), kind: op.kind, start: op.start, end: op.end, text: op.text, subtext: op.subtext, x: op.x ?? 0.5, y: op.y ?? (op.kind === 'callout' ? 0.82 : 0.5), meta: m };
        next = { ...next, overlays: [...next.overlays, o].sort((a, b) => a.start - b.start) };
        break;
      }
      case 'broll': {
        const b: BrollInsert = { id: uid('br'), assetId: op.assetId, start: op.start, end: op.end, assetIn: op.assetIn ?? 0, fit: 'cover', useAssetAudio: false, meta: m };
        next = { ...next, broll: writeLane<BrollInsert>(next.broll, b, protect) };
        break;
      }
      case 'suggest': {
        const s: Suggestion = {
          id: uid('sg'),
          kind: op.kind,
          start: op.start,
          end: op.end,
          title: op.title,
          reason: op.reason,
          confidence: op.confidence ?? 'low',
          status: 'open',
          apply: op.apply ?? [],
          revision,
        };
        next = { ...next, suggestions: [...next.suggestions, s] };
        break;
      }
    }
  }
  return next;
}

// ───────────────────────────── creator actions ─────────────────────────────

/** Restore footage a cut removed, and remember the creator wants it kept. */
export function restoreCut(edit: EditState, cutId: string): EditState {
  const cut = edit.cuts.find((c) => c.id === cutId);
  if (!cut) return edit;
  return { ...edit, cuts: edit.cuts.filter((c) => c.id !== cutId), keeps: union([...edit.keeps, { start: cut.start, end: cut.end }]) };
}

/** Restore any removed footage inside a range (e.g. "restore this sentence"). */
export function restoreRange(edit: EditState, range: Range): EditState {
  const cuts: Cut[] = [];
  for (const c of edit.cuts) {
    if (!overlaps(c, range)) {
      cuts.push(c);
      continue;
    }
    const rest = subtract(c, [range]);
    rest.forEach((r, i) => cuts.push({ ...c, id: i === 0 ? c.id : uid('cut'), start: r.start, end: r.end }));
  }
  return { ...edit, cuts, keeps: union([...edit.keeps, range]) };
}

export function manualCut(edit: EditState, range: Range, revision: number, kind: Cut['kind'] = 'manual'): EditState {
  if (range.end - range.start < 0.01) return edit;
  // A creator cut overrides an earlier "keep".
  const keeps = union(edit.keeps.flatMap((k) => subtract(k, [range])));
  return { ...edit, keeps, cuts: addCut(edit.cuts, { id: uid('cut'), start: range.start, end: range.end, kind, meta: meta('creator', revision) }) };
}

export function addLock(edit: EditState, range: Range, note: string): EditState {
  return { ...edit, locks: [...edit.locks, { id: uid('lock'), start: range.start, end: range.end, note, createdAt: new Date().toISOString() }] };
}

export function removeById<K extends 'cuts' | 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll' | 'masks' | 'locks' | 'suggestions'>(edit: EditState, lane: K, id: string): EditState {
  return { ...edit, [lane]: (edit[lane] as { id: string }[]).filter((x) => x.id !== id) } as EditState;
}

export function updateById<K extends 'cuts' | 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll' | 'masks' | 'locks' | 'suggestions'>(
  edit: EditState,
  lane: K,
  id: string,
  patch: Partial<EditState[K][number]>,
  revision?: number,
): EditState {
  return {
    ...edit,
    [lane]: (edit[lane] as { id: string; meta?: DecisionMeta }[]).map((x) =>
      x.id === id ? { ...x, ...patch, ...(x.meta && revision !== undefined ? { meta: { ...x.meta, ...(patch as { meta?: DecisionMeta }).meta, origin: 'creator' as const, revision } } : {}) } : x,
    ),
  } as EditState;
}

export function acceptSuggestion(edit: EditState, id: string, revision: number): EditState {
  const s = edit.suggestions.find((x) => x.id === id);
  if (!s || s.status !== 'open') return edit;
  // Accepting is a creator decision, so the result is creator-origin.
  const applied = applyOps(edit, s.apply, 'creator', revision);
  return { ...applied, suggestions: applied.suggestions.map((x) => (x.id === id ? { ...x, status: 'accepted' as const } : x)) };
}

export function dismissSuggestion(edit: EditState, id: string): EditState {
  const s = edit.suggestions.find((x) => x.id === id);
  if (!s) return edit;
  // Dismissing a proposed removal means "keep this".
  const keepsRange = s.apply.some((o) => o.op === 'cut');
  return {
    ...edit,
    keeps: keepsRange ? union([...edit.keeps, { start: s.start, end: s.end }]) : edit.keeps,
    suggestions: edit.suggestions.map((x) => (x.id === id ? { ...x, status: 'dismissed' as const } : x)),
  };
}

/**
 * Remove AI decisions inside a range ahead of local regeneration. Creator
 * decisions, locked items and everything outside the range are untouched.
 */
export function clearAiInRange(edit: EditState, range: Range, lanes: ('cuts' | 'speeds' | 'layouts' | 'zooms' | 'overlays' | 'broll')[]): EditState {
  const next = { ...edit };
  for (const lane of lanes) {
    const items = edit[lane] as (Range & { id: string; meta: DecisionMeta })[];
    const kept: typeof items = [];
    for (const it of items) {
      const removable = it.meta.origin === 'ai' && !it.meta.locked && overlaps(it, range);
      if (!removable) {
        kept.push(it);
        continue;
      }
      // keep the parts of an AI decision that lie outside the range
      subtract(it, [range])
        .filter((r) => r.end - r.start > 0.1)
        .forEach((r, i) => kept.push({ ...it, id: i === 0 ? it.id : uid(it.id.split('_')[0]), start: r.start, end: r.end }));
    }
    (next as Record<string, unknown>)[lane] = kept.sort((a, b) => a.start - b.start);
  }
  return next;
}

/** Does the difference between two edits change what the viewer sees/hears enough to invalidate packaging? */
export function materialChange(a: EditState, b: EditState, duration: number): { material: boolean; reason: string | null } {
  const removed = (e: EditState) => union(e.cuts).reduce((s, r) => s + (r.end - r.start), 0);
  const delta = Math.abs(removed(a) - removed(b));
  if (delta > Math.max(5, duration * 0.04)) return { material: true, reason: `About ${Math.round(delta)}s of footage was ${removed(b) > removed(a) ? 'removed' : 'restored'} since these were made.` };
  if (JSON.stringify(a.speeds.map((s) => [s.start, s.end, s.speed])) !== JSON.stringify(b.speeds.map((s) => [s.start, s.end, s.speed]))) {
    return { material: true, reason: 'Playback speed changed, so chapter and caption timing moved.' };
  }
  if (delta > 0.05) return { material: true, reason: 'Cuts changed, so chapter and caption timing moved.' };
  return { material: false, reason: null };
}

export function revisionSummary(project: Pick<Project, 'edit'>): string {
  const e = project.edit;
  const ai = <T extends { meta: DecisionMeta }>(xs: T[]) => xs.filter((x) => x.meta.origin === 'ai').length;
  const parts = [
    `${e.cuts.length} cuts (${ai(e.cuts)} AI)`,
    `${e.layouts.length} view changes`,
    `${e.zooms.length} zooms`,
    `${e.overlays.length} graphics`,
    `${e.broll.length} B-roll`,
  ];
  return parts.join(' · ');
}
