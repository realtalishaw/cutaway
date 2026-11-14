import { useEffect, useRef, useState } from 'react';
import type { CamShape, PreviewFrame, SelfViewPrefs } from '@shared/api';
import { Icon } from '../../ui/icons';
import './recorder.css';

/**
 * The creator's own camera while a take runs: a small always-on-top bubble
 * that is never part of the screen recording (the camera is its own track).
 * The pictures come from the recorder itself, a few times a second, so the
 * camera is not opened a second time and the take is not disturbed.
 */
const SHAPES: CamShape[] = ['rounded', 'circle', 'square'];
const SHAPE_NAME: Record<CamShape, string> = { rounded: 'rounded', circle: 'a circle', square: 'square' };
const nextShape = (s: CamShape): CamShape => (s === 'rounded' ? 'circle' : s === 'circle' ? 'square' : 'rounded');

export function SelfView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [slot, setSlot] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [shape, setShape] = useState<CamShape>('rounded');
  const slotRef = useRef<string | null>(null);
  slotRef.current = slot;

  useEffect(() => {
    void window.cutaway.app.getSettings().then((s) => setShape(SHAPES.includes(s.selfView?.shape as CamShape) ? (s.selfView!.shape as CamShape) : 'rounded')).catch(() => {});
    const offState = window.cutaway.app.onSelfView((s) => setSlots(s.cameras));
    let busy = false;
    const offFrames = window.cutaway.record.onPreview((f: PreviewFrame) => {
      setSlots((list) => (list.includes(f.source) ? list : [...list, f.source].sort()));
      if (!slotRef.current) {
        slotRef.current = f.source;
        setSlot(f.source);
      }
      if (f.source !== slotRef.current || busy) return;
      busy = true;
      // Decoded off the main thread and painted in one go, so the picture never flickers.
      const bin = atob(f.jpeg);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
        .then((bmp) => {
          const c = canvas.current;
          if (c) {
            if (c.width !== bmp.width || c.height !== bmp.height) {
              c.width = bmp.width;
              c.height = bmp.height;
            }
            c.getContext('2d')?.drawImage(bmp, 0, 0);
            setLive(true);
          }
          bmp.close();
        })
        .catch(() => {})
        .finally(() => (busy = false));
    });
    return () => {
      offState();
      offFrames();
    };
  }, []);

  const toggleShape = () => {
    const next = nextShape(shape);
    setShape(next);
    void window.cutaway.app
      .getSettings()
      .then((s) => window.cutaway.app.setSettings({ selfView: { ...(s.selfView ?? {}), shape: next } as SelfViewPrefs }))
      .catch(() => {});
  };
  const other = slots.find((s) => s !== slot) ?? null;

  return (
    <div className={`sv ${shape}`} data-testid="self-view" data-live={live ? '1' : '0'} data-slot={slot ?? ''} title="Only you see this. Drag it anywhere, drag an edge to resize.">
      <canvas ref={canvas} className="sv-picture" />
      {!live ? (
        <div className="sv-wait">
          <Icon name="camera" size={22} />
          <span>Starting camera…</span>
        </div>
      ) : null}
      <div className="sv-tools">
        {other ? (
          <button onClick={() => setSlot(other)} title={`Show camera ${other.endsWith('B') ? 'B' : 'A'}`} aria-label="Show the other camera" data-testid="self-view-switch">
            {slot?.endsWith('B') ? 'B' : 'A'}
          </button>
        ) : null}
        <button onClick={toggleShape} title={`Make it ${SHAPE_NAME[nextShape(shape)]}. The camera in your video changes too.`} aria-label="Change the camera shape" data-testid="self-view-shape">
          <i className={`sv-shape-icon ${nextShape(shape)}`} />
        </button>
        <button onClick={() => void window.cutaway.app.selfView(false)} title="Hide (the camera keeps recording). Bring it back from the recording control." aria-label="Hide the camera bubble" data-testid="self-view-hide">
          <Icon name="x" size={13} />
        </button>
      </div>
    </div>
  );
}
