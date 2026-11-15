import { useEffect, useMemo, useRef, useState, type PointerEvent as RP } from 'react';
import { clamp, sourceByRole, toSourceTime, type Rect } from '@cutaway/core';
import { mediaUrl, resolveSourcePath } from '@shared/api';
import { useApp, useShownProject } from '../../state/store';
import { Button, Segmented } from '../../ui/kit';
import { playheadSource } from './ops';
import { detectBrowserBars } from '../../engine/browserBar';

const MIN = 0.08;

type Lock = 'free' | 'source' | '16:9' | '4:3' | '1:1' | '9:16';
const LOCKS: { value: Lock; label: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'source', label: 'Original' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
];

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const isFull = (r: Rect) => r.x <= 0.0005 && r.y <= 0.0005 && r.w >= 0.9995 && r.h >= 0.9995;

/** Largest rect of the given normalised width/height ratio that fits inside `r`, centred on it. */
function fitRatio(r: Rect, k: number): Rect {
  let w = r.w;
  let h = w / k;
  if (h > r.h) {
    h = r.h;
    w = h * k;
  }
  if (w > 1) (w = 1), (h = w / k);
  if (h > 1) (h = 1), (w = h * k);
  const x = clamp(r.x + (r.w - w) / 2, 0, 1 - w);
  const y = clamp(r.y + (r.h - h) / 2, 0, 1 - h);
  return { x, y, w, h };
}

/** Apply a drag to a rect. `k` is the locked normalised w/h ratio, or null. */
export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, k: number | null): Rect {
  if (handle === 'move') return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN, 1);
  let r: Rect = { x: left, y: top, w: right - left, h: bottom - top };
  if (k) {
    // Keep the dragged edge where the pointer put it and derive the other dimension, anchored on the opposite side.
    const horizontal = handle === 'e' || handle === 'w';
    let w = r.w;
    let h = r.h;
    if (horizontal || (handle.length === 2 && r.w / k <= r.h)) h = w / k;
    else w = h * k;
    const anchorX = handle.includes('w') ? start.x + start.w : handle.includes('e') ? start.x : start.x + start.w / 2;
    const anchorY = handle.includes('n') ? start.y + start.h : handle.includes('s') ? start.y : start.y + start.h / 2;
    // Shrink together until the rect fits the frame from its anchor.
    const maxW = handle.includes('w') ? anchorX : handle.includes('e') ? 1 - anchorX : 2 * Math.min(anchorX, 1 - anchorX);
    const maxH = handle.includes('n') ? anchorY : handle.includes('s') ? 1 - anchorY : 2 * Math.min(anchorY, 1 - anchorY);
    const f = Math.min(1, maxW / w, maxH / h);
    w = Math.max(MIN, w * f);
    h = w / k;
    const x = handle.includes('w') ? anchorX - w : handle.includes('e') ? anchorX : anchorX - w / 2;
    const y = handle.includes('n') ? anchorY - h : handle.includes('s') ? anchorY : anchorY - h / 2;
    r = { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h };
  }
  return r;
}

/**
 * Crop the screen recording: a still of the frame with a rectangle to drag and
 * resize, an aspect lock, and exact pixel fields. Nothing changes until Apply.
 */
export function CropSheet({ onClose }: { onClose(): void }) {
  const project = useShownProject();
  const projectPath = useApp((s) => s.projectPath);
  const screen = sourceByRole(project, 'screen');
  const srcW = screen?.width ?? 1920;
  const srcH = screen?.height ?? 1080;
  const [rect, setRect] = useState<Rect>(() => ({ ...project.edit.appearance.crop }));
  const [lock, setLock] = useState<Lock>('free');
  const [still, setStill] = useState<string | null>(null);
  const [stillFailed, setStillFailed] = useState(false);
  const [bars, setBars] = useState<{ state: 'idle' | 'looking' | 'found' | 'none'; text: string }>({ state: 'idle', text: '' });
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: Rect; x: number; y: number } | null>(null);

  // Locked ratio in normalised units (the frame itself is srcW:srcH).
  const k = useMemo(() => {
    if (lock === 'free') return null;
    if (lock === 'source') return 1;
    const [a, b] = lock.split(':').map(Number) as [number, number];
    return (a / b) * (srcH / srcW);
  }, [lock, srcW, srcH]);

  useEffect(() => {
    if (!screen || !projectPath) return;
    let stale = false;
    const t = clamp(toSourceTime(screen.sync, playheadSource(project)), 0, Math.max(0, screen.duration - 0.05));
    window.cutaway.native
      .frames(projectPath, resolveSourcePath(projectPath, screen.path), [t], 1600)
      .then((r) => !stale && (r[0] ? setStill(mediaUrl(r[0].path)) : setStillFailed(true)))
      .catch(() => !stale && setStillFailed(true));
    return () => {
      stale = true;
    };
    // The still is taken once, where the playhead was when the sheet opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (e.stopPropagation(), onClose());
      else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'INPUT') (e.stopPropagation(), apply());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect]);

  const chooseLock = (next: Lock) => {
    setLock(next);
    if (next === 'free') return;
    const ratio = next === 'source' ? 1 : (() => {
      const [a, b] = next.split(':').map(Number) as [number, number];
      return (a / b) * (srcH / srcW);
    })();
    setRect((r) => fitRatio(r, ratio));
  };

  const down = (handle: Handle) => (e: RP) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, start: rect, x: e.clientX, y: e.clientY };
  };
  const move = (e: RP) => {
    const d = drag.current;
    const box = boxRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    setRect(dragRect(d.start, d.handle, (e.clientX - d.x) / box.width, (e.clientY - d.y) / box.height, k));
  };
  const up = () => (drag.current = null);

  const apply = () => {
    const r = { x: clamp(rect.x, 0, 1 - MIN), y: clamp(rect.y, 0, 1 - MIN), w: clamp(rect.w, MIN, 1), h: clamp(rect.h, MIN, 1) };
    const next = isFull(r) ? { x: 0, y: 0, w: 1, h: 1 } : { ...r, w: Math.min(r.w, 1 - r.x), h: Math.min(r.h, 1 - r.y) };
    const cur = project.edit.appearance.crop;
    if (next.x !== cur.x || next.y !== cur.y || next.w !== cur.w || next.h !== cur.h) useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, crop: { ...e.appearance.crop, ...next } } }), isFull(next) ? 'Remove crop' : 'Crop');
    onClose();
  };

  // Pixel fields edit the same rect; values are clamped to the frame as they are typed.
  const px = { x: Math.round(rect.x * srcW), y: Math.round(rect.y * srcH), w: Math.round(rect.w * srcW), h: Math.round(rect.h * srcH) };
  const setPx = (key: 'x' | 'y' | 'w' | 'h', raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    setRect((r) => {
      let n = { ...r };
      if (key === 'x') n.x = clamp(v / srcW, 0, 1 - MIN);
      if (key === 'y') n.y = clamp(v / srcH, 0, 1 - MIN);
      if (key === 'w') n.w = clamp(v / srcW, MIN, 1);
      if (key === 'h') n.h = clamp(v / srcH, MIN, 1);
      if (k) {
        if (key === 'h') n.w = clamp(n.h * k, MIN, 1);
        n.h = n.w / k;
        if (n.h > 1) (n.h = 1), (n.w = k);
      }
      n.w = Math.min(n.w, 1 - n.x);
      n.h = Math.min(n.h, 1 - n.y);
      if (k) n = { ...n, ...(n.w / k <= n.h ? { h: n.w / k } : { w: n.h * k }) };
      return n;
    });
  };

  // Look at frames across the whole recording for a browser's toolbar and side bars, and crop them away.
  const hideBrowserBar = async () => {
    if (!screen || !projectPath) return;
    setBars({ state: 'looking', text: 'Looking for the browser bar…' });
    try {
      const n = 10;
      const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * Math.max(0.1, screen.duration - 0.1));
      const shots = await window.cutaway.native.frames(projectPath, resolveSourcePath(projectPath, screen.path), times, 640);
      const found = await detectBrowserBars(shots.map((f) => mediaUrl(f.path)));
      if (!found) {
        setBars({ state: 'none', text: 'No browser bar found in this recording. Drag the edges to crop by hand.' });
        return;
      }
      setLock('free');
      setRect({ x: found.left, y: found.top, w: 1 - found.left - found.right, h: 1 - found.top - found.bottom });
      const parts = [found.top > 0 ? 'the tabs and address bar' : null, found.left > 0 ? 'the side bar' : null, found.right > 0 ? 'the strip on the right' : null].filter(Boolean);
      setBars({ state: 'found', text: `Found ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}. Check the frame, adjust if needed, then apply.` });
    } catch {
      setBars({ state: 'none', text: 'Could not read frames from the recording. Drag the edges to crop by hand.' });
    }
  };

  const full = isFull(rect);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide crop-sheet" role="dialog" aria-modal aria-label="Crop the recording" data-testid="crop-sheet">
        <div className="modal-head row between" style={{ alignItems: 'center' }}>
          <div>
            <div className="display h3">Crop the recording</div>
            <div className="tiny dim" style={{ marginTop: 4 }}>Drag the rectangle or its edges. Only what is inside it appears in the video.</div>
          </div>
          <button className="reset-link" disabled={full} onClick={() => (setRect({ x: 0, y: 0, w: 1, h: 1 }), setLock('free'))} data-testid="crop-reset">
            Reset
          </button>
        </div>
        <div className="modal-body">
          <div className="crop-stage">
            <div className="crop-frame" ref={boxRef} style={{ aspectRatio: `${srcW} / ${srcH}`, width: `min(100%, calc(min(54vh, 540px) * ${srcW} / ${srcH}))` }} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
              {still ? <img src={still} alt="" draggable={false} /> : <div className="crop-placeholder">{stillFailed ? 'The frame could not be loaded. The rectangle still shows the crop.' : <span className="spinner" />}</div>}
              <div className="crop-shade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rect.x * 100}% ${rect.y * 100}%, ${rect.x * 100}% ${(rect.y + rect.h) * 100}%, ${(rect.x + rect.w) * 100}% ${(rect.y + rect.h) * 100}%, ${(rect.x + rect.w) * 100}% ${rect.y * 100}%, ${rect.x * 100}% ${rect.y * 100}%)` }} />
              <div className="crop-rect" data-testid="crop-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} onPointerDown={down('move')}>
                <i className="third v1" />
                <i className="third v2" />
                <i className="third h1" />
                <i className="third h2" />
                {HANDLES.map((h) => (
                  <span key={h} className={`crop-handle ${h}`} data-handle={h} onPointerDown={down(h)} />
                ))}
              </div>
            </div>
          </div>
          <div className="crop-controls">
            <div className="field" style={{ gap: 6 }}>
              <span className="label">Shape</span>
              <Segmented label="Crop shape" value={lock} onChange={chooseLock} options={LOCKS} />
            </div>
            {screen && screen.kind !== 'image' ? (
              <div className="field" style={{ gap: 6 }}>
                <span className="label">Recorded a browser?</span>
                <Button icon="globe" onClick={() => void hideBrowserBar()} disabled={bars.state === 'looking'} data-testid="crop-browser-bar" title="Find the browser's tabs, address bar and side bars in the recording and crop them away">
                  {bars.state === 'looking' ? 'Looking…' : 'Hide browser bar'}
                </Button>
                {bars.text ? <span className="tiny dim" data-testid="crop-browser-note">{bars.text}</span> : null}
              </div>
            ) : null}
            <div className="crop-fields">
              {(['x', 'y', 'w', 'h'] as const).map((key) => (
                <label key={key} className="crop-field">
                  <span>{key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'w' ? 'Width' : 'Height'}</span>
                  <input type="number" inputMode="numeric" min={0} max={key === 'x' || key === 'w' ? srcW : srcH} value={px[key]} onChange={(e) => setPx(key, e.target.value)} aria-label={`${key === 'x' ? 'Left' : key === 'y' ? 'Top' : key === 'w' ? 'Width' : 'Height'} in pixels`} data-testid={`crop-${key}`} />
                </label>
              ))}
              <span className="tiny dim mono" style={{ alignSelf: 'end', paddingBottom: 7 }}>of {srcW} × {srcH}</span>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" onClick={apply} data-testid="crop-apply">
            {full ? 'Use the whole frame' : 'Apply crop'}
          </Button>
        </div>
      </div>
    </div>
  );
}
