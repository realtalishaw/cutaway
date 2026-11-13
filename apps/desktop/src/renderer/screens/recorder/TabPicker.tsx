import { useCallback, useEffect, useState } from 'react';
import type { BrowserInfo, BrowserTab, BrowserTabList } from '@shared/api';
import { Icon } from '../../ui/icons';
import { Button } from '../../ui/kit';
import './recorder.css';

export interface TabChoice {
  bundleId: string;
  browser: string;
  window: number;
  tab: number;
  title: string;
  host: string;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Open tabs of the running browsers. macOS asks, once per browser, whether
 * Cutaway may see its tabs; nothing is asked until the creator presses the
 * button for that browser. Only titles and host names are shown.
 */
export function TabPicker({ choice, onPick, busy }: { choice: TabChoice | null; onPick: (c: TabChoice) => void; busy: boolean }) {
  const [list, setList] = useState<BrowserTabList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState<string | null>(null);

  const load = useCallback(async (ask?: string) => {
    if (ask) setAsking(ask);
    try {
      setList(await window.cutaway.native.browserTabs(ask));
      setError(null);
    } catch (e) {
      setError(text(e));
    } finally {
      setLoading(false);
      setAsking(null);
    }
  }, []);

  useEffect(() => {
    void load();
    // Tabs open and close while this is up; coming back to the window is a good moment to look again.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const row = (b: BrowserInfo, t: BrowserTab) => {
    const selected = !!choice && choice.bundleId === b.bundleId && choice.window === t.window && choice.tab === t.tab;
    const hidden = t.windowId === undefined;
    return (
      <button key={`${b.bundleId}-${t.window}-${t.tab}`} className="tab-row" role="radio" aria-checked={selected} disabled={hidden || busy} title={hidden ? 'This window is minimised or on another desktop. Bring it back to record it.' : t.title} onClick={() => onPick({ bundleId: b.bundleId, browser: b.name, window: t.window, tab: t.tab, title: t.title, host: t.host })}>
        <Icon name="globe" size={13} style={{ color: 'var(--text-3)', flex: 'none' }} />
        <span className="tab-title">{t.title || 'Untitled tab'}</span>
        {t.active ? <span className="tab-front">in front</span> : null}
        <span className="tab-host">{hidden ? 'not on screen' : t.host}</span>
      </button>
    );
  };

  if (loading) {
    return (
      <div className="perm-note" data-testid="tab-picker">
        <span className="spinner" />
        <span className="grow">Looking for open browsers…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="perm-note denied" role="alert" data-testid="tab-picker">
        <Icon name="warn" size={14} />
        <span className="grow">The open tabs could not be listed: {error}</span>
        <Button size="sm" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  const browsers = list?.browsers ?? [];
  if (browsers.length === 0) {
    return (
      <div className="perm-note" data-testid="tab-picker">
        <Icon name="globe" size={14} />
        <span className="grow">No browser is open. Open the page in Safari, Chrome, Arc, Edge or Brave, then look again. You can also record the whole browser window with Window.</span>
        <Button size="sm" onClick={() => (setLoading(true), void load())}>Look again</Button>
      </div>
    );
  }
  return (
    <div className="tabs-box" data-testid="tab-picker">
      {browsers.map((b) =>
        b.permission === 'granted' ? (
          <div key={b.bundleId} className="tabs-list" role="radiogroup" aria-label={`${b.name} tabs`}>
            <div className="tabs-head">
              <span className="grow">{b.name}</span>
              <button className="link-btn" onClick={() => void load()}>Look again</button>
            </div>
            {b.error ? <div className="tiny dim" style={{ padding: '2px 8px 6px' }}>{b.name} did not answer: {b.error}</div> : b.tabs.length === 0 ? <div className="tiny dim" style={{ padding: '2px 8px 6px' }}>No tabs are open.</div> : b.tabs.map((t) => row(b, t))}
          </div>
        ) : (
          <div key={b.bundleId} className={`perm-note${b.permission === 'denied' ? ' denied' : ''}`} data-testid={`tab-perm-${b.bundleId}`}>
            <Icon name={b.permission === 'denied' ? 'warn' : 'shield'} size={14} />
            <span className="grow">
              {b.permission === 'denied'
                ? `Cutaway is not allowed to see ${b.name}'s tabs. Turn it on in System Settings → Privacy & Security → Automation → Cutaway → ${b.name}, then look again. Or use Window to record the whole browser window.`
                : `To list ${b.name}'s tabs, macOS will ask once whether Cutaway may control ${b.name}. Cutaway only reads tab titles and brings the tab you pick to the front.`}
            </span>
            {b.permission === 'denied' ? <Button size="sm" onClick={() => void load()}>Look again</Button> : <Button size="sm" variant="primary" busy={asking === b.bundleId} onClick={() => void load(b.bundleId)} data-testid={`tab-allow-${b.bundleId}`}>Allow…</Button>}
          </div>
        ),
      )}
    </div>
  );
}
