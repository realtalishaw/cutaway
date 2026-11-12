import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src/renderer'), '@shared': path.resolve(import.meta.dirname, 'src/shared') } },
  build: { outDir: 'dist/renderer', emptyOutDir: true, target: 'chrome140', sourcemap: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5199, strictPort: false },
});
