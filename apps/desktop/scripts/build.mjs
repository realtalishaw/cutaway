// Builds main + preload + worker with esbuild and the renderer with Vite.
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'], logLevel: 'warning' };

export async function buildMain() {
  await Promise.all([
    esbuild({ ...common, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(root, 'dist/main/index.cjs') }),
    esbuild({ ...common, entryPoints: [path.join(root, 'src/main/worker.ts')], outfile: path.join(root, 'dist/main/worker.cjs') }),
    esbuild({ ...common, entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(root, 'dist/preload/index.cjs') }),
    // the MCP server AI tools start: one file, no dependencies, run on the app's own runtime
    esbuild({ ...common, sourcemap: false, entryPoints: [path.join(root, 'src/mcp/server.ts')], outfile: path.join(root, 'dist/mcp/cutaway-mcp.cjs') }),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildMain();
  await viteBuild({ root, configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn' });
  console.log('built → apps/desktop/dist');
}
