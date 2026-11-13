import type { LayoutMode } from '@cutaway/core';
import './recorder.css';

/** How screen and camera are arranged. It decides what is recorded and how the take first looks in the editor. */
export type RecLayout = 'overlay' | 'split' | 'presenter' | 'screen' | 'camera';

export const REC_LAYOUTS: { value: RecLayout; label: string; hint: string; needs: 'both' | 'screen' | 'camera' }[] = [
  { value: 'overlay', label: 'Screen + bubble', hint: 'The screen fills the frame with your camera in a corner.', needs: 'both' },
  { value: 'split', label: 'Side by side', hint: 'Screen and camera share the frame.', needs: 'both' },
  { value: 'presenter', label: 'Camera + screen', hint: 'Your camera fills the frame with the screen as a small picture.', needs: 'both' },
  { value: 'screen', label: 'Screen only', hint: 'No camera is recorded.', needs: 'screen' },
  { value: 'camera', label: 'Camera only', hint: 'No screen is recorded.', needs: 'camera' },
];

/** The editor layout a recorder choice becomes. */
export const toLayoutMode = (l: RecLayout): LayoutMode => l;

function Diagram({ layout }: { layout: RecLayout }) {
  // 64 × 40 frame
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden>
      <rect className="out" x="0.5" y="0.5" width="63" height="39" rx="5" />
      {layout === 'overlay' ? (
        <>
          <rect className="scr" x="5" y="5" width="54" height="30" rx="3" />
          <rect className="cam" x="44" y="22" width="12" height="12" rx="6" />
        </>
      ) : layout === 'split' ? (
        <>
          <rect className="scr" x="5" y="6" width="34" height="28" rx="3" />
          <rect className="cam" x="42" y="6" width="17" height="28" rx="3" />
        </>
      ) : layout === 'presenter' ? (
        <>
          <rect className="cam" x="1" y="1" width="62" height="38" rx="4.500" opacity="0.85" />
          <rect className="scr" x="37" y="21" width="22" height="14" rx="2" style={{ fill: '#1b1d22' }} />
        </>
      ) : layout === 'screen' ? (
        <rect className="scr" x="5" y="5" width="54" height="30" rx="3" />
      ) : (
        <rect className="cam" x="1" y="1" width="62" height="38" rx="4.500" />
      )}
    </svg>
  );
}

export function LayoutPicker({ value, onChange, disabled }: { value: RecLayout; onChange: (l: RecLayout) => void; disabled?: (l: RecLayout) => string | null }) {
  return (
    <div className="lay-row" role="radiogroup" aria-label="Layout" data-testid="layout-picker">
      {REC_LAYOUTS.map((l) => {
        const why = disabled?.(l.value) ?? null;
        return (
          <button key={l.value} className="lay" role="radio" aria-checked={value === l.value} data-layout={l.value} title={why ?? l.hint} onClick={() => onChange(l.value)}>
            <Diagram layout={l.value} />
            <span>{l.label}</span>
          </button>
        );
      })}
    </div>
  );
}
