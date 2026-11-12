import { useEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'ai' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  on?: boolean;
  busy?: boolean;
};

export function Button({ variant = 'default', size = 'md', icon, on, busy, children, className = '', ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' ? variant : '', size !== 'md' ? size : '', !children ? 'icon' : '', on ? 'on' : '', className].filter(Boolean).join(' ');
  return (
    <button className={cls} aria-pressed={on} {...rest} disabled={rest.disabled || busy}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'lg' ? 17 : size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, full, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: IconName; title?: string; disabled?: boolean }[]; full?: boolean; label?: string }) {
  return (
    <div className={`seg${full ? ' full' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} aria-pressed={o.value === value} title={o.title} disabled={o.disabled} onClick={() => onChange(o.value)} style={o.disabled ? { opacity: 0.35 } : undefined}>
          {o.icon ? <Icon name={o.icon} size={13} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ label, value, min, max, step = 0.01, onChange, format, onCommit }: { label?: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; onCommit?: () => void }) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <label className="field">
      {label ? (
        <span className="label">
          {label}
          <span className="value">{format ? format(value) : value.toFixed(2)}</span>
        </span>
      ) : null}
      <input className="slider" type="range" min={min} max={max} step={step} value={value} aria-label={label} style={{ ['--p' as string]: `${p}%` } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} />
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className="row between" style={{ gap: 12, minHeight: 26 }}>
      <div className="col" style={{ gap: 1 }}>
        <span style={{ fontWeight: 520, fontSize: 12.5 }}>{label}</span>
        {hint ? <span className="tiny dim">{hint}</span> : null}
      </div>
      <button className="toggle" role="switch" aria-checked={checked} aria-label={typeof label === 'string' ? label : undefined} onClick={() => onChange(!checked)} />
    </div>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="tiny dim">{hint}</span> : null}
    </label>
  );
}

export function Modal({ title, eyebrow, children, footer, onClose, wide }: { title: ReactNode; eyebrow?: string; children: ReactNode; footer?: ReactNode; onClose?: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button.primary, input, textarea')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal ref={ref}>
        <div className="modal-head">
          {eyebrow ? <div className="eyebrow" style={{ marginBottom: 8 }}>{eyebrow}</div> : null}
          <div className="display h3">{title}</div>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Banner({ tone = 'info', title, children, action, icon }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  const ic: IconName = icon ?? (tone === 'warn' ? 'warn' : tone === 'danger' ? 'warn' : tone === 'ok' ? 'check' : 'info');
  const color = tone === 'warn' ? 'var(--ai)' : tone === 'danger' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok)' : 'var(--text-2)';
  return (
    <div className={`banner ${tone === 'info' ? '' : tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={ic} size={16} style={{ color, marginTop: 1 }} />
      <div className="grow">
        {title ? <div className="banner-title">{title}</div> : null}
        {children ? <div className="muted" style={{ marginTop: title ? 2 : 0 }}>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="col" style={{ alignItems: 'center', textAlign: 'center', padding: '36px 24px', gap: 10 }}>
      <div style={{ width: 44, height: 44, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--text-2)' }}>
        <Icon name={icon} size={20} />
      </div>
      <div style={{ fontWeight: 620, fontSize: 14 }}>{title}</div>
      {children ? <div className="muted" style={{ maxWidth: 380 }}>{children}</div> : null}
      {action}
    </div>
  );
}

/** Marks who made a decision. Shape + label, never colour alone. */
export function Origin({ origin, locked }: { origin: 'ai' | 'creator'; locked?: boolean }) {
  return (
    <span className={`pill ${origin === 'ai' ? 'ai' : 'you'}`}>
      <Icon name={locked ? 'lock' : origin === 'ai' ? 'sparkle' : 'pencil'} size={10} />
      {origin === 'ai' ? 'AI' : 'You'}
    </span>
  );
}

export function Meter({ db }: { db: number | null }) {
  const p = db === null ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
  const hot = db !== null && db > -6;
  return (
    <div style={{ height: 6, borderRadius: 6, background: 'var(--bg-4)', overflow: 'hidden', flex: 1 }} role="meter" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db ?? -60}>
      <div style={{ width: `${p * 100}%`, height: '100%', background: hot ? 'var(--accent)' : 'linear-gradient(90deg, var(--you), #d7e08a)', transition: 'width 70ms linear' }} />
    </div>
  );
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function fmtAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
