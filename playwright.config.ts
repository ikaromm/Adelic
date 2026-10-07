import { defineConfig } from '@playwright/test';

// E2E against the real backend and web build with a scripted provider (tests/e2e/server.ts).
// Uses the system Chromium when PLAYWRIGHT_CHROMIUM is set (no browser download needed);
// otherwise Playwright's own Chromium (`npx playwright install chromium`).
const port = Number(process.env.E2E_PORT || 4399);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;
export const memoryAppPort = port + 1;
export const fakeMemoryPort = port + 2;
/** Loopback listener in the Tailscale Funnel role (remote-login.spec.ts): always "internet". */
export const funnelPort = port + 3;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    // Specs assert pt-BR text; the UI's `auto` language follows navigator.language, so pin it.
    // tests/e2e/i18n.spec.ts switches to English explicitly.
    locale: 'pt-BR',
    // The production build registers a service worker (docs/specs/pwa.md). Specs run without
    // it so cached shells never leak between them; tests/e2e/pwa.spec.ts opts back in.
    serviceWorkers: 'block',
    launchOptions: executablePath ? { executablePath } : {},
  },
  // Two isolated servers: one whose ai-memory is unreachable (error paths), one with a
  // simulated ai-memory (Memory library flows). Neither reaches the user's real service.
  webServer: [
    {
      command: 'npx tsx tests/e2e/server.ts',
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        E2E_PORT: String(port),
        E2E_FUNNEL_PORT: String(funnelPort),
        ADELIC_MEMORY_URL: 'http://127.0.0.1:9',
        ADELIC_MEMORY_TOKEN: '',
        ADELIC_RELEASES_URL: `http://127.0.0.1:${port}/e2e/releases/latest`,
      },
    },
    {
      command: 'npx tsx tests/e2e/server.ts',
      url: `http://127.0.0.1:${memoryAppPort}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        E2E_PORT: String(memoryAppPort),
        E2E_MEMORY_PORT: String(fakeMemoryPort),
        ADELIC_MEMORY_URL: `http://127.0.0.1:${fakeMemoryPort}`,
        ADELIC_MEMORY_TOKEN: '',
      },
    },
  ],
});
