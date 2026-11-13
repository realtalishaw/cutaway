import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { disclosure } from '@cutaway/ai';
import { uid } from '@cutaway/core';
import type { AppSettings, CacheInfo, ClaudeStatus, StylePreset } from '@shared/api';
import { useApp } from '../state/store';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Field, Segmented, Slider, Toggle, fmtAgo, fmtBytes } from '../ui/kit';
import './settings.css';

type Tab = 'storage' | 'processing' | 'recording' | 'access' | 'shortcuts' | 'presets' | 'about';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'storage', label: 'Storage', icon: 'folder' },
  { id: 'processing', label: 'Processing', icon: 'shield' },
  { id: 'recording', label: 'Recording', icon: 'record' },
  { id: 'access', label: 'Accessibility', icon: 'eye' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'command' },
  { id: 'presets', label: 'Presets', icon: 'palette' },
  { id: 'about', label: 'About', icon: 'info' },
];

const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  {
    group: 'Everywhere',
    rows: [
      ['⌘N', 'New recording'],
      ['⌘I', 'Import media'],
      ['⇧⌘L', 'Project library'],
      ['⌘S', 'Save now (projects also save on their own)'],
      ['⌘,', 'Settings'],
      ['⌃⌥⌘R', 'Start a recording, or stop the one in progress, from any app'],
    ],
  },
  {
    group: 'Editing',
    rows: [
      ['Space', 'Play or pause'],
      ['⌘Z', 'Undo'],
      ['⇧⌘Z', 'Redo'],
      ['⌘B', 'Split at the playhead'],
      ['⌘L', 'Lock the selection against AI changes'],
      ['⌘T', 'Show or hide the expanded timeline'],
    ],
  },
  {
    group: 'Moving around a project',
    rows: [
      ['⌘1', 'Edit'],
      ['⌘2', 'Package'],
      ['⌘3 or ⌘E', 'Export'],
    ],
  },
  {
    group: 'Thumbnail canvas',
    rows: [
      ['← ↑ ↓ →', 'Nudge the selected layer (hold ⇧ for bigger steps)'],
      ['⌫', 'Delete the selected layer'],
      ['⌥ drag', 'Move without snapping to the centre'],
      ['Esc', 'Deselect'],
    ],
  },
];

const LOCALES: [string, string][] = [
  ['en-US', 'English (United States)'],
  ['en-GB', 'English (United Kingdom)'],
  ['en-AU', 'English (Australia)'],
  ['en-IN', 'English (India)'],
];

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="card set-section">
      <div>
        <div className="set-title">{title}</div>
        {hint ? <div className="tiny dim set-hint">{hint}</div> : null}
      </div>
      {children}
    </section>
  );
}

function PathRow({ label, path, onChange, hint }: { label: string; path: string; onChange: () => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="row">
        <button className="well path mono tiny grow" onClick={() => void window.cutaway.app.reveal(path)} title="Show in Finder">
          <Icon name="folder" size={13} />
          <span>{path}</span>
        </button>
        <Button onClick={onChange}>Change…</Button>
      </div>
    </Field>
  );
}

export function Settings() {
  const settings = useApp((s) => s.settings);
  const project = useApp((s) => s.project);
  const projectPath = useApp((s) => s.projectPath);
  const info = useApp((s) => s.info);
  const jobRunning = useApp((s) => s.job?.status === 'running');
  const [tab, setTab] = useState<Tab>('storage');
  const [claude, setClaude] = useState<ClaudeStatus | null>(useApp.getState().claude);
  const [checking, setChecking] = useState(false);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [clearing, setClearing] = useState(false);
  const [presetName, setPresetName] = useState('');

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      const next = await window.cutaway.app.setSettings(patch);
      useApp.getState().setSettings(next);
    } catch (e) {
      useApp.getState().toast(`Could not save the setting: ${(e as Error).message}`, 'error');
    }
  }, []);

  const checkClaude = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const s = await window.cutaway.ai.status(force);
      setClaude(s);
      useApp.setState({ claude: s });
    } catch (e) {
      setClaude({ found: false, path: null, version: null, signedIn: null, message: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!claude) void checkClaude(false);
  }, [claude, checkClaude]);

  useEffect(() => {
    if (!projectPath) return setCache(null);
    void window.cutaway.library.cacheInfo(projectPath).then(setCache).catch(() => setCache(null));
  }, [projectPath, tab]);

  if (!settings) {
    return (
      <div className="page">
        <div className="page-inner row" style={{ gap: 10 }}>
          <span className="spinner" /> Loading settings…
        </div>
      </div>
    );
  }

  const pickDir = async (key: 'libraryDir' | 'exportDir', title: string) => {
    const dir = await window.cutaway.app.pickFolder(title, settings[key]);
    if (dir) await update({ [key]: dir });
  };

  const clearCache = async () => {
    if (!projectPath) return;
    setClearing(true);
    try {
      const before = cache?.bytes ?? 0;
      setCache(await window.cutaway.library.clearCache(projectPath));
      useApp.getState().toast(`Cleared ${fmtBytes(before)} of derived files. Originals and your edit are untouched.`);
    } catch (e) {
      useApp.getState().toast(`Could not clear the cache: ${(e as Error).message}`, 'error');
    } finally {
      setClearing(false);
    }
  };

  const savePreset = async () => {
    if (!project) return;
    const name = presetName.trim() || `${project.name} style`;
    const preset: StylePreset = { id: uid('preset'), name, createdAt: new Date().toISOString(), appearance: project.edit.appearance, brief: { pacing: project.brief.pacing, visualIntensity: project.brief.visualIntensity } };
    await update({ presets: [...settings.presets, preset] });
    setPresetName('');
    useApp.getState().toast(`Saved “${name}”`);
  };

  const applyPreset = (p: StylePreset) => {
    const app = useApp.getState();
    // Appearance only: cuts, timing, locks and the export format are left exactly as they are.
    app.edit((e) => ({ ...e, appearance: { ...p.appearance, output: e.appearance.output } }), `Apply style “${p.name}”`);
    app.patch((pr) => ({ ...pr, brief: { ...pr.brief, ...p.brief } }));
    app.toast(`Applied “${p.name}”. Timing and locked content were not changed.`);
  };

  const d = disclosure(['transcript', 'edit-metadata', 'frames']);
  const whisper = settings.transcription.whisperModelPath;

  return (
    <div className="page settings">
      <div className="page-inner settings-inner">
        <nav className="set-nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={20} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="set-body" key={tab}>
          {tab === 'storage' ? (
            <>
              <Section title="Where things live" hint="Projects and exports stay on this Mac. Nothing is stored in the cloud.">
                <PathRow label="Project library" path={settings.libraryDir} onChange={() => void pickDir('libraryDir', 'Choose the project library folder')} hint="New projects are created here. Existing projects stay where they are; move them in Finder if you want them to follow." />
                <PathRow label="YouTube packages" path={settings.exportDir} onChange={() => void pickDir('exportDir', 'Choose where packages are saved')} hint="Every export gets its own new folder. An existing package is never overwritten." />
              </Section>
              <Section title="Imported media">
                <div className="field">
                  <span className="label">When you import a file</span>
                  <Segmented
                    label="Import mode"
                    value={settings.importMode}
                    onChange={(importMode) => void update({ importMode })}
                    options={[
                      { value: 'copy', label: 'Copy into the project' },
                      { value: 'reference', label: 'Leave it where it is' },
                    ]}
                  />
                </div>
                <div className="tiny muted">
                  {settings.importMode === 'copy'
                    ? 'The project is self-contained and survives if the original moves or the drive is unplugged. It uses more disk space, except on the same APFS volume where the copy is instant and free. Your original file is never modified.'
                    : 'No extra disk space is used, but the project breaks if the file is moved, renamed or its drive is offline. You can relink it in Sources; Cutaway checks the replacement is the same media. The file is never modified and never deleted with the project.'}
                </div>
              </Section>
              <Section title="Derived caches" hint="Stills, previews and analysis that Cutaway can always recompute.">
                {project && projectPath ? (
                  <>
                    <div className="row between">
                      <div>
                        <div style={{ fontWeight: 580 }}>{project.name}</div>
                        <div className="tiny dim mono">{cache ? `${fmtBytes(cache.bytes)} in ${cache.files.toLocaleString()} file${cache.files === 1 ? '' : 's'}` : 'measuring…'}</div>
                      </div>
                      <Button icon="trash" busy={clearing} disabled={!cache || cache.files === 0 || jobRunning} onClick={() => void clearCache()}>
                        Clear derived caches
                      </Button>
                    </div>
                    {jobRunning ? (
                      <Banner tone="warn" title="A job is using these files">
                        Analysis or packaging is running and reads stills from this cache. Wait for it to finish, or cancel it, before clearing.
                      </Banner>
                    ) : (
                      <div className="tiny muted">Clearing removes only derived files. Original recordings, imported media, your edit, transcript corrections and thumbnails stay intact. The next analysis or packaging run re-creates what it needs.</div>
                    )}
                  </>
                ) : (
                  <div className="tiny muted">Open a project to see and clear its cache.</div>
                )}
              </Section>
            </>
          ) : null}

          {tab === 'processing' ? (
            <>
              <Section title="Claude Code on this Mac" hint="Cutaway has no API key and no account of its own. AI editing runs through the Claude Code app you already use.">
                <div className="row between">
                  <div className="row" style={{ gap: 10 }}>
                    <span className={`status-dot ${claude?.found ? (claude.signedIn ? 'ok' : claude.signedIn === false ? 'bad' : 'unknown') : 'bad'}`} aria-hidden />
                    <div>
                      <div style={{ fontWeight: 600 }}>{!claude ? 'Checking…' : !claude.found ? 'Not installed' : claude.signedIn ? 'Installed and signed in' : claude.signedIn === false ? 'Installed, but not signed in' : 'Installed · sign-in not checked yet'}</div>
                      <div className="tiny dim mono">{claude?.found ? `${claude.path ?? 'claude'}${claude.version ? ` · ${claude.version}` : ''}` : (claude?.message ?? '')}</div>
                    </div>
                  </div>
                  <Button icon="sync" busy={checking} onClick={() => void checkClaude(true)}>
                    Check again
                  </Button>
                </div>
                {claude && claude.found && claude.signedIn === false ? (
                  <Banner tone="warn" title="Sign in once, in Terminal">
                    Run <span className="mono code">claude</span>, then type <span className="mono code">/login</span> and follow the prompts. Come back and choose Check again. Until then Cutaway edits with its built-in rules and says so.
                  </Banner>
                ) : null}
                {claude && !claude.found ? (
                  <Banner tone="warn" title="Claude Code was not found">
                    {claude.message || 'Install Claude Code, or point Cutaway at it below.'} Recording, manual editing, on-device rules and export all work without it.
                  </Banner>
                ) : null}
                <div className="two">
                  <Field label="Model" hint="Passed to Claude Code as --model. An alias such as sonnet or opus, or a full model id.">
                    <input className="input mono" defaultValue={settings.claudeModel} onBlur={(e) => e.target.value.trim() !== settings.claudeModel && void update({ claudeModel: e.target.value.trim() || 'sonnet' })} aria-label="Claude model" />
                  </Field>
                  <Field label="Claude Code location" hint="Leave empty to find claude on your PATH.">
                    <input className="input mono" defaultValue={settings.claudePath ?? ''} placeholder="automatic" onBlur={(e) => (e.target.value.trim() || null) !== settings.claudePath && void update({ claudePath: e.target.value.trim() || null }).then(() => checkClaude(true))} aria-label="Claude Code path" />
                  </Field>
                </div>
              </Section>

              <Section title="What leaves this Mac" hint="Shown again, and asked, before the first time a project uses Claude.">
                <dl className="disclosure">
                  <dt>Where it goes</dt>
                  <dd>{d.destination}. The model does not run on this Mac.</dd>
                  <dt>What is sent</dt>
                  <dd>
                    <ul>
                      {d.leaves.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </dd>
                  <dt>Never sent</dt>
                  <dd>
                    <ul>
                      {d.stays.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </dd>
                  <dt>Cost</dt>
                  <dd>{d.cost}</dd>
                  <dt>Retention</dt>
                  <dd>{d.retention}</dd>
                </dl>
                {project ? (
                  project.consent ? (
                    <div className="row between">
                      <div className="tiny muted">
                        <b style={{ color: 'var(--text)' }}>{project.name}</b> may use {project.consent.provider}. Allowed {fmtAgo(project.consent.grantedAt)} for: {project.consent.scope.join(', ')}.
                      </div>
                      <Button
                        variant="danger"
                        onClick={() => {
                          useApp.getState().patch((p) => ({ ...p, consent: null }));
                          useApp.getState().toast('Permission withdrawn. This project will ask again before sending anything.');
                        }}
                      >
                        Withdraw permission
                      </Button>
                    </div>
                  ) : (
                    <div className="tiny muted">
                      <b style={{ color: 'var(--text)' }}>{project.name}</b> has not been allowed to use Claude. Nothing from it has been sent.
                    </div>
                  )
                ) : (
                  <div className="tiny dim">Permission is given per project. Open a project to review or withdraw it.</div>
                )}
              </Section>

              <Section title="Transcription" hint="Transcription always runs on this Mac. Your audio is never sent anywhere.">
                <div className="field">
                  <span className="label">Engine</span>
                  <Segmented
                    label="Transcription engine"
                    value={settings.transcription.engine}
                    onChange={(engine) => void update({ transcription: { ...settings.transcription, engine } })}
                    options={[
                      { value: 'auto', label: 'Automatic', title: 'Apple speech first, Whisper if it is unavailable' },
                      { value: 'apple', label: 'Apple on-device speech' },
                      { value: 'whisper', label: 'Whisper model file' },
                    ]}
                  />
                </div>
                <Field label="Whisper model" hint="A ggml .bin model for whisper.cpp. Used when the engine is Whisper, or as the fallback in Automatic. Needs whisper-cli (Homebrew: whisper-cpp).">
                  <div className="row">
                    <div className="well path mono tiny grow" title={whisper ?? ''}>
                      <Icon name="wave" size={13} />
                      <span>{whisper ?? 'No model file selected'}</span>
                    </div>
                    {whisper ? (
                      <Button variant="ghost" onClick={() => void update({ transcription: { ...settings.transcription, whisperModelPath: null } })}>
                        Clear
                      </Button>
                    ) : null}
                    <Button
                      onClick={async () => {
                        const [f] = await window.cutaway.app.pickFiles({ title: 'Choose a Whisper model (.bin)', kinds: ['model'], multiple: false });
                        if (f) await update({ transcription: { ...settings.transcription, whisperModelPath: f } });
                      }}
                    >
                      Choose…
                    </Button>
                  </div>
                </Field>
                {settings.transcription.engine === 'whisper' && !whisper ? <Banner tone="warn">Whisper is selected but no model file is chosen, so transcription will fail until you pick one or switch to Automatic.</Banner> : null}
                <Field label="Spoken language" hint="Only English has been checked for quality so far.">
                  <select className="select" style={{ maxWidth: 320 }} value={settings.transcription.locale} onChange={(e) => void update({ transcription: { ...settings.transcription, locale: e.target.value } })}>
                    {LOCALES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
              </Section>
              <Section title="Analytics">
                <div className="tiny muted">Cutaway collects no analytics and sends no diagnostics. There is nothing to opt out of.</div>
              </Section>
            </>
          ) : null}

          {tab === 'recording' ? (
            <>
              <Section title="Countdown" hint="Time between pressing Record and the first captured frame.">
                <div className="field">
                  <Segmented
                    label="Countdown"
                    value={String(settings.countdownSeconds)}
                    onChange={(v) => void update({ countdownSeconds: Number(v) })}
                    options={[
                      { value: '0', label: 'None' },
                      { value: '3', label: '3 seconds' },
                      { value: '5', label: '5 seconds' },
                      { value: '10', label: '10 seconds' },
                    ]}
                  />
                </div>
              </Section>
              <Section title="Global shortcut">
                <div className="row between">
                  <div className="tiny muted" style={{ maxWidth: 440 }}>
                    Works from any app: starts a new recording, or stops and saves the one in progress.
                  </div>
                  <span className="row gap-2">
                    {['⌃', '⌥', '⌘', 'R'].map((k) => (
                      <span key={k} className="kbd big">
                        {k}
                      </span>
                    ))}
                  </span>
                </div>
              </Section>
              <Section title="What a recording keeps">
                <ul className="plain tiny muted">
                  <li>Screen, camera A, camera B, microphone and system audio are saved as separate files, so each stays editable.</li>
                  <li>The pointer is recorded as data, not burned into the picture, so it can be smoothed, resized or hidden later.</li>
                  <li>Media is flushed to disk every two seconds. If Cutaway or the Mac stops unexpectedly, the library offers to recover everything up to the last flush.</li>
                </ul>
              </Section>
            </>
          ) : null}

          {tab === 'access' ? (
            <>
              <Section title="Motion">
                <Toggle label="Reduce motion in the app" hint="Turns off interface animation. It does not change zooms or transitions in your video; those are creative choices set in the editor." checked={settings.reduceMotion} onChange={(reduceMotion) => void update({ reduceMotion })} />
              </Section>
              <Section title="Transcript">
                <Slider label="Transcript text size" value={settings.transcriptTextSize} min={12} max={24} step={1} onChange={(transcriptTextSize) => useApp.getState().setSettings({ ...settings, transcriptTextSize })} onCommit={() => void update({ transcriptTextSize: useApp.getState().settings!.transcriptTextSize })} format={(v) => `${v} pt`} />
                <p className="transcript-sample" style={{ fontSize: settings.transcriptTextSize }}>
                  So first we open the settings panel, <s>um,</s> and then choose where the package is saved.
                </p>
              </Section>
              <Section title="Built in">
                <ul className="plain tiny muted">
                  <li>Every control is reachable by keyboard and shows a visible focus ring.</li>
                  <li>Status is never shown by colour alone: AI decisions, your own decisions, warnings and blockers each have their own icon, shape and label.</li>
                  <li>The transcript is a keyboard alternative to precise timeline dragging.</li>
                </ul>
              </Section>
            </>
          ) : null}

          {tab === 'shortcuts' ? (
            <Section title="Keyboard shortcuts">
              {SHORTCUTS.map((g) => (
                <div key={g.group} className="col" style={{ gap: 0 }}>
                  <div className="set-title" style={{ margin: '6px 0 6px' }}>
                    {g.group}
                  </div>
                  <table className="keys">
                    <tbody>
                      {g.rows.map(([k, what]) => (
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
              ))}
            </Section>
          ) : null}

          {tab === 'presets' ? (
            <>
              <Section title="Save the current look" hint="A preset stores background, frame, cursor, camera and caption styling, motion level, and pacing. It never stores cuts or timing.">
                {project ? (
                  <div className="row">
                    <input className="input" placeholder={`${project.name} style`} value={presetName} onChange={(e) => setPresetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void savePreset()} aria-label="Preset name" />
                    <Button variant="primary" icon="plus" onClick={() => void savePreset()}>
                      Save preset
                    </Button>
                  </div>
                ) : (
                  <div className="tiny muted">Open a project to save its look as a preset.</div>
                )}
              </Section>
              <Section title={`Your presets${settings.presets.length ? ` · ${settings.presets.length}` : ''}`}>
                {settings.presets.length === 0 ? (
                  <div className="tiny muted">No presets yet.</div>
                ) : (
                  <ul className="presets">
                    {settings.presets.map((p) => {
                      const bg = p.appearance.background;
                      const swatch = bg.type === 'gradient' ? `linear-gradient(${bg.angle}deg, ${bg.colors.join(', ')})` : bg.type === 'solid' ? bg.color : 'var(--bg-3)';
                      const isDefault = settings.defaultPresetId === p.id;
                      return (
                        <li key={p.id}>
                          <span className="preset-swatch" style={{ background: swatch }} aria-hidden>
                            <i style={{ borderRadius: p.appearance.camera.shape === 'circle' ? '50%' : 3 }} />
                          </span>
                          <div className="grow">
                            <div style={{ fontWeight: 600 }}>
                              {p.name}{' '}
                              {isDefault ? (
                                <span className="pill accent" style={{ marginLeft: 6 }}>
                                  <Icon name="check" size={10} /> Default
                                </span>
                              ) : null}
                            </div>
                            <div className="tiny dim">
                              {p.brief.pacing} pacing · {p.appearance.motion} motion · {p.appearance.camera.shape} camera · saved {fmtAgo(p.createdAt)}
                            </div>
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => void update({ defaultPresetId: isDefault ? null : p.id })} title="Used for new projects">
                            {isDefault ? 'Unset default' : 'Make default'}
                          </Button>
                          <Button size="sm" disabled={!project} onClick={() => applyPreset(p)} title={project ? `Apply to ${project.name}` : 'Open a project first'}>
                            Apply
                          </Button>
                          <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${p.name}`} title="Delete preset" onClick={() => void update({ presets: settings.presets.filter((x) => x.id !== p.id), defaultPresetId: isDefault ? null : settings.defaultPresetId })} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>
            </>
          ) : null}

          {tab === 'about' ? (
            <>
              <Section title="Cutaway">
                <div className="row" style={{ gap: 14 }}>
                  <div className="display h2">
                    Cutaway
                  </div>
                  <div className="tiny dim mono">
                    version {info?.version ?? '—'}
                    <br />
                    {info?.os ?? ''}
                  </div>
                </div>
                <div className="tiny muted">
                  Record once, get the first cut. A recorder and AI editor for YouTube creators that keeps your footage on your Mac and never uploads or publishes for you.
                </div>
                {info && !info.nativeHelper ? <Banner tone="warn" title="The capture helper is not built">Run <span className="mono code">pnpm native:build</span> in the repository, then reopen Cutaway.</Banner> : null}
              </Section>
              <Section title="What is not here yet" hint="Cutaway is independently built. These parts of the wider recording-tool baseline are planned, not shipped.">
                <ul className="plain tiny muted">
                  <li>Loupe-style magnification, motion blur, advanced pointer options and click sounds</li>
                  <li>Camera cut-out, face tracking, colour looks and LUTs</li>
                  <li>iPhone and iPad capture with device frames</li>
                  <li>GIF export, copy to clipboard, vertical and square formats</li>
                  <li>Shareable links, shared projects and a stock background catalogue</li>
                  <li>Sound from selected apps only, speaker notes and window-resize helpers</li>
                </ul>
                <div className="tiny dim">Exports are qualified for 16:9 SDR at 1080p and 4K, 30 or 60 fps. YouTube upload, scheduling and analytics are deliberately out of scope.</div>
              </Section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
