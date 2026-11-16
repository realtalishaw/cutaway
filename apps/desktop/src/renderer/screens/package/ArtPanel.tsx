import { useEffect, useRef, useState } from 'react';
import type { GeneratedArt, PackagingConcept } from '@cutaway/core';
import { applyWholeThumbnail, artAllowed, artInUse, findArtSource, generateThumbnail, isWholeThumbnail, withArt, withoutArt, withoutWholeThumbnail } from '../../jobs/imagegen';
import { thumbnailFormat } from '@cutaway/ai';
import { LogoPicker } from './LogoPicker';
import { PhotoPicker } from './PhotoPicker';
import { openSettingsAt } from '../Settings';
import { FalArtConsent } from './FalArtConsent';
import { useApp } from '../../state/store';
import { ConsentSheet } from '../../ui/Consent';
import { Icon } from '../../ui/icons';
import { Banner, Button } from '../../ui/kit';

type Run = { status: 'idle' } | { status: 'running'; startedAt: number; abort: AbortController } | { status: 'failed'; message: string } | { status: 'note'; message: string };

function setConcept(conceptId: string, fn: (c: PackagingConcept) => PackagingConcept, label: string, undoable = true) {
  const app = useApp.getState();
  const apply = (concepts: PackagingConcept[]) => concepts.map((c) => (c.id === conceptId ? fn(c) : c));
  if (undoable) app.pack((p) => ({ ...p, concepts: apply(p.concepts) }), label);
  else app.patch((p) => ({ ...p, packaging: { ...p.packaging, concepts: apply(p.packaging.concepts) } }));
}

/**
 * AI-generated background pictures for one concept's thumbnail. Pictures are
 * made by Codex when it is signed in, else by fal.ai with the creator's own key;
 * nothing is sent until the creator has allowed it for this project, and every
 * picture is labelled.
 */
export function ArtPanel({ concept }: { concept: PackagingConcept }) {
  const project = useApp((s) => s.project)!;
  const projectPath = useApp((s) => s.projectPath)!;
  const [src, setSrc] = useState<Awaited<ReturnType<typeof findArtSource>> | null>(null);
  const [direction, setDirection] = useState('');
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [sheet, setSheet] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const alive = useRef(true);
  const art = concept.art ?? [];
  const used = artInUse(concept);

  const check = (force = false) =>
    void findArtSource(force).then((r) => alive.current && setSrc(r));
  useEffect(() => {
    alive.current = true;
    check();
    const onFocus = () => check(true);
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  // A picture belongs to the concept it was asked for.
  useEffect(() => () => void (run.status === 'running' && run.abort.abort()), [concept.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (run.status !== 'running') return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - run.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [run]);

  const source = src?.source ?? null;
  const ready = !!source;

  const make = async () => {
    const abort = new AbortController();
    setElapsed(0);
    setRun({ status: 'running', startedAt: Date.now(), abort });
    const now = useApp.getState();
    const current = now.project!.packaging.concepts.find((c) => c.id === concept.id);
    if (!current) return setRun({ status: 'idle' });
    if (!source) return setRun({ status: 'idle' });
    const res = await generateThumbnail({ projectPath, project: now.project!, concept: current, direction, signal: abort.signal, notes: now.settings?.playbookNotes?.thumbnails ?? null, source });
    if (!alive.current) return;
    if (!res.ok) return setRun(res.code === 'cancelled' ? { status: 'note', message: res.message } : { status: 'failed', message: res.message });
    // The finished thumbnail goes straight in; earlier ones stay as spare variations, and the layers from before are kept. One undo step.
    setConcept(concept.id, (c) => ({ ...applyWholeThumbnail(c, res.art), editedByCreator: true }), 'Make AI thumbnail');
    setRun({ status: 'note', message: `Thumbnail made in ${Math.max(1, Math.round(res.durationMs / 1000))}s.` });
  };

  const start = () => {
    if (!source) return;
    if (!artAllowed(useApp.getState().project, source)) return setSheet(true);
    void make();
  };

  const use = (a: GeneratedArt) => setConcept(concept.id, (c) => (a.kind === 'thumbnail' ? { ...applyWholeThumbnail(c, a, false), editedByCreator: true } : { ...c, layers: withArt(c.layers, a), editedByCreator: true }), 'Use AI thumbnail');
  const whole = isWholeThumbnail(concept);
  const takeOut = () => setConcept(concept.id, (c) => (isWholeThumbnail(c) ? { ...withoutWholeThumbnail(c), editedByCreator: true } : { ...c, layers: withoutArt(c.layers), editedByCreator: true }), 'Remove AI thumbnail');
  const format = concept.format ? thumbnailFormat(concept.format) : null;
  const discard = (a: GeneratedArt) => {
    // The file is deleted, so this is not an undo step that could bring back a missing picture.
    setConcept(concept.id, (c) => ({ ...c, art: (c.art ?? []).filter((x) => x.id !== a.id), layers: c.layers.filter((l) => !(l.kind === 'image' && l.generated && l.path === a.path)) }), 'Discard AI picture', false);
    void window.cutaway.ai.removeImage(projectPath, a.path).catch(() => undefined);
  };

  return (
    <section className="col art-panel" style={{ gap: 10 }} data-testid="art-panel">
      <div className="row between">
        <div className="pkg-heading">AI thumbnail</div>
        {source ? (
          <span className="pill ai" title={`Pictures are made by ${source.app}${source.id === 'fal' ? ' with your own key' : ` and sent through ${source.company}`}`}>
            <Icon name="sparkle" size={10} /> {source.app}
          </span>
        ) : null}
      </div>
      {format ? (
        <div className="tiny muted" data-testid="thumb-format" title={format.why}>
          Format #{format.id} · <b>{format.name}</b>: {format.look}.
        </div>
      ) : null}
      <PhotoPicker />
      <LogoPicker />
      {!src ? (
        <div className="tiny dim">Checking what can make pictures…</div>
      ) : !ready ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="tiny muted" data-testid="art-unavailable">
            {src.codexFound ? 'Codex is not signed in on this Mac, and there is no fal.ai key, so pictures cannot be made yet.' : 'Pictures are made by Codex or fal.ai. Neither is set up yet: install Codex, or add a fal.ai key. Everything else in the thumbnail works without them.'}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {src.codexFound ? (
              <Button size="sm" variant="primary" icon="external" onClick={() => void window.cutaway.ai.signIn('codex').then((r) => useApp.getState().toast(r.message))}>
                Sign in to Codex…
              </Button>
            ) : null}
            <Button size="sm" icon="gear" onClick={() => openSettingsAt('generation')} data-testid="art-add-fal">
              Add a fal.ai key…
            </Button>
            <Button size="sm" icon="sync" onClick={() => check(true)}>
              Check again
            </Button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            className="input"
            rows={2}
            value={direction}
            maxLength={400}
            placeholder={art.length ? 'What should change? For example: make me look surprised, use a red background' : 'Anything to add? Leave empty to follow the design'}
            aria-label="What should change in the thumbnail"
            data-testid="art-direction"
            disabled={run.status === 'running'}
            onChange={(e) => setDirection(e.target.value)}
            style={{ resize: 'vertical', minHeight: 52 }}
          />
          {run.status === 'running' ? (
            <div className="col" style={{ gap: 6 }} role="status" aria-live="polite">
              <div className="row between">
                <span className="row tiny" style={{ gap: 8 }}>
                  <span className="spinner" /> {source?.app} is making the thumbnail… {elapsed}s
                </span>
                <Button size="sm" variant="ghost" onClick={() => run.abort.abort()}>
                  Cancel
                </Button>
              </div>
              <div className="tiny dim">This usually takes under a minute. The design and your photo were sent to {source?.id === 'fal' ? 'fal.ai, using your own key and credits' : source?.company}.</div>
            </div>
          ) : (
            <div className="row between wrap" style={{ gap: 8 }}>
              <span className="tiny dim" style={{ maxWidth: 190 }}>The whole thumbnail is made as one picture: you, the props and the words.</span>
              <Button size="sm" variant="primary" icon="sparkle" onClick={start} data-testid="art-generate">
                {art.length ? 'Make another' : 'Make the thumbnail'}
              </Button>
            </div>
          )}
        </>
      )}
      {run.status === 'failed' ? (
        <Banner tone="danger" title="No picture was made">
          {run.message} Your thumbnail is unchanged.
        </Banner>
      ) : null}
      {run.status === 'note' ? <div className="tiny muted" data-testid="art-note">{run.message}</div> : null}
      {art.length ? (
        <div className="art-grid" data-testid="art-variations">
          {art.map((a) => {
            const on = used?.path === a.path;
            return (
              <figure key={a.id} className={`art-item${on ? ' on' : ''}`} title={a.note || undefined}>
                <img src={window.cutaway.media.url(`${projectPath}/${a.path}`)} alt={a.note || 'AI-generated picture'} draggable={false} />
                <span className="art-tag">AI-generated</span>
                <figcaption className="row" style={{ gap: 4, justifyContent: 'space-between' }}>
                  {on ? (
                    <Button size="sm" variant="ghost" icon="check" onClick={takeOut} title="Take it out of the thumbnail">
                      In use
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => use(a)}>
                      Use
                    </Button>
                  )}
                  <button className="btn ghost icon sm" onClick={() => discard(a)} title="Discard this picture and delete its file" aria-label="Discard this picture">
                    <Icon name="trash" size={12} />
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </div>
      ) : null}
      {whole ? (
        <Button size="sm" variant="ghost" icon="undo" onClick={takeOut} data-testid="thumb-back">
          Back to the simple thumbnail
        </Button>
      ) : null}
      {art.length ? <div className="tiny dim">Made by {art[0]!.provider}. The exported package says the thumbnail contains an AI-generated picture.</div> : null}
      {sheet && source?.id === 'codex' ? (
        <ConsentSheet
          purpose="thumbnail pictures"
          provider="codex"
          scope={[]}
          images
          onClose={() => setSheet(false)}
          onDecline={() => {
            setSheet(false);
            setRun({ status: 'note', message: 'Nothing was sent and no picture was made.' });
          }}
          onAllow={() => {
            setSheet(false);
            useApp.getState().patch((p) => ({ ...p, artConsent: { provider: source.consent, grantedAt: new Date().toISOString() } }));
            void make();
          }}
        />
      ) : null}
      {sheet && source?.id === 'fal' ? (
        <FalArtConsent
          onClose={() => setSheet(false)}
          onDecline={() => {
            setSheet(false);
            setRun({ status: 'note', message: 'Nothing was sent and no picture was made.' });
          }}
          onAllow={() => {
            setSheet(false);
            useApp.getState().patch((p) => ({ ...p, artConsent: { provider: source.consent, grantedAt: new Date().toISOString() } }));
            void make();
          }}
        />
      ) : null}
    </section>
  );
}
