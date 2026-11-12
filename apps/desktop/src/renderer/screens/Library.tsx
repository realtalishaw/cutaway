import { useCallback, useEffect, useState } from 'react';
import { fmtTime } from '@cutaway/core';
import type { ProjectSummary, RecoverableTake } from '@shared/api';
import { useApp } from '../state/store';
import { droppedPaths, errorText, importIntoNewProject, newRecording, openProjectAt, pickAndImport } from '../state/actions';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Empty, Modal, fmtAgo, fmtBytes } from '../ui/kit';
import './library.css';

const ROLE_ICON: Record<string, IconName> = { screen: 'screen', cameraA: 'camera', cameraB: 'camera', voice: 'mic', systemAudio: 'speaker', broll: 'broll', music: 'music', image: 'image' };

function ProjectCard({ p, index, onChanged }: { p: ProjectSummary; index: number; onChanged: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const roles = [...new Set(p.sourceRoles.filter((r) => ROLE_ICON[r]))];
  const cams = p.sourceRoles.filter((r) => r === 'cameraA' || r === 'cameraB').length;
  const status = p.missingSources > 0 ? { cls: 'danger', text: `${p.missingSources} missing` } : p.exported ? { cls: 'ok', text: 'Exported' } : p.hasFirstCut ? { cls: 'ai', text: 'First cut' } : { cls: '', text: 'Raw footage' };
  return (
    <>
      <article
        className="project-card rise"
        style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
        tabIndex={0}
        role="button"
        aria-label={`Open ${p.name}`}
        onClick={() => void openProjectAt(p.path)}
        onKeyDown={(e) => e.key === 'Enter' && void openProjectAt(p.path)}
        onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY }))}
      >
        <div className="poster">
          {p.poster ? <img src={p.poster} alt="" draggable={false} /> : <div className="poster-empty"><Icon name="film" size={26} /></div>}
          <span className="duration mono">{fmtTime(p.outDuration || p.duration)}</span>
          <span className={`pill ${status.cls} status`}>{status.text}</span>
        </div>
        <div className="meta">
          <div className="name">{p.name}</div>
          <div className="row between tiny dim">
            <span className="row gap-2">
              {roles.slice(0, 5).map((r) => (
                <Icon key={r} name={ROLE_ICON[r]!} size={12} />
              ))}
              {cams === 2 ? <span className="mono">×2</span> : null}
            </span>
            <span>{fmtAgo(p.updatedAt)}</span>
          </div>
        </div>
        <button className="btn ghost icon sm more" aria-label="Project actions" onClick={(e) => (e.stopPropagation(), setMenu({ x: e.clientX, y: e.clientY }))}>
          <Icon name="dots" size={14} />
        </button>
      </article>
      {menu ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 290 }} onMouseDown={() => setMenu(null)}>
          <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 120) }} onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => (setMenu(null), void openProjectAt(p.path))}><Icon name="chevron" size={13} /> Open</button>
            <button onClick={() => (setMenu(null), void window.cutaway.app.reveal(p.path))}><Icon name="folder" size={13} /> Show in Finder</button>
            <div className="sep" />
            <button className="danger" onClick={() => (setMenu(null), setConfirm(true))}><Icon name="trash" size={13} /> Move to Trash…</button>
          </div>
        </div>
      ) : null}
      {confirm ? (
        <Modal
          eyebrow="Remove project"
          title={<>Move “{p.name}” to the Trash?</>}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Keep project</Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  setConfirm(false);
                  try {
                    await window.cutaway.library.trash(p.path);
                    onChanged();
                  } catch (e) {
                    useApp.getState().toast(`Could not remove: ${errorText(e)}`, 'error');
                  }
                }}
              >
                Move to Trash
              </Button>
            </>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>
            The project and the {fmtBytes(p.sizeBytes)} of media stored inside it go to the Trash, where you can still get them back. Files you imported by reference stay exactly where they are.
          </p>
        </Modal>
      ) : null}
    </>
  );
}

export function Library() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableTake[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const info = useApp((s) => s.info);

  const refresh = useCallback(() => {
    window.cutaway.library.list().then(setProjects).catch((e) => setError(errorText(e)));
    window.cutaway.library.recoverable().then(setRecoverable).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const recoverTake = async (t: RecoverableTake) => {
    setBusy(t.takeDir);
    try {
      const manifest = await window.cutaway.library.recover(t.takeDir);
      if (t.projectPath) {
        await openProjectAt(t.projectPath);
        window.dispatchEvent(new CustomEvent('cutaway-recovered-take', { detail: { takeDir: t.takeDir, manifest } }));
      }
    } catch (e) {
      useApp.getState().toast(`Recovery failed: ${errorText(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={`page library${dragging ? ' dragging' : ''}`}
      onDragEnter={(e) => (e.preventDefault(), setDragging(true))}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void importIntoNewProject(droppedPaths(e));
      }}
    >
      <div className="page-inner">
        <section className="hero">
          <div className="hero-copy rise">
            <div className="eyebrow">Recorder · AI editor · YouTube package</div>
            <h1 className="display h1">
              Record once.
              <br />
              Get the <em>first cut.</em>
            </h1>
            <p className="muted lede">Capture your screen and up to two cameras, or bring footage you already have. Cutaway assembles a real edit you can play, correct and export with its thumbnail and title.</p>
          </div>
          <div className="hero-actions">
            <button className="action record rise" style={{ animationDelay: '80ms' }} onClick={() => void newRecording()}>
              <span className="action-icon"><span className="rec-dot" /></span>
              <span className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
                <span className="action-title">New recording</span>
                <span className="action-sub">Screen, camera A and B, mic, system audio</span>
              </span>
              <span className="kbd">⌘N</span>
            </button>
            <button className="action rise" style={{ animationDelay: '140ms' }} onClick={() => void pickAndImport(true)}>
              <span className="action-icon"><Icon name="import" size={18} /></span>
              <span className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
                <span className="action-title">Import footage</span>
                <span className="action-sub">MP4 or MOV, WAV or M4A, JPG or PNG. Or drop files here.</span>
              </span>
              <span className="kbd">⌘I</span>
            </button>
          </div>
        </section>

        {info && !info.nativeHelper ? (
          <Banner tone="warn" title="The capture helper is not built">
            Recording, import inspection and transcription need it. Run <span className="mono">pnpm native:build</span> in the repository, then reopen Cutaway.
          </Banner>
        ) : null}

        {recoverable.length > 0 ? (
          <section className="col" style={{ gap: 10, marginTop: 8 }}>
            <div className="eyebrow">Interrupted work</div>
            {recoverable.map((t) => (
              <Banner
                key={t.takeDir}
                tone="warn"
                icon="history"
                title={`A recording${t.startedAt ? ` from ${new Date(t.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''} was interrupted`}
                action={
                  <div className="row">
                    <Button size="sm" variant="ghost" onClick={() => void window.cutaway.library.discardTake(t.takeDir).then(refresh)}>Discard</Button>
                    <Button size="sm" busy={busy === t.takeDir} onClick={() => void recoverTake(t)}>Recover {fmtBytes(t.sizeBytes)}</Button>
                  </div>
                }
              >
                Everything up to the last checkpoint is on disk. Recovering adds the usable footage to its project.
              </Banner>
            ))}
          </section>
        ) : null}

        <section style={{ marginTop: 36 }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <div className="eyebrow">Projects{projects?.length ? ` · ${projects.length}` : ''}</div>
            {info ? (
              <button className="btn ghost sm" onClick={() => void window.cutaway.app.reveal(info.libraryDir)} title={info.libraryDir}>
                <Icon name="folder" size={12} /> Stored on this Mac
              </button>
            ) : null}
          </div>
          {error ? (
            <Banner tone="danger" title="The library could not be read" action={<Button size="sm" onClick={refresh}>Try again</Button>}>
              {error}
            </Banner>
          ) : projects === null ? (
            <div className="grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="project-card skeleton" />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="panel">
              <Empty icon="film" title="No projects yet">
                Your recordings and imports appear here. Nothing leaves this Mac unless you approve it.
              </Empty>
            </div>
          ) : (
            <div className="grid">
              {projects.map((p, i) => (
                <ProjectCard key={p.path} p={p} index={i} onChanged={refresh} />
              ))}
            </div>
          )}
        </section>
      </div>
      {dragging ? (
        <div className="drop-veil">
          <div className="drop-card">
            <Icon name="import" size={26} />
            <div className="display h3">Drop to start a project</div>
            <div className="muted">Each file is inspected before anything is edited.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
