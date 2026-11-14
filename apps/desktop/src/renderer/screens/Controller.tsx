import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '@cutaway/core';
import type { RecordEvent } from '@shared/api';
import { bindingOf, formatCombo } from '@shared/keymap';
import { Icon, type IconName } from '../ui/icons';
import { Meter } from '../ui/kit';
import './record.css';

const ICON: Record<string, IconName> = { screen: 'screen', cameraA: 'camera', cameraB: 'camera', microphone: 'mic', system: 'speaker' };
const NAME: Record<string, string> = { screen: 'Screen', cameraA: 'Camera A', cameraB: 'Camera B', microphone: 'Microphone', system: 'System audio' };
const ORDER = ['screen', 'cameraA', 'cameraB', 'microphone', 'system'];

/**
 * The floating recording control: a small always-on-top window that is
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
  const [flags, setFlags] = useState(0);
  const [flagged, setFlagged] = useState(false);
  const [flagKeys, setFlagKeys] = useState(formatCombo(bindingOf('flag', null)));
  const lastFrames = useRef<Record<string, number>>({});
  // The floating camera bubble: only offered when the take has a camera.
  const [selfView, setSelfView] = useState<{ visible: boolean; cameras: string[] }>({ visible: false, cameras: [] });
  const [prompter, setPrompter] = useState(false);
  useEffect(() => window.cutaway.app.onPrompter((s) => setPrompter(s.visible)), []);
  useEffect(() => window.cutaway.app.onSelfView(setSelfView), []);

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
        case 'flag':
          setFlags(e.count);
          setFlagged(true);
          setTimeout(() => setFlagged(false), 900);
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

  useEffect(() => {
    // This window has no app state of its own; read the shortcut straight from settings.
    void window.cutaway.app.getSettings().then((st) => setFlagKeys(formatCombo(bindingOf('flag', st.shortcuts)))).catch(() => {});
  }, []);

  const flag = () => void window.cutaway.record.flag().catch(() => {});
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
      <div className="controller-pill" role="toolbar" aria-label="Recording controls" title={note ?? 'Drag to move. This control is not recorded.'}>
        <button className="stop" onClick={stop} disabled={busy === 'stop'} title="Stop recording (⌃⌥⌘R)" aria-label="Stop recording">
          {busy === 'stop' ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : <Icon name="stop" size={16} />}
        </button>
        <span className={`time${paused ? ' paused' : ''}`} aria-live="off">{fmtTime(elapsed, true)}</span>
        <span className="sep" aria-hidden />
        <div className="chips">
          {sources.map((id) => {
            const isLost = lost.has(id);
            const video = id === 'screen' || id.startsWith('camera');
            const idle = !isLost && video && !paused && flow[id] === false;
            return (
              <span key={id} className={`chip${isLost ? ' lost' : idle ? ' idle' : ''}`} title={`${NAME[id] ?? id}: ${isLost ? 'lost' : paused ? 'paused' : idle ? 'no new frames' : 'recording'}`} aria-label={`${NAME[id] ?? id} ${isLost ? 'lost' : 'recording'}`}>
                <Icon name={ICON[id] ?? 'film'} size={14} />
              </span>
            );
          })}
          {sources.includes('microphone') ? (
            <span className="level">
              <Meter db={paused ? null : mic} />
            </span>
          ) : null}
        </div>
        <span className="sep" aria-hidden />
        <button className={`ctl flag${flagged ? ' hit' : ''}`} onClick={flag} disabled={busy === 'stop'} data-testid="controller-flag" title={`Flag this moment${flagKeys ? ` (${flagKeys})` : ''}. Flags show up on the timeline.`} aria-label={`Flag this moment. ${flags} flagged so far.`}>
          <Icon name="flag" size={16} />
          {flags > 0 ? <span className="count">{flags}</span> : null}
        </button>
        {selfView.cameras.length > 0 ? (
          <button className={`ctl${selfView.visible ? '' : ' dim-off'}`} onClick={() => void window.cutaway.app.selfView('toggle').catch(() => {})} data-testid="controller-selfview" aria-pressed={selfView.visible} title={selfView.visible ? 'Hide your camera bubble (the camera keeps recording)' : 'Show your camera in a floating bubble. It is not recorded.'} aria-label={selfView.visible ? 'Hide the camera bubble' : 'Show the camera bubble'}>
            <Icon name={selfView.visible ? 'eye' : 'eyeOff'} size={16} />
          </button>
        ) : null}
        <button className={`ctl${prompter ? '' : ' dim-off'}`} onClick={() => void window.cutaway.app.notesWindow('toggle').catch(() => {})} data-testid="controller-prompter" aria-pressed={prompter} title={prompter ? 'Hide the teleprompter (it keeps its place)' : 'Show the teleprompter. It is not recorded.'} aria-label={prompter ? 'Hide the teleprompter' : 'Show the teleprompter'}>
          <Icon name="text" size={16} />
        </button>
        <button className="ctl" onClick={togglePause} disabled={busy !== null} title={paused ? 'Resume' : 'Pause'} aria-label={paused ? 'Resume recording' : 'Pause recording'}>
          <Icon name={paused ? 'play' : 'pause'} size={17} />
        </button>
      </div>
    </div>
  );
}
