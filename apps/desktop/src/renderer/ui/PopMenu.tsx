/**
 * A small menu or panel that opens next to a button (or at the pointer, for a right-click) and closes on
 * Escape or a click elsewhere. Used by the timeline's "+ Add" buttons, the selection toolbar and the
 * right-click menu on timeline blocks.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';
import './popmenu.css';

export type MenuItem = { label: string; icon?: IconName; hint?: string; danger?: boolean; disabled?: boolean; testId?: string; onClick(): void } | 'sep';

export interface Anchor {
  x: number;
  y: number;
  /** Open above the point (for things near the bottom of the window, like the timeline). */
  above?: boolean;
}

export const anchorOf = (el: Element, above = true): Anchor => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: above ? r.top - 6 : r.bottom + 6, above };
};

export function PopMenu({ anchor, onClose, items, children, label, width = 240 }: { anchor: Anchor; onClose(): void; items?: MenuItem[]; children?: ReactNode; label: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.x));
    const top = anchor.above ? Math.max(8, anchor.y - h) : Math.min(window.innerHeight - h - 8, anchor.y);
    setPos({ left, top });
  }, [anchor.x, anchor.y, anchor.above, width, items?.length]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') (e.stopPropagation(), onClose());
        return;
      }
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // the press that opened the menu must not close it
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close, true);
      window.addEventListener('keydown', close, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="popmenu" role={items ? 'menu' : 'dialog'} aria-label={label} style={{ left: pos.left, top: pos.top, width }}>
      {items?.map((it, i) =>
        it === 'sep' ? (
          <i key={`s${i}`} className="popmenu-sep" />
        ) : (
          <button
            key={it.label}
            role="menuitem"
            className={`popmenu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            data-testid={it.testId}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon ? <Icon name={it.icon} size={15} /> : <span style={{ width: 15 }} />}
            <span className="grow">{it.label}</span>
            {it.hint ? <kbd>{it.hint}</kbd> : null}
          </button>
        ),
      )}
      {children}
    </div>,
    document.body,
  );
}
