import { expect, test } from './fixtures';

test.beforeEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'pt-BR' } })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'auto' } })).ok()).toBe(true);
});

test('keeps the new project draft while opening SSH settings and returning', async ({ page }) => {
  await page.route('**/api/remote-hosts', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: [] });
    else await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Adicionar projeto' }).click();

  let projectForm = page.getByRole('dialog', { name: 'Novo projeto' });
  await expect(projectForm).toBeVisible();
  await projectForm.getByLabel('Nome do projeto').fill('Rascunho para SSH');
  await projectForm.getByLabel('Localização do código').selectOption('remote');
  await projectForm.getByRole('button', { name: 'Cadastrar ou gerenciar servidor SSH' }).click();

  const search = page.getByRole('searchbox', { name: 'Buscar configurações' });
  await expect(search).toHaveValue('SSH');
  await expect(page.getByRole('region', { name: 'Servidores SSH' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar cadastro do projeto' }).click();

  projectForm = page.getByRole('dialog', { name: 'Novo projeto' });
  await expect(projectForm).toBeVisible();
  const name = projectForm.getByLabel('Nome do projeto');
  await expect(name).toHaveValue('Rascunho para SSH');
  await expect(name).toBeFocused();
  await expect(projectForm.getByLabel('Localização do código')).toHaveValue('remote');
});

test('clears a host removed while SSH project setup is paused', async ({ page }) => {
  let hostListRequests = 0;
  const host = {
    id: 'temporary-ssh-host',
    name: 'Temporary SSH host',
    target: 'example.invalid',
    port: 22,
    fingerprint: 'SHA256:synthetic-test-fingerprint',
    hostKey: 'ssh-ed25519 synthetic-test-public-key',
    runnerPath: '/tmp/adelic-test-runner.py',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  await page.route('**/api/remote-hosts', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    hostListRequests += 1;
    await route.fulfill({ json: hostListRequests === 1 ? [host] : [] });
  });
  await page.route('**/api/remote-hosts/temporary-ssh-host/directories**', async (route) => {
    await route.fulfill({ json: { entries: [], truncated: false } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Adicionar projeto' }).click();
  let projectForm = page.getByRole('dialog', { name: 'Novo projeto' });
  await expect(projectForm).toBeVisible();
  await projectForm.getByLabel('Nome do projeto').fill('Host removido durante cadastro');
  await projectForm.getByLabel('Localização do código').selectOption('remote');
  await expect(projectForm.getByRole('combobox', { name: /^Servidor SSH/ })).toHaveValue('temporary-ssh-host');
  await expect(projectForm.getByLabel('Caminho remoto')).toHaveValue('/');
  await projectForm.getByLabel('Caminho remoto').fill('/workspace');
  await projectForm.getByRole('button', { name: 'Cadastrar ou gerenciar servidor SSH' }).click();

  const search = page.getByRole('searchbox', { name: 'Buscar configurações' });
  await expect(search).toHaveValue('SSH');
  const remoteHosts = page.getByRole('region', { name: 'Servidores SSH' });
  await expect(remoteHosts).toBeVisible();
  await expect(remoteHosts).toContainText('Nenhum servidor SSH cadastrado.');
  expect(hostListRequests).toBeGreaterThanOrEqual(2);

  await page.getByRole('button', { name: 'Continuar cadastro do projeto' }).click();
  projectForm = page.getByRole('dialog', { name: 'Novo projeto' });
  const hostSelect = projectForm.getByRole('combobox', { name: /^Servidor SSH/ });
  await expect(projectForm.getByLabel('Nome do projeto')).toHaveValue('Host removido durante cadastro');
  await expect(hostSelect).toHaveValue('');
  await expect(projectForm.getByLabel('Caminho remoto')).toHaveValue('/workspace');
  await expect(projectForm.getByRole('button', { name: 'Criar projeto' })).toBeDisabled();
});

test('ignores a late directory listing after switching from SSH to a local project', async ({ page }) => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const startedListing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/remote-hosts', (route) =>
    route.fulfill({
      json: [
        {
          id: 'slow-host',
          name: 'Slow SSH',
          target: 'slow.invalid',
          port: 22,
          runnerPath: '/runner.py',
          fingerprint: 'test',
          hostKey: 'test',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    }),
  );
  await page.route('**/api/remote-hosts/slow-host/directories**', async (route) => {
    started?.();
    await held;
    await route.fulfill({
      json: {
        entries: [{ name: 'wrong-server-directory', path: 'wrong-server-directory', directory: true }],
        truncated: false,
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Adicionar projeto' }).click();
  const form = page.getByRole('dialog', { name: 'Novo projeto' });
  await form.getByLabel('Localização do código').selectOption('remote');
  await startedListing;
  await form.getByLabel('Localização do código').selectOption('local');
  await form.getByLabel('Caminho da pasta', { exact: true }).fill('/home/manual-project');
  const finished = page.waitForEvent('requestfinished', {
    predicate: (request) => request.url().includes('/slow-host/directories'),
  });
  release?.();
  await finished;
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await expect(form.getByLabel('Caminho da pasta', { exact: true })).toHaveValue('/home/manual-project');
  await expect(form.getByLabel('Localização do código')).toHaveValue('local');
  await expect(form.getByText('wrong-server-directory')).toBeHidden();
});
