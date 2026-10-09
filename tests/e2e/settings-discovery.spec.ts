import { expect, test, type Page } from './fixtures';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: string | undefined;

test.beforeEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'pt-BR' } })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'auto' } })).ok()).toBe(true);
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

async function openSettings(page: Page, projectName?: string) {
  await page.goto('/');
  if (projectName) await page.getByRole('button', { name: `Nova conversa em ${projectName}` }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();
}

test('switches Basic/Advanced, searches hidden diagnostics, and preserves a project draft', async ({
  page,
  request,
}) => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-settings-discovery-')));
  const name = `Discovery ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `discovery-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);

  await openSettings(page, name);
  const search = page.getByRole('searchbox', { name: 'Buscar configurações' });
  await expect(page.getByRole('button', { name: 'Básico' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Diagnóstico', exact: true })).toBeHidden();
  await expect(page.getByText(/configurações avançadas ocultas/)).toBeVisible();

  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Diagnóstico', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Básico' }).click();
  await expect(page.getByRole('heading', { name: 'Diagnóstico', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();

  const hooks = page.getByRole('region', { name: 'Verificações e bloqueios' });
  await hooks.getByRole('button', { name: 'Adicionar verificação' }).click();
  const draft = hooks.getByRole('listitem', { name: 'Verificação 1' });
  await draft.getByLabel('Nome').fill('rascunho avançado');
  await draft.getByLabel('Comando').fill('npm test');

  await search.fill('diagnostico');
  await expect(page.getByRole('heading', { name: 'Diagnóstico', exact: true })).toBeVisible();
  await expect(hooks).toBeHidden();
  await search.fill('verificacoes');
  await expect(hooks).toBeVisible();
  await expect(draft.getByLabel('Nome')).toHaveValue('rascunho avançado');
  await expect(draft.getByLabel('Comando')).toHaveValue('npm test');
});

test('Settings discovery controls fit a 360px mobile viewport', async ({ page }) => {
  await openSettings(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const discovery = page.locator('.settings-discovery');
  await expect(discovery).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Buscar configurações' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Básico' })).toBeVisible();
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});
