import { useEffect } from 'react';
import { SENSITIVE_LABEL, fmtTime, type SensitiveCategory } from '@cutaway/core';
import { useApp, useShownProject } from '../../state/store';
import { dismissFinding, findingsFor, hideFindings, scanSensitive, useSensitive, type Finding } from '../../state/sensitive';
import { Icon, type IconName } from '../../ui/icons';
import { Button } from '../../ui/kit';
import { seekSource } from './ops';

const ICON: Record<SensitiveCategory, IconName> = { email: 'user', 'api-key': 'lock', 'card-number': 'shield', password: 'eyeOff', phone: 'phone' };

/**
 * Looks for things worth hiding in the screen recording and lists them.
 * The creator decides for each one; nothing is masked without a click.
 */
export function SensitiveSheet({ onClose }: { onClose(): void }) {
  const project = useShownProject();
  const st = useSensitive();
  const findings = findingsFor(project);
  const open = findings.filter((f) => f.status === 'open');
  const scanning = st.status === 'scanning';
  const fresh = st.status === 'idle' || findings.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const hide = (ids: string[]) => {
    const n = hideFindings(ids);
    if (n) useApp.getState().toast(n === 1 ? 'Hidden with a blur. ⌘Z brings it back.' : `${n} areas hidden with a blur. ⌘Z brings them back.`);
  };

  const row = (f: Finding) => (
    <div key={f.id} className={`sens-row${f.status === 'open' ? '' : ' settled'}`} data-testid="sens-row" data-category={f.category} data-status={f.status} onClick={() => seekSource(project, Math.min(f.end - 0.05, f.start + Math.min(1, (f.end - f.start) / 2)))} title="Click to move the playhead there">
      <span className="sens-where" aria-hidden>
        <i style={{ left: `${f.rect.x * 100}%`, top: `${f.rect.y * 100}%`, width: `${f.rect.w * 100}%`, height: `${f.rect.h * 100}%` }} />
      </span>
      <Icon name={ICON[f.category]} size={15} style={{ color: 'var(--text-2)' }} />
      <div className="grow">
        <div>{SENSITIVE_LABEL[f.category]}</div>
        <div className="tiny dim mono">
          {fmtTime(f.start, true)} – {fmtTime(f.end, true)} · on screen for {(f.end - f.start).toFixed(0)}s
        </div>
      </div>
      {f.status === 'open' ? (
        <>
          <Button size="sm" variant="ghost" onClick={(e) => (e.stopPropagation(), dismissFinding(f.id))} data-testid="sens-dismiss">
            Leave it
          </Button>
          <Button size="sm" icon="mask" onClick={(e) => (e.stopPropagation(), hide([f.id]))} data-testid="sens-hide">
            Hide
          </Button>
        </>
      ) : (
        <span className="pill">{f.status === 'hidden' ? 'Hidden' : 'Left as is'}</span>
      )}
    </div>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal aria-label="Find sensitive data" data-testid="sensitive-sheet">
        <div className="modal-head">
          <div className="display h3">Find sensitive data</div>
        </div>
        <div className="modal-body">
          <p className="sens-intro" style={{ margin: 0 }}>
            Cutaway reads the text in your screen recording and looks for email addresses, API keys and tokens, card numbers, passwords and phone numbers. It runs on this Mac: no frame or text is sent anywhere, and the text itself is not kept. Nothing is hidden until you choose it.
          </p>

          {scanning ? (
            <div className="sens-progress" role="status" aria-live="polite" data-testid="sens-progress">
              <div className="row between">
                <span>
                  Reading the recording… {fmtTime(st.scannedSeconds)} of {fmtTime(st.totalSeconds)}
                </span>
                <button className="btn ghost sm" onClick={() => st.cancel?.()}>
                  Stop
                </button>
              </div>
              <div className="sens-bar">
                <i style={{ width: `${Math.round(st.progress * 100)}%` }} />
              </div>
            </div>
          ) : null}

          {st.status === 'failed' ? (
            <div className="qs-done error" role="alert" style={{ marginTop: 14 }}>
              <Icon name="warn" size={14} />
              <span className="grow">The recording could not be read: {st.error}</span>
            </div>
          ) : null}

          {!scanning && (st.status === 'done' || st.status === 'cancelled') && findings.length === 0 ? (
            <div className="sens-progress" data-testid="sens-empty">
              <span>
                {st.status === 'cancelled' ? `Stopped after ${fmtTime(st.scannedSeconds)}. Nothing was found in that part.` : 'Nothing that looks like an email address, key, card number, password or phone number was found in the parts of the recording that are in the video.'} This check can miss things, especially small or blurry text, so look over anything private yourself.
              </span>
            </div>
          ) : null}

          {findings.length ? (
            <>
              <div className="row between" style={{ marginTop: 16 }}>
                <span className="insp-heading" data-testid="sens-count">
                  {findings.length} found{open.length !== findings.length ? ` · ${open.length} to decide` : ''}
                  {st.status === 'cancelled' ? ` · stopped at ${fmtTime(st.scannedSeconds)}` : ''}
                </span>
                <Button size="sm" variant="primary" icon="mask" disabled={!open.length} onClick={() => hide(open.map((f) => f.id))} data-testid="sens-hide-all">
                  Hide all {open.length || ''}
                </Button>
              </div>
              <div className="sens-list">{findings.map(row)}</div>
              <div className="tiny dim" style={{ marginTop: 10 }}>
                Each hidden area becomes a blur mask on the timeline that you can move, resize or delete. A mask stays where the text was found; if the page scrolls, check that it still covers it.
              </div>
            </>
          ) : null}
        </div>
        <div className="modal-foot">
          <Button onClick={onClose}>Close</Button>
          <Button variant={fresh ? 'primary' : 'default'} icon="shield" busy={scanning} onClick={() => void scanSensitive()} data-testid="sens-scan">
            {scanning ? 'Scanning…' : fresh ? 'Scan the recording' : 'Scan again'}
          </Button>
        </div>
      </div>
    </div>
  );
}
