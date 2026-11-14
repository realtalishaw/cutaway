import { useEffect, useRef, useState, type PointerEvent as RP } from 'react';
import { clipEnd, clipLength, clipTrim, clipsOf, playingClips, transitionBetween, transitionLabel, type Clip, type Project } from '@cutaway/core';
import { useApp } from '../../state/store';
import { moveClipTo, renameClipTo, trimClipTo } from './clipOps';
import { setEveryTransition } from './transitionOps';
import { TransitionField, TransitionGlyph } from './inspector/TransitionField';
import './clips.css';

function fmtLen(s: number): string {
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, '') : Math.round(s)}s`;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

/**
 * The clips of the video, one block each, in playing order. Drag a block
 * sideways to change the order, drag either end to trim, double-click to
 * rename. Everything that sits on a clip (cuts, zooms, text, words) moves
 * with it.
 */
export function ClipTrack({ project, pps, readOnly }: { project: Project; pps: number; readOnly: boolean }) {
  const clips = playingClips(clipsOf(project));
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  // while a block is being dragged: how far, and where it would land
  const [drag, setDrag] = useState<{ id: string; dx: number; index: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // the transition menu on a clip change: which pair, and where on screen
  const [join, setJoin] = useState<{ from: string; to: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!join) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement | null)?.closest?.('.tl-join-menu, .tl-join')) setJoin(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
    };
  }, [join]);
  const openJoin = join && clips.some((c, i) => c.id === join.to && clips[i - 1]?.id === join.from) ? join : null;
  const press = useRef<{ id: string; x: number; grab: number; moved: boolean } | null>(null);
  const trim = useRef<{ id: string; side: 'head' | 'tail'; x: number; from: number } | null>(null);

  const targetIndex = (id: string, t: number) => clips.filter((c) => c.id !== id && c.start + clipLength(c) / 2 < t).length;

  const down = (c: Clip) => (e: RP) => {
    if (e.button !== 0 || renaming) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const left = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().left;
    press.current = { id: c.id, x: e.clientX, grab: (e.clientX - left) / pps, moved: false };
    select({ kind: 'clip', id: c.id });
  };
  const move = (e: RP) => {
    const p = press.current;
    if (!p || readOnly) return;
    const dx = e.clientX - p.x;
    if (!p.moved && Math.abs(dx) < 5) return;
    p.moved = true;
    setDrag({ id: p.id, dx, index: targetIndex(p.id, p.grab + dx / pps) });
  };
  const up = () => {
    const p = press.current;
    press.current = null;
    const d = drag;
    setDrag(null);
    if (!p?.moved || !d) return;
    if (d.index !== clips.findIndex((c) => c.id === d.id)) moveClipTo(d.id, d.index);
  };

  const trimDown = (c: Clip, side: 'head' | 'tail') => (e: RP) => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const now = clipTrim(project.edit, c);
    trim.current = { id: c.id, side, x: e.clientX, from: side === 'head' ? now.head : now.tail };
    select({ kind: 'clip', id: c.id });
  };
  const trimMove = (e: RP) => {
    const t = trim.current;
    if (!t) return;
    const dt = (e.clientX - t.x) / pps;
    trimClipTo(t.id, t.side, Math.max(0, t.from + (t.side === 'head' ? dt : -dt)));
  };
  const trimUp = () => (trim.current = null);

  // where the dragged block would be dropped: the left edge of the clip it would come before
  const others = drag ? clips.filter((c) => c.id !== drag.id) : [];
  const dropAt = drag ? (drag.index < others.length ? others[drag.index]!.start : others.length ? clipEnd(others[others.length - 1]!) : 0) : 0;

  return (
    <div className={`tl-lane lane-clips${readOnly ? ' readonly' : ''}`} style={{ height: 30 }} data-testid="clip-track" aria-label="Clips, in playing order">
      <div className="tl-track">
        {clips.map((c, i) => {
          const len = clipLength(c);
          const w = Math.max(6, len * pps - 2);
          const t = clipTrim(project.edit, c);
          const selected = selection?.kind === 'clip' && selection.id === c.id;
          const dragging = drag?.id === c.id;
          const kept = len - t.head - t.tail;
          const title = `${c.name} · ${fmtLen(kept)}${t.head + t.tail > 0.01 ? ` (${fmtLen(t.head + t.tail)} trimmed)` : ''}. Drag to change the order, drag an end to trim, double-click to rename.`;
          return (
            <div
              key={c.id}
              className={`tl-clip${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
              style={{ left: c.start * pps, width: w, transform: dragging ? `translateX(${drag.dx}px)` : undefined }}
              data-testid="clip-block"
              data-clip-id={c.id}
              data-index={i}
              role="button"
              tabIndex={0}
              aria-label={`Clip ${i + 1} of ${clips.length}: ${c.name}, ${fmtLen(kept)}`}
              title={title}
              onPointerDown={down(c)}
              onPointerMove={move}
              onPointerUp={up}
              onDoubleClick={() => !readOnly && setRenaming(c.id)}
              onKeyDown={(e) => {
                if (renaming) return;
                if (e.key === 'Enter') select({ kind: 'clip', id: c.id });
                // Option-arrow moves the clip one place: reordering without a pointer
                else if (e.altKey && e.key === 'ArrowLeft' && !readOnly) (e.preventDefault(), e.stopPropagation(), moveClipTo(c.id, i - 1));
                else if (e.altKey && e.key === 'ArrowRight' && !readOnly) (e.preventDefault(), e.stopPropagation(), moveClipTo(c.id, i + 1));
              }}
            >
              {t.head > 0.01 ? <i className="tl-clip-trimmed" style={{ left: 0, width: t.head * pps }} /> : null}
              {t.tail > 0.01 ? <i className="tl-clip-trimmed" style={{ right: 0, width: t.tail * pps }} /> : null}
              {!readOnly && w > 18 ? <span className="tl-clip-handle l" style={{ left: t.head * pps }} data-testid="clip-trim-head" title="Drag to trim the start of this clip" onPointerDown={trimDown(c, 'head')} onPointerMove={trimMove} onPointerUp={trimUp} /> : null}
              {renaming === c.id ? (
                <input
                  className="tl-clip-name-input"
                  autoFocus
                  defaultValue={c.name}
                  aria-label="Clip name"
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (renameClipTo(c.id, e.currentTarget.value), setRenaming(null));
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => (renameClipTo(c.id, e.currentTarget.value), setRenaming(null))}
                />
              ) : (
                <span className="tl-clip-label" style={{ marginLeft: t.head * pps, marginRight: t.tail * pps }}>
                  <b>{i + 1}</b>
                  {w > 54 ? <span className="tl-clip-name">{c.name}</span> : null}
                  {w > 120 ? <small>{fmtLen(kept)}</small> : null}
                </span>
              )}
              {!readOnly && w > 18 ? <span className="tl-clip-handle r" style={{ right: t.tail * pps }} data-testid="clip-trim-tail" title="Drag to trim the end of this clip" onPointerDown={trimDown(c, 'tail')} onPointerMove={trimMove} onPointerUp={trimUp} /> : null}
            </div>
          );
        })}
        {drag
          ? null
          : clips.slice(1).map((c, i) => {
              const prev = clips[i]!;
              const t = transitionBetween(project, prev.id, c.id);
              const open = openJoin?.to === c.id;
              const what = t ? `${transitionLabel(t.kind)}, ${t.duration.toFixed(1)}s` : 'Hard cut';
              return (
                <button
                  key={`join-${c.id}`}
                  className={`tl-join${t ? ' set' : ''}${open ? ' open' : ''}`}
                  style={{ left: c.start * pps }}
                  data-testid="clip-join"
                  data-from={prev.id}
                  data-to={c.id}
                  data-kind={t?.kind ?? 'none'}
                  aria-label={`Transition from ${prev.name} to ${c.name}: ${what}`}
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  title={`${what} between “${prev.name}” and “${c.name}”. Click to change.`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    if (readOnly) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    setJoin(open ? null : { from: prev.id, to: c.id, x: Math.max(8, Math.min(window.innerWidth - 284, r.left + r.width / 2 - 138)), y: r.top });
                  }}
                >
                  <TransitionGlyph kind={t?.kind ?? null} size={10} />
                </button>
              );
            })}
        {drag ? <i className="tl-clip-drop" style={{ left: dropAt * pps }} /> : null}
        {openJoin ? (
          <div className="tl-join-menu" role="dialog" aria-label="Transition between these clips" data-testid="clip-join-menu" style={{ left: openJoin.x, bottom: window.innerHeight - openJoin.y + 8 }} onPointerDown={(e) => e.stopPropagation()}>
            <span className="eyebrow">Between these clips</span>
            <TransitionField from={openJoin.from} to={openJoin.to} />
            {clips.length > 2 ? (
              <div className="tr-all row" style={{ gap: 6 }}>
                <button
                  className="btn sm ghost"
                  data-testid="clip-join-all"
                  onClick={() => {
                    const t = transitionBetween(project, openJoin.from, openJoin.to);
                    setEveryTransition(t?.kind ?? null, t?.duration);
                    setJoin(null);
                  }}
                >
                  Use on every clip change
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
