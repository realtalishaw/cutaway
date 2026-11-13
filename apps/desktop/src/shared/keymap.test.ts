import { describe, expect, it } from 'vitest';
import { KEY_COMMANDS, bindingOf, comboFromEvent, comboProblem, commandFor, conflictFor, formatCombo, normalizeCombo, toAccelerator, withBinding } from './keymap';

const ev = (code: string, key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('keymap', () => {
  it('defaults are unique, canonical and valid for their scope', () => {
    const seen = new Map<string, string>();
    for (const c of KEY_COMMANDS) {
      expect(normalizeCombo(c.combo), c.id).toBe(c.combo);
      expect(comboProblem(c.id, c.combo), c.id).toBeNull();
      expect(seen.get(c.combo), `${c.id} shares ${c.combo}`).toBeUndefined();
      seen.set(c.combo, c.id);
    }
  });

  it('reads a key press as a combo from the physical key', () => {
    expect(comboFromEvent(ev('KeyX', 'x'))).toBe('X');
    // ⌥F types "ƒ" on a Mac; the binding is still F.
    expect(comboFromEvent(ev('KeyF', 'ƒ', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+F');
    expect(comboFromEvent(ev('KeyE', 'E', { metaKey: true, shiftKey: true }))).toBe('Shift+Cmd+E');
    expect(comboFromEvent(ev('ArrowLeft', 'ArrowLeft', { shiftKey: true }))).toBe('Shift+ArrowLeft');
    expect(comboFromEvent(ev('Space', ' '))).toBe('Space');
    expect(comboFromEvent(ev('BracketRight', ']'))).toBe(']');
    expect(comboFromEvent(ev('MetaLeft', 'Meta', { metaKey: true }))).toBeNull();
  });

  it('prints combos as symbols and as menu accelerators', () => {
    expect(formatCombo('Ctrl+Alt+Cmd+R')).toBe('⌃⌥⌘R');
    expect(formatCombo('Shift+ArrowLeft')).toBe('⇧←');
    expect(formatCombo('Backspace')).toBe('⌫');
    expect(formatCombo('')).toBe('');
    expect(toAccelerator('Shift+Cmd+E')).toBe('Shift+Command+E');
    expect(toAccelerator('Ctrl+Alt+F')).toBe('Control+Alt+F');
    expect(toAccelerator('Cmd+\\')).toBe('Command+\\');
    expect(toAccelerator('ArrowLeft')).toBe('Left');
    expect(toAccelerator('')).toBeUndefined();
  });

  it('resolves commands through the creator\'s changes', () => {
    expect(commandFor('X', null)?.id).toBe('cut');
    const o = withBinding(withBinding(null, 'keep', 'K'), 'cut', '');
    expect(o).toEqual({ keep: 'K', cut: '' });
    expect(bindingOf('cut', o)).toBe('');
    expect(commandFor('X', o)).toBeNull();
    expect(commandFor('K', o)?.id).toBe('keep');
    // menu commands are not editor keys
    expect(commandFor('Cmd+K', null)).toBeNull();
    expect(commandFor('Cmd+K', null, ['menu'])?.id).toBe('palette');
    // setting a command back to its default drops the override
    expect(withBinding(o, 'keep', 'L')).toEqual({ cut: '' });
  });

  it('reports conflicts and combos that cannot be used', () => {
    expect(conflictFor('keep', 'x', null)?.id).toBe('cut');
    expect(conflictFor('cut', 'X', null)).toBeNull();
    expect(conflictFor('keep', 'X', { cut: '' })).toBeNull();
    expect(comboProblem('palette', 'P')).toMatch(/needs/);
    expect(comboProblem('palette', 'Shift+P')).toMatch(/needs/);
    expect(comboProblem('palette', 'Shift+Cmd+P')).toBeNull();
    expect(comboProblem('flag', 'Alt+G')).toMatch(/at least two/);
    expect(comboProblem('flag', 'Ctrl+Alt+G')).toBeNull();
    expect(comboProblem('cut', 'K')).toBeNull();
    expect(comboProblem('undo', 'Cmd+Q')).toMatch(/macOS/);
    expect(comboProblem('cut', 'Escape')).toMatch(/macOS|text editing/);
  });
});
