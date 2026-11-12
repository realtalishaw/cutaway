// Dev loop: Vite serves the renderer with HMR, esbuild bundles main, Electron runs against both.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildMain } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
await buildMain();
const server = await createServer({ root, configFile: path.join(root, 'vite.config.mts') });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const electron = require('electron');
const child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, CUTAWAY_DEV_URL: url } });
child.on('close', async () => {
  await server.close();
  process.exit(0);
});
