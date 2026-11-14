/**
 * What is drawn inside a music block on the timeline: the file's waveform (shaped by the fades and the
 * volume points, so you see what you will hear), the volume line, and its points.
 *
 * Music lives on the output timeline while the ruler shows the recording, so every x here goes through
 * the time map: clip second → output second → recording second → pixel.
 */
import { useEffect, useRef, useState, type PointerEvent as RP } from 'react';
import { MAX_POINT_LEVEL, musicFade, musicSourceTime, volumeAt, type MusicClip, type Range, type TimeMap } from '@cutaway/core';
import { useApp } from '../../state/store';
import { PEAKS_HZ, useMusicPeaks } from '../../engine/musicPeaks';
import { moveVolumePoint, removeVolumePoint } from './titleSoundOps';

interface Props {
  clip: MusicClip;
  /** Where the block is drawn, in recording seconds. */
  range: Range;
  pps: number;
  map: TimeMap;
  height: number;
  selected: boolean;
  readOnly: boolean;
  /** Visible part of the timeline, in pixels from its start: only that much waveform is drawn. */
  view: { left: number; width: number };
}

const PAD = 4;

export function MusicBlock({ clip, range, pps, map, height, selected, readOnly, view }: Props) {
  const project = useApp((s) => s.project);
  const projectPath = useApp((s) => s.projectPath);
  const file = project?.sources.find((s) => s.id === clip.sourceId);
  const peaks = useMusicPeaks(projectPath, file);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const drag = useRef<{ index: number; left: number; top: number } | null>(null);

  const w = Math.max(3, (range.end - range.start) * pps);
  const xOf = (t: number) => (map.toSource(Math.min(map.outDuration, clip.start + t)) - range.start) * pps;
  const tOf = (x: number) => map.toOutput(range.start + x / pps) - clip.start;
  const yOf = (level: number) => height - PAD - (level / MAX_POINT_LEVEL) * (height - PAD * 2);
  const levelOf = (y: number) => ((height - PAD - y) / (height - PAD * 2)) * MAX_POINT_LEVEL;

  // waveform, only for the part of the block that is on screen
  const x0 = Math.max(0, view.left - range.start * pps);
  const x1 = Math.min(w, view.left + view.width - range.start * pps);
  const cw = Math.max(0, Math.round(x1 - x0));
  useEffect(() => {
    const c = canvas.current;
    if (!c || !peaks || cw <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(cw * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, height);
    ctx.fillStyle = 'rgba(214, 255, 236, 0.42)';
    const mid = height / 2;
    for (let px = 0; px < cw; px++) {
      const t = tOf(x0 + px + 0.5);
      if (t < 0 || t >= clip.length) continue;
      const at = musicSourceTime(clip, clip.start + t, file?.duration);
      const i = Math.floor(at * PEAKS_HZ);
      const p = peaks[i] ?? 0;
      // shaped by what the mix does to it, but not by the clip's overall level, so quiet music still reads
      const k = Math.min(1, musicFade(clip, t) * volumeAt(clip.volume, t));
      const h = Math.max(0.5, p * k * (height / 2 - 3));
      ctx.fillRect(px, mid - h, 1, h * 2);
    }
  }, [peaks, cw, x0, height, pps, clip, map, file?.duration]);

  const points = clip.volume ?? [];
  // the volume line: straight between points, level at the ends held
  const line = points.length
    ? [`0,${yOf(points[0]!.level)}`, ...points.map((v) => `${xOf(v.t)},${yOf(v.level)}`), `${w},${yOf(points[points.length - 1]!.level)}`].join(' ')
    : `0,${yOf(1)} ${w},${yOf(1)}`;

  const local = (e: { clientX: number; clientY: number }, d: { left: number; top: number }) => ({ x: e.clientX - d.left, y: e.clientY - d.top });
  const pointDown = (index: number) => (e: RP) => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { index, left: r.left, top: r.top };
    setActive(index);
    useApp.getState().select({ kind: 'music', id: clip.id });
  };
  const pointMove = (e: RP) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = local(e, d);
    // ⇧ keeps the point where it is in time and only changes its level
    const t = e.shiftKey ? points[d.index]!.t : tOf(x);
    moveVolumePoint(clip.id, d.index, t, levelOf(y));
  };
  const pointUp = () => {
    drag.current = null;
    setActive(null);
  };

  return (
    <span className="mu-block" data-testid="music-block" data-clip-id={clip.id}>
      {peaks && cw > 0 ? <canvas ref={canvas} className="mu-wave" style={{ left: x0, width: cw, height }} /> : null}
      <svg
        className={`mu-vol${selected ? ' on' : ''}`}
        width={w}
        height={height}
      >
        <polyline points={line} data-testid="music-volume-line" />
      </svg>
      {selected
        ? points.map((v, i) => (
            <i
              key={i}
              className={`mu-point${active === i ? ' active' : ''}`}
              style={{ left: xOf(v.t), top: yOf(v.level) }}
              data-testid="music-volume-point"
              title={`${Math.round(v.level * clip.gain * 100)}% · drag to change, ⇧ to keep it in place, double-click to remove`}
              onPointerDown={pointDown(i)}
              onPointerMove={pointMove}
              onPointerUp={pointUp}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!readOnly) removeVolumePoint(clip.id, i);
              }}
            />
          ))
        : null}
      {active !== null && points[active] ? (
        <b className="mu-readout" style={{ left: xOf(points[active]!.t), top: Math.max(0, yOf(points[active]!.level) - 22) }}>
          {Math.round(points[active]!.level * clip.gain * 100)}%
        </b>
      ) : null}
    </span>
  );
}
