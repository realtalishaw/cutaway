import { launch } from './harness.mjs';
const out = process.argv[2] ?? '/tmp/cutaway-shot.png';
const { app, page } = await launch();
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
console.log('saved', out);
await app.close();
