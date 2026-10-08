import { createHash } from 'node:crypto';
import type { Bootstrap, Project, Session, SessionDetail } from '../../shared/contracts';
import { expect, test } from './fixtures';

const hostPublicKey = () => {
  const type = Buffer.from('ssh-ed25519');
  const raw = Buffer.alloc(32, 23);
  const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), type, Buffer.from([0, 0, 0, raw.length]), raw]);
  const key = blob.toString('base64');
  const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { hostKey: `ssh-ed25519 ${key}`, fingerprint };
};

test('pins a probed SSH key before creating a remote project and shows its working directory', async ({ page }) => {
  const { hostKey, fingerprint } = hostPublicKey();
  const hostName = `SSH E2E ${Date.now()}`;
  const projectName = `Remote ${Date.now()}`;
  const directoryQueries: string[] = [];
  const savedHost = { id: '' };
  let remoteProject: Project | undefined;
  let remoteSession: Session | undefined;
  let submittedProject: Record<string, unknown> | undefined;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const bootstrap = (await response.json()) as Bootstrap;
    if (!bootstrap.providers.some((provider) => provider.id === 'claude')) {
      bootstrap.providers.push({
        id: 'claude',
        name: 'Claude (E2E)',
        installed: true,
        available: true,
        status: 'ready',
        detail: 'Provider only present to verify the remote provider picker filter.',
        models: [{ id: 'claude-e2e', name: 'Claude E2E', isDefault: true }],
        defaultModel: 'claude-e2e',
        capabilities: { fast: true, tools: true, approvals: true, cancel: true },
      });
      bootstrap.settings.defaultProviderId = 'claude';
    }
    if (remoteProject) {
      bootstrap.projects = bootstrap.projects.filter((project) => project.id !== remoteProject?.id);
      bootstrap.projects.push(remoteProject);
    }
    if (remoteSession) bootstrap.sessions.push(remoteSession);
    await route.fulfill({ response, body: JSON.stringify(bootstrap) });
  });
  await page.route('**/api/remote-hosts/probe', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        target: 'e2e@remote.invalid',
        port: 2222,
        hostname: 'remote.invalid',
        fingerprint,
        hostKey,
      }),
    }),
  );
  await page.route(
    (url) => url.pathname.endsWith('/directories'),
    (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') || '';
      directoryQueries.push(path);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: path === '/home/e2e/work' ? [{ name: 'src', path: 'src', directory: true }] : [],
          truncated: false,
        }),
      });
    },
  );
  await page.route('**/remote-git?operation=*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ output: 'On branch main' }),
    }),
  );
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submittedProject = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
    const remote = submittedProject.remote as { hostId: string; path: string };
    remoteProject = {
      id: `e2e-${Date.now()}`,
      name: submittedProject.name as string,
      path: '/tmp/adelic-e2e-remote-project',
      remote,
      createdAt: new Date().toISOString(),
      memoryWorkspace: submittedProject.memoryWorkspace as string,
      memoryProject: submittedProject.memoryProject as string,
      orchestration: { enabled: false, maxWorkers: 1, review: false },
      graphify: { enabled: false },
    };
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(remoteProject) });
  });
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const request = JSON.parse(route.request().postData() || '{}') as { projectId: string; providerId: string };
    remoteSession = {
      id: 'e2e-remote-session',
      projectId: request.projectId,
      title: 'Remote E2E',
      providerId: request.providerId as Session['providerId'],
      mode: 'auto',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(remoteSession) });
  });
  await page.route(
    (url) => url.pathname === '/api/sessions/e2e-remote-session',
    (route) => {
      const detail: SessionDetail = {
        session: remoteSession!,
        messages: [],
        events: [],
        approvals: [],
        runs: [],
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
    },
  );

  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const hosts = page.getByRole('region', { name: 'Servidores SSH' });
  await hosts.getByLabel('Destino SSH').fill('e2e@remote.invalid');
  await hosts.getByLabel('Porta').fill('2222');
  await hosts.getByRole('button', { name: 'Consultar chave SSH' }).click();
  await expect(hosts.getByText(fingerprint)).toBeVisible();
  const save = hosts.getByRole('button', { name: 'Salvar chave confiável' });
  await expect(save).toBeDisabled();
  await hosts.getByLabel(/Conferi o fingerprint/).check();
  await hosts.getByLabel('Nome', { exact: true }).fill(hostName);
  await hosts.getByLabel('Caminho absoluto do runner').fill('/home/e2e/.local/bin/adelic-remote-runner');
  const hostCreated = page.waitForResponse(
    (response) => response.url().endsWith('/api/remote-hosts') && response.request().method() === 'POST',
  );
  await save.click();
  const hostResponse = await hostCreated;
  savedHost.id = ((await hostResponse.json()) as { id: string }).id;
  await expect(hosts.getByText(fingerprint)).toBeVisible();

  await page.getByRole('button', { name: 'Adicionar projeto' }).click();
  const form = page.getByRole('dialog', { name: 'Novo projeto' });
  await form.getByLabel('Nome do projeto').fill(projectName);
  await form.getByLabel('Localização do código').selectOption('remote');
  await form
    .locator('select')
    .nth(1)
    .selectOption({ label: `${hostName} · e2e@remote.invalid:2222` });
  await form.getByLabel('Caminho remoto').fill('/home/e2e/work');
  await form.getByRole('button', { name: 'Listar diretórios' }).click();
  await form.getByRole('button', { name: 'src', exact: true }).click();
  await expect(form.getByLabel('Caminho remoto')).toHaveValue('/home/e2e/work/src');
  await form.getByRole('button', { name: 'Usar este caminho' }).click();
  await expect(form.getByText('Pasta selecionada')).toBeVisible();
  expect(directoryQueries).toContain('/home/e2e/work/src');
  await form.getByRole('button', { name: 'Criar projeto' }).click();
  expect(submittedProject).toMatchObject({
    remote: { hostId: savedHost.id, path: '/home/e2e/work/src' },
  });

  await page
    .getByRole('button', { name: new RegExp(projectName) })
    .first()
    .click();
  await expect(page.locator('.remote-cwd-label')).toContainText('/home/e2e/work/src');
  await expect(page.locator('.remote-cwd-label')).toContainText(hostName);
  await expect(page.locator('.remote-cwd-label')).toContainText('e2e@remote.invalid');
  await page.getByRole('button', { name: `Nova conversa em ${projectName}` }).click();
  const modelMenu = page.locator('.model-pill');
  await expect(modelMenu).toContainText('Codex (E2E)');
  await modelMenu.click();
  const providers = page.getByRole('list', { name: 'Provedores' });
  await expect(providers.getByRole('button', { name: 'Codex (E2E)' })).toBeVisible();
  await expect(providers.getByRole('button', { name: 'Kiro (E2E)' })).toBeVisible();
  await expect(providers.getByRole('button', { name: 'Claude (E2E)' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: `Git do projeto ${projectName}` }).click();
  await expect(page.locator('.remote-git-location')).toContainText(hostName);
  await expect(page.locator('.remote-git-location')).toContainText('e2e@remote.invalid');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await expect(page.getByRole('heading', { name: 'Mapa de código (Graphify)' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Verificações e bloqueios' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Servidores MCP' })).toHaveCount(0);
});
