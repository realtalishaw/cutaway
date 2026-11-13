import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectSummary } from '@shared/api';
import { saveNow, useApp, usePlayback, type InspectorTab } from '../state/store';
import { backToLibrary, newRecording, openProjectAt, pickAndImport } from '../state/actions';
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
    const view = (v: 'sources' | 'brief' | 'edit' | 'package' | 'export') => () => (app().go('project'), app().setView(v));
    const tab = (t: InspectorTab) => () => (view('edit')(), app().select(null), app().setPanels({ inspector: true, tab: t }));
    const out: Command[] = [
      { id: 'record', label: 'New recording', icon: 'record', keys: '⌘N', run: () => void newRecording() },
      { id: 'import', label: project ? 'Import media into this project' : 'Import footage', icon: 'import', keys: '⌘I', run: () => void pickAndImport(!project) },
      { id: 'library', label: 'Show previous projects', icon: 'folder', keys: '⇧⌘L', run: () => void backToLibrary() },
      { id: 'settings', label: 'Settings', icon: 'gear', keys: '⌘,', run: () => app().go('settings') },
    ];
    if (has) {
      out.push(
        { id: 'edit', label: 'Go to Edit', icon: 'film', keys: '⌘1', run: view('edit') },
        { id: 'package', label: 'Go to Package', hint: 'Thumbnail and title', icon: 'image', keys: '⌘2', run: view('package') },
        { id: 'export', label: 'Export…', icon: 'upload', keys: '⌘E', run: view('export') },
        { id: 'sources', label: 'Go to Sources', hint: 'Tracks, sync, voice', icon: 'sync', run: view('sources') },
        { id: 'firstcut', label: project?.firstCut ? 'Create a new first cut' : 'Create first cut', icon: 'sparkle', run: view('brief') },
        { id: 'play', label: 'Play or pause', icon: 'play', keys: 'Space', run: () => usePlayback.getState().toggle() },
        { id: 'undo', label: 'Undo', icon: 'undo', keys: '⌘Z', run: () => app().undo() },
        { id: 'redo', label: 'Redo', icon: 'redo', keys: '⇧⌘Z', run: () => app().redo() },
        { id: 'save', label: 'Save now', icon: 'check', keys: '⌘S', run: () => void saveNow().then(() => app().toast('Saved')) },
        { id: 'transcript', label: 'Edit transcript', icon: 'captions', run: tab('transcript') },
        { id: 'review', label: 'Review what the AI changed', icon: 'sparkle', run: tab('review') },
        { id: 'history', label: 'History and checkpoints', icon: 'history', run: tab('history') },
        { id: 'sidebar', label: 'Show or hide the sidebar', icon: 'sidebar', run: () => app().setPanels({ inspector: !app().panels.inspector }) },
        { id: 'tracks', label: 'Show or hide the layout and graphics tracks', icon: 'layout', keys: '⌘T', run: () => app().patch((p) => ({ ...p, ui: { ...p.ui, expandedTimeline: !p.ui.expandedTimeline } })) },
        { id: 't-bg', label: 'Background and shape', icon: 'frame', run: tab('background') },
        { id: 't-cursor', label: 'Cursor', icon: 'pointer', run: tab('cursor') },
        { id: 't-camera', label: 'Camera', icon: 'camera', run: tab('camera') },
        { id: 't-captions', label: 'Captions', icon: 'captions', run: tab('captions') },
        { id: 't-audio', label: 'Audio', icon: 'speaker', run: tab('audio') },
        { id: 't-keys', label: 'Keyboard shortcuts overlay', icon: 'command', run: tab('shortcuts') },
        { id: 't-motion', label: 'Animation', icon: 'path', run: tab('motion') },
        { id: 'split', label: 'Split the selected block at the playhead', icon: 'scissors', keys: '⌘B', run: () => window.dispatchEvent(new CustomEvent('cutaway-command', { detail: 'split' })) },
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
