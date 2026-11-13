import { useEffect, useRef, useState } from 'react';
import type { ClaudeStatus } from '@shared/api';
import type { GeneratedArt, PackagingConcept } from '@cutaway/core';
import { ART_PROVIDER, artAllowed, artInUse, generateArt, withArt, withoutArt } from '../../jobs/imagegen';
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
 * made by Codex, whatever app does the editing; nothing is sent until the
 * creator has allowed it for this project, and every picture is labelled.
 */
export function ArtPanel({ concept }: { concept: PackagingConcept }) {
  const project = useApp((s) => s.project)!;
  const projectPath = useApp((s) => s.projectPath)!;
  const [codex, setCodex] = useState<ClaudeStatus | null>(null);
  const [direction, setDirection] = useState('');
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [sheet, setSheet] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const alive = useRef(true);
  const art = concept.art ?? [];
  const used = artInUse(concept);

  const check = (force = false) =>
    void window.cutaway.ai
      .providers(force)
      .then((p) => alive.current && setCodex(p.codex))
      .catch(() => alive.current && setCodex({ found: false, path: null, version: null, signedIn: null, message: 'Codex could not be checked.' }));
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

  const ready = !!codex?.found && codex.signedIn === true;

  const make = async () => {
    const abort = new AbortController();
    setElapsed(0);
    setRun({ status: 'running', startedAt: Date.now(), abort });
    const now = useApp.getState();
    const current = now.project!.packaging.concepts.find((c) => c.id === concept.id);
    if (!current) return setRun({ status: 'idle' });
    const res = await generateArt({ projectPath, project: now.project!, concept: current, direction, signal: abort.signal, notes: now.settings?.playbookNotes?.thumbnails ?? null });
    if (!alive.current) return;
    if (!res.ok) return setRun(res.code === 'cancelled' ? { status: 'note', message: res.message } : { status: 'failed', message: res.message });
    // The new picture goes straight into the thumbnail; earlier ones stay as spare variations. One undo step.
    setConcept(concept.id, (c) => ({ ...c, art: [...(c.art ?? []), res.art], layers: withArt(c.layers, res.art), editedByCreator: true }), 'Add AI picture');
    setRun({ status: 'note', message: `Picture made in ${Math.max(1, Math.round(res.durationMs / 1000))}s and set as the background. Your text is still your own layer on top.` });
  };

  const start = () => {
    if (!artAllowed(useApp.getState().project)) return setSheet(true);
    void make();
  };

  const use = (a: GeneratedArt) => setConcept(concept.id, (c) => ({ ...c, layers: withArt(c.layers, a), editedByCreator: true }), 'Use AI picture');
  const takeOut = () => setConcept(concept.id, (c) => ({ ...c, layers: withoutArt(c.layers), editedByCreator: true }), 'Remove AI picture');
  const discard = (a: GeneratedArt) => {
    // The file is deleted, so this is not an undo step that could bring back a missing picture.
    setConcept(concept.id, (c) => ({ ...c, art: (c.art ?? []).filter((x) => x.id !== a.id), layers: c.layers.filter((l) => !(l.kind === 'image' && l.generated && l.path === a.path)) }), 'Discard AI picture', false);
    void window.cutaway.ai.removeImage(projectPath, a.path).catch(() => undefined);
  };

  return (
    <section className="col art-panel" style={{ gap: 10 }} data-testid="art-panel">
      <div className="row between">
        <div className="pkg-heading">AI picture</div>
        <span className="pill ai" title={`Pictures are made by ${ART_PROVIDER.app} and sent through ${ART_PROVIDER.company}`}>
          <Icon name="sparkle" size={10} /> {ART_PROVIDER.app}
        </span>
      </div>
      {!codex ? (
        <div className="tiny dim">Checking {ART_PROVIDER.app}…</div>
      ) : !ready ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="tiny muted" data-testid="art-unavailable">
            {codex.found ? `${ART_PROVIDER.app} is not signed in on this Mac, so pictures cannot be made yet.` : `Pictures are made by ${ART_PROVIDER.app}, which was not found on this Mac. Everything else in the thumbnail works without it.`}
          </div>
          {codex.found ? (
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="primary" icon="external" onClick={() => void window.cutaway.ai.signIn('codex').then((r) => useApp.getState().toast(r.message))}>
                Sign in to {ART_PROVIDER.app}…
              </Button>
              <Button size="sm" icon="sync" onClick={() => check(true)}>
                Check again
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <textarea
            className="input"
            rows={2}
            value={direction}
            maxLength={400}
            placeholder="Describe the picture, or leave empty to let it follow the title"
            aria-label="Describe the picture"
            data-testid="art-direction"
            disabled={run.status === 'running'}
            onChange={(e) => setDirection(e.target.value)}
            style={{ resize: 'vertical', minHeight: 52 }}
          />
          {run.status === 'running' ? (
            <div className="col" style={{ gap: 6 }} role="status" aria-live="polite">
              <div className="row between">
                <span className="row tiny" style={{ gap: 8 }}>
                  <span className="spinner" /> {ART_PROVIDER.name} is making a picture… {elapsed}s
                </span>
                <Button size="sm" variant="ghost" onClick={() => run.abort.abort()}>
                  Cancel
                </Button>
              </div>
              <div className="tiny dim">This usually takes under a minute. The title, a few of your words and up to two stills were sent to {ART_PROVIDER.company}.</div>
            </div>
          ) : (
            <div className="row between wrap" style={{ gap: 8 }}>
              <span className="tiny dim" style={{ maxWidth: 190 }}>No words, faces or logos are drawn. Your text stays editable.</span>
              <Button size="sm" variant="primary" icon="sparkle" onClick={start} data-testid="art-generate">
                {art.length ? 'Make another' : 'Generate picture'}
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
      {art.length ? <div className="tiny dim">Made by {art[0]!.provider}. The exported package says the thumbnail contains an AI-generated picture.</div> : null}
      {sheet ? (
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
            useApp.getState().patch((p) => ({ ...p, artConsent: { provider: ART_PROVIDER.consent, grantedAt: new Date().toISOString() } }));
            void make();
          }}
        />
      ) : null}
    </section>
  );
}
