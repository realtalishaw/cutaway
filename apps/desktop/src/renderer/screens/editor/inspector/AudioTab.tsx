import { isMasterVoice, setMasterVoice, type EditState } from '@cutaway/core';
import { useProject } from '../../../state/store';
import { Button, Slider, Toggle } from '../../../ui/kit';
import { useState } from 'react';
import { VoiceoverSheet } from '../../Voiceover';
import { Section, app, pct } from './shared';
import { MusicSection, SoundsSection } from './SoundEditors';

export function AudioTab() {
  const [voiceover, setVoiceover] = useState(false);
  const project = useProject();
  const audio = project.edit.audio;
  // one row per file: a second placement of a file (a clip split and moved apart) follows the file's own row
  const tracks = project.sources.filter((s) => s.hasAudio && s.role !== 'music' && s.role !== 'broll' && !s.instanceOf);
  const voices = tracks.filter((s) => s.role !== 'systemAudio');
  const setAudio = (fn: (a: EditState['audio']) => EditState['audio'], label: string, key?: string) => app().edit((e) => ({ ...e, audio: fn(e.audio) }), label, key ? `audio:${key}` : undefined);
  const label = (role: string) => ({ voice: 'Microphone', cameraA: 'Camera A', cameraB: 'Camera B', screen: 'Screen recording', systemAudio: 'System audio' })[role] ?? role;
  return (
    <>
      <Section title="Voice">
        {voices.length === 0 ? <div className="tiny dim">No voice track in this project.</div> : null}
        {voices.map((s) => (
          <label key={s.id} className="radio-row">
            <input type="radio" name={`master-${s.take ?? 'main'}`} checked={isMasterVoice(audio, s)} onChange={() => app().edit((e) => setMasterVoice(e, project.sources, s.id), 'Choose voice track')} />
            <span className="grow">
              <span style={{ fontWeight: 560 }}>{label(s.role)}</span>
              <span className="tiny dim" style={{ display: 'block' }}>{s.name}</span>
            </span>
            {isMasterVoice(audio, s) ? <span className="pill accent">Heard</span> : <span className="pill">Muted</span>}
          </label>
        ))}
        {voices.length > 1 ? <div className="tiny dim">One voice plays through every angle change. Other voice-bearing tracks stay muted so nothing doubles.</div> : null}
        <Toggle label="Voice cleanup" hint="Removes low rumble and evens the level. Identical in preview and export." checked={audio.voiceCleanup.enabled} onChange={(v) => setAudio((a) => ({ ...a, voiceCleanup: { ...a.voiceCleanup, enabled: v } }), 'Voice cleanup')} />
        {audio.voiceCleanup.enabled ? <Toggle label="Bypass to compare" hint="Hear the untouched recording." checked={audio.voiceCleanup.bypass} onChange={(v) => setAudio((a) => ({ ...a, voiceCleanup: { ...a.voiceCleanup, bypass: v } }), 'Bypass cleanup')} /> : null}
      </Section>
      <Section title="Levels">
        {tracks.map((s) => {
          const t = audio.tracks[s.id] ?? { gain: 1, muted: true };
          return (
            <div key={s.id} className="col" style={{ gap: 4 }}>
              <div className="row between">
                <span className="small" style={{ fontWeight: 540 }}>{label(s.role)}</span>
                <Button size="sm" variant="ghost" icon={t.muted ? 'eyeOff' : 'speaker'} on={!t.muted} onClick={() => setAudio((a) => ({ ...a, tracks: { ...a.tracks, [s.id]: { ...t, muted: !t.muted } } }), t.muted ? 'Unmute' : 'Mute')} aria-label={t.muted ? `Unmute ${label(s.role)}` : `Mute ${label(s.role)}`} />
              </div>
              <Slider min={0} max={2} value={t.gain} format={pct} onChange={(v) => setAudio((a) => ({ ...a, tracks: { ...a.tracks, [s.id]: { ...t, gain: v } } }), 'Level', s.id)} />
            </div>
          );
        })}
      </Section>
      <MusicSection project={project} />
      <SoundsSection project={project} />
      <Section title="AI voiceover">
        <button className="btn block" onClick={() => setVoiceover(true)}>
          Add voiceover…
        </button>
        <div className="tiny dim">Reads your script with a system voice, on this Mac. It is a synthetic voice, not a copy of yours.</div>
      </Section>
      {voiceover ? <VoiceoverSheet onClose={() => setVoiceover(false)} /> : null}
    </>
  );
}

