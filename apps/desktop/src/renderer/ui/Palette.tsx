import { useEffect, useMemo, useRef, useState } from 'react';
import { setEveryTransition, togglePunch } from '../screens/editor/transitionOps';
import type { ProjectSummary } from '@shared/api';
import { saveNow, useApp, usePlayback, type InspectorTab } from '../state/store';
import { makeShortFromRange } from '../state/shorts';
import { backToLibrary, newRecording, openProjectAt, pickAndImport } from '../state/actions';
import { keyHint } from '../state/keymap';
import { Icon, type IconName } from './icons';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  keys?: string;
  run(): void;
}

/** ⌘K command menu: every action in the app, searchable. */
export function Palette({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const project = useApp((s) => s.project);
  useEffect(() => {
    window.cutaway.library.list().then(setProjects).catch(() => {});
  }, []);

  const commands = useMemo(() => {
    const app = () => useApp.getState();
    const has = !!project && project.sources.length > 0;
    const view = (v: 'sources' | 'brief' | 'edit' | 'package' | 'shorts' | 'export') => () => (app().go('project'), app().setView(v));
    const tab = (t: InspectorTab) => () => (view('edit')(), app().select(null), app().setPanels({ inspector: true, tab: t }));
    const out: Command[] = [
      { id: 'record', label: 'New recording', icon: 'record', keys: keyHint('record'), run: () => void newRecording() },
      { id: 'import', label: project ? 'Import media into this project' : 'Import footage', icon: 'import', keys: keyHint('import'), run: () => void pickAndImport(!project) },
      { id: 'library', label: 'Show previous projects', icon: 'folder', keys: keyHint('library'), run: () => void backToLibrary() },
      { id: 'settings', label: 'Settings', icon: 'gear', keys: keyHint('settings'), run: () => app().go('settings') },
    ];
    if (has) {
      out.push(
        { id: 'edit', label: 'Go to Edit', icon: 'film', run: view('edit') },
        { id: 'package', label: 'Go to Package', hint: 'Thumbnail and title', icon: 'image', run: view('package') },
        { id: 'shorts', label: 'Go to Shorts', hint: 'Vertical clips with captions', icon: 'phone', run: view('shorts') },
        {
          id: 'short-from-selection',
          label: 'Make a short from the selection',
          hint: 'The selected range or words, fitted to whole sentences',
          icon: 'phone',
          run: () => {
            const sel = app().selection;
            if (!sel || (sel.kind !== 'range' && sel.kind !== 'words')) return app().toast('Select a range on the timeline or some words in the transcript first.');
            const made = makeShortFromRange(sel.range);
            if ('error' in made) return app().toast(made.error, 'error');
            view('shorts')();
          },
        },
        { id: 'export', label: 'Export…', icon: 'upload', keys: keyHint('export'), run: view('export') },
        { id: 'sources', label: 'Go to Sources', hint: 'Tracks, sync, voice', icon: 'sync', run: view('sources') },
        { id: 'firstcut', label: project?.firstCut ? 'Create a new first cut' : 'Create first cut', icon: 'sparkle', run: view('brief') },
        { id: 'play', label: 'Play or pause', icon: 'play', keys: keyHint('play'), run: () => usePlayback.getState().toggle() },
        { id: 'undo', label: 'Undo', icon: 'undo', keys: keyHint('undo'), run: () => app().undo() },
        { id: 'redo', label: 'Redo', icon: 'redo', keys: keyHint('redo'), run: () => app().redo() },
        { id: 'save', label: 'Save now', icon: 'check', keys: keyHint('save'), run: () => void saveNow().then(() => app().toast('Saved')) },
        { id: 'transcript', label: 'Edit transcript', icon: 'captions', keys: keyHint('tab:transcript'), run: tab('transcript') },
        { id: 'review', label: 'Review what the AI changed', icon: 'sparkle', run: tab('review') },
        { id: 'chat', label: 'Ask AI about this edit', hint: 'Chat, propose and apply changes', icon: 'chat', keys: keyHint('tab:chat'), run: tab('chat') },
        { id: 'history', label: 'History and checkpoints', icon: 'history', run: tab('history') },
        { id: 'version-prev', label: 'Look at the previous version', hint: 'Read-only until you restore it', icon: 'history', keys: keyHint('version-prev'), run: () => (view('edit')(), void setTimeout(() => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'version-prev' })), 120)) },
        { id: 'sidebar', label: 'Show or hide the sidebar', icon: 'sidebar', keys: keyHint('toggle-sidebar'), run: () => app().setPanels({ inspector: !app().panels.inspector }) },
        { id: 'tracks', label: 'Show or hide the layout and graphics tracks', icon: 'layout', keys: keyHint('toggle-timeline'), run: () => app().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: !p.ui.expandedTimeline } })) },
        { id: 't-bg', label: 'Background and shape', icon: 'frame', keys: keyHint('tab:background'), run: tab('background') },
        { id: 't-cursor', label: 'Cursor', icon: 'pointer', keys: keyHint('tab:cursor'), run: tab('cursor') },
        { id: 't-camera', label: 'Camera', icon: 'camera', keys: keyHint('tab:camera'), run: tab('camera') },
        { id: 't-captions', label: 'Captions', icon: 'captions', keys: keyHint('tab:captions'), run: tab('captions') },
        { id: 't-audio', label: 'Audio', hint: 'Voice, music and sound effects', icon: 'speaker', keys: keyHint('tab:audio'), run: tab('audio') },
        { id: 'add-text', label: 'Add text at the playhead', icon: 'text', keys: keyHint('add-text'), run: () => (view('edit')(), void setTimeout(() => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'add-text' })), 60)) },
        { id: 't-text', label: 'Add a title, lower third or card', hint: 'Text and titles', icon: 'text', run: tab('text') },
        { id: 'add-music', label: 'Add music or a sound effect', hint: 'Audio tab', icon: 'music', run: tab('audio') },
        { id: 'transitions-dissolve', label: 'Cross-dissolve every clip change', hint: 'Transitions between clips', icon: 'layout', run: () => (view('edit')(), setEveryTransition('dissolve')) },
        { id: 'transitions-none', label: 'Remove all transitions', hint: 'Clip changes become hard cuts', icon: 'layout', run: () => (view('edit')(), setEveryTransition(null)) },
        { id: 'punch-in', label: 'Punch in on jump cuts: on or off', hint: 'Hides cuts inside a camera shot', icon: 'camera', run: () => (view('edit')(), togglePunch()) },
        { id: 't-keys', label: 'Keyboard shortcuts overlay', icon: 'command', keys: keyHint('tab:shortcuts'), run: tab('shortcuts') },
        { id: 't-motion', label: 'Animation', icon: 'path', keys: keyHint('tab:motion'), run: tab('motion') },
        { id: 'flag-next', label: 'Go to the next flag', hint: 'Moments you marked while recording', icon: 'flag', keys: keyHint('flag-next'), run: () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'flag-next' })) },
        { id: 'flag-prev', label: 'Go to the previous flag', icon: 'flag', keys: keyHint('flag-prev'), run: () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'flag-prev' })) },
        { id: 'sensitive', label: 'Find sensitive data to hide', hint: 'Emails, keys, card numbers', icon: 'mask', run: () => (view('edit')(), void setTimeout(() => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'find-sensitive' })), 120)) },
        { id: 'crop', label: 'Crop the recording…', icon: 'crop', run: () => (view('edit')(), void setTimeout(() => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'crop' })), 120)) },
        { id: 'shortcuts', label: 'Change keyboard shortcuts', hint: 'Settings → Shortcuts', icon: 'command', run: () => app().go('settings') },
        { id: 'split', label: 'Split the selected block at the playhead', icon: 'scissors', keys: keyHint('split'), run: () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'split' })) },
      );
    }
    for (const p of projects.slice(0, 30)) out.push({ id: `open:${p.path}`, label: p.name, hint: 'Open project', icon: 'film', run: () => void openProjectAt(p.path) });
    return out;
  }, [project, projects]);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w)));
  }, [q, commands]);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="scrim" style={{ placeItems: 'start center', paddingTop: '14vh' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command menu">
        <div className="palette-input">
          <Icon name="command" size={16} style={{ color: 'var(--text-3)' }} />
          <input
            autoFocus
            placeholder="Type a command or project name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(shown.length - 1, i + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
              else if (e.key === 'Enter') run(shown[index]);
            }}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {shown.length === 0 ? <div className="tiny dim" style={{ padding: 14 }}>Nothing matches “{q}”.</div> : null}
          {shown.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === index} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => run(c)}>
              <Icon name={c.icon} size={15} />
              <span className="grow" style={{ textAlign: 'left' }}>{c.label}</span>
              {c.hint ? <span className="tiny dim">{c.hint}</span> : null}
              {c.keys ? <span className="kbd">{c.keys}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
