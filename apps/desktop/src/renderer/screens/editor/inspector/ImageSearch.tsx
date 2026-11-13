import { useState, type FormEvent } from 'react';
import type { Appearance } from '@cutaway/core';
import type { ImageSearchPhoto } from '@shared/api';
import { useApp } from '../../../state/store';
import { Icon } from '../../../ui/icons';
import './parity.css';

type ImageBg = Extract<Appearance['background'], { type: 'image' }>;

/**
 * Background photos from Unsplash. The search runs in the main process with the
 * access key from Settings; a chosen photo is downloaded into the project folder
 * and its photographer credit is kept with the project.
 */
export function ImageSearch({ projectPath, onUse }: { projectPath: string; onUse(bg: ImageBg): void }) {
  const hasKey = useApp((s) => !!s.settings?.unsplashKey?.trim());
  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [photos, setPhotos] = useState<ImageSearchPhoto[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [state, setState] = useState<'idle' | 'searching' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [using, setUsing] = useState<string | null>(null);

  const search = async (q: string, pg: number) => {
    if (!q.trim()) return;
    setState('searching');
    setError(null);
    try {
      const r = await window.cutaway.looks.searchImages(q, pg);
      setPhotos(pg === 1 ? r.photos : (prev) => [...prev, ...r.photos.filter((p) => !prev.some((x) => x.id === p.id))]);
      setPage(r.page);
      setPages(r.totalPages);
      setAsked(q.trim());
    } catch (e) {
      setError((e as Error).message);
      if (pg === 1) setPhotos([]);
    } finally {
      setState('done');
    }
  };

  const use = async (p: ImageSearchPhoto) => {
    setUsing(p.id);
    setError(null);
    try {
      const r = await window.cutaway.looks.useImage(projectPath, p.id);
      onUse({ type: 'image', path: r.path, blur: 0, credit: r.credit });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUsing(null);
    }
  };

  if (!hasKey) {
    return (
      <div className="tiny dim" data-testid="image-search-nokey">
        To search Unsplash photos here, paste a free access key from unsplash.com/developers into{' '}
        <button className="text-link" onClick={() => useApp.getState().go('settings')}>Settings → Storage</button>.
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void search(query, 1);
  };

  return (
    <div className="col gap-4" data-testid="image-search">
      <form className="row" style={{ gap: 6 }} onSubmit={submit} role="search">
        <input className="input" type="search" placeholder="Search Unsplash photos" aria-label="Search Unsplash photos" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn" type="submit" disabled={!query.trim() || state === 'searching'}>
          {state === 'searching' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null} Search
        </button>
      </form>
      {error ? <div className="status-line bad" role="alert">{error}</div> : null}
      {state === 'done' && !error && photos.length === 0 ? <div className="tiny dim">No photos found for “{asked}”.</div> : null}
      {photos.length ? (
        <>
          <div className="photo-grid" role="list" aria-label={`Photos for ${asked}`}>
            {photos.map((p) => (
              <button key={p.id} role="listitem" className="photo" disabled={!!using} style={{ background: p.color }} title={`${p.description || 'Photo'} — by ${p.author} on Unsplash`} aria-label={`Use photo by ${p.author}${p.description ? `: ${p.description}` : ''}`} onClick={() => void use(p)}>
                {p.thumb ? <img src={p.thumb} alt="" draggable={false} /> : null}
                {using === p.id ? <span className="photo-busy"><span className="spinner" style={{ width: 14, height: 14 }} /></span> : null}
              </button>
            ))}
          </div>
          <div className="row between tiny dim">
            <span>Photos from Unsplash. The query is sent to unsplash.com.</span>
            {page < pages ? (
              <button className="reset-link" disabled={state === 'searching'} onClick={() => void search(asked, page + 1)}>More</button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="tiny dim">Your search words are sent to unsplash.com. Nothing from the project is.</div>
      )}
    </div>
  );
}

/** "Photo by … on Unsplash" for a downloaded background. */
export function ImageCreditLine({ bg }: { bg: ImageBg }) {
  if (!bg.credit) return null;
  const open = (url: string) => (url ? void window.cutaway.looks.openCredit(url).catch(() => undefined) : undefined);
  return (
    <div className="tiny dim" data-testid="image-credit">
      Photo by{' '}
      <button className="text-link" disabled={!bg.credit.authorUrl} onClick={() => open(bg.credit!.authorUrl)}>{bg.credit.author}</button> on{' '}
      <button className="text-link" disabled={!bg.credit.pageUrl} onClick={() => open(bg.credit!.pageUrl)}>Unsplash</button>
    </div>
  );
}
