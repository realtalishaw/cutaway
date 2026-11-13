import { useEffect, useState } from 'react';
import { saveNow, startAutosave, useApp, usePlayback, type ProjectView } from './state/store';
import { backToLibrary, newRecording, pickAndImport } from './state/actions';
import { Icon, Logo } from './ui/icons';
import { Button, Modal, fmtAgo } from './ui/kit';
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
  { view: 'edit', label: 'Edit' },
  { view: 'package', label: 'Package' },
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
    return (
      <div className="tb-title no-drag">
        <input className="input" style={{ width: 260, height: 28, textAlign: 'center' }} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => (e.key === 'Enter' ? void commit() : e.key === 'Escape' ? (setDraft(name), setEditing(false)) : null)} aria-label="Project name" />
      </div>
    );
  }
  return (
    <button className="tb-title no-drag" style={{ background: 'none', border: 0, color: 'inherit' }} onClick={() => setEditing(true)} title="Rename project">
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      <span className="ext">.cutaway</span>
    </button>
  );
}

function PresetsMenu() {
  const settings = useApp((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const presets = settings?.presets ?? [];
  const apply = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    // Appearance only: timing, cuts and locks are never touched by a preset.
    useApp.getState().edit((e) => ({ ...e, appearance: { ...preset.appearance, output: e.appearance.output, crop: e.appearance.crop } }), `Apply preset “${preset.name}”`);
    useApp.getState().toast(`Applied “${preset.name}”.`);
    setOpen(false);
  };
  const save = async () => {
    const app = useApp.getState();
    if (!app.project || !settings || !naming?.trim()) return;
    const preset = { id: `preset_${Date.now().toString(36)}`, name: naming.trim(), createdAt: new Date().toISOString(), appearance: app.project.edit.appearance, brief: { pacing: app.project.brief.pacing, visualIntensity: app.project.brief.visualIntensity } };
    app.setSettings(await window.cutaway.app.setSettings({ presets: [...settings.presets, preset] }));
    app.toast(`Saved preset “${preset.name}”.`);
    setNaming(null);
    setOpen(false);
  };
  return (
    <div style={{ position: 'relative' }} className="no-drag">
      <Button variant="ghost" icon="sparkle" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} style={{ color: 'var(--text)' }}>
        Presets <Icon name="chevronDown" size={13} style={{ color: 'var(--text-3)' }} />
      </Button>
      {open ? (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 290 }} onMouseDown={() => (setOpen(false), setNaming(null))} />
          <div className="menu" style={{ right: 0, top: 38, position: 'absolute', minWidth: 240 }} role="menu">
            {presets.length === 0 ? <div className="tiny dim" style={{ padding: '8px 10px' }}>No presets yet. Save this project’s look to reuse it.</div> : null}
            {presets.map((p) => (
              <button key={p.id} role="menuitem" onClick={() => apply(p.id)}>
                <Icon name="palette" size={13} /> {p.name}
                {settings?.defaultPresetId === p.id ? <span className="tiny dim" style={{ marginLeft: 'auto' }}>default</span> : null}
              </button>
            ))}
            <div className="sep" />
            {naming === null ? (
              <button role="menuitem" onClick={() => setNaming('')}><Icon name="plus" size={13} /> Save current look as preset…</button>
            ) : (
              <div style={{ padding: 6, display: 'flex', gap: 6 }}>
                <input className="input" autoFocus placeholder="Preset name" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? void save() : e.key === 'Escape' ? setNaming(null) : null)} style={{ height: 28 }} />
                <Button size="sm" variant="primary" disabled={!naming.trim()} onClick={() => void save()}>Save</Button>
              </div>
            )}
            <button role="menuitem" onClick={() => (setOpen(false), useApp.getState().go('settings'))}><Icon name="gear" size={13} /> Manage presets…</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Titlebar() {
  const route = useApp((s) => s.route);
  const project = useApp((s) => s.project);
  const projectPath = useApp((s) => s.projectPath);
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const inspector = useApp((s) => s.panels.inspector);
  const setView = useApp((s) => s.setView);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const inProject = route === 'project' && !!project;
  const hasMedia = !!project && project.sources.length > 0;
  const view = project?.ui.view;
  return (
    <header className="titlebar drag">
      <Button className="no-drag" variant="ghost" icon="folder" onClick={() => void backToLibrary()} title="Show previous projects" aria-label="Show previous projects" />
      {inProject ? (
        <>
          <Button className="no-drag" variant="ghost" icon="trash" onClick={() => setConfirmTrash(true)} title="Move project to Trash" aria-label="Move project to Trash" />
          <nav className="steps no-drag" aria-label="Project">
            {STEPS.map((s) => (
              <button key={s.view} aria-current={view === s.view ? 'page' : undefined} disabled={s.view !== 'sources' && !hasMedia} onClick={() => setView(s.view)}>
                {s.label}
              </button>
            ))}
          </nav>
          <ProjectName />
          <div className="grow" />
          <div className="row no-drag" style={{ gap: 2 }}>
            <SaveStatus />
            <Button variant="ghost" icon="undo" disabled={!canUndo} onClick={() => useApp.getState().undo()} title="Undo (⌘Z)" aria-label="Undo" />
            <Button variant="ghost" icon="redo" disabled={!canRedo} onClick={() => useApp.getState().redo()} title="Redo (⇧⌘Z)" aria-label="Redo" />
          </div>
          <span className="tb-sep" />
          <PresetsMenu />
          <span className="tb-sep" />
          <Button className="no-drag" variant="ghost" icon="sidebar" on={inspector && view === 'edit'} disabled={view !== 'edit'} onClick={() => useApp.getState().setPanels({ inspector: !inspector })} title="Show or hide the sidebar" aria-label="Toggle sidebar" />
          <Button className="no-drag" variant="ghost" icon="gear" onClick={() => useApp.getState().go('settings')} title="Settings (⌘,)" aria-label="Settings" />
          <Button className="no-drag" variant="ghost" icon="sparkle" disabled={!hasMedia} on={view === 'brief'} onClick={() => setView('brief')} title="Create or redo the AI first cut" style={{ color: 'var(--ai)' }}>
            First cut
          </Button>
          <Button className="no-drag" variant="primary" icon="upload" disabled={!hasMedia} onClick={() => setView('export')} title="Export (⌘E)">
            Export
          </Button>
        </>
      ) : (
        <>
          <div className="wordmark" style={{ marginLeft: 6 }}>
            <Logo size={18} />
            <span>Cutaway</span>
          </div>
          <div className="grow" />
          <Button className="no-drag" variant="ghost" icon="gear" on={route === 'settings'} onClick={() => useApp.getState().go(route === 'settings' ? (project ? 'project' : 'library') : 'settings')} title="Settings (⌘,)" aria-label="Settings" />
        </>
      )}
      {confirmTrash && project && projectPath ? (
        <Modal
          eyebrow="Remove project"
          title={<>Move “{project.name}” to the Trash?</>}
          onClose={() => setConfirmTrash(false)}
          footer={
            <>
              <Button onClick={() => setConfirmTrash(false)}>Keep project</Button>
              <Button
                variant="danger"
                icon="trash"
                onClick={async () => {
                  setConfirmTrash(false);
                  try {
                    await saveNow();
                    useApp.getState().closeProject();
                    await window.cutaway.library.trash(projectPath);
                  } catch (e) {
                    useApp.getState().toast(`Could not remove: ${(e as Error).message}`, 'error');
                  }
                }}
              >
                Move to Trash
              </Button>
            </>
          }
        >
          <p className="muted" style={{ marginTop: 0 }}>The project and the media stored inside it go to the Trash, where you can still get them back. Files you imported by reference stay exactly where they are.</p>
        </Modal>
      ) : null}
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
