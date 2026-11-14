// Opt-in: time a real first cut of a copied project and log the live status lines.
//   node e2e/firstcut-real-time.mjs <profileDir-with-Library/Copy.cutaway>
import path from 'node:path';
process.env.CUTAWAY_CLAUDE = 'on';
const { launch } = await import('./harness.mjs');
const dir = path.resolve(process.argv[2]);
const { app, page } = await launch({ profile: dir, settings: { claudeModel: 'sonnet', ...(process.env.CLAUDE_WRAP ? { claudePath: process.env.CLAUDE_WRAP } : {}) } });
try {
  const status = await page.evaluate(() => window.cutaway.ai.status(true));
  await page.evaluate((s) => window.__cutaway.useApp.setState({ claude: s }), status);
  await page.evaluate((p) => window.__cutaway.actions.openProjectAt(p), path.join(dir, 'Library', 'Copy.cutaway'));
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  await page.evaluate(() => void window.__cutaway.jobs.startFirstCut(true, true));
  let last = '';
  for (;;) {
    const s = await page.evaluate(() => { const st = window.__cutaway.useApp.getState(); const run = st.job?.stages.find((x) => x.status === 'running'); return { running: !!st.job && st.job.status === 'running', line: run ? `[${run.id}] ${run.detail}` : '', fc: st.project?.firstCut }; });
    const line = s.line;
    const key = line.replace(/\d+:\d\d/, '');
    if (key !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s  ${line}`); last = key; }
    if (!s.running) { console.log('DONE', ((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(s.fc)); break; }
    await page.waitForTimeout(1000);
  }
} finally {
  await app.close();
}
