/**
 * Record a voiceover from the microphone, in the editor. The take starts where the playhead was when
 * recording began, and goes on the audio row as a clip of its own. While recording, the video can play
 * silently so you can talk over it. Nothing leaves this Mac.
 */
import { useEffect, useRef, useState } from 'react';
import { fmtTime, musicClipsOf, sourceFromProbe, uid, withMusic, withSources, type MediaSource } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback } from '../state/store';
import { downmix, encodeWav } from '../engine/wav';
import { Icon } from '../ui/icons';
import { Banner, Button, Modal, Toggle } from '../ui/kit';
import './voiceover.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Phase = 'idle' | 'countdown' | 'recording' | 'done' | 'saving';
interface Take {
  samples: Float32Array;
  rate: number;
  duration: number;
  url: string;
}

export function RecordVoiceoverSheet({ onClose }: { onClose(): void }) {
  const projectPath = useApp((s) => s.projectPath)!;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [playAlong, setPlayAlong] = useState(true);
  const [take, setTake] = useState<Take | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startOut = useRef(0);
  const volumeBefore = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  const listen = useRef<HTMLAudioElement>(null);

  // ── the microphone: opened when the sheet opens (and when another is picked), with a live level ──
  useEffect(() => {
    let live = true;
    let raf = 0;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        setError(null);
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
        if (live) setDevices(list);
        const ctx = new AudioContext();
        audioCtx.current = ctx;
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        let shown = 0;
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          // a quick rise and a slow fall, on a dB-like scale, so speech reads as a steady bar
          const target = Math.max(0, Math.min(1, 1 + Math.log10(rms + 1e-5) / 2.5));
          shown = target > shown ? target : shown * 0.92 + target * 0.08;
          setLevel(shown);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        const name = (e as { name?: string }).name;
        setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'Cutaway is not allowed to use the microphone. Allow it in System Settings › Privacy & Security › Microphone, then open this again.' : name === 'NotFoundError' ? 'No microphone was found. Connect one and open this again.' : `The microphone could not be opened: ${errorText(e)}`);
      }
    })();
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      void audioCtx.current?.close().catch(() => {});
      audioCtx.current = null;
    };
  }, [deviceId]);

  // leaving the sheet stops everything and puts the playback volume back
  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      if (recorder.current?.state === 'recording') recorder.current.stop();
      restorePlayback();
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => () => void (take && URL.revokeObjectURL(take.url)), [take]);

  function restorePlayback() {
    const pb = usePlayback.getState();
    if (volumeBefore.current !== null) {
      pb.setPlaying(false);
      pb.setVolume(volumeBefore.current);
      volumeBefore.current = null;
    }
  }

  const start = () => {
    if (!stream.current) return;
    if (take) URL.revokeObjectURL(take.url);
    setTake(null);
    setError(null);
    setPhase('countdown');
    setCount(3);
    usePlayback.getState().setPlaying(false);
    timers.current = [1, 2].map((n) => window.setTimeout(() => setCount(3 - n), n * 1000));
    timers.current.push(window.setTimeout(begin, 3000));
  };

  const begin = () => {
    const s = stream.current;
    if (!s) return;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(s);
    recorder.current = rec;
    rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    rec.onstop = () => void finish(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    startOut.current = usePlayback.getState().time;
    rec.start(250);
    if (playAlong) {
      // the video plays without its own sound, so the microphone hears only you
      const pb = usePlayback.getState();
      volumeBefore.current = pb.volume;
      pb.setVolume(0);
      pb.setPlaying(true);
    }
    setPhase('recording');
    const t0 = performance.now();
    const tick = () => {
      if (recorder.current?.state !== 'recording') return;
      setElapsed((performance.now() - t0) / 1000);
      timers.current.push(window.setTimeout(tick, 100));
    };
    tick();
  };

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    restorePlayback();
  };

  const finish = async (blob: Blob) => {
    try {
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      void ctx.close();
      const samples = downmix(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)));
      if (audio.duration < 0.3) throw new Error('The take was too short. Press Record and speak, then press Stop.');
      setTake({ samples, rate: audio.sampleRate, duration: audio.duration, url: URL.createObjectURL(blob) });
      setPhase('done');
    } catch (e) {
      setError(errorText(e));
      setPhase('idle');
    }
  };

  const add = async () => {
    if (!take) return;
    setPhase('saving');
    try {
      const { path } = await window.cutaway.native.saveRecording(projectPath, encodeWav(take.samples, take.rate));
      const [probe] = await window.cutaway.native.probe([`${projectPath}/${path}`]);
      if (!probe?.ok) throw new Error(probe?.error?.message ?? 'The recording could not be read back.');
      const app = useApp.getState();
      const n = (app.project?.sources.filter((s) => /^Voiceover \d+$/.test(s.name)).length ?? 0) + 1;
      const source: MediaSource = { ...sourceFromProbe({ ...probe, path }, 'music', { managed: true, origin: 'import', name: `Voiceover ${n}` }), note: 'Recorded from the microphone in the editor.' };
      app.patch((p) => withSources(p, [...p.sources, source]));
      let id = '';
      app.edit((e, p) => {
        const at = Math.min(startOut.current, Math.max(0, timeMapOf(p).outDuration - 0.3));
        id = uid('mus');
        // a voice: full level, never lowered under the recorded speech, no fades
        return withMusic(e, [...musicClipsOf(e, p.sources), { id, sourceId: source.id, start: at, sourceIn: 0, length: Math.max(0.2, source.duration), gain: 1, fadeIn: 0, fadeOut: 0, duck: false, meta: { origin: 'creator', revision: p.revision + 1 } }]);
      }, 'Add voiceover');
      if (id) app.select({ kind: 'music', id });
      app.toast(`Voiceover ${n} is on the audio row, starting at ${fmtTime(startOut.current, true)}.`);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setPhase('done');
    }
  };

  const busy = phase === 'countdown' || phase === 'recording' || phase === 'saving';
  return (
    <Modal
      title="Record voiceover"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <span className="tiny dim grow" style={{ alignSelf: 'center' }}>
            {phase === 'done' && take ? `Take · ${fmtTime(take.duration, true)} · starts at ${fmtTime(startOut.current, true)}` : `Starts at ${fmtTime(phase === 'recording' ? startOut.current : usePlayback.getState().time, true)} of the video`}
          </span>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {phase === 'done' ? (
            <Button variant="primary" icon="plus" data-testid="vo-add" onClick={() => void add()}>
              Add to timeline
            </Button>
          ) : null}
        </>
      }
    >
      <div className="rvo" data-testid="record-voiceover">
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {devices.length > 1 ? (
          <label className="field">
            <span className="field-label">Microphone</span>
            <select className="select" value={deviceId} disabled={busy} onChange={(e) => setDeviceId(e.target.value)} aria-label="Microphone">
              <option value="">System default</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="rvo-meter" aria-label="Microphone level" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${Math.round(level * 100)}%` }} className={level > 0.92 ? 'hot' : ''} />
        </div>
        <div className="rvo-stage">
          {phase === 'countdown' ? (
            <div className="rvo-count" data-testid="vo-countdown">{count}</div>
          ) : phase === 'recording' ? (
            <>
              <div className="rvo-time"><span className="rvo-dot" /> {fmtTime(elapsed, true)}</div>
              <button className="rvo-btn stop" onClick={stop} data-testid="vo-stop" aria-label="Stop recording">
                <span />
              </button>
            </>
          ) : phase === 'done' && take ? (
            <>
              <audio ref={listen} src={take.url} controls className="rvo-listen" />
              <Button icon="record" onClick={start} data-testid="vo-again">Record again</Button>
            </>
          ) : phase === 'saving' ? (
            <div className="rvo-time"><span className="spinner" /> Adding…</div>
          ) : (
            <button className="rvo-btn" onClick={start} disabled={!!error && !stream.current} data-testid="vo-record" aria-label="Start recording">
              <span />
            </button>
          )}
        </div>
        {phase === 'idle' || phase === 'done' ? (
          <Toggle label="Play the video while I record" hint="It plays without sound, so the microphone hears only you." checked={playAlong} onChange={setPlayAlong} />
        ) : null}
        <div className="tiny dim">
          <Icon name="mic" size={11} /> Recorded on this Mac and kept in the project folder. The take goes on the audio row where the playhead is now.
        </div>
      </div>
    </Modal>
  );
}
