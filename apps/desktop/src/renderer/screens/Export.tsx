import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { exportPreflight, fmtTime, packageFolderName, slugify, type ExportRecord, type PreflightCheck } from '@cutaway/core';
import { saveNow, timeMapOf, useApp, useProject } from '../state/store';
import {
  BITRATE_SUPPORTED,
  COMPRESSION,
  PRORES_SUPPORTED,
  bitrateFor,
  estimateExportBytes,
  estimateProresBytes,
  estimateSeconds,
  estimateVideoBytes,
  sizeForShort,
  startFileExport,
  startPackageExport,
  useExportJob,
  type CompressionId,
  type ExportFormat,
  type ExportJob,
  type ExportTarget,
  type PackageExportResult,
} from '../engine/packageExport';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Segmented, Toggle, fmtAgo, fmtBytes } from '../ui/kit';
import { VoiceoverSheet } from './Voiceover';
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
const isMedia = (name: string) => /\.(mp4|mov|gif)$/i.test(name);
const PREFS_KEY = 'cutaway.export.prefs';

interface Prefs {
  format: ExportFormat;
  target: ExportTarget;
  compression: CompressionId;
  gifFps: number;
  gifShort: number;
}

function loadPrefs(): Prefs {
  const d: Prefs = { format: 'mp4', target: 'file', compression: 'social', gifFps: 15, gifShort: 480 };
  try {
    const p = { ...d, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
    return p.format === 'mov' && !PRORES_SUPPORTED ? { ...p, format: 'mp4' } : p;
  } catch {
    return d;
  }
}

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
const rank = (name: string) => FILE_ORDER.indexOf(name) + 1 || 99;

function FileList({ files, folder }: { files: ExportRecord['files']; folder: string | null }) {
  return (
    <ul className="file-list">
      {[...files].sort((a, b) => rank(a.name) - rank(b.name)).map((f) => (
        <li key={f.name}>
          <Icon name={FILE_ICON[f.name] ?? (isMedia(f.name) ? 'film' : 'folder')} size={14} style={{ color: f.ok ? 'var(--text-2)' : 'var(--danger)' }} />
          <div className="grow">
            <div className="file-name">{f.name}</div>
            <div className="tiny dim">{f.note ?? FILE_HINT[f.name] ?? ''}</div>
          </div>
          <span className="mono tiny dim">{fmtBytes(f.bytes)}</span>
          {folder && isMedia(f.name) ? (
            <Button size="sm" variant="ghost" icon="play" onClick={() => void window.cutaway.app.openPath(`${folder}/${f.name}`)}>
              Open
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A labelled row of the export sheet: label on the left, control on the right. */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="ex-row">
      <div className="ex-label">{label}</div>
      <div className="ex-control">
        {children}
        {hint ? <div className="tiny dim ex-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

function Running({ job }: { job: ExportJob }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const idx = job.stages.findIndex((s) => s.id === job.stage);
  const r = job.render;
  const elapsed = (Date.now() - job.startedAt) / 1000;
  const cancelling = job.abort.signal.aborted;
  const encoding = job.stage === 'video' && !!r && r.totalFrames > 0;
  // Percentage and time left come only from real frame counts and the measured encoder speed.
  const pct = encoding ? Math.min(100, Math.round((r!.frames / r!.totalFrames) * 100)) : null;
  const left = encoding && r!.fps > 0 ? Math.max(0, (r!.totalFrames - r!.frames) / r!.fps) : null;
  const what = job.kind === 'package' ? 'YouTube package' : job.format === 'gif' ? 'GIF' : job.format === 'mov' ? 'ProRes video' : 'video';
  return (
    <div className="ex-progress">
      <div className="row between">
        <div className="ex-title">
          Exporting {what}
          {pct !== null ? <span className="dim"> · {pct}%</span> : null}
          <span className="ex-info" title={`Saving into ${job.destDir}`}>
            <Icon name="info" size={13} />
          </span>
        </div>
        <span className="mono tiny dim" aria-label="Elapsed time">
          {fmtTime(elapsed)}
        </span>
      </div>
      {pct !== null ? (
        <div className="progress thin" role="progressbar" aria-valuemin={0} aria-valuemax={r!.totalFrames} aria-valuenow={r!.frames}>
          <i style={{ width: `${(r!.frames / r!.totalFrames) * 100}%` }} />
        </div>
      ) : (
        <div className="progress thin indeterminate">
          <i />
        </div>
      )}
      <div className="row between tiny dim mono">
        {encoding ? (
          <>
            <span>
              frame {r!.frames.toLocaleString()} of {r!.totalFrames.toLocaleString()}
            </span>
            <span>
              {r!.fps > 0 ? `${r!.fps.toFixed(1)} fps measured` : 'measuring speed…'}
              {left !== null ? ` · about ${fmtTime(left)} left` : ''}
            </span>
          </>
        ) : (
          <span>{job.detail}</span>
        )}
      </div>
      <ol className="stage-list">
        {job.stages.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'running' : 'pending';
          return (
            <li key={s.id} className={state}>
              <span className="stage-mark" aria-hidden>
                {state === 'done' ? <Icon name="check" size={11} /> : state === 'running' ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <span className="stage-dot" />}
              </span>
              <span className="stage-label">
                {s.label}
                <span className="sr-only"> — {state}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="row between">
        <span className="tiny dim">You can keep working in other screens. The export uses the edit as it was when you started.</span>
        <Button icon="stop" disabled={cancelling} onClick={() => job.abort.abort()}>
          {cancelling ? 'Stopping…' : 'Stop export'}
        </Button>
      </div>
    </div>
  );
}

function Finished({ job, result, onDismiss, onRetry, onChooseFolder }: { job: ExportJob; result: PackageExportResult; onDismiss: () => void; onRetry: () => void; onChooseFolder: () => void }) {
  const stages = job.stages;
  if (result.status === 'complete' && result.folder) {
    const media = result.files.find((f) => isMedia(f.name));
    const mediaPath = media ? `${result.folder}/${media.name}` : null;
    const pkg = job.kind === 'package';
    const clip = job.target === 'clipboard';
    const clipFailed = clip && !!result.error;
    return (
      <div className="ex-progress">
        <div className="ex-title">
          <span className="ex-ok">
            <Icon name="check" size={12} />
          </span>
          {pkg ? 'Package complete' : clipFailed ? 'Exported, but not copied' : clip ? 'Copied to the clipboard' : job.format === 'gif' ? 'GIF exported' : 'Video exported'}
        </div>
        <button className="folder-path" onClick={() => void window.cutaway.app.reveal(mediaPath ?? result.folder!)} title="Show in Finder">
          <Icon name="folder" size={13} /> {pkg || !media ? result.folder : mediaPath}
        </button>
        <FileList files={result.files} folder={result.folder} />
        {result.notes.length ? (
          <ul className="notes tiny muted">
            {result.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {pkg ? (
          <Banner tone="info" icon="shield" title="Nothing was uploaded to YouTube">
            These files are on your Mac only. Upload them yourself in YouTube Studio when you are ready.
          </Banner>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onDismiss}>
            Done
          </Button>
          {mediaPath ? (
            <>
              <Button icon="play" onClick={() => void window.cutaway.app.openPath(mediaPath)}>
                Open
              </Button>
              {!clip || clipFailed ? (
                <Button
                  onClick={() =>
                    void window.cutaway.app
                      .copyFile(mediaPath)
                      .then(() => useApp.getState().toast('Copied. Paste it into another app.'))
                      .catch((e) => useApp.getState().toast(`Could not copy: ${(e as Error).message}`, 'error'))
                  }
                >
                  Copy
                </Button>
              ) : null}
            </>
          ) : null}
          <Button variant="primary" icon="folder" onClick={() => void window.cutaway.app.reveal(mediaPath ?? result.folder!)}>
            Reveal in Finder
          </Button>
        </div>
      </div>
    );
  }
  const stage = stages.find((s) => s.id === result.failedStage)?.label.toLowerCase() ?? 'export';
  const disk = result.error?.code === 'disk-full';
  const folderProblem = disk || ['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(result.error?.code ?? '');
  const cancelled = result.status === 'cancelled';
  const partial = !!result.folder;
  return (
    <div className="ex-progress">
      <div className="ex-title" style={{ color: cancelled ? 'var(--text)' : 'var(--danger)' }}>{cancelled ? 'Export stopped' : partial ? 'Partial export' : 'Export failed'}</div>
      <div className="muted">{cancelled ? `Stopped at “${stage}”.` : disk ? 'The disk filled up.' : `It stopped at “${stage}”.`}</div>
      <Banner tone={cancelled ? 'info' : 'danger'} title={result.error?.message ?? 'The export did not finish.'}>
        Your project is untouched and no earlier export was overwritten. {partial ? 'The files that did finish were kept in a folder marked PARTIAL; it is not a complete package.' : 'No files were left behind.'}
      </Banner>
      {partial && result.folder ? (
        <>
          <button className="folder-path" onClick={() => void window.cutaway.app.reveal(result.folder!)}>
            <Icon name="folder" size={13} /> {result.folder}
          </button>
          <FileList files={result.files} folder={result.folder} />
        </>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onDismiss}>
          Back
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
      <div className="tiny dim">{job.kind === 'package' ? 'Retrying starts a fresh folder, so it is always safe.' : 'Retrying never overwrites a file you did not choose to replace.'}</div>
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
  const size = (e: ExportRecord) => {
    const short = Math.min(e.settings.width, e.settings.height);
    return short >= 2000 ? '4K' : `${short}p`;
  };
  return (
    <section className="ex-card">
      <div className="ex-card-title">
        <Icon name="history" size={15} /> Earlier exports
      </div>
      <ul className="history">
        {[...exports].reverse().map((e) => (
          <li key={e.id}>
            <span className={`pill ${e.status === 'complete' ? 'ok' : e.status === 'partial' ? 'warn' : 'danger'}`}>
              <Icon name={e.status === 'complete' ? 'check' : 'warn'} size={10} />
              {e.status === 'complete' ? 'Complete' : e.status === 'partial' ? 'Partial' : 'Failed'}
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="file-name">{baseName(e.folder)}</div>
              <div className="tiny dim">
                Revision {e.revision} · {size(e)} {e.settings.fps} fps{e.draft ? ' · draft' : ''} · {fmtAgo(e.createdAt)}
                {e.status === 'failed' ? ' · nothing kept' : present[e.id] === false ? (isMedia(e.folder) ? ' · file no longer there' : ' · folder no longer there') : ''}
              </div>
            </div>
            {present[e.id] ? <Button size="sm" variant="ghost" icon="folder" onClick={() => void window.cutaway.app.reveal(e.folder)} aria-label="Reveal in Finder" title="Reveal in Finder" /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Checks that matter when exporting a single file (packaging, captions and chapters are package-only). */
const FILE_CHECK = (c: PreflightCheck) => c.id === 'sources' || c.id === 'empty' || c.id === 'gaps' || c.id === 'disk' || c.id.startsWith('missing-') || c.id.startsWith('sync-');

export function ExportScreen() {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const settings = useApp((s) => s.settings);
  const job = useExportJob((s) => s.job);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [sharing, setSharing] = useState(false);
  const [voiceover, setVoiceover] = useState(false);

  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* a remembered choice is a convenience only */
      }
      return next;
    });

  const dest = destDir ?? settings?.exportDir ?? null;
  const map = timeMapOf(project);
  const out = project.edit.appearance.output;
  const short = Math.min(out.width, out.height);
  const tier = short >= 2000 ? '2160' : short <= 720 ? '720' : '1080';
  const wide = Math.abs(out.width / out.height - 16 / 9) < 0.01;
  const shape = wide ? 'Wide 16:9' : `${out.width}×${out.height}`;
  const format = prefs.format;
  // A YouTube package is an MP4 in the Wide shape; anything else falls back to a plain file.
  const packageOk = wide && format === 'mp4';
  const target: ExportTarget = prefs.target === 'package' && !packageOk ? 'file' : prefs.target;
  const gifSize = sizeForShort(out, prefs.gifShort);
  const bitrate = bitrateFor(out.width, out.height, out.fps, prefs.compression);
  const frames = Math.max(1, Math.round(map.outDuration * (format === 'gif' ? Math.min(30, out.fps) : out.fps)));

  const estimatedBytes = useMemo(() => (target === 'package' ? estimateExportBytes(project, bitrate) : format === 'mov' ? estimateProresBytes(project) : estimateVideoBytes(project, bitrate)), [project, bitrate, target, format]);
  const seconds = format === 'gif' ? estimateSeconds(frames, gifSize.width, gifSize.height) : estimateSeconds(frames, out.width, out.height);

  const refreshDisk = useCallback(() => {
    if (!dest) return;
    void window.cutaway.app.freeBytes(dest).then(setFreeBytes).catch(() => setFreeBytes(null));
    void window.cutaway.export.existingFolders(dest).then(setExisting).catch(() => setExisting([]));
  }, [dest]);
  useEffect(refreshDisk, [refreshDisk, job?.status]);

  const pre = useMemo(() => exportPreflight(project, { freeBytes, estimatedBytes }), [project, freeBytes, estimatedBytes]);
  const checks = target === 'package' ? pre.checks : pre.checks.filter(FILE_CHECK);
  const counts = { block: checks.filter((c) => c.level === 'block').length, warn: checks.filter((c) => c.level === 'warn').length };
  const blocked = counts.block > 0;
  const needsDraft = target === 'package' && !pre.canExport && pre.canExportDraft;
  const asDraft = needsDraft && draft;
  const folderName = target === 'package' ? packageFolderName(project.name, project.revision, existing, needsDraft) : `${slugify(project.name)}.${format}`;
  const mine = job && job.projectId === project.id ? job : null;
  const otherRunning = !!job && job.status === 'running' && job.projectId !== project.id;
  const busy = mine?.status === 'running';

  const chooseFolder = async () => {
    const picked = await window.cutaway.app.pickFolder('Choose where exports are saved', dest ?? undefined);
    if (!picked) return;
    setDestDir(picked);
    const s = await window.cutaway.app.setSettings({ exportDir: picked });
    useApp.getState().setSettings(s);
  };

  // Resolution and frame rate belong to the project; the shape is kept exactly.
  const setOutput = (patch: Partial<typeof out>) => useApp.getState().edit((e) => ({ ...e, appearance: { ...e.appearance, output: { ...e.appearance.output, ...patch } } }), 'Change export size');

  const finished = (current: { id: string }) => (result: PackageExportResult) => {
    const app = useApp.getState();
    if (result.record && app.project?.id === current.id) app.patch((p) => ({ ...p, exports: [...p.exports, result.record!] }));
    if (result.status === 'complete') app.toast(target === 'clipboard' && !result.error ? 'Exported and copied to the clipboard' : `Exported to ${result.folderName}`, 'info', result.folder ? { label: 'Reveal', run: () => void window.cutaway.app.reveal(result.folder!) } : undefined);
    else if (result.status !== 'cancelled') app.toast(result.error?.message ?? 'The export did not finish.', 'error');
  };

  const canStart = !blocked && !(needsDraft && !asDraft) && !otherRunning && !!dest && !busy && map.outDuration > 0.2;

  const start = async () => {
    if (!dest) return;
    await saveNow();
    const current = useApp.getState().project!;
    if (target === 'package') return startPackageExport({ project: current, projectPath, destDir: dest, draft: needsDraft, bitrate }, finished(current));
    // A file goes exactly where the creator says; the clipboard copy gets a free name in the export folder.
    let picked: { path: string; replace: boolean } | null = null;
    if (target === 'file') {
      picked = await window.cutaway.export.pickFile(dest, `${slugify(current.name)}.${format}`);
      if (!picked) return;
    }
    startFileExport({ project: current, projectPath, destDir: dest, format, target, filePath: picked?.path ?? null, replace: picked?.replace ?? false, gif: { fps: prefs.gifFps, short: prefs.gifShort }, bitrate }, finished(current));
  };

  // Return starts the export, as in the sheet's primary button label.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || voiceover) return;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)) return;
      if (canStart && !mine?.result) void start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onAction = (c: PreflightCheck) => {
    const app = useApp.getState();
    if (c.action === 'relink' || c.action === 'sync') app.setView('sources');
    else if (c.action === 'packaging' || c.action === 'chapters') app.setView('package');
    else if (c.action === 'free-space') void chooseFolder();
  };

  const share = async () => {
    const dir = await window.cutaway.app.pickFolder('Choose where to save the project zip', dest ?? undefined);
    if (!dir) return;
    setSharing(true);
    try {
      await saveNow();
      const r = await window.cutaway.library.exportBundle(projectPath, dir);
      useApp.getState().toast(`Project zip saved (${fmtBytes(r.bytes)}).`, 'info', { label: 'Reveal', run: () => void window.cutaway.app.reveal(r.path) });
    } catch (e) {
      useApp.getState().toast(`The project could not be zipped: ${(e as Error).message}`, 'error');
    } finally {
      setSharing(false);
    }
  };

  const sel = !!project.packaging.concepts.find((c) => c.id === project.packaging.selectedId);
  const willWrite = (['video.mp4', 'thumbnail.jpg', 'title.txt', 'title-options.txt', 'description.txt', 'chapters.txt', 'captions.srt', 'credits.txt', 'package.json'] as const).map((f) => ({
    f,
    has:
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
                : project.edit.broll.length > 0 || !!project.edit.audio.music,
  }));

  const primaryLabel = target === 'package' ? (needsDraft ? 'Export draft package' : 'Export YouTube package') : target === 'clipboard' ? 'Export to clipboard' : 'Export to file';
  const compression = COMPRESSION.find((c) => c.id === prefs.compression) ?? COMPRESSION[1];

  return (
    <div className="page export">
      <div className="export-wrap">
        <section className="ex-sheet" aria-label="Export">
          {mine?.status === 'running' ? (
            <Running job={mine} />
          ) : mine?.result ? (
            <Finished job={mine} result={mine.result} onDismiss={() => useExportJob.getState().set(null)} onRetry={() => void start()} onChooseFolder={() => void chooseFolder()} />
          ) : (
            <>
              <div className="row between ex-head">
                <h1 className="ex-title" style={{ margin: 0 }}>
                  Export
                </h1>
                <span className="tiny dim mono">
                  {fmtTime(map.outDuration)} · {shape} · revision {project.revision}
                </span>
              </div>

              <Row label="Format">
                <Segmented
                  label="Format"
                  value={format}
                  onChange={(v) => setPrefs({ format: v })}
                  options={[
                    { value: 'mp4', label: 'MP4' },
                    ...(PRORES_SUPPORTED ? [{ value: 'mov' as const, label: 'MOV (ProRes 422)' }] : []),
                    { value: 'gif', label: 'GIF' },
                  ]}
                />
              </Row>

              {format !== 'gif' ? (
                <>
                  <Row label="Frame rate">
                    <Segmented
                      label="Frame rate"
                      value={out.fps > 30 ? '60' : '30'}
                      onChange={(v) => setOutput({ fps: Number(v) })}
                      options={[
                        { value: '30', label: '30 FPS' },
                        { value: '60', label: '60 FPS' },
                      ]}
                    />
                  </Row>
                  <Row label="Resolution" hint={`${out.width} × ${out.height} px`}>
                    <Segmented
                      label="Resolution"
                      value={tier}
                      onChange={(v) => setOutput(sizeForShort(out, Number(v)))}
                      options={[
                        { value: '720', label: '720p' },
                        { value: '1080', label: '1080p' },
                        { value: '2160', label: '4K' },
                      ]}
                    />
                  </Row>
                  {format === 'mov' ? (
                    <Row label="Compression" hint="For editing again in Final Cut Pro, Premiere Pro or DaVinci Resolve. The file is large: about ten times an MP4. YouTube and most sites want the MP4.">
                      <div className="ex-fixed">ProRes 422 · uncompressed sound · SDR BT.709</div>
                    </Row>
                  ) : BITRATE_SUPPORTED ? (
                    <Row label="Compression" hint={<>{compression.note} Quality setting does not impact export speed.</>}>
                      <Segmented label="Compression" value={prefs.compression} onChange={(v) => setPrefs({ compression: v })} options={COMPRESSION.map((c) => ({ value: c.id, label: c.label }))} />
                    </Row>
                  ) : (
                    <Row label="Compression" hint="H.264 + AAC-LC, SDR BT.709, at the bitrate YouTube recommends for this size and frame rate.">
                      <div className="ex-fixed">Social Media · {(bitrate / 1e6).toFixed(0)} Mbps</div>
                    </Row>
                  )}
                </>
              ) : (
                <>
                  <Row label="Frame rate">
                    <Segmented
                      label="GIF frame rate"
                      value={String(prefs.gifFps)}
                      onChange={(v) => setPrefs({ gifFps: Number(v) })}
                      options={[
                        { value: '15', label: '15 FPS' },
                        { value: '20', label: '20 FPS' },
                        { value: '30', label: '30 FPS' },
                      ]}
                    />
                  </Row>
                  <Row label="Resolution" hint={`${gifSize.width} × ${gifSize.height} px. GIFs have no sound and get large quickly; keep them short.`}>
                    <Segmented
                      label="GIF resolution"
                      value={String(prefs.gifShort)}
                      onChange={(v) => setPrefs({ gifShort: Number(v) })}
                      options={[
                        { value: '480', label: '480p' },
                        { value: '720', label: '720p' },
                        { value: '1080', label: '1080p' },
                      ]}
                    />
                  </Row>
                </>
              )}

              <Row
                label="Export to"
                hint={
                  target === 'package'
                    ? 'One folder with the video, thumbnail, title, captions and chapters. Nothing is uploaded.'
                    : target === 'clipboard'
                      ? 'Exports the file into the export folder, then puts it on the clipboard so you can paste it into another app.'
                      : !packageOk
                        ? format !== 'mp4'
                          ? 'One file, saved where you choose. A YouTube package needs an MP4.'
                          : `One file, saved where you choose. A YouTube package needs the Wide 16:9 shape; this project is ${shape}. Change the shape under the preview in Edit.`
                        : 'One file. You choose its name and where it goes when you start.'
                }
              >
                <div className="row" style={{ gap: 8 }}>
                  <Segmented
                    label="Export to"
                    value={target}
                    onChange={(v) => setPrefs({ target: v })}
                    options={[
                      { value: 'file', label: 'File' },
                      { value: 'clipboard', label: 'Clipboard' },
                      { value: 'package', label: 'YouTube package', disabled: !packageOk, title: packageOk ? undefined : 'Needs MP4 in the Wide 16:9 shape' },
                    ]}
                  />
                  <Button icon="folder" onClick={() => void chooseFolder()} aria-label="Choose the export folder" title="Choose the export folder" />
                </div>
              </Row>

              <div className="ex-dest" title={dest ?? ''}>
                <Icon name="folder" size={13} />
                <span className="dest-path">{dest ?? '…'}</span>
                <span className="dim">/</span>
                <span className="dest-name">{folderName}</span>
                <span className="grow" />
                <span className="dim">{freeBytes !== null ? `${fmtBytes(freeBytes)} free` : ''}</span>
              </div>

              {target === 'package' ? (
                <ul className="will-write tiny">
                  {willWrite.map(({ f, has }) => (
                    <li key={f} className={has ? '' : 'off'} title={has ? FILE_HINT[f] : 'Not applicable to this project; the reason is recorded in package.json'}>
                      <Icon name={has ? 'check' : 'minus'} size={11} />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {needsDraft ? <Toggle checked={draft} onChange={setDraft} label="I understand this is a draft" hint="There are open review items. The folder name ends in -draft and package.json lists them." /> : null}
              {blocked ? (
                <Banner tone="danger" title="Something needs fixing first">
                  {checks.find((c) => c.level === 'block')?.title}. Use the button beside it in Preflight.
                </Banner>
              ) : null}
              {otherRunning ? <Banner tone="warn">Another project is exporting. Wait for it to finish before starting this one.</Banner> : null}

              <div className="ex-foot">
                <div className="tiny dim">
                  <span className="ex-est">Estimation</span>
                  {format === 'gif' ? 'Output size depends on the content' : `Output size about ${fmtBytes(estimatedBytes)}`}
                  {seconds !== null ? ` · Export time about ${seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : fmtTime(seconds)} (from your last export)` : ' · Export time is measured once it starts'}
                </div>
                <Button variant="primary" size="lg" disabled={!canStart} onClick={() => void start()}>
                  {primaryLabel} <span className="ex-return">↵</span>
                </Button>
              </div>
            </>
          )}
        </section>

        <aside className="ex-side">
          <section className="ex-card">
            <div className="row between">
              <div className="ex-card-title">
                <Icon name="check" size={15} /> Preflight
              </div>
              <div className="row gap-2">
                {counts.block ? <span className="pill danger">{counts.block} blocking</span> : null}
                {counts.warn ? <span className="pill warn">{counts.warn} to review</span> : null}
                {!counts.block && !counts.warn ? <span className="pill ok">All clear</span> : null}
                <Button size="sm" variant="ghost" icon="sync" onClick={refreshDisk} aria-label="Run preflight again" title="Run preflight again" />
              </div>
            </div>
            <ul className="checks">
              {checks.map((c) => (
                <CheckRow key={c.id} check={c} onAction={onAction} />
              ))}
            </ul>
          </section>

          <section className="ex-card">
            <div className="ex-card-title">
              <Icon name="link" size={15} /> Share and narrate
            </div>
            <div className="ex-more">
              <div className="grow">
                <div className="check-title">Share project</div>
                <div className="tiny muted">A zip of this project with its media inside, for someone else to open in Cutaway. Hosted share links are not available: there is no Cutaway server, so nothing is uploaded.</div>
              </div>
              <Button busy={sharing} onClick={() => void share()}>
                Share project…
              </Button>
            </div>
            <div className="ex-more">
              <div className="grow">
                <div className="check-title">Voiceover</div>
                <div className="tiny muted">Narration from a macOS system voice, generated on this Mac. Not a clone of your voice.</div>
              </div>
              <Button onClick={() => setVoiceover(true)}>Voiceover…</Button>
            </div>
          </section>

          <History exports={project.exports} />
        </aside>
      </div>
      {voiceover ? <VoiceoverSheet onClose={() => setVoiceover(false)} /> : null}
    </div>
  );
}
