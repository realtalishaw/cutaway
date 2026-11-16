// Renaming a project: from the title bar while it's open, and from the projects list.
import fs from 'node:fs';
import path from 'node:path';
import { launch, root } from './harness.mjs';

const fx = (n) => path.resolve(root, '../../fixtures/generated', n);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

const { app, page } = await launch();
try {
  await page.evaluate((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  const state = () => page.evaluate(() => ({ path: window.__cutaway.useApp.getState().projectPath, name: window.__cutaway.useApp.getState().project?.name }));
  const before = await state();

  // ── title bar ──
  const title = page.locator('[data-testid="project-rename"]');
  check('the title bar name says it can be renamed', (await title.getAttribute('title')) === 'Rename project' && (await title.locator('.tb-pencil').count()) === 1);
  await title.click();
  await page.locator('[data-testid="project-name-input"]').fill('Launch demo');
  await page.locator('[data-testid="project-name-input"]').press('Enter');
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project?.name === 'Launch demo', null, { timeout: 10000 });
  let st = await state();
  check('renaming from the title bar renames the project and its folder', st.name === 'Launch demo' && path.basename(st.path) === 'Launch demo.cutaway' && fs.existsSync(st.path) && !fs.existsSync(before.path), st.path);
  const saved = JSON.parse(fs.readFileSync(path.join(st.path, 'project.json'), 'utf8'));
  check('the saved project has the new name', saved.name === 'Launch demo');

  // only the capitals change (the Mac's disk treats these as the same name)
  await title.click();
  await page.locator('[data-testid="project-name-input"]').fill('Launch Demo');
  await page.locator('[data-testid="project-name-input"]').press('Enter');
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project?.name === 'Launch Demo', null, { timeout: 10000 });
  st = await state();
  check('changing only capitals keeps one folder, without " 2"', path.basename(st.path) === 'Launch Demo.cutaway' && fs.readdirSync(path.dirname(st.path)).filter((n) => /^launch demo/i.test(n)).length === 1, fs.readdirSync(path.dirname(st.path)).join(', '));

  // Escape cancels
  await title.click();
  await page.locator('[data-testid="project-name-input"]').fill('Nope');
  await page.locator('[data-testid="project-name-input"]').press('Escape');
  check('Escape keeps the old name', (await state()).name === 'Launch Demo');

  // ── projects list ──
  await page.evaluate(() => window.__cutaway.saveNow());
  await page.evaluate(() => window.__cutaway.useApp.getState().closeProject());
  const card = page.locator('.project-card', { hasText: 'Launch Demo' });
  await card.waitFor({ timeout: 10000 });
  await card.hover();
  await card.locator('.more').click();
  await page.locator('[data-testid="card-rename"]').click();
  const input = page.locator('[data-testid="card-name-input"]');
  await input.fill('Product tour');
  await input.press('Enter');
  await page.locator('.project-card', { hasText: 'Product tour' }).waitFor({ timeout: 10000 });
  const dir = path.dirname(st.path);
  check('renaming from the projects list renames the folder', fs.existsSync(path.join(dir, 'Product tour.cutaway')) && !fs.existsSync(st.path));
  check('typing in the name box did not open the project', (await page.evaluate(() => window.__cutaway.useApp.getState().route)) === 'library');
  await page.locator('.project-card', { hasText: 'Product tour' }).click();
  await page.waitForFunction(() => window.__cutaway.useApp.getState().project?.name === 'Product tour', null, { timeout: 15000 });
  check('the renamed project opens with its new name', true);
} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
