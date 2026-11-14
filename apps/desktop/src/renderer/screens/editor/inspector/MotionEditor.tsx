/** The selected animation: its words and colours, how its frames are coming along, and "change it" with AI. */
import { useEffect, useReducer, useState } from 'react';
import { fmtTime, motionPixels, motionValues, withFieldDefaults, type Overlay, type Project } from '@cutaway/core';
import { useApp } from '../../../state/store';
import { Button, Field } from '../../../ui/kit';
import { motionStatus, onMotionChange } from '../../../engine/motionFrames';
import { setMotionField } from '../../../motion/actions';
import { MotionPreview, MotionSheet } from '../MotionSheet';
import { removeSelected } from '../ops';
import { Section } from './shared';

export function MotionEditor({ project, overlay, pickTarget }: { project: Project; overlay: Overlay; pickTarget(what: 'motion-box' | null): void }) {
  const projectPath = useApp((s) => s.projectPath)!;
  const m = overlay.motion!;
  const [html, setHtml] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onMotionChange(tick), []);
  useEffect(() => void window.cutaway.motion.read(projectPath, m.file).then(setHtml).catch(() => setHtml(null)), [projectPath, m.file]);
  const out = project.edit.appearance.output;
  const status = motionStatus(projectPath, m, { width: out.width, height: out.height, fps: out.fps });
  const made = m.origin.kind === 'ai' ? `Written by ${m.origin.provider === 'codex' ? 'Codex' : 'Claude'} from “${m.origin.prompt}”` : 'Built-in template';
  return (
    <Section title={`Animation · ${m.name}`} action={<Button variant="ghost" size="sm" icon="trash" onClick={removeSelected} aria-label="Remove" title="Remove (⌫)" />}>
      <div className="row between tiny dim mono">
        <span>{fmtTime(overlay.start, true)} – {fmtTime(overlay.end, true)}</span>
        <span>{m.duration.toFixed(1)}s long{overlay.end - overlay.start > m.duration + 0.05 ? ', then holds' : ''}</span>
      </div>
      {html ? <MotionPreview html={html} fields={motionValues(m)} width={motionPixels(m, out.width, out.height).width} height={motionPixels(m, out.width, out.height).height} className={m.box ? 'boxed' : ''} /> : null}
      <div className="motion-render" data-testid="motion-render-status" data-state={status.state}>
        {status.state === 'rendering' ? (
          <>
            <span className="spinner" /> {status.total ? `Rendering frames for the preview and export: ${status.done} of ${status.total} (${Math.round((100 * status.done) / status.total)}%)` : 'Starting the renderer…'}
          </>
        ) : status.state === 'failed' ? (
          <span>Could not prepare the frames: {status.error}</span>
        ) : (
          <span>Ready. It plays in the preview and the export exactly like this.</span>
        )}
      </div>
      {m.fields.map((f) => (
        <Field key={f.id} label={f.label}>
          <input className="input" type={f.type === 'color' ? 'color' : f.type === 'number' ? 'number' : 'text'} value={f.value} onChange={(e) => setMotionField(overlay.id, f.id, e.target.value)} aria-label={f.label} data-testid={`motion-field-${f.id}`} />
        </Field>
      ))}
      {m.box ? (
        <div className="col" style={{ gap: 6 }}>
          <Button icon="cursor" onClick={() => pickTarget('motion-box')} data-testid="motion-place">Draw where it goes</Button>
          <div className="tiny dim">Or drag its box on the preview; drag the bottom-right corner to resize it.</div>
        </div>
      ) : null}
      <Button icon="sparkle" onClick={() => setRevising(true)} data-testid="motion-revise">Change it with AI…</Button>
      <Button
        icon="copy"
        data-testid="motion-save-template"
        disabled={!html}
        onClick={() =>
          html &&
          void window.cutaway.motion
            .saveTemplate(withFieldDefaults(html, motionValues(m), m.name), m.name)
            .then(() => useApp.getState().toast(`“${m.name}” is in your templates, with these words and colours. Use it in any project from + › Animation.`))
            .catch((e: unknown) => useApp.getState().toast(e instanceof Error ? e.message : String(e), 'error'))
        }
      >
        Save as template
      </Button>
      <div className="tiny dim">{made}. Drag the block on the timeline to move it; make it longer to hold the last frame.</div>
      {revising ? <MotionSheet editId={overlay.id} onClose={() => setRevising(false)} /> : null}
    </Section>
  );
}
