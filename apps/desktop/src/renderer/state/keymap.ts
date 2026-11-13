/**
 * The renderer's view of the keymap (shared/keymap.ts): what a key press means
 * right now, and what to print next to a command, given the creator's changes.
 */
import { bindingOf, comboFromEvent, commandFor, formatCombo, type KeyOverrides, type KeyScope } from '@shared/keymap';
import { useApp } from './store';

export const keyOverrides = (): KeyOverrides | null => useApp.getState().settings?.shortcuts ?? null;

/** "⌘K" for a command, or undefined when it has no shortcut. */
export function keyHint(id: string, overrides: KeyOverrides | null = keyOverrides()): string | undefined {
  return formatCombo(bindingOf(id, overrides)) || undefined;
}

/** Hint that re-renders when shortcuts change. */
export function useKeyHint(id: string): string | undefined {
  return useApp((s) => formatCombo(bindingOf(id, s.settings?.shortcuts)) || undefined);
}

/** The editor command a key press runs, if any. Menu commands arrive through the application menu instead. */
export function commandForEvent(e: KeyboardEvent, scopes: KeyScope[] = ['editor']): string | null {
  return commandFor(comboFromEvent(e), keyOverrides(), scopes)?.id ?? null;
}
