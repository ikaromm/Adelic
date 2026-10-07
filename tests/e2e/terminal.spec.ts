import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Terminal and local preview (docs/specs/terminal-preview.md) against the real backend. The
// E2E server runs commands in the real bubblewrap sandbox when this machine allows it, and
// directly in the project folder otherwise (see tests/e2e/server.ts).

let folder: string;
test.beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-terminal-')));
});
test.afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

async function openTerminal(page: Page, request: APIRequestContext, narrow = false) {
  const name = `Terminal ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: folder, memoryWorkspace: 'e2e', memoryProject: `terminal-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  // On small screens the sidebar opens from the menu button.
  if (narrow) await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  await expect(page.getByRole('textbox', { name: 'Mensagem para o agente' })).toBeVisible();
  await page.getByRole('button', { name: 'Terminal e preview do projeto' }).click();
  const panel = page.getByRole('complementary', { name: `Ferramentas de ${name}` });
  await expect(panel).toBeVisible();
  return panel;
}

test('runs a command in the project sandbox, shows its output and exit code, and stops a long one', async ({
  page,
  request,
}) => {
  const panel = await openTerminal(page, request);
  await expect(panel.getByText('Executa no sandbox do Adelic com as mesmas permissões dos agentes')).toBeVisible();
  await expect(panel.getByText('não são enviados a nenhum modelo')).toBeVisible();
  const input = panel.getByRole('textbox', { name: 'Comando' });
  await input.fill('echo olá && pwd');
  await input.press('Enter');
  const entry = panel.getByRole('region', { name: 'Comando echo olá && pwd' });
  await expect(entry.locator('.terminal-text')).toHaveText(`olá\n${folder}\n`);
  await expect(entry.getByText('Código de saída 0')).toBeVisible();
  await expect(input).toHaveValue('');

  // History: ↑ brings the previous command back.
  await input.press('ArrowUp');
  await expect(input).toHaveValue('echo olá && pwd');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('');

  await input.fill('sleep 30');
  await input.press('Enter');
  const sleeping = panel.getByRole('region', { name: 'Comando sleep 30' });
  await expect(sleeping.getByText('Em execução')).toBeVisible();
  await sleeping.getByRole('button', { name: 'Parar' }).click();
  await expect(sleeping.getByText('Parado')).toBeVisible();
  await expect(sleeping.getByRole('button', { name: 'Parar' })).toHaveCount(0);

  // A failing command shows its exit code.
  await input.fill('exit 3');
  await input.press('Enter');
  await expect(panel.getByRole('region', { name: 'Comando exit 3' }).getByText('Código de saída 3')).toBeVisible();
});

test('offers the preview for a dev-server URL and validates preview addresses', async ({ page, request }) => {
  const panel = await openTerminal(page, request);
  const input = panel.getByRole('textbox', { name: 'Comando' });
  await input.fill("printf '  Local:   http://localhost:5199/\\n'");
  await input.press('Enter');
  await panel.getByRole('button', { name: /Abrir preview/ }).click();
  await expect(panel.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  const address = panel.getByRole('textbox', { name: 'Endereço do preview' });
  await expect(address).toHaveValue('http://localhost:5199/');
  const frame = panel.locator('iframe[title="Preview"]');
  await expect(frame).toHaveAttribute('src', 'http://localhost:5199/');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
  await expect(panel.getByRole('link', { name: 'Abrir no navegador' })).toHaveAttribute(
    'href',
    'http://localhost:5199/',
  );

  const open = panel.getByRole('button', { name: 'Abrir', exact: true });
  for (const [value, message] of [
    ['http://127.0.0.1.evil.com/', 'Só endereços locais são aceitos'],
    ['http://evil.com@localhost:5173/', 'usuário ou senha'],
    ['file:///etc/passwd', 'Só endereços http:// ou https://'],
    [new URL(page.url()).origin, 'O preview não abre o próprio Adelic'],
  ]) {
    await address.fill(value);
    await open.click();
    await expect(panel.getByRole('alert')).toContainText(message);
  }
  // The frame keeps the last valid address.
  await expect(frame).toHaveAttribute('src', 'http://localhost:5199/');
  await address.fill('127.0.0.1:5198');
  await open.click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(frame).toHaveAttribute('src', 'http://127.0.0.1:5198/');

  const csp = (await request.get('/api/health')).headers()['content-security-policy'];
  // frame-src for the preview; frame-ancestors keeps the app itself out of any frame.
  expect(csp).toBe(
    "frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; frame-ancestors 'none'",
  );
});

test('the terminal and preview fit a 360px screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const panel = await openTerminal(page, request, true);
  const input = panel.getByRole('textbox', { name: 'Comando' });
  await input.fill('echo uma-linha-bem-comprida-sem-espacos-para-quebrar-em-telas-pequenas-0123456789');
  await input.press('Enter');
  await expect(panel.getByText('Código de saída 0')).toBeVisible();
  const fits = async (control: string) => {
    for (const box of [await panel.boundingBox(), await panel.getByRole('button', { name: control }).boundingBox()])
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  };
  await fits('Executar');
  await panel.getByRole('tab', { name: 'Preview' }).click();
  await panel.getByRole('textbox', { name: 'Endereço do preview' }).fill('http://localhost:5199');
  await panel.getByRole('button', { name: 'Abrir', exact: true }).click();
  await expect(panel.locator('iframe[title="Preview"]')).toBeVisible();
  await fits('Abrir');
  await panel.getByRole('button', { name: 'Fechar ferramentas' }).click();
  await expect(panel).toBeHidden();
});
