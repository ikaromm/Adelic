import { test as base, expect } from '@playwright/test';

// Shared E2E fixture: every spec imports `test` from here. Before each test it asks both E2E
// servers to settle (cancel runs an earlier test left going, release held plan tasks and the
// update lock), so a slow or failed test cannot leave state that breaks the next ones. Absolute
// URLs, because some specs point `baseURL` at the memory server or the Funnel listener.
const port = Number(process.env.E2E_PORT || 4399);
const servers = [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`];

export const test = base.extend<{ settled: void }>({
  settled: [
    async ({ playwright }, use) => {
      const request = await playwright.request.newContext();
      try {
        for (const server of servers) {
          const response = await request.post(`${server}/e2e/settle`, { data: {} });
          expect(response.ok(), `POST ${server}/e2e/settle`).toBe(true);
        }
      } finally {
        await request.dispose();
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect };
export type { APIRequestContext, Locator, Page } from '@playwright/test';
