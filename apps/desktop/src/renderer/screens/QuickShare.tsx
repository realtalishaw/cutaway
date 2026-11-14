import { useEffect, useRef, useState } from 'react';
import { clipsOf, dropTake, fmtTime, isTimelineSource, projectOfTake, slugify, withSources, type Project } from '@cutaway/core';
import { mediaUrl, type TakeManifest } from '@shared/api';
import { useApp } from '../state/store';
import { errorText } from '../state/actions';
import { describeTake, setTakeUse } from '../state/recording';
import { runFileExport, type PackageProgress } from '../engine/packageExport';
import { Icon } from '../ui/icons';
import { Button, fmtBytes } from '../ui/kit';
import './quickshare.css';

const api = () => window.cutaway;

type Busy = { kind: 'copy' | 'save'; progress: PackageProgress | null; abort: AbortController };
type Done = { kind: 'copy' | 'save'; path: string; bytes: number };

export type QuickShareExit = 'editor' | 'first-cut' | 'deleted';

/**
 * The sheet shown when a take finishes: watch it, share it straight away, or
 * carry on into the editor. Copy and Save render the take as it stands, with
 * the default look, so a quick clip never needs the editor.
 */
export function QuickShare({ manifest, takeDir, note, onExit }: { manifest: TakeManifest; takeDir: string; note?: string; onExit(how: QuickShareExit): void }) {
  const projectPath = useApp((s) => s.projectPath);
  const [thumb, setThumb] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // In a project that already had footage, the take became a clip after it. That can be changed here.
  const use = useApp((s) => {
    const p = s.project;
    if (!p) return null;
    const mine = p.sources.filter((x) => x.takeId === manifest.takeId && x.origin === 'recording');
    const clip = clipsOf(p).find((c) => c.take === manifest.takeId);
    if (clip) return `clip:${clip.name}`;
    if (mine.length && mine.every((x) => !isTimelineSource(x)) && p.sources.some((x) => isTimelineSource(x) && x.kind === 'video')) return 'broll';
    return null;
  });
  const [switching, setSwitching] = useState(false);
  const switchUse = async (to: 'clip' | 'broll') => {
    setSwitching(true);
    try {
      rendered.current = null;
      await setTakeUse(manifest, takeDir, to);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSwitching(false);
    }
  };
  // One render serves both Copy and Save: the second action reuses the first file.
  const rendered = useRef<{ path: string; bytes: number; revision: number } | null>(null);
  const openRef = useRef<HTMLButtonElement>(null);

  const picture = manifest.sources.find((s) => s.role === 'screen' && s.duration > 0.05) ?? manifest.sources.find((s) => (s.role === 'cameraA' || s.role === 'cameraB') && s.duration > 0.05);
  const flags = manifest.flags?.length ?? 0;

  useEffect(() => {
    openRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!projectPath || !picture) return;
    let stale = false;
    api()
      .native.frames(projectPath, `${takeDir}/${picture.file}`, [Math.min(1, picture.duration / 2)], 960)
      .then((r) => !stale && r[0] && setThumb(mediaUrl(r[0].path)))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [projectPath, takeDir, picture]);

  // Leaving the sheet must not leave an encoder running.
  const busyRef = useRef<Busy | null>(null);
  busyRef.current = busy;
  useEffect(() => () => busyRef.current?.abort.abort(), []);

  const render = async (kind: 'copy' | 'save'): Promise<{ path: string; bytes: number } | null> => {
    const { project, projectPath: path } = useApp.getState();
    if (!project || !path) return null;
    if (rendered.current && rendered.current.revision === project.revision && (await api().library.exists(rendered.current.path))) return rendered.current;
    const abort = new AbortController();
    setBusy({ kind, progress: null, abort });
    // Rendered into the project's cache: not an export the creator has to tidy up, and cleared with the cache.
    const res = await runFileExport({
      // the take by itself, also when it sits on a timeline with other clips
      project: projectOfTake(project, manifest.takeId),
      projectPath: path,
      destDir: `${path}/cache/quick-share`,
      format: 'mp4',
      target: 'file',
      gif: { fps: 15, short: 480 },
      signal: abort.signal,
      onProgress: (progress) => setBusy((b) => (b ? { ...b, progress } : b)),
    });
    if (res.status === 'cancelled') return null;
    const file = res.files.find((f) => f.name.endsWith('.mp4') && f.ok);
    if (res.status !== 'complete' || !res.folder || !file) throw new Error(res.error?.message ?? 'The video could not be rendered.');
    rendered.current = { path: `${res.folder}/${file.name}`, bytes: file.bytes, revision: project.revision };
    return rendered.current;
  };

  const share = async (kind: 'copy' | 'save') => {
    if (busy) return;
    setError(null);
    setDone(null);
    try {
      const file = await render(kind);
      if (!file) return;
      if (kind === 'copy') {
        await api().app.copyFile(file.path);
        setDone({ kind, path: file.path, bytes: file.bytes });
      } else {
        const name = `${slugify(useApp.getState().project?.name ?? 'recording')}.mp4`;
        const saved = await api().app.saveCopyAs(file.path, name);
        if (saved) setDone({ kind, path: saved, bytes: file.bytes });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      busy?.abort.abort();
      useApp.getState().patch((p: Project) => {
        // a take that sits on the timeline as its own clip leaves with its clip
        const q = dropTake(p, manifest.takeId);
        const kept = q.sources.filter((s) => !(s.takeId === manifest.takeId && s.origin === 'recording'));
        return { ...withSources({ ...q, sources: kept }, kept), flags: (q.flags ?? []).filter((f) => f.takeId !== manifest.takeId) };
      });
      await api().library.discardTake(takeDir);
      useApp.getState().toast('The take was moved to the Trash.');
      onExit('deleted');
    } catch (e) {
      setError(`The take could not be deleted: ${errorText(e)}`);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const p = busy?.progress;
  const pct = p?.render && p.render.totalFrames > 0 ? Math.min(100, (p.render.frames / p.render.totalFrames) * 100) : null;

  return (
    <div className="qs" role="dialog" aria-modal aria-label="Recording finished" data-testid="quick-share">
      <div className="qs-card rise">
        <div className="qs-thumb">
          {thumb ? <img src={thumb} alt="A frame from the take" /> : <Icon name={picture ? 'film' : 'mic'} size={34} style={{ color: 'var(--text-3)' }} />}
          <span className="qs-duration mono">{fmtTime(manifest.duration)}</span>
        </div>
        <div className="qs-body">
          <div className="qs-title">Recording saved</div>
          <div className="qs-sub">
            {fmtTime(manifest.duration)} of {describeTake(manifest)}
            {flags ? ` · ${flags} flag${flags === 1 ? '' : 's'}` : ''}
          </div>
          {note ? <div className="tiny dim" style={{ marginTop: 6 }}>{note}</div> : null}
          {use ? (
            <div className="tiny" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid="qs-use">
              <span className="muted">{use === 'broll' ? 'Kept as B-roll: it is in Sources, not on the timeline.' : `Added to the timeline as “${use.slice(5)}”, after what was already there.`}</span>
              <Button size="sm" variant="ghost" disabled={switching || !!busy} data-testid={use === 'broll' ? 'qs-as-clip' : 'qs-as-broll'} onClick={() => void switchUse(use === 'broll' ? 'clip' : 'broll')}>
                {use === 'broll' ? 'Add to the timeline' : 'Use as B-roll instead'}
              </Button>
            </div>
          ) : null}

          <div className="qs-actions">
            <button ref={openRef} className="btn primary lg qs-open" data-testid="qs-open" onClick={() => onExit('editor')} disabled={deleting}>
              <Icon name="film" size={16} /> Open in editor
            </button>
            <div className="qs-row">
              <Button icon="link" onClick={() => void share('copy')} disabled={!!busy || deleting || !picture} data-testid="qs-copy" title="Render the take and put the video file on the clipboard">
                Copy to clipboard
              </Button>
              <Button icon="upload" onClick={() => void share('save')} disabled={!!busy || deleting || !picture} data-testid="qs-save" title="Render the take and choose where to save the video">
                Save video as…
              </Button>
              <Button icon="sparkle" onClick={() => onExit('first-cut')} disabled={deleting} data-testid="qs-firstcut" title="Let Cutaway assemble a first cut of this take">
                First cut
              </Button>
            </div>
          </div>

          {busy ? (
            <div className="qs-progress" role="status" aria-live="polite" data-testid="qs-progress">
              <div className="row between">
                <span>{p?.detail ?? 'Starting…'}</span>
                <button className="btn ghost sm" onClick={() => busy.abort.abort()}>
                  Cancel
                </button>
              </div>
              <div className="qs-bar">
                <i style={pct === null ? undefined : { width: `${pct}%` }} className={pct === null ? 'wait' : ''} />
              </div>
              {p?.render && p.render.totalFrames > 0 ? (
                <div className="tiny dim mono">
                  {p.render.frames.toLocaleString()} of {p.render.totalFrames.toLocaleString()} frames
                </div>
              ) : null}
            </div>
          ) : null}

          {done ? (
            <div className="qs-done" role="status" data-testid="qs-done">
              <Icon name="check" size={14} />
              <span className="grow">{done.kind === 'copy' ? `The video (${fmtBytes(done.bytes)}) is on the clipboard. Paste it into Slack, Mail, Messages or Finder.` : `Saved ${fmtBytes(done.bytes)} to ${done.path.replace(/^\/Users\/[^/]+/, '~')}`}</span>
              {done.kind === 'save' ? (
                <button className="btn ghost sm" onClick={() => void api().app.reveal(done.path)}>
                  Show in Finder
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div className="qs-done error" role="alert">
              <Icon name="warn" size={14} />
              <span className="grow">{error}</span>
            </div>
          ) : null}

          <div className="qs-foot">
            {confirmDelete ? (
              <div className="row" style={{ gap: 8 }} role="alert">
                <span className="grow">Delete this take? Its files go to the Trash and it leaves the project.</span>
                <Button size="sm" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  Keep it
                </Button>
                <Button size="sm" variant="danger" icon="trash" busy={deleting} onClick={() => void remove()} data-testid="qs-delete-confirm">
                  Delete take
                </Button>
              </div>
            ) : (
              <div className="row between">
                <span className="tiny dim">The take is already in your project. Nothing has been uploaded.</span>
                <button className="btn ghost sm qs-delete" onClick={() => setConfirmDelete(true)} disabled={deleting} data-testid="qs-delete">
                  <Icon name="trash" size={12} /> Delete take
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
