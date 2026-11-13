import { Section } from './shared';

export function ShortcutsTab() {
  return (
    <Section group="Keyboard shortcuts" title="Show keyboard shortcuts" icon="command">
      <div className="tiny dim">Shortcuts pressed while recording can be shown as labels in the video. This recording has no shortcut data.</div>
    </Section>
  );
}
