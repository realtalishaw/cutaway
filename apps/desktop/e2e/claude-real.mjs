// The AI path against the real Claude Code CLI on this Mac. Uses the creator's own
// Claude account, so it is never part of the default e2e run:
//   CUTAWAY_CLAUDE=on node e2e/claude-real.mjs [outDir]
// Exits 2 (skipped) when the CLI is missing or not signed in.
// Sends only the generated fixture footage: its transcript, edit metadata and stills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CUTAWAY_CLAUDE = 'on';
const { launch, root } = await import('./harness.mjs');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-claude-real'));
fs.mkdirSync(out, { recursive: true });
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

const { app, page } = await launch();
try {
  const status = await page.evaluate(() => window.cutaway.ai.status(true));
  console.log('claude', JSON.stringify({ found: status.found, path: status.path, version: status.version, signedIn: status.signedIn }));
  if (!status.found || status.signedIn !== true) {
    console.log(`SKIPPED: ${status.message}`);
    await app.close();
    process.exit(2);
  }
  await page.evaluate((s) => window.__cutaway.useApp.setState({ claude: s }), status);

  await page.evaluate((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4'), fx('camera-a.mov')]);
  await page.evaluate(() => window.__cutaway.jobs.grantConsent());
  check('consent recorded, Claude usable', (await page.evaluate(() => window.__cutaway.jobs.consentState(window.__cutaway.useApp.getState().project))) === 'granted');

  // ── first cut ──
  const t0 = Date.now();
  await page.evaluate(() => void window.__cutaway.jobs.startFirstCut(true));
  await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return !s.job || s.job.status !== 'running'; }, null, { timeout: 20 * 60000 });
  const cut = await page.evaluate(() => {
    const { useApp, timeMapOf } = window.__cutaway;
    const s = useApp.getState();
    const p = s.project;
    const count = (lane) => p.edit[lane].filter((x) => x.meta.origin === 'ai').length;
    return { job: s.job && { status: s.job.status, error: s.job.error }, firstCut: p.firstCut, toast: s.toasts?.at(-1)?.text ?? null, ai: { cuts: count('cuts'), layouts: count('layouts'), zooms: count('zooms'), overlays: count('overlays') }, suggestions: p.edit.suggestions.length, duration: p.duration, out: timeMapOf(p).outDuration, reasons: [...p.edit.cuts, ...p.edit.zooms, ...p.edit.layouts].map((x) => x.meta.reason).filter(Boolean).slice(0, 6) };
  });
  console.log('first cut', JSON.stringify(cut, null, 1), `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  check('first cut finished', !cut.job && !!cut.firstCut);
  check('the editorial pass came from Claude, not the built-in rules', cut.firstCut?.mode === 'claude', cut.firstCut?.mode);
  check('Claude decisions were applied and carry reasons', cut.ai.cuts + cut.ai.layouts + cut.ai.zooms + cut.ai.overlays > 0 && cut.reasons.length > 0, JSON.stringify(cut.ai));
  check('the cut is shorter than the take but not empty', cut.out > 2 && cut.out <= cut.duration + 0.01, `${cut.out.toFixed(1)}s of ${cut.duration.toFixed(1)}s`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '1-first-cut.png') });

  // ── local revision ──
  const rev = await page.evaluate(async () => {
    const { useApp, jobs } = window.__cutaway;
    const p = useApp.getState().project;
    const range = { start: Math.min(4, p.duration / 4), end: Math.min(14, p.duration * 0.75) };
    await jobs.reviseSection(range, 'No zooms in this part, and show only the screen.');
    const c = useApp.getState().comparison;
    return c ? { label: c.label, notes: c.notes, zoomsBefore: c.before.edit.zooms.length, zoomsAfter: c.after.edit.zooms.length } : { none: useApp.getState().toasts?.at(-1)?.text ?? 'no comparison' };
  });
  console.log('revision', JSON.stringify(rev));
  check('a section revision came back as a comparison', !rev.none, rev.none ?? rev.label);
  check('the revision was not a fallback to built-in rules', !rev.none && !(rev.notes ?? []).some((n) => /Built-in rules were used/.test(n)), JSON.stringify(rev.notes ?? []));
  if (!rev.none) await page.evaluate(() => window.__cutaway.jobs.acceptComparison());

  // ── packaging ──
  const pack = await page.evaluate(async () => {
    const { useApp, jobs, pipeline } = window.__cutaway;
    const r = await pipeline.generatePackaging(jobs.jobContext(new AbortController().signal, true));
    const p = useApp.getState().project;
    return { ai: r.ai, added: r.added, notes: r.notes, concepts: p.packaging.concepts.map((c) => ({ title: c.title, thumbnail: c.layers.filter((l) => l.kind === 'text').map((l) => l.text).join(' '), origin: c.meta?.origin ?? c.origin ?? null })).slice(0, 6) };
  });
  console.log('packaging', JSON.stringify(pack, null, 1));
  check('thumbnail and title concepts came from Claude', pack.ai.mode === 'claude', pack.ai.reason ?? '');
  check('concepts were added', pack.added >= 1, String(pack.added));
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll real-Claude checks passed');
process.exit(failed ? 1 : 0);
