import { expect, test, type Page } from './fixtures';

// Installable app (docs/specs/pwa.md) on the production build. 127.0.0.1 is a secure
// context, so the service worker registers like it would over HTTPS. Every other spec
// blocks service workers (playwright.config.ts); this one opts in.
test.use({ serviceWorkers: 'allow' });

async function controlled(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .toMatch(/\/sw\.js$/);
}

const cachedUrls = (page: Page) =>
  page.evaluate(async () => {
    const all: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        all.push(`${name} ${new URL(request.url).pathname}`);
    return all;
  });

test('links the manifest and serves it with the right type', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  expect((await manifest.json()).display).toBe('standalone');
  const sw = await request.get('/sw.js');
  expect(sw.headers()['cache-control']).toBe('no-cache');
});

test('registers, controls the page after reload and caches only the shell', async ({ page }) => {
  await controlled(page);
  // The app talks to the API while loading; none of it may end up in Cache Storage.
  await expect(page.getByRole('button', { name: /Nova conversa/ }).first()).toBeVisible();
  const urls = await cachedUrls(page);
  expect(urls.some((entry) => entry.endsWith(' /index.html'))).toBe(true);
  expect(urls.some((entry) => entry.endsWith(' /offline.html'))).toBe(true);
  expect(urls.some((entry) => / \/assets\/main-.*\.js$/.test(entry))).toBe(true);
  expect(urls.filter((entry) => / \/(api|events)(\/|$)/.test(entry))).toEqual([]);
  expect(new Set(urls.map((entry) => entry.split(' ')[0])).size).toBe(1);
  expect(urls[0]).toMatch(/^adelic-shell-/);
});

test('shows the offline page when the computer cannot be reached', async ({ page, context }) => {
  await controlled(page);
  await context.setOffline(true);
  await page.goto('/conversa/qualquer');
  await expect(page.getByRole('heading', { name: 'Sem conexão com o Adelic' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tentar de novo' })).toHaveAttribute('href', '/');
  // Styled from the precached stylesheet, with the dark theme background.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 16, 21)');
  await page.setViewportSize({ width: 360, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.setViewportSize({ width: 1280, height: 800 });
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Tentar de novo' }).click();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
});

test('waits for the user before switching to a new version', async ({ page, request }) => {
  await controlled(page);
  const before = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
  expect((await request.post('/e2e/sw-bump', { data: {} })).ok()).toBe(true);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  const toast = page.getByRole('status').filter({ hasText: 'Atualização disponível' });
  await expect(toast).toBeVisible();
  // Not taken over yet: the new worker is waiting.
  expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())!.waiting))).toBe(
    true,
  );
  await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Recarregar' }).click()]);
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await expect(toast).toHaveCount(0);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting)).toBeNull();
  expect(await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL)).toBe(before);
});

test('explains the HTTPS requirement in Settings', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  await expect(page.getByText(/a instalação exige HTTPS/)).toBeVisible();
});
