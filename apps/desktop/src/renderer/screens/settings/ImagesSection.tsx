import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/api';
import { Button, Field } from '../../ui/kit';

/**
 * The Unsplash access key for the background photo search. It lives in this
 * Mac's settings file only: never in a project, never in an export, never in a log.
 */
export function ImagesSection({ settings, update }: { settings: AppSettings; update(patch: Partial<AppSettings>): Promise<void> }) {
  const saved = settings.unsplashKey ?? '';
  const [value, setValue] = useState(saved);
  const [show, setShow] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  const trimmed = value.trim();
  const dirty = trimmed !== saved;
  return (
    <section className="card set-section" data-testid="images-section">
      <div>
        <div className="set-title">Online background photos</div>
        <div className="tiny dim set-hint">Optional. Lets the Background tab search Unsplash. Only your search words are sent to unsplash.com; nothing from a project is.</div>
      </div>
      <Field label="Unsplash access key" hint="Create a free app at unsplash.com/developers and paste its Access Key here. The key is stored in this Mac's settings only and is never written into a project.">
        <div className="row">
          <input className="input mono grow" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder="Not set" aria-label="Unsplash access key" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' && dirty ? void update({ unsplashKey: trimmed || null }) : undefined)} />
          <Button onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void update({ unsplashKey: trimmed || null })}>Save</Button>
          {saved ? (
            <Button
              onClick={() => {
                setValue('');
                void update({ unsplashKey: null });
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      </Field>
      <div className="tiny muted">{saved ? 'A key is saved. Photo search is available in the Background tab, under Image.' : 'Without a key, the Background tab still offers wallpapers, gradients, colours and your own images.'}</div>
    </section>
  );
}
