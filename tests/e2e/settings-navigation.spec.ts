import { expect, test } from './fixtures';
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

test('Settings can be searched and filtered by category at narrow widths', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Configurações', exact: true })).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'Buscar configurações' });
  const categories = page.getByRole('navigation', { name: 'Categorias das configurações' });
  await expect(categories.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Escopo: configurações locais')).toBeVisible();

  await search.fill('memoria');
  await expect(categories.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Memória compartilhada' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Geral' })).toBeHidden();
  await expect(page.getByText('1 resultado')).toBeVisible();

  await categories.getByRole('button', { name: 'Ferramentas' }).click();
  await expect(search).toHaveValue('');
  await expect(categories.getByRole('button', { name: 'Ferramentas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agentes e respostas' })).toBeHidden();

  await search.fill('termo sem correspondencia');
  await expect(page.getByText('Nenhuma configuração encontrada.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Limpar busca e mostrar todas' })).toBeVisible();
  await page.getByRole('button', { name: 'Limpar busca e mostrar todas' }).click();
  await expect(categories.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Agentes e respostas' })).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  await expect(search).toBeVisible();
  await expect(categories.getByRole('button', { name: 'Todas' })).toBeVisible();
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});

test('keeps an unsaved project check draft while searching other Settings cards', async ({ page, request }) => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-settings-search-')));
  const name = `Settings search ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `settings-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();

  const hooks = page.getByRole('region', { name: 'Verificações e bloqueios' });
  await expect(hooks.getByRole('form', { name: /Verificações e bloqueios do projeto/ })).toBeVisible();
  await hooks.getByRole('button', { name: 'Adicionar verificação' }).click();
  const check = hooks.getByRole('listitem', { name: 'Verificação 1' });
  await check.getByLabel('Nome').fill('rascunho sem salvar');
  await check.getByLabel('Comando').fill('npm test');

  const search = page.getByRole('searchbox', { name: 'Buscar configurações' });
  await search.fill('memoria');
  await expect(hooks).toBeHidden();
  await search.fill('verificacoes');
  await expect(hooks).toBeVisible();
  await expect(check.getByLabel('Nome')).toHaveValue('rascunho sem salvar');
  await expect(check.getByLabel('Comando')).toHaveValue('npm test');
});
