import { useMemo } from 'react';
import { fmtTime, restoreRevision, type DecisionMeta, type Project, type Range } from '@cutaway/core';
import { timeMapOf, useApp, useShownProject, type Selection } from '../../state/store';
import { Icon, type IconName } from '../../ui/icons';
import { Button, Empty, Origin } from '../../ui/kit';
import { accept, dismiss, restoreOne, seekSource } from './ops';

interface Row {
  key: string;
  icon: IconName;
  title: string;
  detail?: string;
  range: Range;
  meta: DecisionMeta;
  sel: Selection;
  removed?: boolean;
  action?: { label: string; run(): void };
}

function Times({ project, range, removed }: { project: Project; range: Range; removed?: boolean }) {
  const map = timeMapOf(project);
  return (
    <span className="times mono" title="Where this is in the recording → where it lands in the finished video">
      {fmtTime(range.start, true)} <Icon name="chevron" size={9} /> {removed ? 'removed' : fmtTime(map.toOutput(range.start), true)}
    </span>
  );
}

/** What the editor did, most consequential first, each linked to its source and output time. */
export function Review() {
  const project = useShownProject();
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const e = project.edit;
  const open = e.suggestions.filter((s) => s.status === 'open');
  const assetName = (id: string) => project.sources.find((s) => s.id === id)?.name ?? 'missing asset';

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const c of e.cuts) out.push({ key: c.id, icon: 'scissors', title: `${c.kind === 'filler' ? 'Filler removed' : c.kind === 'silence' ? 'Pause shortened' : c.kind === 'trim' ? 'Trimmed' : c.kind === 'retake' ? 'Retake removed' : 'Cut'} · ${(c.end - c.start).toFixed(1)}s`, detail: c.meta.reason, range: c, meta: c.meta, sel: { kind: 'cut', id: c.id }, removed: true, action: { label: 'Restore', run: () => restoreOne(c.id) } });
    for (const l of e.layouts) out.push({ key: l.id, icon: l.mode === 'split' ? 'split' : l.mode === 'camera' ? 'camera' : l.mode === 'screen' ? 'screen' : 'layout', title: `${l.mode === 'overlay' ? 'Screen + camera' : l.mode === 'camera' ? `Camera ${l.camera}` : l.mode === 'split' ? `Split with camera ${l.camera}` : 'Screen only'}`, detail: l.meta.reason, range: l, meta: l.meta, sel: { kind: 'layout', id: l.id } });
    for (const z of e.zooms) out.push({ key: z.id, icon: 'zoom', title: `Zoom ${z.scale.toFixed(1)}×`, detail: z.meta.reason, range: z, meta: z.meta, sel: { kind: 'zoom', id: z.id } });
    for (const o of e.overlays) out.push({ key: o.id, icon: 'text', title: `“${o.text}”`, detail: o.meta.reason ?? o.kind, range: o, meta: o.meta, sel: { kind: 'overlay', id: o.id } });
    for (const b of e.broll) out.push({ key: b.id, icon: 'broll', title: `B-roll · ${assetName(b.assetId)}`, detail: b.meta.reason, range: b, meta: b.meta, sel: { kind: 'broll', id: b.id } });
    for (const s of e.speeds) out.push({ key: s.id, icon: 'speed', title: `${s.speed}× speed`, detail: s.meta.reason, range: s, meta: s.meta, sel: { kind: 'speed', id: s.id } });
    return out.sort((a, b) => a.range.start - b.range.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e, project.sources]);

  const weight = (r: Row) => (r.meta.confidence === 'low' ? 0 : r.meta.confidence === 'medium' ? 1 : 2);
  const uncertain = rows.filter((r) => r.meta.origin === 'ai' && weight(r) < 2);
  const rest = rows.filter((r) => !(r.meta.origin === 'ai' && weight(r) < 2));
  const removedSeconds = e.cuts.reduce((s, c) => s + (c.end - c.start), 0);
  const isSel = (sel: Selection) => !!sel && !!selection && 'id' in sel && 'id' in selection && sel.kind === selection.kind && sel.id === selection.id;

  const row = (r: Row) => (
    <div key={r.key} className={`review-row${isSel(r.sel) ? ' selected' : ''}`} role="button" tabIndex={0} onClick={() => (select(r.sel), seekSource(project, r.removed ? Math.max(0, r.range.start - 1.2) : r.range.start + 0.05))} onKeyDown={(ev) => ev.key === 'Enter' && select(r.sel)}>
      <span className={`review-icon ${r.meta.origin === 'ai' ? 'ai' : 'you'}`}>
        <Icon name={r.icon} size={13} />
      </span>
      <div className="grow">
        <div className="row between">
          <span className="review-title">{r.title}</span>
          <Times project={project} range={r.range} removed={r.removed} />
        </div>
        {r.detail ? <div className="tiny dim">{r.detail}</div> : null}
      </div>
      {r.action ? (
        <Button size="sm" variant="ghost" onClick={(ev) => (ev.stopPropagation(), r.action!.run())}>
          {r.action.label}
        </Button>
      ) : null}
    </div>
  );

  if (!project.firstCut && rows.length === 0 && open.length === 0) {
    return (
      <div className="review">
        <Empty icon="sparkle" title="No first cut yet" action={<Button variant="ai" icon="sparkle" onClick={() => useApp.getState().setView('brief')}>Create first cut</Button>}>
          This is the raw recording. You can edit by hand right away, or let Cutaway assemble a first cut for you to review.
        </Empty>
      </div>
    );
  }

  return (
    <div className="review">
      {project.firstCut ? (
        <div className="review-summary">
          <div className="row between">
            <span className={`pill ${project.firstCut.mode === 'claude' ? 'ai' : ''}`}>
              <Icon name="sparkle" size={10} /> {project.firstCut.mode === 'claude' ? 'Assembled with Claude' : 'Assembled with built-in rules'}
            </span>
            <span className="tiny dim mono">{removedSeconds.toFixed(0)}s removed</span>
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>{project.firstCut.summary}</p>
        </div>
      ) : null}

      {open.length ? (
        <section>
          <div className="eyebrow review-head">Your call · {open.length}</div>
          {open.map((s) => (
            <div key={s.id} className="suggestion">
              <div className="row between">
                <span className="review-title">{s.title}</span>
                <Times project={project} range={s} />
              </div>
              <div className="small muted" style={{ margin: '4px 0 8px' }}>{s.reason}</div>
              <div className="row">
                <Button size="sm" variant="ghost" icon="play" onClick={() => seekSource(project, Math.max(0, s.start - 0.5))}>Play it</Button>
                <div className="grow" />
                <Button size="sm" onClick={() => dismiss(s.id)}>{s.apply.length ? 'Keep both' : 'Dismiss'}</Button>
                {s.apply.length ? <Button size="sm" variant="ai" icon="check" onClick={() => accept(s.id)}>{s.kind === 'retake' ? 'Remove retake' : 'Apply'}</Button> : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {uncertain.length ? (
        <section>
          <div className="eyebrow review-head">Less certain · {uncertain.length}</div>
          {uncertain.map(row)}
        </section>
      ) : null}

      <section>
        <div className="eyebrow review-head">All decisions · {rest.length}</div>
        {rest.length ? rest.map(row) : <div className="tiny dim" style={{ padding: '6px 12px' }}>Nothing else has been changed.</div>}
      </section>
    </div>
  );
}

export function History() {
  const project = useShownProject();
  const revisions = [...project.revisions].sort((a, b) => b.revision - a.revision);
  if (revisions.length === 0) {
    return (
      <div className="review">
        <Empty icon="history" title="No checkpoints yet">
          A checkpoint is saved before and after every AI change, so you can always get an earlier cut back. Undo covers everything in between.
        </Empty>
      </div>
    );
  }
  return (
    <div className="review">
      <div className="eyebrow review-head">Checkpoints</div>
      {revisions.map((r) => (
        <div key={`${r.revision}-${r.label}`} className="review-row">
          <span className={`review-icon ${r.origin === 'ai' ? 'ai' : 'you'}`}>
            <Icon name={r.origin === 'ai' ? 'sparkle' : 'history'} size={13} />
          </span>
          <div className="grow">
            <div className="row between">
              <span className="review-title">{r.label}</span>
              <Origin origin={r.origin} />
            </div>
            <div className="tiny dim">
              {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {r.summary}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const app = useApp.getState();
              if (!app.project) return;
              app.replace(restoreRevision(app.project, r.revision), `Restore “${r.label}”`);
              app.toast(`Restored “${r.label}”. Undo brings back what you had.`);
            }}
          >
            Restore
          </Button>
        </div>
      ))}
    </div>
  );
}
