import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-project hooks (docs/specs/project-hooks.md) against the real backend: checks run in the
// real bubblewrap sandbox after the scripted provider's [escrever] edits the project, and
// [bloquear] asks to run `git push origin main`, which a project rule denies.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

let repo: string;
test.beforeEach(async ({ request }) => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-hooks-')));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha original\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'init');
  await setSettings(request, { sandbox: 'workspace-write', approvalMode: 'auto-safe' });
});
test.afterEach(async ({ request }) => {
  await setSettings(request, { sandbox: 'read-only', approvalMode: 'auto-safe' });
  rmSync(repo, { recursive: true, force: true });
});
async function setSettings(request: APIRequestContext, data: Record<string, string>) {
  expect((await request.patch('/api/settings', { data })).ok()).toBe(true);
}
async function createProject(request: APIRequestContext) {
  const name = `Hooks ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `hooks-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  return { name, id: ((await created.json()) as { id: string }).id };
}
async function openConversation(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}

test('configures checks in Settings, tests one, and runs them after a run edits files', async ({ page, request }) => {
  const project = await createProject(request);
  await openConversation(page, project.name);
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const card = page.getByRole('region', { name: 'Verificações e bloqueios' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Adicionar verificação' }).click();
  const first = card.getByRole('listitem', { name: 'Verificação 1' });
  await first.getByLabel('Nome').fill('conteúdo');
  await first.getByLabel('Comando').fill('grep -q agente README.md && echo README ok');
  await card.getByRole('button', { name: 'Adicionar verificação' }).click();
  const second = card.getByRole('listitem', { name: 'Verificação 2' });
  await second.getByLabel('Nome').fill('sem rede');
  await second.getByLabel('Comando').fill('echo sem conexão >&2; exit 4');
  await card.getByRole('button', { name: 'Salvar verificações' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Verificações e bloqueios salvos.' })).toBeVisible();

  // "Testar" runs it now in the sandbox: README.md still has the original text.
  await first.getByRole('button', { name: 'Testar conteúdo' }).click();
  await expect(first.getByRole('status')).toContainText('Verificação: conteúdo falhou (código 1)');
  expect(existsSync(join(repo, 'novo 1.txt'))).toBe(false);

  const hooks = (await (await request.get(`/api/projects/${project.id}/hooks`)).json()) as {
    afterEdit: { name: string; timeoutSec: number }[];
  };
  expect(hooks.afterEdit.map((c) => [c.name, c.timeoutSec])).toEqual([
    ['conteúdo', 120],
    ['sem rede', 120],
  ]);

  const input = await openConversation(page, project.name);
  await input.fill('[escrever] 1');
  await input.press('Enter');
  await expect(page.getByText('Alterou 2 arquivos (+2 −1)')).toBeVisible();
  const checks = page.getByRole('group', { name: /Verificações do projeto/ });
  await expect(checks.getByText(/Verificação: conteúdo passou \(\d+ s\)/)).toBeVisible();
  await expect(checks.getByText('Verificação: sem rede falhou (código 4)')).toBeVisible();
  await checks.getByText('Verificação: sem rede falhou (código 4)').click();
  await expect(checks.getByLabel('Saída da verificação sem rede')).toHaveText('sem conexão');
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('linha alterada pelo agente 1');
});

test('denies a blocked command without asking, even in automatic approval mode', async ({ page, request }) => {
  const project = await createProject(request);
  const saved = await request.put(`/api/projects/${project.id}/hooks`, {
    data: { blockedCommands: ['git push*'] },
  });
  expect(saved.ok()).toBe(true);
  const input = await openConversation(page, project.name);
  await input.fill('[bloquear]');
  await input.press('Enter');
  await expect(page.getByText('Comando bloqueado pelas regras do projeto: git push origin main')).toBeVisible();
  const denied = page.locator('.markdown-content', { hasText: 'Comando negado; nada foi executado.' });
  await expect(denied).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toHaveCount(0);

  // A command that no rule matches still asks.
  await input.fill('[aprovar]');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Negar', exact: true }).click();
  await expect(denied).toHaveCount(2);
});

test('fits the settings card and the check results on a small screen', async ({ page, request }) => {
  const project = await createProject(request);
  await request.put(`/api/projects/${project.id}/hooks`, {
    data: { afterEdit: [{ name: 'verificação com um nome comprido', command: 'echo ok' }] },
  });
  const input = await openConversation(page, project.name);
  await input.fill('[escrever] 3');
  await input.press('Enter');
  const check = page.getByText(/Verificação: verificação com um nome comprido passou/);
  await expect(check).toBeVisible();
  await page.setViewportSize({ width: 360, height: 640 });
  await check.click();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const card = page.getByRole('region', { name: 'Verificações e bloqueios' });
  await expect(card.getByRole('listitem', { name: 'Verificação 1' }).getByLabel('Comando')).toHaveValue('echo ok');
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(await overflow()).toBeLessThanOrEqual(0);
});
