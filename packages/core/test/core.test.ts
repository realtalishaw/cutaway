import { describe, expect, it } from 'vitest';
import {
  TimeMap,
  applyProposal,
  buildCues,
  chaptersToOutput,
  checkChapters,
  commitEdit,
  conceptFromTemplate,
  correlateAudio,
  createProject,
  defaultSync,
  evaluateFrame,
  exportPreflight,
  manualCut,
  packageFolderName,
  PALETTES,
  proposePacing,
  proposeRetakes,
  proposeZooms,
  resolveLayout,
  restoreCut,
  restoreRevision,
  setMasterVoice,
  syncFromCalibration,
  toSourceTime,
  toSrt,
  updateById,
  validateOps,
  addLock,
  applyOps,
  type MediaSource,
  type Project,
  type Transcript,
  type Word,
} from '../src';

function src(role: MediaSource['role'], duration: number, extra: Partial<MediaSource> = {}): MediaSource {
  return {
    id: `src_${role}`,
    role,
    name: `${role}.mov`,
    path: `/tmp/${role}.mov`,
    managed: false,
    origin: 'import',
    kind: role === 'voice' ? 'audio' : 'video',
    duration,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    fingerprint: { sizeBytes: 1000, duration },
    available: true,
    cursorBaked: true,
    sync: defaultSync('reference'),
    gaps: [],
    ...extra,
  };
}

function words(spec: [string, number, number][]): Word[] {
  return spec.map(([text, start, end], i) => ({ id: `w${i}`, text, start, end, kind: 'word' as const }));
}

function transcript(ws: Word[]): Transcript {
  return { engine: 'test', locale: 'en-US', onDevice: true, sourceId: 'src_screen', hasSpeech: ws.length > 0, words: ws, generatedAt: '' };
}

function project(duration = 120, extra: Partial<Project> = {}): Project {
  const p = createProject('Demo', [src('screen', duration), src('cameraA', duration)]);
  return { ...p, ...extra };
}

describe('TimeMap', () => {
  it('maps through cuts and speed changes in both directions', () => {
    const map = new TimeMap(100, [{ start: 10, end: 20 }], [{ start: 40, end: 60, speed: 2 }]);
    expect(map.outDuration).toBeCloseTo(100 - 10 - 10);
    expect(map.toOutput(5)).toBeCloseTo(5);
    expect(map.toOutput(15)).toBeCloseTo(10); // inside the cut → lands on the next kept frame
    expect(map.toOutput(30)).toBeCloseTo(20);
    expect(map.toOutput(50)).toBeCloseTo(30 + 5); // 10s into a 2× range = 5s of output
    expect(map.toSource(35)).toBeCloseTo(50);
    expect(map.toSource(map.toOutput(77))).toBeCloseTo(77);
    expect(map.isKept(15)).toBe(false);
    expect(map.rangeToOutput({ start: 5, end: 25 })).toEqual([{ start: 5, end: 15 }]);
  });
});

describe('captions (SC-015, SC-017)', () => {
  const ws = words([
    ['Open', 1, 1.3],
    ['the', 1.3, 1.45],
    ['Cutawy', 1.5, 2.0],
    ['settings.', 2.0, 2.6],
    ['Then', 5, 5.3],
    ['press', 5.3, 5.6],
    ['save.', 5.6, 6.0],
  ]);
  it('follows trims and speed changes with valid ordered intervals', () => {
    let p = project(20, { transcript: transcript(ws) });
    p = commitEdit(p, manualCut(p.edit, { start: 2.7, end: 4.7 }, 2));
    p = commitEdit(p, applyOps(p.edit, [{ op: 'speed', start: 4.7, end: 7, speed: 2 }], 'creator', 3));
    const map = TimeMap.fromEdit(p.duration, p.edit);
    const cues = buildCues(p.transcript, p.edit, map);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i]!.end).toBeGreaterThan(cues[i]!.start);
      if (i > 0) expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
      expect(cues[i]!.end).toBeLessThanOrEqual(map.outDuration + 1e-9);
    }
    // "Then" is spoken at 5.0s source → 2.7 + (5 - 4.7)/2 output
    const then = cues.find((c) => c.text.startsWith('Then'))!;
    expect(then.start).toBeCloseTo(2.7 + 0.3 / 2, 2);
    expect(toSrt(cues)).toMatch(/^1\n00:00:01,000 --> /);
  });
  it('spelling correction changes caption text without removing footage', () => {
    const p = project(20, { transcript: transcript(ws) });
    const edit = { ...p.edit, wordText: { w2: 'Cutaway' } };
    const map = TimeMap.fromEdit(p.duration, edit);
    expect(map.outDuration).toBe(20);
    expect(buildCues(p.transcript, edit, map)[0]!.text).toContain('Cutaway');
  });
  it('writes no cues for a silent project (SC-030)', () => {
    const p = project(20, { transcript: transcript([]) });
    expect(buildCues(p.transcript, p.edit, TimeMap.fromEdit(20, p.edit))).toEqual([]);
  });
});

describe('proposal validation', () => {
  const ws = words([
    ['Do', 10, 10.2],
    ['not', 10.2, 10.5],
    ['delete', 10.5, 11],
    ['this', 11, 11.2],
    ['file.', 11.2, 11.7],
    ['um', 13, 13.3],
    ['Now', 15, 15.3],
    ['wait', 15.3, 15.6],
  ]);
  const base = () => project(60, { transcript: transcript(ws) });

  it('rejects anything that is not an allowed edit operation', () => {
    const r = validateOps(base(), [{ op: 'exec', cmd: 'rm -rf ~' }, { op: 'writeFile', path: '/etc/hosts' }, 'cut', null, { op: 'cut', start: 'a', end: 2 }], { origin: 'ai' });
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.code)).toEqual(['unknown-op', 'unknown-op', 'bad-shape', 'bad-shape', 'bad-shape']);
  });

  it('never silently removes a negation: it becomes a suggestion (SC-011)', () => {
    const r = validateOps(base(), [{ op: 'cut', start: 10.15, end: 10.55, kind: 'pacing', confidence: 'high', reason: 'tighten' }], { origin: 'ai' });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.op).toBe('suggest');
    const filler = validateOps(base(), [{ op: 'cut', start: 10.15, end: 10.55, kind: 'filler', confidence: 'high' }], { origin: 'ai' });
    expect(filler.accepted).toHaveLength(0);
  });

  it('applies filler and silence cuts, snapping away from words', () => {
    const r = validateOps(base(), [
      { op: 'cut', start: 12.9, end: 13.4, kind: 'filler', confidence: 'high' },
      { op: 'cut', start: 11.5, end: 12.8, kind: 'silence', confidence: 'high' },
    ], { origin: 'ai' });
    expect(r.accepted.map((o) => o.op)).toEqual(['cut', 'cut']);
    expect(r.accepted[1]).toMatchObject({ start: 11.7, end: 12.8 }); // backed off "file."
  });

  it('carves AI operations around locks and creator keeps (SC-016)', () => {
    let p = base();
    p = { ...p, edit: addLock(p.edit, { start: 20, end: 30 }, 'keep this explanation intact') };
    const r = validateOps(p, [
      { op: 'cut', start: 18, end: 32, kind: 'silence', confidence: 'high' },
      { op: 'zoom', start: 22, end: 28, scale: 2 },
      { op: 'layout', start: 25, end: 40, mode: 'camera', camera: 'A' },
    ], { origin: 'ai' });
    const cuts = r.accepted.filter((o) => o.op === 'cut');
    expect(cuts.map((c) => [c.start, c.end])).toEqual([[18, 20], [30, 32]]);
    expect(r.accepted.some((o) => o.op === 'zoom')).toBe(false);
    expect(r.accepted.find((o) => o.op === 'layout')).toMatchObject({ start: 30, end: 40 });

    // restored footage is protected from later AI cleanup
    let q = base();
    q = { ...q, edit: applyOps(q.edit, [{ op: 'cut', start: 40, end: 44, kind: 'silence' }], 'ai', 2) };
    q = { ...q, edit: restoreCut(q.edit, q.edit.cuts[0]!.id) };
    const again = validateOps(q, [{ op: 'cut', start: 40, end: 44, kind: 'silence', confidence: 'high' }], { origin: 'ai' });
    expect(again.rejected[0]!.code).toBe('kept-by-creator');
  });

  it('refuses graphics with figures the recording never says', () => {
    const r = validateOps(base(), [
      { op: 'overlay', kind: 'callout', start: 5, end: 8, text: '87% faster exports' },
      { op: 'overlay', kind: 'section-card', start: 0, end: 3, text: 'Step 2: Save the file' },
    ], { origin: 'ai' });
    expect(r.rejected[0]!.code).toBe('unsupported-fact');
    expect(r.accepted).toHaveLength(1);
  });

  it('rejects B-roll that is not in the project', () => {
    const r = validateOps(base(), [{ op: 'broll', assetId: 'nope', start: 5, end: 9 }], { origin: 'ai' });
    expect(r.rejected[0]!.code).toBe('missing-asset');
  });
});

describe('camera coverage (SC-005, SC-012)', () => {
  const p = () => {
    const camB = src('cameraB', 40, { sync: { ...defaultSync('manual'), offset: 20 }, gaps: [{ start: 35, end: 40, reason: 'disconnected' }] });
    return createProject('Two cams', [src('screen', 120), src('cameraA', 120), camB]);
  };
  it('clips camera B decisions to its calibrated usable range', () => {
    const r = validateOps(p(), [{ op: 'layout', start: 5, end: 80, mode: 'camera', camera: 'B' }], { origin: 'ai' });
    expect(r.accepted.map((o) => [o.start, o.end])).toEqual([[20, 35], [40, 60]]);
  });
  it('never shows a camera outside coverage even if a decision asks for it', () => {
    const pr = p();
    const edit = applyOps(pr.edit, [{ op: 'layout', start: 0, end: 120, mode: 'camera', camera: 'B' }], 'creator', 2);
    const q = { ...pr, edit };
    expect(resolveLayout(q, 10)).toMatchObject({ camera: 'A', fellBack: true, unresolved: false });
    expect(resolveLayout(q, 25)).toMatchObject({ camera: 'B', fellBack: false });
    expect(resolveLayout(q, 37)).toMatchObject({ camera: 'A', fellBack: true });
  });
  it('shows the main camera outside view blocks, and falls back where it has no footage', () => {
    const pr = p();
    const q = { ...pr, edit: { ...pr.edit, appearance: { ...pr.edit.appearance, camera: { ...pr.edit.appearance.camera, main: 'B' as const } } } };
    expect(resolveLayout(pr, 25).camera).toBe('A');
    expect(resolveLayout(q, 25).camera).toBe('B');
    expect(resolveLayout(q, 10).camera).toBe('A');
  });
});

describe('sync (SC-007, SC-032)', () => {
  it('manual two-point calibration recovers offset and drift', () => {
    const rate = 1.0005;
    const offset = 3.2;
    const s = syncFromCalibration([
      { session: 10, source: (10 - offset) * rate },
      { session: 600, source: (600 - offset) * rate },
    ]);
    expect(s.offset).toBeCloseTo(offset, 4);
    expect(s.rate).toBeCloseTo(rate, 6);
    expect(s.method).toBe('manual');
    for (const t of [0, 300, 600]) expect(Math.abs(toSourceTime(s, t) - (t - offset) * rate)).toBeLessThan(1 / 60);
  });

  it('audio correlation finds offset and drift within one frame', () => {
    const sr = 8000;
    const seconds = 90;
    // speech-like signal: noise bursts with irregular rhythm
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff);
    const ref = new Float32Array(sr * seconds);
    let t = 0;
    while (t < seconds) {
      const len = 0.08 + rnd() * 0.35;
      const amp = 0.2 + rnd() * 0.8;
      for (let i = Math.floor(t * sr); i < Math.min(ref.length, Math.floor((t + len) * sr)); i++) ref[i] = (rnd() * 2 - 1) * amp;
      t += len + 0.05 + rnd() * 0.5;
    }
    const offset = 4.37; // other camera started 4.37s late
    const rate = 1.0006; // and its clock runs fast
    const other = new Float32Array(sr * 70);
    for (let i = 0; i < other.length; i++) {
      const refT = i / sr / rate + offset;
      const j = Math.floor(refT * sr);
      other[i] = j >= 0 && j < ref.length ? ref[j]! * 0.5 + (rnd() * 2 - 1) * 0.02 : 0;
    }
    const r = correlateAudio(ref, other, sr, 30);
    expect(r.reliable).toBe(true);
    for (const srcT of [1, 35, 69]) {
      const truth = srcT / rate + offset;
      const est = srcT / r.rate + r.offset;
      expect(Math.abs(est - truth)).toBeLessThan(1 / 60);
    }
  }, 30000);

  it('does not claim a sync when recordings share no audio', () => {
    const sr = 8000;
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff);
    const mk = () => {
      const a = new Float32Array(sr * 40);
      let t = 0;
      while (t < 40) {
        const len = 0.1 + rnd() * 0.3;
        for (let i = Math.floor(t * sr); i < Math.min(a.length, Math.floor((t + len) * sr)); i++) a[i] = rnd() * 2 - 1;
        t += len + rnd() * 0.6;
      }
      return a;
    };
    expect(correlateAudio(mk(), mk(), sr, 20).reliable).toBe(false);
  }, 30000);
});

describe('pacing rules (SC-011, SC-030)', () => {
  it('keeps a wait that has a visible result, cuts a dead pause', () => {
    const ws = words([
      ['Click', 1, 1.4],
      ['build.', 1.4, 2],
      ['Done.', 12, 12.5],
      ['Next', 20, 20.4],
      ['step.', 20.4, 21],
    ]);
    const activity = new Array(100).fill(0); // 4 Hz, 25 s
    for (let i = 36; i < 44; i++) activity[i] = 0.05; // progress bar + result appear at 9–11s
    const ops = proposePacing({ duration: 25, words: ws, hasSpeech: true, brief: { pacing: 'balanced' }, activity, activityHz: 4, clicks: [{ t: 2.2, x: 0.5, y: 0.5 }] });
    const cuts = ops.filter((o) => o.op === 'cut');
    // nothing between 8.5 and 11.5 (the visible result) is removed
    expect(cuts.some((c) => c.start < 11.5 && c.end > 8.5)).toBe(false);
    // the dead pause 12.5 → 20 is shortened
    expect(cuts.some((c) => c.start >= 12.5 && c.end <= 20 && c.end - c.start > 5)).toBe(true);
    // no cut touches a word
    for (const c of cuts) for (const w of ws) expect(c.end <= w.start || c.start >= w.end).toBe(true);
  });
  it('edits a silent demo from screen activity alone', () => {
    const activity = new Array(160).fill(0);
    for (let i = 0; i < 20; i++) activity[i] = 0.03;
    for (let i = 120; i < 160; i++) activity[i] = 0.03;
    const ops = proposePacing({ duration: 40, words: [], hasSpeech: false, brief: { pacing: 'balanced' }, activity, activityHz: 4, clicks: [] });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'cut', kind: 'silence' });
  });
  it('offers retakes as suggestions, not cuts', () => {
    const ws = words([
      ['So', 0, 0.2], ['first', 0.2, 0.5], ['we', 0.5, 0.6], ['open', 0.6, 0.9], ['the', 0.9, 1], ['panel', 1, 1.4],
      ['So', 2.5, 2.7], ['first', 2.7, 3], ['we', 3, 3.1], ['open', 3.1, 3.4], ['the', 3.4, 3.5], ['settings', 3.5, 4], ['panel.', 4, 4.5],
    ]);
    const ops = proposeRetakes(ws);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('suggest');
  });
  it('caps zoom density for calm styles', () => {
    const clicks = Array.from({ length: 12 }, (_, i) => ({ t: 2 + i * 5, x: 0.3, y: 0.3 }));
    expect(proposeZooms(clicks, 70, 'calm')).toHaveLength(0); // single clicks are not enough
    expect(proposeZooms(clicks, 70, 'lively').length).toBeGreaterThan(3);
  });
});

describe('regeneration preserves creator work (SC-013, SC-016)', () => {
  it('replaces only AI decisions inside the scope', () => {
    let p = project(100);
    p = applyProposal(p, [
      { op: 'zoom', start: 10, end: 14, scale: 2 },
      { op: 'zoom', start: 50, end: 54, scale: 2 },
      { op: 'layout', start: 60, end: 70, mode: 'camera', camera: 'A' },
    ], { label: 'First cut' }).project;
    const manualZoom = p.edit.zooms[0]!;
    p = commitEdit(p, updateById(p.edit, 'zooms', manualZoom.id, { scale: 1.3 }, p.revision + 1));
    expect(p.edit.zooms[0]!.meta.origin).toBe('creator');

    const before = p.edit;
    const out = applyProposal(p, [{ op: 'zoom', start: 5, end: 20, scale: 3 }, { op: 'zoom', start: 51, end: 53, scale: 1.2 }], { label: 'Less movement', scope: { start: 45, end: 58 }, replaceAi: ['zooms'] });
    p = out.project;
    expect(p.edit.zooms.find((z) => z.id === manualZoom.id)).toMatchObject({ scale: 1.3, start: 10, end: 14 });
    expect(p.edit.zooms.filter((z) => z.start >= 45 && z.end <= 58)).toHaveLength(1);
    expect(p.edit.zooms.find((z) => z.start >= 45)!.scale).toBe(1.2);
    expect(p.edit.layouts).toEqual(before.layouts);
    expect(out.rejected.some((r) => r.code === 'out-of-range')).toBe(true);

    // undo: the checkpoint taken before the regeneration restores the previous section
    const cp = p.revisions.find((r) => r.label === 'Before: Less movement')!;
    const restored = restoreRevision(p, cp.revision);
    expect(restored.edit.zooms.find((z) => z.start >= 45)!.scale).toBe(2);
  });
});

describe('frames', () => {
  it('produces the same frame for the same time (preview/export consistency)', () => {
    let p = project(60);
    p = applyProposal(p, [{ op: 'zoom', start: 10, end: 16, scale: 2, x: 0.8, y: 0.2 }, { op: 'layout', start: 20, end: 30, mode: 'camera', camera: 'A' }], { label: 'x' }).project;
    const ctx = { project: p, map: TimeMap.fromEdit(p.duration, p.edit), cursor: null, follow: null, screenAspect: 16 / 9 };
    const a = evaluateFrame(ctx, 12.345);
    const b = evaluateFrame(ctx, 12.345);
    expect(a).toEqual(b);
    expect(a.screen!.zoom.scale).toBeCloseTo(2);
    expect(a.screen!.zoom.cx).toBeCloseTo(0.75); // clamped so the viewport stays inside the screen
    const mid = evaluateFrame(ctx, 20.2);
    expect(mid.cameras[0]!.rect.w).toBeGreaterThan(evaluateFrame(ctx, 19).cameras[0]!.rect.w);
    expect(evaluateFrame(ctx, 25).cameras[0]!.rect.w).toBe(1920);
  });
  it('a mask stays active whatever the zoom or layout (SC-018)', () => {
    let p = project(60);
    p = { ...p, edit: { ...p.edit, masks: [{ id: 'm1', target: 'screen', start: 5, end: 15, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, style: 'blur', meta: { origin: 'creator', revision: 1 } }] } };
    p = applyProposal(p, [{ op: 'zoom', start: 6, end: 12, scale: 2.5 }, { op: 'layout', start: 8, end: 14, mode: 'split', camera: 'A' }], { label: 'x' }).project;
    const ctx = { project: p, map: TimeMap.fromEdit(p.duration, p.edit), cursor: null, follow: null, screenAspect: 16 / 9 };
    for (const t of [5.1, 7, 9, 13, 14.9]) expect(evaluateFrame(ctx, t).masks).toHaveLength(1);
    expect(evaluateFrame(ctx, 16).masks).toHaveLength(0);
  });
});

describe('packaging and export', () => {
  it('marks packaging stale after a material cut, keeping creator edits (SC-022)', () => {
    let p = project(300);
    const c = conceptFromTemplate('headline', 'Ship faster', 'SHIP FASTER', { sourceId: 'src_screen', time: 12 }, PALETTES[0]!, 'because', [], 'template');
    p = { ...p, packaging: { ...p.packaging, concepts: [{ ...c, editedByCreator: true }], selectedId: c.id, basedOnRevision: p.revision } };
    p = commitEdit(p, manualCut(p.edit, { start: 100, end: 160 }, p.revision + 1));
    expect(p.packaging.stale).toBe(true);
    expect(p.packaging.concepts[0]!.editedByCreator).toBe(true);
    expect(p.packaging.selectedId).toBe(c.id);
  });

  it('chapters follow the cut and obey YouTube rules', () => {
    const map = new TimeMap(300, [{ start: 30, end: 90 }]);
    const ch = chaptersToOutput([{ sessionTime: 0, title: 'Intro' }, { sessionTime: 120, title: 'Setup' }, { sessionTime: 200, title: 'Result' }], map);
    expect(ch.map((c) => c.time)).toEqual([0, 60, 140]);
    expect(checkChapters(ch, map.outDuration).valid).toBe(true);
    expect(checkChapters(ch.slice(0, 2), map.outDuration).valid).toBe(false);
  });

  it('never reuses an existing export folder name', () => {
    expect(packageFolderName('My Video!', 3, [])).toBe('my-video-youtube');
    expect(packageFolderName('My Video!', 3, ['my-video-youtube'])).toBe('my-video-youtube-rev3');
    expect(packageFolderName('My Video!', 3, ['my-video-youtube', 'my-video-youtube-rev3'])).toBe('my-video-youtube-rev3-2');
  });

  it('blocks a complete export when media is missing or disk is short (SC-024, SC-033)', () => {
    const p = project(60);
    const missing = { ...p, sources: p.sources.map((s) => (s.role === 'cameraA' ? { ...s, available: false } : s)) };
    const a = exportPreflight(missing, { freeBytes: 50e9, estimatedBytes: 60e6 });
    expect(a.canExport).toBe(false);
    expect(a.canExportDraft).toBe(false);
    expect(a.checks.find((c) => c.level === 'block')!.action).toBe('relink');
    const b = exportPreflight(p, { freeBytes: 10e6, estimatedBytes: 60e6 });
    expect(b.checks.find((c) => c.id === 'disk')!.level).toBe('block');
    const ok = exportPreflight(p, { freeBytes: 50e9, estimatedBytes: 60e6 });
    expect(ok.canExportDraft).toBe(true);
    expect(ok.canExport).toBe(false); // no packaging selected yet → draft only
  });
});

describe('audio', () => {
  it('only one voice is audible after choosing a master (SC-008)', () => {
    const p = createProject('v', [src('screen', 60, { hasAudio: false }), src('cameraA', 60), src('cameraB', 60), src('voice', 60)]);
    expect(p.edit.audio.masterVoiceId).toBe('src_voice');
    const audible = (e: typeof p.edit) => Object.entries(e.audio.tracks).filter(([, t]) => !t.muted).map(([id]) => id);
    expect(audible(p.edit)).toEqual(['src_voice']);
    expect(audible(setMasterVoice(p.edit, p.sources, 'src_cameraA'))).toEqual(['src_cameraA']);
  });
});
