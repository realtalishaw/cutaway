import { clickSoundOf, cursorExtrasOf, defaultAppearance, type Appearance } from '@cutaway/core';
import { useProject } from '../../../state/store';
import { Banner, Slider, Toggle } from '../../../ui/kit';
import { Reset, Section, pct, setAppearance } from './shared';
import './parity.css';

const DEF = defaultAppearance();

export function CursorTab() {
  const project = useProject();
  const ap = project.edit.appearance;
  const screen = project.sources.find((s) => s.role === 'screen');
  const hasCursor = !!screen && !screen.cursorBaked && !!screen.cursorFile;
  const extra = cursorExtrasOf(ap);
  const sound = clickSoundOf(ap);
  const cursor = (patch: Partial<Appearance['cursor']>, label: string, key: string) => setAppearance((a) => ({ ...a, cursor: { ...a.cursor, ...patch } }), label, key);
  if (!screen) {
    return (
      <Section title="Cursor" icon="pointer">
        <div className="tiny dim">This project has no screen recording, so there is no cursor to style.</div>
      </Section>
    );
  }
  if (!hasCursor) {
    return (
      <Section title="Cursor" icon="pointer">
        <Banner icon="cursor" title={screen.origin === 'import' ? 'Imported video' : 'Cursor was recorded into the picture'}>
          The cursor is part of the pixels, so it cannot be resized, smoothed or hidden. Recordings made in Cutaway with “Clean cursor” keep it editable.
        </Banner>
      </Section>
    );
  }
  return (
    <>
      <Section title="Cursor" icon="pointer">
        <Toggle label="Hide cursor" checked={!ap.cursor.visible} onChange={(v) => cursor({ visible: !v }, 'Cursor', 'cur')} />
      </Section>
      <Section title="Cursor size" icon="pointer" action={<Reset show={ap.cursor.size !== DEF.cursor.size} onClick={() => cursor({ size: DEF.cursor.size }, 'Cursor size', 'cursize')} />}>
        <Slider min={0.6} max={3.5} step={0.05} value={ap.cursor.size} onChange={(v) => cursor({ size: v }, 'Cursor size', 'cursize')} />
      </Section>
      <Section title="Smooth movement" icon="path" action={<Reset show={ap.cursor.smoothing !== DEF.cursor.smoothing} onClick={() => cursor({ smoothing: DEF.cursor.smoothing }, 'Cursor smoothing', 'cursmooth')} />}>
        <Slider min={0} max={1} value={ap.cursor.smoothing} onChange={(v) => cursor({ smoothing: v }, 'Cursor smoothing', 'cursmooth')} />
      </Section>
      <Section title="Cursor type" icon="pointer">
        <Toggle label="Always use default pointer" hint="Off shows the hand over links and the I-beam over text, as recorded." checked={extra.style === 'arrow'} onChange={(v) => cursor({ style: v ? 'arrow' : 'auto' }, 'Cursor type', 'curstyle')} />
        <Toggle label="Rotate cursor while moving" hint="A slight lean in the direction of travel." checked={extra.rotate} onChange={(v) => cursor({ rotate: v }, 'Cursor rotation', 'currot')} />
      </Section>
      <Section title="Behaviour" icon="pointer">
        <Toggle label="Hide cursor if not moving" checked={ap.cursor.hideWhenIdle} onChange={(v) => cursor({ hideWhenIdle: v }, 'Cursor', 'curidle')} />
        <Toggle label="Stop cursor shaking" hint="Ignores tiny hand tremor while the pointer rests." checked={extra.antiShake} onChange={(v) => cursor({ antiShake: v }, 'Cursor shake', 'curshake')} />
        <Toggle label="Loop cursor position" hint="Returns to where it started over the last second, for seamless loops." checked={extra.loop} onChange={(v) => cursor({ loop: v }, 'Cursor loop', 'curloop')} />
      </Section>
      <Section title="Clicks" icon="pointer">
        <Toggle label="Click effect" hint="A soft ripple on every click." checked={ap.cursor.clickEffect === 'ripple'} onChange={(v) => cursor({ clickEffect: v ? 'ripple' : 'none' }, 'Cursor', 'curclick')} />
        <Toggle label="Click sound" hint="A quiet tick on every click, in the preview and the export." checked={sound.enabled} onChange={(v) => cursor({ clickSound: { ...sound, enabled: v } }, 'Click sound', 'cursound')} />
        {sound.enabled ? <Slider label="Click volume" min={0.05} max={1} value={sound.volume} format={pct} onChange={(v) => cursor({ clickSound: { ...sound, volume: v } }, 'Click volume', 'cursoundvol')} /> : null}
      </Section>
    </>
  );
}
