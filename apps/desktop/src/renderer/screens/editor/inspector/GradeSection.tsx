import { useState } from 'react';
import { GRADE_DEFAULT, gradeOf, type LayerGrade } from '@cutaway/core';
import { useApp, useProject } from '../../../state/store';
import { forgetLut, useLut } from '../../../engine/lut';
import { Icon } from '../../../ui/icons';
import { Slider } from '../../../ui/kit';
import { Reset, Section, pct, setAppearance } from './shared';
import './parity.css';

/** Colour LUT and sharpening for one picture layer: the screen recording, or the cameras. */
export function GradeSection({ layer, group }: { layer: 'screen' | 'camera'; group?: string }) {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const g = gradeOf(project.edit.appearance)[layer];
  const entry = useLut(projectPath, g.lut);
  const [busy, setBusy] = useState(false);
  const what = layer === 'screen' ? 'Screen' : 'Camera';
  const set = (patch: Partial<LayerGrade>, label: string, key: string) =>
    setAppearance((a) => ({ ...a, grade: { ...a.grade, [layer]: { ...GRADE_DEFAULT, ...a.grade?.[layer], ...patch } } }), label, `grade-${layer}-${key}`);

  const choose = async () => {
    setBusy(true);
    try {
      const ref = await window.cutaway.looks.importLut(projectPath, null);
      if (ref) {
        forgetLut(projectPath, ref);
        set({ lut: ref, strength: g.lut ? g.strength : 1 }, `${what} LUT`, 'lut');
      }
    } catch (e) {
      useApp.getState().toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section group={group} title={`${what} LUT`} icon="palette" action={<Reset show={!!g.lut} onClick={() => set({ lut: null }, `Remove ${what.toLowerCase()} LUT`, 'lut')} />}>
        {g.lut ? (
          <>
            <div className="lut-row" data-testid={`lut-${layer}`}>
              <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                <span className="lut-name" title={g.lut.name}>{g.lut.name}</span>
                <span className="tiny dim">{g.lut.kind === '3d' ? `3D · ${g.lut.size}×${g.lut.size}×${g.lut.size}` : `1D · ${g.lut.size} steps`}</span>
              </div>
              <button className="btn sm" disabled={busy} onClick={() => void choose()}>Replace…</button>
            </div>
            {entry?.status === 'loading' ? (
              <div className="status-line" role="status">
                <span className="spinner" style={{ width: 12, height: 12 }} /> Reading the LUT…
              </div>
            ) : null}
            {entry?.status === 'failed' ? (
              <div className="status-line bad" role="alert">
                <span className="grow">{entry.error}</span>
                <button className="reset-link" onClick={() => forgetLut(projectPath, g.lut!)}>Try again</button>
              </div>
            ) : null}
            <Slider label="Strength" min={0} max={1} value={g.strength} format={pct} onChange={(v) => set({ strength: v }, `${what} LUT strength`, 'strength')} />
          </>
        ) : (
          <>
            <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={() => void choose()}>
              <Icon name="folder" size={14} /> Choose a .cube file…
            </button>
            <div className="tiny dim">{layer === 'screen' ? 'Recolours the screen recording. The file is copied into the project.' : 'Recolours every camera. The file is copied into the project.'}</div>
          </>
        )}
      </Section>
      <Section title={`${what} sharpening`} icon="palette" action={<Reset show={g.sharpen > 0.005} onClick={() => set({ sharpen: 0 }, `${what} sharpening`, 'sharpen')} />}>
        <Slider min={0} max={1} value={g.sharpen} format={(v) => (v < 0.01 ? 'Off' : pct(v))} label="Amount" onChange={(v) => set({ sharpen: v }, `${what} sharpening`, 'sharpen')} />
      </Section>
    </>
  );
}
