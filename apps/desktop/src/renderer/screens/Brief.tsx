import { useState } from 'react';
import { fmtTime, type Brief as BriefT } from '@cutaway/core';
import { useApp, useProject } from '../state/store';
import { consentState, grantConsent, startFirstCut } from '../state/jobs';
import { ConsentSheet } from '../ui/Consent';
import { Icon } from '../ui/icons';
import { Banner, Button, Field, Segmented, Toggle } from '../ui/kit';
import './brief.css';

const DURATIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Natural length' },
  { value: '180', label: '≈ 3 min' },
  { value: '300', label: '≈ 5 min' },
  { value: '480', label: '≈ 8 min' },
  { value: '720', label: '≈ 12 min' },
];

/** Sensible defaults produce a first cut with no prompt; everything here is optional. */
export function Brief() {
  const project = useProject();
  const claude = useApp((s) => s.claude);
  const [sheet, setSheet] = useState(false);
  const brief = project.brief;
  const set = (patch: Partial<BriefT>) => useApp.getState().patch((p) => ({ ...p, brief: { ...p.brief, ...patch } }));
  const consent = consentState(project);
  const timeline = project.sources.filter((s) => ['screen', 'cameraA', 'cameraB'].includes(s.role));
  const unsynced = project.sources.filter((s) => ['cameraA', 'cameraB', 'voice'].includes(s.role) && s.sync.status !== 'aligned');
  const assets = project.sources.filter((s) => s.role === 'broll' || s.role === 'image');
  const hasAudio = project.sources.some((s) => s.hasAudio);

  const go = () => {
    if (consent === 'needed') return setSheet(true);
    void startFirstCut(consent === 'granted', !!project.firstCut);
  };

  return (
    <div className="page brief">
      <div className="page-inner" style={{ maxWidth: 980 }}>
        <div className="brief-head rise">
          <div className="eyebrow">First cut</div>
          <h1 className="display h2">
            What should the <em>first cut</em> feel like?
          </h1>
          <p className="muted lede">These defaults work as they are. Change anything you care about, then let Cutaway assemble a cut you can play.</p>
        </div>

        <div className="brief-grid">
          <div className="card col gap-6 rise" style={{ animationDelay: '60ms' }}>
            <Field label="Who is it for?">
              <input className="input" value={brief.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="People learning this for the first time" />
            </Field>
            <Field label="Length" hint={brief.targetDuration === 'auto' ? `Keeps everything worth keeping. The recording is ${fmtTime(project.duration)}.` : 'A target, not a promise: meaning and demonstrated steps win over the clock.'}>
              <Segmented full value={String(brief.targetDuration)} onChange={(v) => set({ targetDuration: v === 'auto' ? 'auto' : Number(v) })} options={DURATIONS} />
            </Field>
            <Field label="Pacing" hint={{ relaxed: 'Leaves room to breathe. Only long dead pauses are shortened.', balanced: 'Tightens pauses and removes filler words, keeps natural rhythm.', energetic: 'Tighter pauses throughout. Still never cuts through a word.' }[brief.pacing]}>
              <Segmented full value={brief.pacing} onChange={(v) => set({ pacing: v })} options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'balanced', label: 'Balanced' }, { value: 'energetic', label: 'Energetic' }]} />
            </Field>
            <Field label="Movement" hint={{ calm: 'Few zooms, long shots.', balanced: 'Zooms on real detail, view changes with a reason.', lively: 'More intentional movement. Not random effects.' }[brief.visualIntensity]}>
              <Segmented full value={brief.visualIntensity} onChange={(v) => set({ visualIntensity: v })} options={[{ value: 'calm', label: 'Calm' }, { value: 'balanced', label: 'Balanced' }, { value: 'lively', label: 'Lively' }]} />
            </Field>
            <Toggle label="Use my B-roll where it fits" hint={assets.length ? `${assets.length} supporting asset${assets.length === 1 ? '' : 's'} in this project. Narration always continues underneath.` : 'No supporting clips in this project yet. Shots stay clean; nothing is invented.'} checked={brief.allowBroll} onChange={(v) => set({ allowBroll: v })} />
            <Field label="Anything else? (optional)">
              <textarea className="textarea" rows={3} value={brief.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Make a clear walkthrough. Use the screen while I demonstrate steps, show me when I explain the idea, and use the second camera sparingly." />
            </Field>
          </div>

          <div className="col gap-4 rise" style={{ animationDelay: '120ms' }}>
            <div className="card col gap-4">
              <div className="eyebrow">What Cutaway will work from</div>
              {timeline.map((s) => (
                <div key={s.id} className="row small">
                  <Icon name={s.role === 'screen' ? 'screen' : 'camera'} size={14} style={{ color: 'var(--text-3)' }} />
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.role === 'screen' ? 'Screen' : s.role === 'cameraA' ? 'Camera A' : 'Camera B'}</span>
                  <span className="mono tiny dim">{fmtTime(s.duration)}</span>
                </div>
              ))}
              <div className="row small">
                <Icon name="mic" size={14} style={{ color: 'var(--text-3)' }} />
                <span className="grow">{hasAudio ? 'Speech, transcribed on this Mac' : 'No audio: a silent demo, edited from what happens on screen'}</span>
              </div>
              {unsynced.length ? (
                <Banner tone="warn" title={`${unsynced.length} source${unsynced.length === 1 ? ' is' : 's are'} not aligned`} action={<Button size="sm" onClick={() => useApp.getState().setView('sources')}>Review sync</Button>}>
                  Unaligned footage is left out of the cut until you confirm its sync.
                </Banner>
              ) : null}
            </div>

            <div className="card col gap-4">
              <div className="eyebrow">Where the thinking happens</div>
              <div className="row small" style={{ alignItems: 'flex-start' }}>
                <Icon name="shield" size={14} style={{ color: 'var(--you)', marginTop: 2 }} />
                <span>Transcription, pause and filler cleanup, sync and export always run on this Mac.</span>
              </div>
              {consent === 'unavailable' ? (
                <Banner icon="info" title={claude?.found ? 'Claude Code is not signed in' : 'Claude Code was not found'}>
                  The cut will be assembled with Cutaway’s built-in rules. To add Claude’s editorial pass, {claude?.found ? <>run <span className="mono">claude</span> in Terminal and type <span className="mono">/login</span></> : <>install Claude Code and sign in</>}, then check again in Settings.
                </Banner>
              ) : consent === 'granted' ? (
                <div className="row small" style={{ alignItems: 'flex-start' }}>
                  <Icon name="sparkle" size={14} style={{ color: 'var(--ai)', marginTop: 2 }} />
                  <span>
                    Claude reviews the transcript, edit data and a few still frames through Claude Code on this Mac. You allowed this for this project.{' '}
                    <button className="btn ghost sm" style={{ padding: 0, height: 'auto' }} onClick={() => useApp.getState().patch((p) => ({ ...p, consent: null }))}>Withdraw</button>
                  </span>
                </div>
              ) : (
                <div className="row small" style={{ alignItems: 'flex-start' }}>
                  <Icon name="sparkle" size={14} style={{ color: 'var(--ai)', marginTop: 2 }} />
                  <span>Claude can add an editorial pass (views, zooms, graphics, retake suggestions). You will be shown exactly what would be sent before anything leaves this Mac.</span>
                </div>
              )}
            </div>

            <Button variant="primary" size="lg" icon="sparkle" onClick={go} disabled={timeline.length === 0}>
              {project.firstCut ? 'Create a new first cut' : 'Create first cut'}
            </Button>
            {project.firstCut ? <div className="tiny dim">Your own edits, locks and restored footage are kept. Earlier AI decisions are replaced, and the current cut is saved as a checkpoint first.</div> : null}
            <Button variant="ghost" onClick={() => useApp.getState().setView('edit')}>Skip and edit by hand</Button>
          </div>
        </div>
      </div>
      {sheet ? (
        <ConsentSheet
          purpose="the first cut"
          onClose={() => setSheet(false)}
          onAllow={() => {
            setSheet(false);
            grantConsent();
            void startFirstCut(true, !!project.firstCut);
          }}
          onDecline={() => {
            setSheet(false);
            void startFirstCut(false, !!project.firstCut);
          }}
        />
      ) : null}
    </div>
  );
}
