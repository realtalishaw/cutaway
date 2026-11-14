/**
 * Add an animation: pick a template, or describe one and let Claude Code or Codex write it. Also changes an
 * animation already on the timeline ("make the confetti gold"). Everything is previewed live before it is
 * added, and each change is one undoable step.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { motionPixels, parseMotionMeta, type MotionField } from '@cutaway/core';
import { useApp, useProject } from '../../state/store';
import { Icon } from '../../ui/icons';
import { Banner, Button, Modal, Segmented } from '../../ui/kit';
import { authorMotion, type MotionStep } from '../../motion/author';
import { addMotion, reviseMotion } from '../../motion/actions';
import { MOTION_TEMPLATES, ownTemplates, type MotionTemplate } from '../../motion/templates';
import './motion.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e));
const EXAMPLES = ['A subscribe button that gets clicked, turns into Subscribed, and confetti bursts', 'A big number counting up from 0 to 10,000 with “views” under it', 'A Vox-style yellow highlighter sweeping under the words “It works”', 'A name tag that slides in from the left: “Talisha White — Creator”'];

/** A live, looping preview of an animation page, in a sandboxed frame that can only draw. */
export function MotionPreview({ html, fields, width, height, className = '' }: { html: string; fields: Record<string, string>; width: number; height: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  const duration = useMemo(() => parseMotionMeta(html).meta?.duration ?? 4, [html]);
  const [src, setSrc] = useState<string | null>(null);
  const fieldsKey = JSON.stringify(fields);
  useEffect(() => {
    let live = true;
    void window.cutaway.motion.preview(html, fields, duration).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [html, fieldsKey, duration]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={box} className={`motion-preview ${className}`} style={{ aspectRatio: `${width} / ${height}`, ...(className.includes('boxed') ? { maxWidth: `${Math.round((260 * width) / height)}px`, margin: '0 auto' } : null) }}>
      {src ? <iframe title="Animation preview" sandbox="allow-scripts" src={src} style={{ width, height, transform: `scale(${scale})` }} /> : null}
    </div>
  );
}

const valuesOf = (fields: MotionField[]) => Object.fromEntries(fields.map((f) => [f.id, f.value]));

/** `request` opens on Describe it with that request, and starts writing it; `at` (session time) is where it goes. */
/** The steps of making an animation: done ones with how they went, the current one live with its time. */
function MotionSteps({ steps, live = false }: { steps: MotionStep[]; live?: boolean }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [live]);
  return (
    <ol className={`motion-steps${live ? ' live' : ''}`} data-testid="motion-steps" aria-live="polite">
      {steps.map((x) => (
        <li key={x.id} className={x.state} data-state={x.state} data-step={x.id}>
          <span className="motion-step-mark">{x.state === 'active' ? <span className="spinner" /> : <Icon name={x.state === 'done' ? 'check' : 'x'} size={11} />}</span>
          <div className="grow">
            <div className="row between">
              <b>{x.label}</b>
              <span className="tiny dim mono">{Math.max(0, Math.round(((x.ms ?? Date.now() - x.startedAt) as number) / 1000))} s</span>
            </div>
            {x.detail ? <div className="tiny dim">{x.detail}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function MotionSheet({ editId, request: asked, at = null, onClose }: { editId?: string; request?: string; at?: number | null; onClose(): void }) {
  const project = useProject();
  const projectPath = useApp((s) => s.projectPath)!;
  const claude = useApp((s) => s.claude);
  const { width, height } = project.edit.appearance.output;
  const editing = editId ? project.edit.overlays.find((o) => o.id === editId && o.motion) : undefined;
  const [tab, setTab] = useState<'templates' | 'describe'>(editing || asked ? 'describe' : 'templates');
  const [pick, setPick] = useState(MOTION_TEMPLATES[0]!.id);
  const [own, setOwn] = useState<MotionTemplate[]>([]);
  useEffect(() => void ownTemplates().then(setOwn), []);
  const all = [...MOTION_TEMPLATES, ...own];
  const [request, setRequest] = useState(asked ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [steps, setSteps] = useState<MotionStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ html: string; problems: string[]; provider: string; request: string } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // changing an animation starts from its current page
  useEffect(() => {
    if (editing?.motion) void window.cutaway.motion.read(projectPath, editing.motion.file).then(setCurrent).catch((e) => setError(errorText(e)));
  }, [editing?.motion?.file, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => ctrl.current?.abort(), []);

  const template = all.find((t) => t.id === pick) ?? MOTION_TEMPLATES[0]!;
  const tplMeta = useMemo(() => parseMotionMeta(template.html).meta, [template.html]);
  // a boxed template is previewed at its box's shape
  const tplSize = motionPixels({ box: tplMeta?.box ?? undefined }, width, height);
  const tplFields = useMemo(() => parseMotionMeta(template.html).meta?.fields ?? [], [template.html]);
  const [tplValues, setTplValues] = useState<Record<string, string>>({});
  useEffect(() => setTplValues(valuesOf(tplFields)), [tplFields]);
  const madeFields = useMemo(() => (made ? valuesOf(parseMotionMeta(made.html).meta?.fields ?? []) : {}), [made]);
  const base = made?.html ?? current ?? null;
  const aiName = claude?.provider === 'codex' ? 'Codex' : 'Claude Code';
  const aiReady = !!claude?.found && claude.signedIn !== false;

  const generate = async () => {
    const text = request.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    ctrl.current = new AbortController();
    try {
      setSteps([]);
      const r = await authorMotion({ project, request: text, previous: made?.html ?? current, signal: ctrl.current.signal, onStatus: setStatus, onSteps: setSteps });
      setMade({ html: r.html, problems: r.check.ok ? [] : r.check.errors, provider: r.provider, request: text });
      setRequest('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  // a request handed over (from Ask AI) starts at once
  const started = useRef(false);
  useEffect(() => {
    if (!asked || started.current || !aiReady) return;
    started.current = true;
    void generate();
  }, [aiReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === 'templates' && !editing) {
        await addMotion(template.html, { kind: 'template', template: template.id }, tplValues, at);
        if (template.boxed) useApp.getState().toast('Drag its box on the preview to put it over what you mean, or use “Draw where it goes” in the panel.');
      } else if (made) {
        if (editing) await reviseMotion(editing.id, made.html, made.request, made.provider);
        else await addMotion(made.html, { kind: 'ai', provider: made.provider, prompt: made.request }, {}, at);
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Change “${editing.motion!.name}”` : 'Add an animation'}
      wide
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <span className="tiny dim grow" style={{ alignSelf: 'center' }}>{busy ? status : tab === 'describe' ? `Written by ${aiName} with your own subscription. Only what you type is sent.` : 'Edit the words and colours any time after adding it.'}</span>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          {busy && ctrl.current ? <Button onClick={() => ctrl.current?.abort()}>Stop</Button> : null}
          <Button variant="primary" icon={editing ? 'check' : 'plus'} data-testid="motion-add" disabled={busy || (tab === 'describe' && !made)} onClick={() => void add()}>
            {editing ? 'Use this version' : 'Add at the playhead'}
          </Button>
        </>
      }
    >
      <div className="motion-sheet" data-testid="motion-sheet">
        {!editing ? <Segmented value={tab} onChange={setTab} options={[{ value: 'templates', label: 'Templates' }, { value: 'describe', label: 'Describe it' }]} label="How" full /> : null}
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {tab === 'templates' && !editing ? (
          <div className="motion-tpl">
            <div className="motion-tpl-list">
              {all.map((t, i) => (
                <div key={t.id} className="motion-tpl-row">
                  {t.own && !all[i - 1]?.own ? <span className="eyebrow">Yours</span> : i === 0 ? <span className="eyebrow">Built in</span> : null}
                  <button className={`motion-tpl-card${t.id === pick ? ' on' : ''}`} onClick={() => setPick(t.id)} data-testid={`motion-tpl-${t.id}`}>
                    <b>
                      {t.name}
                      {t.boxed ? <small className="motion-tag">box</small> : null}
                    </b>
                    <span className="tiny dim">{t.description}</span>
                  </button>
                  {t.own ? (
                    <button className="motion-tpl-remove" title="Remove this template" aria-label={`Remove ${t.name}`} onClick={() => void window.cutaway.motion.removeTemplate(t.id).then(() => ownTemplates().then((o) => (setOwn(o), setPick(MOTION_TEMPLATES[0]!.id))))}>
                      <Icon name="trash" size={12} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="motion-tpl-main">
              <MotionPreview html={template.html} fields={tplValues} width={tplSize.width} height={tplSize.height} className={template.boxed ? 'boxed' : ''} />
              {template.boxed ? <div className="tiny dim">Goes in a box you place over your video: drag it on the preview after adding.</div> : null}
              <div className="motion-fields">
                {tplFields.map((f) => (
                  <label key={f.id} className="field">
                    <span className="field-label">{f.label}</span>
                    <input className="input" type={f.type === 'color' ? 'color' : 'text'} value={tplValues[f.id] ?? f.value} onChange={(e) => setTplValues({ ...tplValues, [f.id]: e.target.value })} aria-label={f.label} />
                  </label>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="motion-describe">
            {!aiReady ? <Banner tone="warn" title={`${aiName} is not ready`}>{claude?.message ?? 'Set up Claude Code or Codex in Settings › Processing to describe animations.'}</Banner> : null}
            {busy && steps.length ? <MotionSteps steps={steps} live /> : base ? <MotionPreview html={base} fields={made ? madeFields : editing?.motion ? valuesOf(editing.motion.fields) : {}} {...(() => { const b = editing?.motion?.box ?? parseMotionMeta(base).meta?.box ?? undefined; const px = motionPixels({ box: b }, width, height); return { width: px.width, height: px.height, className: b ? 'boxed' : '' }; })()} /> : <div className="motion-empty"><Icon name="sparkle" size={18} /> Describe the animation you want. It is drawn over your video.</div>}
            {!busy && steps.length ? (
              <details className="motion-steps-done" data-testid="motion-steps-done">
                <summary>How it was made · {Math.round(steps.reduce((t, x) => t + (x.ms ?? 0), 0) / 1000)} s</summary>
                <MotionSteps steps={steps} />
              </details>
            ) : null}
            {made?.problems.length ? <Banner tone="warn" title="It still has problems">{made.problems.slice(0, 3).join(' ')} You can add it anyway, or describe a fix.</Banner> : null}
            <textarea className="input motion-request" rows={3} data-testid="motion-request" placeholder={base ? 'Change it: “make the confetti gold and slower”' : EXAMPLES[0]} value={request} onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void generate()} />
            {!base ? (
              <div className="motion-examples">
                {EXAMPLES.map((x) => (
                  <button key={x} className="chip" onClick={() => setRequest(x)}>{x}</button>
                ))}
              </div>
            ) : null}
            <div className="row">
              <Button icon="sparkle" data-testid="motion-generate" disabled={!request.trim() || busy || !aiReady} busy={busy} onClick={() => void generate()}>
                {base ? 'Change it' : 'Make it'}
              </Button>

            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
