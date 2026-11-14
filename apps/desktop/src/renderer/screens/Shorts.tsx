import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SHORT_CAPTION_LOOKS,
  SHORT_FRAMINGS,
  SHORT_SAFE,
  cameraSourceAt,
  defaultShortCaptions,
  effectiveFraming,
  fmtTime,
  newShort,
  nudgeShortRange,
  shortDuration,
  shortFramings,
  shortProject,
  shortSources,
  shortsOf,
  type Cue,
  type Project,
  type Range,
  type Short,
  type ShortCaptionPreset,
  type ShortCaptions,
  type ShortFraming,
} from '@cutaway/core';
import { Preview } from '../engine/Preview';
import { drawShortCaption, shortCaptionFont } from '../engine/shortCaption';
import { facesKey, useData } from '../engine/parityData';
import { useExportJob } from '../engine/packageExport';
import { timeMapOf, useApp, usePlayback } from '../state/store';
import { consentCovers, grantConsent, useAiInfo } from '../state/jobs';
import { cancelFindShorts, cancelShortExport, deleteShort, dismissCandidate, exportShort, keepCandidate, makeShortFromRange, patchShort, runFindShorts, useShorts } from '../state/shorts';
import type { DisclosureScope } from '@cutaway/ai';
import { ConsentSheet } from '../ui/Consent';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Segmented, Slider } from '../ui/kit';
import './shorts.css';

/** Finding shorts reads text only: the transcript and where the edit cut. No stills, no media. */
const TEXT_SCOPE: DisclosureScope[] = ['transcript', 'edit-metadata'];

type Chosen = { kind: 'short'; id: string } | { kind: 'found'; key: string } | null;

const secs = (n: number) => (n >= 60 ? fmtTime(n) : `${Math.round(n)} s`);

/** Where a session range sits in the finished long video. */
function longStamp(project: Project, r: Range): string {
  const map = timeMapOf(project);
  return `${fmtTime(map.toOutput(r.start))} – ${fmtTime(map.toOutput(r.end))}`;
}

const FRAMING_ICON: Record<ShortFraming, IconName> = { face: 'user', stack: 'split', screen: 'screen', original: 'layout' };

/** A tiny picture of what each framing does to the frame. */
function FramingGlyph({ framing }: { framing: ShortFraming }) {
  return (
    <span className={`sh-glyph sh-glyph-${framing}`} aria-hidden>
      <i />
      <i />
    </span>
  );
}

const SAMPLE: Cue = {
  index: 1,
  start: 0,
  end: 2,
  text: 'Watch this part',
  wordIds: [],
  words: [
    { text: 'Watch', start: 0, end: 0.3 },
    { text: 'this', start: 0.3, end: 0.7 },
    { text: 'part', start: 0.7, end: 1.2 },
  ],
};

/** A caption style shown in its own letters, drawn by the same code as the video. */
function CaptionChip({ preset, active, onClick }: { preset: ShortCaptionPreset; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const look = SHORT_CAPTION_LOOKS.find((l) => l.id === preset)!;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let live = true;
    const paint = () => {
      if (!live) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = 148;
      const h = 64;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#2b3350');
      g.addColorStop(1, '#141722');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // Drawn as on a phone as wide as the tile; the tile shows the band the line sits in.
      const phone = { W: w, H: (w * 16) / 9 };
      ctx.save();
      ctx.translate(0, h / 2 - SHORT_SAFE.y.middle * phone.H);
      drawShortCaption(ctx, SAMPLE, 0.5, { preset, position: 'middle', size: 1.3 }, phone.W, phone.H);
      ctx.restore();
    };
    paint();
    void document.fonts.load(shortCaptionFont({ preset, position: 'middle', size: 1 })).then(paint, () => undefined);
    return () => {
      live = false;
    };
  }, [preset]);
  return (
    <button type="button" className="sh-cap" aria-pressed={active} onClick={onClick} title={look.hint} data-testid={`short-cap-${preset}`}>
      <canvas ref={ref} style={{ width: 148, height: 64 }} aria-hidden />
      <span>{look.name}</span>
    </button>
  );
}

function OriginPill({ origin, provider }: { origin: Short['origin']; provider?: 'claude' | 'codex' }) {
  if (origin === 'ai') return <span className="pill ai">{provider === 'codex' ? 'Codex' : 'Claude'}</span>;
  if (origin === 'rules') return <span className="pill">Built-in rules</span>;
  return <span className="pill you">You</span>;
}

/** Whether the camera is being followed, said plainly. */
function FaceNote({ project, short }: { project: Project; short: Short }) {
  const projectPath = useApp((s) => s.projectPath)!;
  const who = shortSources(project, short);
  const cam = who.camera ? cameraSourceAt(project, who.camera, (short.start + short.end) / 2) : undefined;
  const entry = useData<unknown>(cam ? facesKey(projectPath, cam) : null);
  const framing = effectiveFraming(project, short);
  if (!cam || (framing !== 'face' && framing !== 'stack')) return null;
  const text =
    entry.status === 'ready'
      ? 'Following your face, with room above your head.'
      : entry.status === 'computing'
        ? 'Finding your face in the camera recording, on this Mac…'
        : entry.status === 'failed'
          ? 'No face was found in the camera recording, so the middle of the picture is used.'
          : 'Your face is found on this Mac the first time the short plays.';
  return (
    <div className="tiny dim row" style={{ gap: 6, alignItems: 'flex-start' }} data-testid="short-face-note">
      <Icon name="user" size={12} style={{ marginTop: 2 }} /> <span>{text}</span>
    </div>
  );
}

export function Shorts() {
  const project = useApp((s) => s.project)!;
  const settings = useApp((s) => s.settings);
  const claude = useApp((s) => s.claude);
  const ai = useAiInfo();
  const ui = useShorts();
  const job = useExportJob((s) => s.job);
  const time = usePlayback((s) => s.time);
  const playing = usePlayback((s) => s.playing);
  const saved = shortsOf(project);
  const [pick, setPick] = useState<Chosen>(saved[0] ? { kind: 'short', id: saved[0].id } : null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [guides, setGuides] = useState(false);
  const map = timeMapOf(project);

  // The playhead belongs to the long video; this screen borrows the player and gives it back.
  useEffect(() => {
    const before = usePlayback.getState().time;
    usePlayback.getState().reset(0);
    return () => {
      usePlayback.getState().reset(before);
      useApp.getState().patch((p) => (p.ui.playhead === before ? p : { ...p, ui: { ...p.ui, playhead: before } }));
    };
  }, []);

  // Keep the selection on something that exists.
  useEffect(() => {
    const ok = pick && (pick.kind === 'short' ? saved.some((s) => s.id === pick.id) : ui.found.some((c) => c.key === pick.key));
    if (ok) return;
    setPick(ui.found[0] ? { kind: 'found', key: ui.found[0].key } : saved[0] ? { kind: 'short', id: saved[0].id } : null);
  }, [pick, saved, ui.found]);

  const pickedKey = pick ? (pick.kind === 'short' ? pick.id : pick.key) : null;
  useEffect(() => {
    usePlayback.getState().reset(0);
  }, [pickedKey]);

  const short: Short | null = useMemo(() => {
    if (!pick) return null;
    if (pick.kind === 'short') return saved.find((s) => s.id === pick.id) ?? null;
    const cand = ui.found.find((c) => c.key === pick.key);
    return cand ? { ...newShort(project, cand, cand.origin, cand.provider), id: `found-${cand.key}`, createdAt: '' } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, project.shorts, ui.found, project.sources, project.edit]);
  const derived = useMemo(() => (short ? shortProject(project, short) : null), [project, short]);
  const length = short ? shortDuration(project, short) : 0;
  const isSaved = pick?.kind === 'short';

  const find = async () => {
    let status = useApp.getState().claude;
    try {
      status = await window.cutaway.ai.status();
      useApp.setState({ claude: status });
    } catch {
      /* treated as unavailable below */
    }
    if (!(status?.found && status.signedIn === true)) return void runFindShorts(false);
    if (consentCovers(useApp.getState().project, TEXT_SCOPE)) return void runFindShorts(true);
    setConsentOpen(true);
  };

  const keep = (key: string) => {
    const id = keepCandidate(key);
    if (id) setPick({ kind: 'short', id });
  };
  const keepAll = () => {
    let last: string | null = null;
    for (const c of [...useShorts.getState().found]) last = keepCandidate(c.key) ?? last;
    if (last) setPick({ kind: 'short', id: last });
  };

  const byHand = () => {
    const app = useApp.getState();
    const sel = app.selection;
    const range: Range =
      sel && (sel.kind === 'range' || sel.kind === 'words')
        ? sel.range
        : (() => {
            const start = map.toSource(Math.min(Math.max(0, map.outDuration - 20), project.ui.playhead));
            return { start, end: map.toSource(Math.min(map.outDuration, map.toOutput(start) + 30)) };
          })();
    const made = makeShortFromRange(range);
    if ('error' in made) return app.toast(made.error, 'error');
    setPick({ kind: 'short', id: made.id });
    if (made.notes.length) app.toast(made.notes.join(' '));
  };

  const nudge = (edge: 'start' | 'end', dir: -1 | 1) => {
    if (!short || !isSaved) return;
    const r = nudgeShortRange(project, short, edge, dir);
    if (!r.ok) return useApp.getState().toast(r.reason);
    patchShort(short.id, { start: r.range.start, end: r.range.end });
  };

  const exportOne = async (id: string) => {
    const dest = settings?.exportDir;
    if (!dest) return useApp.getState().toast('Choose an export folder on the Export screen first.', 'error');
    usePlayback.getState().setPlaying(false);
    await exportShort(id, dest);
  };
  /** One after another; stops at the first that is cancelled or fails. */
  const exportAll = async () => {
    const dest = settings?.exportDir;
    if (!dest) return useApp.getState().toast('Choose an export folder on the Export screen first.', 'error');
    usePlayback.getState().setPlaying(false);
    for (const s of shortsOf(useApp.getState().project!)) {
      const r = await exportShort(s.id, dest);
      if (!r || r.status !== 'complete') break;
    }
  };

  const signedIn = !!claude?.found && claude.signedIn === true;
  const finding = ui.status === 'finding';
  const exporting = ui.exporting;
  const render = exporting && job?.status === 'running' ? job : null;
  const framings = short ? shortFramings(project, short) : [];
  const captions: ShortCaptions = short?.captions ?? defaultShortCaptions('face');
  const noSpeech = !project.transcript?.hasSpeech;

  const consent = consentOpen ? (
    <ConsentSheet
      purpose="finding shorts"
      scope={TEXT_SCOPE}
      onAllow={() => {
        setConsentOpen(false);
        grantConsent(TEXT_SCOPE);
        void runFindShorts(true);
      }}
      onDecline={() => (setConsentOpen(false), void runFindShorts(false))}
      onClose={() => setConsentOpen(false)}
    />
  ) : null;

  const findRow = (
    <div className="sh-find">
      <Button variant="primary" icon="sparkle" busy={finding} disabled={finding || map.outDuration < 3} onClick={() => void find()} data-testid="shorts-find">
        {saved.length || ui.found.length ? 'Find more' : 'Find shorts'}
      </Button>
      {finding ? (
        <Button onClick={cancelFindShorts}>Cancel</Button>
      ) : (
        <>
          {signedIn ? (
            <Button onClick={() => void runFindShorts(false)} title="Nothing leaves this Mac" data-testid="shorts-find-rules">
              Rules only
            </Button>
          ) : null}
          <Button icon="scissors" onClick={byHand} title="From the range selected in the editor, or 30 seconds from the playhead" data-testid="shorts-by-hand">
            By hand
          </Button>
        </>
      )}
    </div>
  );

  if (saved.length === 0 && ui.found.length === 0) {
    return (
      <div className="sh-screen sh-empty" data-testid="shorts-screen">
        <div className="sh-empty-card">
          <div className="sh-empty-art" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="sh-ghost" style={{ animationDelay: `${i * 140}ms` }}>
                <span />
                <span />
              </div>
            ))}
          </div>
          <h2>Shorts from this video</h2>
          <p className="muted">
            Pick the strongest 30 to 60 seconds of your {fmtTime(map.outDuration)} cut, reframe them upright around you, and burn in captions that follow your voice. Each short plays through the cuts you already made; the long video is never changed.
          </p>
          {ui.status === 'failed' ? (
            <Banner tone="danger" title="Finding shorts did not work">
              {ui.error} Nothing was changed.
            </Banner>
          ) : null}
          {ui.note ? <Banner tone="info">{ui.note}</Banner> : null}
          {noSpeech ? (
            <Banner tone="warn" title="No transcript yet">
              Sentences and captions come from the transcript, which is made with the first cut. Without it a short is a plain stretch of time with no captions.
            </Banner>
          ) : null}
          {findRow}
          <span className="tiny dim" style={{ maxWidth: 520 }}>
            {signedIn
              ? `With your permission, ${ai.name} reads the transcript text and where you cut (sent to ${ai.company}). No pictures, video or audio are sent. "Rules only" keeps everything on this Mac.`
              : `${ai.app} is not signed in on this Mac, so Cutaway's own rules pick the moments here and nothing is sent anywhere.`}
          </span>
        </div>
        {consent}
      </div>
    );
  }

  return (
    <div className="sh-screen" data-testid="shorts-screen">
      <aside className="sh-list">
        <div className="sh-list-head">
          <div className="eyebrow">Shorts</div>
          {findRow}
          {ui.status === 'failed' ? <Banner tone="danger">{ui.error}</Banner> : null}
          {ui.note ? <div className="tiny dim" data-testid="shorts-note">{ui.note}</div> : null}
        </div>
        <div className="sh-scroll">
          {ui.found.length ? (
            <>
              <div className="sh-group row between">
                <span>Proposed</span>
                <button type="button" className="sh-link" onClick={keepAll} data-testid="shorts-keep-all">
                  Keep all
                </button>
              </div>
              {ui.found.map((c) => (
                <div key={c.key} className="sh-card" role="button" tabIndex={0} aria-current={pick?.kind === 'found' && pick.key === c.key} onClick={() => setPick({ kind: 'found', key: c.key })} onKeyDown={(e) => e.key === 'Enter' && setPick({ kind: 'found', key: c.key })} data-testid="short-candidate">
                  <div className="row between" style={{ gap: 8 }}>
                    <OriginPill origin={c.origin} provider={c.provider} />
                    <span className="tiny dim">
                      {secs(c.duration)} · {longStamp(project, c)}
                    </span>
                  </div>
                  <div className="sh-title">{c.title}</div>
                  {c.hook ? <div className="sh-hook">“{c.hook}”</div> : null}
                  <div className="tiny muted">{c.reason}</div>
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" variant="primary" icon="check" onClick={(e) => (e.stopPropagation(), keep(c.key))} data-testid="short-keep">
                      Keep
                    </Button>
                    <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), dismissCandidate(c.key))}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))}
            </>
          ) : null}
          {saved.length ? (
            <>
              <div className="sh-group row between">
                <span>Your shorts</span>
                {saved.length > 1 ? (
                  <button type="button" className="sh-link" disabled={!!exporting} onClick={() => void exportAll()}>
                    Export all
                  </button>
                ) : null}
              </div>
              {saved.map((s) => {
                const res = ui.results[s.id];
                return (
                  <div key={s.id} className="sh-card" role="button" tabIndex={0} aria-current={pick?.kind === 'short' && pick.id === s.id} onClick={() => setPick({ kind: 'short', id: s.id })} onKeyDown={(e) => e.key === 'Enter' && setPick({ kind: 'short', id: s.id })} data-testid="short-saved">
                    <div className="row between" style={{ gap: 8 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <OriginPill origin={s.origin} provider={s.provider} />
                        <span className="pill">
                          <Icon name={FRAMING_ICON[effectiveFraming(project, s)]} size={11} /> {SHORT_FRAMINGS.find((f) => f.id === effectiveFraming(project, s))!.name}
                        </span>
                      </span>
                      <span className="tiny dim">{secs(shortDuration(project, s))}</span>
                    </div>
                    <div className="sh-title">{s.title}</div>
                    <div className="tiny dim">{longStamp(project, s)} in the long video</div>
                    {exporting === s.id ? (
                      <div className="tiny" style={{ color: 'var(--accent-2)' }}>Exporting…</div>
                    ) : res ? (
                      <div className="tiny" style={{ color: res.status === 'complete' ? 'var(--ok)' : res.status === 'failed' ? 'var(--danger)' : 'var(--text-3)' }}>{res.message}</div>
                    ) : s.exported ? (
                      <div className="tiny dim">Exported {s.exported.revision === project.revision ? '' : '(before your latest edits)'}</div>
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : null}
        </div>
      </aside>

      <section className="sh-stage">
        {derived && short ? (
          <>
            <div className={`sh-phone sh-${short.shape}`} data-testid="short-preview">
              <Preview project={derived} />
              {guides ? (
                <div className="sh-guides" aria-hidden>
                  <div className="sh-guide-top" style={{ height: `${SHORT_SAFE.top * 100}%` }} />
                  <div className="sh-guide-bottom" style={{ height: `${SHORT_SAFE.bottom * 100}%` }}>
                    <span>The apps put their own text and buttons here</span>
                  </div>
                  <div className="sh-guide-side" />
                </div>
              ) : null}
            </div>
            <div className="sh-transport">
              <button type="button" className="tbtn" onClick={() => usePlayback.getState().toggle()} aria-label={playing ? 'Pause' : 'Play'} data-testid="short-play">
                <Icon name={playing ? 'pause' : 'play'} size={18} />
              </button>
              <input className="sh-scrub" type="range" min={0} max={Math.max(0.1, length)} step={0.01} value={Math.min(time, length)} onChange={(e) => usePlayback.getState().seek(Number(e.target.value))} aria-label="Position in the short" />
              <span className="timecode">
                {fmtTime(Math.min(time, length))} / {fmtTime(length)}
              </span>
              <button type="button" className={`tbtn ${guides ? 'on' : ''}`} onClick={() => setGuides((g) => !g)} title="Show where the short-video apps cover the picture" aria-pressed={guides}>
                <Icon name="phone" size={16} />
              </button>
            </div>
          </>
        ) : (
          <div className="muted">Choose a short on the left.</div>
        )}
      </section>

      <aside className="sh-side">
        {short ? (
          <div className="sh-scroll col" style={{ gap: 18 }}>
            {!isSaved ? (
              <Banner tone="info" title="A proposal, not yet yours" action={<Button size="sm" variant="primary" icon="check" onClick={() => keep((pick as { key: string }).key)}>Keep</Button>}>
                Keep it to change its framing, captions and range, and to export it.
              </Banner>
            ) : null}
            <div className="col" style={{ gap: 6 }}>
              <label className="eyebrow" htmlFor="short-title">Title</label>
              <input id="short-title" className="input" value={short.title} disabled={!isSaved} maxLength={100} onChange={(e) => patchShort(short.id, { title: e.target.value })} data-testid="short-title" />
              {short.reason ? <div className="tiny muted">{short.reason}</div> : null}
            </div>

            <div className="col" style={{ gap: 8 }}>
              <div className="eyebrow">Range</div>
              <div className="sh-range">
                <div>
                  <div className="tiny dim">Starts</div>
                  <div className="sh-range-row">
                    <button type="button" className="tbtn" disabled={!isSaved} onClick={() => nudge('start', -1)} title="Start one sentence earlier" data-testid="short-start-earlier"><Icon name="minus" size={14} /></button>
                    <span>{fmtTime(map.toOutput(short.start))}</span>
                    <button type="button" className="tbtn" disabled={!isSaved} onClick={() => nudge('start', 1)} title="Start one sentence later"><Icon name="plus" size={14} /></button>
                  </div>
                </div>
                <div>
                  <div className="tiny dim">Ends</div>
                  <div className="sh-range-row">
                    <button type="button" className="tbtn" disabled={!isSaved} onClick={() => nudge('end', -1)} title="End one sentence earlier" data-testid="short-end-earlier"><Icon name="minus" size={14} /></button>
                    <span>{fmtTime(map.toOutput(short.end))}</span>
                    <button type="button" className="tbtn" disabled={!isSaved} onClick={() => nudge('end', 1)} title="End one sentence later" data-testid="short-end-later"><Icon name="plus" size={14} /></button>
                  </div>
                </div>
              </div>
              <div className="tiny dim" data-testid="short-length">
                {secs(length)} long. Moves a whole sentence at a time, and plays through the cuts of the long video.
                {length > 60 ? ' Most apps cap a short at 60 seconds.' : ''}
              </div>
              {length < 1 ? <Banner tone="warn">Almost all of this range has been cut from the long video since the short was made.</Banner> : null}
            </div>

            <div className="col" style={{ gap: 8 }}>
              <div className="eyebrow">Frame</div>
              <Segmented label="Shape" full value={short.shape} onChange={(v) => isSaved && patchShort(short.id, { shape: v })} options={[{ value: 'vertical', label: 'Vertical 9:16' }, { value: 'square', label: 'Square 1:1' }]} />
              <div className="sh-framings">
                {SHORT_FRAMINGS.filter((f) => framings.includes(f.id)).map((f) => (
                  <button key={f.id} type="button" className="sh-framing" disabled={!isSaved} aria-pressed={effectiveFraming(project, short) === f.id} onClick={() => patchShort(short.id, { framing: f.id, captions: { ...short.captions, position: short.captions.position === defaultShortCaptions(short.framing).position ? defaultShortCaptions(f.id).position : short.captions.position } })} title={f.hint} data-testid={`short-framing-${f.id}`}>
                    <FramingGlyph framing={f.id} />
                    <span>{f.name}</span>
                  </button>
                ))}
              </div>
              <div className="tiny dim">{SHORT_FRAMINGS.find((f) => f.id === effectiveFraming(project, short))!.hint}</div>
              <FaceNote project={project} short={short} />
            </div>

            <div className="col" style={{ gap: 8 }}>
              <div className="eyebrow">Captions</div>
              <div className="sh-caps">
                {SHORT_CAPTION_LOOKS.map((l) => (
                  <CaptionChip key={l.id} preset={l.id} active={captions.preset === l.id} onClick={() => isSaved && patchShort(short.id, { captions: { ...captions, preset: l.id } })} />
                ))}
                <button type="button" className="sh-cap sh-cap-off" aria-pressed={captions.preset === 'off'} onClick={() => isSaved && patchShort(short.id, { captions: { ...captions, preset: 'off' } })} data-testid="short-cap-off">
                  <span className="sh-cap-none"><Icon name="eyeOff" size={16} /></span>
                  <span>No captions</span>
                </button>
              </div>
              {captions.preset !== 'off' ? (
                <>
                  <Segmented label="Where" full value={captions.position} onChange={(v) => isSaved && patchShort(short.id, { captions: { ...captions, position: v } })} options={[{ value: 'high', label: 'High' }, { value: 'middle', label: 'Middle' }, { value: 'low', label: 'Low' }]} />
                  <Slider label="Size" min={0.7} max={1.4} step={0.05} value={captions.size} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => isSaved && patchShort(short.id, { captions: { ...captions, size: v } })} />
                  {noSpeech ? <div className="tiny dim">There is no transcript, so there is nothing to caption.</div> : null}
                </>
              ) : null}
            </div>

            {isSaved ? (
              <div className="col sh-export" style={{ gap: 10 }}>
                {render ? (
                  <>
                    <div className="sh-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={render.render && render.render.totalFrames ? Math.round((render.render.frames / render.render.totalFrames) * 100) : undefined}>
                      <i style={{ width: `${render.render && render.render.totalFrames ? (render.render.frames / render.render.totalFrames) * 100 : 4}%` }} />
                    </div>
                    <div className="row between">
                      <span className="tiny dim">{render.detail}</span>
                      <Button size="sm" onClick={cancelShortExport} data-testid="short-export-cancel">Cancel</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Button variant="primary" size="lg" icon="upload" disabled={!!exporting || job?.status === 'running' || length < 1} onClick={() => void exportOne(short.id)} data-testid="short-export">
                      Export this short
                    </Button>
                    {ui.results[short.id] ? (
                      <div className="row between" data-testid="short-export-result">
                        <span className="tiny" style={{ color: ui.results[short.id]!.status === 'complete' ? 'var(--ok)' : ui.results[short.id]!.status === 'failed' ? 'var(--danger)' : 'var(--text-3)' }}>{ui.results[short.id]!.message}</span>
                        {ui.results[short.id]!.path ? (
                          <Button size="sm" variant="ghost" icon="folder" onClick={() => void window.cutaway.app.reveal(ui.results[short.id]!.path!)}>Show</Button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="tiny dim">
                      {short.shape === 'square' ? '1080 × 1080' : '1080 × 1920'} MP4 into {settings?.exportDir ? settings.exportDir.replace(/^\/Users\/[^/]+/, '~') : 'your export folder'}. Nothing is uploaded.
                    </div>
                  </>
                )}
                <Button variant="ghost" icon="trash" disabled={!!exporting} onClick={() => deleteShort(short.id)} data-testid="short-delete">
                  Remove this short
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>
      {consent}
    </div>
  );
}
