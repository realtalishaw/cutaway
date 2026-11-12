import { useCallback, useEffect, useMemo, useState } from 'react';
import { exportPreflight, fmtTime, packageFolderName, type ExportRecord, type PreflightCheck } from '@cutaway/core';
import { saveNow, timeMapOf, useApp, useProject } from '../state/store';
import { EXPORT_STAGES, estimateExportBytes, startPackageExport, useExportJob, type ExportJob, type PackageExportResult } from '../engine/packageExport';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Segmented, Toggle, fmtAgo, fmtBytes } from '../ui/kit';
import './export.css';

const FILE_ICON: Record<string, IconName> = { 'video.mp4': 'film', 'thumbnail.jpg': 'image', 'thumbnail-master.jpg': 'image', 'captions.srt': 'captions', 'title.txt': 'text', 'title-options.txt': 'text', 'description.txt': 'text', 'chapters.txt': 'clock', 'credits.txt': 'broll', 'package.json': 'info' };

const FILE_HINT: Record<string, string> = {
  'video.mp4': 'The finished video',
  'thumbnail.jpg': 'Selected thumbnail, ready to upload',
  'thumbnail-master.jpg': '4K master of the thumbnail',
  'title.txt': 'Selected title',
  'title-options.txt': 'Selected title and the alternatives',
  'description.txt': 'Description',
  'chapters.txt': 'Chapter timestamps for the description',
  'captions.srt': 'Subtitles timed to the final cut',
  'credits.txt': 'Origin of B-roll and music',
  'package.json': 'Revision, settings and validation record',
};

const baseName = (p: string) => p.split('/').pop() ?? p;

function CheckRow({ check, onAction }: { check: PreflightCheck; onAction: (c: PreflightCheck) => void }) {
  const tone = check.level;
  const label = check.action === 'relink' ? 'Relink in Sources' : check.action === 'sync' ? 'Review sync' : check.action === 'packaging' ? 'Open Package' : check.action === 'chapters' ? 'Edit chapters' : check.action === 'free-space' ? 'Choose another folder' : null;
  return (
    <li className={`check ${tone}`}>
      <span className="check-mark" aria-hidden>
        <Icon name={tone === 'ok' ? 'check' : tone === 'warn' ? 'warn' : 'x'} size={12} />
      </span>
      <div className="grow">
        <div className="check-title">
          {check.title}
          <span className="sr-only"> — {tone === 'ok' ? 'passed' : tone === 'warn' ? 'warning' : 'blocks export'}</span>
        </div>
        <div className="tiny muted">{check.detail}</div>
      </div>
      {label && tone !== 'ok' ? (
        <Button size="sm" onClick={() => onAction(check)}>
          {label}
        </Button>
      ) : null}
    </li>
  );
}

const FILE_ORDER = ['video.mp4', 'thumbnail.jpg', 'thumbnail-master.jpg', 'title.txt', 'title-options.txt', 'description.txt', 'chapters.txt', 'captions.srt', 'credits.txt', 'package.json'];
const rank = (name: string) => (FILE_ORDER.indexOf(name) + 1 || 99);

function FileList({ files, folder }: { files: ExportRecord['files']; folder: string | null }) {
  return (
    <ul className="file-list">
      {[...files].sort((a, b) => rank(a.name) - rank(b.name)).map((f) => (
        <li key={f.name}>
          <Icon name={FILE_ICON[f.name] ?? 'folder'} size={14} style={{ color: f.ok ? 'var(--text-2)' : 'var(--danger)' }} />
          <div className="grow">
            <div className="mono file-name">{f.name}</div>
            <div className="tiny dim">{f.note ?? FILE_HINT[f.name] ?? ''}</div>
          </div>
          <span className="mono tiny dim">{fmtBytes(f.bytes)}</span>
          {folder && f.name === 'video.mp4' ? (
            <Button size="sm" variant="ghost" icon="play" onClick={() => void window.cutaway.app.openPath(`${folder}/${f.name}`)}>
              Open
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Running({ job }: { job: ExportJob }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const idx = EXPORT_STAGES.findIndex((s) => s.id === job.stage);
  const r = job.render;
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const cancelling = job.abort.signal.aborted;
  return (
    <div className="card export-status rise">
      <div className="row between">
        <div>
          <div className="eyebrow">Exporting{job.draft ? ' · draft' : ''}</div>
          <div className="display h2" style={{ marginTop: 8 }}>
            Writing the <em>package.</em>
          </div>
        </div>
        <span className="mono tiny dim" aria-label="Elapsed time">
          {fmtTime(elapsed)}
        </span>
      </div>
      <ol className="stage-list">
        {EXPORT_STAGES.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'running' : 'pending';
          return (
            <li key={s.id} className={state}>
              <span className="stage-mark" aria-hidden>
                {state === 'done' ? <Icon name="check" size={11} /> : state === 'running' ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <span className="stage-dot" />}
              </span>
              <div className="grow">
                <div className="stage-label">
                  {s.label}
                  <span className="sr-only"> — {state}</span>
                </div>
                {state === 'running' ? <div className="tiny muted">{job.detail}</div> : null}
                {state === 'running' && s.id === 'video' && r && r.totalFrames > 0 ? (
                  <div className="col" style={{ gap: 6, marginTop: 8 }}>
                    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={r.totalFrames} aria-valuenow={r.frames}>
                      <i style={{ width: `${Math.min(100, (r.frames / r.totalFrames) * 100)}%` }} />
                    </div>
                    <div className="row between mono tiny dim">
                      <span>
                        frame {r.frames.toLocaleString()} of {r.totalFrames.toLocaleString()}
                      </span>
                      <span>{r.fps > 0 ? `${r.fps.toFixed(1)} fps measured` : 'measuring speed…'}</span>
                    </div>
                  </div>
                ) : state === 'running' && s.id !== 'video' ? (
                  <div className="progress indeterminate" style={{ marginTop: 8 }}>
                    <i />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="row between" style={{ marginTop: 6 }}>
        <span className="tiny dim">You can keep working in other screens. The export uses the edit as it was when you started.</span>
        <Button icon="x" disabled={cancelling} onClick={() => job.abort.abort()}>
          {cancelling ? 'Cancelling…' : 'Cancel export'}
        </Button>
      </div>
    </div>
  );
}

function Finished({ result, onDismiss, onRetry, onChooseFolder }: { result: PackageExportResult; onDismiss: () => void; onRetry: () => void; onChooseFolder: () => void }) {
  if (result.status === 'complete' && result.folder) {
    return (
      <div className="card export-status rise">
        <div className="eyebrow" style={{ color: 'var(--ok)' }}>
          <Icon name="check" size={11} style={{ verticalAlign: -1, marginRight: 6 }} />
          Package complete
        </div>
        <div className="display h2" style={{ marginTop: 8 }}>
          Ready to <em>upload.</em>
        </div>
        <button className="folder-path mono" onClick={() => void window.cutaway.app.reveal(result.folder!)} title="Show in Finder">
          <Icon name="folder" size={13} /> {result.folder}
        </button>
        <FileList files={result.files} folder={result.folder} />
        {result.notes.length ? (
          <ul className="notes tiny muted">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <Banner tone="info" icon="shield" title="Nothing was uploaded to YouTube">
          These files are on your Mac only. Upload them yourself in YouTube Studio when you are ready.
        </Banner>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onDismiss}>
            Done
          </Button>
          <Button icon="play" onClick={() => void window.cutaway.app.openPath(`${result.folder}/video.mp4`)}>
            Open video
          </Button>
          <Button variant="primary" icon="folder" onClick={() => void window.cutaway.app.reveal(result.folder!)}>
            Reveal in Finder
          </Button>
        </div>
      </div>
    );
  }
  const stage = EXPORT_STAGES.find((s) => s.id === result.failedStage)?.label.toLowerCase() ?? 'export';
  const disk = result.error?.code === 'disk-full';
  const folderProblem = disk || ['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(result.error?.code ?? '');
  const cancelled = result.status === 'cancelled';
  const partial = !!result.folder;
  return (
    <div className="card export-status rise">
      <div className="eyebrow" style={{ color: cancelled ? 'var(--text-3)' : 'var(--danger)' }}>{cancelled ? 'Export cancelled' : partial ? 'Partial export' : 'Export failed'}</div>
      <div className="display h2" style={{ marginTop: 8 }}>
        {cancelled ? (
          <>
            Stopped at <em>{stage}.</em>
          </>
        ) : disk ? (
          <>
            The disk <em>filled up.</em>
          </>
        ) : (
          <>
            It stopped at <em>{stage}.</em>
          </>
        )}
      </div>
      <Banner tone={cancelled ? 'info' : 'danger'} title={result.error?.message ?? 'The export did not finish.'}>
        Your project is untouched and no earlier package was overwritten. {partial ? 'The files that did finish were kept in a folder marked PARTIAL; it is not a complete package.' : 'No files were left behind.'}
      </Banner>
      {partial && result.folder ? (
        <>
          <button className="folder-path mono" onClick={() => void window.cutaway.app.reveal(result.folder!)}>
            <Icon name="folder" size={13} /> {result.folder}
          </button>
          <FileList files={result.files} folder={result.folder} />
        </>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onDismiss}>
          Back to preflight
        </Button>
        {folderProblem ? (
          <Button icon="folder" onClick={onChooseFolder}>
            Choose another folder
          </Button>
        ) : null}
        <Button variant="primary" icon="sync" onClick={onRetry}>
          {disk ? 'Retry after freeing space' : 'Export again'}
        </Button>
      </div>
      <div className="tiny dim">Retrying starts a fresh folder, so it is always safe.</div>
    </div>
  );
}

function History({ exports }: { exports: ExportRecord[] }) {
  const [present, setPresent] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(exports.map(async (e) => [e.id, await window.cutaway.library.exists(e.folder).catch(() => false)] as const)).then((rows) => live && setPresent(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
  }, [exports]);
  if (exports.length === 0) return null;
  return (
    <section className="col" style={{ gap: 10 }}>
      <div className="eyebrow">Earlier exports of this project</div>
      <ul className="history">
        {[...exports].reverse().map((e) => (
          <li key={e.id}>
            <span className={`pill ${e.status === 'complete' ? 'ok' : e.status === 'partial' ? 'warn' : 'danger'}`}>
              <Icon name={e.status === 'complete' ? 'check' : 'warn'} size={10} />
              {e.status === 'complete' ? 'Complete' : e.status === 'partial' ? 'Partial' : 'Failed'}
            </span>
            <div className="grow">
              <div className="mono file-name">{baseName(e.folder)}</div>
              <div className="tiny dim">
                Revision {e.revision} · {e.settings.height === 2160 ? '4K' : `${e.settings.height}p`} {e.settings.fps} fps{e.draft ? ' · draft' : ''} · {fmtAgo(e.createdAt)}
                {e.status === 'failed' ? ` · stopped at ${EXPORT_STAGES.find((x) => x.id === e.failedStage)?.label.toLowerCase() ?? 'export'}, nothing kept` : present[e.id] === false ? ' · folder no longer there' : ''}
              </div>
            </div>
            {present[e.id] ? (
              <Button size="sm" variant="ghost" icon="folder" onClick={() => void window.cutaway.app.reveal(e.folder)}>
                Reveal
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ExportScreen() {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const settings = useApp((s) => s.settings);
  const job = useExportJob((s) => s.job);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);

  const dest = destDir ?? settings?.exportDir ?? null;
  const map = timeMapOf(project);
  const out = project.edit.appearance.output;
  const estimatedBytes = useMemo(() => estimateExportBytes(project), [project]);

  const refreshDisk = useCallback(() => {
    if (!dest) return;
    void window.cutaway.app.freeBytes(dest).then(setFreeBytes).catch(() => setFreeBytes(null));
    void window.cutaway.export.existingFolders(dest).then(setExisting).catch(() => setExisting([]));
  }, [dest]);
  useEffect(refreshDisk, [refreshDisk, job?.status]);

  const pre = useMemo(() => exportPreflight(project, { freeBytes, estimatedBytes }), [project, freeBytes, estimatedBytes]);
  const blocked = !pre.canExportDraft;
  const needsDraft = !pre.canExport && pre.canExportDraft;
  const asDraft = needsDraft && draft;
  const folderName = packageFolderName(project.name, project.revision, existing, needsDraft);
  const mine = job && job.projectId === project.id ? job : null;
  const otherRunning = !!job && job.status === 'running' && job.projectId !== project.id;

  const chooseFolder = async () => {
    const picked = await window.cutaway.app.pickFolder('Choose where packages are saved', dest ?? undefined);
    if (!picked) return;
    setDestDir(picked);
    const s = await window.cutaway.app.setSettings({ exportDir: picked });
    useApp.getState().setSettings(s);
  };

  const setOutput = (patch: Partial<typeof out>) => useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, output: { ...e.appearance.output, ...patch } } }), 'Change export format');

  const start = async () => {
    if (!dest) return;
    await saveNow();
    const current = useApp.getState().project!;
    startPackageExport({ project: current, projectPath, destDir: dest, draft: needsDraft }, (result) => {
      const app = useApp.getState();
      if (result.record && app.project?.id === current.id) app.patch((p) => ({ ...p, exports: [...p.exports, result.record!] }));
      if (result.status === 'complete') app.toast(`Package exported to ${result.folderName}`, 'info', result.folder ? { label: 'Reveal', run: () => void window.cutaway.app.reveal(result.folder!) } : undefined);
      else if (result.status !== 'cancelled') app.toast(result.error?.message ?? 'The export did not finish.', 'error');
    });
  };

  const onAction = (c: PreflightCheck) => {
    const app = useApp.getState();
    if (c.action === 'relink' || c.action === 'sync') app.setView('sources');
    else if (c.action === 'packaging' || c.action === 'chapters') app.setView('package');
    else if (c.action === 'free-space') void chooseFolder();
  };

  const counts = { block: pre.checks.filter((c) => c.level === 'block').length, warn: pre.checks.filter((c) => c.level === 'warn').length };

  return (
    <div className="page export">
      <div className="page-inner export-inner">
        <header className="export-head rise">
          <div className="eyebrow">Step 05 · Export</div>
          <h1 className="display h1">
            One folder, <em>ready to upload.</em>
          </h1>
          <p className="muted lede">The video, the thumbnail and title you chose, and captions and chapters timed to this exact cut. Cutaway never uploads or publishes anything.</p>
        </header>

        <div className="export-grid">
          <div className="col" style={{ gap: 16 }}>
            <section className="card col" style={{ gap: 16 }}>
              <div className="row between">
                <div className="eyebrow">Format</div>
                <span className="mono tiny dim">
                  {fmtTime(map.outDuration)} · revision {project.revision}
                </span>
              </div>
              <div className="row wrap" style={{ gap: 12 }}>
                <div className="field">
                  <span className="label">Resolution</span>
                  <Segmented
                    label="Resolution"
                    value={out.height >= 2160 ? '2160' : '1080'}
                    onChange={(v) => setOutput(v === '2160' ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 })}
                    options={[
                      { value: '1080', label: '1080p' },
                      { value: '2160', label: '4K' },
                    ]}
                  />
                </div>
                <div className="field">
                  <span className="label">Frame rate</span>
                  <Segmented
                    label="Frame rate"
                    value={out.fps > 30 ? '60' : '30'}
                    onChange={(v) => setOutput({ fps: Number(v) })}
                    options={[
                      { value: '30', label: '30 fps' },
                      { value: '60', label: '60 fps' },
                    ]}
                  />
                </div>
                <div className="field grow">
                  <span className="label">Encoding</span>
                  <div className="well format-note tiny muted" title="Progressive frames, tagged BT.709, as YouTube recommends for SDR uploads">MP4 · H.264 · AAC-LC · SDR BT.709</div>
                </div>
              </div>
              <div className="field">
                <span className="label">
                  Save to <span className="value">{freeBytes !== null ? `${fmtBytes(freeBytes)} free` : ''}</span>
                </span>
                <div className="row">
                  <div className="well dest mono tiny grow" title={dest ?? ''}>
                    <Icon name="folder" size={13} />
                    <span className="dest-path">{dest ?? '…'}</span>
                    <span className="dim">/</span>
                    <span className="dest-name">{folderName}</span>
                  </div>
                  <Button onClick={() => void chooseFolder()}>Change…</Button>
                </div>
                <span className="tiny dim">A new folder is created every time. An existing export is never overwritten.</span>
              </div>
            </section>

            <section className="card col" style={{ gap: 12 }}>
              <div className="row between">
                <div className="eyebrow">Preflight</div>
                <div className="row gap-2">
                  {counts.block ? <span className="pill danger">{counts.block} blocking</span> : null}
                  {counts.warn ? <span className="pill warn">{counts.warn} to review</span> : null}
                  {!counts.block && !counts.warn ? <span className="pill ok">All clear</span> : null}
                  <Button size="sm" variant="ghost" icon="sync" onClick={refreshDisk} aria-label="Run preflight again" title="Run preflight again" />
                </div>
              </div>
              <ul className="checks">
                {pre.checks.map((c) => (
                  <CheckRow key={c.id} check={c} onAction={onAction} />
                ))}
              </ul>
            </section>
          </div>

          <div className="col" style={{ gap: 16 }}>
            {mine?.status === 'running' ? (
              <Running job={mine} />
            ) : mine?.result ? (
              <Finished result={mine.result} onDismiss={() => useExportJob.getState().set(null)} onRetry={() => void start()} onChooseFolder={() => void chooseFolder()} />
            ) : (
              <section className="card export-status rise">
                <div className="eyebrow">{blocked ? 'Blocked' : needsDraft ? 'Draft only' : 'Ready'}</div>
                <div className="display h2" style={{ marginTop: 8 }}>
                  {blocked ? (
                    <>
                      Something needs <em>fixing first.</em>
                    </>
                  ) : needsDraft ? (
                    <>
                      Export a <em>labelled draft?</em>
                    </>
                  ) : (
                    <>
                      Everything <em>checks out.</em>
                    </>
                  )}
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  {blocked
                    ? 'A complete package cannot be written while required media is missing, the title is invalid or the disk is too full. Use the buttons beside each item to fix it.'
                    : needsDraft
                      ? 'There are open review items. You can still export a folder clearly named as a draft; it records which items were unresolved.'
                      : `About ${fmtBytes(estimatedBytes)} will be written to a new folder.`}
                </p>
                <ul className="will-write tiny">
                  {(['video.mp4', 'thumbnail.jpg', 'title.txt', 'title-options.txt', 'description.txt', 'chapters.txt', 'captions.srt', 'credits.txt', 'package.json'] as const).map((f) => {
                    const sel = !!project.packaging.concepts.find((c) => c.id === project.packaging.selectedId);
                    const has =
                      f === 'video.mp4' || f === 'package.json'
                        ? true
                        : f === 'thumbnail.jpg' || f === 'title.txt' || f === 'title-options.txt'
                          ? sel
                          : f === 'description.txt'
                            ? !!project.packaging.description.trim()
                            : f === 'chapters.txt'
                              ? project.packaging.chapters.length > 0
                              : f === 'captions.srt'
                                ? !!project.transcript?.hasSpeech
                                : project.edit.broll.length > 0 || !!project.edit.audio.music;
                    return (
                      <li key={f} className={has ? '' : 'off'} title={has ? FILE_HINT[f] : 'Not applicable to this project; the reason is recorded in package.json'}>
                        <Icon name={has ? 'check' : 'minus'} size={11} />
                        <span className="mono">{f}</span>
                      </li>
                    );
                  })}
                </ul>
                {needsDraft ? <Toggle checked={draft} onChange={setDraft} label="I understand this is a draft" hint="The folder name ends in -draft and package.json lists the open items." /> : null}
                {otherRunning ? <Banner tone="warn">Another project is exporting. Wait for it to finish before starting this one.</Banner> : null}
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button variant="primary" size="lg" icon="upload" disabled={blocked || (needsDraft && !asDraft) || otherRunning || !dest} onClick={() => void start()}>
                    {needsDraft ? 'Export draft package' : 'Export YouTube package'}
                  </Button>
                </div>
              </section>
            )}
            <History exports={project.exports} />
          </div>
        </div>
      </div>
    </div>
  );
}
