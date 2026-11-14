import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { portableAppearance, uid } from '@cutaway/core';
import type { AppSettings, CacheInfo, StylePreset } from '@shared/api';
import { useApp } from '../state/store';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Field, Segmented, Slider, Toggle, fmtAgo, fmtBytes } from '../ui/kit';
import { AiSection } from './settings/AiSection';
import { ImagesSection } from './settings/ImagesSection';
import { PlaybooksSection } from './settings/PlaybooksSection';
import { ShortcutsSection } from './settings/ShortcutsSection';
import { GenerationSection } from './settings/GenerationSection';
import { AiToolsSection } from './settings/AiToolsSection';
import './settings.css';

type Tab = 'storage' | 'processing' | 'generation' | 'aitools' | 'recording' | 'access' | 'shortcuts' | 'presets' | 'about';

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'storage', label: 'Storage', icon: 'folder' },
  { id: 'processing', label: 'Processing', icon: 'shield' },
  { id: 'generation', label: 'AI generation', icon: 'sparkle' },
  { id: 'aitools', label: 'AI tools', icon: 'command' },
  { id: 'recording', label: 'Recording', icon: 'record' },
  { id: 'access', label: 'Accessibility', icon: 'eye' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'command' },
  { id: 'presets', label: 'Presets', icon: 'palette' },
  { id: 'about', label: 'About', icon: 'info' },
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
    const preset: StylePreset = { id: uid('preset'), name, createdAt: new Date().toISOString(), appearance: portableAppearance(project.edit.appearance), brief: { pacing: project.brief.pacing, visualIntensity: project.brief.visualIntensity } };
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
              <ImagesSection settings={settings} update={update} />
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
              <AiSection settings={settings} update={update} />

              <PlaybooksSection settings={settings} update={update} />

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

          {tab === 'generation' ? <GenerationSection /> : null}
          {tab === 'aitools' ? <AiToolsSection /> : null}
          {tab === 'shortcuts' ? <ShortcutsSection update={update} /> : null}

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
              <Section title="What is not here yet" hint="Cutaway is independently built. These parts of the wider recording-tool baseline are not shipped.">
                <ul className="plain tiny muted">
                  <li>Hosted share links and view counts (Cutaway has no server; share a project file or an export instead)</li>
                  <li>A built-in stock photo catalogue (online image search needs your own Unsplash key, under Storage)</li>
                  <li>HDR and 10-bit capture; ProRes exports are made from an 8-bit render</li>
                  <li>Masks that follow content as it scrolls (masks are fixed rectangles over a time range)</li>
                  <li>Recording one browser tab while it is hidden behind another tab or window (Tab mode records the browser window with its toolbar left out, so the tab has to stay in front)</li>
                  <li>Generated pictures from Claude (only Codex has an image tool, so thumbnail pictures always go through Codex)</li>
                </ul>
                <div className="tiny dim">Exports are qualified for SDR at 1080p, 30 fps. 4K and 60 fps are available and not yet measured. YouTube upload, scheduling and analytics are deliberately out of scope.</div>
              </Section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
