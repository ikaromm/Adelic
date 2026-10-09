import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders: string[] = [];
test.afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function createProject(request: APIRequestContext, name: string) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-tool-context-')));
  folders.push(path);
  const response = await request.post('/api/projects', {
    data: { name, path, memoryWorkspace: 'e2e', memoryProject: `tool-context-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  return { id: (await response.json()).id as string, path };
}

async function openConversation(page: Page, name: string) {
  const sidebar = page.locator('.sidebar');
  if (!(await sidebar.evaluate((node) => node.classList.contains('sidebar-mobile-open')))) {
    const openNavigation = page.getByRole('button', { name: 'Abrir navegação' });
    if (await openNavigation.isVisible()) await openNavigation.click();
  }
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  await expect(page.getByRole('textbox', { name: 'Mensagem para o agente' })).toBeVisible();
}

test('terminal scope is visible and its draft clears when changing projects', async ({ page, request }) => {
  const firstName = `Tools first ${'very-long-project-name-'.repeat(4)} ${Date.now()}`;
  const secondName = `Tools second ${Date.now()}`;
  const first = await createProject(request, firstName);
  const second = await createProject(request, secondName);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openConversation(page, firstName);
  await page.getByRole('button', { name: 'Terminal e preview do projeto' }).click();
  const firstPanel = page.getByRole('complementary', { name: `Ferramentas de ${firstName}` });
  await expect(firstPanel.locator('.tools-panel-scope')).toContainText(firstName);
  await expect(firstPanel.locator('.tools-panel-scope')).toContainText('Local');
  await expect(firstPanel.locator('.tools-panel-scope code')).toHaveText(first.path);
  const scope = firstPanel.locator('.tools-panel-scope');
  await expect.poll(() => scope.locator('strong').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await firstPanel.getByRole('textbox', { name: 'Comando' }).fill('echo command from the first project');

  await openConversation(page, secondName);
  await expect(firstPanel).toHaveCount(0);
  await page.getByRole('button', { name: 'Terminal e preview do projeto' }).click();
  const secondPanel = page.getByRole('complementary', { name: `Ferramentas de ${secondName}` });
  await expect(secondPanel.locator('.tools-panel-scope')).toContainText(secondName);
  await expect(secondPanel.locator('.tools-panel-scope code')).toHaveText(second.path);
  await expect(secondPanel.getByRole('textbox', { name: 'Comando' })).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('SSH terminal permission text and disabled state follow current sandbox settings', async ({ page, request }) => {
  const initial = await (await request.get('/api/bootstrap')).json();
  try {
    await request.patch('/api/settings', { data: { sandbox: 'read-only' } });
    const name = `SSH tools ${Date.now()}`;
    const project = await createProject(request, name);
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const bootstrap = await response.json();
      const item = bootstrap.projects.find((candidate: { id: string }) => candidate.id === project.id);
      item.remote = { hostId: 'mock-ssh-host', path: '/srv/example' };
      await route.fulfill({ response, json: bootstrap });
    });
    await page.route(`**/api/projects/${project.id}/terminal`, (route) =>
      route.fulfill({
        json: {
          enabled: true,
          remote: false,
          sandbox: 'read-only',
          maxRunning: 3,
          commands: [],
        },
      }),
    );
    await page.route(`**/api/projects/${project.id}/terminal/events`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: 'data: {"type":"snapshot","commands":[]}\n\n',
      }),
    );

    await page.goto('/');
    await openConversation(page, name);
    await page.getByRole('button', { name: 'Terminal e preview do projeto' }).click();
    const panel = page.getByRole('complementary', { name: `Ferramentas de ${name}` });
    await expect(panel.locator('.tools-panel-scope')).toContainText('SSH');
    await expect(panel.locator('.tools-panel-scope code')).toHaveText('/srv/example');
    const command = panel.getByRole('textbox', { name: 'Comando' });
    await expect(panel.getByText(/Terminal indisponível para projetos SSH/)).toBeVisible();
    await expect(command).toBeDisabled();

    await page.getByRole('button', { name: /^Acesso: / }).click();
    await page
      .getByRole('dialog', { name: 'Acesso' })
      .getByRole('button', { name: /Escrita no projeto/ })
      .click();
    await expect(panel.getByText(/Executa por SSH como o usuário configurado/)).toBeVisible();
    await expect(command).toBeEnabled();

    await page.getByRole('button', { name: /^Acesso: / }).click();
    await page
      .getByRole('dialog', { name: 'Acesso' })
      .getByRole('button', { name: /Somente leitura/ })
      .click();
    await expect(panel.getByText(/Terminal indisponível para projetos SSH/)).toBeVisible();
    await expect(command).toBeDisabled();
  } finally {
    await request.patch('/api/settings', { data: { sandbox: initial.settings.sandbox } });
  }
});

test('Preview warns when the browser is remote from a local project', async ({ page, request }) => {
  const name = `Remote browser ${Date.now()}`;
  const project = await createProject(request, name);
  await page.route(`**/api/projects/${project.id}/terminal`, (route) =>
    route.fulfill({
      json: {
        enabled: false,
        remote: true,
        reason: 'Terminal is disabled remotely.',
        sandbox: 'read-only',
        maxRunning: 3,
        commands: [],
      },
    }),
  );

  await page.goto('/');
  await openConversation(page, name);
  await page.getByRole('button', { name: 'Terminal e preview do projeto' }).click();
  const panel = page.getByRole('complementary', { name: `Ferramentas de ${name}` });
  await expect(panel.locator('.tools-panel-scope')).toContainText('Local');
  await panel.getByRole('tab', { name: 'Preview' }).click();
  await expect(panel.getByText(/localhost e 127\.0\.0\.1 apontam para este dispositivo/)).toBeVisible();
});
