import { useEffect, useState } from 'react';
import type { ThumbnailLogo } from '../../../shared/api';
import { useApp } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Button } from '../../ui/kit';

/**
 * The creator's logos for AI thumbnails (up to three), saved once and used in every project. Claude is told their
 * names, and when a thumbnail shows one, its picture goes to the image model so the real logo is drawn.
 */
export function LogoPicker() {
  const [logos, setLogos] = useState<ThumbnailLogo[] | undefined>(undefined);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    void window.cutaway.ai.logos().then(setLogos).catch(() => setLogos([]));
  }, []);
  const fail = (e: unknown) => useApp.getState().toast(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
  const add = async () => {
    const [file] = await window.cutaway.app.pickFiles({ title: 'Choose a picture of your logo', kinds: ['image'], multiple: false });
    if (!file) return;
    try {
      const next = await window.cutaway.ai.addLogo(file);
      setLogos(next);
      useApp.getState().toast(`Saved as “${next[next.length - 1]?.name ?? 'your logo'}”. New thumbnail ideas can show it. Rename it if that's not what people call it.`);
    } catch (e) {
      fail(e);
    }
  };
  const rename = async (l: ThumbnailLogo) => {
    const name = names[l.path]?.trim();
    if (!name || name === l.name) return;
    setLogos(await window.cutaway.ai.renameLogo(l.path, name).catch((e) => (fail(e), logos)));
    setNames(({ [l.path]: _, ...rest }) => rest);
  };
  const remove = async (l: ThumbnailLogo) => setLogos(await window.cutaway.ai.removeLogo(l.path).catch((e) => (fail(e), logos)));
  if (!logos) return null;
  return (
    <div className="col" style={{ gap: 6 }} data-testid="thumb-logos">
      {logos.map((l) => (
        <div key={l.path} className="row" style={{ gap: 8, alignItems: 'center' }} data-testid="thumb-logo">
          <img src={window.cutaway.media.url(l.path)} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'contain', background: 'var(--surface-2, rgba(127,127,127,.15))', flex: 'none' }} />
          <input
            className="input grow"
            style={{ minWidth: 0, height: 26 }}
            aria-label="What this logo is called"
            title="What people call it. Thumbnail ideas use this name."
            value={names[l.path] ?? l.name}
            maxLength={40}
            onChange={(e) => setNames((n) => ({ ...n, [l.path]: e.target.value }))}
            onBlur={() => void rename(l)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            data-testid="thumb-logo-name"
          />
          <Button size="sm" variant="ghost" onClick={() => void remove(l)} title="Forget this logo" aria-label={`Remove the ${l.name} logo`} data-testid="thumb-logo-remove">
            <Icon name="x" size={12} />
          </Button>
        </div>
      ))}
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="tiny dim grow">{logos.length ? 'Shown when a thumbnail is about it. Used in every project.' : 'Add your logo so thumbnails show the real one, not a made-up icon.'}</span>
        {logos.length < 3 ? (
          <Button size="sm" onClick={() => void add()} data-testid="thumb-logo-add" title="A PNG with a transparent or plain background works best">
            {logos.length ? 'Add another…' : 'Add your logo…'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
