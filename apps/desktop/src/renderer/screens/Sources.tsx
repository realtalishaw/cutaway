import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { clipsOf, dropTake, isTimelineSource, putBackClip, takeOf, coverage, fmtTime, relinkMatch, setMasterVoice, withoutSoundSource, syncFromCalibration, toSessionTime, toSourceTime, withSources, type CorrelationResult, type MediaSource, type Project, type Range, type SourceRole, type SourceSync } from '@cutaway/core';
import { resolveSourcePath, type ProbeResult } from '@shared/api';
import { useApp, useProject } from '../state/store';
import { clearImportReport, droppedPaths, errorText, filePaths, getImportReport, importFiles, newRecording, recordImportReport, sourceToClip, subscribeImportReport, takeToBroll } from '../state/actions';
import '../state/recording';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Empty, Modal, Segmented, Slider, Toggle, fmtBytes } from '../ui/kit';
import './sources.css';

const api = () => window.cutaway;

const ROLES: { role: SourceRole; label: string; icon: IconName; single: boolean; kinds: MediaSource['kind'][] }[] = [
  { role: 'screen', label: 'Screen', icon: 'screen', single: true, kinds: ['video'] },
  { role: 'cameraA', label: 'Camera A', icon: 'camera', single: true, kinds: ['video'] },
  { role: 'cameraB', label: 'Camera B', icon: 'camera', single: true, kinds: ['video'] },
  { role: 'voice', label: 'Voice', icon: 'mic', single: true, kinds: ['audio', 'video'] },
  { role: 'systemAudio', label: 'System audio', icon: 'speaker', single: false, kinds: ['audio'] },
  { role: 'broll', label: 'B-roll', icon: 'broll', single: false, kinds: ['video'] },
  { role: 'music', label: 'Music', icon: 'music', single: false, kinds: ['audio'] },
  { role: 'image', label: 'Image', icon: 'image', single: false, kinds: ['image'] },
];
const ROLE = Object.fromEntries(ROLES.map((r) => [r.role, r])) as Record<SourceRole, (typeof ROLES)[number]>;
const TIMELINE: SourceRole[] = ['screen', 'cameraA', 'cameraB', 'voice'];
const isTimeline = (s: MediaSource) => TIMELINE.includes(s.role);

/** The source that defines the session timeline (same rule as core.sessionDuration). */
function leadOf(sources: MediaSource[]): MediaSource | undefined {
  const tl = sources.filter((s) => isTimeline(s) && s.sync.status !== 'unsynced');
  return tl.find((s) => s.role === 'screen') ?? tl.find((s) => s.role === 'cameraA') ?? tl[0];
}

const REVIEW: SourceSync = { offset: 0, rate: 1, method: 'unsynced', confidence: null, status: 'needs-review', checkpoints: [], calibration: [], confirmedByCreator: false };
const REFERENCE: SourceSync = { offset: 0, rate: 1, method: 'reference', confidence: null, status: 'aligned', checkpoints: [], calibration: [], confirmedByCreator: true };

/**
 * Keep sync states honest after roles change: the lead source is the
 * reference; any other imported timeline source that was never aligned must be
 * reviewed. Sources recorded together keep their shared clock.
 */
function normaliseSync(sources: MediaSource[]): MediaSource[] {
  // Each footage group (a clip's take) has its own reference; a clip that sits further along the
  // timeline keeps its place (`shift`) when its sync state is reset.
  const leads = new Map<string, MediaSource | undefined>();
  const leadFor = (s: MediaSource) => {
    const k = takeOf(s);
    if (!leads.has(k)) leads.set(k, leadOf(sources.filter((x) => !x.instanceOf && takeOf(x) === k)));
    return leads.get(k);
  };
  let changed = false;
  const out = sources.map((s) => {
    if (s.sync.method === 'recorded-clock' || s.instanceOf) return s;
    if (!isTimeline(s)) {
      if (s.sync.method === 'reference' && s.sync.status === 'aligned') return s;
      changed = true;
      return { ...s, sync: { ...REFERENCE } };
    }
    if (s.id === leadFor(s)?.id) {
      if (s.sync.status === 'aligned' && s.sync.confirmedByCreator) return s;
      if (s.sync.method !== 'unsynced') return s;
      changed = true;
      return { ...s, sync: { ...REFERENCE, offset: s.shift ?? 0 } };
    }
    if (s.sync.method === 'reference') {
      changed = true;
      return { ...s, sync: { ...REVIEW, offset: s.shift ?? 0 } };
    }
    return s;
  });
  return changed ? out : sources;
}

/** The reference of a source's own footage group. */
const groupLead = (sources: MediaSource[], s: MediaSource) => leadOf(sources.filter((x) => !x.instanceOf && takeOf(x) === takeOf(s)));

function needsReview(s: MediaSource, lead: MediaSource | undefined): boolean {
  return isTimeline(s) && s.id !== lead?.id && s.sync.method !== 'recorded-clock' && s.sync.status !== 'unsynced' && !(s.sync.status === 'aligned' && s.sync.confirmedByCreator);
}

function patchSources(fn: (sources: MediaSource[]) => MediaSource[]) {
  useApp.getState().patch((p: Project) => {
    const next = normaliseSync(fn(p.sources));
    return next === p.sources ? p : withSources(p, next);
  });
}

const setSync = (id: string, sync: SourceSync) => patchSources((ss) => ss.map((s) => (s.id === id ? { ...s, sync } : s)));

const fps2 = (n?: number) => (n ? `${Number.isInteger(n) ? n : n.toFixed(2)} fps` : null);
const secs = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(3)} s`;

// ───────────────────────────── coverage strip ─────────────────────────────

function CoverageStrip({ source, duration, lead }: { source: MediaSource; duration: number; lead: boolean }) {
  const total = Math.max(duration, 0.001);
  const excluded = source.sync.status === 'unsynced';
  const cov = excluded ? [] : coverage(source);
  const start = source.sync.offset;
  const end = source.sync.offset + source.duration / source.sync.rate;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100))}%`;
  return (
    <div className="cov">
      <div className={`cov-bar${excluded ? ' excluded' : ''}`} role="img" aria-label={excluded ? 'Not placed on the timeline' : `Covers ${fmtTime(Math.max(0, start), true)} to ${fmtTime(Math.min(total, end), true)}`}>
        {cov.map((r, i) => (
          <i key={i} className={`cov-seg${lead ? ' lead' : ''}`} style={{ left: pct(r.start), width: `calc(${pct(r.end)} - ${pct(r.start)})` }} />
        ))}
        {source.gaps.map((g, i) => (
          <i key={`g${i}`} className="cov-gap" title={`No media ${fmtTime(g.start, true)}–${fmtTime(g.end, true)}: ${g.reason}`} style={{ left: pct(g.start), width: `calc(${pct(g.end)} - ${pct(g.start)})` }} />
        ))}
      </div>
      <div className="row between tiny dim mono">
        {excluded ? (
          <span>not placed on the timeline</span>
        ) : (
          <>
            <span>{lead ? 'defines the timeline' : `starts ${fmtTime(Math.max(0, start), true)}${start < -0.01 ? ` (${Math.abs(start).toFixed(1)}s before the timeline)` : ''}`}</span>
            <span>
              {source.gaps.length ? `${source.gaps.length} gap${source.gaps.length === 1 ? '' : 's'} · ` : ''}
              ends {fmtTime(Math.min(end, total), true)}
              {end < total - 0.05 ? ` (${(total - end).toFixed(1)}s early)` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── sync workbench ─────────────────────────────

interface Pair {
  session: number;
  source: number;
}

function Player({ source, projectPath, label, mediaRef, muted }: { source: MediaSource; projectPath: string; label: string; mediaRef: React.RefObject<HTMLVideoElement | null>; muted: boolean }) {
  const [t, setT] = useState(0);
  const [error, setError] = useState(false);
  const url = api().media.url(resolveSourcePath(projectPath, source.path));
  return (
    <div className="sync-player">
      <div className="sync-screen">
        <video ref={mediaRef} src={url} muted={muted} playsInline preload="auto" crossOrigin="anonymous" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onSeeked={(e) => setT(e.currentTarget.currentTime)} onError={() => setError(true)} />
        {source.kind === 'audio' ? <div className="sync-audio"><Icon name="wave" size={28} /></div> : null}
        {error ? <div className="sync-audio" style={{ color: 'var(--danger)' }}><Icon name="warn" size={22} /><span className="tiny">Cannot play this file here</span></div> : null}
        <span className="sync-label">{label}</span>
      </div>
      <input
        className="slider"
        type="range"
        min={0}
        max={Math.max(0.01, source.duration)}
        step={0.01}
        value={Math.min(t, source.duration)}
        aria-label={`${label} position`}
        style={{ ['--p' as string]: `${(Math.min(t, source.duration) / Math.max(0.01, source.duration)) * 100}%` }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setT(v);
          if (mediaRef.current) mediaRef.current.currentTime = v;
        }}
      />
      <div className="row between tiny mono dim">
        <span>{fmtTime(t, true)}</span>
        <span className="row" style={{ gap: 4 }}>
          <button className="btn sm ghost" onClick={() => mediaRef.current && (mediaRef.current.currentTime = Math.max(0, mediaRef.current.currentTime - 1 / (source.fps || 30)))} aria-label="Back one frame">−1f</button>
          <button className="btn sm ghost" onClick={() => mediaRef.current && (mediaRef.current.paused ? void mediaRef.current.play() : mediaRef.current.pause())} aria-label="Play or pause">
            <Icon name="play" size={11} />
          </button>
          <button className="btn sm ghost" onClick={() => mediaRef.current && (mediaRef.current.currentTime = Math.min(source.duration, mediaRef.current.currentTime + 1 / (source.fps || 30)))} aria-label="Forward one frame">+1f</button>
        </span>
        <span>{fmtTime(source.duration, true)}</span>
      </div>
    </div>
  );
}

function SyncWorkbench({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const source = project.sources.find((s) => s.id === sourceId);
  // a file is lined up against the reference of its own footage group (its clip)
  const lead = source ? groupLead(project.sources, source) : leadOf(project.sources);
  const refVideo = useRef<HTMLVideoElement>(null);
  const srcVideo = useRef<HTMLVideoElement>(null);
  const [listen, setListen] = useState<'both' | 'ref' | 'this'>('both');
  const [finding, setFinding] = useState(false);
  const [result, setResult] = useState<{ r: CorrelationResult; refName: string } | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<{ a: Pair | null; b: Pair | null }>({ a: null, b: null });
  const [offsetDraft, setOffsetDraft] = useState<string | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (stopTimer.current && clearTimeout(stopTimer.current)), []);

  if (!source || !lead) return null;
  const sync = source.sync;
  const frame = 1 / (source.fps || project.edit.appearance.output.fps || 30);

  // Audio reference: an aligned source that has sound. Its file time maps onto the session clock.
  const audioRef = [lead, project.sources.find((s) => s.id === project.edit.audio.masterVoiceId), ...project.sources]
    .filter((s): s is MediaSource => !!s && s.id !== source.id && s.hasAudio && s.available && isTimeline(s) && s.sync.status === 'aligned' && s.sync.confirmedByCreator)[0];

  const findFromAudio = async () => {
    if (!audioRef) return;
    setFinding(true);
    setFindError(null);
    setResult(null);
    try {
      const r = await api().native.correlate(resolveSourcePath(projectPath, audioRef.path), resolveSourcePath(projectPath, source.path), 600);
      setResult({ r, refName: audioRef.name });
      if (r.reliable) {
        // Map from the reference file's clock onto the session clock.
        const offset = audioRef.sync.offset + r.offset / audioRef.sync.rate;
        const rate = r.rate * audioRef.sync.rate;
        setSync(source.id, {
          offset,
          rate,
          method: 'audio-correlation',
          confidence: r.confidence,
          status: 'needs-review',
          checkpoints: r.checkpoints.map((c) => ({ sessionTime: audioRef.sync.offset + c.sessionTime / audioRef.sync.rate, residualMs: c.residualMs })),
          calibration: [],
          confirmedByCreator: false,
        });
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      setFindError(code === 'no-audio' ? 'One of the two files has no audio track, so there is nothing to compare. Align it by hand below.' : errorText(e));
    } finally {
      setFinding(false);
    }
  };

  const nudge = (delta: number) => setSync(source.id, { ...sync, offset: sync.offset + delta, method: sync.method === 'unsynced' ? 'manual' : sync.method, status: 'needs-review', confirmedByCreator: false, checkpoints: [] });
  const commitOffset = () => {
    if (offsetDraft === null) return;
    const v = Number(offsetDraft);
    setOffsetDraft(null);
    if (Number.isFinite(v) && Math.abs(v - sync.offset) > 1e-4) setSync(source.id, { ...sync, offset: v, method: sync.method === 'unsynced' ? 'manual' : sync.method, status: 'needs-review', confirmedByCreator: false, checkpoints: [] });
  };

  const mark = (which: 'a' | 'b') => {
    if (!refVideo.current || !srcVideo.current) return;
    setPairs((p) => ({ ...p, [which]: { session: toSessionTime(lead.sync, refVideo.current!.currentTime), source: srcVideo.current!.currentTime } }));
  };
  const applyCalibration = () => {
    const pts = [pairs.a, pairs.b].filter((p): p is Pair => !!p);
    if (pts.length === 0) return;
    setSync(source.id, syncFromCalibration(pts, sync));
    setResult(null);
  };
  const calibrated = [pairs.a, pairs.b].filter(Boolean).length;
  const calPreview = calibrated ? syncFromCalibration([pairs.a, pairs.b].filter((p): p is Pair => !!p)) : null;

  // Where both files have media, on the session clock.
  const overlap: Range = { start: Math.max(lead.sync.offset, sync.offset, 0), end: Math.min(lead.sync.offset + lead.duration / lead.sync.rate, sync.offset + source.duration / sync.rate) };
  const hasOverlap = overlap.end - overlap.start > 1;
  const playAt = (fraction: number) => {
    if (!refVideo.current || !srcVideo.current || !hasOverlap) return;
    const span = Math.min(4, overlap.end - overlap.start);
    const t = overlap.start + (overlap.end - overlap.start - span) * fraction;
    const a = refVideo.current;
    const b = srcVideo.current;
    a.currentTime = toSourceTime(lead.sync, t);
    b.currentTime = toSourceTime(sync, t);
    b.playbackRate = Math.max(0.5, Math.min(2, sync.rate / lead.sync.rate));
    void a.play().catch(() => {});
    void b.play().catch(() => {});
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      a.pause();
      b.pause();
    }, span * 1000);
  };

  const driftPpm = (sync.rate - 1) * 1e6;
  const driftFrames = Math.abs(sync.rate - 1) * source.duration * (project.edit.appearance.output.fps || 30);
  const worst = sync.checkpoints.reduce((m, c) => Math.max(m, c.residualMs), 0);
  const methodText: Record<SourceSync['method'], string> = { 'recorded-clock': 'Recorded together', 'audio-correlation': 'Matched by shared audio', manual: 'Aligned by you', unsynced: 'Not aligned', reference: 'Timeline reference' };
  const confirmed = sync.status === 'aligned' && sync.confirmedByCreator;

  return (
    <Modal
      wide
      eyebrow="Sync review"
      title={<>Line up “{source.name}”</>}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => (setSync(source.id, { ...REVIEW, status: 'unsynced' }), onClose())} title="Keep the file in the project but leave it out of the edit">Leave out of the edit</Button>
          <div className="grow" />
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon="check" disabled={sync.method === 'unsynced'} title={sync.method === 'unsynced' ? 'Align it first: find sync from audio, or mark a matching moment' : undefined} onClick={() => (setSync(source.id, { ...sync, status: 'aligned', confirmedByCreator: true }), onClose())}>
            {confirmed ? 'Sync confirmed' : 'Confirm sync'}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="sync-players">
          <Player source={lead} projectPath={projectPath} label={`Reference · ${ROLE[lead.role].label}`} mediaRef={refVideo} muted={listen === 'this'} />
          <Player source={source} projectPath={projectPath} label={`This file · ${ROLE[source.role].label}`} mediaRef={srcVideo} muted={listen === 'ref'} />
        </div>

        <div className="row between wrap" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="small muted">Play both at</span>
            <Button size="sm" disabled={!hasOverlap} onClick={() => playAt(0.02)}>Start</Button>
            <Button size="sm" disabled={!hasOverlap} onClick={() => playAt(0.5)}>Middle</Button>
            <Button size="sm" disabled={!hasOverlap} onClick={() => playAt(0.98)}>End</Button>
            {!hasOverlap ? <span className="tiny" style={{ color: '#ffc452' }}>The two files do not overlap with this offset.</span> : <span className="tiny dim">An echo means they are still apart.</span>}
          </div>
          <Segmented label="Listen to" value={listen} onChange={setListen} options={[{ value: 'both', label: 'Both' }, { value: 'ref', label: 'Reference' }, { value: 'this', label: 'This file' }]} />
        </div>

        <div className="sync-stats">
          <div><span className="eyebrow">Method</span><b>{methodText[sync.method]}</b></div>
          <div><span className="eyebrow">Offset</span><b className="mono">{sync.method === 'unsynced' ? '—' : secs(sync.offset)}</b></div>
          <div><span className="eyebrow">Drift</span><b className="mono">{sync.method === 'unsynced' ? '—' : `${driftPpm >= 0 ? '+' : '−'}${Math.abs(driftPpm).toFixed(0)} ppm`}</b><span className="tiny dim">{sync.method === 'unsynced' ? '' : driftFrames < 0.5 ? 'under a frame over the take' : `${driftFrames.toFixed(1)} frames over the take, corrected`}</span></div>
          <div><span className="eyebrow">Confidence</span><b className="mono">{sync.confidence === null ? '—' : `${Math.round(sync.confidence * 100)}%`}</b><span className="tiny dim">{sync.checkpoints.length ? `${sync.checkpoints.length} check points, worst ${worst.toFixed(1)} ms` : ''}</span></div>
        </div>

        {sync.checkpoints.length ? (
          <div className="row wrap" style={{ gap: 6 }}>
            {sync.checkpoints.map((c, i) => (
              <span key={i} className={`pill ${c.residualMs <= 1000 * frame ? 'ok' : 'warn'}`} title="Difference between the fitted alignment and what was measured at this point">
                <span className="mono">{fmtTime(c.sessionTime)}</span> {c.residualMs.toFixed(1)} ms
              </span>
            ))}
            <span className="tiny dim">One frame is {(frame * 1000).toFixed(0)} ms.</span>
          </div>
        ) : null}

        <div className="sync-tools">
          <div className="sync-tool">
            <div className="row between">
              <b>From shared audio</b>
              <Button size="sm" icon="wave" busy={finding} disabled={!audioRef} onClick={() => void findFromAudio()}>Find sync from audio</Button>
            </div>
            {!audioRef ? (
              <span className="tiny dim">No aligned source with sound to compare against. Use manual alignment.</span>
            ) : !source.hasAudio ? (
              <span className="tiny dim">This file has no audio track, so it can only be aligned by hand.</span>
            ) : finding ? (
              <span className="tiny dim">Comparing against “{audioRef.name}”…</span>
            ) : findError ? (
              <span className="tiny" style={{ color: 'var(--danger)' }}>{findError}</span>
            ) : result ? (
              result.r.reliable ? (
                <span className="tiny" style={{ color: 'var(--ok)' }}>Found a match at {Math.round(result.r.confidence * 100)}% confidence against “{result.refName}”. Play the check points, then confirm.</span>
              ) : (
                <span className="tiny" style={{ color: '#ffc452' }}>
                  No shared audio was found between these files ({Math.round(result.r.confidence * 100)}% match). Nothing was changed and this file is not synchronized. Align it by hand: find the same moment in both players and mark it.
                </span>
              )
            ) : (
              <span className="tiny dim">Works when both recordings heard the same room. Compared against “{audioRef.name}”.</span>
            )}
          </div>

          <div className="sync-tool">
            <b>By hand</b>
            <div className="row wrap" style={{ gap: 6 }}>
              <Button size="sm" onClick={() => nudge(-0.1)}>−0.1 s</Button>
              <Button size="sm" onClick={() => nudge(-frame)}>−1 frame</Button>
              <input className="input mono" style={{ width: 96, height: 24, fontSize: 11.5 }} aria-label="Offset in seconds" value={offsetDraft ?? sync.offset.toFixed(3)} onChange={(e) => setOffsetDraft(e.target.value)} onBlur={commitOffset} onKeyDown={(e) => e.key === 'Enter' && commitOffset()} />
              <Button size="sm" onClick={() => nudge(frame)}>+1 frame</Button>
              <Button size="sm" onClick={() => nudge(0.1)}>+0.1 s</Button>
            </div>
            <span className="tiny dim">Offset is where this file starts on the timeline. Positive means it started later than the reference.</span>
          </div>

          <div className="sync-tool">
            <b>Two-point calibration</b>
            <span className="tiny dim">Park both players on the same moment (a clap, a keystroke, a word), then mark it. One point fixes the offset; a second one far away also corrects drift.</span>
            <div className="row wrap" style={{ gap: 6 }}>
              <Button size="sm" on={!!pairs.a} onClick={() => mark('a')}>Mark start pair</Button>
              <span className="tiny mono dim" style={{ minWidth: 150 }}>{pairs.a ? `${fmtTime(pairs.a.session, true)} ↔ ${fmtTime(pairs.a.source, true)}` : 'not marked'}</span>
              <Button size="sm" on={!!pairs.b} onClick={() => mark('b')}>Mark end pair</Button>
              <span className="tiny mono dim" style={{ minWidth: 150 }}>{pairs.b ? `${fmtTime(pairs.b.session, true)} ↔ ${fmtTime(pairs.b.source, true)}` : 'not marked'}</span>
            </div>
            <div className="row between">
              <span className="tiny dim">
                {calPreview ? `Gives offset ${secs(calPreview.offset)}${calibrated === 2 ? `, drift ${((calPreview.rate - 1) * 1e6).toFixed(0)} ppm` : ', no drift correction yet'}.` : ''}
                {calibrated === 2 && pairs.a && pairs.b && Math.abs(pairs.b.session - pairs.a.session) < 10 ? ' The two points are close together; drift is more accurate with points far apart.' : ''}
              </span>
              <Button size="sm" variant="primary" disabled={calibrated === 0} onClick={applyCalibration}>Apply calibration</Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────── relink ─────────────────────────────

type RelinkState = { source: MediaSource; probe: ProbeResult; match: 'likely' | 'different'; detail: string } | null;

async function relink(source: MediaSource, setState: (s: RelinkState) => void) {
  const app = useApp.getState();
  const kinds = source.kind === 'image' ? (['image'] as const) : source.kind === 'audio' ? (['audio', 'video'] as const) : (['video'] as const);
  const [picked] = await api().app.pickFiles({ title: `Locate “${source.name}”`, kinds: [...kinds], multiple: false });
  if (!picked) return;
  try {
    const [probe] = await api().native.probe([picked]);
    if (!probe) throw new Error('The file could not be inspected.');
    const m = relinkMatch(source, probe);
    if (m.match === 'exact') {
      applyRelink(source, probe, false);
      app.toast(`Relinked “${source.name}”. Your edits line up as before.`);
    } else setState({ source, probe, match: m.match, detail: m.detail });
  } catch (e) {
    app.toast(`Could not inspect that file: ${errorText(e)}`, 'error');
  }
}

/** Point the source at the new location. The file is referenced where it is; nothing is moved or deleted. */
function applyRelink(source: MediaSource, probe: ProbeResult, updateIdentity: boolean) {
  patchSources((ss) =>
    ss.map((s) =>
      s.id === source.id
        ? { ...s, path: probe.path, managed: false, available: true, fingerprint: updateIdentity ? { sizeBytes: probe.sizeBytes ?? s.fingerprint.sizeBytes, duration: probe.duration ?? s.fingerprint.duration, createdAt: probe.createdAt ?? s.fingerprint.createdAt } : s.fingerprint }
        : s,
    ),
  );
}

// ───────────────────────────── source row ─────────────────────────────

function SourceRow({ source, project, lead, onSync, onRelink }: { source: MediaSource; project: Project; lead: MediaSource | undefined; onSync: () => void; onRelink: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const projectPath = useApp((s) => s.projectPath)!;
  // roles are per footage group: every clip can have its own screen and cameras
  const taken = new Set(project.sources.filter((s) => s.id !== source.id && !s.instanceOf && takeOf(s) === takeOf(source)).map((s) => s.role));
  const pieces = project.edit.clips && isTimelineSource(source) ? clipsOf(project).filter((c) => c.take === takeOf(source)) : [];
  const offTimeline = pieces.length > 0 && pieces.every((c) => c.removed);
  const otherFootage = project.sources.some((s) => s.id !== source.id && !s.instanceOf && isTimelineSource(s) && s.kind === 'video');
  const isLead = source.id === lead?.id;
  const timeline = isTimeline(source);
  const sync = source.sync;
  const review = needsReview(source, lead);

  const changeRole = (role: SourceRole) =>
    patchSources((ss) =>
      ss.map((s) => {
        if (s.id !== source.id) return s;
        const nowTimeline = TIMELINE.includes(role);
        const keep = s.sync.method === 'recorded-clock' || (nowTimeline && timeline && s.sync.method !== 'reference');
        return { ...s, role, sync: keep ? s.sync : nowTimeline ? { ...REVIEW } : { ...REFERENCE } };
      }),
    );

  const remove = () => {
    useApp.getState().patch((p0) => {
      // the picture of a clip leaves with its clip
      const lastVideo = !!p0.edit.clips && isTimelineSource(source) && source.kind === 'video' && !p0.sources.some((s) => s.id !== source.id && !s.instanceOf && isTimelineSource(s) && s.kind === 'video' && takeOf(s) === takeOf(source));
      const p = lastVideo ? dropTake(p0, takeOf(source)) : p0;
      const sources = normaliseSync(p.sources.filter((s) => s.id !== source.id));
      const next = withSources({ ...p, sources }, sources);
      // Decisions that pointed at this file go with it.
      return { ...next, edit: withoutSoundSource({ ...next.edit, broll: next.edit.broll.filter((b) => b.assetId !== source.id) }, p.sources, source.id) };
    });
    useApp.getState().toast(`Removed “${source.name}” from the project. The file itself was not deleted.`);
  };

  const syncPill = !timeline ? null : isLead ? (
    <span className="pill"><Icon name="clock" size={10} /> Timeline reference</span>
  ) : sync.method === 'recorded-clock' ? (
    <span className="pill ok"><Icon name="check" size={10} /> Recorded together · shared clock</span>
  ) : sync.status === 'unsynced' ? (
    <span className="pill"><Icon name="eyeOff" size={10} /> Left out of the edit</span>
  ) : sync.status === 'aligned' && sync.confirmedByCreator ? (
    <span className="pill ok"><Icon name="check" size={10} /> {sync.method === 'audio-correlation' ? 'Synced by audio' : 'Aligned by you'} · {secs(sync.offset)}</span>
  ) : sync.method === 'unsynced' ? (
    <span className="pill warn"><Icon name="warn" size={10} /> Not aligned yet</span>
  ) : (
    <span className="pill warn"><Icon name="warn" size={10} /> Sync found · needs your review</span>
  );

  const meta = [
    fmtTime(source.duration, true),
    source.width && source.height ? `${source.width}×${source.height}` : null,
    source.kind === 'video' ? fps2(source.fps) : null,
    source.codec?.trim() || null,
    source.kind === 'audio' && source.sampleRate ? `${(source.sampleRate / 1000).toFixed(source.sampleRate % 1000 ? 1 : 0)} kHz${source.audioChannels ? ` · ${source.audioChannels === 1 ? 'mono' : source.audioChannels === 2 ? 'stereo' : `${source.audioChannels} ch`}` : ''}` : null,
    source.fingerprint.sizeBytes ? fmtBytes(source.fingerprint.sizeBytes) : null,
  ].filter(Boolean);

  return (
    <article className={`source-row${!source.available ? ' missing' : ''}`}>
      <div className="source-icon"><Icon name={ROLE[source.role].icon} size={18} /></div>
      <div className="col grow" style={{ gap: 7, minWidth: 0 }}>
        <div className="row between" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <span className="source-name" title={source.managed ? source.name : source.path}>{source.name}</span>
            <span className={`pill ${source.origin === 'recording' ? 'accent' : ''}`}>{source.origin === 'recording' ? 'Recorded here' : source.managed ? 'Imported · copy in project' : 'Imported · linked file'}</span>
            {source.deviceKind ? <span className="pill" title="Recorded from a connected device. Touches are not captured as cursor data, so there are no automatic zooms for this track."><Icon name="phone" size={10} /> {source.deviceKind === 'ipad' ? 'iPad' : 'iPhone'} · no cursor data</span> : null}
            {source.keysFile ? <span className="pill" title="Shortcuts and typing activity were recorded with this take (never the typed characters). Show them from the Keyboard shortcuts tab in the editor."><Icon name="command" size={10} /> Shortcuts recorded</span> : null}
            {source.variableFrameRate && source.origin === 'import' ? <span className="pill warn" title="Frames are not evenly spaced. Cutaway reads real timestamps and conforms on export; the original is not changed.">Variable frame rate</span> : null}
          </div>
          <div className="row" style={{ gap: 6, flex: 'none' }}>
            <select className="select role-select" value={source.role} aria-label={`Role of ${source.name}`} onChange={(e) => changeRole(e.target.value as SourceRole)} disabled={source.origin === 'recording'} title={source.origin === 'recording' ? 'The role of a recorded track is fixed by how it was captured' : undefined}>
              {ROLES.filter((r) => r.kinds.includes(source.kind) && (r.role !== 'voice' || source.hasAudio)).map((r) => (
                <option key={r.role} value={r.role} disabled={r.single && taken.has(r.role)}>
                  {r.label}{r.single && taken.has(r.role) ? ' (in use)' : ''}
                </option>
              ))}
            </select>
            {pieces.length && clipsOf(project).length > 1 ? <span className={`pill ${offTimeline ? 'warn' : ''}`} data-testid="source-clip" title={offTimeline ? 'This clip was removed from the timeline. Its footage and its edits are kept.' : 'The clip on the timeline that plays this footage'}>{offTimeline ? 'Off the timeline · ' : ''}{pieces[0]!.name}{pieces.length > 1 ? ` +${pieces.length - 1}` : ''}</span> : null}
            {offTimeline && isLead ? <Button size="sm" data-testid="source-put-back" onClick={() => useApp.getState().edit((_e, p) => pieces.filter((c) => c.removed).reduce((e, c) => putBackClip({ edit: e, duration: p.duration }, c.id), p.edit), 'Put clip back')}>Put back</Button> : null}
            {source.role === 'broll' && source.kind === 'video' && source.available && otherFootage ? <Button size="sm" data-testid="source-to-clip" title="Play this video on the timeline as a clip of its own, after what is already there" onClick={() => { const name = sourceToClip(source.id); if (name) useApp.getState().toast(`“${source.name}” is now ${name} on the timeline.`); }}>Add to the timeline</Button> : null}
            {pieces.length && isLead && source.origin === 'import' && takeOf(source) !== 'main' && otherFootage ? <Button size="sm" variant="ghost" data-testid="source-to-broll" title="Take this clip off the timeline and keep the video as B-roll. Edits made on the clip are dropped." onClick={() => (takeToBroll(takeOf(source)), useApp.getState().toast(`“${source.name}” is now B-roll.`))}>Use as B-roll</Button> : null}
            <Button variant="ghost" size="sm" icon="dots" aria-label={`More actions for ${source.name}`} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })} />
          </div>
        </div>
        <div className="row wrap tiny mono dim" style={{ gap: 10 }}>
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
          {source.kind !== 'image' && !source.hasAudio && source.kind === 'video' ? <span>no audio</span> : null}
        </div>
        {!source.available ? (
          <Banner tone="danger" title="This file is missing" action={<Button size="sm" icon="link" onClick={onRelink}>Relink…</Button>}>
            It was last seen at <span className="mono">{resolveSourcePath(projectPath, source.path)}</span>. Your edits are kept and return once the same file is located.
          </Banner>
        ) : null}
        {source.origin === 'import' && source.role === 'screen' ? (
          <div className="tiny dim row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <Icon name="info" size={12} style={{ marginTop: 2 }} />
            <span>Flattened file: cursor is part of the picture, so cursor smoothing and separate camera tracks are not available. Cuts, zooms, crop, captions and audio cleanup all work.</span>
          </div>
        ) : null}
        {source.note ? <div className="tiny dim">{source.note}</div> : null}
        {timeline && source.available ? (
          <>
            <CoverageStrip source={source} duration={project.duration} lead={isLead} />
            <div className="row between">
              {syncPill}
              {!isLead && sync.method !== 'recorded-clock' ? (
                sync.status === 'unsynced' ? (
                  <Button size="sm" onClick={() => (setSync(source.id, { ...REVIEW }), onSync())}>Bring into the edit…</Button>
                ) : (
                  <Button size="sm" variant={review ? 'primary' : 'default'} icon="sync" onClick={onSync}>{review ? 'Review sync' : 'Adjust sync'}</Button>
                )
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      {menu ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 290 }} onMouseDown={() => setMenu(null)}>
          <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 130) }} onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => (setMenu(null), void api().app.reveal(resolveSourcePath(projectPath, source.path)))}><Icon name="folder" size={13} /> Show in Finder</button>
            <button onClick={() => (setMenu(null), onRelink())}><Icon name="link" size={13} /> Point to another copy…</button>
            <div className="sep" />
            <button className="danger" onClick={() => (setMenu(null), remove())}><Icon name="x" size={13} /> Remove from project</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ───────────────────────────── audio ─────────────────────────────

function AudioPanel({ project }: { project: Project }) {
  const edit = useApp((s) => s.edit);
  const audible = project.sources.filter((s) => s.hasAudio);
  const voiceLike = (s: MediaSource) => ['voice', 'cameraA', 'cameraB', 'screen'].includes(s.role) && s.sync.status !== 'unsynced';
  const audio = project.edit.audio;
  if (audible.length === 0) {
    return (
      <section className="panel audio-panel">
        <div className="src-heading"><Icon name="mic" size={16} /> Voice</div>
        <div className="muted small">None of these files has sound. The edit will be built from what happens on screen, and no captions will be written.</div>
      </section>
    );
  }
  return (
    <section className="panel audio-panel">
      <div className="row between">
        <div className="src-heading"><Icon name="mic" size={16} /> Voice and audio</div>
        <span className="tiny dim">One voice plays in the edit. Camera scratch audio stays muted unless you turn it on.</span>
      </div>
      <div className="col" style={{ gap: 2 }} role="radiogroup" aria-label="Master voice">
        {audible.map((s) => {
          const track = audio.tracks[s.id] ?? { gain: 1, muted: true };
          const master = audio.masterVoiceId === s.id;
          const canMaster = voiceLike(s);
          return (
            <div key={s.id} className={`audio-row${master ? ' master' : ''}`}>
              <button className="radio" role="radio" aria-checked={master} disabled={!canMaster} title={canMaster ? 'Use as the voice of the edit' : 'Only a voice, camera or screen track can be the voice'} onClick={() => !master && edit((e, p) => setMasterVoice(e, p.sources, s.id), 'Choose voice track')} aria-label={`Use ${s.name} as the voice`} />
              <Icon name={ROLE[s.role].icon} size={14} style={{ color: 'var(--text-3)' }} />
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
                {master ? <span className="pill accent" style={{ marginLeft: 8 }}>Master voice</span> : canMaster && track.muted ? <span className="tiny dim" style={{ marginLeft: 8 }}>scratch audio · muted</span> : null}
              </span>
              <div style={{ width: 120 }}>
                <Slider value={track.gain} min={0} max={1.5} step={0.01} onChange={(v) => edit((e) => ({ ...e, audio: { ...e.audio, tracks: { ...e.audio.tracks, [s.id]: { ...track, gain: v } } } }), 'Change track level', `gain-${s.id}`)} />
              </div>
              <span className="tiny mono dim" style={{ width: 38, textAlign: 'right' }}>{Math.round(track.gain * 100)}%</span>
              <Button size="sm" variant="ghost" icon={track.muted ? 'eyeOff' : 'speaker'} on={!track.muted} disabled={master} title={master ? 'The master voice is always heard' : track.muted ? 'Muted. Click to hear this track in the edit too.' : 'Audible. Click to mute.'} aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${s.name}`} onClick={() => edit((e) => ({ ...e, audio: { ...e.audio, tracks: { ...e.audio.tracks, [s.id]: { ...track, muted: !track.muted } } } }), track.muted ? 'Unmute track' : 'Mute track')} />
            </div>
          );
        })}
      </div>
      <hr className="hr" />
      <div className="row" style={{ gap: 28, alignItems: 'flex-start' }}>
        <div className="grow">
          <Toggle checked={audio.voiceCleanup.enabled} onChange={(v) => edit((e) => ({ ...e, audio: { ...e.audio, voiceCleanup: { ...e.audio.voiceCleanup, enabled: v } } }), 'Toggle voice cleanup')} label="Voice cleanup" hint="A gentle rumble filter and noise gate on the master voice. The original recording is never changed." />
        </div>
        <div className="grow">
          <Toggle checked={audio.voiceCleanup.bypass} onChange={(v) => edit((e) => ({ ...e, audio: { ...e.audio, voiceCleanup: { ...e.audio.voiceCleanup, bypass: v } } }), 'Toggle cleanup bypass')} label="Bypass to compare" hint={audio.voiceCleanup.enabled ? 'Hear the untouched voice without changing the setting.' : 'Cleanup is off.'} />
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────── inspection report ─────────────────────────────

function guidance(p: ProbeResult): string {
  switch (p.error?.code) {
    case 'corrupt':
      return 'The file is damaged or incomplete. Re-export it from the app that made it, or convert it to MP4/MOV (H.264) and re-import.';
    case 'unsupported-codec':
      return 'Convert to MP4/MOV (H.264) and re-import. Audio works as WAV or M4A; images as JPG or PNG.';
    case 'protected':
      return 'This file is copy-protected and cannot be edited.';
    case 'not-found':
      return 'The file was not there any more. Check the drive is connected and try again.';
    case 'disk-full':
      return 'There was not enough room to copy it into the project. Free some space, or import by reference in Settings.';
    default:
      return 'Convert to MP4/MOV (H.264) and re-import.';
  }
}

function Inspection() {
  const projectPath = useApp((s) => s.projectPath);
  const entry = useSyncExternalStore(subscribeImportReport, getImportReport);
  if (!entry || entry.projectPath !== projectPath) return null;
  const { accepted, rejected } = entry.report;
  if (accepted.length === 0 && rejected.length === 0) return null;
  return (
    <section className={`panel inspection${rejected.length ? ' has-rejects' : ''}`} aria-live="polite">
      <div className="row between">
        <div className="row" style={{ gap: 8 }}>
          <Icon name={rejected.length ? 'warn' : 'check'} size={15} style={{ color: rejected.length ? '#ffc452' : 'var(--ok)' }} />
          <b>
            Inspected {accepted.length + rejected.length} file{accepted.length + rejected.length === 1 ? '' : 's'}: {accepted.length} added{rejected.length ? `, ${rejected.length} could not be used` : ''}
          </b>
        </div>
        <Button size="sm" variant="ghost" icon="x" onClick={clearImportReport} aria-label="Dismiss inspection" />
      </div>
      {accepted.length ? (
        <div className="row wrap" style={{ gap: 6 }}>
          {accepted.map(({ probe, source, clip }) => (
            <span key={source.id} className="pill ok" title={probe.path}>
              <Icon name={ROLE[source.role].icon} size={10} />
              {source.name} → {clip ? `${clip} on the timeline` : ROLE[source.role].label}
            </span>
          ))}
          <span className="tiny dim">Roles are suggestions. Change them below.</span>
        </div>
      ) : null}
      {rejected.map((p) => (
        <div key={p.path} className="reject">
          <Icon name="x" size={13} style={{ color: 'var(--danger)', marginTop: 2 }} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{p.path.split('/').pop()}</div>
            <div className="small muted">{p.error?.message ?? 'This file could not be read.'}</div>
            <div className="tiny dim">{guidance(p)}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

// ───────────────────────────── screen ─────────────────────────────

export function Sources() {
  const project = useProject();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [relinking, setRelinking] = useState<RelinkState>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const lead = useMemo(() => leadOf(project.sources), [project.sources]);

  // Imports that arrived from elsewhere may need their sync state made honest.
  useEffect(() => {
    const next = normaliseSync(project.sources);
    if (next !== project.sources) patchSources(() => next);
  }, [project.sources]);

  const add = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    setImporting(true);
    try {
      recordImportReport(await importFiles(paths));
    } finally {
      setImporting(false);
    }
  }, []);

  // a second placement of a file (a clip split and moved apart) is not a file of its own
  const records = project.sources.filter((s) => !s.instanceOf);
  const timeline = records.filter(isTimeline);
  const other = records.filter((s) => !isTimeline(s));
  const pending = records.filter((s) => s.available && needsReview(s, groupLead(records, s)));
  const leadUsable = !!lead && lead.available;
  const missing = records.filter((s) => !s.available);

  const proceed = () => useApp.getState().setView('brief');
  const proceedWithout = () => {
    patchSources((ss) => ss.map((s) => (pending.some((p) => p.id === s.id) ? { ...s, sync: { ...REVIEW, status: 'unsynced' } } : s)));
    proceed();
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      data-testid="import-input"
      onChange={(e) => {
        const paths = filePaths(e.target.files);
        e.target.value = '';
        void add(paths);
      }}
    />
  );

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => (e.preventDefault(), setDragging(true)),
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragLeave: (e: React.DragEvent) => e.currentTarget === e.target && setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void add(droppedPaths(e));
    },
  };

  if (project.sources.length === 0) {
    return (
      <div className={`page sources${dragging ? ' dragging' : ''}`} {...dropProps}>
        {fileInput}
        <div className="page-inner" style={{ maxWidth: 760 }}>
          <h1 className="src-title">Sources</h1>
          <p className="muted" style={{ margin: '4px 0 16px' }}>This project has no footage yet.</p>
          <Inspection />
          <div className="panel" style={{ marginTop: 14 }}>
            <Empty
              icon="film"
              title="Add footage to begin"
              action={
                <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <Button variant="primary" icon="record" onClick={() => useApp.getState().go('record')}>Record</Button>
                  <Button icon="import" busy={importing} onClick={() => input.current?.click()}>Import files…</Button>
                </div>
              }
            >
              Record your screen and cameras, or drop MP4 or MOV video, WAV or M4A audio, and JPG or PNG images here. Every file is inspected before anything is edited, and your originals are never changed.
            </Empty>
          </div>
        </div>
        {dragging ? <DropVeil /> : null}
      </div>
    );
  }

  return (
    <div className={`page sources${dragging ? ' dragging' : ''}`} {...dropProps}>
      {fileInput}
      <div className="sources-scroll">
        <div className="page-inner">
          <div className="row between" style={{ alignItems: 'flex-end', marginBottom: 20 }}>
            <div>
              <h1 className="src-title">Sources</h1>
              <div className="muted" style={{ maxWidth: 600, marginTop: 4 }}>Check each file’s role, line up anything recorded on another device, and choose the voice the edit uses. Originals are never modified.</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <span className="tiny dim mono">Timeline {fmtTime(project.duration, true)}</span>
              <Button icon="record" data-testid="record-clip" title="Record another take into this project. It is added to the timeline as a new clip, after what is already there." onClick={() => useApp.getState().go('record')}>Record a clip</Button>
              <Button icon="import" busy={importing} onClick={() => input.current?.click()}>Add media…</Button>
            </div>
          </div>

          <div className="col" style={{ gap: 14 }}>
            <Inspection />
            {!leadUsable && missing.length === 0 ? (
              <Banner tone="warn" title="No usable picture on the timeline">Give one file the Screen or Camera A role, or bring a left-out file back into the edit.</Banner>
            ) : null}

            {timeline.length ? (
              <section className="col" style={{ gap: 8 }}>
                <div className="src-heading"><Icon name="film" size={16} /> On the timeline <span className="dim">{timeline.length}</span></div>
                {timeline.map((s) => (
                  <SourceRow key={s.id} source={s} project={project} lead={groupLead(records, s)} onSync={() => setSyncing(s.id)} onRelink={() => void relink(s, setRelinking)} />
                ))}
              </section>
            ) : null}

            {other.length ? (
              <section className="col" style={{ gap: 8 }}>
                <div className="src-heading"><Icon name="broll" size={16} /> Supporting media <span className="dim">{other.length}</span></div>
                {other.map((s) => (
                  <SourceRow key={s.id} source={s} project={project} lead={lead} onSync={() => setSyncing(s.id)} onRelink={() => void relink(s, setRelinking)} />
                ))}
              </section>
            ) : null}

            <AudioPanel project={project} />
          </div>
        </div>
      </div>

      <footer className="sources-bar">
        <div className="grow small">
          {!leadUsable ? (
            <span style={{ color: '#ffc452' }}><Icon name="warn" size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{missing.length ? 'A source file is missing. Relink it to continue.' : 'There is no usable screen or camera on the timeline.'}</span>
          ) : pending.length ? (
            <span style={{ color: '#ffc452' }}><Icon name="warn" size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{pending.length === 1 ? `“${pending[0]!.name}” has not been lined up with the timeline yet.` : `${pending.length} files have not been lined up with the timeline yet.`}</span>
          ) : (
            <span className="muted"><Icon name="check" size={13} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--ok)' }} />{timeline.length} timeline source{timeline.length === 1 ? '' : 's'} ready{project.edit.audio.masterVoiceId ? ', one master voice' : ', no voice track'}.</span>
          )}
        </div>
        {leadUsable && pending.length ? (
          <>
            <Button size="lg" variant="ghost" onClick={proceedWithout} title="Leave the unaligned files out of the edit. You can bring them back later.">Continue without {pending.length === 1 ? 'it' : 'them'}</Button>
            <Button size="lg" variant="primary" icon="sync" onClick={() => setSyncing(pending[0]!.id)}>Review sync</Button>
          </>
        ) : (
          <Button size="lg" variant="primary" disabled={!leadUsable} onClick={proceed} title={leadUsable ? undefined : 'Add or relink a screen or camera first'}>
            Continue <Icon name="chevron" size={15} />
          </Button>
        )}
      </footer>

      {syncing ? <SyncWorkbench sourceId={syncing} onClose={() => setSyncing(null)} /> : null}
      {relinking ? (
        <Modal
          eyebrow="Relink"
          title={relinking.match === 'likely' ? 'This looks like a different copy' : 'That is not the same media'}
          onClose={() => setRelinking(null)}
          footer={
            relinking.match === 'likely' ? (
              <>
                <Button onClick={() => setRelinking(null)}>Cancel</Button>
                <Button variant="primary" icon="link" onClick={() => (applyRelink(relinking.source, relinking.probe, true), setRelinking(null), useApp.getState().toast(`Relinked “${relinking.source.name}” to the new copy.`))}>Use this copy</Button>
              </>
            ) : (
              <>
                <Button onClick={() => setRelinking(null)}>Close</Button>
                <Button variant="primary" onClick={() => { const s = relinking.source; setRelinking(null); void relink(s, setRelinking); }}>Choose another file…</Button>
              </>
            )
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>{relinking.detail}</p>
          <p className="small dim mono" style={{ wordBreak: 'break-all' }}>{relinking.probe.path}</p>
          {relinking.match === 'different' ? <p className="muted">Nothing was changed. The original stays linked as missing until the matching file is found.</p> : <p className="muted">If it is a re-encoded copy of the same recording your edits will still line up. Neither file is moved or deleted.</p>}
        </Modal>
      ) : null}
      {dragging ? <DropVeil /> : null}
    </div>
  );
}

function DropVeil() {
  return (
    <div className="drop-veil">
      <div className="drop-card">
        <Icon name="import" size={26} />
        <div className="drop-title">Drop to add to this project</div>
        <div className="muted">Each file is inspected before it is used.</div>
      </div>
    </div>
  );
}
