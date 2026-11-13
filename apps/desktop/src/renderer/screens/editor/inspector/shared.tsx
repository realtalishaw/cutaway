import type { ReactNode } from 'react';
import { fmtTime, type Appearance, type DecisionMeta, type Project, type Range } from '@cutaway/core';
import { timeMapOf, useApp } from '../../../state/store';
import { Origin } from '../../../ui/kit';
import { Icon, type IconName } from '../../../ui/icons';

export const pct = (v: number) => `${Math.round(v * 100)}%`;

export function Section({ title, children, action, icon, group }: { title: string; children: ReactNode; action?: ReactNode; icon?: IconName; group?: string }) {
  return (
    <section className="insp-section">
      {group ? <div className="insp-group">{group}</div> : null}
      <div className="row between insp-title">
        <span className="row" style={{ gap: 8 }}>
          {icon ? <Icon name={icon} size={16} /> : null}
          <span className="insp-heading">{title}</span>
        </span>
        {action}
      </div>
      <div className="col gap-4">{children}</div>
    </section>
  );
}

export function Why({ meta }: { meta: DecisionMeta }) {
  return (
    <div className="why">
      <div className="row between">
        <Origin origin={meta.origin} locked={meta.locked} />
        {meta.confidence ? <span className="tiny dim">{meta.confidence} confidence</span> : null}
      </div>
      {meta.reason ? <div className="small muted" style={{ marginTop: 6 }}>{meta.reason}</div> : null}
    </div>
  );
}

export function TimesRow({ project, range }: { project: Project; range: Range }) {
  const map = timeMapOf(project);
  return (
    <div className="row between tiny dim mono">
      <span>
        {fmtTime(range.start, true)} – {fmtTime(range.end, true)}
      </span>
      <span title="Position in the finished video">→ {fmtTime(map.toOutput(range.start), true)}</span>
    </div>
  );
}

export const app = () => useApp.getState();
export const setAppearance = (fn: (a: Appearance) => Appearance, label: string, key: string) => app().edit((e) => ({ ...e, appearance: fn(e.appearance) }), label, `look:${key}`);


/** "Reset" link shown beside a control when it differs from its default. */
export function Reset({ show, onClick }: { show: boolean; onClick(): void }) {
  return (
    <button className="reset-link" disabled={!show} onClick={onClick}>
      Reset
    </button>
  );
}
