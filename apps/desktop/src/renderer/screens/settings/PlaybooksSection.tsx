import { useEffect, useState } from 'react';
import { NOTE_MAX, PLAYBOOKS, PLAYBOOK_SOURCES, cleanNote, type PlaybookId } from '@cutaway/ai';
import type { AppSettings } from '@shared/api';
import { Button } from '../../ui/kit';

/**
 * The craft guidance the AI works from, shown as it is sent, with a place for
 * the creator's own notes. Notes live in this Mac's settings and are added to
 * the prompt under the playbook; they cannot switch off the fixed rules.
 */
export function PlaybooksSection({ settings, update }: { settings: AppSettings; update(patch: Partial<AppSettings>): Promise<void> }) {
  const [open, setOpen] = useState<PlaybookId | null>(null);
  const saved = settings.playbookNotes ?? {};
  const [drafts, setDrafts] = useState<Record<PlaybookId, string>>({ editing: saved.editing ?? '', titles: saved.titles ?? '', thumbnails: saved.thumbnails ?? '' });
  useEffect(() => setDrafts({ editing: saved.editing ?? '', titles: saved.titles ?? '', thumbnails: saved.thumbnails ?? '' }), [saved.editing, saved.titles, saved.thumbnails]);
  const save = (id: PlaybookId) => update({ playbookNotes: { ...saved, [id]: cleanNote(drafts[id]) || null } });

  return (
    <section className="card set-section" data-testid="playbooks-section">
      <div>
        <div className="set-title">Playbooks</div>
        <div className="tiny dim set-hint">How Cutaway is told to edit, title and design thumbnails. The same guidance shapes the built-in rules when Claude is not used. Add notes about your own channel; they are sent with the playbook and never override the safety rules.</div>
      </div>
      {PLAYBOOKS.map((pb) => {
        const draft = drafts[pb.id];
        const dirty = cleanNote(draft) !== (saved[pb.id] ?? '');
        const isOpen = open === pb.id;
        return (
          <div key={pb.id} className="col" style={{ gap: 8, borderTop: '1px solid var(--hairline, #1a1e27)', paddingTop: 12 }} data-testid={`playbook-${pb.id}`}>
            <div className="row between">
              <div>
                <div style={{ fontWeight: 600 }}>{pb.title}</div>
                <div className="tiny dim">{pb.usedFor}</div>
              </div>
              <Button size="sm" variant="ghost" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : pb.id)}>
                {isOpen ? 'Hide playbook' : 'Read playbook'}
              </Button>
            </div>
            {isOpen ? (
              <pre className="tiny" style={{ whiteSpace: 'pre-wrap', margin: 0, padding: '10px 12px', borderRadius: 10, background: 'var(--control, #1b1d22)', color: 'var(--text-2)', maxHeight: 320, overflow: 'auto', fontFamily: 'inherit', lineHeight: 1.5 }} data-testid={`playbook-text-${pb.id}`}>
                {pb.text}
              </pre>
            ) : null}
            <label className="field">
              <span className="label">
                Add your own notes
                <span className="value">
                  {cleanNote(draft).length} / {NOTE_MAX}
                </span>
              </span>
              <textarea
                className="input"
                rows={2}
                maxLength={NOTE_MAX}
                value={draft}
                placeholder={pb.id === 'editing' ? 'For example: keep my sign-off; never zoom during code.' : pb.id === 'titles' ? 'For example: always sentence case; my viewers are beginners.' : 'For example: yellow words on dark; never use the banner layout.'}
                aria-label={`Your notes for the ${pb.title.toLowerCase()} playbook`}
                onChange={(e) => setDrafts((d) => ({ ...d, [pb.id]: e.target.value }))}
              />
            </label>
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save(pb.id)}>
                Save notes
              </Button>
              {saved[pb.id] ? (
                <Button size="sm" onClick={() => void update({ playbookNotes: { ...saved, [pb.id]: null } })}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      <details className="tiny muted">
        <summary style={{ cursor: 'pointer' }}>Where this guidance comes from</summary>
        <ul className="plain" style={{ marginTop: 6 }}>
          {PLAYBOOK_SOURCES.map((s) => (
            <li key={s.url}>
              {s.name} ({s.licence}): {s.used}.
            </li>
          ))}
        </ul>
        <div className="dim" style={{ marginTop: 4 }}>Written for Cutaway from these sources; none of their text is copied.</div>
      </details>
    </section>
  );
}
