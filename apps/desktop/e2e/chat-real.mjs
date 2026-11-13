// The Ask AI chat against the real Claude Code CLI on this Mac. Uses the creator's own
// Claude account, so it is never part of the default e2e run:
//   node e2e/chat-real.mjs [outDir]
// Exits 2 (skipped) when the CLI is missing or not signed in.
// Sends only the generated fixture footage: its transcript and edit metadata (no stills:
// both messages are about the whole video).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CUTAWAY_CLAUDE = 'on';
const { launch, root } = await import('./harness.mjs');

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-chat-real'));
fs.mkdirSync(out, { recursive: true });
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

const { app, page } = await launch();
const state = (fn, arg) => page.evaluate(fn, arg);
const replies = () => page.locator('[data-testid="chat-reply"]');
const ask = async (text, count) => {
  const t0 = Date.now();
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-input"]').press('Enter');
  await page.waitForFunction((c) => document.querySelectorAll('[data-testid="chat-reply"]').length >= c && !document.querySelector('[data-testid="chat-thinking"]'), count, { timeout: 8 * 60000 });
  return (Date.now() - t0) / 1000;
};
const zooms = () => state(() => window.__cutaway.useApp.getState().project.edit.zooms.map((z) => [+z.start.toFixed(1), +z.end.toFixed(1), z.meta.origin]));

try {
  const status = await state(() => window.cutaway.ai.status(true));
  console.log('provider', JSON.stringify({ provider: status.provider, found: status.found, path: status.path, version: status.version, signedIn: status.signedIn }));
  if (!status.found || status.signedIn !== true) {
    console.log(`SKIPPED: ${status.message}`);
    await app.close();
    process.exit(2);
  }

  // A cut made on this Mac by the built-in rules (transcript, pauses, activity), plus two known zooms early on.
  await state((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4'), fx('camera-a.mov')]);
  await state(() => void window.__cutaway.jobs.startFirstCut(false));
  await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return !s.job || s.job.status !== 'running'; }, null, { timeout: 5 * 60000 });
  const seeded = await state((s) => {
    const { useApp, core, jobs } = window.__cutaway;
    let st = useApp.getState();
    // Start from no zooms at all, then place two early ones, so the request has an exact right answer.
    st.edit((e) => ({ ...e, zooms: [] }), 'Clear zooms');
    st = useApp.getState();
    st.replace(core.applyProposal(st.project, [{ op: 'zoom', start: 1.5, end: 4.5, scale: 1.8, x: 0.3, y: 0.3, reason: 'Opening the panel' }, { op: 'zoom', start: 6, end: 9, scale: 1.8, x: 0.6, y: 0.4, reason: 'A click' }], { label: 'Seeded zooms' }).project, 'Seeded zooms');
    useApp.setState({ claude: s });
    jobs.grantConsent();
    st = useApp.getState();
    st.setView('edit');
    st.setPanels({ inspector: true, tab: 'chat' });
    const p = useApp.getState().project;
    return { firstCut: p.firstCut?.mode, words: p.transcript?.words.length ?? 0, text: (p.transcript?.words ?? []).map((w) => w.text).join(' ').slice(0, 500), cuts: p.edit.cuts.length, consent: jobs.consentState(p) };
  }, status);
  console.log('project', JSON.stringify(seeded));
  check('a local first cut with a transcript is in place and the provider may be used', seeded.firstCut === 'local-rules' && seeded.words > 20 && seeded.consent === 'granted');
  const z0 = await zooms();
  await page.waitForSelector('[data-testid="chat-tab"]');

  // ── message 1 ──
  const t1 = await ask('Remove the zooms in the first ten seconds', 1);
  const r1 = replies().nth(0);
  const c1 = await r1.locator('[data-testid="chat-card"]').evaluateAll((els) => els.map((e) => [e.dataset.kind, e.dataset.status, e.querySelector('.chat-card-what').textContent, e.querySelector('[data-testid="chat-jump"]').textContent]));
  console.log(`reply 1 (${t1.toFixed(0)}s):`, (await r1.locator('.chat-text').innerText()).replace(/\s+/g, ' '));
  console.log('cards 1', JSON.stringify(c1));
  check('the first reply came from the model, not the built-in rules', (await r1.getAttribute('data-mode')) === 'claude');
  check('it proposes removing both early zooms and nothing was applied yet', c1.filter((c) => c[0] === 'remove' && c[1] === 'open').length === 2 && JSON.stringify(await zooms()) === JSON.stringify(z0), JSON.stringify(c1.map((c) => c.slice(0, 2))));
  await page.screenshot({ path: path.join(out, '1-proposal.png') });
  await (c1.filter((c) => c[1] === 'open').length > 1 ? r1.locator('[data-testid="chat-apply-all"]') : r1.locator('[data-testid="chat-apply"]')).click();
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project.revisions.some((r) => r.via === 'chat'), null, { timeout: 15000 });
  const z1 = await zooms();
  check('applying it leaves no zoom in the first ten seconds', z1.every((z) => z[0] >= 10), JSON.stringify(z1));
  const v1 = await state(() => { const p = window.__cutaway.useApp.getState().project; const r = p.revisions.find((x) => x.via === 'chat'); return r && { revision: r.revision, label: r.label }; });
  check('the change is saved as a version linked from the reply', !!v1 && (await r1.locator('[data-testid="chat-view-version"]').isVisible()), JSON.stringify(v1));

  // ── message 2: a follow-up that only makes sense with the conversation ──
  const t2 = await ask('Actually bring one back where the format is chosen', 2);
  const r2 = replies().nth(1);
  const c2 = await r2.locator('[data-testid="chat-card"]').evaluateAll((els) => els.map((e) => [e.dataset.kind, e.dataset.status, e.querySelector('.chat-card-what').textContent, e.querySelector('[data-testid="chat-jump"]').textContent, e.querySelector('.tiny.muted')?.textContent ?? '']));
  console.log(`reply 2 (${t2.toFixed(0)}s):`, (await r2.locator('.chat-text').innerText()).replace(/\s+/g, ' '));
  console.log('cards 2', JSON.stringify(c2));
  check('the follow-up came from the model', (await r2.getAttribute('data-mode')) === 'claude');
  const adds = c2.filter((c) => c[0] === 'add' && c[1] === 'open' && /^Zoom/.test(c[2]));
  check('it proposes one zoom, with a reason', adds.length === 1 && adds[0][4].length > 0, JSON.stringify(c2.map((c) => c.slice(0, 3))));
  await page.screenshot({ path: path.join(out, '2-follow-up.png') });
  const before2 = await state(() => window.__cutaway.useApp.getState().project.revision);
  await (c2.filter((c) => c[1] === 'open').length > 1 ? r2.locator('[data-testid="chat-apply-all"]') : r2.locator('[data-testid="chat-apply"]')).first().click();
  await page.waitForFunction((r) => window.__cutaway.useApp.getState().project.revision > r, before2, { timeout: 15000 });
  const z2 = await zooms();
  check('applying it adds exactly one zoom', z2.length === z1.length + 1, JSON.stringify(z2));

  // ── versions ──
  const live = await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit));
  await r1.locator('[data-testid="chat-view-version"]').click();
  await page.waitForSelector('[data-testid="version-bar"]');
  const viewed = await state(() => { const { useApp, viewedProject } = window.__cutaway; return { zooms: viewedProject(useApp.getState()).edit.zooms.length, liveSame: null }; });
  check('viewing the first reply’s version shows the edit without the new zoom, and changes nothing', viewed.zooms === z1.length && (await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit))) === live);
  await page.screenshot({ path: path.join(out, '3-viewing.png') });
  await page.locator('[data-testid="version-restore"]').click();
  check('restoring it makes that the current edit', (await zooms()).length === z1.length && (await state(() => window.__cutaway.useApp.getState().viewing)) === null);
  await state(() => window.__cutaway.useApp.getState().undo());
  check('one undo brings the newer edit back', (await state(() => JSON.stringify(window.__cutaway.useApp.getState().project.edit))) === live);
  console.log(`time per reply: ${t1.toFixed(0)}s and ${t2.toFixed(0)}s`);
} catch (e) {
  failed++;
  console.log('ERROR', e.stack ?? e.message);
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll real chat checks passed');
process.exit(failed ? 1 : 0);
