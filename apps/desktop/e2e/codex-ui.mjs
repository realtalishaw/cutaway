// Codex as the AI provider, end to end through the real app, against a fake `codex`
// executable (packages/ai/test/fake-codex.mjs). No account is used and nothing leaves
// this Mac:
//   node e2e/codex-ui.mjs [outDir]
// Covers: provider status and choice, consent that names OpenAI and is separate from
// Anthropic's, a first cut and thumbnail/title concepts through Codex, and thumbnail
// pictures (own consent, saved in the project, labelled, variations, manifest flag).
// The real CLI is exercised by e2e/codex-real.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFakeCodex } from '../../../packages/ai/test/fake-codex.mjs';

const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'cutaway-codex-ui'));
fs.mkdirSync(out, { recursive: true });
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cutaway-codex-ui-')));
const fakeDir = path.join(work, 'fake');
const codexHome = path.join(work, 'codex-home');
fs.mkdirSync(fakeDir);
fs.mkdirSync(codexHome);
const fake = makeFakeCodex(fakeDir);
const set = (name, value) => (value === null ? fs.rmSync(path.join(fakeDir, name), { force: true }) : fs.writeFileSync(path.join(fakeDir, name), value));
const calls = () => Number(fs.existsSync(path.join(fakeDir, 'calls.txt')) ? fs.readFileSync(path.join(fakeDir, 'calls.txt'), 'utf8') : '0');
const lastArgs = () => JSON.parse(fs.readFileSync(path.join(fakeDir, 'args.json'), 'utf8'));
const lastPrompt = () => fs.readFileSync(path.join(fakeDir, 'stdin.txt'), 'utf8');

process.env.CUTAWAY_CODEX = 'on';
process.env.CUTAWAY_CLAUDE = 'off';
process.env.CODEX_HOME = codexHome;
const { launch, root } = await import('./harness.mjs');
const fx = (n) => path.resolve(root, '../../fixtures/generated', n);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
};

// A solid 16:9 picture for the fake image tool to "make".
{
  const { execFileSync } = await import('node:child_process');
  const ffmpeg = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1e7a46:s=1280x720', '-frames:v', '1', path.join(fakeDir, 'image.png')]);
}

const { app, page, libraryDir, exportDir } = await launch({ settings: { aiProvider: 'codex', codexPath: fake } });
try {
  // ── status and choice ──
  const all = await page.evaluate(() => window.cutaway.ai.providers(true));
  check('Codex is found, signed in and the provider in use', all.active === 'codex' && all.codex.found && all.codex.signedIn === true && all.codex.version === '9.9.9', JSON.stringify({ active: all.active, codex: [all.codex.found, all.codex.signedIn, all.codex.version] }));
  check('Claude Code is reported separately (switched off in this run)', all.claude.found === false && all.claude.provider === 'claude');
  const status = await page.evaluate(() => window.cutaway.ai.status(true));
  check('ai.status() describes the provider in use', status.provider === 'codex' && status.signedIn === true);
  await page.evaluate((s) => window.__cutaway.useApp.setState({ claude: s }), status);

  set('status.txt', 'Not logged in');
  const off = await page.evaluate(() => window.cutaway.ai.providers(true));
  check('a signed-out Codex is reported as such, with its own sign-in command', off.codex.signedIn === false && /codex login/.test(off.codex.message), off.codex.message);
  set('status.txt', null);
  await page.evaluate(() => window.cutaway.ai.providers(true));

  // ── settings ──
  await page.evaluate(() => window.__cutaway.useApp.getState().go('settings'));
  await page.getByRole('button', { name: 'Processing' }).click();
  await page.waitForSelector('[data-testid="ai-codex"][data-state="ok"]', { timeout: 15000 });
  check('Settings shows both apps and marks Codex as in use', (await page.locator('[data-testid="ai-codex"] [data-testid="ai-in-use"]').count()) === 1 && (await page.locator('[data-testid="ai-claude"] [data-testid="ai-in-use"]').count()) === 0);
  const sent = await page.locator('[data-testid="ai-disclosure"]').innerText();
  check('"What leaves this Mac" names OpenAI and Codex, not Anthropic', /OpenAI, through the Codex app/.test(sent) && !/Anthropic|Claude/.test(sent), sent.slice(0, 110).replace(/\n/g, ' '));
  await shot(page, '1-settings-ai');

  // ── first cut through Codex ──
  await page.evaluate((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4'), fx('camera-a.mov')]);
  await page.evaluate(() => (window.__cutaway.useApp.getState().go('project'), window.__cutaway.useApp.getState().setView('brief')));
  check('a new project has allowed nothing', (await page.evaluate(() => window.__cutaway.jobs.consentState(window.__cutaway.useApp.getState().project))) === 'needed');
  set('reply.json', JSON.stringify({ summary: 'Zoomed in where the export panel opens.', ops: [{ op: 'zoom', start: 8, end: 12, kind: null, speed: null, mode: null, camera: null, transition: null, scale: 1.8, x: 0.5, y: 0.5, follow: false, text: null, subtext: null, assetId: null, assetIn: null, title: null, reason: 'the export panel opens', confidence: 'high', apply: null }], chapters: [], notes: [] }));
  const before = calls();
  await page.getByRole('button', { name: /Create first cut/ }).click();
  await page.waitForSelector('[data-testid="consent-allow"]', { timeout: 10000 });
  const sheet = await page.locator('.modal, [role="dialog"]').first().innerText();
  check('the consent sheet names Codex and OpenAI, never Anthropic', /Use Codex for the first cut\?/.test(sheet) && /OpenAI, through the Codex app/.test(sheet) && !/Anthropic|Claude/.test(sheet), sheet.slice(0, 90).replace(/\n/g, ' '));
  check('its button says who is being allowed', /Allow OpenAI for this project/.test(await page.locator('[data-testid="consent-allow"]').innerText()));
  check('nothing was sent before the answer', calls() === before);
  await shot(page, '2-consent-openai');
  await page.locator('[data-testid="consent-allow"]').click();
  await page.waitForFunction(() => { const s = window.__cutaway.useApp.getState(); return !s.job && !!s.project?.firstCut; }, null, { timeout: 5 * 60000 });
  const cut = await page.evaluate(() => {
    const p = window.__cutaway.useApp.getState().project;
    return { firstCut: p.firstCut, consent: p.consent, aiZooms: p.edit.zooms.filter((z) => z.meta.origin === 'ai').map((z) => [z.start, z.end, z.scale]) };
  });
  check('the first cut was made with Codex and says so', cut.firstCut.mode === 'claude' && cut.firstCut.provider === 'codex' && /Codex: Zoomed in/.test(cut.firstCut.summary), JSON.stringify({ mode: cut.firstCut.mode, provider: cut.firstCut.provider }));
  check('its edit was applied (nulls for unused fields were dropped)', cut.aiZooms.some((z) => Math.abs(z[0] - 8) < 0.6 && z[2] === 1.8), JSON.stringify(cut.aiZooms));
  check('consent is recorded for OpenAI', cut.consent?.provider === 'OpenAI via local Codex', cut.consent?.provider);
  const a = lastArgs();
  check('Codex ran read-only, isolated, with the stills attached', a[a.indexOf('--sandbox') + 1] === 'read-only' && a.includes('--ignore-user-config') && a.includes('--ephemeral') && a.filter((x) => x === '--image').length >= 1 && !a.join(' ').match(/dangerously|workspace-write|approve-for-me/), `${a.filter((x) => x === '--image').length} stills`);
  check('the prompt tells it the stills are attachments', /still frames? listed above (is|are) attached/.test(lastPrompt()));
  await page.evaluate(() => window.__cutaway.useApp.getState().setPanels({ inspector: true, tab: 'review' }));
  await page.waitForTimeout(500);
  check('the Review card says "Assembled with Codex"', await page.getByText('Assembled with Codex').first().isVisible().catch(() => false));
  await shot(page, '3-first-cut-codex');

  // Switching provider: consent given to OpenAI does not cover Anthropic.
  const swapped = await page.evaluate(() => {
    const { useApp, jobs } = window.__cutaway;
    const mine = useApp.getState().claude;
    useApp.setState({ claude: { found: true, path: '/x/claude', version: '2.1.0', signedIn: true, message: 'ok', provider: 'claude' } });
    const asClaude = jobs.consentState(useApp.getState().project);
    useApp.setState({ claude: mine });
    return { asClaude, asCodex: jobs.consentState(useApp.getState().project) };
  });
  check('after a switch to Claude Code the project asks again; back on Codex it is still allowed', swapped.asClaude === 'needed' && swapped.asCodex === 'granted', JSON.stringify(swapped));

  // ── concepts through Codex ──
  set('reply.json', JSON.stringify({ concepts: ['Export settings, start to finish', 'The export setting people skip', 'Render a first video without the usual mistakes'].map((title, i) => ({ title, thumbnailText: ['EXPORT RIGHT', 'DO NOT SKIP', 'FIRST RENDER'][i], template: 'headline', frameIndex: 0, paletteIndex: i, rationale: 'The video walks through the export panel.', evidence: [] })), description: 'A walkthrough of the export panel.', chapters: [] }));
  await page.evaluate(() => window.__cutaway.useApp.getState().setView('package'));
  await page.getByRole('button', { name: /Create three concepts/ }).click();
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project.packaging.concepts.length >= 3, null, { timeout: 3 * 60000 });
  const concepts = await page.evaluate(() => window.__cutaway.useApp.getState().project.packaging.concepts.map((c) => [c.title, c.origin, c.aiProvider]));
  check('three concepts came from Codex without asking again', concepts.length === 3 && concepts.every((c) => c[1] === 'ai' && c[2] === 'codex'), JSON.stringify(concepts.map((c) => c[2])));
  await page.waitForTimeout(600);
  check('the cards say "From Codex"', (await page.getByText('From Codex').count()) >= 1);

  // ── thumbnail pictures ──
  await page.waitForSelector('[data-testid="art-generate"]', { timeout: 15000 });
  set('image.txt', '1');
  set('reply.json', JSON.stringify({ generated: true, note: 'A green studio backdrop with soft light.' }));
  const beforeArt = calls();
  await page.locator('[data-testid="art-direction"]').fill('a calm green studio backdrop');
  await page.locator('[data-testid="art-generate"]').click();
  await page.waitForSelector('[data-testid="consent-allow"]', { timeout: 10000 });
  const artSheet = await page.locator('.modal, [role="dialog"]').first().innerText();
  check('pictures ask separately and say what is sent', /Use Codex for thumbnail pictures\?/.test(artSheet) && /thumbnail art: the concept title/i.test(artSheet) && /labelled as AI-generated/.test(artSheet), artSheet.slice(0, 80).replace(/\n/g, ' '));
  await shot(page, '4-consent-pictures');
  await page.locator('[data-testid="consent-decline"]').click();
  await page.waitForSelector('[data-testid="art-note"]');
  check('declining sends nothing and makes nothing', calls() === beforeArt && /Nothing was sent/.test(await page.locator('[data-testid="art-note"]').innerText()) && !fs.existsSync(path.join(await page.evaluate(() => window.__cutaway.useApp.getState().projectPath), 'media', 'generated')));
  await page.locator('[data-testid="art-generate"]').click();
  await page.locator('[data-testid="consent-allow"]').click();
  await page.waitForSelector('[data-testid="art-variations"] figure', { timeout: 60000 });
  const projectPath = await page.evaluate(() => window.__cutaway.useApp.getState().projectPath);
  const artState = () =>
    page.evaluate(() => {
      const p = window.__cutaway.useApp.getState().project;
      const c = p.packaging.concepts.find((x) => (x.art ?? []).length) ?? p.packaging.concepts[0];
      return { artConsent: p.artConsent, art: c.art ?? [], layers: c.layers.map((l) => ({ kind: l.kind, path: l.path, generated: l.generated ?? null })), consent: p.consent };
    });
  let st = await artState();
  const made = st.art[0];
  check('one picture was made and saved inside the project', st.art.length === 1 && /^media\/generated\/art-[a-z0-9-]+\.png$/.test(made.path) && fs.statSync(path.join(projectPath, made.path)).size > 100, made?.path);
  check('it is recorded as made by OpenAI, with the creator\'s direction', made.provider === 'OpenAI via local Codex' && made.direction === 'a calm green studio backdrop' && /green studio/.test(made.note));
  const kinds = st.layers.map((l) => (l.generated ? 'art' : l.kind));
  check('it sits above the video frame and below the text, which is still an editable layer', kinds.indexOf('art') === kinds.lastIndexOf('frame') + 1 && kinds.indexOf('text') > kinds.indexOf('art'), kinds.join(' › '));
  check('picture permission is its own record; edit consent is unchanged', st.artConsent?.provider === 'OpenAI via local Codex' && st.consent?.scope.length === 3);
  const ia = lastArgs();
  const ip = lastPrompt();
  check('the request was read-only with at most two reference stills', ia[ia.indexOf('--sandbox') + 1] === 'read-only' && ia.filter((x) => x === '--image').length <= 2);
  check('the instruction carries the fixed rules and the direction', /No words, letters, numbers/.test(ip) && /no realistic human faces/.test(ip) && /No logos/.test(ip) && /a calm green studio backdrop/.test(ip) && /do not draw it yourself/.test(ip));
  await page.waitForTimeout(800);
  check('the concept is labelled as having an AI picture', (await page.locator('[data-testid="art-pill"]').count()) >= 1 && (await page.getByText('AI-generated').count()) >= 1);
  // The preview canvas really shows it: sample the thumbnail in the editor.
  const green = await page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].filter((x) => x.width >= 640).sort((a, b) => b.width - a.width)[0];
    if (!c) return null;
    const d = c.getContext('2d').getImageData(Math.round(c.width * 0.93), Math.round(c.height * 0.5), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  check('the thumbnail canvas shows the generated picture', !!green && green[1] > green[0] + 25 && green[1] > green[2] + 25, JSON.stringify(green));
  await shot(page, '5-art-in-thumbnail');

  await page.locator('[data-testid="art-generate"]').click(); // "Make another": no sheet this time
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project.packaging.concepts.some((c) => (c.art ?? []).length === 2), null, { timeout: 60000 });
  st = await artState();
  check('a second variation is kept beside the first, one in use', st.art.length === 2 && st.layers.filter((l) => l.generated).length === 1 && st.layers.find((l) => l.generated).path === st.art[1].path);
  await page.evaluate(() => window.__cutaway.useApp.getState().undo());
  st = await artState();
  check('undo takes the second picture back out in one step', st.layers.find((l) => l.generated)?.path === st.art[0].path, String(st.art.length));
  await page.evaluate(() => window.__cutaway.useApp.getState().redo());
  st = await artState();
  const spare = st.art[0];
  await page.locator('[data-testid="art-variations"] figure').first().getByRole('button', { name: 'Discard this picture' }).click();
  await page.waitForTimeout(700);
  st = await artState();
  check('discarding a spare variation deletes its file and nothing else', st.art.length === 1 && !fs.existsSync(path.join(projectPath, spare.path)) && fs.existsSync(path.join(projectPath, st.art[0].path)) && st.layers.filter((l) => l.generated).length === 1);
  await page.evaluate((pp) => window.cutaway.ai.removeImage(pp, 'project.json'), projectPath);
  await page.evaluate((pp) => window.cutaway.ai.removeImage(pp, '../../outside.png'), projectPath);
  check('the delete call refuses anything that is not a generated picture', fs.existsSync(path.join(projectPath, 'project.json')));

  // ── a failed picture leaves the thumbnail alone ──
  set('image.txt', null);
  set('reply.json', JSON.stringify({ generated: false, note: 'image generation is not available on this account' }));
  await page.locator('[data-testid="art-generate"]').click();
  await page.getByText('No picture was made').first().waitFor({ timeout: 60000 });
  const msg = await page.locator('[data-testid="art-panel"]').innerText();
  st = await artState();
  check('a refusal is shown with its reason and changes nothing', /image generation is not available on this account/.test(msg) && st.art.length === 1, msg.match(/Codex did not[^.]*\./)?.[0] ?? '');
  await shot(page, '6-art-failed');

  // ── the package says so ──
  const exp = await page.evaluate(async (dest) => {
    const { useApp, packageExport } = window.__cutaway;
    const s = useApp.getState();
    const c = s.project.packaging.concepts.find((x) => (x.art ?? []).length);
    s.pack((p) => ({ ...p, selectedId: c.id, reviewed: true }), 'Choose');
    await window.__cutaway.saveNow();
    const st = useApp.getState();
    const r = await packageExport.runPackageExport({ project: st.project, projectPath: st.projectPath, destDir: dest, draft: true, onProgress: () => {}, signal: new AbortController().signal });
    return { ok: r.ok ?? r.status === 'complete', folder: r.folder ?? r.record?.folder ?? null, error: r.error ?? null };
  }, exportDir);
  const folder = exp.folder ?? fs.readdirSync(exportDir).map((n) => path.join(exportDir, n)).find((p) => fs.existsSync(path.join(p, 'package.json')));
  const manifest = folder && fs.existsSync(path.join(folder, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) : null;
  check('the exported package records that the thumbnail contains an AI-generated picture', manifest?.thumbnail?.aiGenerated?.provider === 'OpenAI via local Codex' && manifest.thumbnail.aiGenerated.layers === 1 && manifest.validation.notes.some((n) => /AI-generated picture/.test(n)), JSON.stringify(manifest?.thumbnail?.aiGenerated ?? exp));

  // ── reopen: the picture is still found by its project-relative path ──
  await page.evaluate(() => window.__cutaway.saveNow());
  const reopened = await page.evaluate(async (pp) => {
    const { actions, useApp } = window.__cutaway;
    await actions.backToLibrary();
    await actions.openProjectAt(pp);
    const p = useApp.getState().project;
    const c = p.packaging.concepts.find((x) => (x.art ?? []).length);
    return { art: c?.art?.length ?? 0, layer: c?.layers.find((l) => l.generated)?.path ?? null, artConsent: p.artConsent?.provider ?? null };
  }, projectPath);
  check('after reopening, the picture, its label and the permission are all still there', reopened.art === 1 && /^media\/generated\//.test(reopened.layer ?? '') && reopened.artConsent === 'OpenAI via local Codex', JSON.stringify(reopened));
  check('nothing was written outside the test folders', fs.readdirSync(codexHome).join() === 'generated_images' && libraryDir.startsWith(os.tmpdir().replace(/\/$/, '')) || libraryDir.includes('cutaway-e2e-'));
} finally {
  await app.close().catch(() => {});
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll Codex UI checks passed');
console.log(`screenshots → ${out}`);
process.exit(failed ? 1 : 0);
