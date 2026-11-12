import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '@cutaway/core';
import type { RecordEvent } from '@shared/api';
import { Icon, type IconName } from '../ui/icons';
import { Meter } from '../ui/kit';
import './record.css';

const ICON: Record<string, IconName> = { screen: 'screen', cameraA: 'camera', cameraB: 'camera', microphone: 'mic', system: 'speaker' };
const NAME: Record<string, string> = { screen: 'Screen', cameraA: 'Camera A', cameraB: 'Camera B', microphone: 'Microphone', system: 'System audio' };
const ORDER = ['screen', 'cameraA', 'cameraB', 'microphone', 'system'];

/**
 * The floating recording controller: a small always-on-top window that is
 * excluded from capture. It only reflects recorder events and sends
 * pause / resume / stop; the main window turns the finished take into sources.
 */
export function Controller() {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [lost, setLost] = useState<Set<string>>(new Set());
  const [flow, setFlow] = useState<Record<string, boolean>>({});
  const [mic, setMic] = useState<number | null>(null);
  const [busy, setBusy] = useState<'stop' | 'pause' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const lastFrames = useRef<Record<string, number>>({});

  useEffect(() => {
    const seen = new Set<string>();
    const add = (ids: string[]) => {
      let changed = false;
      for (const id of ids) if (!seen.has(id)) (seen.add(id), (changed = true));
      if (changed) setSources(ORDER.filter((id) => seen.has(id)).concat([...seen].filter((id) => !ORDER.includes(id))));
    };
    return window.cutaway.record.onEvent((e: RecordEvent) => {
      switch (e.type) {
        case 'started':
          add(e.sources.map((s) => s.id));
          break;
        case 'tick': {
          setElapsed(e.elapsed);
          add(Object.keys(e.frames));
          const moving: Record<string, boolean> = {};
          for (const [id, n] of Object.entries(e.frames)) moving[id] = n > (lastFrames.current[id] ?? -1);
          lastFrames.current = e.frames;
          setFlow(moving);
          break;
        }
        case 'levels':
          if (e.microphone !== undefined) (add(['microphone']), setMic(e.microphone));
          if (e.system !== undefined) add(['system']);
          break;
        case 'paused':
          setPaused(true);
          setElapsed(e.elapsed);
          setBusy(null);
          break;
        case 'resumed':
          setPaused(false);
          setBusy(null);
          break;
        case 'source-lost':
          setLost((s) => new Set(s).add(e.source));
          setNote(`${NAME[e.source] ?? e.source} lost; the rest is still recording`);
          break;
        case 'source-restored':
          setLost((s) => {
            const n = new Set(s);
            n.delete(e.source);
            return n;
          });
          setNote(null);
          break;
        case 'disk-low':
          setNote('Disk almost full; stopping safely');
          break;
        case 'error':
          if (!e.fatal) setNote(e.message);
          break;
      }
    });
  }, []);

  const stop = () => {
    setBusy('stop');
    window.cutaway.record.stop().catch(() => setBusy(null));
  };
  const togglePause = () => {
    setBusy('pause');
    (paused ? window.cutaway.record.resume() : window.cutaway.record.pause()).catch(() => setBusy(null));
  };

  return (
    <div className="controller">
      <div className="controller-pill" role="toolbar" aria-label="Recording controls" title={note ?? 'Drag to move. This controller is not recorded.'}>
        <span className={`rec-dot${paused ? '' : ' live'}`} style={paused ? { background: 'var(--ai)', boxShadow: 'none' } : undefined} aria-hidden />
        <span className="time mono" aria-live="off">{fmtTime(elapsed, true)}</span>
        <div className="chips">
          {sources.map((id) => {
            const isLost = lost.has(id);
            const video = id === 'screen' || id.startsWith('camera');
            const idle = !isLost && video && !paused && flow[id] === false;
            return (
              <span key={id} className={`chip${isLost ? ' lost' : idle ? ' idle' : ''}`} title={`${NAME[id] ?? id}: ${isLost ? 'lost' : paused ? 'paused' : idle ? 'no new frames' : 'recording'}`} aria-label={`${NAME[id] ?? id} ${isLost ? 'lost' : 'recording'}`}>
                <Icon name={ICON[id] ?? 'film'} size={13} />
              </span>
            );
          })}
          {sources.includes('microphone') ? (
            <span className="level">
              <Meter db={paused ? null : mic} />
            </span>
          ) : null}
        </div>
        <button className="ctl" onClick={togglePause} disabled={busy !== null} title={paused ? 'Resume' : 'Pause'} aria-label={paused ? 'Resume recording' : 'Pause recording'}>
          <Icon name={paused ? 'record' : 'pause'} size={16} />
        </button>
        <button className="ctl stop" onClick={stop} disabled={busy === 'stop'} title="Stop recording (⌃⌥⌘R)" aria-label="Stop recording">
          {busy === 'stop' ? <span className="spinner" style={{ borderTopColor: 'var(--accent-ink)' }} /> : <Icon name="stop" size={16} />}
        </button>
      </div>
    </div>
  );
}
