import { useEffect, useRef, useState } from 'react';
import { fmtTime, type ChatMessage, type ChatProposalItem, type Range } from '@cutaway/core';
import { useApp } from '../../../state/store';
import { consentState, grantConsent } from '../../../state/jobs';
import { applyChatCards, chatScope, checkpointOf, clearChat, dismissChatCards, dropChatMessage, jumpTo, reopenChatCard, sendChat, stopChat, useChat } from '../../../state/chat';
import { LOCAL_REVISION_HELP } from '../../../jobs/revision';
import { ConsentSheet } from '../../../ui/Consent';
import { Icon } from '../../../ui/icons';
import { Button } from '../../../ui/kit';
import './chat.css';

const IDEAS = ['Tighten the intro', 'Where does it drag?', 'Fewer zooms, calmer overall', 'Zoom in when I open settings'];

const span = (r: Range) => (r.end - r.start < 0.05 ? fmtTime(r.start) : `${fmtTime(r.start)} – ${fmtTime(r.end)}`);

function Card({ messageId, item, busy }: { messageId: string; item: ChatProposalItem; busy: boolean }) {
  return (
    <div className={`chat-card ${item.status}`} data-testid="chat-card" data-status={item.status} data-kind={item.kind}>
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <div className="chat-card-what">{item.what}</div>
        <button className="chat-jump mono" title="Go there on the timeline" onClick={() => jumpTo(item.range.start)} data-testid="chat-jump">
          {span(item.range)}
        </button>
      </div>
      {item.why ? <div className="tiny muted">{item.why}</div> : null}
      {item.note ? (
        <div className={`tiny ${item.status === 'refused' ? 'chat-refused' : 'dim'}`} data-testid="chat-note">
          {item.status === 'refused' ? 'Not possible: ' : ''}
          {item.note}
        </div>
      ) : null}
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        {item.status === 'open' ? (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void applyChatCards(messageId, [item.id])} data-testid="chat-apply">Apply</Button>
            <Button size="sm" variant="ghost" onClick={() => dismissChatCards(messageId, [item.id])} data-testid="chat-dismiss">Dismiss</Button>
          </>
        ) : item.status === 'applied' ? (
          <>
            <span className="chat-state ok"><Icon name="check" size={11} /> Applied</span>
            {item.checkpoint ? (
              <Button size="sm" variant="ghost" onClick={() => useApp.getState().viewVersion(item.checkpoint!)} title="Look at the video as it was right after this change">View</Button>
            ) : null}
          </>
        ) : item.status === 'dismissed' ? (
          <>
            <span className="chat-state">Dismissed</span>
            <Button size="sm" variant="ghost" onClick={() => reopenChatCard(messageId, item.id)}>Bring back</Button>
          </>
        ) : (
          <span className="chat-state">Left out</span>
        )}
      </div>
    </div>
  );
}

function Reply({ m, busy }: { m: ChatMessage; busy: boolean }) {
  const project = useApp((s) => s.project)!;
  const viewing = useApp((s) => s.viewing);
  const items = m.items ?? [];
  const open = items.filter((i) => i.status === 'open');
  const ref = checkpointOf(project, m);
  const onScreen = !!ref && viewing?.revision === ref.revision;
  return (
    <div className={`chat-msg assistant${m.failed ? ' failed' : ''}`} data-testid="chat-reply" data-mode={m.mode ?? ''}>
      <div className="chat-who">
        <Icon name="sparkle" size={11} /> {m.mode === 'local-rules' ? 'Built-in rules' : 'AI'}
        {m.failed ? (
          <button className="chat-x" title="Remove this message" aria-label="Remove this message" onClick={() => dropChatMessage(m.id)}>
            <Icon name="x" size={11} />
          </button>
        ) : null}
      </div>
      <div className="chat-text">{m.text}</div>
      {m.moments?.length ? (
        <div className="chat-moments">
          {m.moments.map((x, i) => (
            <button key={i} className="chat-moment" onClick={() => jumpTo(x.start)} title="Go there on the timeline" data-testid="chat-moment">
              <span className="mono">{span(x)}</span>
              <span>{x.note}</span>
            </button>
          ))}
        </div>
      ) : null}
      {items.length ? (
        <div className="chat-cards">
          {items.map((it) => (
            <Card key={it.id} messageId={m.id} item={it} busy={busy} />
          ))}
        </div>
      ) : null}
      {open.length > 1 ? (
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void applyChatCards(m.id)} data-testid="chat-apply-all">Apply all {open.length}</Button>
          <Button size="sm" variant="ghost" onClick={() => dismissChatCards(m.id)}>Dismiss all</Button>
        </div>
      ) : null}
      {ref ? (
        <div className="chat-version" data-testid="chat-version">
          <Icon name="history" size={12} />
          <span className="grow tiny">Saved as a version: “{ref.label}”</span>
          <Button size="sm" variant={onScreen ? 'default' : 'ghost'} on={onScreen} onClick={() => (onScreen ? useApp.getState().exitViewing() : useApp.getState().viewVersion(ref))} data-testid="chat-view-version">
            {onScreen ? 'Viewing' : 'View this version'}
          </Button>
          {project.revision !== ref.revision ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="chat-restore-version"
              onClick={() => {
                const app = useApp.getState();
                if (app.viewVersion(ref)) app.restoreViewed();
              }}
            >
              Restore
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Ask AI": talk about the edit, get specific proposed changes, apply them one by one. */
export function ChatTab() {
  const project = useApp((s) => s.project);
  const selection = useApp((s) => s.selection);
  const viewing = useApp((s) => s.viewing);
  const claude = useApp((s) => s.claude);
  const busy = useChat((s) => s.busy);
  const startedAt = useChat((s) => s.startedAt);
  const [draft, setDraft] = useState('');
  const [consent, setConsent] = useState<string | null>(null);
  const [, tick] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const chat = project?.chat ?? [];

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.length, busy]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  if (!project) return null;
  // Re-read on every render: sign-in and consent can change while the tab is open.
  void claude;
  const state = consentState(project);
  const scope = chatScope(project, selection);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    if (state === 'needed') return setConsent(t);
    setDraft('');
    void sendChat(t, state === 'granted');
  };

  return (
    <div className="chat" data-testid="chat-tab">
      <div className="chat-head">
        <div>
          <div style={{ fontWeight: 600 }}>Ask AI</div>
          <div className="tiny dim" data-testid="chat-provider">
            {state === 'unavailable' ? 'No AI provider is signed in. Built-in rules only.' : state === 'needed' ? 'Asks before anything leaves this Mac.' : 'Proposes changes. Nothing is applied until you say so.'}
          </div>
        </div>
        {chat.length ? (
          <Button size="sm" variant="ghost" onClick={clearChat} title="Forget this conversation. Versions it created stay in History.">Clear</Button>
        ) : null}
      </div>

      <div className="chat-thread">
        {chat.length === 0 ? (
          <div className="chat-empty">
            <div className="muted small">
              Say what you want changed, or ask about the video. You get specific changes as cards: apply them one by one or all at once. Every applied change is saved as a version you can look at or go back to.
            </div>
            {state === 'unavailable' ? <div className="tiny dim">{LOCAL_REVISION_HELP} Sign in to Claude Code in Settings for anything else.</div> : null}
            <div className="chat-ideas">
              {IDEAS.map((t) => (
                <button key={t} className="chat-idea" onClick={() => (setDraft(t), box.current?.focus())}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {chat.map((m) =>
          m.role === 'creator' ? (
            <div key={m.id} className="chat-msg creator" data-testid="chat-mine">
              <div className="chat-text">{m.text}</div>
              <div className="tiny dim">{m.scope ? `About ${span(m.scope)}` : 'About the whole video'}</div>
            </div>
          ) : (
            <Reply key={m.id} m={m} busy={busy} />
          ),
        )}
        {busy ? (
          <div className="chat-msg assistant thinking" data-testid="chat-thinking">
            <span className="spinner" /> Working on it… {startedAt ? `${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s` : ''}
            <Button size="sm" variant="ghost" onClick={stopChat}>Stop</Button>
          </div>
        ) : null}
        <div ref={end} />
      </div>

      {viewing ? (
        <div className="chat-compose">
          <div className="tiny muted">You are looking at an earlier version. Go back to the latest to keep talking about the edit.</div>
          <Button size="sm" onClick={() => useApp.getState().exitViewing()}>Back to latest</Button>
        </div>
      ) : (
        <div className="chat-compose">
          <div className="row between" style={{ gap: 8 }}>
            <span className={`chat-scope${scope ? ' on' : ''}`} data-testid="chat-scope" title={scope ? 'Your message is about the selected section only.' : 'Select a range on the timeline or words in the transcript to talk about just that part.'}>
              <Icon name={scope ? 'scissors' : 'film'} size={11} /> {scope ? `Selection ${span(scope)}` : 'Whole video'}
            </span>
            {scope ? (
              <button className="chat-x" onClick={() => useApp.getState().select(null)} title="Talk about the whole video instead" aria-label="Clear the selection">
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </div>
          <textarea
            ref={box}
            className="input chat-input"
            data-testid="chat-input"
            rows={2}
            maxLength={1200}
            placeholder={state === 'unavailable' ? 'Try “fewer zooms”, “tighter” or “keep this”' : 'What should change? Or ask about the video…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(draft);
              }
            }}
            aria-label="Message to the AI editor"
          />
          <div className="row between">
            <span className="tiny dim">⏎ to send · ⇧⏎ for a new line</span>
            <Button size="sm" variant="primary" icon="sparkle" disabled={!draft.trim() || busy} onClick={() => send(draft)} data-testid="chat-send">
              Send
            </Button>
          </div>
        </div>
      )}

      {consent !== null ? (
        <ConsentSheet
          purpose="this conversation"
          onClose={() => setConsent(null)}
          onAllow={() => {
            const t = consent;
            setConsent(null);
            setDraft('');
            grantConsent();
            void sendChat(t, true);
          }}
          onDecline={() => {
            const t = consent;
            setConsent(null);
            setDraft('');
            void sendChat(t, false);
          }}
        />
      ) : null}
    </div>
  );
}
