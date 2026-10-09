import { expect, test } from './fixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('creates a local folder from the picker and preserves the standard profile defaults', async ({ page }) => {
  const parent = mkdtempSync(join(tmpdir(), 'adelic-onboarding-e2e-'));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const openForm = async () => {
      const sidebar = page.locator('.sidebar');
      if (!(await sidebar.evaluate((node) => node.classList.contains('sidebar-mobile-open')))) {
        await page.getByRole('button', { name: 'Abrir navegação' }).click();
      }
      await page
        .getByRole('button', { name: /Adicionar projeto|Novo projeto/ })
        .first()
        .click();
      return page.getByRole('dialog', { name: 'Novo projeto' });
    };
    const standardForm = await openForm();
    await standardForm.getByRole('textbox', { name: 'Nome do projeto' }).fill(`Padrão ${Date.now()}`);
    await standardForm.getByRole('textbox', { name: 'Caminho da pasta' }).fill(parent);
    await standardForm.getByRole('button', { name: 'Selecionar ou criar pasta' }).click();
    await standardForm.getByRole('button', { name: 'Usar esta pasta' }).click();
    await expect(standardForm.getByRole('radio', { name: /Padrão/ })).toBeChecked();
    const standardResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/projects') && response.request().method() === 'POST',
    );
    await standardForm.getByRole('button', { name: 'Criar projeto' }).click();
    const standardProject = await (await standardResponse).json();
    expect(standardProject.orchestration).toMatchObject({ enabled: true, maxWorkers: 2, review: true });
    expect(standardProject.graphify).toEqual({ enabled: true });

    const lightForm = await openForm();
    const lightName = `Leve ${Date.now()}`;
    await lightForm.getByRole('textbox', { name: 'Nome do projeto' }).fill(lightName);
    await lightForm.getByRole('textbox', { name: 'Caminho da pasta' }).fill(parent);
    await lightForm.getByRole('button', { name: 'Selecionar ou criar pasta' }).click();
    await lightForm.getByRole('textbox', { name: 'Nome da nova pasta' }).fill('projeto-criado-pelo-picker');
    await lightForm.getByRole('button', { name: 'Criar pasta aqui' }).click();
    await expect(lightForm.getByText('Pasta criada.')).toBeVisible();
    await lightForm.getByRole('button', { name: 'Usar esta pasta' }).click();
    await lightForm.getByRole('radio', { name: /Leve/ }).check();
    const lightResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/projects') && response.request().method() === 'POST',
    );
    await lightForm.getByRole('button', { name: 'Criar projeto' }).click();
    const lightProject = await (await lightResponse).json();
    expect(lightProject.path).toBe(join(parent, 'projeto-criado-pelo-picker'));
    expect(lightProject.orchestration).toMatchObject({ enabled: false, maxWorkers: 1, review: false });
    expect(lightProject.graphify).toEqual({ enabled: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
