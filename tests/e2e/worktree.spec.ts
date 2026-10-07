import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated worktree per conversation: the scripted provider's [escrever] marker writes in
// input.cwd, which is the worktree once enabled, so the main checkout stays untouched.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const ID = ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid'];

let repo: string;
test.beforeEach(async ({ request }) => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-wt-')));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha original\n');
  git(repo, 'add', '-A');
  git(repo, ...ID, 'commit', '-qm', 'init');
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
  const name = `Worktree ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `wt-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}

test('works in an isolated copy, shows its changes and applies them with a merge', async ({ page, request }) => {
  const input = await projectConversation(page, request);
  const panel = page.getByRole('region', { name: 'Cópia isolada' });
  await panel.getByRole('switch', { name: 'Trabalhar em uma cópia isolada (worktree)' }).click();
  await expect(panel.locator('.worktree-branch')).toContainText('adelic/');
  await expect(panel).toContainText('0 arquivos alterados em relação a');

  await input.fill('[escrever] 1');
  await input.press('Enter');
  await expect(page.locator('.markdown-content', { hasText: 'Arquivos alterados.' }).last()).toBeVisible();
  await expect(panel).toContainText('2 arquivos alterados em relação a');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Projeto\n\nlinha original\n');

  await panel.getByRole('button', { name: 'Ver alterações' }).click();
  await panel.getByRole('button', { name: /alterado README\.md/ }).click();
  await expect(panel.getByLabel('Diferenças em README.md').locator('.diff-add')).toHaveText(
    '+linha alterada pelo agente 1',
  );

  // A dirty main checkout blocks the apply, and nothing there changes.
  writeFileSync(join(repo, 'rascunho.txt'), 'do usuário\n');
  await input.fill('[normal]');
  await input.press('Enter');
  await expect(page.getByText('Resposta E2E pronta.')).toBeVisible();
  const apply = panel.getByRole('button', { name: 'Aplicar no projeto' });
  await expect(apply).toBeDisabled();
  await expect(panel).toContainText('alterações não commitadas (rascunho.txt)');
  rmSync(join(repo, 'rascunho.txt'));

  await input.fill('[normal] de novo');
  await input.press('Enter');
  await expect(apply).toBeEnabled();
  await apply.click();
  const dialog = page.getByRole('alertdialog', { name: 'Aplicar no projeto?' });
  await expect(dialog).toContainText('git merge --no-ff');
  await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Alterações aplicadas em main');
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('linha alterada pelo agente 1');
  expect(existsSync(join(repo, 'novo 1.txt'))).toBe(true);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(repo, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);

  await panel.getByRole('button', { name: 'Descartar worktree' }).click();
  const discard = page.getByRole('alertdialog', { name: 'Descartar a cópia isolada?' });
  await expect(discard).toContainText('não tem commits fora do projeto e também é apagado');
  await discard.getByRole('button', { name: 'Descartar', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('foi apagado');
  await expect(panel.getByRole('switch', { name: 'Trabalhar em uma cópia isolada (worktree)' })).not.toBeChecked();
  expect(git(repo, 'branch', '--list', 'adelic/*').trim()).toBe('');
});

test('discards an unapplied copy and keeps its branch unless asked', async ({ page, request }) => {
  const input = await projectConversation(page, request);
  const panel = page.getByRole('region', { name: 'Cópia isolada' });
  await panel.getByRole('switch', { name: 'Trabalhar em uma cópia isolada (worktree)' }).click();
  await input.fill('[escrever] 2');
  await input.press('Enter');
  await expect(panel).toContainText('2 arquivos alterados');
  // A commit of its own in the copy: the branch now holds work that is not in the project.
  const sessions = (await (await request.get('/api/bootstrap')).json()) as {
    sessions: { worktree?: { path: string } }[];
  };
  const path = sessions.sessions.find((s) => s.worktree)!.worktree!.path;
  git(path, 'add', '-A');
  git(path, ...ID, 'commit', '-qm', 'trabalho');
  await input.fill('[normal]');
  await input.press('Enter');
  await expect(page.getByText('Resposta E2E pronta.')).toBeVisible();
  await panel.getByRole('button', { name: 'Descartar worktree' }).click();
  const discard = page.getByRole('alertdialog', { name: 'Descartar a cópia isolada?' });
  await expect(discard.getByRole('checkbox', { name: /Apagar o branch também/ })).not.toBeChecked();
  await discard.getByRole('button', { name: 'Descartar', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('continua no repositório');
  expect(git(repo, 'branch', '--list', 'adelic/*').trim()).toContain('adelic/');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(existsSync(join(repo, 'novo 2.txt'))).toBe(false);
});

test('fits a 360px screen', async ({ page, request }) => {
  await projectConversation(page, request);
  await page.setViewportSize({ width: 360, height: 740 });
  const panel = page.getByRole('region', { name: 'Cópia isolada' });
  await panel.getByRole('switch', { name: 'Trabalhar em uma cópia isolada (worktree)' }).click();
  await expect(panel.getByRole('button', { name: 'Descartar worktree' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(360);
});
