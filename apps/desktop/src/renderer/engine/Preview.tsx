import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { cameraSourceAt, isMasterVoice, sourceAt, trackOf, buildCues, burnInCues, buildCursorTrack, clickSoundOf, clickTick, coverage, cueAt, cursorExtrasOf, cutoutOf, deviceKindFor, deviceOf, evaluateFrame, faceOf, shortcutsOf, toSourceTime, type CameraSlot, type CursorTrack, type FaceTrackSmooth, type FrameState, type MediaSource, type Project } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject } from '../state/store';
import { motionFrameNow } from './motionFrames';
import { drawFrame, drawableFromElement, type DrawEnv, type FrameResources } from './compositor';
import { punchInOf } from '@cutaway/core';
import { keysOnSession, loadCursorOnSession, sourceUrl, voiceGain } from './media';
import { duckStep, musicClipsOf, musicGainAt, musicSourceTime, soundEvents, speakingAt, speechWindows, type Range, type SoundEvent } from '@cutaway/core';
import { playBuiltin, playFile } from './soundPlayer';
import voiceWorkletUrl from './voiceWorklet.ts?worker&url';
import { ensureFaces, ensureKeys, ensureMatte, peekFaces, peekKeys, peekMatte } from './parityData';
import { gradeLuts } from './lut';
import { resolveSourcePath } from '@shared/api';

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
  /** A free text overlay to outline as selected (editor only; never drawn in an export). */
  selectedOverlayId?: string | null;
  showCaptions?: boolean;
  /** Play this project instead of the open one (a short's derived project). */
  project?: Project;
}

interface El {
  el: HTMLVideoElement;
  source: MediaSource;
  url: string;
  node?: { src: MediaElementAudioSourceNode; hp: BiquadFilterNode; gain: GainNode; worklet?: AudioWorkletNode; sent?: string };
}

/**
 * Live preview. Media elements are slaved to one output-time clock; every
 * frame is drawn by the same evaluateFrame + drawFrame the exporter uses.
 */
export function Preview({ onPointer, cursorStyle, selectedMaskId, selectedOverlayId, showCaptions = true, project: override }: Props) {
  const shown = useShownProject();
  // A short is played from a project derived for it (shortProject); everything else plays the open project.
  const project = override ?? shown;
  const projectPath = useApp((s) => s.projectPath)!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const live = useRef({ project, projectPath, selectedMaskId: selectedMaskId ?? null, selectedOverlayId: selectedOverlayId ?? null, showCaptions });
  live.current = { project, projectPath, selectedMaskId: selectedMaskId ?? null, selectedOverlayId: selectedOverlayId ?? null, showCaptions };
  const lastState = useRef<FrameState | null>(null);

  useEffect(() => {
    const els = new Map<string, El>();
    const images = new Map<string, HTMLImageElement>();
    let audioCtx: AudioContext | null = null;
    let voiceWorklet: Promise<void> | null = null;
    let cursorKey = '';
    let cursorTrack: CursorTrack | null = null;
    let followTrack: CursorTrack | null = null;
    /** Built tracks by key, so crossing from one clip into the next does not blank the pointer while it rebuilds. */
    const trackCache = new Map<string, { cursor: CursorTrack; follow: CursorTrack }>();
    let cuesKey: unknown = null;
    let cues: ReturnType<typeof buildCues> = [];
    const matteEls = new Map<string, HTMLVideoElement>();
    let tick_: AudioBuffer | null = null;
    let prevSrc = -1;
    // music clips and sound effects run on the output clock
    const musicEls = new Map<string, { el: HTMLAudioElement; url: string }>();
    let duck = 1;
    let speechKey: unknown = null;
    let speech: Range[] = [];
    let eventsKey: unknown = null;
    let events: SoundEvent[] = [];
    let prevOut = -1;
    /** Stop functions of the sounds this preview started (not the inspector's "listen" buttons). */
    let started: (() => void)[] = [];
    /** Where the neighbouring clip's frame is drawn during a cross-dissolve. */
    let blendCanvas: HTMLCanvasElement | null = null;
    let raf = 0;
    let last = performance.now();
    let seenSeek = -1;
    let lastSeg = -1;
    let disposed = false;
    /**
     * The last picture of each video, copied just before it is sent to a new time. While the seek runs the
     * element has no frame to give, so this is drawn instead of a "source unavailable" slate.
     */
    const held = new Map<string, HTMLCanvasElement>();
    const holdFrame = (id: string, el: HTMLVideoElement) => {
      if (el.readyState < 2 || !el.videoWidth || !el.videoHeight) return;
      const scale = Math.min(1, 1920 / el.videoWidth);
      const w = Math.round(el.videoWidth * scale), h = Math.round(el.videoHeight * scale);
      let c = held.get(id);
      if (!c) held.set(id, (c = document.createElement('canvas')));
      if (c.width !== w || c.height !== h) (c.width = w), (c.height = h);
      c.getContext('2d')?.drawImage(el, 0, 0, w, h);
    };
    /** Move a video to a new time, keeping its current picture to show until the new one is ready. */
    const seekEl = (id: string, el: HTMLVideoElement, t: number) => {
      holdFrame(id, el);
      el.currentTime = t;
    };
    /** The video's picture now, or the one held from before a seek that is still running. */
    const pictureOf = (id: string, el: HTMLVideoElement) => {
      const d = drawableFromElement(el);
      if (d) {
        if (!el.seeking) held.delete(id);
        return d;
      }
      const h = held.get(id);
      return h ? drawableFromElement(h) : null;
    };

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
        // sped-up and slowed-down sections keep the voice's pitch, as the export does
        el.preservesPitch = true;
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

    /** The background picture, when the background is an image (absolute, or relative to the project folder). */
    let bgImage: { url: string; img: HTMLImageElement } | null = null;
    const backgroundImage = (path: string): HTMLImageElement | null => {
      const url = window.cutaway.media.url(resolveSourcePath(live.current.projectPath, path));
      if (bgImage?.url !== url) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = url;
        bgImage = { url, img };
      }
      return bgImage.img.complete && bgImage.img.naturalWidth > 0 ? bgImage.img : null;
    };

    /** Shape of the screen picture after the crop. A photo imported without its size uses the loaded image's. */
    const aspectOf = (s: MediaSource | undefined, p: Project): number | null => {
      const img = s?.kind === 'image' && !(s.width && s.height) ? image(s) : null;
      const w = s?.width || img?.naturalWidth;
      const h = s?.height || img?.naturalHeight;
      return w && h ? (w * p.edit.appearance.crop.w) / (h * p.edit.appearance.crop.h) : null;
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
      const on = p.edit.audio.voiceCleanup.enabled && !p.edit.audio.voiceCleanup.bypass && isMasterVoice(p.edit.audio, e.source);
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
          const node: NonNullable<El['node']> = { src, hp, gain };
          e.node = node;
          // The full chain (expander and limiter too) runs in a worklet with the exporter's own code.
          // Until it has loaded, or if it cannot load, the filter and gain above stand in.
          const ctx = audioCtx;
          voiceWorklet ??= ctx.audioWorklet.addModule(voiceWorkletUrl);
          voiceWorklet
            .then(() => {
              if (ctx.state === 'closed') return;
              const worklet = new AudioWorkletNode(ctx, 'cutaway-voice-cleaner', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
              src.disconnect();
              src.connect(worklet).connect(ctx.destination);
              node.worklet = worklet;
              node.sent = undefined;
            })
            .catch((err) => console.warn('voice cleanup worklet unavailable; using the basic chain', err));
        } catch {
          return;
        }
      }
      if (e.node.worklet) {
        const params = { on, makeup: voiceGain(p), expander: p.analysis?.voiceLevelDb != null };
        const key = JSON.stringify(params);
        if (e.node.sent !== key) {
          e.node.worklet.port.postMessage(params);
          e.node.sent = key;
        }
      }
      e.node.hp.frequency.value = on ? 85 : 1;
      e.node.gain.gain.value = on ? voiceGain(p) : 1;
      if (audioCtx?.state === 'suspended') void audioCtx.resume();
    };

    /** Short click tick through WebAudio; the export mixer adds the identical samples. */
    const playClick = (volume: number) => {
      try {
        audioCtx ??= new AudioContext();
        if (!tick_) {
          const data = clickTick(audioCtx.sampleRate);
          tick_ = audioCtx.createBuffer(1, data.length, audioCtx.sampleRate);
          tick_.getChannelData(0).set(data);
        }
        const node = audioCtx.createBufferSource();
        node.buffer = tick_;
        const g = audioCtx.createGain();
        g.gain.value = volume * usePlayback.getState().volume;
        node.connect(g).connect(audioCtx.destination);
        node.start();
      } catch {
        /* audio device unavailable: the preview stays silent, export is unaffected */
      }
    };

    const matteEl = (path: string): HTMLVideoElement => {
      let el = matteEls.get(path);
      if (!el) {
        el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.muted = true;
        el.playsInline = true;
        el.src = window.cutaway.media.url(path);
        matteEls.set(path, el);
      }
      return el;
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
      // With several clips, the screen (and its pointer, keys and size) is the one of the clip being shown.
      const screen = sourceAt(p, 'screen', src);
      const extra = cursorExtrasOf(p.edit.appearance);
      const key = screen && !screen.cursorBaked && screen.cursorFile ? `${pp}|${screen.cursorFile}|${screen.shift ?? 0}|${screen.window?.start ?? ''}|${screen.window?.end ?? ''}|${p.edit.appearance.cursor.smoothing}|${extra.antiShake}|${extra.loop}` : '';
      if (key !== cursorKey) {
        cursorKey = key;
        const built = trackCache.get(key);
        cursorTrack = built?.cursor ?? null;
        followTrack = built?.follow ?? null;
        if (key && screen && !built) {
          const smoothing = p.edit.appearance.cursor.smoothing;
          void loadCursorOnSession(pp, screen).then((samples) => {
            if (samples.length === 0) return;
            const fresh = { cursor: buildCursorTrack(samples, smoothing, 120, { antiShake: extra.antiShake, loop: extra.loop }), follow: buildCursorTrack(samples, 0.97) };
            if (trackCache.size > 12) trackCache.clear();
            trackCache.set(key, fresh);
            if (cursorKey !== key) return;
            cursorTrack = fresh.cursor;
            followTrack = fresh.follow;
          });
        }
      }

      // derived data: shortcuts, face tracks (requested lazily, drawn once ready)
      if (screen?.keysFile && shortcutsOf(p.edit.appearance).show) void ensureKeys(pp, screen);
      const faceOpt = faceOf(p.edit.appearance);
      const faces: Partial<Record<CameraSlot, FaceTrackSmooth | null>> = {};
      if (faceOpt.zoom || faceOpt.follow || punchInOf(p.edit).enabled) {
        for (const slot of ['A', 'B'] as CameraSlot[]) {
          const cam = cameraSourceAt(p, slot, src);
          if (!cam || !cam.available) continue;
          void ensureFaces(pp, cam);
          faces[slot] = peekFaces(pp, cam).value;
        }
      }
      const ctxFrame = { project: p, map, cursor: cursorTrack, follow: followTrack, screenAspect: aspectOf(screen, p), keys: keysOnSession(peekKeys(pp, screen), screen), faces, quality: 'preview' as const, device: deviceOf(p.edit.appearance).frame ? deviceKindFor(screen) : null };
      const state = evaluateFrame(ctxFrame, out);
      lastState.current = state;

      // click sound: every click the playhead passes while playing
      const cs = clickSoundOf(p.edit.appearance);
      if (pb.playing && cs.enabled && cursorTrack && prevSrc >= 0 && src > prevSrc && src - prevSrc < 0.5) {
        for (const c of cursorTrack.clicks) if (c.t > prevSrc && c.t <= src) playClick(cs.volume);
      }
      prevSrc = src;

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
          if (hardSeek || segChanged || Math.abs(drift) > 0.12) seekEl(s.id, el, local);
          if (el.paused) void el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(drift) > 0.012 && !el.seeking) seekEl(s.id, el, local);
        }
        return e;
      };

      const res: FrameResources = { screen: null, cameraA: null, cameraB: null, broll: null, backgroundImage: null };
      // ── animations: their frames, rendered once at the output size (the export draws the same ones) ──
      for (const o of state.overlays) {
        if (o.overlay.kind !== 'motion') continue;
        const out = p.edit.appearance.output;
        const f = motionFrameNow(pp, o.overlay, o.sinceIn, { width: out.width, height: out.height, fps: out.fps });
        if (f) (res.motion ??= new Map()).set(o.overlay.id, f);
      }
      // ── a cross-dissolve between clips: the neighbouring clip's own pictures, taken just beyond its edge ──
      const tr = state.transition;
      const clipLevel = tr?.gain ?? 1;
      const partnerIds = new Set<string>();
      let partner: { state: FrameState; res: FrameResources; screen: MediaSource | undefined; alpha: number } | null = null;
      if (tr?.partner && tr.partner.alpha > 0.001) {
        const ps = tr.partner.src;
        const pScreen = sourceAt(p, 'screen', ps);
        const pRes: FrameResources = { screen: null, cameraA: null, cameraB: null, broll: null, backgroundImage: null };
        const pFaces: Partial<Record<CameraSlot, FaceTrackSmooth | null>> = {};
        for (const [s, key] of [[pScreen, 'screen'], [cameraSourceAt(p, 'A', ps), 'cameraA'], [cameraSourceAt(p, 'B', ps), 'cameraB']] as [MediaSource | undefined, 'screen' | 'cameraA' | 'cameraB'][]) {
          if (!s || !s.available || s.sync.status === 'unsynced') continue;
          if (key !== 'screen' && (faceOpt.zoom || faceOpt.follow || punchInOf(p.edit).enabled)) pFaces[key === 'cameraA' ? 'A' : 'B'] = peekFaces(pp, s).value;
          // a photo clip's picture is the image itself
          if (s.kind === 'image') {
            const img = image(s);
            pRes[key] = img && img.complete ? drawableFromElement(img) : null;
            continue;
          }
          const e = ensure(s);
          if (!e) continue;
          // The same file is already playing as this clip's own picture (two halves of a split): it is left alone.
          if (!coverage(s).some((c) => src >= c.start && src < c.end)) {
            partnerIds.add(s.id);
            wanted.add(s.id);
            const el = e.el;
            const local = Math.max(0, Math.min(s.duration - 0.03, toSourceTime(s.sync, ps)));
            const drift = el.currentTime - local;
            el.muted = true;
            if (pb.playing && !tr.partner.held) {
              const r = Math.max(0.1, Math.min(8, s.sync.rate));
              if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
              if (hardSeek || Math.abs(drift) > 0.12) el.currentTime = local;
              if (el.paused) void el.play().catch(() => {});
            } else {
              if (!el.paused) el.pause();
              if (Math.abs(drift) > 0.02 && !el.seeking) el.currentTime = local;
            }
          }
          pRes[key] = drawableFromElement(e.el);
        }
        const pState = evaluateFrame({ ...ctxFrame, cursor: null, follow: null, keys: [], faces: pFaces, screenAspect: aspectOf(pScreen, p), device: deviceOf(p.edit.appearance).frame ? deviceKindFor(pScreen) : null }, tr.partner.edgeOut);
        partner = { state: pState, res: pRes, screen: pScreen, alpha: tr.partner.alpha };
      }
      for (const s of p.sources) {
        if (partnerIds.has(s.id)) continue;
        const track = trackOf(audio, s);
        const audible = s.hasAudio && track && !track.muted;
        const timeline = s.role === 'screen' || s.role === 'cameraA' || s.role === 'cameraB';
        if (!timeline && !audible) continue;
        if (s.sync.status === 'unsynced') continue;
        const covered = coverage(s).some((c) => src >= c.start && src < c.end);
        // a photo clip: its picture is the image, shown for as long as the clip plays
        if (s.kind === 'image') {
          if (covered && s.role === 'screen') {
            const img = image(s);
            res.screen = img && img.complete ? drawableFromElement(img) : null;
          }
          continue;
        }
        // A source of another clip is opened shortly before its clip begins and parked on its first
        // frame, so the change of clip does not wait for a seek. Further away it is left alone.
        if (!covered && s.window) {
          const lead = s.window.start - src;
          if (lead > 0 && lead < 4 && s.available) {
            const upcoming = ensure(s);
            const first = Math.max(0, toSourceTime(s.sync, s.window.start));
            if (upcoming) {
              upcoming.el.muted = true;
              if (!upcoming.el.paused) upcoming.el.pause();
              if (Math.abs(upcoming.el.currentTime - first) > 0.05 && !upcoming.el.seeking) upcoming.el.currentTime = first;
            }
          }
          continue;
        }
        // during a transition the clip's sound follows the transition's level curve, as in the export
        const e = sync(s, toSourceTime(s.sync, src), covered, audible ? track.gain * clipLevel : 0, speed * s.sync.rate);
        if (!e || !covered) continue;
        const d = pictureOf(s.id, e.el);
        if (s.role === 'screen') res.screen = d;
        else if (s.role === 'cameraA') res.cameraA = d;
        else if (s.role === 'cameraB') res.cameraB = d;
        // background removal: a matte video kept in step with its camera
        if ((s.role === 'cameraA' || s.role === 'cameraB') && cutoutOf(p.edit.appearance).enabled) {
          void ensureMatte(pp, s);
          const mp = peekMatte(pp, s).value;
          if (mp) {
            const m = matteEl(mp);
            const want = e.el.currentTime;
            if (pb.playing) {
              if (Math.abs(m.playbackRate - e.el.playbackRate) > 1e-3) m.playbackRate = e.el.playbackRate;
              if (Math.abs(m.currentTime - want) > 0.06) m.currentTime = want;
              if (m.paused) void m.play().catch(() => {});
            } else {
              if (!m.paused) m.pause();
              if (Math.abs(m.currentTime - want) > 0.012 && !m.seeking) m.currentTime = want;
            }
            const md = drawableFromElement(m);
            if (s.role === 'cameraA') res.matteA = md;
            else res.matteB = md;
          }
        }
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

      // ── music clips: one element per clip, slaved to the output clock, with the exporter's level maths ──
      if (speechKey !== p.transcript) {
        speechKey = p.transcript;
        speech = speechWindows(p);
      }
      duck = pb.playing && !hardSeek ? duckStep(duck, speakingAt(speech, src), dt) : speakingAt(speech, src) ? duckStep(1, true, 10) : 1;
      const sounding = new Set<string>();
      for (const c of musicClipsOf(p.edit, p.sources)) {
        const file = p.sources.find((x) => x.id === c.sourceId);
        if (!file) continue;
        const local = musicSourceTime(c, out, file.duration);
        if (!file.available || out < c.start || out >= c.start + c.length || (!c.loop && local >= file.duration - 0.02)) continue;
        sounding.add(c.id);
        const url = sourceUrl(pp, file);
        let m = musicEls.get(c.id);
        if (m && m.url !== url) {
          m.el.pause();
          musicEls.delete(c.id);
          m = undefined;
        }
        if (!m) {
          const el = new Audio();
          el.crossOrigin = 'anonymous';
          el.preload = 'auto';
          el.src = url;
          m = { el, url };
          musicEls.set(c.id, m);
        }
        // a looping clip lets the element wrap by itself; the drift check below keeps it on the output clock
        m.el.loop = !!c.loop;
        const volume = Math.max(0, Math.min(1, musicGainAt(c, out, file.duration) * (c.duck ? duck : 1) * pb.volume));
        m.el.volume = volume;
        m.el.muted = volume <= 0;
        const drift = m.el.currentTime - local;
        if (pb.playing) {
          if (hardSeek || Math.abs(drift) > 0.12) m.el.currentTime = local;
          if (m.el.paused) void m.el.play().catch(() => {});
        } else {
          if (!m.el.paused) m.el.pause();
          if (Math.abs(drift) > 0.012 && !m.el.seeking) m.el.currentTime = local;
        }
      }
      for (const [id, m] of musicEls) {
        if (sounding.has(id)) continue;
        if (!m.el.paused) m.el.pause();
        // a clip that was removed, or one the playhead has left for good
        if (!musicClipsOf(p.edit, p.sources).some((c) => c.id === id)) {
          m.el.removeAttribute('src');
          m.el.load();
          musicEls.delete(id);
        }
      }

      // ── sound effects: each one starts as the playhead reaches it ──
      if (eventsKey !== p.edit) {
        eventsKey = p.edit;
        events = soundEvents(p, map);
      }
      if (!pb.playing || hardSeek) {
        for (const stop of started) stop();
        started = [];
      } else if (prevOut >= 0 && out >= prevOut && out - prevOut < 0.5) {
        for (const ev of events) {
          if (ev.at < prevOut) continue;
          if (ev.at >= out) break;
          if (ev.cue.builtin) started.push(playBuiltin(ev.cue.builtin, ev.cue.gain * pb.volume, ev.skip));
          else {
            const file = p.sources.find((x) => x.id === ev.cue.sourceId);
            if (file?.available) started.push(playFile(sourceUrl(pp, file), ev.cue.gain * pb.volume, ev.skip));
          }
        }
        if (started.length > 64) started = started.slice(-32);
      }
      prevOut = out;

      // ── draw ──
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const ap = p.edit.appearance;
      if (ap.background.type === 'image') {
        const bg = backgroundImage(ap.background.path);
        res.backgroundImage = bg ? drawableFromElement(bg) : null;
      }
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
        cues = burnInCues(p, map, buildCues);
      }
      let blend: DrawEnv['blend'] = null;
      if (tr?.wash) blend = { alpha: tr.wash.alpha, color: tr.wash.color };
      else if (partner) {
        blendCanvas ??= document.createElement('canvas');
        if (blendCanvas.width !== pw || blendCanvas.height !== ph) {
          blendCanvas.width = pw;
          blendCanvas.height = ph;
        }
        const bctx = blendCanvas.getContext('2d', { alpha: false })!;
        bctx.setTransform(pw / ap.output.width, 0, 0, ph / ap.output.height, 0, 0);
        partner.res.backgroundImage = res.backgroundImage;
        drawFrame(bctx, partner.state, partner.res, {
          appearance: ap,
          screenPoints: partner.screen?.pointWidth && partner.screen.pointHeight ? { width: partner.screen.pointWidth, height: partner.screen.pointHeight } : null,
          cue: null,
          device: deviceOf(ap).frame ? deviceKindFor(partner.screen) : null,
          luts: gradeLuts(pp, ap),
        });
        blend = { alpha: partner.alpha, image: blendCanvas };
      }
      drawFrame(ctx, state, res, {
        appearance: live.current.showCaptions ? ap : { ...ap, captions: { ...ap.captions, burnIn: false } },
        screenPoints: screen?.pointWidth && screen.pointHeight ? { width: screen.pointWidth, height: screen.pointHeight } : null,
        cue: ap.captions.burnIn ? cueAt(cues, out) : null,
        device: deviceOf(ap).frame ? deviceKindFor(screen) : null,
        editor: { selectedMaskId: live.current.selectedMaskId, selectedOverlayId: live.current.selectedOverlayId },
        luts: gradeLuts(pp, ap),
        blend,
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
      for (const m of matteEls.values()) {
        m.pause();
        m.removeAttribute('src');
        m.load();
      }
      for (const m of musicEls.values()) {
        m.el.pause();
        m.el.removeAttribute('src');
        m.el.load();
      }
      for (const stop of started) stop();
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
