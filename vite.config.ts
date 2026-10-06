/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', watch: { ignored: ['**/.adelic/**', '**/.desktop/**', '**/release/**', '**/dist/**'] } },
  build: { outDir: 'dist' },
  // Playwright specs (tests/e2e/*.spec.ts) run separately with `npm run test:e2e`.
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts', 'src/**/*.{ts,tsx}'],
      exclude: ['server/cli.ts', 'server/desktop-entry.ts', 'src/main.tsx'],
      reporter: ['text-summary', 'json-summary', 'html'],
      // Floor for the server and shared code (the UI is covered by Playwright, not here).
      // Raise it as coverage grows; CI fails if it drops.
      thresholds: { 'server/**/*.ts': { lines: 80, branches: 65 }, 'shared/**/*.ts': { lines: 90 } },
    },
  },
});
