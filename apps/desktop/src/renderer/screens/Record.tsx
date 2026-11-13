import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtTime } from '@cutaway/core';
import type { CameraInfo, DeviceList, DisplayInfo, ExtraPermission, Permission, PermissionKind, PreflightResult, RecordConfig, RecordEvent } from '@shared/api';
import { useApp } from '../state/store';
import { backToLibrary, errorText, pickAndImport, setRecordingActive } from '../state/actions';
import { addTakeToProject, describeTake } from '../state/recording';
import { Icon, type IconName } from '../ui/icons';
import { Banner, Button, Meter, Segmented, Toggle, fmtBytes } from '../ui/kit';
import './Notes';
import './record.css';

type Mode = 'display' | 'window' | 'region' | 'device' | 'none';
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

function PermissionNote({ kind, status, onRequest, children }: { kind: PermissionKind; status: Permission; onRequest: () => void; children?: ReactNode }) {
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
        <div style={{ fontWeight: 600, color: 'var(--text)' }}>{PERMISSION_NAME[kind]} access is off for Cutaway</div>
        <div>
          Turn it on in System Settings → Privacy &amp; Security → {PERMISSION_NAME[kind]}, then come back. {children}
        </div>
      </div>
      <Button size="sm" icon="external" onClick={() => void api().app.openPrivacySettings(kind)}>Open settings</Button>
    </div>
  );
}

/** A pill in the recorder bar that opens a menu above it. */
function PillMenu({ icon, label, title, off, level, width = 280, align = 'center', testId, children }: { icon: IconName; label?: string; title: string; off?: boolean; level?: number | null; width?: number; align?: 'center' | 'right'; testId?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="rb-wrap">
      <button className={`rb-pill${off ? ' off' : ''}${open ? ' open' : ''}${label ? '' : ' icon-only'}`} aria-haspopup="menu" aria-expanded={open} title={title} aria-label={title} data-testid={testId} onClick={() => setOpen(!open)}>
        <Icon name={icon} size={15} />
        {label ? <span className="rb-pill-label">{label}</span> : null}
        <Icon name="chevronDown" size={12} style={{ color: 'var(--text-3)' }} />
        {level !== undefined ? (
          <i className="rb-level" aria-hidden>
            <b style={{ width: `${level === null ? 0 : Math.max(0, Math.min(1, (level + 60) / 60)) * 100}%` }} />
          </i>
        ) : null}
      </button>
      {open ? (
        <>
          <div className="rb-veil" onMouseDown={close} />
          <div className="menu rb-pop" role="menu" style={align === 'right' ? { width, right: 0 } : { width, left: '50%', marginLeft: -width / 2 }}>
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

function MenuRow({ checked, onClick, disabled, children, note, icon }: { checked?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode; note?: string; icon?: IconName }) {
  return (
    <button role="menuitemradio" aria-checked={!!checked} disabled={disabled} onClick={onClick} style={disabled ? { opacity: 0.4 } : undefined}>
      {icon ? <Icon name={icon} size={13} /> : null}
      <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
      {note ? <span className="tiny dim">{note}</span> : null}
      {checked ? <Icon name="check" size={13} style={{ color: 'var(--accent-2)' }} /> : null}
    </button>
  );
}

function NumberField({ label, value, onChange, min = 0 }: { label: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <label className="num-field">
      <span>{label}</span>
      <input className="input mono" type="number" min={min} step={2} value={Math.round(value)} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))} aria-label={label} />
    </label>
  );
}

function fitRegion(d: DisplayInfo, w: number, h: number): Region {
  const width = Math.min(w, d.width);
  const height = Math.min(h, d.height);
  return { x: Math.round((d.width - width) / 2), y: Math.round((d.height - height) / 2), width, height };
}

const short = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// ───────────────────────────── remembered options ─────────────────────────────

interface Prefs {
  fps: 30 | 60;
  cursor: 'clean' | 'baked';
  hideIcons: boolean;
  hideNotifs: boolean;
  captureKeys: boolean;
}
const PREFS_KEY = 'cutaway.recorder';
const NOTES_OPEN_KEY = 'cutaway.notes.open';

function loadPrefs(): Prefs {
  const d: Prefs = { fps: 60, cursor: 'clean', hideIcons: false, hideNotifs: false, captureKeys: false };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { fps: p.fps === 30 ? 30 : 60, cursor: p.cursor === 'baked' ? 'baked' : 'clean', hideIcons: !!p.hideIcons, hideNotifs: !!p.hideNotifs, captureKeys: !!p.captureKeys };
  } catch {
    return d;
  }
}

const WINDOW_SIZES: [number, number][] = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
];
const COUNTDOWNS = [0, 3, 5, 10];
const MODES: { value: Mode; label: string; icon: IconName }[] = [
  { value: 'display', label: 'Display', icon: 'screen' },
  { value: 'window', label: 'Window', icon: 'window' },
  { value: 'region', label: 'Area', icon: 'region' },
  { value: 'device', label: 'Device', icon: 'phone' },
  { value: 'none', label: 'Camera', icon: 'camera' },
];

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
  const [extId, setExtId] = useState<string | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [camA, setCamA] = useState<string | null>(null);
  const [camB, setCamB] = useState<string | null>(null);
  const [mic, setMic] = useState<string | null>(null);
  const [audioMode, setAudioMode] = useState<'off' | 'all' | 'apps'>('off');
  const [audioApps, setAudioApps] = useState<string[]>([]);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [notesOpen, setNotesOpen] = useState(() => localStorage.getItem(NOTES_OPEN_KEY) === '1');
  const [resizeNote, setResizeNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [resizing, setResizing] = useState(false);
  const initialised = useRef(false);
  const { fps, cursor } = prefs;
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* preferences are a convenience */
      }
      return next;
    });

  const [phase, setPhase] = useState<Phase>('setup');
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [blocking, setBlocking] = useState<PreflightResult['issues'] | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [live, setLive] = useState<{ elapsed: number; paused: boolean; frames: Record<string, number>; mic: number | null; lost: { source: string; elapsed: number; reason: string; restored: number | null }[]; diskLow: boolean; sources: string[]; warnings: string[] }>({ elapsed: 0, paused: false, frames: {}, mic: null, lost: [], diskLow: false, sources: [], warnings: [] });
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

  // ── speaker notes window (kept out of the recording by the app) ──
  const toggleNotes = useCallback((on: boolean) => {
    setNotesOpen(on);
    try {
      localStorage.setItem(NOTES_OPEN_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    void api().app.notesWindow(on).catch((e) => useApp.getState().toast(`Speaker notes could not be opened: ${errorText(e)}`, 'error'));
  }, []);
  useEffect(() => {
    if (localStorage.getItem(NOTES_OPEN_KEY) === '1') void api().app.notesWindow(true).catch(() => {});
    // the notes window closing itself updates this flag
    const onStorage = (e: StorageEvent) => e.key === NOTES_OPEN_KEY && setNotesOpen(e.newValue === '1');
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      void api().app.notesWindow(false).catch(() => {});
    };
  }, []);

  const display = devices?.displays.find((d) => d.id === displayId) ?? devices?.displays[0] ?? null;
  // Cutaway's own windows are left out of every capture, so they are not offered as targets.
  const windows = useMemo(() => (devices?.windows ?? []).filter((w) => w.bundleId !== 'studio.cutaway.app' && w.bundleId !== 'com.github.Electron'), [devices]);
  const win = windows.find((w) => w.id === windowId) ?? null;
  const externals = devices?.externalDevices ?? [];
  const ext = externals.find((d) => d.id === extId) ?? null;
  // One row per app; Cutaway itself is never a useful sound source for its own recording.
  const apps = useMemo(() => {
    const seen = new Set<string>();
    return (devices?.apps ?? []).filter((a) => a.bundleId !== 'studio.cutaway.app' && a.bundleId !== 'com.github.Electron' && !seen.has(a.bundleId) && !!seen.add(a.bundleId));
  }, [devices]);
  const cameraA = devices?.cameras.find((c) => c.id === camA) ?? null;
  const cameraB = devices?.cameras.find((c) => c.id === camB) ?? null;
  const microphone = devices?.microphones.find((m) => m.id === mic) ?? null;
  const extra = (k: ExtraPermission): Permission | null => devices?.permissions[k] ?? null;

  useEffect(() => {
    // Default to a 16:9 area that is visibly smaller than the display.
    if (mode === 'region' && display && !region) setRegion(display.width > 1920 && display.height > 1080 ? fitRegion(display, 1920, 1080) : fitRegion(display, 1280, 720));
  }, [mode, display, region]);
  useEffect(() => {
    if (mode === 'device' && !ext && externals[0]) setExtId(externals[0].id);
  }, [mode, ext, externals]);
  useEffect(() => setResizeNote(null), [windowId, mode]);

  const onMac = mode === 'display' || mode === 'window' || mode === 'region';
  const wantsScreen = mode !== 'none';
  const screenBlocked = onMac && perms.screen !== 'granted';
  const cameraBlocked = (!!camA || !!camB) && perms.camera !== 'granted';
  const micBlocked = !!mic && perms.microphone !== 'granted';
  const screenReady = wantsScreen && !screenBlocked && (mode === 'window' ? !!win : mode === 'device' ? !!ext : !!display);
  const previewsOn = phase === 'setup' || phase === 'checking';
  const systemAudioOn = audioMode === 'all' || (audioMode === 'apps' && audioApps.length > 0);

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
    if (screenReady) {
      const showCursor = cursor === 'baked';
      const hide = { hideDesktopIcons: prefs.hideIcons || undefined, hideNotifications: prefs.hideNotifs || undefined };
      if (mode === 'display' && display) screen = { type: 'display', displayId: display.id, showCursor, ...hide };
      else if (mode === 'window' && win) screen = { type: 'window', windowId: win.id, showCursor };
      else if (mode === 'region' && region && display) screen = { type: 'region', displayId: display.id, rect: { x: display.x + region.x, y: display.y + region.y, width: region.width, height: region.height }, showCursor, ...hide };
      else if (mode === 'device' && ext) screen = { type: 'device', deviceId: ext.id, showCursor: true };
    }
    const audioAllowed = perms.screen === 'granted';
    const systemAudio: RecordConfig['systemAudio'] = !audioAllowed || audioMode === 'off' ? false : audioMode === 'all' ? true : audioApps.length ? { apps: audioApps } : false;
    return {
      fps,
      screen,
      cameras,
      microphone: microphone && !micBlocked ? { deviceId: microphone.id } : null,
      systemAudio,
      // Shortcuts and typing ticks only; meaningless without a Mac screen in the take.
      ...(prefs.captureKeys && screen && screen.type !== 'device' ? { captureKeys: true } : {}),
    };
  }, [devices, cameraA, cameraB, cameraBlocked, screenReady, display, win, ext, region, mode, cursor, fps, microphone, micBlocked, audioMode, audioApps, perms.screen, prefs.hideIcons, prefs.hideNotifs, prefs.captureKeys]);

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
        case 'error':
          // Non-fatal: the take continues (e.g. keyboard data unavailable, microphone silent).
          if (!e.fatal) setLive((l) => (l.warnings.includes(e.message) ? l : { ...l, warnings: [...l.warnings, e.code === 'keys-unavailable' ? 'Keyboard shortcuts are not being recorded: Input Monitoring is not allowed for Cutaway. Everything else is recording.' : e.message] }));
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
      if (onMac && perms.screen === 'undetermined') await request('screen');
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
    setLive({ elapsed: 0, paused: false, frames: {}, mic: null, lost: [], diskLow: false, sources: [], warnings: [] });
    try {
      const { takeDir } = await api().record.start(projectPath, config);
      takeDirRef.current = takeDir;
      setRecordingActive(true);
      setPhase('recording');
      await api().app.recordingMode(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setStartError(code === 'permission-denied' ? `${errorText(e)} Check the permissions, or record with the remaining sources.` : errorText(e));
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

  const resizeTo = async (w: number, h: number) => {
    if (!win) return;
    setResizing(true);
    setResizeNote(null);
    try {
      await api().native.resizeWindow(win.id, w, h);
      await refresh();
      setResizeNote({ tone: 'info', text: `${win.app} was resized to ${w} × ${h}.` });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setResizeNote(
        code === 'permission-denied'
          ? { tone: 'warn', text: 'Resizing another app’s window needs Accessibility access. Turn Cutaway on in System Settings → Privacy & Security → Accessibility, then try again. Nothing was changed.' }
          : { tone: 'warn', text: `The window could not be resized: ${errorText(e)}` },
      );
    } finally {
      setResizing(false);
    }
  };

  const setCountdown = async (seconds: number) => {
    try {
      useApp.getState().setSettings(await api().app.setSettings({ countdownSeconds: seconds }));
    } catch (e) {
      useApp.getState().toast(errorText(e), 'error');
    }
  };

  // ───────────────────────────── render ─────────────────────────────

  if (phase === 'recording' || phase === 'starting' || phase === 'finishing') {
    const ids = live.sources.length ? live.sources : [...Object.keys(live.frames), ...(config?.microphone ? ['microphone'] : []), ...(config?.systemAudio ? ['system'] : [])];
    const openLoss = (id: string) => live.lost.find((l) => l.source === id && l.restored === null);
    return (
      <div className="rec-live" role="status" aria-live="polite">
        <div className="rec-live-card rise">
          <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
            <span className={`rec-dot${live.paused || phase !== 'recording' ? '' : ' live'}`} style={live.paused ? { background: 'var(--text-3)', boxShadow: 'none' } : undefined} />
            <span className="rec-state">{phase === 'starting' ? 'Starting the recorder' : phase === 'finishing' ? 'Adding the take to your project' : live.paused ? 'Paused' : 'Recording'}</span>
          </div>
          <div className="rec-clock mono">{fmtTime(live.elapsed, true)}</div>
          <div className="row wrap" style={{ gap: 6, justifyContent: 'center' }}>
            {ids.map((id) => {
              const lost = openLoss(id);
              return (
                <span key={id} className={`pill ${lost ? 'danger' : ''}`} title={lost ? `Lost at ${fmtTime(lost.elapsed)}: ${lost.reason}` : 'Receiving'}>
                  <Icon name={SOURCE_ICON[id] ?? 'film'} size={11} />
                  {SOURCE_LABEL[id] ?? id}
                  {lost ? ' · lost' : live.frames[id] !== undefined ? <span className="mono dim"> · {live.frames[id]}f</span> : null}
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
          {live.warnings.map((w) => (
            <Banner key={w} tone="warn" title="Still recording">{w}</Banner>
          ))}
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
              <button className="btn lg rec-stop" onClick={stop}>
                <Icon name="stop" size={17} /> Stop recording
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: 10, justifyContent: 'center' }}>
              <span className="spinner" />
              <span className="muted">{phase === 'starting' ? 'Opening devices…' : 'Finishing files…'}</span>
            </div>
          )}
          <div className="tiny dim" style={{ textAlign: 'center' }}>
            Saved to disk every 2 seconds. Each source is its own file in the project. Nothing is uploaded.
            <br />
            Stop from the floating control or with <span className="kbd">⌃⌥⌘R</span>.
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
            <Button onClick={() => void backToLibrary()}>Back to projects</Button>
            <Button variant="primary" onClick={() => (setFailure(null), setPhase('setup'))}>Set up another take</Button>
          </div>
        </div>
      </div>
    );
  }

  const thumbFor = (kind: 'display' | 'window', id: number) => thumbs.find((t) => t.kind === kind && (t.id === id || (kind === 'display' && t.displayId === id)))?.dataUrl ?? null;
  const stageShot = mode === 'window' ? (win ? thumbFor('window', win.id) : null) : onMac && display ? thumbFor('display', display.id) : null;
  const stageAspect = mode === 'window' ? (win ? win.width / Math.max(1, win.height) : null) : mode === 'device' ? (ext ? ext.width / Math.max(1, ext.height) : null) : display ? display.width / Math.max(1, display.height) : null;
  const minutes = preflight && preflight.estimatedBytesPerMinute > 0 ? Math.floor(preflight.freeBytes / preflight.estimatedBytesPerMinute) : null;
  const cannotStart = !helper
    ? 'The capture helper is not built.'
    : loading
      ? 'Looking for devices…'
      : duplicate
        ? 'Camera A and Camera B use the same device.'
        : mode === 'window' && !win && !screenBlocked
          ? 'Choose a window to record.'
          : mode === 'device' && !ext
            ? 'Connect an iPhone or iPad to record it.'
            : sourceCount === 0
              ? 'Turn on at least one source.'
              : !hasPicture
                ? 'Choose a screen or a camera. Audio alone is not a video.'
                : null;
  const skipped = [screenBlocked ? 'the screen' : null, cameraBlocked ? `camera ${[camA ? 'A' : null, camB ? 'B' : null].filter(Boolean).join(' and ')}` : null, micBlocked ? 'the microphone' : null].filter(Boolean) as string[];
  const countdown = Math.max(0, Math.round(settings?.countdownSeconds ?? 3));
  const keysPerm = extra('inputMonitoring');
  const parts = [
    config?.screen ? (mode === 'window' ? 'Window' : mode === 'region' ? 'Area' : mode === 'device' ? 'Device' : 'Display') : null,
    ...(config?.cameras.map((c) => `Camera ${c.slot}`) ?? []),
    config?.microphone ? 'Microphone' : null,
    config?.systemAudio ? (typeof config.systemAudio === 'object' ? `Sound from ${config.systemAudio.apps.length} app${config.systemAudio.apps.length === 1 ? '' : 's'}` : 'System audio') : null,
  ].filter(Boolean) as string[];
  const targetName = mode === 'window' ? (win ? win.app : 'No window chosen') : mode === 'device' ? (ext ? ext.name : 'No device') : mode === 'none' ? (cameraA?.name ?? cameraB?.name ?? 'Camera') : (display?.name ?? 'Display');
  const targetDims = mode === 'window' ? (win ? `${win.width} × ${win.height}` : null) : mode === 'region' ? (region ? `${region.width} × ${region.height}` : null) : mode === 'device' ? (ext ? `${ext.width} × ${ext.height}` : null) : mode === 'none' ? null : display ? `${display.width} × ${display.height}` : null;

  const startButton = (
    <button className="btn primary lg rec-start" disabled={!!cannotStart || phase === 'checking'} onClick={() => void begin()} title={cannotStart ?? (countdown ? `Starts after a ${countdown} second countdown` : 'Starts immediately')} data-testid="start-recording">
      {phase === 'checking' ? <span className="spinner" /> : <span className="rec-dot" style={{ background: '#fff', boxShadow: 'none' }} />}
      Start recording
    </button>
  );

  const target = (
    <div className={`target${mode === 'none' ? ' compact' : ''}`}>
      {mode !== 'none' ? (
        <span className="target-icon">
          <Icon name={mode === 'window' ? 'window' : mode === 'device' ? 'phone' : mode === 'region' ? 'region' : 'screen'} size={22} />
        </span>
      ) : null}
      <div className="target-name">{targetName}</div>
      {targetDims ? (
        <div className="row" style={{ gap: 8 }}>
          <span className="target-dims mono">{targetDims}</span>
          {mode === 'window' && win ? (
            <PillMenu icon="width" label="Resize" title="Resize this window to a standard size" width={230} testId="resize-menu">
              {(close) => (
                <>
                  {WINDOW_SIZES.map(([w, h]) => (
                    <MenuRow key={w} checked={win.width === w && win.height === h} disabled={resizing} onClick={() => (close(), void resizeTo(w, h))} note={w / h > 1.7 ? '16:9' : '16:10'}>
                      {w} × {h}
                    </MenuRow>
                  ))}
                  <div className="sep" />
                  <div className="tiny dim" style={{ padding: '4px 10px 6px' }}>Moves and resizes the real window. Needs Accessibility access.</div>
                </>
              )}
            </PillMenu>
          ) : null}
        </div>
      ) : null}
      {startButton}
      <div className="tiny target-note">{cannotStart && !loading ? cannotStart : parts.length ? parts.join(' · ') : ''}</div>
    </div>
  );

  return (
    <div className="page record">
      <div className="rec-alerts">
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
      </div>

      <div className={`rec-stage${mode === 'none' ? ' camera-only' : ''}`}>
        {mode === 'none' ? (
          previewA.stream ? (
            <LiveVideo stream={previewA.stream} />
          ) : (
            <div className="stage-empty">
              <Icon name="camera" size={30} />
              <div className="stage-title">{camA ? (cameraBlocked ? 'Camera access is off' : previewA.state === 'loading' ? 'Starting camera…' : 'No preview for this camera') : 'Camera only'}</div>
              <div className="muted small">{camA ? 'It is still recorded if access is allowed.' : 'Choose Camera A in the bar below.'}</div>
            </div>
          )
        ) : screenBlocked ? (
          <div className="stage-empty" style={{ maxWidth: 520 }}>
            <Icon name="screen" size={30} />
            <div className="stage-title">The screen cannot be recorded yet</div>
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
        ) : mode === 'device' && !ext ? (
          <div className="stage-empty" style={{ maxWidth: 460 }}>
            <Icon name="phone" size={30} />
            <div className="stage-title">No iPhone or iPad connected</div>
            <div className="muted small">Connect it with a cable, unlock it, and tap Trust on the device. It appears here a few seconds later. Touches are not recorded as cursor data, so automatic zooms are not available for device takes.</div>
            <Button size="sm" icon="sync" onClick={() => (setLoading(true), void refresh())}>Look again</Button>
          </div>
        ) : (
          <div className="stage-shot" style={stageAspect ? { aspectRatio: String(stageAspect), ...(stageAspect >= 16 / 9 ? { width: '100%' } : { height: '100%' }) } : { width: '100%', height: '100%' }}>
            {stageShot ? <img src={stageShot} alt="" draggable={false} /> : <div className={`stage-blank${mode === 'device' ? ' device' : ''}`} />}
            {mode === 'region' && display && region ? (
              <div className="region-veil" aria-hidden>
                <div className="region-box" style={{ left: `${(region.x / display.width) * 100}%`, top: `${(region.y / display.height) * 100}%`, width: `${(region.width / display.width) * 100}%`, height: `${(region.height / display.height) * 100}%` }} />
              </div>
            ) : (
              <div className="stage-tint" aria-hidden />
            )}
          </div>
        )}
        {!(onMac && screenBlocked) && !loading && !(mode === 'device' && !ext) ? target : null}
        {mode !== 'none' && camA && !cameraBlocked ? <div className="cam-bubble a">{previewA.stream ? <LiveVideo stream={previewA.stream} /> : <Icon name="camera" size={18} />}<span>A</span></div> : null}
        {camB && !cameraBlocked ? <div className={`cam-bubble b${mode === 'none' ? ' solo' : ''}`}>{previewB.stream ? <LiveVideo stream={previewB.stream} /> : <Icon name="camera" size={18} />}<span>B</span></div> : null}
      </div>

      <div className="rec-strip">
        {!screenBlocked && devices && (mode === 'display' || mode === 'region') && devices.displays.length > 1 ? (
          <div className="picker" role="radiogroup" aria-label="Display">
            {devices.displays.map((d) => {
              const shot = thumbFor('display', d.id);
              return (
                <button key={d.id} className="pick" role="radio" aria-checked={display?.id === d.id} onClick={() => (setDisplayId(d.id), setRegion(null))}>
                  <span className="pick-thumb">{shot ? <img src={shot} alt="" draggable={false} /> : <Icon name="screen" size={18} />}</span>
                  <span className="pick-name">{d.name}</span>
                  <span className="tiny dim mono">{d.width} × {d.height}{d.main ? ' · main' : ''}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {!screenBlocked && devices && mode === 'window' ? (
          windows.length === 0 ? (
            <div className="perm-note">
              <Icon name="window" size={14} />
              <span className="grow">No windows to record. Open the app you want to capture.</span>
              <Button size="sm" onClick={() => void refresh()}>Look again</Button>
            </div>
          ) : (
            <div className="picker" role="radiogroup" aria-label="Window">
              {windows.map((w) => {
                const shot = thumbFor('window', w.id);
                return (
                  <button key={w.id} className="pick" role="radio" aria-checked={win?.id === w.id} onClick={() => setWindowId(w.id)} title={w.title}>
                    <span className="pick-thumb">{shot ? <img src={shot} alt="" draggable={false} /> : <Icon name="window" size={18} />}</span>
                    <span className="pick-name">{w.app}</span>
                    <span className="tiny dim pick-sub">{w.title || 'Untitled window'}</span>
                  </button>
                );
              })}
            </div>
          )
        ) : null}

        {mode === 'device' && externals.length > 0 ? (
          <div className="picker" role="radiogroup" aria-label="Device">
            {externals.map((d) => (
              <button key={d.id} className="pick" role="radio" aria-checked={ext?.id === d.id} onClick={() => setExtId(d.id)}>
                <span className="pick-thumb"><Icon name="phone" size={20} /></span>
                <span className="pick-name">{d.name}</span>
                <span className="tiny dim mono">{d.width} × {d.height}</span>
              </button>
            ))}
          </div>
        ) : null}

        {!screenBlocked && mode === 'region' && display && region ? (
          <div className="region-row">
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" on={region.width === display.width && region.height === display.height} onClick={() => setRegion({ x: 0, y: 0, width: display.width, height: display.height })}>Full display</Button>
              <Button size="sm" disabled={display.width < 1920 || display.height < 1080} on={region.width === 1920 && region.height === 1080 && !(region.width === display.width && region.height === display.height)} onClick={() => setRegion(fitRegion(display, 1920, 1080))} title={display.width < 1920 || display.height < 1080 ? 'This display is smaller than 1920 × 1080 points' : undefined}>1920 × 1080</Button>
              <Button size="sm" on={region.width === 1280 && region.height === 720} onClick={() => setRegion(fitRegion(display, 1280, 720))}>1280 × 720</Button>
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

      <div className="rec-alerts">
        {(camA || camB) && perms.camera !== 'granted' ? (
          <PermissionNote kind="camera" status={perms.camera} onRequest={() => void request('camera')}>
            <button className="link-btn" onClick={() => (setCamA(null), setCamB(null))}>Record without a camera</button>
          </PermissionNote>
        ) : null}
        {mic && perms.microphone !== 'granted' ? (
          <PermissionNote kind="microphone" status={perms.microphone} onRequest={() => void request('microphone')}>
            <button className="link-btn" onClick={() => setMic(null)}>Record without a microphone</button>
          </PermissionNote>
        ) : null}
        {duplicate ? <div className="perm-note denied" role="alert"><Icon name="warn" size={14} /><span className="grow">The same device cannot be both cameras. Choose a different camera for B, or turn it off.</span></div> : null}
        {resizeNote ? (
          <div className={`perm-note${resizeNote.tone === 'warn' ? ' denied' : ''}`} role="status">
            <Icon name={resizeNote.tone === 'warn' ? 'warn' : 'check'} size={14} />
            <span className="grow">{resizeNote.text}</span>
            <Button size="sm" variant="ghost" icon="x" aria-label="Dismiss" onClick={() => setResizeNote(null)} />
          </div>
        ) : null}
        {blocking
          ? blocking.map((issue, i) => (
              <Banner key={i} tone="danger" title={`${issue.source ? `${SOURCE_LABEL[issue.source] ?? issue.source}: ` : ''}${issue.message}`}>
                {issue.alternatives?.length ? <>Supported instead: <span className="mono">{issue.alternatives.join(' · ')}</span>. Nothing was changed for you.</> : issue.code === 'low-disk' ? 'Free some space, or choose fewer sources.' : issue.code === 'permission-denied' ? 'Allow access, or turn that source off.' : 'Adjust the setup and try again.'}
              </Banner>
            ))
          : null}
        {startError ? <Banner tone="danger" title="Recording did not start">{startError}</Banner> : null}
      </div>

      <div className="rec-bar" role="toolbar" aria-label="Recorder">
        <button className="rb-close" onClick={() => void backToLibrary()} title="Close the recorder" aria-label="Close the recorder">
          <Icon name="x" size={13} />
        </button>
        <div className="rb-modes" role="group" aria-label="What to record">
          {MODES.map((m) => (
            <button key={m.value} className="rb-mode" data-mode={m.value} aria-pressed={mode === m.value} onClick={() => setMode(m.value)} title={m.value === 'none' ? 'Camera only, no screen' : m.value === 'device' ? 'A connected iPhone or iPad' : `Record ${m.label === 'Area' ? 'an area' : `a ${m.label.toLowerCase()}`}`}>
              <Icon name={m.icon} size={18} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        <span className="rb-sep" />

        <PillMenu icon="camera" label={cameraA ? short(cameraA.name) : 'No camera'} off={!cameraA} title="Camera A" testId="camera-a">
          {(close) => (
            <>
              <div className="rb-head">Camera A</div>
              <MenuRow checked={!camA} onClick={() => (setCamA(null), close())}>Don’t record camera</MenuRow>
              {devices?.cameras.map((c) => (
                <MenuRow key={c.id} checked={camA === c.id} disabled={c.id === camB} note={c.id === camB ? 'used by B' : undefined} onClick={() => (setCamA(c.id), close(), perms.camera === 'undetermined' ? void request('camera') : undefined)}>
                  {c.name}
                </MenuRow>
              ))}
              {devices && devices.cameras.length === 0 ? <div className="tiny dim rb-note">No camera is connected.</div> : null}
              {cameraA && !cameraBlocked ? <div className="tiny dim rb-note">{(() => { const f = pickFormat(cameraA); return `${f.width} × ${f.height} · ${f.fps} fps · its own track`; })()}</div> : null}
            </>
          )}
        </PillMenu>

        <PillMenu icon="camera" label={cameraB ? short(cameraB.name, 14) : 'B'} off={!cameraB} title="Camera B (second angle)" testId="camera-b" width={300}>
          {(close) => (
            <>
              <div className="rb-head">Camera B · second angle</div>
              <MenuRow checked={!camB} onClick={() => (setCamB(null), close())}>Don’t record a second camera</MenuRow>
              {devices?.cameras.map((c) => (
                <MenuRow key={c.id} checked={camB === c.id} disabled={c.id === camA} note={c.id === camA ? 'used by A' : undefined} onClick={() => (setCamB(c.id), close(), perms.camera === 'undetermined' ? void request('camera') : undefined)}>
                  {c.name}
                </MenuRow>
              ))}
              <div className="tiny dim rb-note">
                {devices && devices.cameras.length < 2 ? (devices.cameras.length === 0 ? 'No camera is connected.' : 'Only one camera is connected. One device cannot fill both slots: connect a second camera, or import its file later.') : 'Both cameras share one clock, so they stay in sync.'}
              </div>
            </>
          )}
        </PillMenu>

        <PillMenu icon="mic" label={microphone ? short(microphone.name) : 'No microphone'} off={!microphone} level={mic && !micBlocked ? micDb : undefined} title="Microphone" testId="microphone" width={320}>
          {(close) => (
            <>
              <div className="rb-head">Microphone</div>
              <MenuRow checked={!mic} onClick={() => (setMic(null), close())}>Don’t record microphone</MenuRow>
              {devices?.microphones.map((m) => (
                <MenuRow key={m.id} checked={mic === m.id} note={m.default ? 'system default' : undefined} onClick={() => (setMic(m.id), close(), perms.microphone === 'undetermined' ? void request('microphone') : undefined)}>
                  {m.name}
                </MenuRow>
              ))}
              {mic && !micBlocked ? (
                <div className="row rb-note" style={{ gap: 8 }}>
                  <Meter db={micDb} />
                  <span className="tiny mono dim" style={{ width: 44, textAlign: 'right' }}>{micDb === null ? '—' : `${micDb.toFixed(0)} dB`}</span>
                </div>
              ) : null}
            </>
          )}
        </PillMenu>

        <PillMenu icon="speaker" label={!systemAudioOn || perms.screen !== 'granted' ? 'No system audio' : audioMode === 'all' ? 'System audio' : `Sound from ${audioApps.length} app${audioApps.length === 1 ? '' : 's'}`} off={!systemAudioOn || perms.screen !== 'granted'} title="System audio" testId="system-audio" width={320}>
          {(close) => (
            <>
              <div className="rb-head">System audio</div>
              <MenuRow checked={audioMode === 'off'} onClick={() => (setAudioMode('off'), close())}>No system audio</MenuRow>
              <MenuRow checked={audioMode === 'all'} onClick={() => (perms.screen === 'granted' ? setAudioMode('all') : void request('screen'), close())}>Record system audio from all apps</MenuRow>
              <MenuRow checked={audioMode === 'apps'} disabled={apps.length === 0} onClick={() => (perms.screen === 'granted' ? setAudioMode('apps') : void request('screen'))} note={apps.length === 0 ? 'no apps listed' : undefined}>Record from selected apps</MenuRow>
              {audioMode === 'apps' ? (
                <div className="rb-apps" role="group" aria-label="Apps to record sound from">
                  {apps.map((a) => (
                    <label key={a.bundleId}>
                      <input type="checkbox" checked={audioApps.includes(a.bundleId)} onChange={(e) => setAudioApps((list) => (e.target.checked ? [...list, a.bundleId] : list.filter((b) => b !== a.bundleId)))} />
                      <span>{a.name}</span>
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="tiny dim rb-note">{perms.screen === 'granted' ? 'Kept as its own track, separate from your voice.' : 'Needs Screen Recording access.'}</div>
            </>
          )}
        </PillMenu>

        <span className="rb-sep" />
        <button className="rb-icon" onClick={() => (useApp.getState().setView('sources'), useApp.getState().go('project'))} title="Import files instead of recording" aria-label="Import instead" data-testid="import-instead">
          <Icon name="import" size={16} />
        </button>
        <PillMenu icon="gear" title="Recording options" align="right" width={360} testId="options">
          {() => (
            <div className="rb-options">
              <div className="rb-head">Recording options</div>
              <Toggle label="Hide desktop icons" hint="Left out of the recording only. Your desktop is not changed." checked={prefs.hideIcons} onChange={(v) => setPrefs({ hideIcons: v })} />
              <Toggle label="Hide notifications" hint="Banners are left out of the recording." checked={prefs.hideNotifs} onChange={(v) => setPrefs({ hideNotifs: v })} />
              <Toggle
                label="Record keyboard shortcuts"
                hint={
                  keysPerm === 'granted'
                    ? 'Shortcuts and typing activity only. Typed characters are never stored.'
                    : keysPerm === 'denied'
                      ? 'Shortcuts and typing activity only, never the characters. Input Monitoring is off for Cutaway: turn it on in System Settings → Privacy & Security → Input Monitoring. Until then the take records without it.'
                      : 'Shortcuts and typing activity only, never the characters. Needs Input Monitoring: allow Cutaway in System Settings → Privacy & Security → Input Monitoring.'
                }
                checked={prefs.captureKeys}
                onChange={(v) => setPrefs({ captureKeys: v })}
              />
              <Toggle label="Show speaker notes" hint="A floating notepad that is not recorded." checked={notesOpen} onChange={toggleNotes} />
              <div className="sep" />
              <div className="row between">
                <span className="rb-opt-label">Frame rate</span>
                <Segmented<'30' | '60'> label="Frame rate" value={String(fps) as '30' | '60'} onChange={(v) => setPrefs({ fps: Number(v) as 30 | 60 })} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
              </div>
              <div className="row between">
                <span className="rb-opt-label">Cursor</span>
                <Segmented<'clean' | 'baked'> label="Cursor" value={cursor} onChange={(v) => setPrefs({ cursor: v })} options={[{ value: 'clean', label: 'Clean', disabled: !onMac }, { value: 'baked', label: 'Baked in', disabled: !onMac }]} />
              </div>
              <div className="tiny dim">{!onMac ? 'No Mac screen in this take, so there is no cursor to record.' : cursor === 'clean' ? 'Clean: recorded separately so it can be smoothed and resized later.' : 'Baked in: part of the picture; it cannot be restyled afterwards.'}</div>
              <div className="row between">
                <span className="rb-opt-label">Countdown</span>
                <Segmented<string> label="Countdown" value={String(COUNTDOWNS.includes(countdown) ? countdown : 3)} onChange={(v) => void setCountdown(Number(v))} options={COUNTDOWNS.map((c) => ({ value: String(c), label: c === 0 ? 'Off' : `${c}s` }))} />
              </div>
            </div>
          )}
        </PillMenu>
      </div>

      <div className="rec-status tiny dim" aria-live="polite">
        {cannotStart && !loading ? <span className="warn">{cannotStart} </span> : null}
        {skipped.length ? <span className="warn">Without {skipped.join(', ')} (no access). </span> : null}
        {sourceCount > 0 ? `${sourceCount} separate track${sourceCount === 1 ? '' : 's'} on one clock. ` : ''}
        {preflight && minutes !== null ? `About ${minutes >= 600 ? 'ten hours or more' : minutes >= 120 ? `${Math.floor(minutes / 60)} hours` : `${minutes} minutes`} of room (${fmtBytes(preflight.estimatedBytesPerMinute)} per minute, ${fmtBytes(preflight.freeBytes)} free).` : ''}
      </div>

      {phase === 'countdown' ? (
        <div className="countdown" role="alertdialog" aria-label="Recording starts soon">
          <div key={count} className="countdown-num">{count}</div>
          <div className="muted">Recording starts at zero.</div>
          <Button size="lg" onClick={() => setPhase('setup')}>Cancel <span className="kbd" style={{ marginLeft: 6 }}>esc</span></Button>
        </div>
      ) : null}
    </div>
  );
}
