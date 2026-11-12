import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { buildCues, buildCursorTrack, coverage, cueAt, evaluateFrame, toSourceTime, type CursorTrack, type FrameState, type MediaSource, type Project } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject } from '../state/store';
import { drawFrame, drawableFromElement, type FrameResources } from './compositor';
import { loadCursor, sourceUrl, voiceGain } from './media';

export interface PreviewPoint {
  /** 0…1 across the output frame. */
  x: number;
  y: number;
  /** Same point in screen-source coordinates (0…1), when it lands on the screen picture. */
  screen: { x: number; y: number } | null;
}

interface Props {
  onPointer?(phase: 'down' | 'move' | 'up', p: PreviewPoint, e: ReactPointerEvent): void;
  cursorStyle?: string;
  selectedMaskId?: string | null;
  showCaptions?: boolean;
}

interface El {
  el: HTMLVideoElement;
  source: MediaSource;
  url: string;
  node?: { src: MediaElementAudioSourceNode; hp: BiquadFilterNode; gain: GainNode };
}

/**
 * Live preview. Media elements are slaved to one output-time clock; every
 * frame is drawn by the same evaluateFrame + drawFrame the exporter uses.
 */
export function Preview({ onPointer, cursorStyle, selectedMaskId, showCaptions = true }: Props) {
  const project = useShownProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const live = useRef({ project, projectPath, selectedMaskId: selectedMaskId ?? null, showCaptions });
  live.current = { project, projectPath, selectedMaskId: selectedMaskId ?? null, showCaptions };
  const lastState = useRef<FrameState | null>(null);

  useEffect(() => {
    const els = new Map<string, El>();
    const images = new Map<string, HTMLImageElement>();
    let audioCtx: AudioContext | null = null;
    let cursorKey = '';
    let cursorTrack: CursorTrack | null = null;
    let followTrack: CursorTrack | null = null;
    let cuesKey: unknown = null;
    let cues: ReturnType<typeof buildCues> = [];
    let raf = 0;
    let last = performance.now();
    let seenSeek = -1;
    let lastSeg = -1;
    let disposed = false;

    const ensure = (s: MediaSource): El | null => {
      if (!s.available || s.kind === 'image') return null;
      const url = sourceUrl(live.current.projectPath, s);
      let e = els.get(s.id);
      if (e && e.url !== url) {
        e.el.pause();
        e.el.removeAttribute('src');
        e.el.load();
        els.delete(s.id);
        e = undefined;
      }
      if (!e) {
        const el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.playsInline = true;
        el.src = url;
        e = { el, source: s, url };
        els.set(s.id, e);
      }
      e.source = s;
      return e;
    };

    const image = (s: MediaSource): HTMLImageElement | null => {
      let img = images.get(s.id);
      if (!img) {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = sourceUrl(live.current.projectPath, s);
        images.set(s.id, img);
      }
      return img.complete && img.naturalWidth > 0 ? img : null;
    };

    /** Route the master voice through a rumble filter + level gain; same treatment as export. */
    const applyVoiceChain = (e: El, p: Project) => {
      const on = p.edit.audio.voiceCleanup.enabled && !p.edit.audio.voiceCleanup.bypass && e.source.id === p.edit.audio.masterVoiceId;
      if (!e.node) {
        if (!on) return;
        try {
          audioCtx ??= new AudioContext();
          const src = audioCtx.createMediaElementSource(e.el);
          const hp = audioCtx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 85;
          const gain = audioCtx.createGain();
          src.connect(hp).connect(gain).connect(audioCtx.destination);
          e.node = { src, hp, gain };
        } catch {
          return;
        }
      }
      e.node.hp.frequency.value = on ? 85 : 1;
      e.node.gain.gain.value = on ? voiceGain(p) : 1;
      if (audioCtx?.state === 'suspended') void audioCtx.resume();
    };

    const tick = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { project: p, projectPath: pp } = live.current;
      const pb = usePlayback.getState();
      const map = timeMapOf(p);
      let out = pb.time;
      if (pb.playing) {
        out += dt;
        if (out >= map.outDuration) {
          out = Math.max(0, map.outDuration - 1e-3);
          pb.setPlaying(false);
        }
        pb.setTime(out);
      } else if (out > map.outDuration) {
        out = Math.max(0, map.outDuration - 1e-3);
        pb.setTime(out);
      }
      const hardSeek = pb.seekToken !== seenSeek;
      seenSeek = pb.seekToken;
      const segIndex = map.segmentAtOut(out);
      const seg = segIndex >= 0 ? map.segments[segIndex]! : null;
      const segChanged = segIndex !== lastSeg;
      lastSeg = segIndex;
      const src = map.toSource(out);
      const speed = seg?.speed ?? 1;

      // cursor telemetry (recordings only)
      const screen = p.sources.find((s) => s.role === 'screen');
      const key = screen && !screen.cursorBaked && screen.cursorFile ? `${pp}|${screen.cursorFile}|${p.edit.appearance.cursor.smoothing}` : '';
      if (key !== cursorKey) {
        cursorKey = key;
        cursorTrack = followTrack = null;
        if (key && screen) {
          const smoothing = p.edit.appearance.cursor.smoothing;
          void loadCursor(pp, screen).then((samples) => {
            if (cursorKey !== key || samples.length === 0) return;
            cursorTrack = buildCursorTrack(samples, smoothing);
            followTrack = buildCursorTrack(samples, 0.97);
          });
        }
      }

      const ctxFrame = { project: p, map, cursor: cursorTrack, follow: followTrack, screenAspect: screen?.width && screen.height ? (screen.width * p.edit.appearance.crop.w) / (screen.height * p.edit.appearance.crop.h) : null };
      const state = evaluateFrame(ctxFrame, out);
      lastState.current = state;

      // ── slave media elements to the clock ──
      const wanted = new Set<string>();
      const audio = p.edit.audio;
      const sync = (s: MediaSource, local: number, active: boolean, volume: number, rate: number) => {
        const e = ensure(s);
        if (!e) return null;
        wanted.add(s.id);
        const el = e.el;
        const inRange = active && local >= 0 && local < s.duration - 0.02;
        el.volume = Math.max(0, Math.min(1, volume * pb.volume));
        el.muted = volume <= 0 || !inRange;
        if (!inRange) {
          if (!el.paused) el.pause();
          return e;
        }
        applyVoiceChain(e, p);
        const drift = el.currentTime - local;
        if (pb.playing) {
          const r = Math.max(0.1, Math.min(8, rate));
          if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
          if (hardSeek || segChanged || Math.abs(drift) > 0.12) el.currentTime = local;
          if (el.paused) void el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(drift) > 0.012 && !el.seeking) el.currentTime = local;
        }
        return e;
      };

      const res: FrameResources = { screen: null, cameraA: null, cameraB: null, broll: null, backgroundImage: null };
      for (const s of p.sources) {
        const track = audio.tracks[s.id];
        const audible = s.hasAudio && track && !track.muted;
        const isMusic = audio.music?.sourceId === s.id;
        const timeline = s.role === 'screen' || s.role === 'cameraA' || s.role === 'cameraB';
        if (isMusic) {
          sync(s, out, true, audio.music!.gain * (audio.music!.duck && speaking(p, src) ? 0.22 : 1), 1);
          continue;
        }
        if (!timeline && !audible) continue;
        if (s.sync.status === 'unsynced') continue;
        const covered = coverage(s).some((c) => src >= c.start && src < c.end);
        const e = sync(s, toSourceTime(s.sync, src), covered, audible ? track.gain : 0, speed * s.sync.rate);
        if (!e || !covered) continue;
        const d = drawableFromElement(e.el);
        if (s.role === 'screen') res.screen = d;
        else if (s.role === 'cameraA') res.cameraA = d;
        else if (s.role === 'cameraB') res.cameraB = d;
      }
      if (state.broll) {
        const asset = p.sources.find((s) => s.id === state.broll!.insert.assetId);
        if (asset?.kind === 'image') {
          const img = image(asset);
          res.broll = img ? drawableFromElement(img) : null;
        } else if (asset) {
          const e = sync(asset, state.broll.assetTime, true, state.broll.insert.useAssetAudio ? 1 : 0, speed);
          res.broll = e ? drawableFromElement(e.el) : null;
        }
      }
      for (const [id, e] of els) {
        if (!wanted.has(id) && !e.el.paused) e.el.pause();
      }

      // ── draw ──
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ap = p.edit.appearance;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const box = wrap.getBoundingClientRect();
      const aspect = ap.output.width / ap.output.height;
      let cw = box.width;
      let ch = cw / aspect;
      if (ch > box.height) {
        ch = box.height;
        cw = ch * aspect;
      }
      const pw = Math.max(2, Math.round(cw * dpr));
      const ph = Math.max(2, Math.round(ch * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.setTransform(pw / ap.output.width, 0, 0, ph / ap.output.height, 0, 0);
      if (cuesKey !== p.edit || !cues) {
        cuesKey = p.edit;
        cues = buildCues(p.transcript, p.edit, map);
      }
      drawFrame(ctx, state, res, {
        appearance: live.current.showCaptions ? ap : { ...ap, captions: { ...ap.captions, burnIn: false } },
        screenPoints: screen?.pointWidth && screen.pointHeight ? { width: screen.pointWidth, height: screen.pointHeight } : null,
        cue: ap.captions.burnIn ? cueAt(cues, out) : null,
        editor: { selectedMaskId: live.current.selectedMaskId },
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const e of els.values()) {
        e.el.pause();
        e.el.removeAttribute('src');
        e.el.load();
      }
      void audioCtx?.close();
    };
  }, []);

  const point = (e: ReactPointerEvent): PreviewPoint => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const st = lastState.current;
    const ap = live.current.project.edit.appearance;
    let screen: PreviewPoint['screen'] = null;
    if (st?.screen && st.screen.opacity > 0.5) {
      const R = st.screen.rect;
      const px = x * ap.output.width;
      const py = y * ap.output.height;
      if (px >= R.x && px <= R.x + R.w && py >= R.y && py <= R.y + R.h) {
        const z = st.screen.zoom;
        const vw = ap.crop.w / z.scale;
        const vh = ap.crop.h / z.scale;
        const vx = ap.crop.x + z.cx * ap.crop.w - vw / 2;
        const vy = ap.crop.y + z.cy * ap.crop.h - vh / 2;
        screen = { x: vx + ((px - R.x) / R.w) * vw, y: vy + ((py - R.y) / R.h) * vh };
      }
    }
    return { x, y, screen };
  };

  return (
    <div ref={wrapRef} className="preview-wrap">
      <canvas
        ref={canvasRef}
        className="preview-canvas"
        style={{ cursor: cursorStyle }}
        onPointerDown={(e) => {
          if (!onPointer) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          onPointer('down', point(e), e);
        }}
        onPointerMove={(e) => onPointer && e.buttons === 1 && onPointer('move', point(e), e)}
        onPointerUp={(e) => onPointer?.('up', point(e), e)}
        aria-label="Video preview"
        role="img"
      />
    </div>
  );
}

function speaking(p: Project, src: number): boolean {
  const words = p.transcript?.words;
  if (!words) return false;
  // binary search for a word near src
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid]!;
    if (src < w.start - 0.25) hi = mid - 1;
    else if (src > w.end + 0.35) lo = mid + 1;
    else return true;
  }
  return false;
}
