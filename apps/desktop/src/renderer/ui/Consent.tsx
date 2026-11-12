import { disclosure } from '@cutaway/ai';
import { AI_SCOPE } from '../state/jobs';
import { Icon } from './icons';
import { Button, Modal } from './kit';

/** Shown before anything is sent off this Mac. Declining sends nothing. */
export function ConsentSheet({ onAllow, onDecline, onClose, purpose }: { onAllow(): void; onDecline(): void; onClose(): void; purpose: string }) {
  const d = disclosure(AI_SCOPE);
  return (
    <Modal
      eyebrow="Before anything leaves this Mac"
      title={<>Use Claude for {purpose}?</>}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onDecline}>Stay on this Mac</Button>
          <Button variant="primary" icon="check" onClick={onAllow} data-autofocus>Allow for this project</Button>
        </>
      }
    >
      <div className="col gap-4">
        <div className="well" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Where it goes</div>
          <div>{d.destination}. The model does not run on this Mac.</div>
        </div>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="well" style={{ padding: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--ai)' }}>What is sent</div>
            <div className="col" style={{ gap: 6 }}>
              {d.leaves.map((l) => (
                <div key={l} className="row small" style={{ alignItems: 'flex-start' }}><Icon name="upload" size={13} style={{ marginTop: 2, color: 'var(--ai)' }} /> <span>{l}</span></div>
              ))}
            </div>
          </div>
          <div className="well" style={{ padding: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--you)' }}>What stays here</div>
            <div className="col" style={{ gap: 6 }}>
              {d.stays.map((l) => (
                <div key={l} className="row small" style={{ alignItems: 'flex-start' }}><Icon name="shield" size={13} style={{ marginTop: 2, color: 'var(--you)' }} /> <span>{l}</span></div>
              ))}
            </div>
          </div>
        </div>
        <div className="col small muted" style={{ gap: 6 }}>
          <div><b style={{ color: 'var(--text)' }}>Why.</b> {d.purpose}</div>
          <div><b style={{ color: 'var(--text)' }}>Cost.</b> {d.cost}</div>
          <div><b style={{ color: 'var(--text)' }}>Retention.</b> {d.retention}</div>
          <div>{d.decline}</div>
        </div>
      </div>
    </Modal>
  );
}
