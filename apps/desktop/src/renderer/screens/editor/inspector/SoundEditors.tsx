import { useEffect, useRef, useState } from 'react';
import { BUILTIN_SOUNDS, builtinSound, fmtTime, musicClipsOf, musicGainAt, soundsOf, type MusicClip, type Project, type SoundCue, type SoundEffect } from '@cutaway/core';
import { timeMapOf, usePlayback } from '../../../state/store';
import { Icon } from '../../../ui/icons';
import { Button, Field, Slider, Toggle } from '../../../ui/kit';
import { removeSelected, seekSource } from '../ops';
import { addMusic, addSoundAtPlayhead, addVolumePoint, clearVolumePoints, addSoundsEverywhere, defaultCue, fitMusicToVideo, patchMusic, patchSound, soundPlacementCounts, type SoundPlacement } from '../titleSoundOps';
import { CueField, listen } from './CueField';
import { Section, app, pct } from './shared';
import './titles-sound.css';

const secs = (v: number) => `${v.toFixed(1)}s`;
const del = <Button variant="ghost" size="sm" icon="trash" onClick={removeSelected} aria-label="Remove" title="Remove (⌫)" />;

export function cueName(cue: SoundCue, project: Project): string {
  return builtinSound(cue.builtin)?.name ?? project.sources.find((s) => s.id === cue.sourceId)?.name ?? 'Missing sound';
}

/** The clip's level over its length: fades at both ends, drawn the way the mixer applies them. */
function Envelope({ clip, fileLength }: { clip: MusicClip; fileLength?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 300;
    const h = 44;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const y = (t: number) => h - 5 - Math.min(1, musicGainAt(clip, clip.start + t, fileLength)) * (h - 10);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x++) ctx.lineTo(x, y(Math.min(clip.length - 1e-4, (x / w) * clip.length)));
    ctx.lineTo(w, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(88, 213, 162, .55)');
    g.addColorStop(1, 'rgba(88, 213, 162, .08)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    for (let x = 0; x <= w; x++) ctx[x ? 'lineTo' : 'moveTo'](x, y(Math.min(clip.length - 1e-4, (x / w) * clip.length)));
    ctx.strokeStyle = '#6fe3b0';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [clip, fileLength]);
  return <canvas ref={ref} className="mu-env" aria-hidden />;
}

/** Editor for the selected music clip. Every time here is a second of the finished video. */
export function MusicEditor({ project, clip }: { project: Project; clip: MusicClip }) {
  const file = project.sources.find((s) => s.id === clip.sourceId);
  const outDuration = timeMapOf(project).outDuration;
  const files = project.sources.filter((s) => s.role === 'music' || s.id === clip.sourceId);
  const fileLength = file?.duration ?? clip.sourceIn + clip.length;
  const set = (patch: Partial<MusicClip>, label: string, key?: string) => patchMusic(clip.id, patch, label, key);
  const pastEnd = clip.start + clip.length > outDuration + 0.05;
  return (
    <Section title="Music" action={del}>
      <div className="row between tiny dim mono">
        <span>
          {fmtTime(clip.start, true)} – {fmtTime(clip.start + clip.length, true)}
        </span>
        <span title="Music is placed on the finished video, so cuts never chop it">in the finished video</span>
      </div>
      <Envelope clip={clip} fileLength={file?.duration} />
      <Field label="File">
        <select className="select" value={clip.sourceId} onChange={(e) => set({ sourceId: e.target.value, sourceIn: 0 }, 'Replace music')} aria-label="Music file">
          {files.map((f) => (
            <option key={f.id} value={f.id}>{f.name}{f.available ? '' : ' (missing)'}</option>
          ))}
        </select>
      </Field>
      <Slider label="Level" min={0} max={1} value={clip.gain} format={pct} onChange={(v) => set({ gain: v }, 'Music level', 'gain')} />
      <div className="te-row2">
        <Slider label="Fade in" min={0} max={Math.min(8, clip.length)} step={0.1} value={clip.fadeIn} format={secs} onChange={(v) => set({ fadeIn: v }, 'Fade in', 'fadeIn')} />
        <Slider label="Fade out" min={0} max={Math.min(8, clip.length)} step={0.1} value={clip.fadeOut} format={secs} onChange={(v) => set({ fadeOut: v }, 'Fade out', 'fadeOut')} />
      </div>
      <Toggle label="Lower under speech" hint="Drops the music while someone is talking, then brings it back." checked={clip.duck} onChange={(v) => set({ duck: v }, 'Music ducking')} />
      <Slider label="Starts at" min={0} max={Math.max(0.1, outDuration - 0.2)} step={0.05} value={Math.min(clip.start, Math.max(0.1, outDuration - 0.2))} format={(v) => fmtTime(v, true)} onChange={(v) => set({ start: v }, 'Move music', 'start')} />
      <Toggle label="Loop" hint="Starts the file again when it runs out, so a short piece can play under the whole video." checked={!!clip.loop} onChange={(v) => set(v ? { loop: true } : { loop: false, length: Math.min(clip.length, fileLength - clip.sourceIn) }, v ? 'Loop music' : 'Stop looping music')} />
      <Slider label="Length" min={0.2} max={Math.max(0.3, clip.loop ? Math.max(outDuration - clip.start, clip.length) : fileLength - clip.sourceIn)} step={0.05} value={clip.length} format={(v) => fmtTime(v, true)} onChange={(v) => set({ length: v }, 'Trim music', 'length')} />
      {clip.loop || fileLength - clip.length > 0.3 ? <Slider label="Begins inside the file at" min={0} max={Math.max(0.1, clip.loop ? fileLength - 0.2 : fileLength - clip.length)} step={0.05} value={Math.min(clip.sourceIn, Math.max(0, clip.loop ? fileLength - 0.2 : fileLength - clip.length))} format={(v) => fmtTime(v, true)} onChange={(v) => set({ sourceIn: v }, 'Slip music', 'sourceIn')} /> : null}
      {pastEnd ? (
        <Button icon="scissors" onClick={() => fitMusicToVideo(clip.id)}>
          End with the video and fade out
        </Button>
      ) : null}
      <Field label="Volume over time">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Button size="sm" icon="plus" data-testid="music-point-add" onClick={() => addVolumePoint(clip.id, usePlayback.getState().time - clip.start)} title="Adds a point where the playhead is, at the level the music has there">
            Point at the playhead
          </Button>
          {clip.volume?.length ? (
            <Button size="sm" variant="ghost" data-testid="music-point-clear" onClick={() => clearVolumePoints(clip.id)}>
              Flatten ({clip.volume.length} {clip.volume.length === 1 ? 'point' : 'points'})
            </Button>
          ) : null}
        </div>
      </Field>
      <div className="tiny dim">On the music row: double-click to add a volume point, drag a point up or down to make the music louder or quieter there, double-click a point to remove it. ⌘B or the playhead scissors split the selected music. Cutting or moving footage leaves the music where it is.</div>
    </Section>
  );
}

/** Editor for the selected sound effect. */
export function SoundEditor({ project, sound }: { project: Project; sound: SoundEffect }) {
  const map = timeMapOf(project);
  const kept = map.isKept(sound.start);
  return (
    <Section title="Sound effect" action={del}>
      <div className="row between tiny dim mono">
        <span>{fmtTime(sound.start, true)}</span>
        <span title="Position in the finished video">{kept ? `→ ${fmtTime(map.toOutput(sound.start), true)}` : 'this moment is cut'}</span>
      </div>
      {!kept ? <div className="tiny dim">The moment this sound belongs to was cut, so it is not heard. Restore the footage or move the sound.</div> : null}
      <CueField allowNone={false} value={{ builtin: sound.builtin, sourceId: sound.sourceId, gain: sound.gain }} sources={project.sources} onChange={(cue, coalesce) => cue && patchSound(sound.id, { cue }, 'Sound', coalesce ? 'cue' : undefined)} />
      <Slider label="At" min={0} max={Math.max(0.1, project.duration - 0.05)} step={0.02} value={Math.min(sound.start, project.duration)} format={(v) => fmtTime(v, true)} onChange={(v) => patchSound(sound.id, { start: v }, 'Move sound', 'start')} />
      <div className="row wrap">
        <Button icon="play" onClick={() => listen(sound)}>Listen</Button>
        <Button icon="cursor" onClick={() => seekSource(project, sound.start)}>Go to it</Button>
      </div>
      {builtinSound(sound.builtin)?.hit ? <div className="tiny dim">{sound.builtin === 'riser' ? 'A riser builds up before this moment and stops on it.' : 'This sound peaks on the moment, so it starts a little before it.'}</div> : null}
    </Section>
  );
}

/** Music in the Audio tab: the clips in the video, and adding one. */
export function MusicSection({ project }: { project: Project }) {
  const clips = musicClipsOf(project.edit, project.sources);
  const files = project.sources.filter((s) => s.role === 'music' && s.hasAudio);
  const name = (id: string) => project.sources.find((s) => s.id === id)?.name ?? 'Missing file';
  return (
    <Section title="Music">
      {clips.length ? (
        <div className="mu-list">
          {clips.map((c) => (
            <button key={c.id} className="mu-row" data-testid="music-row" onClick={() => (app().select({ kind: 'music', id: c.id }), usePlayback.getState().seek(Math.min(c.start, Math.max(0, timeMapOf(project).outDuration - 0.05))))}>
              <span className="ico"><Icon name="music" size={14} /></span>
              <span className="n">
                <b>{name(c.sourceId)}</b>
                <span>
                  {fmtTime(c.start)} – {fmtTime(c.start + c.length)} · {pct(c.gain)}{c.duck ? ' · lowers under speech' : ''}
                </span>
              </span>
              <Icon name="chevron" size={13} />
            </button>
          ))}
        </div>
      ) : null}
      {files.length === 0 ? (
        <div className="tiny dim">Add a WAV, MP3 or M4A in Sources and give it the Music role. Cutaway does not supply music.</div>
      ) : (
        <Field label={clips.length ? 'Add another piece at the playhead' : 'Add music'}>
          <select className="select" data-testid="music-add" value="" onChange={(e) => e.target.value && addMusic(e.target.value)} aria-label="Add music">
            <option value="">Choose a file…</option>
            {files.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Field>
      )}
      {clips.length ? <div className="tiny dim">Music sits on the finished video: it is not chopped when footage is cut. Pieces can overlap.</div> : null}
    </Section>
  );
}

const PLACES: { id: SoundPlacement; label: string }[] = [
  { id: 'views', label: 'On every view change' },
  { id: 'cuts', label: 'On every cut' },
  { id: 'texts', label: 'As every text appears' },
];

/** Sound effects in the Audio tab: add one at the playhead, or one on every cut, view change or text. */
export function SoundsSection({ project }: { project: Project }) {
  const [cue, setCue] = useState<SoundCue>(defaultCue('pop'));
  const sounds = soundsOf(project.edit);
  const counts = soundPlacementCounts(project);
  const map = timeMapOf(project);
  return (
    <Section title="Sound effects">
      <CueField allowNone={false} value={cue} sources={project.sources} onChange={(c) => c && setCue(c)} />
      <Button icon="plus" data-testid="sound-add" onClick={() => addSoundAtPlayhead(cue)}>
        Add at the playhead
      </Button>
      <div className="mu-every">
        {PLACES.map((p) => (
          <button key={p.id} className="btn" data-testid={`sound-every-${p.id}`} disabled={counts[p.id] === 0} onClick={() => addSoundsEverywhere(p.id, cue)}>
            <span>{p.label}</span>
            <span className="count">{counts[p.id]}</span>
          </button>
        ))}
      </div>
      {sounds.length ? (
        <div className="mu-list">
          {sounds.map((s) => (
            <button key={s.id} className="mu-row" onClick={() => (app().select({ kind: 'sound', id: s.id }), seekSource(project, s.start))}>
              <span className="ico fx"><Icon name="bell" size={14} /></span>
              <span className="n">
                <b>{cueName(s, project)}</b>
                <span>{map.isKept(s.start) ? fmtTime(map.toOutput(s.start), true) : 'cut with its footage'}</span>
              </span>
              <Icon name="chevron" size={13} />
            </button>
          ))}
        </div>
      ) : null}
      <div className="tiny dim">The {BUILTIN_SOUNDS.length} built-in sounds are made by Cutaway itself. A sound belongs to its moment: cut the moment and the sound goes with it.</div>
    </Section>
  );
}
