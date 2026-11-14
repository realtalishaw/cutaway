import { useEffect } from 'react';
import { CAMERA_LOOKS, LOOK_DEFAULT, cameraLookOf, cutoutOf, defaultAppearance, faceOf, isNeutralLook, type Appearance, type CameraLook, type MediaSource } from '@cutaway/core';
import { useApp, useProject } from '../../../state/store';
import { ensureFaces, ensureMatte, facesKey, matteKey, retry, useData } from '../../../engine/parityData';
import { Segmented, Slider, Toggle } from '../../../ui/kit';
import { GradeSection } from './GradeSection';
import { Reset, Section, app, pct, setAppearance } from './shared';
import { PunchSection } from './PunchSection';
import './parity.css';

const DEF = defaultAppearance();

function Status({ entry, working, ready, onRetry }: { entry: { status: string; error: string | null }; working: string; ready: string; onRetry(): void }) {
  if (entry.status === 'computing') {
    return (
      <div className="status-line" role="status">
        <span className="spinner" style={{ width: 12, height: 12 }} /> {working}
      </div>
    );
  }
  if (entry.status === 'failed') {
    return (
      <div className="status-line bad" role="alert">
        <span className="grow">{entry.error ?? 'This could not be prepared.'}</span>
        <button className="reset-link" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (entry.status === 'ready') return <div className="status-line good">{ready}</div>;
  return null;
}

function CameraData({ cam, projectPath, face, cutout }: { cam: MediaSource; projectPath: string; face: boolean; cutout: boolean }) {
  const faces = useData(face ? facesKey(projectPath, cam) : null);
  const matte = useData(cutout ? matteKey(projectPath, cam) : null);
  useEffect(() => {
    if (face && faces.status === 'idle') void ensureFaces(projectPath, cam);
  }, [face, faces.status, projectPath, cam]);
  useEffect(() => {
    if (cutout && matte.status === 'idle') void ensureMatte(projectPath, cam);
  }, [cutout, matte.status, projectPath, cam]);
  const name = cam.role === 'cameraA' ? 'Camera A' : 'Camera B';
  return (
    <>
      {face ? <Status entry={faces} working={`Finding the face in ${name} on this Mac…`} ready={`${name}: face found and tracked.`} onRetry={() => retry(facesKey(projectPath, cam))} /> : null}
      {cutout ? <Status entry={matte} working={`Separating the person from the background in ${name}. This runs on this Mac and can take a while for long takes…`} ready={`${name}: background removed.`} onRetry={() => retry(matteKey(projectPath, cam))} /> : null}
    </>
  );
}

export function CameraTab() {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const ap = project.edit.appearance;
  const cams = project.sources.filter((s) => (s.role === 'cameraA' || s.role === 'cameraB') && s.available);
  const hasCam = project.sources.some((s) => s.role === 'cameraA' || s.role === 'cameraB');
  const hasScreen = project.sources.some((s) => s.role === 'screen');
  const look = cameraLookOf(ap);
  const face = faceOf(ap);
  const cut = cutoutOf(ap);
  const camera = (patch: Partial<Appearance['camera']>, label: string, key: string) => setAppearance((a) => ({ ...a, camera: { ...a.camera, ...patch } }), label, key);
  const setLook = (patch: Partial<CameraLook>, key: string) => setAppearance((a) => ({ ...a, camera: { ...a.camera, look: { ...cameraLookOf(a), ...patch } } }), 'Camera look', key);
  const sameLook = (a: CameraLook, b: CameraLook) => Math.abs(a.brightness - b.brightness) + Math.abs(a.contrast - b.contrast) + Math.abs(a.saturation - b.saturation) + Math.abs(a.warmth - b.warmth) < 0.01;
  if (!hasCam) {
    return (
      <Section title="Camera" icon="camera">
        <div className="tiny dim">No camera in this project. Record with a camera, or add a camera file in Sources.</div>
      </Section>
    );
  }
  const slots = (['A', 'B'] as const).filter((x) => cams.some((c) => c.role === `camera${x}`));
  const main = ap.camera.main === 'B' && slots.includes('B') ? 'B' : 'A';
  const views = project.edit.layouts.filter((l) => l.mode !== 'screen');
  const onB = views.filter((l) => l.camera === 'B').length;
  const showEverywhere = (slot: 'A' | 'B') =>
    app().edit((e) => ({ ...e, appearance: { ...e.appearance, camera: { ...e.appearance.camera, main: slot } }, layouts: e.layouts.map((l) => (l.mode === 'screen' ? l : { ...l, camera: slot })) }), `Show Camera ${slot}`, 'look:cammain');
  return (
    <>
      {slots.length === 2 ? (
        <Section title="Your two cameras" icon="camera">
          <div className="tiny dim" data-testid="two-cameras-note">
            Camera A and Camera B were both recorded. Camera {main} shows unless a block on the View track picks the other one
            {views.length ? `. Right now ${onB} of ${views.length} view${views.length === 1 ? '' : 's'} show${views.length === 1 ? 's' : ''} Camera B.` : '.'}
          </div>
          <Segmented full value={main} onChange={(v) => showEverywhere(v)} options={[{ value: 'A', label: 'Camera A' }, { value: 'B', label: 'Camera B' }]} />
          <div className="tiny dim">Picking one shows it everywhere. To switch for one moment, click a block on the View track and choose its camera.</div>
        </Section>
      ) : null}
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

      <Section group="Look" title="Camera look" icon="palette" action={<Reset show={!isNeutralLook(look)} onClick={() => camera({ look: { ...LOOK_DEFAULT } }, 'Camera look', 'camlook')} />}>
        <div className="look-row" role="group" aria-label="Looks">
          {CAMERA_LOOKS.map((l) => (
            <button key={l.id} className={`chip${sameLook(l.look, look) ? ' on' : ''}`} aria-pressed={sameLook(l.look, look)} onClick={() => camera({ look: { ...l.look } }, `Look: ${l.name}`, 'camlook')}>
              {l.name}
            </button>
          ))}
        </div>
        <Slider label="Brightness" min={0.6} max={1.4} value={look.brightness} format={pct} onChange={(v) => setLook({ brightness: v }, 'lookb')} />
        <Slider label="Contrast" min={0.6} max={1.4} value={look.contrast} format={pct} onChange={(v) => setLook({ contrast: v }, 'lookc')} />
        <Slider label="Saturation" min={0} max={1.6} value={look.saturation} format={pct} onChange={(v) => setLook({ saturation: v }, 'looks')} />
        <Slider label="Warmth" min={-1} max={1} value={look.warmth} format={(v) => (Math.abs(v) < 0.02 ? 'Neutral' : `${v > 0 ? 'Warm' : 'Cool'} ${Math.round(Math.abs(v) * 100)}`)} onChange={(v) => setLook({ warmth: v }, 'lookw')} />
      </Section>

      <GradeSection layer="camera" />

      <Section group="Framing" title="Face tracking" icon="user">
        <Toggle label="Zoom on face" hint="Punches in so your face fills the camera frame." checked={face.zoom} onChange={(v) => camera({ face: { ...face, zoom: v } }, 'Zoom on face', 'camfacezoom')} />
        <Toggle label="Follow face" hint="Keeps you centred when you move." checked={face.follow} onChange={(v) => camera({ face: { ...face, follow: v } }, 'Follow face', 'camfacefollow')} />
        {cams.map((cam) => (
          <CameraData key={cam.id} cam={cam} projectPath={projectPath} face={face.zoom || face.follow} cutout={false} />
        ))}
      </Section>

      <PunchSection />

      <Section title="Remove background" icon="user">
        <Toggle label="Cut out the person" hint="Hides what is behind you. Computed on this Mac; nothing is uploaded." checked={cut.enabled} onChange={(v) => camera({ cutout: { ...cut, enabled: v } }, 'Remove background', 'camcut')} />
        {cut.enabled ? (
          <>
            <Segmented full value={cut.backdrop} onChange={(v) => camera({ cutout: { ...cut, backdrop: v } }, 'Cutout backdrop', 'camcutbg')} options={[{ value: 'none', label: 'None' }, { value: 'blur', label: 'Blur' }, { value: 'color', label: 'Color' }]} />
            {cut.backdrop === 'color' ? (
              <div className="row">
                <label className="color-well" style={{ background: cut.color }} title="Backdrop colour">
                  <input type="color" value={cut.color} onChange={(e) => camera({ cutout: { ...cut, color: e.target.value } }, 'Cutout colour', 'camcutcolor')} aria-label="Backdrop colour" />
                </label>
                <span className="tiny dim">Backdrop colour behind you.</span>
              </div>
            ) : (
              <div className="tiny dim">{cut.backdrop === 'none' ? 'You stand directly on the recording, with no camera bubble.' : 'Your own background, blurred.'}</div>
            )}
            {cams.map((cam) => (
              <CameraData key={cam.id} cam={cam} projectPath={projectPath} face={false} cutout />
            ))}
          </>
        ) : null}
      </Section>

      <Section title="Mirror" icon="camera">
        <Toggle label="Mirror camera" checked={ap.camera.mirror} onChange={(v) => camera({ mirror: v }, 'Mirror', 'cammirror')} />
      </Section>
      <Section title="Layouts" icon="layout">
        <div className="tiny dim">Select a range on the timeline, or a block on the View track, to switch between screen, camera, both and split for that moment.</div>
      </Section>
    </>
  );
}
