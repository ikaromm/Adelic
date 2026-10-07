/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { precacheEntries } from './src/pwa/sw-core.js';

const outDir = resolve(import.meta.dirname, 'dist');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * Writes dist/sw.js after the build (docs/specs/pwa.md). The precache list is the whole
 * output (index.html, hashed assets, offline page, manifest and icons), and the version is
 * a hash of those files, so any change to the shell installs a new worker and cache.
 */
function serviceWorker(): Plugin {
  return {
    name: 'adelic-service-worker',
    apply: 'build',
    async closeBundle() {
      const precache = precacheEntries(files(outDir).map((file) => relative(outDir, file)));
      const hash = createHash('sha256');
      for (const path of precache)
        hash
          .update(path)
          .update('\0')
          .update(readFileSync(join(outDir, path)));
      await build({
        entryPoints: [resolve(import.meta.dirname, 'src/pwa/sw-entry.ts')],
        outfile: join(outDir, 'sw.js'),
        bundle: true,
        format: 'iife',
        target: 'es2022',
        minify: true,
        legalComments: 'none',
        logLevel: 'warning',
        define: {
          __ADELIC_SW_VERSION__: JSON.stringify(hash.digest('hex').slice(0, 16)),
          __ADELIC_SW_PRECACHE__: JSON.stringify(precache),
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: { host: '127.0.0.1', watch: { ignored: ['**/.adelic/**', '**/.desktop/**', '**/release/**', '**/dist/**'] } },
  build: {
    outDir: 'dist',
    // offline.html is the service worker's fallback page, built with the same theme tokens.
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        offline: resolve(import.meta.dirname, 'offline.html'),
      },
    },
  },
  // Playwright specs (tests/e2e/*.spec.ts) run separately with `npm run test:e2e`.
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts', 'src/**/*.{ts,tsx}'],
      exclude: ['server/cli.ts', 'server/desktop-entry.ts', 'src/main.tsx', 'src/pwa/sw-entry.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // Floor for the server and shared code (the UI is covered by Playwright, not here).
      // Raise it as coverage grows; CI fails if it drops.
      thresholds: { 'server/**/*.ts': { lines: 80, branches: 65 }, 'shared/**/*.ts': { lines: 90 } },
    },
  },
});
