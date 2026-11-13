// The AI path against the real Codex CLI on this Mac, including one generated
// thumbnail picture. Uses the creator's own ChatGPT/OpenAI account, so it is never part
// of the default e2e run:
//   node e2e/codex-real.mjs [outDir]
// Exits 2 (skipped) when the CLI is missing or not signed in.
// Sends only the generated fixture footage: its transcript, edit metadata and stills.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CUTAWAY_CODEX = 'on';
process.env.CUTAWAY_CLAUDE = 'off';
const { launch, root } = await import('./harness.mjs');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-codex-real'));
fs.mkdirSync(out, { recursive: true });
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
const secs = (t0) => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const { app, page } = await launch({ settings: { aiProvider: 'codex' } });
try {
  const status = await page.evaluate(() => window.cutaway.ai.status(true));
  console.log('codex', JSON.stringify({ provider: status.provider, found: status.found, path: status.path, version: status.version, signedIn: status.signedIn }));
  if (status.provider !== 'codex' || !status.found || status.signedIn !== true) {
    console.log(`SKIPPED: ${status.message}`);
    await app.close();
    process.exit(2);
  }
  await page.evaluate((s) => window.__cutaway.useApp.setState({ claude: s }), status);

  await page.evaluate((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4'), fx('camera-a.mov')]);
  await page.evaluate(() => window.__cutaway.jobs.grantConsent());
  const consent = await page.evaluate(() => window.__cutaway.useApp.getState().project.consent.provider);
  check('consent recorded for OpenAI, Codex usable', consent === 'OpenAI via local Codex' && (await page.evaluate(() => window.__cutaway.jobs.consentState(window.__cutaway.useApp.getState().project))) === 'granted', consent);

  // ── first cut ──
  let t0 = Date.now();
  await page.evaluate(() => void window.__cutaway.jobs.startFirstCut(true));
  await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return !s.job || s.job.status !== 'running'; }, null, { timeout: 20 * 60000 });
  const cut = await page.evaluate(() => {
    const { useApp, timeMapOf } = window.__cutaway;
    const s = useApp.getState();
    const p = s.project;
    const count = (lane) => p.edit[lane].filter((x) => x.meta.origin === 'ai').length;
    return { job: s.job && { status: s.job.status, error: s.job.error }, firstCut: p.firstCut, ai: { cuts: count('cuts'), layouts: count('layouts'), zooms: count('zooms'), overlays: count('overlays') }, suggestions: p.edit.suggestions.length, duration: p.duration, out: timeMapOf(p).outDuration };
  });
  console.log('first cut', JSON.stringify(cut, null, 1), secs(t0));
  check('first cut finished', !cut.job && !!cut.firstCut);
  check('the editorial pass came from Codex, not the built-in rules', cut.firstCut?.mode === 'claude' && cut.firstCut?.provider === 'codex', `${cut.firstCut?.mode}/${cut.firstCut?.provider}`);
  check('its decisions were applied', cut.ai.cuts + cut.ai.layouts + cut.ai.zooms + cut.ai.overlays > 0, JSON.stringify(cut.ai));
  check('the cut is shorter than the take but not empty', cut.out > 2 && cut.out <= cut.duration + 0.01, `${cut.out.toFixed(1)}s of ${cut.duration.toFixed(1)}s`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, '1-first-cut.png') });

  // ── section revision ──
  t0 = Date.now();
  const rev = await page.evaluate(async () => {
    const { useApp, jobs } = window.__cutaway;
    const p = useApp.getState().project;
    const range = { start: Math.min(4, p.duration / 4), end: Math.min(14, p.duration * 0.75) };
    await jobs.reviseSection(range, 'No zooms in this part, and show only the screen.');
    const c = useApp.getState().comparison;
    return c ? { label: c.label, notes: c.notes } : { none: useApp.getState().toasts?.at(-1)?.text ?? 'no comparison' };
  });
  console.log('revision', JSON.stringify(rev), secs(t0));
  check('a section revision came back as a comparison, not a fallback', !rev.none && !(rev.notes ?? []).some((n) => /Built-in rules were used/.test(n)), rev.none ?? JSON.stringify(rev.notes));
  if (!rev.none) await page.evaluate(() => window.__cutaway.jobs.acceptComparison());

  // ── concepts ──
  t0 = Date.now();
  const pack = await page.evaluate(async () => {
    const { useApp, jobs, pipeline } = window.__cutaway;
    const r = await pipeline.generatePackaging(jobs.jobContext(new AbortController().signal, true));
    const p = useApp.getState().project;
    return { ai: r.ai, added: r.added, notes: r.notes, concepts: p.packaging.concepts.map((c) => ({ title: c.title, origin: c.origin, aiProvider: c.aiProvider ?? null })).slice(0, 6) };
  });
  console.log('packaging', JSON.stringify(pack, null, 1), secs(t0));
  check('thumbnail and title concepts came from Codex', pack.ai.mode === 'claude' && pack.ai.provider === 'codex' && pack.concepts.some((c) => c.aiProvider === 'codex'), pack.ai.reason ?? '');

  // ── one generated picture, through the Package tab ──
  await page.evaluate(() => (window.__cutaway.useApp.getState().go('project'), window.__cutaway.useApp.getState().setView('package')));
  await page.waitForSelector('[data-testid="art-generate"]', { timeout: 30000 });
  t0 = Date.now();
  await page.locator('[data-testid="art-generate"]').click();
  await page.waitForSelector('[data-testid="consent-allow"]', { timeout: 10000 });
  await page.screenshot({ path: path.join(out, '2-picture-consent.png') });
  await page.locator('[data-testid="consent-allow"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="art-panel"] .spinner'), null, { timeout: 10 * 60000 });
  const art = await page.evaluate(() => {
    const s = window.__cutaway.useApp.getState();
    const c = s.project.packaging.concepts.find((x) => (x.art ?? []).length);
    return { projectPath: s.projectPath, art: c?.art ?? [], inUse: c?.layers.find((l) => l.generated)?.path ?? null, panel: document.querySelector('[data-testid="art-panel"]')?.innerText ?? '' };
  });
  console.log('picture', JSON.stringify({ art: art.art.map((a) => ({ path: a.path, note: a.note })), inUse: art.inUse }), secs(t0));
  const file = art.art[0] ? path.join(art.projectPath, art.art[0].path) : null;
  check('Codex made a picture and it was saved in the project', !!file && fs.existsSync(file) && fs.statSync(file).size > 50_000, file ? `${(fs.statSync(file).size / 1e6).toFixed(2)} MB` : art.panel.slice(-200));
  if (file && fs.existsSync(file)) {
    const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString().match(/\d+/g).slice(-2).map(Number);
    check('it is a landscape picture large enough for a thumbnail', dims[0] >= 1280 && dims[0] / dims[1] > 1.5 && dims[0] / dims[1] < 1.9, dims.join('×'));
    check('it is in the thumbnail as a labelled layer', art.inUse === art.art[0].path);
    fs.copyFileSync(file, path.join(out, `generated${path.extname(file)}`));
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, '3-picture-in-thumbnail.png') });
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll real-Codex checks passed');
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
