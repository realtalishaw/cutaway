import { Button, Modal } from '../../ui/kit';

/** Before fal.ai makes thumbnail pictures with the creator's own key: what is sent, and that it spends their credits. */
export function FalArtConsent({ onAllow, onDecline, onClose }: { onAllow(): void; onDecline(): void; onClose(): void }) {
  return (
    <Modal
      eyebrow="Before anything leaves this Mac · fal.ai"
      title={<>Make thumbnail pictures with fal.ai?</>}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onDecline} data-testid="consent-decline">Not now</Button>
          <Button variant="primary" icon="check" onClick={onAllow} data-autofocus data-testid="consent-allow">Allow fal.ai for this project</Button>
        </>
      }
    >
      <div className="col gap-4">
        <div className="well" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>What is sent</div>
          <div>A description of the picture: the concept's title, why it fits, and a few words you say in the video. No video, audio or stills.</div>
        </div>
        <div className="well" style={{ padding: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Cost</div>
          <div>Each picture uses your own fal.ai key and spends a little of your fal.ai credit. Pictures are made only when you ask.</div>
        </div>
      </div>
    </Modal>
  );
}
