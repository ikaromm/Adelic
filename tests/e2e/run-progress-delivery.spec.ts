import { expect, test } from './fixtures';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let projectPath: string;
test.beforeEach(async ({ request }) => {
  projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-delivery-')));
  expect((await request.patch('/api/settings', { data: { sandbox: 'workspace-write' } })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { sandbox: 'read-only' } });
  rmSync(projectPath, { recursive: true, force: true });
});

test('delivery summarizes observed evidence and keeps check output collapsed until requested', async ({
  page,
  request,
}) => {
  const name = `Delivery summary ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: projectPath, memoryWorkspace: 'e2e', memoryProject: `delivery-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string };
  expect(
    (
      await request.put(`/api/projects/${project.id}/hooks`, {
        data: { afterEdit: [{ name: 'check output', command: 'echo output-observavel' }] },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('[escrever] 4');
  await input.press('Enter');

  const delivery = page.getByRole('region', { name: 'Entrega da execução' });
  await expect(delivery).toBeVisible();
  await expect(delivery).toContainText('arquivos observados');
  await expect(delivery).toContainText('check output');
  await expect(delivery).toContainText('echo output-observavel');
  const output = delivery.locator('.run-delivery-check details').first();
  await expect(output).toBeVisible();
  await expect(output).not.toHaveAttribute('open', '');
  await output.locator('summary').click();
  await expect(output).toHaveAttribute('open', '');
  await expect(output.locator('pre')).toContainText('output-observavel');
  await expect(delivery.getByRole('heading', { name: 'Próximos passos' })).toBeVisible();
});

test('failed artifact loading can be retried', async ({ page, request }) => {
  const name = `Delivery retry ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: projectPath, memoryWorkspace: 'e2e', memoryProject: `delivery-retry-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  let attempts = 0;
  await page.route(/\/api\/runs\/[^/]+\/artifacts\/file\?/, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporary load failure' }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: 'README.md', content: 'retry succeeded', truncated: false }),
      });
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('[escrever] 4');
  await input.press('Enter');

  const delivery = page.getByRole('region', { name: 'Entrega da execução' });
  await expect(delivery).toBeVisible();
  await delivery.getByRole('button', { name: 'Ver conteúdo: README.md' }).click();
  await expect(delivery.getByRole('alert')).toBeVisible();
  await delivery.getByRole('button', { name: 'Tentar carregar novamente' }).click();
  await expect(delivery.locator('pre[aria-label="README.md"]')).toContainText('retry succeeded');
  expect(attempts).toBe(2);
});

test('progress remains visible while reading earlier messages and disappears on cancellation', async ({ page }) => {
  await page.goto('/');
  await page.locator('.new-chat-button').click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('[eco] ' + 'Parágrafo anterior para leitura. '.repeat(180));
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancelar execução', exact: true })).toBeHidden();
  await input.fill('[lento]');
  await input.press('Enter');
  const banner = page.locator('.run-progress-banner');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Ver atividade' })).toBeVisible();
  expect(await page.locator('.conversation').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  await page.locator('.conversation').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(banner).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(banner).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Cancelar execução', exact: true }).click();
  await expect(banner).toBeHidden();
});

test('a download reads the current file again after the delivery content was opened', async ({ page, request }) => {
  const name = `Current artifact ${Date.now()}`;
  await request.post('/api/projects', {
    data: { name, path: projectPath, memoryWorkspace: 'e2e', memoryProject: 'download-current' },
  });
  let reads = 0;
  await page.route(/\/api\/runs\/[^/]+\/artifacts\/file\?/, (route) => {
    reads += 1;
    return route.fulfill({
      json: { path: 'README.md', content: reads === 1 ? 'earlier contents' : 'current contents', truncated: false },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('[escrever] 4');
  await input.press('Enter');
  const delivery = page.getByRole('region', { name: 'Entrega da execução' });
  await expect(delivery).toBeVisible();
  await delivery.getByRole('button', { name: 'Ver conteúdo: README.md' }).click();
  await expect(delivery.locator('pre[aria-label="README.md"]')).toContainText('earlier contents');
  const downloaded = page.waitForEvent('download');
  await delivery.getByRole('button', { name: 'Baixar texto: README.md' }).click();
  const download = await downloaded;
  expect(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8')).toBe('current contents');
  expect(reads).toBe(2);
});
