/**
 * The page an animation runs in. The animation's own HTML gets, at the top of its <head>:
 *
 *  - a Content-Security-Policy that allows inline styles and scripts and nothing from anywhere else
 *    (no network, no files), so a page written by an AI can only draw;
 *  - the creator's field values, as CSS custom properties, as the text of [data-field] elements and as
 *    `window.__fields`;
 *  - `window.__cutaway.seek(t)`: every CSS animation and Web Animation is paused and set to `t`, then the
 *    page's optional `window.__render(t)` draws; it resolves once that frame has been painted.
 *
 * Both the hidden window that renders frames and the live preview in the animation sheet use this, so
 * what is previewed is what is rendered.
 */

/** Bump when the runtime changes what a frame looks like: cached frames from older versions are not reused. */
export const MOTION_RUNTIME_VERSION = 1;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:";

function runtime(fields: Record<string, string>, autoplay: { duration: number } | null): string {
  return `(() => {
  const FIELDS = ${JSON.stringify(fields).replace(/</g, '\\u003c')};
  window.__fields = FIELDS;
  window.__errors = [];
  addEventListener('error', (e) => window.__errors.push(String((e && e.message) || e)));
  addEventListener('unhandledrejection', (e) => window.__errors.push(String(e && e.reason)));
  const root = document.documentElement;
  for (const [k, v] of Object.entries(FIELDS)) root.style.setProperty('--' + k, v);
  const fill = () => { for (const [k, v] of Object.entries(FIELDS)) document.querySelectorAll('[data-field="' + k + '"]').forEach((el) => { el.textContent = v; }); };
  document.addEventListener('DOMContentLoaded', fill);
  const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
  window.__cutaway = {
    ready: () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { fill(); return paint(); }),
    seek: (t) => {
      for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000; } catch (e) { window.__errors.push(String(e)); } }
      try { if (typeof window.__render === 'function') window.__render(t); } catch (e) { window.__errors.push(String((e && e.message) || e)); }
      return paint();
    },
    /** For checks: whether anything is visible at all. */
    painted: () => !!document.querySelector('body *'),
  };
  ${
    autoplay
      ? `addEventListener('load', () => { let t0 = null; const total = ${autoplay.duration} + 0.8;
    const step = (now) => { if (t0 === null) t0 = now; const t = ((now - t0) / 1000) % total; window.__cutaway.seek(Math.min(t, ${autoplay.duration})); requestAnimationFrame(step); };
    requestAnimationFrame(step); });`
      : ''
  }
})();`;
}

/**
 * The animation's HTML ready to load. `autoplay` makes it loop by itself (for a live preview); without it
 * the page waits for `__cutaway.seek(t)`.
 */
export function wrapMotion(html: string, fields: Record<string, string>, autoplay: { duration: number } | null = null): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><script>${runtime(fields, autoplay)}</script><style>html,body{margin:0;background:transparent!important;overflow:hidden}</style>`;
  // remove any policy of the page's own, so it cannot loosen ours, then put ours first
  const clean = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(clean)) return clean.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${clean}</body></html>`;
}
