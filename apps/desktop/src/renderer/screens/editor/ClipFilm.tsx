/**
 * Inside a clip on the simple timeline's video row: a strip of stills of what plays there, with the voice
 * drawn along the bottom, so a clip can be recognised at a glance. Only the part on screen is drawn.
 */
import { useEffect, useRef, useState } from 'react';
import { clipLength, type Clip, type Project } from '@cutaway/core';
import { useApp } from '../../state/store';
import { cachedStill, loadStill, pictureAt, stillKey } from '../../engine/filmstrip';

interface Props {
  project: Project;
  clip: Clip;
  pps: number;
  height: number;
  view: { left: number; width: number };
}

export function ClipFilm({ project, clip, pps, height, view }: Props) {
  const projectPath = useApp((s) => s.projectPath);
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  const w = Math.max(6, clipLength(clip) * pps - 2);
  const x0 = Math.max(0, view.left - clip.start * pps);
  const x1 = Math.min(w, view.left + view.width - clip.start * pps);
  const cw = Math.max(0, Math.round(x1 - x0));

  useEffect(() => {
    const c = ref.current;
    if (!c || cw <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const H = Math.round(height * dpr);
    c.width = Math.round(cw * dpr);
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, height);
    // tiles are 16:9 and start at the clip's left edge, so they do not slide while scrolling
    const tile = Math.max(24, Math.round((height * 16) / 9));
    const first = Math.floor(x0 / tile);
    const last = Math.ceil(x1 / tile);
    let missing = 0;
    for (let i = first; i < last; i++) {
      const tx = i * tile;
      const t = clip.start + Math.min(clipLength(clip) - 0.05, (tx + tile / 2) / pps);
      const pic = pictureAt(project, t);
      if (!pic || !projectPath) continue;
      const time = Math.round(pic.time * 10) / 10;
      const key = stillKey(pic.source.id, time, H);
      const still = cachedStill(key);
      if (still === undefined) {
        missing++;
        void loadStill(projectPath, project.sources, pic.source, time, H).then(() => setTick((n) => n + 1));
        continue;
      }
      if (!still) continue;
      // cover the tile, centred
      const sw = Math.min(still.width, (still.height * tile) / height);
      ctx.drawImage(still, (still.width - sw) / 2, 0, sw, still.height, tx - x0, 0, tile, height);
    }
    void missing;
    // a soft shade so the label and the voice read over any picture
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, 'rgba(8, 9, 13, 0.35)');
    g.addColorStop(0.45, 'rgba(8, 9, 13, 0)');
    g.addColorStop(1, 'rgba(8, 9, 13, 0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, height);
    // the voice along the bottom
    const wf = project.analysis?.waveform;
    const hz = project.analysis?.waveformHz ?? 20;
    if (wf?.length) {
      const band = height * 0.32;
      ctx.fillStyle = 'rgba(255, 214, 140, 0.75)';
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let px = 0; px <= cw; px += 2) {
        const t = clip.start + (x0 + px) / pps;
        ctx.lineTo(px, height - 1 - (wf[Math.floor(t * hz)] ?? 0) * band);
      }
      ctx.lineTo(cw, height);
      ctx.closePath();
      ctx.fill();
    }
  }, [project, clip, pps, height, x0, x1, cw, projectPath, tick]);

  return cw > 0 ? <canvas ref={ref} className="tl-clip-film" style={{ left: x0, width: cw, height }} aria-hidden /> : null;
}
