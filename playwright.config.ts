import { defineConfig } from '@playwright/test';

// E2E against the real backend and web build with a scripted provider (tests/e2e/server.ts).
// Uses the system Chromium when PLAYWRIGHT_CHROMIUM is set (no browser download needed);
// otherwise Playwright's own Chromium (`npx playwright install chromium`).
const port = Number(process.env.E2E_PORT || 4399);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npx tsx tests/e2e/server.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    // Never reach the user's real ai-memory: point it at a closed loopback port.
    env: { E2E_PORT: String(port), ADELIC_MEMORY_URL: 'http://127.0.0.1:9', ADELIC_MEMORY_TOKEN: '' },
  },
});
