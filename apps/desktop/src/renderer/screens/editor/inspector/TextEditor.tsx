import { TEXT_ANIMATIONS, TEXT_FONTS, TEXT_LIMITS, TEXT_TEMPLATES, textStyleOf, type Overlay, type Project, type TextAnimation, type TextFont, type TextStyle } from '@cutaway/core';
import { TEXT_FONT_CSS } from '../../../engine/textOverlay';
import { Icon } from '../../../ui/icons';
import { Button, Field, Segmented, Slider, Toggle } from '../../../ui/kit';
import { patchItem, removeSelected, toggleItemLock } from '../ops';
import { applyTextLook, duplicateText, patchTextStyle, setOverlaySound } from '../titleSoundOps';
import { CueField } from './CueField';
import { Section, TimesRow, pct } from './shared';
import './titles-sound.css';

const TEXT_COLORS = ['#ffffff', '#0b0c10', '#ff5a36', '#f5c542', '#7dd3c0', '#60a5fa', '#c4b5fd', '#f472b6'];
const PANEL_COLORS = ['#0b0c10', '#ffffff', '#ff5a36', '#f5c542', '#4d2ef5', '#0f766e', '#be185d', '#1d4ed8'];
const six = (hex: string) => (hex.length > 7 ? hex.slice(0, 7) : hex);

function Colors({ value, onChange, colors = TEXT_COLORS, label, none }: { value: string | null; onChange(c: string | null): void; colors?: string[]; label: string; none?: boolean }) {
  const cur = value ? six(value).toLowerCase() : null;
  return (
    <div className="te-colors" role="group" aria-label={label}>
      {none ? (
        <button className={`wall none${cur === null ? ' on' : ''}`} aria-pressed={cur === null} aria-label={`No ${label.toLowerCase()}`} title="None" onClick={() => onChange(null)}>
          <Icon name="x" size={12} />
        </button>
      ) : null}
      {colors.slice(0, none ? 6 : 7).map((c) => (
        <button key={c} className={`wall${cur === c ? ' on' : ''}`} style={{ background: c }} aria-pressed={cur === c} aria-label={`${label} ${c}`} onClick={() => onChange(c)} />
      ))}
      <label className="wall custom" title="Any colour" style={cur && !colors.includes(cur) ? { background: cur } : undefined}>
        <Icon name="plus" size={13} />
        <input type="color" value={cur ?? '#ff5a36'} onChange={(e) => onChange(e.target.value)} aria-label={`Custom ${label.toLowerCase()}`} />
      </label>
    </div>
  );
}

const secs = (v: number) => `${v.toFixed(2)}s`;
const ANIM_OPTIONS = TEXT_ANIMATIONS.map((a) => ({ value: a.id, label: a.name }));

function AnimField({ label, value, onType, onDuration }: { label: string; value: TextStyle['in']; onType(t: TextAnimation): void; onDuration(d: number): void }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <Field label={label}>
        <select className="select" value={value.type} onChange={(e) => onType(e.target.value as TextAnimation)} aria-label={label}>
          {ANIM_OPTIONS.map((a) => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
      </Field>
      {value.type !== 'none' ? <Slider min={TEXT_LIMITS.duration[0]} max={2} step={0.05} value={value.duration} format={secs} onChange={onDuration} label="Takes" /> : null}
    </div>
  );
}

/** Nine places a text is commonly put. The text can also be dragged on the preview. */
const SPOTS: { x: number; y: number; name: string }[] = [0.12, 0.5, 0.88].flatMap((y, r) => [0.06, 0.5, 0.94].map((x, c) => ({ x, y, name: `${['Top', 'Middle', 'Bottom'][r]} ${['left', 'centre', 'right'][c]}` })));

/** The editor for a free text overlay: words, look, place, motion and sound. */
export function TextEditor({ project, overlay: o }: { project: Project; overlay: Overlay }) {
  const s = textStyleOf(o);
  const set = (patch: Parameters<typeof patchTextStyle>[1], label: string, coalesce = true) => patchTextStyle(o, patch, label, coalesce);
  const font = TEXT_FONTS.find((f) => f.id === s.font)!;
  const place = (x: number, y: number) => {
    // keep the text's own alignment in step with the side it is pushed to
    const align = x < 0.3 ? 'left' : x > 0.7 ? 'right' : 'center';
    patchItem('overlays', o.id, { x, y, style: { ...s, align } }, 'Place text', false);
  };
  const atSpot = (p: { x: number; y: number }) => Math.abs(o.x - p.x) < 0.02 && Math.abs(o.y - p.y) < 0.02;
  return (
    <>
      <Section
        title="Text"
        action={
          <div className="row gap-2">
            <Button variant="ghost" size="sm" icon="copy" onClick={() => duplicateText(o.id)} aria-label="Duplicate" title="Duplicate this text" />
            <Button variant="ghost" size="sm" icon={o.meta.locked ? 'lock' : 'unlock'} on={!!o.meta.locked} onClick={() => toggleItemLock('overlays', o.id)} aria-label={o.meta.locked ? 'Unlock' : 'Lock'} title={o.meta.locked ? 'Locked: AI will not change this' : 'Lock so AI changes leave it alone'} />
            <Button variant="ghost" size="sm" icon="trash" onClick={removeSelected} aria-label="Remove" title="Remove (⌫)" />
          </div>
        }
      >
        <TimesRow project={project} range={o} />
        <Field label="Words">
          <textarea className="textarea te-textarea" data-testid="text-input" rows={2} value={o.text} maxLength={TEXT_LIMITS.text} onChange={(ev) => patchItem('overlays', o.id, { text: ev.target.value }, 'Edit text')} />
        </Field>
        <Field label="Second line">
          <input className="input" data-testid="text-sub-input" value={o.subtext ?? ''} maxLength={160} placeholder="Optional" onChange={(ev) => patchItem('overlays', o.id, { subtext: ev.target.value || undefined }, 'Edit text')} />
        </Field>
        <Field label="Start from a look">
          <select className="select" value="" onChange={(e) => e.target.value && applyTextLook(o, e.target.value)} aria-label="Use the look of a template">
            <option value="">Choose a template’s look…</option>
            {TEXT_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Font">
        <div className="te-fonts" role="group" aria-label="Font">
          {TEXT_FONTS.map((f) => (
            <button key={f.id} className="te-font" aria-pressed={s.font === f.id} title={`${f.name} · ${f.hint}`} onClick={() => set({ font: f.id as TextFont }, 'Font', false)}>
              <b style={{ fontFamily: TEXT_FONT_CSS[f.id], fontWeight: f.weights.includes(700) ? 700 : 400 }}>Aa</b>
              <small>{f.name.split(' ')[0]}</small>
            </button>
          ))}
        </div>
        <Slider label="Size" min={0.02} max={0.3} step={0.002} value={s.size} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(v) => set({ size: v }, 'Text size')} />
        {font.weights.length > 1 ? (
          <Field label="Weight">
            <Segmented full value={String(s.weight)} onChange={(w) => set({ weight: Number(w) }, 'Text weight', false)} options={font.weights.map((w) => ({ value: String(w), label: { 400: 'Regular', 500: 'Medium', 600: 'Semi', 700: 'Bold', 800: 'Heavy' }[w] ?? String(w) }))} />
          </Field>
        ) : null}
        <Field label="Colour">
          <Colors label="Text colour" value={s.color} onChange={(c) => c && set({ color: c }, 'Text colour')} />
        </Field>
        <div className="te-row2">
          <Field label="Align">
            <Segmented full value={s.align} onChange={(a) => set({ align: a }, 'Align text', false)} options={[{ value: 'left', label: '', icon: 'alignLeft', title: 'Left' }, { value: 'center', label: '', icon: 'alignCenter', title: 'Centre' }, { value: 'right', label: '', icon: 'alignRight', title: 'Right' }]} />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <Toggle label="ALL CAPS" checked={s.uppercase} onChange={(v) => set({ uppercase: v }, 'Capitals', false)} />
          </div>
        </div>
        <Slider label="Wrap width" min={0.15} max={1} step={0.01} value={s.width} format={pct} onChange={(v) => set({ width: v }, 'Wrap width')} />
        <div className="te-row2">
          <Slider label="Letter spacing" min={-0.06} max={0.3} step={0.005} value={s.tracking} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => set({ tracking: v }, 'Letter spacing')} />
          <Slider label="Line height" min={0.85} max={1.8} step={0.01} value={s.leading} format={(v) => v.toFixed(2)} onChange={(v) => set({ leading: v }, 'Line height')} />
        </div>
      </Section>

      <Section title="Place">
        <div className="te-place-row">
          <div className="te-place" role="group" aria-label="Position">
            {SPOTS.map((p) => (
              <button key={p.name} className={atSpot(p) ? 'on' : ''} title={p.name} aria-label={p.name} aria-pressed={atSpot(p)} onClick={() => place(p.x, p.y)} />
            ))}
          </div>
          <div className="te-hint">
            <Icon name="cursor" size={13} />
            <span>Or drag the text on the preview. It always stays inside the safe margins.</span>
          </div>
        </div>
      </Section>

      <Section title="Panel and edges">
        <Field label="Behind the text">
          <Segmented full value={s.background.shape} onChange={(shape) => set({ background: { shape } }, 'Text panel', false)} options={[{ value: 'none', label: 'Nothing' }, { value: 'box', label: 'Box' }, { value: 'pill', label: 'Pill' }]} />
        </Field>
        {s.background.shape !== 'none' ? (
          <>
            <Colors label="Panel colour" colors={PANEL_COLORS} value={s.background.color} onChange={(c) => c && set({ background: { color: c } }, 'Panel colour')} />
            <Slider label="Panel opacity" min={0.1} max={1} value={s.background.opacity} format={pct} onChange={(v) => set({ background: { opacity: v } }, 'Panel opacity')} />
          </>
        ) : null}
        <Slider label="Shadow" min={0} max={1} value={s.shadow} format={pct} onChange={(v) => set({ shadow: v }, 'Text shadow')} />
        <Slider label="Outline" min={0} max={0.2} step={0.005} value={s.outline.width} format={(v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}`)} onChange={(v) => set({ outline: { width: v } }, 'Text outline')} />
        {s.outline.width > 0 ? <Colors label="Outline colour" colors={PANEL_COLORS} value={s.outline.color} onChange={(c) => c && set({ outline: { color: c } }, 'Outline colour')} /> : null}
        <Field label="Accent line" hint={s.align === 'center' ? 'A short rule under the first line.' : 'A bar beside the text.'}>
          <Colors label="Accent" none value={s.accent} onChange={(c) => set({ accent: c }, 'Accent line')} />
        </Field>
        <Slider label="Dim the picture behind" min={0} max={0.95} value={s.scrim?.opacity ?? 0} format={(v) => (v === 0 ? 'Off' : pct(v))} onChange={(v) => set({ scrim: v > 0.01 ? { color: s.scrim?.color ?? '#08090d', opacity: v } : null }, 'Dim picture')} />
      </Section>

      {o.subtext ? (
        <Section title="Second line">
          <div className="te-sub">
            <Slider label="Size, next to the first line" min={0.2} max={1} step={0.01} value={s.sub.scale} format={pct} onChange={(v) => set({ sub: { scale: v } }, 'Second line size')} />
            <Field label="Font">
              <select className="select" value={s.sub.font} onChange={(e) => set({ sub: { font: e.target.value as TextFont } }, 'Second line font', false)} aria-label="Second line font">
                {TEXT_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </Field>
            <Colors label="Second line colour" value={s.sub.color} onChange={(c) => c && set({ sub: { color: c } }, 'Second line colour')} />
            <Toggle label="ALL CAPS" checked={s.sub.uppercase} onChange={(v) => set({ sub: { uppercase: v, tracking: v ? Math.max(s.sub.tracking, 0.1) : Math.min(s.sub.tracking, 0.02) } }, 'Second line capitals', false)} />
          </div>
        </Section>
      ) : null}

      <Section title="Motion">
        <div className="te-anim">
          <AnimField label="Arrives" value={s.in} onType={(type) => set({ in: { type } }, 'Text arrives', false)} onDuration={(duration) => set({ in: { duration } }, 'Arrival time')} />
          <AnimField label="Leaves" value={s.out} onType={(type) => set({ out: { type } }, 'Text leaves', false)} onDuration={(duration) => set({ out: { duration } }, 'Leaving time')} />
        </div>
        <div className="tiny dim">Motion is part of the video: it plays the same in the preview and in the export.</div>
      </Section>

      <Section title="Sound as it appears">
        <CueField value={o.sound ?? null} sources={project.sources} onChange={(cue, coalesce) => setOverlaySound(o.id, cue, coalesce)} />
      </Section>
    </>
  );
}
