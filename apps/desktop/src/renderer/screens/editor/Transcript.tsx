import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { applyOps, fmtTime, proposePacing, sentences, type EditOp, type Project, type Range, type Word } from '@cutaway/core';
import { timeMapOf, useApp, usePlayback, useShownProject, readOnly } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Button, Empty } from '../../ui/kit';
import { cutRange, lockRange, restore, seekSource } from './ops';

interface WordView {
  word: Word;
  cut: boolean;
  locked: boolean;
}

const WordSpan = memo(function WordSpan({ w, text, selected, size }: { w: WordView; text: string; selected: boolean; size: number }) {
  const cls = ['w', w.cut ? 'cut' : '', w.word.kind === 'filler' ? 'filler' : '', selected ? 'sel' : '', w.locked ? 'locked' : '', text !== w.word.text ? 'fixed' : ''].filter(Boolean).join(' ');
  return (
    <>
      <span className={cls} data-w={w.word.id} style={{ fontSize: size }}>
        {text}
      </span>{' '}
    </>
  );
});

/**
 * Edit by text. Two deliberately separate actions:
 *   "Fix spelling" changes what the caption says and never removes footage;
 *   "Cut" removes the selected words' footage.
 */
export function Transcript() {
  const project = useShownProject();
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const textSize = useApp((s) => s.settings?.transcriptTextSize ?? 15);
  const comparing = useApp(readOnly);
  const [fixing, setFixing] = useState<{ id: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const t = project.transcript;
  const map = timeMapOf(project);

  const views = useMemo(() => {
    if (!t) return [];
    const locks = project.edit.locks;
    return t.words.map<WordView>((word) => {
      const mid = (word.start + word.end) / 2;
      return { word, cut: !map.isKept(mid), locked: locks.some((l) => mid >= l.start && mid < l.end) };
    });
  }, [t, map, project.edit.locks]);
  const byId = useMemo(() => new Map(views.map((v, i) => [v.word.id, i])), [views]);
  const paragraphs = useMemo(() => {
    if (!t) return [];
    const ss = sentences(t.words, 1.4);
    // group sentences into paragraphs at long pauses
    const out: { start: number; ids: string[] }[] = [];
    let cur: { start: number; ids: string[] } | null = null;
    let lastEnd = -10;
    for (const s of ss) {
      if (!cur || s.start - lastEnd > 2.2 || cur.ids.length > 90) {
        cur = { start: s.start, ids: [] };
        out.push(cur);
      }
      cur.ids.push(...s.wordIds);
      lastEnd = s.end;
    }
    return out;
  }, [t]);

  // "Remove N filler words" / "Tighten N pauses": the same safe rules as the first cut, applied on request.
  const tidy = useMemo(() => {
    if (!t?.hasSpeech) return { fillers: [] as EditOp[], pauses: [] as EditOp[] };
    const a = project.analysis;
    const ops = proposePacing({ duration: project.duration, words: t.words, hasSpeech: true, brief: { pacing: project.brief.pacing }, activity: a?.activity ?? [], activityHz: a?.activityHz || 4, clicks: a?.clicks ?? [], silences: a?.voiceLevelDb != null ? a.silences : undefined });
    const locks = project.edit.locks;
    const fresh = ops.filter((o) => o.op === 'cut' && map.isKept((o.start + o.end) / 2) && !locks.some((l) => o.start < l.end && o.end > l.start));
    return { fillers: fresh.filter((o) => o.op === 'cut' && o.kind === 'filler'), pauses: fresh.filter((o) => o.op === 'cut' && o.kind !== 'filler') };
  }, [t, project.analysis, project.duration, project.brief.pacing, project.edit.locks, map]);
  const applyTidy = (ops: EditOp[], label: string) => {
    const seconds = ops.reduce((s, o) => s + (o.end - o.start), 0);
    useApp.getState().edit((e, p) => applyOps(e, ops, 'creator', p.revision + 1), label);
    useApp.getState().toast(`Removed ${seconds.toFixed(1)}s — ⌘Z to undo`);
  };

  const selIds = selection?.kind === 'words' ? new Set(selection.ids) : null;

  // highlight the spoken word without re-rendering the transcript
  useEffect(() => {
    if (!t) return;
    let current: Element | null = null;
    const update = () => {
      const src = timeMapOf(project).toSource(usePlayback.getState().time);
      // binary search
      let lo = 0;
      let hi = t.words.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const w = t.words[mid]!;
        if (src < w.start) hi = mid - 1;
        else if (src >= w.end) lo = mid + 1;
        else {
          found = mid;
          break;
        }
      }
      const el = found >= 0 ? (bodyRef.current?.querySelector(`[data-w="${t.words[found]!.id}"]`) ?? null) : null;
      if (el === current) return;
      current?.classList.remove('now');
      el?.classList.add('now');
      current = el;
      if (el && usePlayback.getState().playing) {
        const body = bodyRef.current!;
        const r = (el as HTMLElement).offsetTop;
        if (r < body.scrollTop + 40 || r > body.scrollTop + body.clientHeight - 80) body.scrollTo({ top: r - body.clientHeight * 0.35, behavior: 'smooth' });
      }
    };
    update();
    return usePlayback.subscribe(update);
  }, [project, t]);

  const rangeOf = (a: string, b: string): { ids: string[]; range: Range } | null => {
    const i = byId.get(a);
    const j = byId.get(b);
    if (i === undefined || j === undefined) return null;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const ws = views.slice(lo, hi + 1).map((v) => v.word);
    const prev = views[lo - 1]?.word;
    const next = views[hi + 1]?.word;
    // take half of the surrounding gap so cuts do not clip neighbouring words
    const start = prev ? Math.max(prev.end, ws[0]!.start - Math.min(0.12, (ws[0]!.start - prev.end) / 2)) : Math.max(0, ws[0]!.start - 0.1);
    const end = next ? Math.min(next.start, ws[ws.length - 1]!.end + Math.min(0.12, (next.start - ws[ws.length - 1]!.end) / 2)) : ws[ws.length - 1]!.end + 0.1;
    return { ids: ws.map((w) => w.id), range: { start, end } };
  };

  const wordAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.('[data-w]')?.getAttribute('data-w') ?? null;
  const dragging = useRef(false);

  const transcribe = async () => {
    const app = useApp.getState();
    const voice = project.sources.find((s) => s.id === project.edit.audio.masterVoiceId) ?? project.sources.find((s) => s.hasAudio);
    if (!voice || !app.projectPath) return;
    setBusy(true);
    try {
      const { resolveSourcePath } = await import('@shared/api');
      const { markFillers, toSessionTime, uid } = await import('@cutaway/core');
      const r = await window.cutaway.native.transcribe(resolveSourcePath(app.projectPath, voice.path), app.settings?.transcription.locale ?? 'en-US');
      const words = markFillers(r.words.map((w) => ({ id: uid('w'), text: w.text, start: toSessionTime(voice.sync, w.start), end: toSessionTime(voice.sync, w.end), confidence: w.confidence, kind: 'word' as const })));
      app.patch((p) => ({ ...p, transcript: { engine: r.engine, locale: r.locale, onDevice: r.onDevice, sourceId: voice.id, hasSpeech: r.hasSpeech && words.length > 0, words, generatedAt: new Date().toISOString() } }));
    } catch (e) {
      app.toast(`Transcription failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!t) {
    return (
      <div className="transcript">
        <Empty icon="captions" title="Not transcribed yet" action={<Button icon="wave" busy={busy} onClick={() => void transcribe()} disabled={!project.sources.some((s) => s.hasAudio)}>Transcribe on this Mac</Button>}>
          {project.sources.some((s) => s.hasAudio) ? 'Speech is recognised on-device. Audio never leaves this Mac.' : 'This project has no audio track, so there is nothing to transcribe.'}
        </Empty>
      </div>
    );
  }
  if (!t.hasSpeech || t.words.length === 0) {
    return (
      <div className="transcript">
        <Empty icon="wave" title="No speech found">
          This is a silent recording, so there is no transcript and no caption file will be exported. Edit with the timeline; the first cut uses what happens on screen.
        </Empty>
      </div>
    );
  }

  const sel = selection?.kind === 'words' ? selection : null;
  const selViews = sel ? sel.ids.map((id) => views[byId.get(id)!]!).filter(Boolean) : [];
  const anyCut = selViews.some((v) => v.cut);
  const allCut = selViews.length > 0 && selViews.every((v) => v.cut);

  return (
    <div className="transcript">
      <div className="transcript-head">
        <div className="insp-group" style={{ margin: 0 }}>Edit by transcript</div>
        {tidy.fillers.length || tidy.pauses.length ? (
          <div className="col" style={{ gap: 6 }}>
            {tidy.fillers.length ? (
              <button className="btn block" disabled={comparing} title="Cuts stand-alone filler words such as um and uh. Words around them are untouched." onClick={() => applyTidy(tidy.fillers, 'Remove filler words')}>
                Remove {tidy.fillers.length} filler word{tidy.fillers.length === 1 ? '' : 's'}
              </button>
            ) : null}
            {tidy.pauses.length ? (
              <button className="btn block" disabled={comparing} title="Shortens silent pauses where nothing happens on screen. Waits with a visible result are kept." onClick={() => applyTidy(tidy.pauses, 'Tighten pauses')}>
                Tighten {tidy.pauses.length} pause{tidy.pauses.length === 1 ? '' : 's'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        className="transcript-body"
        ref={bodyRef}
        onPointerDown={(e) => {
          if (comparing) return;
          const id = wordAt(e.target);
          if (!id) return select(null);
          dragging.current = true;
          anchor.current = e.shiftKey && anchor.current ? anchor.current : id;
          const r = rangeOf(anchor.current, id);
          if (e.shiftKey && r) select({ kind: 'words', ...r });
        }}
        onPointerMove={(e) => {
          if (!dragging.current || !anchor.current) return;
          const id = wordAt(document.elementFromPoint(e.clientX, e.clientY));
          if (!id || id === anchor.current) return;
          const r = rangeOf(anchor.current, id);
          if (r) select({ kind: 'words', ...r });
        }}
        onPointerUp={(e) => {
          const wasDrag = dragging.current && selection?.kind === 'words' && selection.ids.length > 1;
          dragging.current = false;
          const id = wordAt(e.target);
          if (!id || wasDrag || e.shiftKey) return;
          const v = views[byId.get(id)!]!;
          const r = rangeOf(id, id);
          if (r) select({ kind: 'words', ...r });
          seekSource(project, v.word.start + 0.001);
        }}
        onDoubleClick={(e) => {
          const id = wordAt(e.target);
          if (id && !comparing) setFixing({ id, draft: project.edit.wordText[id] ?? views[byId.get(id)!]!.word.text });
        }}
      >
        {paragraphs.map((p) => (
          <div className="para" key={p.start}>
            <button className="tx-stamp mono" onClick={() => seekSource(project, p.start)} title="Jump here">
              {fmtTime(map.toOutput(p.start))}
            </button>
            <p>
              {p.ids.map((id) => {
                const v = views[byId.get(id)!]!;
                return <WordSpan key={id} w={v} text={project.edit.wordText[id] ?? v.word.text} selected={!!selIds?.has(id)} size={textSize} />;
              })}
            </p>
          </div>
        ))}
      </div>

      {sel && !comparing ? (
        <div className="transcript-actions" role="toolbar" aria-label="Selected text">
          <span className="tiny dim mono">
            {sel.ids.length} word{sel.ids.length === 1 ? '' : 's'} · {(sel.range.end - sel.range.start).toFixed(1)}s
          </span>
          <div className="grow" />
          {sel.ids.length === 1 ? (
            <Button size="sm" icon="pencil" onClick={() => setFixing({ id: sel.ids[0]!, draft: project.edit.wordText[sel.ids[0]!] ?? selViews[0]!.word.text })} title="Change the caption text only. No footage is removed.">
              Fix spelling
            </Button>
          ) : null}
          {anyCut ? (
            <Button size="sm" icon="undo" onClick={() => restore(sel.range)}>
              Restore
            </Button>
          ) : null}
          {!allCut ? (
            <Button size="sm" icon="scissors" onClick={() => cutRange(sel.range, 'transcript')} title="Remove this footage (⌫)">
              Cut
            </Button>
          ) : null}
          <Button size="sm" icon="lock" onClick={() => lockRange(sel.range, 'Keep this explanation intact')} title="AI changes will leave this alone">
            Keep
          </Button>
        </div>
      ) : (
        <div className="transcript-actions hint tiny dim">
          <Icon name="info" size={12} /> Click a word to jump. Drag to select, then cut, restore or keep. Double-click to fix spelling without cutting.
        </div>
      )}

      {fixing ? (
        <div className="fix-pop" role="dialog" aria-label="Fix spelling">
          <div className="eyebrow">Fix spelling · footage is not changed</div>
          <input
            className="input"
            autoFocus
            value={fixing.draft}
            onChange={(e) => setFixing({ ...fixing, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFixing(null);
              if (e.key === 'Enter') {
                const original = views[byId.get(fixing.id)!]!.word.text;
                const next = fixing.draft.trim();
                useApp.getState().edit((ed) => {
                  const wordText = { ...ed.wordText };
                  if (!next || next === original) delete wordText[fixing.id];
                  else wordText[fixing.id] = next;
                  return { ...ed, wordText };
                }, 'Fix spelling');
                setFixing(null);
              }
            }}
          />
          <div className="tiny dim">Enter to apply · Esc to cancel</div>
        </div>
      ) : null}
    </div>
  );
}

export function wordsIn(project: Project, range: Range): Word[] {
  return (project.transcript?.words ?? []).filter((w) => w.end > range.start && w.start < range.end);
}
