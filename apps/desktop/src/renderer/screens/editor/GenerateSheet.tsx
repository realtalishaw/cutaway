/**
 * Generate voiceover, music, a sound effect, an image or a video with the creator's own ElevenLabs or
 * fal.ai account (or, for voiceover, a free voice on this Mac), listen to or look at the result, then put
 * it on the timeline at the playhead. Nothing is added until "Add to timeline".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtTime, meta, musicClipsOf, newMusicClip, sourceFromProbe, uid, withMusic, withSources, type MediaSource, type SourceRole } from '@cutaway/core';
import type { GenKeyStatus, GenKind, GenProvider, GenVoice, VoiceInfo } from '@shared/api';
import { placeGenerated } from '../../state/generated';
import { timeMapOf, useApp, usePlayback } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Banner, Button, Modal, Segmented, Slider, Toggle } from '../../ui/kit';
import { placeOverlays } from './addMenus';
import './generate.css';

/** Where a picture or a video goes: a clip of its own on the video row, or over the footage. */
export type GenTarget = 'clip' | 'over';
type Provider = GenProvider | 'mac';

const TITLE: Record<GenKind, string> = { voice: 'AI voiceover', music: 'Generate music', sound: 'Generate a sound effect', image: 'Generate an image', video: 'Generate a video' };
const PLACEHOLDER: Record<GenKind, string> = {
  voice: 'What the voice should say…',
  music: 'Upbeat lo-fi beat with soft keys, for a product walkthrough',
  sound: 'A short whoosh as a page slides in',
  image: 'A clean desk with a laptop showing a dashboard, soft morning light',
  video: 'Slow camera move over a city skyline at dusk',
};
const NAME: Record<Provider, string> = { elevenlabs: 'ElevenLabs', fal: 'fal.ai', mac: 'This Mac (free)' };
/** Prices published for the default models. Anything else is "uses your credits". */
const COST: Partial<Record<`${GenProvider}:${GenKind}`, string>> = {
  'fal:voice': '$0.10 per 1,000 characters',
  'fal:music': '$0.20 per piece',
  'fal:sound': '$0.002 per second',
};
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e));
const remembered = (kind: GenKind): Provider | null => {
  try {
    return (localStorage.getItem(`cutaway.gen.${kind}`) as Provider | null) ?? null;
  } catch {
    return null;
  }
};

export function GenerateSheet({ kind, target = 'over', onClose }: { kind: GenKind; target?: GenTarget; onClose(): void }) {
  const projectPath = useApp((s) => s.projectPath)!;
  const [keys, setKeys] = useState<GenKeyStatus | null>(null);
  const providers = useMemo<Provider[]>(() => [...(keys ? (['elevenlabs', 'fal'] as GenProvider[]).filter((p) => keys.can[p].includes(kind)) : []), ...(kind === 'voice' ? (['mac'] as Provider[]) : [])], [keys, kind]);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [prompt, setPrompt] = useState('');
  const [voices, setVoices] = useState<GenVoice[] | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const [seconds, setSeconds] = useState(kind === 'sound' ? 3 : kind === 'video' ? 5 : 20);
  const [instrumental, setInstrumental] = useState(true);
  const [aspect, setAspect] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ path: string; provider: Provider; model: string; prompt: string } | null>(null);
  const job = useRef<string | null>(null);
  const pending = useRef<{ path: string; mac: boolean } | null>(null);

  useEffect(() => void window.cutaway.gen.status().then(setKeys), []);
  // pick the provider: the last one used for this kind, else the first with a key, else the first
  useEffect(() => {
    if (!keys || provider) return;
    const last = remembered(kind);
    const hasKey = (p: Provider) => p === 'mac' || keys[p].set;
    setProvider(last && providers.includes(last) && hasKey(last) ? last : (providers.find(hasKey) ?? providers[0] ?? null));
  }, [keys, providers, provider, kind]);
  // voices of the chosen provider
  useEffect(() => {
    if (kind !== 'voice' || !provider || !keys) return;
    setVoices(null);
    if (provider !== 'mac' && !keys[provider].set) return;
    const load: Promise<GenVoice[]> = provider === 'mac' ? window.cutaway.native.voices().then((vs: VoiceInfo[]) => vs.map((v) => ({ id: v.id, name: v.name, description: v.language, previewUrl: null }))) : window.cutaway.gen.voices(provider);
    load.then((vs) => {
      setVoices(vs);
      setVoiceId(vs[0]?.id ?? '');
    }).catch((e) => setError(errorText(e)));
  }, [kind, provider, keys]);
  useEffect(() => window.cutaway.gen.onStatus((s) => s.jobId === job.current && setStatusText(s.text)), []);
  // closing without adding leaves no file behind and stops a request still running
  useEffect(
    () => () => {
      if (job.current) void window.cutaway.gen.cancel(job.current);
      const p = pending.current;
      if (p) void (p.mac ? window.cutaway.native.removeVoiceover(projectPath, p.path) : window.cutaway.gen.discard(projectPath, p.path)).catch(() => {});
    },
    [projectPath],
  );

  const keyMissing = !!provider && provider !== 'mac' && !!keys && !keys[provider].set;
  const canGo = !!provider && !keyMissing && !!prompt.trim() && !busy && (kind !== 'voice' || !!voiceId);
  const fileUrl = made ? window.cutaway.media.url(`${projectPath}/${made.path}`) : '';

  const generate = async () => {
    if (!provider || !canGo) return;
    setBusy(true);
    setError(null);
    setStatusText(provider === 'mac' ? 'Speaking…' : 'Sending…');
    const prev = pending.current;
    try {
      let path: string;
      let model: string;
      if (provider === 'mac') {
        path = (await window.cutaway.native.speak(projectPath, prompt.trim(), voiceId)).path;
        model = 'macOS voice';
      } else {
        const id = uid('gen');
        job.current = id;
        const r = await window.cutaway.gen.generate(projectPath, { jobId: id, provider, kind, prompt: prompt.trim(), voiceId: voiceId || undefined, seconds: kind === 'voice' || kind === 'image' ? undefined : seconds, instrumental, aspect });
        path = r.path;
        model = r.model;
      }
      // a new result replaces the one only looked at
      if (prev) void (prev.mac ? window.cutaway.native.removeVoiceover(projectPath, prev.path) : window.cutaway.gen.discard(projectPath, prev.path)).catch(() => {});
      pending.current = { path, mac: provider === 'mac' };
      setMade({ path, provider, model, prompt: prompt.trim() });
      try {
        localStorage.setItem(`cutaway.gen.${kind}`, provider);
      } catch {
        /* remembering the choice is a convenience */
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      job.current = null;
      setBusy(false);
      setStatusText('');
    }
  };

  const add = async () => {
    if (!made) return;
    setBusy(true);
    try {
      const app = useApp.getState();
      const { itemId, label } = await placeGenerated({ path: made.path, kind, provider: made.provider, model: made.model, prompt: made.prompt, target });
      pending.current = null; // the project owns the file now
      if (itemId && kind !== 'image' && kind !== 'video') app.select({ kind: 'music', id: itemId });
      app.toast(`${label} added at ${fmtTime(usePlayback.getState().time, true)}.`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const cost = provider && provider !== 'mac' ? (COST[`${provider}:${kind}`] ?? 'priced by the model, from your credits') : null;
  return (
    <Modal
      title={TITLE[kind]}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="tiny dim grow" style={{ alignSelf: 'center' }}>
            {busy ? statusText : made ? `Made with ${NAME[made.provider]} · ${made.model}` : cost && provider ? `${NAME[provider]} · ${cost}` : ''}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon="sparkle" data-testid="gen-go" onClick={() => void generate()} disabled={!canGo} busy={busy && !made}>
            {made ? 'Make another' : 'Generate'}
          </Button>
          {made ? (
            <Button variant="primary" icon="plus" data-testid="gen-add" onClick={() => void add()} disabled={busy}>
              Add to timeline
            </Button>
          ) : null}
        </>
      }
    >
      <div className="gen" data-testid="generate-sheet" data-kind={kind}>
        {providers.length > 1 && provider ? <Segmented value={provider} onChange={(p) => (setProvider(p), setMade(null))} options={providers.map((p) => ({ value: p, label: NAME[p] }))} label="Made by" full /> : null}
        {keyMissing && provider ? (
          <Banner tone="warn" title={`Add your ${NAME[provider]} API key`} action={<Button size="sm" onClick={() => (onClose(), useApp.getState().go('settings'))}>Open Settings</Button>}>
            Settings › AI generation. Generations use your own {NAME[provider]} account and its credits.
          </Banner>
        ) : null}
        <textarea className="input gen-prompt" rows={kind === 'voice' ? 5 : 3} placeholder={PLACEHOLDER[kind]} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label={kind === 'voice' ? 'Script' : 'Description'} data-testid="gen-prompt" />
        <div className="gen-opts">
          {kind === 'voice' ? (
            <label className="field grow">
              <span className="field-label">Voice</span>
              <select className="select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!voices?.length} aria-label="Voice" data-testid="gen-voice">
                {!voices ? <option>{keyMissing ? 'Add a key first' : 'Loading voices…'}</option> : null}
                {voices?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.description ? ` · ${v.description}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {kind === 'music' || kind === 'sound' ? <Slider label="Length" min={kind === 'sound' ? 0.5 : 5} max={kind === 'sound' ? 22 : 120} step={kind === 'sound' ? 0.5 : 5} value={seconds} format={(v) => fmtTime(v, kind === 'sound')} onChange={setSeconds} /> : null}
          {kind === 'music' && provider === 'elevenlabs' ? <Toggle label="Instrumental" hint="No singing, so it sits under a voice." checked={instrumental} onChange={setInstrumental} /> : null}
          {kind === 'image' || kind === 'video' ? <Segmented value={aspect} onChange={setAspect} options={[{ value: '16:9', label: 'Wide' }, { value: '9:16', label: 'Tall' }, { value: '1:1', label: 'Square' }]} label="Shape" /> : null}
          {kind === 'video' ? <Segmented value={seconds > 5 ? '8' : '5'} onChange={(v) => setSeconds(Number(v))} options={[{ value: '5', label: '5 s' }, { value: '8', label: '8 s' }]} label="Length" /> : null}
        </div>
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {made ? (
          <div className="gen-result" data-testid="gen-result">
            {kind === 'image' ? <img src={fileUrl} alt="" /> : kind === 'video' ? <video src={fileUrl} controls autoPlay muted loop /> : <audio src={fileUrl} controls autoPlay />}
          </div>
        ) : busy ? (
          <div className="gen-wait">
            <span className="spinner" /> {statusText || 'Working…'}
            {kind === 'video' ? <span className="tiny dim"> Video usually takes a minute or two.</span> : null}
          </div>
        ) : null}
        <div className="tiny dim">
          <Icon name={provider === 'mac' ? 'mic' : 'sparkle'} size={11} />{' '}
          {provider === 'mac'
            ? 'Made on this Mac with a system voice. Nothing is sent anywhere.'
            : `What you type is sent to ${provider ? NAME[provider] : 'the provider'} to make this, using your account. ${kind === 'image' || kind === 'video' ? (target === 'clip' ? 'It goes on the video row as a clip of its own.' : 'It goes over the footage at the playhead.') : 'It goes on the audio row at the playhead.'}`}
        </div>
      </div>
    </Modal>
  );
}
