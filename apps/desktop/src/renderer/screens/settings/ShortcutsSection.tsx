import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/api';
import { KEY_COMMANDS, KEY_GROUPS, bindingOf, comboFromEvent, comboProblem, conflictFor, formatCombo, withBinding, type KeyCommand } from '@shared/keymap';
import { useApp } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Button } from '../../ui/kit';
import './shortcuts.css';

const SCOPE_NOTE: Record<KeyCommand['scope'], string> = {
  menu: 'Works anywhere in Cutaway',
  editor: 'Works in the editor',
  global: 'Works from any app',
};

/** Keys that are not rebindable because they act on whatever has focus. */
const FIXED: [string, string][] = [
  ['Esc', 'Deselect, or leave a picking mode'],
  ['⌦', 'Remove the selected item (same as the Remove shortcut)'],
  ['← ↑ ↓ →', 'Thumbnail canvas: nudge the selected layer (hold ⇧ for bigger steps)'],
  ['⌥ drag', 'Thumbnail canvas: move without snapping to the centre'],
];

type Pending = { id: string; combo: string; problem: string | null; conflict: KeyCommand | null };

/**
 * Every command with its shortcut. Click a shortcut, press the new keys.
 * Changes are saved in settings and apply to the menu, the editor, the command
 * menu and the shortcuts that work from other apps.
 */
export function ShortcutsSection({ update }: { update(patch: Partial<AppSettings>): Promise<void> }) {
  const overrides = useApp((s) => s.settings?.shortcuts) ?? {};
  const [capturing, setCapturing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const changed = Object.keys(overrides).length;

  const save = (next: Record<string, string>) => void update({ shortcuts: next });
  const assign = (id: string, combo: string, replace: KeyCommand | null) => {
    let next = withBinding(overrides, id, combo);
    if (replace) next = withBinding(next, replace.id, '');
    save(next);
    setPending(null);
    setCapturing(null);
  };

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      // While recording a shortcut, no key may do anything else.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setCapturing(null);
        setPending(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // modifiers only so far
      const problem = comboProblem(capturing, combo);
      const conflict = problem ? null : conflictFor(capturing, combo, overrides);
      if (!problem && !conflict) return assign(capturing, combo, null);
      setPending({ id: capturing, combo, problem, conflict });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, overrides]);

  return (
    <section className="card set-section" data-testid="shortcuts-section">
      <header className="row between" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div>
          <div className="set-title">Keyboard shortcuts</div>
          <div className="tiny dim" style={{ marginTop: 4, maxWidth: 520 }}>
            Click a shortcut and press the keys you want instead. Press Esc to leave it as it is.
          </div>
        </div>
        <Button size="sm" icon="undo" disabled={!changed} onClick={() => (setCapturing(null), setPending(null), save({}))} data-testid="shortcuts-reset">
          Reset all{changed ? ` (${changed})` : ''}
        </Button>
      </header>

      {KEY_GROUPS.map((group) => (
        <div key={group} className="col" style={{ gap: 0 }}>
          <div className="set-title" style={{ margin: '10px 0 6px' }}>{group}</div>
          <div className="keymap" role="list">
            {KEY_COMMANDS.filter((c) => c.group === group).map((c) => {
              const combo = bindingOf(c.id, overrides);
              const isChanged = c.id in overrides;
              const active = capturing === c.id;
              const p = pending?.id === c.id ? pending : null;
              return (
                <div key={c.id} className={`keymap-row${active ? ' capturing' : ''}`} role="listitem" data-command={c.id}>
                  <div className="keymap-what">
                    <div>{c.label}</div>
                    <div className="tiny dim">{SCOPE_NOTE[c.scope]}</div>
                    {p ? (
                      <div className="keymap-warn" role="alert">
                        <Icon name="warn" size={13} />
                        {p.problem ? (
                          <span className="grow">{p.problem} Press another combination.</span>
                        ) : (
                          <>
                            <span className="grow">
                              {formatCombo(p.combo)} is already used by “{p.conflict!.label}”.
                            </span>
                            <button className="btn sm" data-testid="shortcut-replace" onClick={() => assign(c.id, p.combo, p.conflict)}>
                              Use it here instead
                            </button>
                            <button className="btn ghost sm" onClick={() => (setPending(null), setCapturing(null))}>
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <button
                      className={`keymap-key${active ? ' on' : ''}${combo ? '' : ' none'}`}
                      onClick={() => (setPending(null), setCapturing(active ? null : c.id))}
                      aria-label={`Shortcut for ${c.label}: ${combo ? formatCombo(combo) : 'none'}. Click to change.`}
                      title="Click, then press the new shortcut"
                    >
                      {active ? (p ? formatCombo(p.combo) : 'Press keys…') : combo ? formatCombo(combo) : 'None'}
                    </button>
                    <button className="btn ghost icon sm" disabled={!combo} onClick={() => (setPending(null), setCapturing(null), save(withBinding(overrides, c.id, '')))} title="Remove this shortcut" aria-label={`Remove the shortcut for ${c.label}`}>
                      <Icon name="x" size={12} />
                    </button>
                    <button className="btn ghost icon sm" style={{ visibility: isChanged ? 'visible' : 'hidden' }} onClick={() => (setPending(null), setCapturing(null), save(withBinding(overrides, c.id, c.combo)))} title={`Back to ${formatCombo(c.combo)}`} aria-label={`Reset the shortcut for ${c.label} to ${formatCombo(c.combo)}`}>
                      <Icon name="undo" size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="col" style={{ gap: 0 }}>
        <div className="set-title" style={{ margin: '10px 0 6px' }}>Fixed keys</div>
        <table className="keys">
          <tbody>
            {FIXED.map(([k, what]) => (
              <tr key={k}>
                <th scope="row">
                  <span className="kbd big">{k}</span>
                </th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
