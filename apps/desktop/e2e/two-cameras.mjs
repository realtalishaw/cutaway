// Two cameras in the editor: the Camera tab's main-camera choice, and switching cameras at the playhead (Ctrl+A).
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
  await page.evaluate((files) => window.__cutaway.actions.importIntoNewProject(files), [fx('screen.mp4'), fx('camera-a.mov'), fx('camera-b.mov')]);
  await page.waitForFunction(() => !!window.__cutaway.useApp.getState().project, null, { timeout: 30000 });
  // make sure the two camera files hold the two camera slots
  await page.evaluate(() => {
    const { useApp } = window.__cutaway;
    useApp.getState().patch((p) => {
      let seen = 0;
      // recorded together, so both are lined up with the screen; then open the editor
      const sources = p.sources.map((s) => (s.role === 'cameraA' || s.role === 'cameraB' ? { ...s, role: seen++ === 0 ? 'cameraA' : 'cameraB', sync: { ...s.sync, method: 'recorded-clock', status: 'aligned', offset: 0, confirmedByCreator: true } } : s));
      return { ...p, sources, ui: { ...p.ui, view: 'edit' } };
    });
  });
  const roles = await page.evaluate(() => window.__cutaway.useApp.getState().project.sources.map((s) => s.role));
  check('project has screen and two cameras', roles.includes('screen') && roles.includes('cameraA') && roles.includes('cameraB'), roles.join(','));

  await page.evaluate(() => window.__cutaway.useApp.setState((s) => ({ panels: { ...s.panels, inspector: true, tab: 'camera' } })));
  const note = page.locator('[data-testid="two-cameras-note"]');
  await note.waitFor({ timeout: 8000 });
  check('Camera tab explains the two cameras', /Camera A and Camera B were both recorded/.test(await note.innerText()));

  const camAt = (t) => page.evaluate((t) => window.__cutaway.core.resolveLayout(window.__cutaway.useApp.getState().project, t).camera, t);
  check('Camera A shows by default', (await camAt(2)) === 'A');
  await page.locator('.inspector button', { hasText: /^Camera B$/ }).first().click();
  check('picking Camera B makes it the main camera', (await camAt(2)) === 'B');
  await page.locator('.inspector button', { hasText: /^Camera A$/ }).first().click();
  check('and back to Camera A', (await camAt(2)) === 'A');

  // switch at the playhead with Ctrl+A
  await page.evaluate(() => window.__cutaway.useApp.getState().select(null));
  await page.locator('.preview, .stage, body').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(300);
  const lay = await page.evaluate(() => window.__cutaway.useApp.getState().project.edit.layouts.map((l) => ({ camera: l.camera, mode: l.mode, start: l.start, end: l.end })));
  check('Ctrl+A adds a view showing the other camera', lay.some((l) => l.camera === 'B'), JSON.stringify(lay));
  const sel = await page.evaluate(() => window.__cutaway.useApp.getState().selection);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(300);
  const after = await page.evaluate((id) => window.__cutaway.useApp.getState().project.edit.layouts.find((l) => l.id === id)?.camera, sel?.id);
  check('Ctrl+A on the selected view flips it back', sel?.kind === 'layout' && after === 'A', `${sel?.kind} → ${after}`);

} finally {
  await app.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
