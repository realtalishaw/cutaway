import { useApp, type InspectorTab } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { Banner } from '../../ui/kit';
import { Transcript } from './Transcript';
import { History, Review } from './Review';
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
  { id: 'background', icon: 'frame', label: 'Background' },
  { id: 'cursor', icon: 'pointer', label: 'Cursor' },
  { id: 'camera', icon: 'camera', label: 'Camera' },
  { id: 'captions', icon: 'captions', label: 'Captions' },
  { id: 'transcript', icon: 'transcript', label: 'Transcript' },
  { id: 'audio', icon: 'speaker', label: 'Audio' },
  { id: 'shortcuts', icon: 'command', label: 'Keyboard shortcuts' },
  { id: 'motion', icon: 'path', label: 'Animations' },
];

const CLOSE_LABEL: Record<string, string> = { zoom: 'Zoom', layout: 'Layout', cut: 'Cut', overlay: 'Graphic', broll: 'B-roll', mask: 'Mask', lock: 'Lock', speed: 'Speed', range: 'Selection', words: 'Selection', suggestion: 'Suggestion' };

/** Right sidebar: a rail of icon tabs beside one rounded card, like Screen Studio's. */
export function Inspector({ pickTarget }: { pickTarget: (what: 'zoom' | 'mask' | 'callout' | null) => void }) {
  const sel = useApp((s) => s.selection);
  const comparing = useApp((s) => !!s.comparison);
  const tab = useApp((s) => s.panels.tab);
  const openSuggestions = useApp((s) => s.project?.edit.suggestions.filter((x) => x.status === 'open').length ?? 0);
  const hasKeys = useApp((s) => !!s.project?.sources.some((x) => (x as { keysFile?: string }).keysFile));
  const setPanels = useApp((s) => s.setPanels);
  // Text selections made in the transcript are acted on there, not in a separate editor.
  const contextual = !!sel && !(tab === 'transcript' && sel.kind === 'words');
  const railBtn = (id: InspectorTab, icon: IconName, label: string, extra = '') => (
    <button key={id} className={`${!contextual && tab === id ? 'on' : ''} ${extra}`} aria-pressed={!contextual && tab === id} title={label} aria-label={label} onClick={() => (app().select(null), setPanels({ tab: id }))}>
      <Icon name={icon} size={20} />
      {id === 'review' && openSuggestions ? <i className="badge">{openSuggestions}</i> : null}
    </button>
  );
  const fill = !contextual && !comparing && (tab === 'transcript' || tab === 'review' || tab === 'history');
  return (
    <aside className="inspector" aria-label="Inspector">
      <nav className="insp-rail" aria-label="Inspector sections">
        {TABS.map((t) => railBtn(t.id, t.icon, t.label, t.id === 'shortcuts' && !hasKeys ? 'dim' : ''))}
        <span className="rail-sep" />
        {railBtn('review', 'sparkle', 'AI review: what the first cut changed')}
        {railBtn('history', 'history', 'History and checkpoints')}
      </nav>
      <div className={`insp-card${fill ? ' fill' : ''}`}>
        {comparing ? (
          <div className="insp-section">
            <Banner icon="eye" title="Comparing a proposed change">Accept or discard it above the preview to keep editing.</Banner>
          </div>
        ) : contextual ? (
          <>
            <div className="insp-back">
              <button className="btn block" onClick={() => app().select(null)}>
                <Icon name="arrowLeft" size={15} /> Close {CLOSE_LABEL[sel!.kind] ?? ''} editor
              </button>
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
        ) : tab === 'transcript' ? (
          <Transcript />
        ) : tab === 'audio' ? (
          <AudioTab />
        ) : tab === 'shortcuts' ? (
          <ShortcutsTab />
        ) : tab === 'review' ? (
          <Review />
        ) : tab === 'history' ? (
          <History />
        ) : (
          <MotionTab />
        )}
      </div>
    </aside>
  );
}
