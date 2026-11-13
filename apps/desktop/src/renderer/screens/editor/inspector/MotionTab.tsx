import { deviceKindFor, deviceOf, motionBlurOf, type Appearance } from '@cutaway/core';
import { useProject } from '../../../state/store';
import { Segmented, Slider, Toggle } from '../../../ui/kit';
import { Reset, Section, pct, setAppearance } from './shared';
import './parity.css';

export function MotionTab() {
  const project = useProject();
  const ap = project.edit.appearance;
  const mb = motionBlurOf(ap);
  const dev = deviceOf(ap);
  const screen = project.sources.find((s) => s.role === 'screen');
  const kind = deviceKindFor(screen);
  const blur = (patch: Partial<NonNullable<Appearance['motionBlur']>>, key: string) => setAppearance((a) => ({ ...a, motionBlur: { ...motionBlurOf(a), ...patch } }), 'Motion blur', key);
  const device = (patch: Partial<NonNullable<Appearance['device']>>, key: string) => setAppearance((a) => ({ ...a, device: { ...deviceOf(a), ...patch } }), 'Device frame', key);
  return (
    <>
      <Section group="Animation" title="Animation speed" icon="path">
        <Segmented full value={ap.motion} onChange={(v) => setAppearance((a) => ({ ...a, motion: v }), 'Motion', 'motion')} options={[{ value: 'calm', label: 'Slow' }, { value: 'balanced', label: 'Medium' }, { value: 'lively', label: 'Rapid' }]} />
        <div className="tiny dim">How quickly zooms and view changes animate in the video.</div>
      </Section>
      <Section title="Motion blur" icon="path" action={<Reset show={mb.amount !== 0} onClick={() => blur({ amount: 0 }, 'mbamount')} />}>
        <Slider min={0} max={1} value={mb.amount} format={(v) => (v < 0.01 ? 'Off' : pct(v))} label="Amount" onChange={(v) => blur({ amount: v }, 'mbamount')} />
        {mb.amount > 0.01 ? (
          <>
            <Toggle label="Blur cursor movement" checked={mb.cursor} onChange={(v) => blur({ cursor: v }, 'mbcursor')} />
            <Toggle label="Blur zooms and view changes" checked={mb.animation} onChange={(v) => blur({ animation: v }, 'mbanim')} />
            <div className="tiny dim">Fast movement smears like a camera shutter. The preview uses a lighter version; the export is full quality.</div>
          </>
        ) : null}
      </Section>
      {kind ? (
        <Section group="Device" title="Device frame" icon="phone">
          <Toggle label={`Show a ${kind} frame`} hint="A plain, generic bezel around the screen recording." checked={dev.frame} onChange={(v) => device({ frame: v }, 'devframe')} />
          {dev.frame ? <Segmented full value={dev.color} onChange={(v) => device({ color: v }, 'devcolor')} options={[{ value: 'graphite', label: 'Graphite' }, { value: 'silver', label: 'Silver' }, { value: 'midnight', label: 'Midnight' }]} /> : null}
        </Section>
      ) : null}
    </>
  );
}
