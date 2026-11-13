/**
 * Recording flags: moments the creator marked while recording ("look here").
 * They are plain session times. They never change the edit on their own; they
 * guide the first cut and give the creator points to jump between.
 */
import type { EditOp, Flag, Project, Seconds } from './types';
import { uid } from './ranges';

/** Flags of a project, sorted, de-duplicated to 50 ms. */
export function flagsOf(project: Pick<Project, 'flags'>): Flag[] {
  const out: Flag[] = [];
  for (const f of [...(project.flags ?? [])].sort((a, b) => a.t - b.t)) {
    if (!out.length || f.t - out[out.length - 1]!.t > 0.05) out.push(f);
  }
  return out;
}

/** Add flags recorded with a take. Times are on the session clock. Safe to call twice for the same take. */
export function withTakeFlags<P extends Pick<Project, 'flags' | 'duration'>>(project: P, takeId: string, times: Seconds[]): P {
  const existing = project.flags ?? [];
  if (existing.some((f) => f.takeId === takeId)) return project;
  const fresh = times.filter((t) => Number.isFinite(t) && t >= 0).map((t) => ({ id: uid('flag'), t, takeId }));
  if (!fresh.length) return project;
  return { ...project, flags: [...existing, ...fresh].sort((a, b) => a.t - b.t) };
}

/** The flag after (dir 1) or before (dir -1) a session time, or null. */
export function neighbourFlag(flags: Flag[], t: Seconds, dir: 1 | -1): Flag | null {
  const sorted = [...flags].sort((a, b) => a.t - b.t);
  if (dir > 0) return sorted.find((f) => f.t > t + 0.05) ?? null;
  return [...sorted].reverse().find((f) => f.t < t - 0.05) ?? null;
}

/**
 * A flagged moment must survive automatic cleanup: drop proposed cuts that
 * would remove one, except trims of dead air that merely touch it (those are
 * shortened to leave the flag and a little room around it).
 */
export function keepFlaggedMoments(ops: EditOp[], flags: Seconds[], room: Seconds = 0.4): { ops: EditOp[]; protectedCount: number } {
  if (!flags.length) return { ops, protectedCount: 0 };
  let protectedCount = 0;
  const out: EditOp[] = [];
  for (const op of ops) {
    if (op.op !== 'cut') {
      out.push(op);
      continue;
    }
    const inside = flags.filter((t) => t >= op.start && t <= op.end);
    if (!inside.length) {
      out.push(op);
      continue;
    }
    protectedCount += 1;
    // Keep what lies clear of every flag, if a useful amount of it is left.
    const first = Math.min(...inside) - room;
    const last = Math.max(...inside) + room;
    if (first - op.start >= 0.6) out.push({ ...op, end: first });
    if (op.end - last >= 0.6) out.push({ ...op, start: last });
  }
  return { ops: out, protectedCount };
}
