import { useProject } from '../../../state/store';
import { Segmented } from '../../../ui/kit';
import { Section, setAppearance } from './shared';

export function MotionTab() {
  const project = useProject();
  const ap = project.edit.appearance;
  return (
    <>
      <Section group="Animation" title="Animation speed" icon="path">
        <Segmented full value={ap.motion} onChange={(v) => setAppearance((a) => ({ ...a, motion: v }), 'Motion', 'motion')} options={[{ value: 'calm', label: 'Slow' }, { value: 'balanced', label: 'Medium' }, { value: 'lively', label: 'Rapid' }]} />
        <div className="tiny dim">How quickly zooms and view changes animate in the video.</div>
      </Section>
    </>
  );
}
