import { useEffect, useMemo, useState } from 'react';
import { applyOps, detectTyping, fmtTime, shortcutCaps, shortcutId, shortcutsOf, typingSpeedOps, type Appearance, type KeyStroke } from '@cutaway/core';
import { useApp, useProject } from '../../../state/store';
import { ensureKeys, keysKey, useData } from '../../../engine/parityData';
import { Icon } from '../../../ui/icons';
import { Segmented, Slider, Toggle } from '../../../ui/kit';
import { seekSource } from '../ops';
import { Reset, Section, setAppearance } from './shared';
import './parity.css';

export function ShortcutsTab() {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const ap = project.edit.appearance;
  const opt = shortcutsOf(ap);
  const screen = project.sources.find((s) => s.role === 'screen');
  const hasKeys = !!screen?.keysFile;
  const entry = useData<KeyStroke[]>(hasKeys ? keysKey(projectPath, screen!) : null);
  const [speed, setSpeed] = useState('2');
  useEffect(() => {
    if (hasKeys && entry.status === 'idle') void ensureKeys(projectPath, screen);
  }, [hasKeys, entry.status, projectPath, screen]);
  const keys = entry.value ?? [];
  const shortcuts = useMemo(() => keys.filter((k): k is Extract<KeyStroke, { e: 'shortcut' }> => k.e === 'shortcut'), [keys]);
  const typing = useMemo(() => detectTyping(keys), [keys]);
  const set = (patch: Partial<NonNullable<Appearance['shortcuts']>>, key: string) => setAppearance((a) => ({ ...a, shortcuts: { ...shortcutsOf(a), ...patch } }), 'Keyboard shortcuts', key);
  const toggleHidden = (id: string) => set({ hidden: opt.hidden.includes(id) ? opt.hidden.filter((h) => h !== id) : [...opt.hidden, id] }, `kshide:${id}`);

  const speedUp = () => {
    const app = useApp.getState();
    let added = 0;
    app.edit((e, p) => {
      // never inside locks, and never on top of a speed change that already exists
      const ops = typingSpeedOps(typing, [...e.locks, ...e.speeds], Number(speed));
      added = ops.length;
      return ops.length ? applyOps(e, ops, 'creator', p.revision + 1) : e;
    }, 'Speed up typing');
    app.toast(added ? `Sped up ${added} typing stretch${added === 1 ? '' : 'es'} to ${speed}×. Undo restores normal speed.` : 'Every typing stretch is already sped up or locked.');
  };

  if (!hasKeys) {
    return (
      <Section group="Keyboard shortcuts" title="Show keyboard shortcuts" icon="command">
        <div className="tiny dim">This recording has no keyboard data. Turn on “Record shortcuts” when recording in Cutaway (it needs Input Monitoring permission). Only shortcuts and typing rhythm are stored, never what you type.</div>
      </Section>
    );
  }
  return (
    <>
      <Section group="Keyboard shortcuts" title="Show keyboard shortcuts" icon="command">
        <Toggle label="Show shortcuts in the video" hint="Pressed shortcuts appear as key caps. Typed text is never recorded or shown." checked={opt.show} onChange={(v) => set({ show: v }, 'ksshow')} />
      </Section>
      {opt.show ? (
        <>
          <Section title="Label size" icon="command" action={<Reset show={opt.size !== 1} onClick={() => set({ size: 1 }, 'kssize')} />}>
            <Slider min={0.6} max={2} value={opt.size} onChange={(v) => set({ size: v }, 'kssize')} />
          </Section>
          <Section title="Position" icon="command">
            <Segmented full value={opt.position} onChange={(v) => set({ position: v }, 'kspos')} options={[{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }]} />
          </Section>
        </>
      ) : null}
      <Section title={`Recorded shortcuts${shortcuts.length ? ` · ${shortcuts.length}` : ''}`} icon="command">
        {entry.status === 'computing' ? (
          <div className="status-line"><span className="spinner" style={{ width: 12, height: 12 }} /> Reading keyboard data…</div>
        ) : entry.status === 'failed' ? (
          <div className="status-line bad">{entry.error}</div>
        ) : shortcuts.length === 0 ? (
          <div className="tiny dim">No shortcuts were pressed during this recording.</div>
        ) : (
          <div className="key-list">
            {shortcuts.map((k) => {
              const id = shortcutId(k);
              const hidden = opt.hidden.includes(id);
              return (
                <div key={id} className={`key-row${hidden ? ' off' : ''}`}>
                  <button className="when" onClick={() => seekSource(project, k.t + 0.05)} title="Jump here">{fmtTime(k.t)}</button>
                  <span className="caps">
                    {shortcutCaps(k.keys).map((c, i) => (
                      <span key={i} className="keycap">{c}</span>
                    ))}
                  </span>
                  <button className="btn ghost sm icon" onClick={() => toggleHidden(id)} aria-label={hidden ? 'Show this shortcut' : 'Hide this shortcut'} aria-pressed={!hidden} title={hidden ? 'Hidden in the video' : 'Shown in the video'}>
                    <Icon name={hidden ? 'eyeOff' : 'eye'} size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <Section group="Typing" title="Speed up typing" icon="speed">
        <div className="tiny dim">{typing.length ? `${typing.length} stretch${typing.length === 1 ? '' : 'es'} of continuous typing found (${typing.reduce((s, r) => s + (r.end - r.start), 0).toFixed(0)}s in total).` : 'No long typing stretches were found in this recording.'}</div>
        {typing.length ? (
          <>
            <Segmented full value={speed} onChange={setSpeed} options={[{ value: '1.5', label: '1.5×' }, { value: '2', label: '2×' }, { value: '3', label: '3×' }, { value: '4', label: '4×' }]} />
            <button className="btn block" onClick={speedUp}>Speed up typing</button>
            <div className="tiny dim">Adds speed changes you can adjust or remove on the clip. Locked ranges are left alone.</div>
          </>
        ) : null}
      </Section>
    </>
  );
}
