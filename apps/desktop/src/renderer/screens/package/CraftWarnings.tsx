import { packagingWarnings } from '@cutaway/ai';
import type { PackagingConcept } from '@cutaway/core';
import { Icon } from '../../ui/icons';

/** The words on a concept's thumbnail, as a viewer reads them. */
export function thumbnailTextOf(concept: PackagingConcept): string {
  return concept.layers
    .flatMap((l) => (l.kind === 'text' ? [l.text.trim()] : []))
    .filter(Boolean)
    .join(' ');
}

/**
 * Checks from the title and thumbnail playbooks. They are advice: nothing is
 * rewritten, and a concept with warnings can still be chosen and exported.
 */
export function CraftWarnings({ concept }: { concept: PackagingConcept }) {
  const warnings = packagingWarnings({ title: concept.title, thumbnailText: thumbnailTextOf(concept) });
  if (warnings.length === 0) return null;
  return (
    <section className="card col" style={{ gap: 6 }} data-testid="craft-warnings" aria-label="Title and thumbnail checks">
      <span className="label">Worth a look before you publish</span>
      {warnings.map((w) => (
        <div key={w.code} className="tiny row" style={{ gap: 6, alignItems: 'flex-start', color: 'var(--warn, #e0a84a)' }} data-code={w.code}>
          <Icon name="warn" size={11} style={{ marginTop: 2, flex: 'none' }} />
          <span style={{ color: 'var(--text-2)' }}>{w.message}</span>
        </div>
      ))}
      <span className="tiny dim">These are suggestions from the playbooks in Settings. Cutaway does not change your wording.</span>
    </section>
  );
}
