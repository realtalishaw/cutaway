import { defaultAppearance, type Appearance } from '@cutaway/core';
import { useProject } from '../../../state/store';
import { Segmented, Slider, Toggle } from '../../../ui/kit';
import { Reset, Section, setAppearance } from './shared';

const DEF = defaultAppearance();

export function CameraTab() {
  const project = useProject();
  const ap = project.edit.appearance;
  const hasCam = project.sources.some((s) => s.role === 'cameraA' || s.role === 'cameraB');
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const camera = (patch: Partial<Appearance['camera']>, label: string, key: string) => setAppearance((a) => ({ ...a, camera: { ...a.camera, ...patch } }), label, key);
  if (!hasCam) {
    return (
      <Section title="Camera" icon="camera">
        <div className="tiny dim">No camera in this project. Record with a camera, or add a camera file in Sources.</div>
      </Section>
    );
  }
  return (
    <>
      {hasScreen ? (
        <>
          <Section title="Camera shape" icon="camera">
            <Segmented full value={ap.camera.shape} onChange={(v) => camera({ shape: v }, 'Camera shape', 'camshape')} options={[{ value: 'rounded', label: 'Rounded' }, { value: 'circle', label: 'Circle' }, { value: 'square', label: 'Square' }]} />
          </Section>
          <Section title="Camera size" icon="camera" action={<Reset show={ap.camera.size !== DEF.camera.size} onClick={() => camera({ size: DEF.camera.size }, 'Camera size', 'camsize')} />}>
            <Slider min={0.12} max={0.45} value={ap.camera.size} onChange={(v) => camera({ size: v }, 'Camera size', 'camsize')} />
          </Section>
          {ap.camera.shape === 'rounded' ? (
            <Section title="Roundness" icon="camera" action={<Reset show={ap.camera.radius !== DEF.camera.radius} onClick={() => camera({ radius: DEF.camera.radius }, 'Camera roundness', 'camrad')} />}>
              <Slider min={0.04} max={0.5} value={ap.camera.radius} onChange={(v) => camera({ radius: v }, 'Camera roundness', 'camrad')} />
            </Section>
          ) : null}
          <Section title="Camera position" icon="layout">
            <div className="corner-grid" role="group" aria-label="Camera corner">
              {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
                <button key={c} className={ap.camera.corner === c ? 'on' : ''} aria-pressed={ap.camera.corner === c} aria-label={{ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' }[c]} onClick={() => camera({ corner: c }, 'Camera corner', 'camcorner')}>
                  <i className={c} />
                </button>
              ))}
            </div>
          </Section>
          <Section title="Camera shadow" icon="camera" action={<Reset show={ap.camera.shadow !== DEF.camera.shadow} onClick={() => camera({ shadow: DEF.camera.shadow }, 'Camera shadow', 'camshadow')} />}>
            <Slider min={0} max={1} value={ap.camera.shadow} onChange={(v) => camera({ shadow: v }, 'Camera shadow', 'camshadow')} />
          </Section>
        </>
      ) : null}
      <Section title="Mirror" icon="camera">
        <Toggle label="Mirror camera" checked={ap.camera.mirror} onChange={(v) => camera({ mirror: v }, 'Mirror', 'cammirror')} />
      </Section>
      <Section title="Layouts" icon="layout">
        <div className="tiny dim">Select a range on the timeline, or a block on the View track, to switch between screen, camera, both and split for that moment.</div>
      </Section>
    </>
  );
}
