import { useEffect, useMemo, useRef, useState } from 'react';
import { displayText, fmtTime, keptWords, sourceFromProbe, withSources, type MediaSource } from '@cutaway/core';
import type { VoiceInfo } from '@shared/api';
import { timeMapOf, useApp, useProject } from '../state/store';
import { Icon } from '../ui/icons';
import { Banner, Button, Modal, Slider } from '../ui/kit';
import './voiceover.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const QUALITY_RANK: Record<string, number> = { premium: 0, enhanced: 1, default: 2 };
/** macOS novelty voices: listed last and never picked by default. */
const NOVELTY = new Set(['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Fred', 'Kathy']);
const rank = (v: VoiceInfo) => (NOVELTY.has(v.name) ? 10 : 0) + (QUALITY_RANK[v.quality] ?? 3);

/**
 * Narration from a system voice, synthesised on this Mac. Nothing is sent
 * anywhere, and it is always a stock voice: Cutaway does not clone voices.
 */
export function VoiceoverSheet({ onClose }: { onClose(): void }) {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const locale = useApp((s) => s.settings?.transcription.locale ?? 'en-US');
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const [allLanguages, setAllLanguages] = useState(false);
  const [script, setScript] = useState('');
  const [rate, setRate] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ key: string; path: string; duration: number } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  /** The generated take that has not been added to the project yet; its file is removed if it is abandoned. */
  const pending = useRef<string | null>(null);

  const removeFile = (path: string) => window.cutaway.native.removeVoiceover(projectPath, path);
  const dropPending = () => {
    const path = pending.current;
    pending.current = null;
    if (path) void removeFile(path).catch(() => {});
  };
  // Closing the sheet without adding the take leaves no stray audio file behind.
  useEffect(() => dropPending, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Narration this project already holds. */
  const takes = project.sources.filter((s) => s.path.startsWith('media/voiceover/'));
  const useOf = (s: MediaSource) => (project.edit.audio.masterVoiceId === s.id ? 'This project’s voice' : project.edit.audio.music?.sourceId === s.id ? 'Plays under the video' : 'Not in use');

  const deleteTake = async (s: MediaSource) => {
    if (confirming !== s.id) {
      setConfirming(s.id);
      return;
    }
    setConfirming(null);
    audioRef.current?.pause();
    useApp.getState().patch((p) => {
      const next = withSources(p, p.sources.filter((x) => x.id !== s.id));
      // Decisions that pointed at this take go with it.
      return { ...next, edit: { ...next.edit, broll: next.edit.broll.filter((b) => b.assetId !== s.id), audio: { ...next.edit.audio, music: next.edit.audio.music?.sourceId === s.id ? null : next.edit.audio.music } } };
    });
    try {
      await removeFile(s.path);
      useApp.getState().toast(`Deleted “${s.name}” and its audio file.`);
    } catch (e) {
      useApp.getState().toast(`The take was removed from the project, but its file could not be deleted: ${errorText(e)}`, 'error');
    }
  };

  const lang = locale.slice(0, 2).toLowerCase();
  useEffect(() => {
    window.cutaway.native
      .voices()
      .then((v) => {
        const sorted = [...v].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
        setVoices(sorted);
        const pick = sorted.find((x) => x.language === locale) ?? sorted.find((x) => x.language.toLowerCase().startsWith(lang)) ?? sorted[0];
        if (pick) setVoiceId(pick.id);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [locale, lang]);

  const shown = useMemo(() => (voices ?? []).filter((v) => allLanguages || v.language.toLowerCase().startsWith(lang) || v.id === voiceId), [voices, allLanguages, lang, voiceId]);
  const map = timeMapOf(project);
  const transcriptText = useMemo(() => keptWords(project.transcript, map).map((k) => displayText(k.word, project.edit)).join(' '), [project.transcript, project.edit, map]);
  const hasVoice = !!project.edit.audio.masterVoiceId;
  const hasMusic = !!project.edit.audio.music;
  const key = `${voiceId}|${rate}|${script.trim()}`;
  const current = made?.key === key ? made : null;
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;

  const generate = async (): Promise<typeof made> => {
    if (current) return current;
    setBusy(true);
    setError(null);
    try {
      const r = await window.cutaway.native.speak(projectPath, script.trim(), voiceId, rate);
      const m = { key, path: r.path, duration: r.duration };
      // a new take replaces the one that was only auditioned
      dropPending();
      pending.current = m.path;
      setMade(m);
      return m;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    const m = await generate();
    const el = audioRef.current;
    if (!m || !el) return;
    el.src = window.cutaway.media.url(`${projectPath}/${m.path}`);
    void el.play().catch(() => {});
  };

  const add = async () => {
    const m = await generate();
    if (!m) return;
    setBusy(true);
    try {
      const [probe] = await window.cutaway.native.probe([`${projectPath}/${m.path}`]);
      if (!probe?.ok) throw new Error(probe?.error?.message ?? 'The synthesised audio could not be read.');
      const voice = voices?.find((v) => v.id === voiceId);
      const role: MediaSource['role'] = hasVoice ? 'music' : 'voice';
      const source: MediaSource = {
        ...sourceFromProbe({ ...probe, path: m.path }, role, { managed: true, origin: 'import', name: `Voiceover · ${voice?.name ?? 'system voice'}` }),
        note: 'Synthetic narration from a macOS system voice, generated on this Mac.',
        license: 'macOS system voice',
      };
      const app = useApp.getState();
      pending.current = null; // the project owns this file now
      app.patch((p) => withSources(p, [...p.sources, source]));
      if (hasVoice && !hasMusic) {
        // Plays straight through the finished video, on top of the recorded voice.
        app.edit((e) => ({ ...e, audio: { ...e.audio, music: { sourceId: source.id, gain: 1, duck: false } } }), 'Add voiceover');
        app.toast('Voiceover added. It plays from the start of the finished video; adjust or remove it in the Audio tab.');
      } else if (hasVoice) {
        app.toast('Voiceover added to Sources. A music track is already playing, so choose the voiceover in the Audio tab to use it instead.');
      } else {
        app.toast('Voiceover added as this project’s voice. Create the first cut to transcribe and caption it.');
      }
      audioRef.current?.pause();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Voiceover"
      wide
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <span className="tiny dim grow" style={{ alignSelf: 'center' }}>
            {current ? `Generated · ${fmtTime(current.duration)}` : words ? `${words} word${words === 1 ? '' : 's'}` : 'Write or paste what the voice should say.'}
          </span>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button icon="play" onClick={() => void preview()} disabled={!script.trim() || !voiceId || busy} busy={busy && !current}>
            {current ? 'Play again' : 'Generate and play'}
          </Button>
          <Button variant="primary" icon="plus" onClick={() => void add()} disabled={!script.trim() || !voiceId || busy}>
            Add to project
          </Button>
        </>
      }
    >
      <div className="vo">
        <div className="vo-col">
          <div className="row between">
            <span className="vo-label">Voice</span>
            <button className="reset-link" onClick={() => setAllLanguages(!allLanguages)}>
              {allLanguages ? `Only ${locale}` : 'All languages'}
            </button>
          </div>
          {loadError ? (
            <Banner tone="danger" title="System voices could not be listed">
              {loadError}
            </Banner>
          ) : voices === null ? (
            <div className="row muted">
              <span className="spinner" /> Looking for system voices…
            </div>
          ) : shown.length === 0 ? (
            <div className="tiny dim">No system voice is installed for {locale}. Show all languages, or add voices in System Settings › Accessibility › Spoken Content.</div>
          ) : (
            <div className="vo-voices" role="radiogroup" aria-label="Voice">
              {shown.map((v) => (
                <button key={v.id} role="radio" aria-checked={v.id === voiceId} className={v.id === voiceId ? 'on' : ''} onClick={() => setVoiceId(v.id)}>
                  <Icon name="user" size={14} />
                  <span className="grow">{v.name}</span>
                  <span className="tiny dim">
                    {v.language}
                    {v.quality !== 'default' ? ` · ${v.quality}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
          <Slider label="Speaking rate" min={0.3} max={0.65} step={0.01} value={rate} format={(v) => (v < 0.45 ? 'Slower' : v > 0.55 ? 'Faster' : 'Normal')} onChange={setRate} />
          {takes.length ? (
            <div className="vo-takes">
              <span className="vo-label">In this project</span>
              <ul>
                {takes.map((s) => (
                  <li key={s.id} data-testid="vo-take">
                    <Icon name="mic" size={13} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="vo-take-name">{s.name}</div>
                      <div className="tiny dim">
                        {fmtTime(s.duration)} · {useOf(s)}
                      </div>
                    </div>
                    <Button size="sm" variant={confirming === s.id ? 'danger' : 'ghost'} icon="trash" disabled={busy} onClick={() => void deleteTake(s)} onBlur={() => setConfirming((c) => (c === s.id ? null : c))} title="Remove this take from the project and delete its audio file">
                      {confirming === s.id ? 'Delete the file?' : 'Delete'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="vo-col">
          <div className="row between">
            <span className="vo-label">Script</span>
            <button className="reset-link" disabled={!transcriptText} onClick={() => setScript(transcriptText)} title={transcriptText ? 'Fill in the words that survive the current cut' : 'This project has no transcript'}>
              Use transcript text
            </button>
          </div>
          <textarea className="textarea vo-script" value={script} onChange={(e) => setScript(e.target.value)} placeholder="Type or paste the narration." aria-label="Voiceover script" />
          <audio ref={audioRef} controls className="vo-audio" style={{ display: current ? 'block' : 'none' }} />
          {error ? (
            <Banner tone="danger" title="The voiceover could not be generated">
              {error}
            </Banner>
          ) : null}
          <div className="vo-note tiny muted">
            <Icon name="shield" size={13} />
            <span>
              A synthetic macOS system voice, generated on this Mac. It is not your voice and Cutaway does not clone voices.{' '}
              {hasVoice
                ? hasMusic
                  ? 'This project already has a voice and a music track, so the voiceover is added to Sources and you choose it in the Audio tab.'
                  : 'This project already has a recorded voice, so the voiceover is added as a supporting track that plays from the start of the finished video. It does not follow cuts.'
                : 'This project has no voice track, so the voiceover becomes its voice: it is transcribed, captioned and follows your cuts.'}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
