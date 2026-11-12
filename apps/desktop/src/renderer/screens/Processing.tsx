import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { cancelJob, consentState, dismissJob, startFirstCut } from '../state/jobs';
import { Icon } from '../ui/icons';
import { Banner, Button } from '../ui/kit';
import './brief.css';

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Stage-by-stage progress. Percentages appear only when a stage can really measure them. */
export function Processing() {
  const job = useApp((s) => s.job);
  const project = useApp((s) => s.project);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!job) return null;
  const running = job.stages.find((s) => s.status === 'running');
  const slow = running?.startedAt && now - running.startedAt > 30000;
  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  const doneStages = job.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;

  return (
    <div className="page brief">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <div className="brief-head">
          <div className="eyebrow">{failed ? 'Stopped' : cancelled ? 'Cancelled' : 'Working on your footage'}</div>
          <h1 className="display h2">{failed ? <>A stage <em>did not finish.</em></> : cancelled ? <>Stopped where you asked.</> : <>Assembling the <em>first cut…</em></>}</h1>
          <p className="muted lede">
            {failed || cancelled ? 'Your sources and everything completed so far are safe. Finished stages are not repeated.' : `${doneStages} of ${job.stages.length || 6} stages done · ${elapsed(now - job.startedAt)} so far. You can leave this screen; the work continues.`}
          </p>
        </div>

        <div className="card stages">
          {job.stages.length === 0 ? (
            <div className="row muted"><span className="spinner" /> Starting…</div>
          ) : (
            job.stages.map((s) => (
              <div key={s.id} className={`stage-row ${s.status}`}>
                <span className="stage-dot" aria-hidden>
                  {s.status === 'done' ? <Icon name="check" size={12} /> : s.status === 'failed' ? <Icon name="x" size={12} /> : s.status === 'running' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : s.status === 'skipped' ? <Icon name="minus" size={12} /> : null}
                </span>
                <div className="grow">
                  <div className="row between">
                    <span className="stage-label">
                      {s.label}
                      {s.remote ? <span className="pill ai" style={{ marginLeft: 8 }} title="This stage sends transcript text, edit data and selected stills to Anthropic through Claude Code"><Icon name="upload" size={9} /> Uses Claude</span> : <span className="pill" style={{ marginLeft: 8 }}><Icon name="shield" size={9} /> On this Mac</span>}
                    </span>
                    <span className="tiny dim mono">
                      {s.status === 'running' && s.startedAt ? elapsed(now - s.startedAt) : s.status === 'done' && s.startedAt && s.endedAt ? elapsed(s.endedAt - s.startedAt) : s.status === 'skipped' ? 'already done' : ''}
                    </span>
                  </div>
                  {s.detail ? <div className="tiny dim" style={{ marginTop: 2 }}>{s.detail}</div> : null}
                  {s.status === 'running' ? (
                    <div className={`progress${s.progress === null ? ' indeterminate' : ''}`} style={{ marginTop: 8 }} role="progressbar" aria-valuenow={s.progress === null ? undefined : Math.round(s.progress * 100)}>
                      <i style={{ width: s.progress === null ? undefined : `${Math.round(s.progress * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        {slow && !failed && !cancelled ? (
          <Banner icon="clock" title="Still working">
            “{running!.label}” has not reported progress for a while. That is normal for long recordings; it cannot show a percentage because the work is not measurable in steps. You can keep waiting, look at your sources, or cancel safely.
          </Banner>
        ) : null}

        {failed && job.error ? (
          <Banner tone="danger" title={job.error.message}>
            Nothing was lost. {job.error.retryable ? 'Retry picks up at the failed stage.' : 'This needs a change before it can run again.'}
          </Banner>
        ) : null}

        <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
          {failed || cancelled ? (
            <>
              <Button onClick={() => (dismissJob(), useApp.getState().setView('edit'))}>Continue by hand</Button>
              <Button onClick={() => (dismissJob(), useApp.getState().setView('brief'))}>Back to the brief</Button>
              {!failed || job.error?.retryable ? (
                <Button variant="primary" icon="sync" onClick={() => (dismissJob(), void startFirstCut(consentState(project) === 'granted'))}>
                  {failed ? 'Retry from the failed stage' : 'Resume'}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => useApp.getState().setView('sources')}>Look at sources meanwhile</Button>
              <Button onClick={cancelJob}>Cancel safely</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
