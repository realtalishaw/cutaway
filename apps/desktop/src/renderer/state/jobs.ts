import type { Project, Range } from '@cutaway/core';
import { PROVIDERS, type DisclosureScope, type ProviderId, type ProviderInfo } from '@cutaway/ai';
import { JobError, proposeRevision, runFirstCut, type JobContext } from '../jobs';
import { useApp, usePlayback } from './store';

export const AI_SCOPE: DisclosureScope[] = ['transcript', 'edit-metadata', 'frames'];

export function jobContext(signal: AbortSignal, useClaude: boolean): JobContext {
  const app = useApp.getState();
  return {
    projectPath: app.projectPath!,
    get: () => useApp.getState().project!,
    update: (fn) => useApp.getState().patch(fn),
    setStages: (stages) => {
      const job = useApp.getState().job;
      if (job) useApp.setState({ job: { ...job, stages } });
    },
    signal,
    settings: app.settings!,
    useClaude,
    provider: activeProvider(),
  };
}

/** The AI app Cutaway would use right now (the main process decides; this is its last answer). */
export function activeProvider(): ProviderId {
  return useApp.getState().claude?.provider ?? 'claude';
}

export function aiInfo(): ProviderInfo {
  return PROVIDERS[activeProvider()];
}

/** For components: the provider in use, re-rendering when it changes. */
export function useAiInfo(): ProviderInfo {
  return PROVIDERS[useApp((s) => s.claude?.provider) ?? 'claude'];
}

/** Has the creator allowed this project's data to go to the provider in use, for this scope? Consent to one provider never covers the other. */
export function consentCovers(project: Project | null, scope: DisclosureScope[]): boolean {
  const c = project?.consent;
  return !!c && c.provider === aiInfo().consent && scope.every((s) => c.scope.includes(s));
}

/** 'granted' → the provider in use may be used; 'needed' → ask first; 'unavailable' → not installed or not signed in. */
export function consentState(project: Project | null): 'granted' | 'needed' | 'unavailable' {
  const ai = useApp.getState().claude;
  if (!ai?.found || ai.signedIn !== true) return 'unavailable';
  return consentCovers(project, AI_SCOPE) ? 'granted' : 'needed';
}

/** Record consent for the provider in use. A wider scope given earlier to the same provider is kept. */
export function grantConsent(scope: DisclosureScope[] = AI_SCOPE) {
  const provider = aiInfo().consent;
  useApp.getState().patch((p) => ({ ...p, consent: { provider, scope: [...new Set([...(p.consent?.provider === provider ? p.consent.scope : []), ...scope])], grantedAt: new Date().toISOString() } }));
}

export function revokeConsent() {
  useApp.getState().patch((p) => ({ ...p, consent: null }));
}

export async function startFirstCut(useClaude: boolean, regenerate = false): Promise<void> {
  const app = useApp.getState();
  if (!app.project || !app.projectPath || app.job?.status === 'running') return;
  usePlayback.getState().setPlaying(false);
  const abort = new AbortController();
  const before = app.project;
  useApp.setState({ job: { kind: 'first-cut', status: 'running', stages: [], error: null, startedAt: Date.now(), abort } });
  try {
    const result = await runFirstCut(jobContext(abort.signal, useClaude), { regenerate });
    const now = useApp.getState();
    // one undo step back to the pre-cut edit
    useApp.setState({ past: [...now.past, { edit: before.edit, packaging: before.packaging, label: 'AI first cut' }].slice(-120), future: [] });
    useApp.setState({ job: { ...useApp.getState().job!, status: 'done' } });
    now.setView('edit');
    usePlayback.getState().seek(0);
    useApp.setState({ job: null });
    now.toast(result.mode === 'claude' ? 'First cut ready. Review what changed in the Review tab.' : `First cut ready, assembled with built-in rules${result.ai.reason ? ` (${result.ai.reason})` : ''}.`);
  } catch (e) {
    const job = useApp.getState().job;
    if (!job) return;
    const je = e instanceof JobError ? e : null;
    if (je?.code === 'cancelled' || abort.signal.aborted) {
      useApp.setState({ job: { ...job, status: 'cancelled', error: null } });
      return;
    }
    useApp.setState({ job: { ...job, status: 'failed', error: { stage: je?.stage, code: je?.code ?? 'failed', message: (e as Error).message, retryable: je?.retryable ?? true } } });
  }
}

export function cancelJob() {
  useApp.getState().job?.abort.abort();
}

export function dismissJob() {
  useApp.setState({ job: null });
}

/** Ask for a change to one section and open a before/after comparison. Nothing is committed here. */
export async function reviseSection(range: Range, instruction: string): Promise<void> {
  const app = useApp.getState();
  if (!app.project) return;
  const abort = new AbortController();
  try {
    const before = app.project;
    const { preview, outcome } = await proposeRevision(jobContext(abort.signal, consentState(before) === 'granted'), range, instruction);
    if (!outcome.changed) {
      app.toast(outcome.message || 'Nothing in this section needed to change.');
      return;
    }
    const notes = [...outcome.understood, ...(outcome.ai.mode === 'local-rules' && outcome.ai.reason ? [`Built-in rules were used: ${outcome.ai.reason}`] : []), ...(outcome.rejected.length ? [`${outcome.rejected.length} proposed change${outcome.rejected.length === 1 ? ' was' : 's were'} refused by validation.`] : [])];
    usePlayback.getState().setPlaying(false);
    app.setComparison({ before, after: preview, label: outcome.label, range, notes, showing: 'after' });
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}

export function acceptComparison() {
  const app = useApp.getState();
  const c = app.comparison;
  if (!c) return;
  app.replace(c.after, c.label);
  app.setComparison(null);
  app.toast('Change applied. Undo restores the previous section.');
}

export function discardComparison() {
  useApp.getState().setComparison(null);
}
