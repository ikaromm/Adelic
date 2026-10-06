/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', watch: { ignored: ['**/.adelic/**', '**/.desktop/**', '**/release/**', '**/dist/**'] } },
  build: { outDir: 'dist' },
  // Playwright specs (tests/e2e/*.spec.ts) run separately with `npm run test:e2e`.
  test: { include: ['tests/**/*.test.{ts,tsx}'] },
});
