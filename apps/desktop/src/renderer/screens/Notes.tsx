import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PrompterPlace } from '@shared/api';
import { Icon } from '../ui/icons';
import './notes.css';

const TEXT_KEY = 'cutaway.notes.text';
const PREFS_KEY = 'cutaway.prompter.prefs';
const OPEN_KEY = 'cutaway.notes.open';

interface PrompterPrefs {
  /** Text size, px. */
  size: number;
  /** Reading pace, words per minute. */
  wpm: number;
  opacity: number;
  /** Flipped left to right, for prompter glass. */
  mirror: boolean;
  /** Start scrolling when the recording starts, pause and stop with it. */
  followTake: boolean;
}
const DEFAULTS: PrompterPrefs = { size: 30, wpm: 140, opacity: 0.82, mirror: false, followTake: true };
const WPM = { min: 60, max: 260, step: 10 };
const SIZE = { min: 16, max: 72, step: 2 };
/** Where the line being read sits, as a fraction of the window's height. */
const READ_AT = 0.32;

function loadPrefs(): PrompterPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PrompterPrefs>) };
  } catch {
    return DEFAULTS;
  }
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const words = (s: string) => (s.match(/\S+/g) ?? []).length;
const fmtLeft = (s: number) => (s < 60 ? `${Math.max(0, Math.round(s))} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

const PLACES: { id: PrompterPlace; label: string; hint: string }[] = [
  { id: 'top', label: 'Under the camera', hint: 'Top centre, so your eyes stay near the lens' },
  { id: 'left', label: 'Left side', hint: 'A tall column on the left' },
  { id: 'right', label: 'Right side', hint: 'A tall column on the right' },
  { id: 'bottom', label: 'Bottom', hint: 'Low and centred, above the controls' },
  { id: 'camera', label: 'Over my camera bubble', hint: 'Right on top of your camera preview' },
];

/**
 * The teleprompter: your script in big text, scrolling past a reading line at a steady words-per-minute pace.
 * It sits in its own always-on-top window that the recorder leaves out of every capture, so you can put it
 * over your screen or your camera and it never shows in the video. It starts, pauses and stops with the take.
 * The script and settings stay on this Mac.
 */
export function Notes() {
  const [text, setText] = useState(() => localStorage.getItem(TEXT_KEY) ?? '');
  const [prefs, setPrefs] = useState<PrompterPrefs>(loadPrefs);
  const [mode, setMode] = useState<'prompt' | 'edit'>(() => ((localStorage.getItem(TEXT_KEY) ?? '').trim() ? 'prompt' : 'edit'));
  const [panel, setPanel] = useState<'settings' | 'place' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState<'off' | 'on' | 'paused'>('off');
  const [left, setLeft] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pos = useRef(0);
  const geom = useRef({ height: 1, stage: 1, pxPerWord: 1 });
  const total = words(text);

  useEffect(() => {
    document.body.classList.add('controller-body');
    document.title = 'Teleprompter';
  }, []);
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(TEXT_KEY, text), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs]);

  const paint = useCallback(() => {
    const el = body.current;
    if (el) el.style.transform = `translateY(${-pos.current}px)`;
    const g = geom.current;
    const wordsLeft = Math.max(0, (g.height - pos.current) / g.pxPerWord);
    setLeft(total ? (wordsLeft / prefs.wpm) * 60 : null);
  }, [total, prefs.wpm]);

  // how tall the script is and how many pixels one word takes, so the pace is in words per minute at any size
  const measure = useCallback(() => {
    const el = body.current;
    const st = stage.current;
    if (!el || !st) return;
    // the first line starts on the reading line, and the last one can scroll up to it
    const sh = st.clientHeight;
    el.style.paddingTop = `${Math.round(sh * READ_AT)}px`;
    el.style.paddingBottom = `${Math.round(sh * (1 - READ_AT))}px`;
    const h = el.scrollHeight - Math.round(sh * READ_AT) - Math.round(sh * (1 - READ_AT));
    geom.current = { height: Math.max(1, h), stage: sh, pxPerWord: Math.max(0.01, h / Math.max(1, total)) };
    pos.current = clamp(pos.current, 0, geom.current.height);
    paint();
  }, [total, paint]);
  useLayoutEffect(() => {
    if (mode !== 'prompt') return;
    measure();
    const ro = new ResizeObserver(measure);
    if (stage.current) ro.observe(stage.current);
    return () => ro.disconnect();
  }, [mode, measure, prefs.size, text]);

  // scrolling: a steady pace in words per minute
  useEffect(() => {
    if (!playing || mode !== 'prompt') return;
    let raf = 0;
    let last = performance.now();
    let shown = 0;
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      pos.current += (prefs.wpm / 60) * geom.current.pxPerWord * dt;
      const el = body.current;
      if (el) el.style.transform = `translateY(${-pos.current}px)`;
      if (now - shown > 500) {
        shown = now;
        paint();
      }
      if (pos.current >= geom.current.height) {
        pos.current = geom.current.height;
        paint();
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, mode, prefs.wpm, paint]);

  // follow the take: the recorder tells every Cutaway window when it starts, pauses, resumes and stops
  const follow = useRef(prefs.followTake);
  follow.current = prefs.followTake;
  useEffect(
    () =>
      window.cutaway.record.onEvent((e) => {
        if (e.type === 'started') {
          setRecording('on');
          if (follow.current && text.trim()) {
            setMode('prompt');
            setPanel(null);
            setPlaying(true);
          }
        } else if (e.type === 'paused') {
          setRecording('paused');
          if (follow.current) setPlaying(false);
        } else if (e.type === 'resumed') {
          setRecording('on');
          if (follow.current) setPlaying(true);
        } else if (e.type === 'stopped' || e.type === 'crashed') {
          setRecording('off');
          if (follow.current) setPlaying(false);
        }
      }),
    [text],
  );

  const nudge = useCallback(
    (lines: number) => {
      pos.current = clamp(pos.current + lines * prefs.size * 1.35, 0, geom.current.height);
      paint();
    },
    [prefs.size, paint],
  );
  const restart = () => {
    pos.current = 0;
    paint();
  };

  // keys while the window has focus (it does not take focus during a take, so the recording is undisturbed)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== 'prompt' || (e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === ' ') setPlaying((p) => !p);
      else if (e.key === 'ArrowUp') setPrefs((p) => ({ ...p, wpm: clamp(p.wpm + WPM.step, WPM.min, WPM.max) }));
      else if (e.key === 'ArrowDown') setPrefs((p) => ({ ...p, wpm: clamp(p.wpm - WPM.step, WPM.min, WPM.max) }));
      else if (e.key === 'ArrowLeft') nudge(-1);
      else if (e.key === 'ArrowRight') nudge(1);
      else if (e.key === 'Home') restart();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const close = () => {
    localStorage.setItem(OPEN_KEY, '0');
    void window.cutaway.app.notesWindow(false).catch(() => window.close());
  };
  const place = (where: PrompterPlace) => {
    setPanel(null);
    void window.cutaway.app.prompterPlace(where).then((ok) => {
      if (!ok) {
        setNote('Your camera bubble is not showing. Turn it on from the recording controls, then try again.');
        setTimeout(() => setNote(null), 4000);
      }
    });
  };
  const set = <K extends keyof PrompterPrefs>(k: K, v: PrompterPrefs[K]) => setPrefs((p) => ({ ...p, [k]: v }));
  const slider = (label: string, key: 'wpm' | 'size' | 'opacity', min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label className="notes-slider">
      <span>
        {label}
        <b>{fmt(prefs[key])}</b>
      </span>
      <input className="slider" type="range" min={min} max={max} step={step} value={prefs[key]} style={{ ['--p' as string]: `${((prefs[key] - min) / (max - min)) * 100}%` }} onChange={(e) => set(key, Number(e.target.value))} aria-label={label} />
    </label>
  );

  return (
    <div className={`notes-window tp ${mode}${playing ? ' playing' : ''}`} style={{ background: `rgba(14, 15, 18, ${prefs.opacity})` }} data-testid="prompter">
      <header className="notes-head">
        <button className={`tp-play${playing ? ' on' : ''}`} onClick={() => (mode === 'edit' && setMode('prompt'), setPlaying(!playing))} disabled={!text.trim()} title={playing ? 'Pause (Space)' : 'Start scrolling (Space)'} aria-label={playing ? 'Pause scrolling' : 'Start scrolling'} aria-pressed={playing} data-testid="prompter-play">
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <span className="notes-title">Teleprompter</span>
        <span className="notes-badge" title="Cutaway leaves this window out of every recording. Only you can see it.">
          <Icon name="eyeOff" size={10} /> Not recorded
        </span>
        {recording !== 'off' ? <span className={`tp-rec ${recording}`} title={recording === 'on' ? 'Recording' : 'Recording paused'} /> : null}
        <span className="grow" />
        {mode === 'prompt' && left !== null ? (
          <span className="tp-left mono" title="About how long the rest of the script takes at this pace" data-testid="prompter-left">
            {fmtLeft(left)} left
          </span>
        ) : null}
        <button onClick={() => (setPlaying(false), setMode(mode === 'edit' ? 'prompt' : 'edit'))} title={mode === 'edit' ? 'Done: show it as a prompter' : 'Edit the script'} aria-label={mode === 'edit' ? 'Done editing' : 'Edit the script'} aria-pressed={mode === 'edit'} data-testid="prompter-edit" disabled={mode === 'edit' && !text.trim()}>
          <Icon name={mode === 'edit' ? 'check' : 'pencil'} size={13} />
        </button>
        <button onClick={() => setPanel(panel === 'place' ? null : 'place')} title="Move it to a quick spot" aria-label="Move the teleprompter" aria-pressed={panel === 'place'} data-testid="prompter-place">
          <Icon name="layout" size={14} />
        </button>
        <button onClick={() => setPanel(panel === 'settings' ? null : 'settings')} title="Teleprompter settings" aria-label="Teleprompter settings" aria-pressed={panel === 'settings'} data-testid="prompter-settings">
          <Icon name="gear" size={14} />
        </button>
        <button onClick={close} title="Close the teleprompter" aria-label="Close the teleprompter">
          <Icon name="x" size={13} />
        </button>
      </header>

      {panel === 'place' ? (
        <div className="notes-settings tp-places" data-testid="prompter-places">
          {PLACES.map((p) => (
            <button key={p.id} className="tp-place" onClick={() => place(p.id)} data-testid={`prompter-place-${p.id}`}>
              <b>{p.label}</b>
              <span>{p.hint}</span>
            </button>
          ))}
          <span className="tp-hint">Or drag the top bar anywhere, and drag an edge to resize.</span>
        </div>
      ) : null}
      {panel === 'settings' ? (
        <div className="notes-settings">
          {slider('Pace', 'wpm', WPM.min, WPM.max, WPM.step, (v) => `${v} words/min`)}
          {slider('Text size', 'size', SIZE.min, SIZE.max, SIZE.step, (v) => `${v} px`)}
          {slider('Background', 'opacity', 0.2, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
          <label className="tp-check">
            <input type="checkbox" checked={prefs.followTake} onChange={(e) => set('followTake', e.target.checked)} data-testid="prompter-follow" />
            Start, pause and stop with the recording
          </label>
          <label className="tp-check">
            <input type="checkbox" checked={prefs.mirror} onChange={(e) => set('mirror', e.target.checked)} />
            Mirror the text (for prompter glass)
          </label>
          <button className="notes-reset" onClick={() => setPrefs(DEFAULTS)} disabled={JSON.stringify(prefs) === JSON.stringify(DEFAULTS)}>
            Reset
          </button>
        </div>
      ) : null}
      {note ? <div className="tp-note">{note}</div> : null}

      {mode === 'edit' ? (
        <textarea className="notes-text tp-edit" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste or type your script. Press ✓ when you are done; it scrolls when you start recording." spellCheck autoFocus aria-label="Teleprompter script" data-testid="prompter-script" />
      ) : (
        <div
          ref={stage}
          className={`tp-stage${prefs.mirror ? ' mirror' : ''}`}
          onWheel={(e) => {
            pos.current = clamp(pos.current + e.deltaY, 0, geom.current.height);
            paint();
          }}
          onDoubleClick={() => setPlaying((p) => !p)}
          data-testid="prompter-stage"
        >
          <div className="tp-guide" style={{ top: `${READ_AT * 100}%`, height: prefs.size * 1.35 }} aria-hidden />
          <div ref={body} className="tp-body" style={{ fontSize: prefs.size }} data-testid="prompter-text">
            {text.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
            <div className="tp-end">— end —</div>
          </div>
        </div>
      )}

      {mode === 'prompt' ? (
        <footer className="tp-bar">
          <button onClick={restart} title="Back to the start (Home)" aria-label="Back to the start">
            <Icon name="undo" size={12} />
          </button>
          <span className="grow" />
          <button onClick={() => set('wpm', clamp(prefs.wpm - WPM.step, WPM.min, WPM.max))} title="Slower (↓)" aria-label="Slower" data-testid="prompter-slower">
            <Icon name="minus" size={12} />
          </button>
          <span className="tp-val mono" data-testid="prompter-wpm">{prefs.wpm} wpm</span>
          <button onClick={() => set('wpm', clamp(prefs.wpm + WPM.step, WPM.min, WPM.max))} title="Faster (↑)" aria-label="Faster" data-testid="prompter-faster">
            <Icon name="plus" size={12} />
          </button>
          <span className="tp-sep" />
          <button onClick={() => set('size', clamp(prefs.size - SIZE.step, SIZE.min, SIZE.max))} title="Smaller text" aria-label="Smaller text">
            <span className="tp-a small">A</span>
          </button>
          <button onClick={() => set('size', clamp(prefs.size + SIZE.step, SIZE.min, SIZE.max))} title="Bigger text" aria-label="Bigger text">
            <span className="tp-a">A</span>
          </button>
        </footer>
      ) : (
        <footer className="tp-bar edit">
          <span className="tiny">{total} words · about {fmtLeft((total / prefs.wpm) * 60)} at {prefs.wpm} words/min</span>
        </footer>
      )}
    </div>
  );
}
