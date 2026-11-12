import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtTime } from '@cutaway/core';
import type { CameraInfo, DeviceList, DisplayInfo, Permission, PermissionKind, PreflightResult, RecordConfig, RecordEvent } from '@shared/api';
import { useApp } from '../state/store';
import { backToLibrary, errorText, pickAndImport, setRecordingActive } from '../state/actions';
import { addTakeToProject, describeTake } from '../state/recording';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Meter, Segmented, Toggle, fmtBytes } from '../ui/kit';
import './record.css';

type Mode = 'display' | 'window' | 'region' | 'none';
type Thumb = { kind: 'display' | 'window'; id: number; displayId: number | null; name: string; dataUrl: string };
type Phase = 'setup' | 'checking' | 'countdown' | 'starting' | 'recording' | 'finishing' | 'failed';
type Region = { x: number; y: number; width: number; height: number };

const api = () => window.cutaway;

const SOURCE_LABEL: Record<string, string> = { screen: 'Screen', cameraA: 'Camera A', cameraB: 'Camera B', microphone: 'Microphone', system: 'System audio' };
const SOURCE_ICON: Record<string, IconName> = { screen: 'screen', cameraA: 'camera', cameraB: 'camera', microphone: 'mic', system: 'speaker' };
const PERMISSION_NAME: Record<PermissionKind, string> = { screen: 'Screen Recording', camera: 'Camera', microphone: 'Microphone' };

// ───────────────────────────── device helpers ─────────────────────────────

/** Best capture format at or below 1080p, preferring 16:9. */
function pickFormat(cam: CameraInfo): { width: number; height: number; fps: number } {
  const formats = cam.formats.length ? cam.formats : [{ width: 1280, height: 720, maxFps: 30 }];
  const score = (f: (typeof formats)[number]) => {
    const wide = Math.abs(f.width / f.height - 16 / 9) < 0.02 ? 1e7 : 0;
    const fits = f.height <= 1080 && f.width <= 1920 ? 1e6 : 0;
    return wide + fits + f.width * f.height * (f.height <= 1080 ? 1 : -1);
  };
  const best = [...formats].sort((a, b) => score(b) - score(a))[0]!;
  return { width: best.width, height: best.height, fps: Math.min(30, Math.round(best.maxFps) || 30) };
}

async function browserDevice(kind: 'videoinput' | 'audioinput', nativeName: string): Promise<MediaDeviceInfo | null> {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind && d.deviceId !== 'default');
  const clean = (s: string) => s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').replace(/[’']/g, "'").trim().toLowerCase();
  const want = clean(nativeName);
  return list.find((d) => clean(d.label) === want) ?? list.find((d) => clean(d.label).startsWith(want) || want.startsWith(clean(d.label) || '\u0000')) ?? null;
}

/** Live preview of one native camera through the renderer. Stops the stream when disabled or unmounted. */
function useCameraPreview(name: string | null, enabled: boolean) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<'off' | 'loading' | 'live' | 'unavailable'>('off');
  useEffect(() => {
    if (!name || !enabled) {
      setStream(null);
      setState('off');
      return;
    }
    let cancelled = false;
    let current: MediaStream | null = null;
    setState('loading');
    (async () => {
      try {
        const dev = await browserDevice('videoinput', name);
        if (!dev) throw new Error('no matching device');
        current = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: dev.deviceId }, width: { ideal: 960 }, height: { ideal: 540 } }, audio: false });
        if (cancelled) return current.getTracks().forEach((t) => t.stop());
        setStream(current);
        setState('live');
      } catch {
        if (!cancelled) {
          setStream(null);
          setState('unavailable');
        }
      }
    })();
    return () => {
      cancelled = true;
      current?.getTracks().forEach((t) => t.stop());
    };
  }, [name, enabled]);
  return { stream, state };
}

/** Peak level of a microphone in dBFS, about 15 times a second. */
function useMicLevel(name: string | null, enabled: boolean): number | null {
  const [db, setDb] = useState<number | null>(null);
  useEffect(() => {
    if (!name || !enabled) {
      setDb(null);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      try {
        const dev = await browserDevice('audioinput', name);
        stream = await navigator.mediaDevices.getUserMedia({ audio: dev ? { deviceId: { exact: dev.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : true, video: false });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let held = -60;
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]!));
          const now = 20 * Math.log10(peak + 1e-6);
          held = Math.max(now, held - 2.5);
          setDb(Math.max(-60, held));
        }, 66);
      } catch {
        if (!cancelled) setDb(null);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [name, enabled]);
  return db;
}

function LiveVideo({ stream, mirror }: { stream: MediaStream | null; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline style={mirror ? { transform: 'scaleX(-1)' } : undefined} />;
}

// ───────────────────────────── small pieces ─────────────────────────────

function PermissionNote({ kind, status, onRequest, children }: { kind: PermissionKind; status: Permission; onRequest: () => void; children?: React.ReactNode }) {
  if (status === 'granted') return null;
  if (status === 'undetermined') {
    return (
      <div className="perm-note">
        <Icon name="shield" size={14} />
        <span className="grow">macOS will ask once for {PERMISSION_NAME[kind]} access.</span>
        <Button size="sm" onClick={onRequest}>Allow…</Button>
      </div>
    );
  }
  return (
    <div className="perm-note denied" role="alert">
      <Icon name="warn" size={14} />
      <div className="grow">
        <div style={{ fontWeight: 620, color: 'var(--text)' }}>{PERMISSION_NAME[kind]} access is off for Cutaway</div>
        <div>
          Turn it on in System Settings → Privacy &amp; Security → {PERMISSION_NAME[kind]}, then come back. {children}
        </div>
      </div>
      <Button size="sm" icon="external" onClick={() => void api().app.openPrivacySettings(kind)}>Open settings</Button>
    </div>
  );
}

function Section({ icon, title, right, children, off }: { icon: IconName; title: string; right?: React.ReactNode; children?: React.ReactNode; off?: boolean }) {
  return (
    <section className={`rec-section${off ? ' off' : ''}`}>
      <header className="row between">
        <span className="row" style={{ gap: 8, fontWeight: 620 }}>
          <Icon name={icon} size={15} style={{ color: off ? 'var(--text-3)' : 'var(--text-2)' }} />
          {title}
        </span>
        {right}
      </header>
      {children}
    </section>
  );
}

function NumberField({ label, value, onChange, min = 0 }: { label: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <label className="num-field">
      <span className="mono">{label}</span>
      <input className="input mono" type="number" min={min} step={2} value={Math.round(value)} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} aria-label={label} />
    </label>
  );
}

function fitRegion(d: DisplayInfo, w: number, h: number): Region {
  const width = Math.min(w, d.width);
  const height = Math.min(h, d.height);
  return { x: Math.round((d.width - width) / 2), y: Math.round((d.height - height) / 2), width, height };
}

// ───────────────────────────── the screen ─────────────────────────────

export function Record() {
  const projectPath = useApp((s) => s.projectPath);
  const settings = useApp((s) => s.settings);
  const helper = useApp((s) => s.info?.nativeHelper ?? true);

  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [perms, setPerms] = useState<Record<PermissionKind, Permission>>({ screen: 'undetermined', camera: 'undetermined', microphone: 'undetermined' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<Mode>('display');
  const [displayId, setDisplayId] = useState<number | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [camA, setCamA] = useState<string | null>(null);
  const [camB, setCamB] = useState<string | null>(null);
  const [mic, setMic] = useState<string | null>(null);
  const [systemAudio, setSystemAudio] = useState(false);
  const [fps, setFps] = useState<30 | 60>(60);
  const [cursor, setCursor] = useState<'clean' | 'baked'>('clean');
  const initialised = useRef(false);

  const [phase, setPhase] = useState<Phase>('setup');
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [blocking, setBlocking] = useState<PreflightResult['issues'] | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [live, setLive] = useState<{ elapsed: number; paused: boolean; frames: Record<string, number>; mic: number | null; lost: { source: string; elapsed: number; reason: string; restored: number | null }[]; diskLow: boolean; sources: string[] }>({ elapsed: 0, paused: false, frames: {}, mic: null, lost: [], diskLow: false, sources: [] });
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  const phaseRef = useRef<Phase>('setup');
  phaseRef.current = phase;
  const finished = useRef(false);
  const takeDirRef = useRef<string | null>(null);

  // ── devices and permissions ──
  const refresh = useCallback(async () => {
    try {
      const [screen, camera, microphone] = await Promise.all([api().app.permission('screen'), api().app.permission('camera'), api().app.permission('microphone')]);
      setPerms({ screen, camera, microphone });
      const [list, shots] = await Promise.all([api().native.devices(), api().app.captureThumbnails().catch(() => [] as Thumb[])]);
      setDevices(list);
      setThumbs(shots);
      setLoadError(null);
      if (!initialised.current) {
        initialised.current = true;
        const main = list.displays.find((d) => d.main) ?? list.displays[0];
        setDisplayId(main?.id ?? null);
        if (screen === 'denied') setMode('none');
        // Sources that would need a new permission stay off until the creator turns them on.
        if (camera === 'granted' && list.cameras[0]) setCamA(list.cameras[0].id);
        if (microphone === 'granted') setMic((list.microphones.find((m) => m.default) ?? list.microphones[0])?.id ?? null);
      }
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Coming back from System Settings: pick up the new permission state.
    const onFocus = () => phaseRef.current === 'setup' && void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const request = useCallback(
    async (kind: PermissionKind) => {
      const status = await api().app.requestPermission(kind);
      setPerms((p) => ({ ...p, [kind]: status }));
      await refresh();
      return status;
    },
    [refresh],
  );

  const display = devices?.displays.find((d) => d.id === displayId) ?? devices?.displays[0] ?? null;
  const win = devices?.windows.find((w) => w.id === windowId) ?? null;
  const cameraA = devices?.cameras.find((c) => c.id === camA) ?? null;
  const cameraB = devices?.cameras.find((c) => c.id === camB) ?? null;
  const microphone = devices?.microphones.find((m) => m.id === mic) ?? null;

  useEffect(() => {
    // Default to a 16:9 area that is visibly smaller than the display.
    if (mode === 'region' && display && !region) setRegion(display.width > 1920 && display.height > 1080 ? fitRegion(display, 1920, 1080) : fitRegion(display, 1280, 720));
  }, [mode, display, region]);

  const wantsScreen = mode !== 'none';
  const screenBlocked = wantsScreen && perms.screen !== 'granted';
  const cameraBlocked = (!!camA || !!camB) && perms.camera !== 'granted';
  const micBlocked = !!mic && perms.microphone !== 'granted';
  const screenReady = wantsScreen && !screenBlocked && (mode === 'window' ? !!win : !!display);
  const previewsOn = phase === 'setup' || phase === 'checking';

  const previewA = useCameraPreview(cameraA?.name ?? null, previewsOn && perms.camera === 'granted');
  const previewB = useCameraPreview(cameraB?.name ?? null, previewsOn && perms.camera === 'granted');
  const micDb = useMicLevel(microphone?.name ?? null, previewsOn && perms.microphone === 'granted');

  const config = useMemo<RecordConfig | null>(() => {
    if (!devices) return null;
    const cameras: RecordConfig['cameras'] = [];
    if (!cameraBlocked) {
      if (cameraA) cameras.push({ slot: 'A', deviceId: cameraA.id, ...pickFormat(cameraA) });
      if (cameraB) cameras.push({ slot: 'B', deviceId: cameraB.id, ...pickFormat(cameraB) });
    }
    let screen: RecordConfig['screen'] = null;
    if (screenReady && display) {
      const showCursor = cursor === 'baked';
      if (mode === 'display') screen = { type: 'display', displayId: display.id, showCursor };
      else if (mode === 'window' && win) screen = { type: 'window', windowId: win.id, showCursor };
      else if (mode === 'region' && region) screen = { type: 'region', displayId: display.id, rect: { x: display.x + region.x, y: display.y + region.y, width: region.width, height: region.height }, showCursor };
    }
    return { fps, screen, cameras, microphone: microphone && !micBlocked ? { deviceId: microphone.id } : null, systemAudio: systemAudio && perms.screen === 'granted' };
  }, [devices, cameraA, cameraB, cameraBlocked, screenReady, display, win, region, mode, cursor, fps, microphone, micBlocked, systemAudio, perms.screen]);

  const sourceCount = config ? (config.screen ? 1 : 0) + config.cameras.length + (config.microphone ? 1 : 0) + (config.systemAudio ? 1 : 0) : 0;
  const hasPicture = !!config && (!!config.screen || config.cameras.length > 0);
  const duplicate = !!camA && camA === camB;

  // ── quiet preflight for the disk estimate ──
  const configKey = JSON.stringify(config);
  useEffect(() => {
    if (!config || sourceCount === 0 || phase !== 'setup' || !helper) return;
    let stale = false;
    const t = setTimeout(() => {
      api()
        .native.preflight(config)
        .then((r) => !stale && setPreflight(r))
        .catch(() => !stale && setPreflight(null));
    }, 450);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, phase, helper]);

  // ── recorder events ──
  const finish = useCallback(async (run: () => Promise<{ text: string; tone?: 'info' | 'error' }>) => {
    if (finished.current) return;
    finished.current = true;
    setPhase('finishing');
    setRecordingActive(false);
    await api().app.recordingMode(false).catch(() => {});
    try {
      const r = await run();
      const app = useApp.getState();
      app.setView('sources');
      app.go('project');
      app.toast(r.text, r.tone ?? 'info');
    } catch (e) {
      finished.current = false;
      setFailure({ title: 'The take could not be added to the project', detail: `${errorText(e)} The recorded files are still on disk; the library will offer to recover them.` });
      setPhase('failed');
    }
  }, []);

  useEffect(() => {
    const off = api().record.onEvent((e: RecordEvent) => {
      const p = phaseRef.current;
      if (p !== 'starting' && p !== 'recording') return;
      switch (e.type) {
        case 'started':
          setLive((l) => ({ ...l, sources: e.sources.map((s) => s.id) }));
          break;
        case 'tick':
          setLive((l) => ({ ...l, elapsed: e.elapsed, frames: e.frames }));
          break;
        case 'levels':
          setLive((l) => ({ ...l, mic: e.microphone ?? null }));
          break;
        case 'paused':
          setLive((l) => ({ ...l, paused: true, elapsed: e.elapsed }));
          break;
        case 'resumed':
          setLive((l) => ({ ...l, paused: false }));
          break;
        case 'source-lost':
          setLive((l) => ({ ...l, lost: [...l.lost, { source: e.source, elapsed: e.elapsed, reason: e.reason, restored: null }] }));
          break;
        case 'source-restored':
          setLive((l) => ({ ...l, lost: l.lost.map((x) => (x.source === e.source && x.restored === null ? { ...x, restored: e.elapsed } : x)) }));
          break;
        case 'disk-low':
          setLive((l) => ({ ...l, diskLow: true }));
          break;
        case 'stopped': {
          const takeDir = takeDirRef.current;
          if (!takeDir) break;
          const manifest = e.manifest;
          void finish(async () => {
            const r = await addTakeToProject(manifest, takeDir);
            const gaps = manifest.sources.some((s) => s.gaps.length > 0);
            const demoted = r.demoted.length ? ` ${r.demoted.length} track${r.demoted.length === 1 ? ' was' : 's were'} added as supporting media because that role was already filled.` : '';
            return { text: `Recorded ${fmtTime(manifest.duration)} of ${describeTake(manifest)}.${gaps ? ' Missing stretches are marked on the track.' : ''}${demoted}` };
          });
          break;
        }
        case 'crashed': {
          const takeDir = e.takeDir;
          void finish(async () => {
            // Movie fragments are flushed every two seconds, so everything up to the last checkpoint is playable.
            const manifest = await api().library.recover(takeDir);
            await addTakeToProject(manifest, takeDir);
            return { text: `The recorder stopped unexpectedly. Recovered ${fmtTime(manifest.duration)} up to the last checkpoint: ${describeTake(manifest)}.`, tone: 'error' };
          });
          break;
        }
      }
    });
    return off;
  }, [finish]);

  // Leaving this screen must never leave a capture running unattended.
  useEffect(
    () => () => {
      if ((phaseRef.current === 'recording' || phaseRef.current === 'starting') && !finished.current) {
        setRecordingActive(false);
        void api().record.stop().catch(() => {});
        void api().app.recordingMode(false).catch(() => {});
      }
    },
    [],
  );

  // ── start flow ──
  const begin = async () => {
    if (!config || !projectPath) return;
    setStartError(null);
    setBlocking(null);
    setPhase('checking');
    try {
      // Ask for what is enabled and still undecided, nothing else.
      if (wantsScreen && perms.screen === 'undetermined') await request('screen');
      if ((camA || camB) && perms.camera === 'undetermined') await request('camera');
      if (mic && perms.microphone === 'undetermined') await request('microphone');
      const pre = await api().native.preflight(config);
      setPreflight(pre);
      if (!pre.ok) {
        setBlocking(pre.issues);
        setPhase('setup');
        return;
      }
    } catch (e) {
      setStartError(errorText(e));
      setPhase('setup');
      return;
    }
    const seconds = Math.max(0, Math.round(settings?.countdownSeconds ?? 3));
    if (seconds === 0) return void start();
    setCount(seconds);
    setPhase('countdown');
  };

  const start = useCallback(async () => {
    if (!config || !projectPath) return;
    setPhase('starting');
    finished.current = false;
    setLive({ elapsed: 0, paused: false, frames: {}, mic: null, lost: [], diskLow: false, sources: [] });
    try {
      const { takeDir } = await api().record.start(projectPath, config);
      takeDirRef.current = takeDir;
      setRecordingActive(true);
      setPhase('recording');
      await api().app.recordingMode(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setStartError(code === 'permission-denied' ? `${errorText(e)} Check the permissions above, or record with the remaining sources.` : errorText(e));
      setPhase('setup');
      void refresh();
    }
  }, [config, projectPath, refresh]);

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count <= 0) {
      void start();
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, count, start]);

  useEffect(() => {
    if (phase !== 'countdown') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPhase('setup');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const stop = () => void api().record.stop().catch((e) => useApp.getState().toast(errorText(e), 'error'));
  const togglePause = () => void (live.paused ? api().record.resume() : api().record.pause()).catch((e) => useApp.getState().toast(errorText(e), 'error'));

  // ───────────────────────────── render ─────────────────────────────

  if (phase === 'recording' || phase === 'starting' || phase === 'finishing') {
    const ids = live.sources.length ? live.sources : [...Object.keys(live.frames), ...(config?.microphone ? ['microphone'] : []), ...(config?.systemAudio ? ['system'] : [])];
    const openLoss = (id: string) => live.lost.find((l) => l.source === id && l.restored === null);
    return (
      <div className="rec-live" role="status" aria-live="polite">
        <div className="rec-live-card rise">
          <div className="row" style={{ gap: 12, justifyContent: 'center' }}>
            <span className={`rec-dot${live.paused || phase !== 'recording' ? '' : ' live'}`} style={live.paused ? { background: 'var(--ai)', boxShadow: 'none' } : undefined} />
            <span className="eyebrow">{phase === 'starting' ? 'Starting the recorder' : phase === 'finishing' ? 'Adding the take to your project' : live.paused ? 'Paused' : 'Recording'}</span>
          </div>
          <div className="rec-clock mono">{fmtTime(live.elapsed, true)}</div>
          <div className="row wrap" style={{ gap: 6, justifyContent: 'center' }}>
            {ids.map((id) => {
              const lost = openLoss(id);
              return (
                <span key={id} className={`pill ${lost ? 'danger' : 'ok'}`} title={lost ? `Lost at ${fmtTime(lost.elapsed)}: ${lost.reason}` : 'Receiving'}>
                  <Icon name={SOURCE_ICON[id] ?? 'film'} size={11} />
                  {SOURCE_LABEL[id] ?? id}
                  {lost ? ' · lost' : live.frames[id] !== undefined ? <span className="mono"> · {live.frames[id]}f</span> : null}
                </span>
              );
            })}
          </div>
          {config?.microphone ? (
            <div className="row" style={{ gap: 10, width: 280 }}>
              <Icon name="mic" size={14} style={{ color: 'var(--text-3)' }} />
              <Meter db={live.mic} />
            </div>
          ) : null}
          {live.lost.map((l, i) => (
            <Banner key={i} tone={l.restored === null ? 'danger' : 'warn'} title={`${SOURCE_LABEL[l.source] ?? l.source} ${l.restored === null ? 'stopped' : 'dropped out'} at ${fmtTime(l.elapsed)}`}>
              {l.restored === null
                ? `Reason: ${l.reason}. Everything else is still recording, and the footage before this point is safe. The missing stretch will be marked on its track.`
                : `It came back at ${fmtTime(l.restored)}. The gap is marked on its track; the other sources were not interrupted.`}
            </Banner>
          ))}
          {live.diskLow ? (
            <Banner tone="danger" title="The disk is almost full">
              Recording is stopping on its own so the files can be finished properly. Everything captured so far is kept.
            </Banner>
          ) : null}
          {phase === 'recording' ? (
            <div className="row" style={{ gap: 10, justifyContent: 'center', marginTop: 6 }}>
              <Button size="lg" icon={live.paused ? 'record' : 'pause'} onClick={togglePause}>{live.paused ? 'Resume' : 'Pause'}</Button>
              <Button size="lg" variant="primary" icon="stop" onClick={stop}>Stop and open project</Button>
            </div>
          ) : (
            <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
              <span className="spinner" />
              <span className="muted">{phase === 'starting' ? 'Opening devices…' : 'Finishing files…'}</span>
            </div>
          )}
          <div className="tiny dim" style={{ textAlign: 'center' }}>
            A checkpoint is written every two seconds. Each source is its own file inside the project, and nothing is uploaded.
            <br />
            Stop from the floating controller or with <span className="kbd">⌃⌥⌘R</span>.
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'failed' && failure) {
    return (
      <div className="rec-live">
        <div className="rec-live-card rise">
          <Banner tone="danger" title={failure.title}>{failure.detail}</Banner>
          <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
            <Button onClick={() => void backToLibrary()}>Back to library</Button>
            <Button variant="primary" onClick={() => (setFailure(null), setPhase('setup'))}>Set up another take</Button>
          </div>
        </div>
      </div>
    );
  }

  const thumbFor = (kind: 'display' | 'window', id: number) => thumbs.find((t) => t.kind === kind && (t.id === id || (kind === 'display' && t.displayId === id)))?.dataUrl ?? null;
  const stageShot = mode === 'window' ? (win ? thumbFor('window', win.id) : null) : display ? thumbFor('display', display.id) : null;
  const stageAspect = mode === 'window' ? (win ? win.width / Math.max(1, win.height) : null) : display ? display.width / Math.max(1, display.height) : null;
  const minutes = preflight && preflight.estimatedBytesPerMinute > 0 ? Math.floor(preflight.freeBytes / preflight.estimatedBytesPerMinute) : null;
  const cannotStart = !helper
    ? 'The capture helper is not built.'
    : loading
      ? 'Looking for devices…'
      : duplicate
        ? 'Camera A and Camera B use the same device.'
        : sourceCount === 0
          ? 'Turn on at least one source.'
          : !hasPicture
            ? 'Choose a screen or a camera: audio alone is not a video.'
            : mode === 'window' && !win && !screenBlocked
              ? 'Choose a window to record.'
              : null;
  const skipped = [screenBlocked ? 'the screen' : null, cameraBlocked ? `camera ${[camA ? 'A' : null, camB ? 'B' : null].filter(Boolean).join(' and ')}` : null, micBlocked ? 'the microphone' : null].filter(Boolean) as string[];

  return (
    <div className="page record">
      <div className="record-layout">
        <div className="record-main">
          <div className="row between" style={{ alignItems: 'flex-end' }}>
            <div>
              <div className="eyebrow">New recording</div>
              <h1 className="display h2" style={{ margin: '8px 0 0' }}>
                What are we <em>capturing?</em>
              </h1>
            </div>
            <Segmented<Mode>
              label="Capture mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'display', label: 'Display', icon: 'screen' },
                { value: 'window', label: 'Window', icon: 'window' },
                { value: 'region', label: 'Area', icon: 'region' },
                { value: 'none', label: 'Camera only', icon: 'camera' },
              ]}
            />
          </div>

          {loadError ? (
            <Banner tone="danger" title="Devices could not be listed" action={<Button size="sm" onClick={() => (setLoading(true), void refresh())}>Try again</Button>}>
              {loadError}
            </Banner>
          ) : null}
          {!helper ? (
            <Banner tone="warn" title="The capture helper is not built">
              Run <span className="mono">pnpm native:build</span> in the repository, then reopen Cutaway. You can still import footage.
            </Banner>
          ) : null}

          <div className={`stage${mode === 'none' ? ' camera-only' : ''}`}>
            {mode === 'none' ? (
              previewA.stream ? (
                <LiveVideo stream={previewA.stream} />
              ) : (
                <div className="stage-empty">
                  <Icon name="camera" size={30} />
                  <div style={{ fontWeight: 620 }}>{camA ? (cameraBlocked ? 'Camera access is off' : previewA.state === 'loading' ? 'Starting camera…' : 'Preview unavailable for this camera') : 'Camera-only recording'}</div>
                  <div className="muted small">{camA ? 'It will still be recorded if access is allowed.' : 'Choose Camera A on the right.'}</div>
                </div>
              )
            ) : screenBlocked ? (
              <div className="stage-empty" style={{ maxWidth: 520 }}>
                <Icon name="screen" size={30} />
                <div style={{ fontWeight: 620 }}>The screen cannot be recorded yet</div>
                <PermissionNote kind="screen" status={perms.screen} onRequest={() => void request('screen')}>
                  macOS may ask you to reopen Cutaway.
                </PermissionNote>
                <div className="row" style={{ gap: 8 }}>
                  <Button size="sm" icon="camera" onClick={() => setMode('none')}>Record camera only</Button>
                  <Button size="sm" variant="ghost" icon="import" onClick={() => void pickAndImport(false).then((r) => r && (useApp.getState().setView('sources'), useApp.getState().go('project')))}>Import footage instead</Button>
                </div>
              </div>
            ) : loading ? (
              <div className="stage-empty">
                <span className="spinner" />
                <div className="muted">Looking for displays and cameras…</div>
              </div>
            ) : (
              stageShot ? (
                <div className="stage-shot" style={stageAspect ? { aspectRatio: String(stageAspect), ...(stageAspect >= 16 / 9 ? { width: '100%' } : { height: '100%' }) } : { width: '100%', height: '100%' }}>
                  <img src={stageShot} alt="" draggable={false} />
                  {mode === 'region' && display && region ? (
                    <div className="region-veil" aria-hidden>
                      <div className="region-box" style={{ left: `${(region.x / display.width) * 100}%`, top: `${(region.y / display.height) * 100}%`, width: `${(region.width / display.width) * 100}%`, height: `${(region.height / display.height) * 100}%` }}>
                        <span className="mono">{region.width}×{region.height}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="stage-empty"><Icon name={mode === 'window' ? 'window' : 'screen'} size={30} /><div className="muted">{mode === 'window' && !win ? 'Choose a window below' : 'No preview for this source'}</div></div>
              )
            )}
            {mode !== 'none' && camA && !cameraBlocked ? <div className="cam-bubble a">{previewA.stream ? <LiveVideo stream={previewA.stream} /> : <Icon name="camera" size={18} />}<span>A</span></div> : null}
            {camB && !cameraBlocked ? <div className={`cam-bubble b${mode === 'none' ? ' solo' : ''}`}>{previewB.stream ? <LiveVideo stream={previewB.stream} /> : <Icon name="camera" size={18} />}<span>B</span></div> : null}
            <div className="stage-tag mono">
              {mode === 'none' ? 'camera only' : mode === 'window' ? (win ? `${win.app} · ${win.width}×${win.height}` : 'window') : display ? `${display.name} · ${mode === 'region' && region ? `${region.width}×${region.height}` : `${display.width}×${display.height}`} pt${display.scale > 1 ? ` @${display.scale}x` : ''}` : ''}
            </div>
          </div>

          {!screenBlocked && devices && (mode === 'display' || mode === 'region') ? (
            <div className="picker" role="radiogroup" aria-label="Display">
              {devices.displays.map((d) => {
                const shot = thumbFor('display', d.id);
                return (
                  <button key={d.id} className="pick" role="radio" aria-checked={display?.id === d.id} onClick={() => (setDisplayId(d.id), setRegion(null))}>
                    <span className="pick-thumb">{shot ? <img src={shot} alt="" draggable={false} /> : <Icon name="screen" size={18} />}</span>
                    <span className="pick-name">{d.name}</span>
                    <span className="tiny dim mono">{d.width}×{d.height}{d.main ? ' · main' : ''}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {!screenBlocked && devices && mode === 'window' ? (
            devices.windows.length === 0 ? (
              <Banner title="No windows to record">Open the app you want to capture, then <button className="btn sm" style={{ marginLeft: 4 }} onClick={() => void refresh()}>refresh</button></Banner>
            ) : (
              <div className="picker" role="radiogroup" aria-label="Window">
                {devices.windows.map((w) => {
                  const shot = thumbFor('window', w.id);
                  return (
                    <button key={w.id} className="pick" role="radio" aria-checked={win?.id === w.id} onClick={() => setWindowId(w.id)} title={w.title}>
                      <span className="pick-thumb">{shot ? <img src={shot} alt="" draggable={false} /> : <Icon name="window" size={18} />}</span>
                      <span className="pick-name">{w.app}</span>
                      <span className="tiny dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{w.title || 'Untitled window'}</span>
                    </button>
                  );
                })}
              </div>
            )
          ) : null}

          {!screenBlocked && mode === 'region' && display && region ? (
            <div className="region-row">
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" on={region.width === display.width && region.height === display.height} onClick={() => setRegion({ x: 0, y: 0, width: display.width, height: display.height })}>Full display</Button>
                <Button size="sm" disabled={display.width < 1920 || display.height < 1080} on={region.width === 1920 && region.height === 1080 && !(region.width === display.width && region.height === display.height)} onClick={() => setRegion(fitRegion(display, 1920, 1080))} title={display.width < 1920 || display.height < 1080 ? 'This display is smaller than 1920×1080 points' : undefined}>1920×1080</Button>
                <Button size="sm" on={region.width === 1280 && region.height === 720} onClick={() => setRegion(fitRegion(display, 1280, 720))}>1280×720</Button>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <NumberField label="X" value={region.x} onChange={(x) => setRegion({ ...region, x: Math.min(x, display.width - region.width) })} />
                <NumberField label="Y" value={region.y} onChange={(y) => setRegion({ ...region, y: Math.min(y, display.height - region.height) })} />
                <NumberField label="W" min={160} value={region.width} onChange={(width) => setRegion({ ...region, width: Math.min(width, display.width - region.x) })} />
                <NumberField label="H" min={90} value={region.height} onChange={(height) => setRegion({ ...region, height: Math.min(height, display.height - region.y) })} />
              </div>
            </div>
          ) : null}
        </div>

        <aside className="record-rail">
          <Section icon="camera" title="Camera A" off={!camA}>
            <select className="select" value={camA ?? ''} aria-label="Camera A" onChange={(e) => (setCamA(e.target.value || null), e.target.value && perms.camera === 'undetermined' ? void request('camera') : undefined)}>
              <option value="">Off</option>
              {devices?.cameras.map((c) => (
                <option key={c.id} value={c.id} disabled={c.id === camB}>{c.name}{c.id === camB ? ' (used by Camera B)' : ''}</option>
              ))}
            </select>
            {cameraA && !cameraBlocked ? <span className="tiny dim mono">{(() => { const f = pickFormat(cameraA); return `${f.width}×${f.height} · ${f.fps} fps · own track`; })()}</span> : null}
          </Section>

          <Section icon="camera" title="Camera B" off={!camB}>
            <select className="select" value={camB ?? ''} aria-label="Camera B" disabled={!devices || devices.cameras.length === 0} onChange={(e) => (setCamB(e.target.value || null), e.target.value && perms.camera === 'undetermined' ? void request('camera') : undefined)}>
              <option value="">Off</option>
              {devices?.cameras.map((c) => (
                <option key={c.id} value={c.id} disabled={c.id === camA}>{c.name}{c.id === camA ? ' (used by Camera A)' : ''}</option>
              ))}
            </select>
            {devices && devices.cameras.length < 2 ? (
              <span className="tiny dim">{devices.cameras.length === 0 ? 'No camera is connected.' : 'Only one camera is connected. A camera cannot fill both slots; connect a second one or import its file later.'}</span>
            ) : cameraB && !cameraBlocked ? (
              <span className="tiny dim mono">{(() => { const f = pickFormat(cameraB); return `${f.width}×${f.height} · ${f.fps} fps · shared clock with A`; })()}</span>
            ) : null}
            {duplicate ? <span className="tiny" style={{ color: 'var(--danger)' }}>The same device cannot be both cameras.</span> : null}
          </Section>
          {(camA || camB) && perms.camera !== 'granted' ? (
            <PermissionNote kind="camera" status={perms.camera} onRequest={() => void request('camera')}>
              <button className="link-btn" onClick={() => (setCamA(null), setCamB(null))}>Record without a camera</button>
            </PermissionNote>
          ) : null}

          <Section icon="mic" title="Microphone" off={!mic}>
            <select className="select" value={mic ?? ''} aria-label="Microphone" onChange={(e) => (setMic(e.target.value || null), e.target.value && perms.microphone === 'undetermined' ? void request('microphone') : undefined)}>
              <option value="">Off</option>
              {devices?.microphones.map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.default ? ' (system default)' : ''}</option>
              ))}
            </select>
            {mic && !micBlocked ? (
              <div className="row" style={{ gap: 8 }}>
                <Meter db={micDb} />
                <span className="tiny mono dim" style={{ width: 44, textAlign: 'right' }}>{micDb === null ? '—' : `${micDb.toFixed(0)} dB`}</span>
              </div>
            ) : null}
          </Section>
          {mic && perms.microphone !== 'granted' ? (
            <PermissionNote kind="microphone" status={perms.microphone} onRequest={() => void request('microphone')}>
              <button className="link-btn" onClick={() => setMic(null)}>Record without a microphone</button>
            </PermissionNote>
          ) : null}

          <Section icon="speaker" title="System audio" off={!systemAudio}>
            <Toggle checked={systemAudio && perms.screen === 'granted'} onChange={(v) => (perms.screen === 'granted' ? setSystemAudio(v) : void request('screen'))} label="Record what the Mac plays" hint={perms.screen === 'granted' ? 'Kept as its own track, separate from your voice.' : 'Needs Screen Recording access.'} />
          </Section>

          <Section icon="gear" title="Capture">
            <div className="row between">
              <span className="small muted">Frame rate</span>
              <Segmented<'30' | '60'> label="Frame rate" value={String(fps) as '30' | '60'} onChange={(v) => setFps(Number(v) as 30 | 60)} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
            </div>
            <div className="row between">
              <span className="small muted">Cursor</span>
              <Segmented<'clean' | 'baked'> label="Cursor" value={cursor} onChange={setCursor} options={[{ value: 'clean', label: 'Clean', icon: 'cursor', disabled: mode === 'none' }, { value: 'baked', label: 'Baked in', disabled: mode === 'none' }]} />
            </div>
            <span className="tiny dim">{mode === 'none' ? 'No screen in this take, so there is no cursor to record.' : cursor === 'clean' ? 'Clean cursor: recorded separately so it can be smoothed and resized later.' : 'Baked in: the cursor is part of the picture and cannot be restyled afterwards.'}</span>
          </Section>
        </aside>
      </div>

      <footer className="record-bar">
        <div className="col grow" style={{ gap: 4 }}>
          {blocking ? (
            <div className="col" style={{ gap: 6 }}>
              {blocking.map((issue, i) => (
                <Banner key={i} tone="danger" title={`${issue.source ? `${SOURCE_LABEL[issue.source] ?? issue.source}: ` : ''}${issue.message}`}>
                  {issue.alternatives?.length ? <>Supported instead: <span className="mono">{issue.alternatives.join(' · ')}</span>. Nothing was changed for you.</> : issue.code === 'low-disk' ? 'Free some space, or choose fewer sources.' : issue.code === 'permission-denied' ? 'Allow access above, or turn that source off.' : 'Adjust the setup above and try again.'}
                </Banner>
              ))}
            </div>
          ) : startError ? (
            <Banner tone="danger" title="Recording did not start">{startError}</Banner>
          ) : (
            <>
              <div className="row wrap" style={{ gap: 6 }}>
                {config?.screen ? <span className="pill"><Icon name={mode === 'window' ? 'window' : mode === 'region' ? 'region' : 'screen'} size={11} /> {mode === 'window' ? 'Window' : mode === 'region' ? 'Area' : 'Display'}</span> : null}
                {config?.cameras.map((c) => <span key={c.slot} className="pill"><Icon name="camera" size={11} /> Camera {c.slot}</span>)}
                {config?.microphone ? <span className="pill"><Icon name="mic" size={11} /> Microphone</span> : null}
                {config?.systemAudio ? <span className="pill"><Icon name="speaker" size={11} /> System audio</span> : null}
                {cannotStart && !loading ? <span className="pill warn"><Icon name="warn" size={11} /> {cannotStart}</span> : null}
                {skipped.length ? <span className="pill warn"><Icon name="warn" size={11} /> Without {skipped.join(', ')} (no access)</span> : null}
              </div>
              <span className="tiny dim">
                {sourceCount > 0 ? `${sourceCount} independent track${sourceCount === 1 ? '' : 's'} on one shared clock. ` : ''}
                {preflight && minutes !== null ? `About ${minutes >= 600 ? 'ten hours or more' : minutes >= 120 ? `${Math.floor(minutes / 60)} hours` : `${minutes} minutes`} of room (${fmtBytes(preflight.estimatedBytesPerMinute)} per minute, ${fmtBytes(preflight.freeBytes)} free).` : ''}
              </span>
            </>
          )}
        </div>
        <Button size="lg" variant="ghost" icon="import" onClick={() => (useApp.getState().setView('sources'), useApp.getState().go('project'))} title="Skip recording and bring in files you already have">Import instead</Button>
        <Button size="lg" variant="ghost" onClick={() => void backToLibrary()}>Cancel</Button>
        <Button size="lg" variant="primary" icon="record" disabled={!!cannotStart} busy={phase === 'checking'} onClick={() => void begin()} title={cannotStart ?? 'Start after a short countdown'}>
          Start recording
        </Button>
      </footer>

      {phase === 'countdown' ? (
        <div className="countdown" role="alertdialog" aria-label="Recording starts soon">
          <div key={count} className="countdown-num display">{count}</div>
          <div className="muted">Recording starts when this reaches zero.</div>
          <Button size="lg" onClick={() => setPhase('setup')}>Cancel <span className="kbd" style={{ marginLeft: 6 }}>esc</span></Button>
        </div>
      ) : null}
    </div>
  );
}
