import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Checkpoints: a run that writes in a git project shows what it changed and can be undone.
// The scripted provider's [escrever] marker edits README.md and creates a file in the project.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

let repo: string;
test.beforeEach(async ({ request }) => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-repo-')));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha original\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'init');
  await setSandbox(request, 'workspace-write');
});
test.afterEach(async ({ request }) => {
  await setSandbox(request, 'read-only');
  rmSync(repo, { recursive: true, force: true });
});
async function setSandbox(request: APIRequestContext, sandbox: string) {
  expect((await request.patch('/api/settings', { data: { sandbox } })).ok()).toBe(true);
}
async function projectConversation(page: Page, request: APIRequestContext) {
  const name = `Repo ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `repo-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}

test('shows the files a run changed with their diff, and undoes them', async ({ page, request }) => {
  const input = await projectConversation(page, request);
  await input.fill('[escrever] 1');
  await input.press('Enter');
  const summary = page.getByText('Alterou 2 arquivos (+2 −1)');
  await expect(summary).toBeVisible();
  const head = git(repo, 'rev-parse', 'HEAD');
  expect(git(repo, 'status', '--porcelain')).toContain('README.md');

  await summary.click();
  await page.getByRole('button', { name: /alterado README\.md/ }).click();
  const diff = page.getByLabel('Diferenças em README.md');
  await expect(diff.locator('.diff-add')).toHaveText('+linha alterada pelo agente 1');
  await expect(diff.locator('.diff-del')).toHaveText('-linha original');

  await page.getByRole('button', { name: 'Desfazer alterações desta execução' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Desfazer alterações desta execução?' });
  await expect(dialog).toContainText('editado depois da execução, nada é desfeito');
  await dialog.getByRole('button', { name: 'Desfazer alterações' }).click();
  await expect(page.getByText('Alterações desfeitas.')).toBeVisible();
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Projeto\n\nlinha original\n');
  expect(existsSync(join(repo, 'novo 1.txt'))).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
});

test('blocks the undo and lists the files edited after the run', async ({ page, request }) => {
  const input = await projectConversation(page, request);
  await input.fill('[escrever] 2');
  await input.press('Enter');
  const summary = page.getByText('Alterou 2 arquivos (+2 −1)');
  await expect(summary).toBeVisible();
  writeFileSync(join(repo, 'README.md'), 'editado pelo usuário depois\n');

  await summary.click();
  await page.getByRole('button', { name: 'Desfazer alterações desta execução' }).click();
  await page.getByRole('button', { name: 'Desfazer alterações', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'alterado depois desta execução' });
  await expect(alert).toContainText('README.md');
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('editado pelo usuário depois\n');
  expect(existsSync(join(repo, 'novo 2.txt'))).toBe(true);
});
