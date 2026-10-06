import { expect, test } from '@playwright/test';
import { fakeMemoryPort, memoryAppPort } from '../../playwright.config';

// Memory library against the simulated ai-memory (tests/e2e/fake-memory.ts).
test.use({ baseURL: `http://127.0.0.1:${memoryAppPort}` });
const external = (path: string, body: string, workspace = 'pessoal', project = 'ambiente-ikaromm') =>
  fetch(`http://127.0.0.1:${fakeMemoryPort}/e2e/external-edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, project, path, body }),
  });

async function openMemory(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: /Memória/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Memória', level: 1 })).toBeVisible();
}

test('lists notes of the preferred scope and opens one', async ({ page }) => {
  await openMemory(page);
  await expect(page.getByText('2 notas no catálogo')).toBeVisible();
  await page.getByRole('button', { name: /Rede local/ }).click();
  await expect(page.getByText('Roteador em 192.168.0.1.')).toBeVisible();
});

test('switching scope shows only that scope, and searches stay in it', async ({ page }) => {
  await openMemory(page);
  await page.getByRole('combobox', { name: /Workspace e projeto/ }).selectOption({ label: 'projetos / adelic (1)' });
  await expect(page.getByRole('button', { name: /Tema escuro/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Rede local/ })).toHaveCount(0);
  await page.getByPlaceholder(/Buscar neste escopo/).fill('Roteador');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.getByRole('button', { name: /Rede local/ })).toHaveCount(0);
  // The 5 s poll must keep using the newly selected scope.
  await page.waitForTimeout(6000);
  await expect(page.getByRole('button', { name: /Rede local/ })).toHaveCount(0);
});

test('edits a note, and an external change while editing keeps the draft and blocks saving', async ({ page }) => {
  await openMemory(page);
  await page.getByRole('button', { name: /Backup/ }).click();
  await page.getByRole('button', { name: 'Editar' }).click();
  const content = page.getByRole('textbox', { name: 'Conteúdo' });
  await content.fill('# Backup\n\nDiário às 4h.\n');
  await page.getByRole('button', { name: 'Salvar nota' }).click();
  await expect(page.getByText('Diário às 4h.')).toBeVisible();

  await page.getByRole('button', { name: 'Editar' }).click();
  await content.fill('# Backup\n\nmeu rascunho\n');
  await external('configuracoes/backup.md', '# Backup\n\nalterado por outro cliente\n');
  await expect(page.getByText('Esta nota mudou externamente.')).toBeVisible({ timeout: 12_000 });
  await expect(content).toHaveValue('# Backup\n\nmeu rascunho\n');
  await expect(page.getByRole('button', { name: 'Salvar nota' })).toBeDisabled();
});
