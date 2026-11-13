import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/icons';
import './notes.css';

const TEXT_KEY = 'cutaway.notes.text';
const PREFS_KEY = 'cutaway.notes.prefs';
const OPEN_KEY = 'cutaway.notes.open';

interface NotePrefs {
  size: number;
  opacity: number;
  speed: number;
}
const DEFAULTS: NotePrefs = { size: 18, opacity: 0.86, speed: 28 };

function loadPrefs(): NotePrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<NotePrefs>) };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Speaker notes: a small translucent always-on-top notepad in its own window.
 * The app leaves the window out of every recording. Text and settings stay on
 * this Mac (localStorage).
 */
export function Notes() {
  const [text, setText] = useState(() => localStorage.getItem(TEXT_KEY) ?? '');
  const [prefs, setPrefs] = useState<NotePrefs>(loadPrefs);
  const [settings, setSettings] = useState(false);
  const [playing, setPlaying] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.body.classList.add('controller-body');
    document.title = 'Speaker notes';
  }, []);
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(TEXT_KEY, text), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs]);

  // Prompter: scroll the notes upward at a steady pace.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      const el = area.current;
      if (!el) return;
      carry += ((now - last) / 1000) * prefs.speed;
      last = now;
      const px = Math.floor(carry);
      if (px > 0) {
        carry -= px;
        el.scrollTop += px;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return setPlaying(false);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, prefs.speed]);

  const close = () => {
    localStorage.setItem(OPEN_KEY, '0');
    void window.cutaway.app.notesWindow(false).catch(() => window.close());
  };
  const slider = (label: string, key: keyof NotePrefs, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="notes-slider">
      <span>
        {label}
        <b>{fmt(prefs[key])}</b>
      </span>
      <input className="slider" type="range" min={min} max={max} step={step} value={prefs[key]} style={{ ['--p' as string]: `${((prefs[key] - min) / (max - min)) * 100}%` }} onChange={(e) => setPrefs({ ...prefs, [key]: Number(e.target.value) })} aria-label={label} />
    </label>
  );

  return (
    <div className="notes-window" style={{ background: `rgba(21, 22, 25, ${prefs.opacity})` }}>
      <header className="notes-head">
        <button onClick={() => setPlaying(!playing)} title={playing ? 'Pause scrolling' : 'Scroll the notes like a prompter'} aria-label={playing ? 'Pause scrolling' : 'Start scrolling'} aria-pressed={playing}>
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <span className="notes-title">Speaker notes</span>
        <span className="notes-badge" title="This window is left out of every recording">
          <Icon name="eyeOff" size={10} /> Not recorded
        </span>
        <span className="grow" />
        <button onClick={() => setSettings(!settings)} title="Notes settings" aria-label="Notes settings" aria-pressed={settings}>
          <Icon name="gear" size={14} />
        </button>
        <button onClick={close} title="Close speaker notes" aria-label="Close speaker notes">
          <Icon name="x" size={13} />
        </button>
      </header>
      {settings ? (
        <div className="notes-settings">
          {slider('Prompter speed', 'speed', 6, 90, 1, (v) => `${Math.round(v)}`)}
          {slider('Notepad opacity', 'opacity', 0.35, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
          {slider('Font size', 'size', 12, 40, 1, (v) => `${Math.round(v)} pt`)}
          <button className="notes-reset" onClick={() => setPrefs(DEFAULTS)} disabled={JSON.stringify(prefs) === JSON.stringify(DEFAULTS)}>
            Reset
          </button>
        </div>
      ) : null}
      <textarea ref={area} className="notes-text" style={{ fontSize: prefs.size }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type what you want to say. Only you can see this." spellCheck aria-label="Speaker notes" />
    </div>
  );
}
