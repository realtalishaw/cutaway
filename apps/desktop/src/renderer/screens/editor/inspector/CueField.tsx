import { BUILTIN_SOUNDS, DEFAULT_SOUND_GAIN, type MediaSource, type SoundCue } from '@cutaway/core';
import { useApp, usePlayback } from '../../../state/store';
import { playBuiltin, playFile } from '../../../engine/soundPlayer';
import { sourceUrl } from '../../../engine/media';
import { Icon } from '../../../ui/icons';
import { Slider } from '../../../ui/kit';
import { pct } from './shared';
import './titles-sound.css';

/** Audio files in the project that can be used as a sound effect. */
export function soundFiles(sources: MediaSource[]): MediaSource[] {
  return sources.filter((s) => s.kind === 'audio' && s.hasAudio && s.role === 'music');
}

/** Plays a cue once, at the editor's volume, so a sound can be heard before it is used. */
export function listen(cue: SoundCue) {
  const { project, projectPath } = useApp.getState();
  const volume = usePlayback.getState().volume || 1;
  if (cue.builtin) return void playBuiltin(cue.builtin, cue.gain * volume);
  const file = project?.sources.find((s) => s.id === cue.sourceId);
  if (file?.available && projectPath) playFile(sourceUrl(projectPath, file), cue.gain * volume);
}

/**
 * Chooses a sound: one of the built-in synthesised ones, or one of the creator's own audio files.
 * Choosing a sound plays it once.
 */
export function CueField({ value, onChange, sources, allowNone = true, levelLabel = 'Level' }: { value: SoundCue | null; onChange(cue: SoundCue | null, coalesce?: boolean): void; sources: MediaSource[]; allowNone?: boolean; levelLabel?: string }) {
  const files = soundFiles(sources);
  const gain = value?.gain ?? DEFAULT_SOUND_GAIN;
  const pick = (cue: SoundCue) => {
    onChange(cue);
    listen(cue);
  };
  return (
    <div className="cue">
      <div className="cue-chips" role="group" aria-label="Sound">
        {allowNone ? (
          <button className="cue-chip" aria-pressed={!value} onClick={() => onChange(null)}>
            None
          </button>
        ) : null}
        {BUILTIN_SOUNDS.map((s) => (
          <button key={s.id} className="cue-chip" aria-pressed={value?.builtin === s.id} title={s.description} onClick={() => pick({ builtin: s.id, gain })}>
            <Icon name="play" size={10} />
            {s.name}
          </button>
        ))}
      </div>
      {files.length ? (
        <div className="cue-row">
          <select className="select" aria-label="Your own sound file" value={value && !value.builtin ? (value.sourceId ?? '') : ''} onChange={(e) => e.target.value && pick({ builtin: null, sourceId: e.target.value, gain })}>
            <option value="">Use one of your audio files…</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
      ) : null}
      {value ? <Slider label={levelLabel} min={0.05} max={1} value={gain} format={pct} onChange={(v) => onChange({ ...value, gain: v }, true)} /> : null}
    </div>
  );
}
