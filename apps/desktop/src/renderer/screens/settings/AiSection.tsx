import { useCallback, useEffect, useState } from 'react';
import { PROVIDERS, PROVIDER_ORDER, disclosure, providerChoice, type ProviderChoice, type ProviderId } from '@cutaway/ai';
import type { AiProviders, AppSettings, ClaudeStatus } from '@shared/api';
import { useApp } from '../../state/store';
import { Banner, Button, Field, Segmented, fmtAgo } from '../../ui/kit';

const BLURB: Record<ProviderId, string> = {
  claude: 'Edits and thumbnail/title concepts through Anthropic’s Claude.',
  codex: 'Edits and concepts through OpenAI’s Codex, and the only one that can generate thumbnail pictures.',
};

function Status({ id, status, active, onSignIn }: { id: ProviderId; status: ClaudeStatus | null; active: boolean; onSignIn(): void }) {
  const p = PROVIDERS[id];
  const dot = status?.found ? (status.signedIn ? 'ok' : status.signedIn === false ? 'bad' : 'unknown') : 'bad';
  const state = !status ? 'Checking…' : !status.found ? 'Not installed' : status.signedIn ? 'Installed and signed in' : status.signedIn === false ? 'Installed, but not signed in' : 'Installed · sign-in not checked yet';
  return (
    <div className="col" style={{ gap: 8, borderTop: '1px solid var(--hairline, #1a1e27)', paddingTop: 12 }} data-testid={`ai-${id}`} data-state={dot}>
      <div className="row between">
        <div className="row" style={{ gap: 10 }}>
          <span className={`status-dot ${dot}`} aria-hidden />
          <div>
            <div style={{ fontWeight: 600 }}>
              {p.app} {active ? <span className="pill ai" style={{ marginLeft: 6 }} data-testid="ai-in-use">In use</span> : null}
            </div>
            <div className="tiny muted">{state}. {BLURB[id]}</div>
            <div className="tiny dim mono">{status?.found ? `${status.path ?? p.command}${status.version ? ` · ${status.version}` : ''}` : (status?.message ?? '')}</div>
          </div>
        </div>
        {status?.found && status.signedIn === false ? (
          <Button variant="primary" size="sm" icon="external" data-testid={`${id}-sign-in`} onClick={onSignIn}>
            Sign in to {p.app}…
          </Button>
        ) : null}
      </div>
      {status?.found && status.signedIn === false ? (
        <div className="tiny dim">
          Cutaway runs the same <span className="mono code">{p.command}</span> command as your terminal, and right now it says it is not signed in. The button opens Terminal and runs{' '}
          <span className="mono code">{[p.command, ...p.signIn].join(' ')}</span>; then choose Check again.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Which AI app Cutaway uses, the state of each, where data would go and what
 * this project has allowed. Cutaway has no key or account of its own.
 */
export function AiSection({ settings, update }: { settings: AppSettings; update(patch: Partial<AppSettings>): Promise<void> }) {
  const project = useApp((s) => s.project);
  const [all, setAll] = useState<AiProviders | null>(null);
  const [checking, setChecking] = useState(false);
  const choice = providerChoice(settings.aiProvider);

  const check = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const p = await window.cutaway.ai.providers(force);
      setAll(p);
      useApp.setState({ claude: p[p.active] });
    } catch (e) {
      useApp.getState().toast(`The AI apps could not be checked: ${(e as Error).message}`, 'error');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check(false);
  }, [check, settings.aiProvider, settings.claudePath, settings.codexPath]);

  const active = all?.active ?? (choice === 'auto' ? 'claude' : choice);
  const info = PROVIDERS[active];
  const d = disclosure(['transcript', 'edit-metadata', 'frames'], active);
  const signIn = (id: ProviderId) =>
    void window.cutaway.ai
      .signIn(id)
      .then((r) => useApp.getState().toast(r.message))
      .catch((e: Error) => useApp.getState().toast(e.message));
  const consentHere = project?.consent && project.consent.provider === info.consent ? project.consent : null;

  return (
    <>
      <section className="card set-section" data-testid="ai-section">
        <div>
          <div className="set-title">AI on this Mac</div>
          <div className="tiny dim set-hint">Cutaway has no API key and no account of its own. AI editing runs through an app you already use and are signed in to. The model itself runs at that company, not on this Mac.</div>
        </div>
        <div className="row between wrap" style={{ gap: 12 }}>
          <div className="field" style={{ margin: 0 }}>
            <span className="label">Use</span>
            <Segmented<ProviderChoice>
              label="AI app"
              value={choice}
              onChange={(v) => void update({ aiProvider: v })}
              options={[
                { value: 'auto', label: 'Automatic' },
                { value: 'claude', label: 'Claude Code' },
                { value: 'codex', label: 'Codex' },
              ]}
            />
          </div>
          <Button icon="sync" busy={checking} onClick={() => void check(true)} data-testid="ai-check">
            Check again
          </Button>
        </div>
        <div className="tiny dim">
          {choice === 'auto'
            ? `Automatic uses the first app that is signed in, Claude Code first. Right now that is ${info.app}.`
            : `${info.app} is always used. If it is not ready, Cutaway edits with its built-in rules and says so; it never switches to the other app on its own.`}{' '}
          Each project is asked once per company before anything is sent. Thumbnail pictures are always made by Codex and ask separately.
        </div>
        {PROVIDER_ORDER.map((id) => (
          <Status key={id} id={id} status={all ? all[id] : null} active={active === id} onSignIn={() => signIn(id)} />
        ))}
        {all && !all.claude.found && !all.codex.found ? (
          <Banner tone="warn" title="No AI app was found">
            Install Claude Code or Codex and sign in, or point Cutaway at one below. Recording, manual editing, on-device rules and export all work without it.
          </Banner>
        ) : null}
        <div className="two">
          <Field label="Claude model" hint="Passed to Claude Code as --model. An alias such as sonnet or opus, or a full model id.">
            <input className="input mono" defaultValue={settings.claudeModel} onBlur={(e) => e.target.value.trim() !== settings.claudeModel && void update({ claudeModel: e.target.value.trim() || 'sonnet' })} aria-label="Claude model" />
          </Field>
          <Field label="Claude Code location" hint="Leave empty to use the claude your terminal uses.">
            <input className="input mono" defaultValue={settings.claudePath ?? ''} placeholder="automatic" onBlur={(e) => (e.target.value.trim() || null) !== settings.claudePath && void update({ claudePath: e.target.value.trim() || null })} aria-label="Claude Code path" />
          </Field>
          <Field label="Codex model" hint="Passed to Codex as --model. Leave empty for Codex’s own default.">
            <input className="input mono" defaultValue={settings.codexModel ?? ''} placeholder="default" onBlur={(e) => e.target.value.trim() !== (settings.codexModel ?? '') && void update({ codexModel: e.target.value.trim() })} aria-label="Codex model" />
          </Field>
          <Field label="Codex location" hint="Leave empty to use the codex your terminal uses.">
            <input className="input mono" defaultValue={settings.codexPath ?? ''} placeholder="automatic" onBlur={(e) => (e.target.value.trim() || null) !== (settings.codexPath ?? null) && void update({ codexPath: e.target.value.trim() || null })} aria-label="Codex path" />
          </Field>
        </div>
      </section>

      <section className="card set-section" data-testid="ai-disclosure">
        <div>
          <div className="set-title">What leaves this Mac</div>
          <div className="tiny dim set-hint">For {info.app}, the app in use. Shown again, and asked, before the first time a project uses it.</div>
        </div>
        <dl className="disclosure">
          <dt>Where it goes</dt>
          <dd>{d.destination}. The model does not run on this Mac.</dd>
          <dt>What is sent</dt>
          <dd>
            <ul>
              {d.leaves.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </dd>
          <dt>Never sent</dt>
          <dd>
            <ul>
              {d.stays.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </dd>
          <dt>Cost</dt>
          <dd>{d.cost}</dd>
          <dt>Retention</dt>
          <dd>{d.retention}</dd>
        </dl>
        {project ? (
          <div className="col" style={{ gap: 10 }}>
            {consentHere ? (
              <div className="row between">
                <div className="tiny muted">
                  <b style={{ color: 'var(--text)' }}>{project.name}</b> may use {consentHere.provider}. Allowed {fmtAgo(consentHere.grantedAt)} for: {consentHere.scope.join(', ')}.
                </div>
                <Button
                  variant="danger"
                  onClick={() => {
                    useApp.getState().patch((p) => ({ ...p, consent: null }));
                    useApp.getState().toast('Permission withdrawn. This project will ask again before sending anything.');
                  }}
                >
                  Withdraw permission
                </Button>
              </div>
            ) : (
              <div className="tiny muted">
                <b style={{ color: 'var(--text)' }}>{project.name}</b> has not been allowed to use {info.name}
                {project.consent ? ` (it was allowed for ${project.consent.provider}, which does not carry over)` : ''}. It will ask before sending anything.
              </div>
            )}
            {project.artConsent ? (
              <div className="row between">
                <div className="tiny muted">
                  Thumbnail pictures: allowed for {project.artConsent.provider}, {fmtAgo(project.artConsent.grantedAt)}.
                </div>
                <Button
                  variant="danger"
                  onClick={() => {
                    useApp.getState().patch((p) => ({ ...p, artConsent: null }));
                    useApp.getState().toast('Permission withdrawn. Pictures already made stay in the project.');
                  }}
                >
                  Withdraw
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="tiny dim">Permission is given per project and per company. Open a project to review or withdraw it.</div>
        )}
      </section>
    </>
  );
}
