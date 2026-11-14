import { useEffect, useState } from 'react';
import type { GenKeyStatus, GenKind, GenProvider } from '@shared/api';
import { Banner, Button, Field } from '../../ui/kit';

const NAME: Record<GenProvider, string> = { elevenlabs: 'ElevenLabs', fal: 'fal.ai' };
const WHERE: Record<GenProvider, string> = {
  elevenlabs: 'In ElevenLabs, open Developers › API keys and create a key. Give it access to Text to Speech, Sound Effects, Music and Voices (read).',
  fal: 'In fal.ai, open the dashboard › Keys and create an API key.',
};
const KIND_LABEL: Record<GenKind, string> = { voice: 'Voiceover', music: 'Music', sound: 'Sound effects', image: 'Images', video: 'Video' };

/**
 * The creator's own ElevenLabs and fal.ai keys, for generating voiceover, music, sound effects, images
 * and video. Keys are kept in this Mac's keychain by the main process; this screen never sees them again
 * after they are saved, only the last four characters.
 */
export function GenerationSection() {
  const [status, setStatus] = useState<GenKeyStatus | null>(null);
  useEffect(() => void window.cutaway.gen.status().then(setStatus), []);
  if (!status) return null;
  return (
    <>
      {(['elevenlabs', 'fal'] as GenProvider[]).map((p) => (
        <KeyCard key={p} provider={p} status={status} onChange={setStatus} />
      ))}
      <ModelsCard status={status} onChange={setStatus} />
    </>
  );
}

function KeyCard({ provider, status, onChange }: { provider: GenProvider; status: GenKeyStatus; onChange(s: GenKeyStatus): void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const saved = status[provider];
  const save = async (key: string | null) => {
    setBusy(true);
    setResult(null);
    try {
      onChange(await window.cutaway.gen.setKey(provider, key));
      setValue('');
      if (key) setResult(await window.cutaway.gen.testKey(provider));
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setResult(await window.cutaway.gen.testKey(provider));
    setBusy(false);
  };
  return (
    <section className="card set-section" data-testid={`gen-key-${provider}`}>
      <div>
        <div className="set-title">{NAME[provider]}</div>
        <div className="tiny dim set-hint">
          Makes {status.can[provider].map((k) => KIND_LABEL[k].toLowerCase()).join(', ')} with your own {NAME[provider]} account. What you type in a generation is sent to {NAME[provider]}, and it uses your account&apos;s credits.
        </div>
      </div>
      <Field label="API key" hint={`${WHERE[provider]} The key is kept in this Mac's keychain, never in a project or an export.`}>
        <div className="row">
          <input className="input mono grow" type="password" autoComplete="off" spellCheck={false} placeholder={saved.set ? `Saved (${saved.hint})` : 'Not set'} aria-label={`${NAME[provider]} API key`} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save(value.trim())} />
          <Button variant="primary" disabled={!value.trim() || busy} onClick={() => void save(value.trim())}>
            Save
          </Button>
          {saved.set ? (
            <>
              <Button disabled={busy} onClick={() => void test()} busy={busy && !value}>
                Test
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void save(null)}>
                Remove
              </Button>
            </>
          ) : null}
        </div>
      </Field>
      {result ? <Banner tone={result.ok ? 'ok' : 'warn'}>{result.message}</Banner> : null}
    </section>
  );
}

function ModelsCard({ status, onChange }: { status: GenKeyStatus; onChange(s: GenKeyStatus): void }) {
  const [draft, setDraft] = useState(status.models);
  useEffect(() => setDraft(status.models), [status.models]);
  const dirty = (Object.keys(draft) as GenKind[]).some((k) => draft[k] !== status.models[k]);
  return (
    <section className="card set-section">
      <div>
        <div className="set-title">fal.ai models</div>
        <div className="tiny dim set-hint">Which fal.ai model makes each kind of media. The defaults are inexpensive; any model id from fal.ai/models that takes a text prompt works. Leave a field empty to go back to the default.</div>
      </div>
      {(Object.keys(KIND_LABEL) as GenKind[]).map((k) => (
        <Field key={k} label={KIND_LABEL[k]}>
          <input className="input mono" spellCheck={false} placeholder={status.defaults[k]} value={draft[k] === status.defaults[k] ? '' : draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value || status.defaults[k] })} aria-label={`fal.ai model for ${KIND_LABEL[k]}`} />
        </Field>
      ))}
      <div className="row">
        <Button variant="primary" disabled={!dirty} onClick={() => void window.cutaway.gen.setModels(draft).then(onChange)}>
          Save models
        </Button>
      </div>
    </section>
  );
}
