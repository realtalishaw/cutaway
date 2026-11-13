import { useEffect, useState } from 'react';
import type { CountdownState } from '@shared/api';
import './recorder.css';

type State = CountdownState & { bounds: { x: number; y: number; width: number; height: number } };

/**
 * The countdown, drawn over the display, window or area that is about to be
 * recorded. This window covers one display, takes no clicks or keys, and is
 * closed before the recorder starts (and left out of the capture regardless).
 */
export function CountdownOverlay() {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => window.cutaway.app.onCountdown(setState), []);
  if (!state) return null;
  const { rect, bounds, kind } = state;
  // Global screen points → this window's own coordinates, kept inside the display.
  const x = Math.max(0, rect.x - bounds.x);
  const y = Math.max(0, rect.y - bounds.y);
  const w = Math.min(rect.width, bounds.width - x);
  const h = Math.min(rect.height, bounds.height - y);
  const size = Math.round(Math.max(72, Math.min(260, Math.min(w, h) * 0.42)));
  return (
    <div className="cd-root" data-kind={kind} data-testid="countdown-overlay">
      <div className={`cd-target${kind === 'display' ? ' whole' : ''}`} style={{ left: x, top: y, width: w, height: h }} data-testid="countdown-target">
        <div className="cd-center">
          <div key={state.count} className="cd-num" style={{ fontSize: size }} data-testid="countdown-number">{state.count}</div>
          <div className="cd-label">
            <span className="cd-dot" />
            Recording <b>{state.label}</b> in {state.count}
            <span className="cd-esc">esc to cancel</span>
          </div>
        </div>
      </div>
    </div>
  );
}
