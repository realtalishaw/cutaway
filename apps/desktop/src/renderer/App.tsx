import { useEffect, useState } from 'react';
import { saveNow, startAutosave, useApp, usePlayback, type ProjectView } from './state/store';
import { backToLibrary, newRecording, pickAndImport } from './state/actions';
import { Icon, Logo } from './ui/icons';
import { Button, fmtAgo } from './ui/kit';
import { Library } from './screens/Library';
import { Record } from './screens/Record';
import { Controller } from './screens/Controller';
import { Sources } from './screens/Sources';
import { Brief } from './screens/Brief';
import { Editor } from './screens/Editor';
import { Package } from './screens/Package';
import { ExportScreen } from './screens/Export';
import { Settings } from './screens/Settings';
import { Processing } from './screens/Processing';

const STEPS: { view: ProjectView; label: string }[] = [
  { view: 'sources', label: 'Sources' },
  { view: 'brief', label: 'Brief' },
  { view: 'edit', label: 'Edit' },
  { view: 'package', label: 'Package' },
  { view: 'export', label: 'Export' },
];

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function SaveStatus() {
  const save = useApp((s) => s.save);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 20000);
    return () => clearInterval(t);
  }, []);
  if (save.state === 'error') {
    return (
      <button className="pill danger no-drag" title={save.error ?? ''} onClick={() => void saveNow()} style={{ border: 0 }}>
        <Icon name="warn" size={11} /> Not saved · Retry
      </button>
    );
  }
  const text = save.state === 'saving' ? 'Saving…' : save.state === 'dirty' ? 'Edited' : save.at ? `Saved ${fmtAgo(save.at)}` : 'Saved';
  return (
    <span className="tiny dim row gap-2" aria-live="polite">
      {save.state === 'saved' ? <Icon name="check" size={12} /> : <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}
      {text}
    </span>
  );
}

function ProjectName() {
  const name = useApp((s) => s.project?.name ?? '');
  const path = useApp((s) => s.projectPath);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === name || !path) return setDraft(name);
    try {
      await saveNow();
      const r = await window.cutaway.library.rename(path, next);
      const opened = await window.cutaway.library.open(r.path);
      useApp.setState({ projectPath: opened.path, project: { ...useApp.getState().project!, name: opened.project.name } });
    } catch (e) {
      useApp.getState().toast(`Could not rename: ${(e as Error).message}`, 'error');
      setDraft(name);
    }
  };
  if (editing) {
    return <input className="input no-drag" style={{ width: 240, height: 28 }} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => (e.key === 'Enter' ? void commit() : e.key === 'Escape' ? (setDraft(name), setEditing(false)) : null)} aria-label="Project name" />;
  }
  return (
    <button className="btn ghost no-drag" style={{ maxWidth: 280, fontWeight: 600, color: 'var(--text)' }} onClick={() => setEditing(true)} title="Rename project">
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
    </button>
  );
}

function Titlebar() {
  const route = useApp((s) => s.route);
  const project = useApp((s) => s.project);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const setView = useApp((s) => s.setView);
  const inProject = route === 'project' && !!project;
  const hasMedia = !!project && project.sources.length > 0;
  return (
    <header className="titlebar drag">
      <button className="wordmark no-drag" style={{ background: 'none', border: 0, padding: 0 }} onClick={() => void backToLibrary()} title="Project library">
        <Logo />
        <span>
          Cut<i>away</i>
        </span>
      </button>
      {inProject ? (
        <>
          <Icon name="chevron" size={13} style={{ color: 'var(--text-4)' }} />
          <ProjectName />
          <div className="grow" />
          <nav className="steps no-drag" aria-label="Project steps">
            {STEPS.map((s, i) => (
              <button key={s.view} aria-current={project!.ui.view === s.view ? 'page' : undefined} disabled={s.view !== 'sources' && !hasMedia} onClick={() => setView(s.view)}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                {s.label}
              </button>
            ))}
          </nav>
          <div className="grow" />
          <div className="row no-drag" style={{ gap: 6 }}>
            <SaveStatus />
            <Button variant="ghost" icon="undo" disabled={!canUndo} onClick={() => useApp.getState().undo()} title="Undo (⌘Z)" aria-label="Undo" />
            <Button variant="ghost" icon="redo" disabled={!canRedo} onClick={() => useApp.getState().redo()} title="Redo (⇧⌘Z)" aria-label="Redo" />
          </div>
        </>
      ) : (
        <div className="grow" />
      )}
      <Button className="no-drag" variant="ghost" icon="gear" on={route === 'settings'} onClick={() => useApp.getState().go(route === 'settings' ? (project ? 'project' : 'library') : 'settings')} title="Settings (⌘,)" aria-label="Settings" />
    </header>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === 'error' ? <Icon name="warn" size={14} style={{ color: 'var(--danger)' }} /> : null}
          <span>{t.text}</span>
          {t.action ? (
            <button className="btn sm" onClick={() => (t.action!.run(), dismiss(t.id))}>
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Workspace() {
  const view = useApp((s) => s.project?.ui.view ?? 'sources');
  const job = useApp((s) => s.job);
  // The job screen owns Brief/Edit while it runs; Sources stays reachable.
  if (job && job.kind === 'first-cut' && job.status !== 'done' && (view === 'brief' || view === 'edit')) return <Processing />;
  switch (view) {
    case 'sources':
      return <Sources />;
    case 'brief':
      return <Brief />;
    case 'edit':
      return <Editor />;
    case 'package':
      return <Package />;
    case 'export':
      return <ExportScreen />;
  }
}

export function App() {
  const route = useApp((s) => s.route);
  const project = useApp((s) => s.project);
  const reduce = useApp((s) => s.settings?.reduceMotion ?? false);
  const isController = window.location.hash === '#controller';

  useEffect(() => {
    document.body.classList.toggle('reduce-motion', reduce);
  }, [reduce]);

  useEffect(() => {
    if (isController) {
      document.body.classList.add('controller-body');
      return;
    }
    const api = window.cutaway;
    void api.app.getSettings().then((s) => useApp.getState().setSettings(s));
    void api.app.info().then((info) => useApp.setState({ info }));
    void api.ai.status().then((claude) => useApp.setState({ claude })).catch(() => {});
    startAutosave();
    const offMenu = api.app.onMenu((cmd) => {
      const app = useApp.getState();
      const typing = isTyping();
      switch (cmd) {
        case 'undo':
          return typing ? document.execCommand('undo') : app.undo();
        case 'redo':
          return typing ? document.execCommand('redo') : app.redo();
        case 'save':
          return void saveNow().then(() => app.toast('Saved'));
        case 'settings':
          return app.go('settings');
        case 'library':
          return void backToLibrary();
        case 'record':
          return void newRecording();
        case 'import':
          return void pickAndImport(!app.project);
        case 'view-edit':
          return app.project && app.project.sources.length ? (app.go('project'), app.setView('edit')) : undefined;
        case 'view-package':
          return app.project && app.project.sources.length ? (app.go('project'), app.setView('package')) : undefined;
        case 'view-export':
        case 'export':
          return app.project && app.project.sources.length ? (app.go('project'), app.setView('export')) : undefined;
        default:
          // editor-specific commands (split, lock, toggle-timeline) are handled by the editor
          window.dispatchEvent(new CustomEvent('cutaway-command', { detail: cmd }));
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.metaKey || e.ctrlKey) return;
      const app = useApp.getState();
      if (e.code === 'Space' && app.route === 'project' && app.project && (app.project.ui.view === 'edit' || app.project.ui.view === 'package')) {
        e.preventDefault();
        usePlayback.getState().toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    // Dropping a file anywhere must never navigate the window away.
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      offMenu();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, [isController]);

  if (isController) return <Controller />;

  return (
    <div className="app">
      <Titlebar />
      <main className="main">
        {route === 'settings' ? <Settings /> : route === 'record' && project ? <Record /> : route === 'project' && project ? <Workspace /> : <Library />}
      </main>
      <Toasts />
    </div>
  );
}
