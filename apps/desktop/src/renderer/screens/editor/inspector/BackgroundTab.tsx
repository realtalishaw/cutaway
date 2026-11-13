import { useState } from 'react';
import { BACKGROUNDS, WALLPAPERS, defaultAppearance, type Appearance } from '@cutaway/core';
import { useProject } from '../../../state/store';
import { Icon } from '../../../ui/icons';
import { Segmented, Slider } from '../../../ui/kit';
import { Reset, Section, pct, setAppearance } from './shared';

type BgKind = Appearance['background']['type'];
const GROUPS = ['Dusk', 'Aurora', 'Ember', 'Mono'] as const;
const DEF = defaultAppearance();

const wallpaperCss = (id: string) => {
  const w = WALLPAPERS.find((x) => x.id === id) ?? WALLPAPERS[0]!;
  return `${w.blobs.map((b) => `radial-gradient(circle at ${b.x * 100}% ${b.y * 100}%, ${b.color} 0%, transparent ${b.r * 100}%)`).join(', ')}, ${w.base}`;
};

export function BackgroundTab() {
  const project = useProject();
  const ap = project.edit.appearance;
  const bg = ap.background;
  const [group, setGroup] = useState<(typeof GROUPS)[number]>(bg.type === 'wallpaper' ? (WALLPAPERS.find((w) => w.id === bg.id)?.group ?? 'Dusk') : 'Dusk');
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const setBg = (background: Appearance['background']) => setAppearance((a) => ({ ...a, background }), 'Background', 'bg');
  const switchKind = (k: BgKind) => {
    if (k === bg.type) return;
    if (k === 'wallpaper') setBg({ type: 'wallpaper', id: 'dusk-1', blur: 0 });
    else if (k === 'gradient') setBg({ type: 'gradient', colors: BACKGROUNDS[0]!.colors, angle: BACKGROUNDS[0]!.angle });
    else if (k === 'solid') setBg({ type: 'solid', color: '#1c1d21' });
    else void pickImage();
  };
  const pickImage = async () => {
    const [file] = await window.cutaway.app.pickFiles({ title: 'Background image', kinds: ['image'], multiple: false });
    if (file) setBg({ type: 'image', path: file, blur: 0 });
  };
  const blur = bg.type === 'wallpaper' || bg.type === 'image' ? bg.blur : 0;
  const frame = (patch: Partial<Appearance['frame']>, label: string, key: string) => setAppearance((a) => ({ ...a, frame: { ...a.frame, ...patch } }), label, key);
  return (
    <>
      <Section title="Background" icon="image">
        <Segmented full label="Background type" value={bg.type} onChange={switchKind} options={[{ value: 'wallpaper', label: 'Wallpaper' }, { value: 'gradient', label: 'Gradient' }, { value: 'solid', label: 'Color' }, { value: 'image', label: 'Image' }]} />
      </Section>

      {bg.type === 'wallpaper' ? (
        <Section title="Wallpaper" icon="image">
          <div className="chips" role="tablist">
            {GROUPS.map((g) => (
              <button key={g} role="tab" aria-selected={group === g} className={`chip${group === g ? ' on' : ''}`} onClick={() => setGroup(g)}>
                {g}
              </button>
            ))}
          </div>
          <button className="btn" style={{ width: '100%' }} onClick={() => setBg({ type: 'wallpaper', id: WALLPAPERS[Math.floor(Math.random() * WALLPAPERS.length)]!.id, blur })}>
            <Icon name="sparkle" size={14} /> Pick random wallpaper
          </button>
          <div className="wall-grid">
            {WALLPAPERS.filter((w) => w.group === group).map((w) => (
              <button key={w.id} className={`wall${bg.id === w.id ? ' on' : ''}`} style={{ background: wallpaperCss(w.id) }} title={w.name} aria-label={`${w.name} wallpaper`} aria-pressed={bg.id === w.id} onClick={() => setBg({ type: 'wallpaper', id: w.id, blur })} />
            ))}
          </div>
        </Section>
      ) : null}

      {bg.type === 'gradient' ? (
        <Section title="Gradient" icon="palette">
          <div className="wall-grid">
            {BACKGROUNDS.map((b) => (
              <button key={b.id} className={`wall${bg.colors.join() === b.colors.join() ? ' on' : ''}`} style={{ background: `linear-gradient(${b.angle}deg, ${b.colors.join(',')})` }} title={b.name} aria-label={`${b.name} gradient`} aria-pressed={bg.colors.join() === b.colors.join()} onClick={() => setBg({ type: 'gradient', colors: b.colors, angle: b.angle })} />
            ))}
          </div>
          <Slider label="Angle" min={0} max={360} step={1} value={bg.angle} format={(v) => `${Math.round(v)}°`} onChange={(v) => setAppearance((a) => (a.background.type === 'gradient' ? { ...a, background: { ...a.background, angle: v } } : a), 'Gradient angle', 'bgangle')} />
        </Section>
      ) : null}

      {bg.type === 'solid' ? (
        <Section title="Color" icon="palette">
          <div className="wall-grid">
            {['#0b0b0d', '#1c1d21', '#ffffff', '#f3ece3', '#4f46f5', '#7c3aed', '#ec4899', '#f97316', '#facc15', '#10b981', '#22d3ee', '#2563eb'].map((c) => (
              <button key={c} className={`wall${bg.color.toLowerCase() === c ? ' on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={bg.color.toLowerCase() === c} onClick={() => setBg({ type: 'solid', color: c })} />
            ))}
            <label className="wall custom" title="Custom colour" style={{ background: bg.color }}>
              <Icon name="plus" size={13} />
              <input type="color" value={bg.color} onChange={(e) => setBg({ type: 'solid', color: e.target.value })} aria-label="Custom background colour" />
            </label>
          </div>
        </Section>
      ) : null}

      {bg.type === 'image' ? (
        <Section title="Image" icon="image">
          <div className="tiny dim" style={{ wordBreak: 'break-all' }}>{bg.path.split('/').pop()}</div>
          <button className="btn" onClick={() => void pickImage()}>
            <Icon name="folder" size={14} /> Choose another image
          </button>
        </Section>
      ) : null}

      {bg.type === 'wallpaper' || bg.type === 'image' ? (
        <Section title="Background blur" icon="image" action={<Reset show={blur !== 0} onClick={() => setAppearance((a) => (a.background.type === 'wallpaper' || a.background.type === 'image' ? { ...a, background: { ...a.background, blur: 0 } } : a), 'Background blur', 'bgblur')} />}>
          <Slider min={0} max={1} value={blur} onChange={(v) => setAppearance((a) => (a.background.type === 'wallpaper' || a.background.type === 'image' ? { ...a, background: { ...a.background, blur: v } } : a), 'Background blur', 'bgblur')} />
        </Section>
      ) : null}

      {hasScreen ? (
        <>
          <Section group="Shape" title="Padding" icon="frame" action={<Reset show={ap.frame.padding !== DEF.frame.padding} onClick={() => frame({ padding: DEF.frame.padding }, 'Padding', 'pad')} />}>
            <Slider min={0} max={0.16} step={0.002} value={ap.frame.padding} onChange={(v) => frame({ padding: v }, 'Padding', 'pad')} />
          </Section>
          <Section title="Rounded corners" icon="frame" action={<Reset show={ap.frame.radius !== DEF.frame.radius} onClick={() => frame({ radius: DEF.frame.radius }, 'Corners', 'rad')} />}>
            <Slider min={0} max={0.06} step={0.001} value={ap.frame.radius} onChange={(v) => frame({ radius: v }, 'Corners', 'rad')} />
          </Section>
          <Section title="Shadow" icon="frame" action={<Reset show={ap.frame.shadow !== DEF.frame.shadow} onClick={() => frame({ shadow: DEF.frame.shadow }, 'Shadow', 'shadow')} />}>
            <Slider min={0} max={1} value={ap.frame.shadow} format={pct} onChange={(v) => frame({ shadow: v }, 'Shadow', 'shadow')} />
          </Section>
          <Section title="Inset" icon="frame" action={<Reset show={ap.frame.inset !== DEF.frame.inset} onClick={() => frame({ inset: DEF.frame.inset }, 'Inset', 'inset')} />}>
            <Slider min={0} max={1} value={ap.frame.inset} format={pct} onChange={(v) => frame({ inset: v }, 'Inset', 'inset')} />
          </Section>
        </>
      ) : null}
    </>
  );
}
