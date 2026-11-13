import { useApp, type InspectorTab } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { Banner, Button } from '../../ui/kit';
import { BackgroundTab } from './inspector/BackgroundTab';
import { CursorTab } from './inspector/CursorTab';
import { CameraTab } from './inspector/CameraTab';
import { CaptionsTab } from './inspector/CaptionsTab';
import { AudioTab } from './inspector/AudioTab';
import { ShortcutsTab } from './inspector/ShortcutsTab';
import { MotionTab } from './inspector/MotionTab';
import { SelectionPanel } from './inspector/Selection';
import { app } from './inspector/shared';

const TABS: { id: InspectorTab; icon: IconName; label: string }[] = [
  { id: 'background', icon: 'frame', label: 'Background and shape' },
  { id: 'cursor', icon: 'pointer', label: 'Cursor' },
  { id: 'camera', icon: 'camera', label: 'Camera' },
  { id: 'captions', icon: 'captions', label: 'Captions and transcript' },
  { id: 'audio', icon: 'speaker', label: 'Audio' },
  { id: 'shortcuts', icon: 'command', label: 'Keyboard shortcuts' },
  { id: 'motion', icon: 'path', label: 'Animation' },
];

/** Right sidebar: a rail of icon tabs beside one rounded card, like Screen Studio's. */
export function Inspector({ pickTarget }: { pickTarget: (what: 'zoom' | 'mask' | 'callout' | null) => void }) {
  const sel = useApp((s) => s.selection);
  const comparing = useApp((s) => !!s.comparison);
  const tab = useApp((s) => s.panels.tab);
  const drawer = useApp((s) => s.panels.drawer);
  const openSuggestions = useApp((s) => s.project?.edit.suggestions.filter((x) => x.status === 'open').length ?? 0);
  const setPanels = useApp((s) => s.setPanels);
  return (
    <aside className="inspector" aria-label="Inspector">
      <nav className="insp-rail" aria-label="Inspector sections">
        {TABS.map((t) => (
          <button key={t.id} className={!sel && tab === t.id ? 'on' : ''} aria-pressed={!sel && tab === t.id} title={t.label} aria-label={t.label} onClick={() => (app().select(null), setPanels({ tab: t.id }))}>
            <Icon name={t.icon} size={20} />
          </button>
        ))}
        <span className="rail-sep" />
        <button className={drawer === 'review' ? 'on ai' : 'ai'} aria-pressed={drawer === 'review'} title="AI review: what the first cut changed" aria-label="AI review" onClick={() => setPanels({ drawer: drawer === 'review' ? null : 'review' })}>
          <Icon name="sparkle" size={20} />
          {openSuggestions ? <i className="badge">{openSuggestions}</i> : null}
        </button>
        <button className={drawer === 'history' ? 'on' : ''} aria-pressed={drawer === 'history'} title="History and checkpoints" aria-label="History" onClick={() => setPanels({ drawer: drawer === 'history' ? null : 'history' })}>
          <Icon name="history" size={20} />
        </button>
      </nav>
      <div className="insp-card">
        {comparing ? (
          <div className="insp-section">
            <Banner icon="eye" title="Comparing a proposed change">Accept or discard it under the preview to keep editing.</Banner>
          </div>
        ) : sel ? (
          <>
            <div className="insp-back">
              <Button size="sm" variant="ghost" icon="back" onClick={() => app().select(null)}>Back</Button>
            </div>
            <SelectionPanel pickTarget={pickTarget} />
          </>
        ) : tab === 'background' ? (
          <BackgroundTab />
        ) : tab === 'cursor' ? (
          <CursorTab />
        ) : tab === 'camera' ? (
          <CameraTab />
        ) : tab === 'captions' ? (
          <CaptionsTab />
        ) : tab === 'audio' ? (
          <AudioTab />
        ) : tab === 'shortcuts' ? (
          <ShortcutsTab />
        ) : (
          <MotionTab />
        )}
      </div>
    </aside>
  );
}
