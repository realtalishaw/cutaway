/**
 * Keyboard shortcuts: one list of commands and their default bindings, used by
 * the application menu and global shortcuts (main process) and by the editor,
 * the command menu and Settings (renderer). The creator's changes are stored
 * in AppSettings.shortcuts as { commandId: combo }, '' meaning "no shortcut".
 *
 * A combo is written like "Ctrl+Alt+F", "Shift+Cmd+E", "Space" or "X":
 * modifiers in the order Ctrl, Alt, Shift, Cmd, then one key.
 */

export type KeyScope =
  /** Application menu item: works anywhere in the app, needs a modifier. */
  | 'menu'
  /** Works in the editor while no text field has focus. */
  | 'editor'
  /** Works from any app while Cutaway is open, needs a modifier. */
  | 'global';

export interface KeyCommand {
  id: string;
  label: string;
  group: 'General' | 'Recording' | 'Playback' | 'Editing' | 'Sidebar';
  scope: KeyScope;
  /** Default combo. */
  combo: string;
}

export type KeyOverrides = Record<string, string>;

export const KEY_COMMANDS: KeyCommand[] = [
  { id: 'palette', label: 'Command menu', group: 'General', scope: 'menu', combo: 'Cmd+K' },
  { id: 'record', label: 'New recording', group: 'General', scope: 'menu', combo: 'Cmd+N' },
  { id: 'import', label: 'Import media', group: 'General', scope: 'menu', combo: 'Cmd+I' },
  { id: 'library', label: 'Project library', group: 'General', scope: 'menu', combo: 'Shift+Cmd+L' },
  { id: 'save', label: 'Save now', group: 'General', scope: 'menu', combo: 'Cmd+S' },
  { id: 'export', label: 'Export', group: 'General', scope: 'menu', combo: 'Shift+Cmd+E' },
  { id: 'settings', label: 'Settings', group: 'General', scope: 'menu', combo: 'Cmd+,' },

  { id: 'record-toggle', label: 'Start a recording, or stop the one in progress, from any app', group: 'Recording', scope: 'global', combo: 'Ctrl+Alt+Cmd+R' },
  { id: 'flag', label: 'Flag this moment while recording, from any app', group: 'Recording', scope: 'global', combo: 'Ctrl+Alt+F' },

  { id: 'play', label: 'Play or pause', group: 'Playback', scope: 'editor', combo: 'Space' },
  { id: 'frame-back', label: 'Back one frame', group: 'Playback', scope: 'editor', combo: 'ArrowLeft' },
  { id: 'frame-forward', label: 'Forward one frame', group: 'Playback', scope: 'editor', combo: 'ArrowRight' },
  { id: 'second-back', label: 'Back one second', group: 'Playback', scope: 'editor', combo: 'Shift+ArrowLeft' },
  { id: 'second-forward', label: 'Forward one second', group: 'Playback', scope: 'editor', combo: 'Shift+ArrowRight' },
  { id: 'flag-prev', label: 'Go to the previous flag', group: 'Playback', scope: 'editor', combo: '[' },
  { id: 'flag-next', label: 'Go to the next flag', group: 'Playback', scope: 'editor', combo: ']' },

  { id: 'version-prev', label: 'Look at the previous version', group: 'Playback', scope: 'editor', combo: 'Alt+[' },
  { id: 'version-next', label: 'Look at the next version', group: 'Playback', scope: 'editor', combo: 'Alt+]' },

  { id: 'undo', label: 'Undo', group: 'Editing', scope: 'menu', combo: 'Cmd+Z' },
  { id: 'redo', label: 'Redo', group: 'Editing', scope: 'menu', combo: 'Shift+Cmd+Z' },
  { id: 'mark-in', label: 'Mark the start of a range', group: 'Editing', scope: 'editor', combo: 'I' },
  { id: 'mark-out', label: 'Mark the end of a range', group: 'Editing', scope: 'editor', combo: 'O' },
  { id: 'cut', label: 'Cut the selected range', group: 'Editing', scope: 'editor', combo: 'X' },
  { id: 'keep', label: 'Keep the selected range (protect it from AI changes)', group: 'Editing', scope: 'editor', combo: 'L' },
  { id: 'delete', label: 'Remove the selected item', group: 'Editing', scope: 'editor', combo: 'Backspace' },
  { id: 'split', label: 'Split the selected block, or the clip, at the playhead', group: 'Editing', scope: 'menu', combo: 'Cmd+B' },
  { id: 'split-key', label: 'Split at the playhead (one key)', group: 'Editing', scope: 'editor', combo: 'S' },
  { id: 'lock', label: 'Lock the selection against AI changes', group: 'Editing', scope: 'menu', combo: 'Cmd+L' },
  { id: 'layout-camera', label: 'Fullscreen camera from the playhead', group: 'Editing', scope: 'editor', combo: 'Ctrl+L' },
  { id: 'layout-screen', label: 'Screen only from the playhead', group: 'Editing', scope: 'editor', combo: 'Ctrl+S' },
  { id: 'layout-both', label: 'Screen with camera overlay from the playhead', group: 'Editing', scope: 'editor', combo: 'Ctrl+B' },
  { id: 'add-text', label: 'Add text at the playhead', group: 'Editing', scope: 'editor', combo: 'T' },
  { id: 'duplicate', label: 'Duplicate the selected blocks', group: 'Editing', scope: 'menu', combo: 'Cmd+D' },
  { id: 'nudge-back', label: 'Move the selected blocks one frame earlier', group: 'Editing', scope: 'editor', combo: 'Alt+ArrowLeft' },
  { id: 'nudge-forward', label: 'Move the selected blocks one frame later', group: 'Editing', scope: 'editor', combo: 'Alt+ArrowRight' },
  { id: 'nudge-back-more', label: 'Move the selected blocks one second earlier', group: 'Editing', scope: 'editor', combo: 'Alt+Shift+ArrowLeft' },
  { id: 'nudge-forward-more', label: 'Move the selected blocks one second later', group: 'Editing', scope: 'editor', combo: 'Alt+Shift+ArrowRight' },

  { id: 'tab:background', label: 'Background', group: 'Sidebar', scope: 'menu', combo: 'Cmd+1' },
  { id: 'tab:cursor', label: 'Cursor', group: 'Sidebar', scope: 'menu', combo: 'Cmd+2' },
  { id: 'tab:camera', label: 'Camera', group: 'Sidebar', scope: 'menu', combo: 'Cmd+3' },
  { id: 'tab:captions', label: 'Captions', group: 'Sidebar', scope: 'menu', combo: 'Cmd+4' },
  { id: 'tab:transcript', label: 'Transcript', group: 'Sidebar', scope: 'menu', combo: 'Cmd+5' },
  { id: 'tab:audio', label: 'Audio', group: 'Sidebar', scope: 'menu', combo: 'Cmd+6' },
  { id: 'tab:shortcuts', label: 'Keyboard shortcuts overlay', group: 'Sidebar', scope: 'menu', combo: 'Cmd+7' },
  { id: 'tab:motion', label: 'Animations', group: 'Sidebar', scope: 'menu', combo: 'Cmd+8' },
  { id: 'tab:chat', label: 'Ask AI', group: 'Sidebar', scope: 'menu', combo: 'Cmd+9' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', group: 'Sidebar', scope: 'menu', combo: 'Cmd+\\' },
  { id: 'toggle-timeline', label: 'Show or hide the extra timelines', group: 'Sidebar', scope: 'menu', combo: 'Cmd+T' },
];

export const KEY_GROUPS: KeyCommand['group'][] = ['General', 'Recording', 'Playback', 'Editing', 'Sidebar'];

const BY_ID = new Map(KEY_COMMANDS.map((c) => [c.id, c]));
export const keyCommand = (id: string): KeyCommand | undefined => BY_ID.get(id);

const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;
type Mod = (typeof MODS)[number];

/** macOS shortcuts that belong to the system or to text editing and must stay as they are. */
const RESERVED = new Set(['Cmd+Q', 'Cmd+W', 'Cmd+H', 'Alt+Cmd+H', 'Cmd+M', 'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+A', 'Cmd+Tab', 'Cmd+Space', 'Ctrl+Cmd+F', 'Escape', 'Enter', 'Tab']);

export function parseCombo(combo: string): { mods: Mod[]; key: string } | null {
  if (!combo) return null;
  // The key itself may be "+", so split on the separators before it only.
  const parts = combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+');
  const key = parts.pop();
  if (!key) return null;
  const mods = MODS.filter((m) => parts.includes(m));
  if (mods.length !== parts.length) return null;
  return { mods, key };
}

export function normalizeCombo(combo: string): string {
  const p = parseCombo(combo);
  return p ? [...p.mods, p.key.length === 1 ? p.key.toUpperCase() : p.key].join('+') : '';
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Backquote: '`',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The combo a key press stands for, or null while only modifiers are down. */
export function comboFromEvent(e: KeyLike): string | null {
  let key: string | undefined;
  // The physical key, so ⌥F is "F" rather than the "ƒ" it types.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code];
  if (!key) {
    if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null;
    key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  const mods: Mod[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Cmd');
  return [...mods, key].join('+');
}

const SYMBOL: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Enter: '↩', Tab: '⇥', PageUp: '⇞', PageDown: '⇟' };

/** "Ctrl+Alt+F" → "⌃⌥F". Empty for no shortcut. */
export function formatCombo(combo: string): string {
  const p = parseCombo(combo);
  if (!p) return '';
  return `${p.mods.map((m) => SYMBOL[m]).join('')}${SYMBOL[p.key] ?? p.key}`;
}

const ACCEL_KEY: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Return', Escape: 'Esc', '+': 'Plus' };
const ACCEL_MOD: Record<Mod, string> = { Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Cmd: 'Command' };

/** Electron accelerator for a combo, or undefined for no shortcut. */
export function toAccelerator(combo: string): string | undefined {
  const p = parseCombo(combo);
  if (!p) return undefined;
  return [...p.mods.map((m) => ACCEL_MOD[m]), ACCEL_KEY[p.key] ?? p.key].join('+');
}

/** Current combo of a command ('' when the creator removed it). */
export function bindingOf(id: string, overrides: KeyOverrides | null | undefined): string {
  const o = overrides?.[id];
  if (typeof o === 'string') return normalizeCombo(o);
  return BY_ID.get(id)?.combo ?? '';
}

/** Which command a combo runs, among the given scopes. */
export function commandFor(combo: string | null, overrides: KeyOverrides | null | undefined, scopes: KeyScope[] = ['editor']): KeyCommand | null {
  if (!combo) return null;
  return KEY_COMMANDS.find((c) => scopes.includes(c.scope) && bindingOf(c.id, overrides) === combo) ?? null;
}

/** Another command that already uses this combo. */
export function conflictFor(id: string, combo: string, overrides: KeyOverrides | null | undefined): KeyCommand | null {
  const want = normalizeCombo(combo);
  if (!want) return null;
  return KEY_COMMANDS.find((c) => c.id !== id && bindingOf(c.id, overrides) === want) ?? null;
}

/** Why a combo cannot be used for a command, or null when it can. */
export function comboProblem(id: string, combo: string): string | null {
  const cmd = BY_ID.get(id);
  const p = parseCombo(normalizeCombo(combo));
  if (!cmd || !p) return 'That is not a key combination.';
  const norm = normalizeCombo(combo);
  if (RESERVED.has(norm)) return `${formatCombo(norm)} is used by macOS or by text editing.`;
  const strong = p.mods.some((m) => m !== 'Shift');
  if (cmd.scope !== 'editor' && !strong) return 'This shortcut works while you type, so it needs ⌘, ⌃ or ⌥.';
  if (cmd.scope === 'global' && p.mods.length < 2) return 'A shortcut that works from any app needs at least two of ⌃ ⌥ ⇧ ⌘, so it does not take over a key other apps use.';
  return null;
}

/** Overrides with one command changed. Setting a command back to its default removes the override. */
export function withBinding(overrides: KeyOverrides | null | undefined, id: string, combo: string): KeyOverrides {
  const next: KeyOverrides = { ...(overrides ?? {}) };
  const norm = normalizeCombo(combo);
  if (norm === (BY_ID.get(id)?.combo ?? '')) delete next[id];
  else next[id] = norm;
  return next;
}
