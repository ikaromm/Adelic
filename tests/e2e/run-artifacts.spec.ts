import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A non-Git project still gets bounded delivery evidence after a write run.
let projectPath: string;
test.beforeEach(async ({ request }) => {
  projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-artifacts-')));
  await setSandbox(request, 'workspace-write');
});
test.afterEach(async ({ request }) => {
  await setSandbox(request, 'read-only');
  rmSync(projectPath, { recursive: true, force: true });
});

async function setSandbox(request: APIRequestContext, sandbox: string) {
  expect((await request.patch('/api/settings', { data: { sandbox } })).ok()).toBe(true);
}
async function startProjectConversation(page: Page, request: APIRequestContext) {
  const name = `Artifacts ${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, path: projectPath, memoryWorkspace: 'e2e', memoryProject: `artifacts-${Date.now()}` },
  });
  expect(response.ok()).toBe(true);
  const project = (await response.json()) as { id: string };
  const hooks = await request.put(`/api/projects/${project.id}/hooks`, {
    data: { afterEdit: [{ name: 'verificação real', command: 'echo execução-real' }] },
  });
  expect(hooks.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return { input, project };
}

test('shows files and real checks for a non-Git write run and fits on a 390px screen', async ({ page, request }) => {
  const { input } = await startProjectConversation(page, request);
  await input.fill('[escrever] 4');
  await input.press('Enter');

  const delivery = page.getByRole('region', { name: 'Entrega da execução' });
  await expect(delivery).toBeVisible();
  await expect(delivery).toContainText('README.md');
  await expect(delivery).toContainText('novo 4.txt');
  await expect(delivery).toContainText('verificação real');
  await expect(delivery).toContainText('echo execução-real');
  await expect(delivery).toContainText('Passou');
  await expect(delivery).toContainText('Não há evidência automática de interface além das verificações listadas.');

  const download = page.waitForEvent('download');
  await delivery.getByRole('button', { name: 'Baixar texto: novo 4.txt' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('novo 4.txt');
  expect(await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8')).toBe('criado pelo agente\n');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('historical delivery cannot initialize Git or open tools in a newly linked project', async ({ page, request }) => {
  const { input, project } = await startProjectConversation(page, request);
  await input.fill('[escrever] 4');
  await input.press('Enter');
  const delivery = page.getByRole('region', { name: 'Entrega da execução' });
  await expect(delivery).toBeVisible();
  await expect(delivery.getByRole('button', { name: 'Inicializar Git neste projeto' })).toBeVisible();
  const otherPath = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-relinked-')));
  try {
    const created = await request.post('/api/projects', {
      data: { name: `Relink ${Date.now()}`, path: otherPath, memoryWorkspace: 'e2e', memoryProject: 'relinked' },
    });
    expect(created.ok()).toBe(true);
    const other = await created.json();
    const state = await (await request.get('/api/bootstrap')).json();
    const session = state.sessions.find((item: { projectId: string }) => item.projectId === project.id);
    expect(session).toBeTruthy();
    expect((await request.patch(`/api/sessions/${session.id}`, { data: { projectId: other.id } })).ok()).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: other.name, exact: true }).click();
    await page.locator('button.session-item').filter({ hasText: session.title }).click();
    await expect(delivery).toBeVisible();
    await expect(delivery.getByRole('button', { name: 'Inicializar Git neste projeto' })).toHaveCount(0);
    await expect(delivery.getByRole('button', { name: 'Abrir terminal' })).toHaveCount(0);
    await expect(delivery.getByRole('button', { name: 'Abrir prévia' })).toHaveCount(0);
    expect((await import('node:fs')).existsSync(join(otherPath, '.git'))).toBe(false);
  } finally {
    rmSync(otherPath, { recursive: true, force: true });
  }
});
