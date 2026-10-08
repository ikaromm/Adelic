import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAppPort } from '../../playwright.config';

// Observability, Automations, Memory and the update toast in English (docs/i18n.md). The language is
// saved on the server (Settings.language) before each test and set back to `auto` after it, so the
// other specs keep their pt-BR text.
const memoryApp = `http://127.0.0.1:${memoryAppPort}`;
const PORTUGUESE = /Execuç|Automaç|Memória|Próxim|Nenhum|Configuraç|Atualizar|Buscar|Salvar|Horário|às /;

async function setLanguage(request: APIRequestContext, language: 'en' | 'auto', baseURL?: string) {
  const response = await request.patch(`${baseURL ?? ''}/api/settings`, { data: { language } });
  expect(response.ok()).toBe(true);
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
async function noPortuguese(page: Page) {
  expect(await page.locator('.page-content').innerText()).not.toMatch(PORTUGUESE);
}

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => {
  await setLanguage(request, 'en');
  await setLanguage(request, 'en', memoryApp);
});
test.afterEach(async ({ request }) => {
  await setLanguage(request, 'auto');
  await setLanguage(request, 'auto', memoryApp);
  expect((await request.patch('/api/settings', { data: { automations: false } })).ok()).toBe(true);
});

test('Observability page in English, with a finished run', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /^New conversation/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Message to the agent' });
  await input.fill(`[normal] activity ${Date.now()}`);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 15_000 });

  await nav(page).getByRole('button', { name: 'Observability' }).click();
  await expect(page.getByRole('heading', { name: 'Observability', level: 1 })).toBeVisible();
  const content = page.locator('.page-content');
  await expect(content).toContainText('SYSTEM HEALTH');
  await expect(page.locator('.observability-filters')).toHaveAttribute('aria-label', 'Observability filters');
  await expect(content).toContainText('Available providers');
  await expect(content).toContainText('Component health');
  await expect(page.getByRole('heading', { name: 'Recent runs' })).toBeVisible();
  const row = page.locator('.observability-run').first();
  await expect(row).toContainText('Completed');
  await row.locator('.observability-run-head').click();
  await expect(row.locator('.observability-trace')).toBeVisible();
  // Route reasons are persisted run data (pt-BR): only the page chrome is checked.
  for (const text of await page.locator('.page-heading, .metrics-grid, .observability-filters').allInnerTexts())
    expect(text).not.toMatch(PORTUGUESE);
});

test('Automations page, form, schedule preview and validation in English', async ({ page, request }) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-i18n-')));
  try {
    const project = `I18n ${Date.now()}`;
    expect(
      (
        await request.post('/api/projects', {
          data: { name: project, path: repo, memoryWorkspace: 'e2e', memoryProject: `i18n-${Date.now()}` },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    await nav(page).getByRole('button', { name: 'Automations' }).click();
    await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Automations are off' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();

    await page.getByRole('button', { name: 'New automation' }).click();
    const form = page.getByRole('form', { name: 'New automation' });
    await form.getByRole('button', { name: 'Create automation' }).click();
    await expect(form.getByRole('alert')).toHaveText('Name required (up to 80 characters)');
    const name = `Digest ${Date.now().toString(36)}`;
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Project').selectOption({ label: project });
    await form.getByLabel('Prompt').fill('[normal] summarize the day');
    await expect(form).toContainText('Accepts saved commands (/revisar) and /plano. 26/8000');
    await form.getByLabel('Repeat').selectOption('weekly');
    for (const day of ['Tue', 'Wed', 'Thu', 'Fri']) await form.getByLabel(day, { exact: true }).uncheck();
    await form.getByLabel('Time', { exact: true }).fill('19:30');
    await form.getByLabel('Time zone').fill('America/Sao_Paulo');
    const preview = form.getByRole('list', { name: 'Next runs' });
    await expect(preview.getByRole('listitem')).toHaveCount(3);
    await expect(preview.getByRole('listitem').first()).toContainText(/^Mon, [A-Z][a-z]{2} \d{2},? 07:30\sPM$/);
    await expect(form.getByLabel('Minutes until approvals are denied')).toHaveValue('30');
    await expect(form).toContainText('Automatically deny approvals after');
    await expect(form).toContainText('Created off: turn it on in the list when you want it to run.');
    await form.getByLabel('Repeat').selectOption('interval');
    await expect(form).toContainText('Counted from when the automation is turned on or saved.');
    await form.getByLabel('Repeat').selectOption('weekly');
    expect(await form.innerText()).not.toMatch(PORTUGUESE);
    await form.getByRole('button', { name: 'Create automation' }).click();
    await expect(form).toBeHidden();

    const item = page.getByRole('listitem', { name });
    await expect(item).toContainText('Mon at 7:30 PM');
    await expect(item).toContainText('Next run');
    await expect(item).toContainText('Off');
    await expect(item).toContainText('Never run');
    await expect(item.getByRole('switch', { name: `Enable ${name}` })).toHaveAttribute('aria-checked', 'false');
    await expect(item.getByRole('button', { name: 'Run now' })).toBeDisabled();
    await noPortuguese(page);

    // Turn everything on and run it: the result line is translated too.
    expect((await request.patch('/api/settings', { data: { automations: true } })).ok()).toBe(true);
    await page.reload();
    await nav(page).getByRole('button', { name: 'Automations' }).click();
    await item.getByRole('button', { name: 'Run now' }).click();
    await expect(item).toContainText('Completed', { timeout: 10_000 });
    await expect(item).toContainText('(manual)');
    await expect(item.getByRole('button', { name: 'Open conversation' })).toBeVisible();
    await item.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(item.getByRole('button', { name: 'Keep' })).toBeVisible();
    await item.getByRole('button', { name: 'Confirm deletion' }).click();
    await expect(item).toHaveCount(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test.describe('Memory page', () => {
  test.use({ baseURL: memoryApp });

  test('lists, opens and edits notes in English', async ({ page }) => {
    await page.goto('/');
    await nav(page)
      .getByRole('button', { name: /^Memory/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Memory', level: 1 })).toBeVisible();
    await expect(page.locator('.page-content')).toContainText('SHARED SOURCE');
    await expect(page.getByText(/^\d+ notes in the catalog$/)).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Workspace and project/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pick a note to read' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await noPortuguese(page);

    await page.getByRole('button', { name: /Rede local/ }).click();
    await expect(page.locator('.memory-article')).toContainText('MEMORY NOTE');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Content' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Note path' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save note' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'New note' }).click();
    await expect(page.getByRole('heading', { name: 'Add to memory' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Note path' })).toHaveAttribute('placeholder', 'notes/topic.md');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByPlaceholder('Search this scope…').fill('zzz-nothing-matches');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText('No results')).toBeVisible();
    await expect(page.getByText('Try another search.')).toBeVisible();
  });
});

test.describe('update toast', () => {
  test.use({ serviceWorkers: 'allow' });

  test('offers the new version in English', async ({ page, request }) => {
    await page.goto('/');
    await expect(nav(page)).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
      .toMatch(/\/sw\.js$/);
    expect((await request.post('/e2e/sw-bump', { data: {} })).ok()).toBe(true);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    const toast = page.getByRole('status').filter({ hasText: 'Update available' });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(toast).not.toContainText('Atualização');
  });

  test('the offline page follows the app language', async ({ page, context }) => {
    await page.goto('/');
    await expect(nav(page)).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
      .toMatch(/\/sw\.js$/);
    await context.setOffline(true);
    try {
      await page.goto('/conversa/qualquer');
      await expect(page.getByRole('heading', { name: 'Cannot reach Adelic' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Sem conexão com o Adelic' })).toBeHidden();
      await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page).toHaveTitle('Cannot reach Adelic');
    } finally {
      await context.setOffline(false);
    }
  });
});
