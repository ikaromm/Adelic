import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Project tools in English (docs/i18n.md): Git panel, isolated worktree strip, terminal and
// preview, and the orchestration / code map cards in Settings. The header buttons that open
// the panels (src/App.tsx) are converted elsewhere, so they are found by a pt-BR or en name.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const ID = ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid'];

/** Text of the area under test must not contain these Portuguese words. */
async function noPortuguese(scope: Locator, words: string[]) {
  const text = await scope.innerText();
  for (const word of words) expect(text, `"${word}" in English UI`).not.toContain(word);
}

let repo: string;
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'en' } })).ok()).toBe(true);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-i18n-tools-')));
  git(repo, 'init', '-q', '-b', 'main');
  // The Git panel commits with the repository identity and never sets one (CI has none).
  git(repo, 'config', 'user.name', 'Pessoa E2E');
  git(repo, 'config', 'user.email', 'e2e@example.invalid');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha original\n');
  git(repo, 'add', '-A');
  git(repo, ...ID, 'commit', '-qm', 'init');
});
test.afterEach(async ({ request }) => {
  await request.patch('/api/settings', { data: { language: 'auto' } });
  rmSync(repo, { recursive: true, force: true });
});

async function openProject(page: Page, request: APIRequestContext, prefix: string) {
  const name = `${prefix} ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `i18n-tools-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: `New conversation in ${name}` }).click();
  await expect(page.getByRole('textbox', { name: 'Message to the agent' })).toBeVisible();
  return name;
}

test('Git panel in English', async ({ page, request }) => {
  const name = await openProject(page, request, 'Git en');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha alterada\n');
  writeFileSync(join(repo, 'new.txt'), 'hello\n');
  await page
    .getByRole('button', { name: new RegExp(`^(Git do projeto|Git for project|Project Git).*${name}`) })
    .click();
  await expect(page.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
  const section = page.locator('.git-page');
  await expect(section.locator('.eyebrow')).toHaveText(`PROJECT · ${name}`);
  await expect(page.getByLabel('Current branch')).toContainText('no upstream');
  await expect(page.getByRole('button', { name: 'Refresh git status' })).toBeVisible();
  const changes = page.getByLabel('Changes', { exact: true });
  await expect(changes.getByRole('heading', { name: /Unstaged/ })).toBeVisible();
  await expect(changes.getByRole('heading', { name: /Untracked/ })).toBeVisible();

  await page.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(changes.getByRole('heading', { name: /Staged/ })).toBeVisible();
  await changes.getByRole('button', { name: 'modified README.md', exact: true }).click();
  await expect(page.getByLabel('Diff of README.md').locator('.diff-add')).toHaveText('+linha alterada');

  await expect(page.getByText('Commits run without git hooks.')).toBeVisible();
  await page.getByLabel('Commit message').fill('Update README');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByText(/Commit [0-9a-f]{7} created\./)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent commits' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Run git hooks on commit' })).toBeVisible();

  await page.getByRole('button', { name: 'Discard new.txt' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Discard changes?' });
  await expect(dialog).toContainText('is untracked and will be deleted from disk');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await noPortuguese(dialog, ['Descartar', 'Cancelar', 'arquivo']);
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByText('No changes. The working tree is clean.')).toBeVisible();
  await noPortuguese(section, ['Alterações', 'Atualizar', 'Mensagem', 'Commits recentes', 'sem upstream', 'Executar']);
});

test('worktree strip and dialogs in English', async ({ page, request }) => {
  await openProject(page, request, 'Worktree en');
  const panel = page.getByRole('region', { name: 'Isolated copy' });
  await panel.getByRole('switch', { name: 'Work in an isolated copy (worktree)' }).click();
  await expect(panel.locator('.worktree-branch')).toContainText('adelic/');
  await expect(panel).toContainText(/0 files changed since [0-9a-f]{7}/);
  await expect(panel.getByRole('button', { name: 'View changes' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Apply to project' })).toBeVisible();
  await noPortuguese(panel, ['arquivos', 'alterações', 'Aplicar', 'Descartar']);

  await panel.getByRole('button', { name: 'Discard worktree' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Discard the isolated copy?' });
  await expect(dialog).toContainText('The copy’s folder is deleted');
  await expect(dialog).toContainText('has no commits outside the project');
  await noPortuguese(dialog, ['Descartar', 'Cancelar', 'branch não']);
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(panel).toContainText(/Isolated copy discarded; branch adelic\/\S+ was deleted\./);
});

test('terminal and preview in English', async ({ page, request }) => {
  const name = await openProject(page, request, 'Terminal en');
  await page.getByRole('button', { name: /^(Terminal e preview do projeto|Project terminal and preview)$/ }).click();
  const panel = page.getByRole('complementary', { name: `${name} tools` });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Runs in the Adelic sandbox with the same permissions as the agents')).toBeVisible();
  await expect(panel.getByText('No commands run in this Adelic session.')).toBeVisible();
  const input = panel.getByRole('textbox', { name: 'Command' });
  await input.fill("printf '  Local:   http://localhost:5199/\\n'");
  await input.press('Enter');
  const entry = panel.getByRole('region', { name: /^Command printf/ });
  await expect(entry.getByText('Exit code 0')).toBeVisible();
  await expect(panel.locator('.terminal-meta')).toHaveText('0 of 3 running · history: ↑ and ↓');
  await expect(panel.getByRole('combobox', { name: 'Timeout' })).toBeVisible();
  await noPortuguese(panel, ['Executa', 'comandos', 'Código de saída', 'em execução', 'histórico']);

  await entry.getByRole('button', { name: /Open preview/ }).click();
  await expect(panel.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  const address = panel.getByRole('textbox', { name: 'Preview address' });
  await expect(address).toHaveValue('http://localhost:5199/');
  await expect(panel.getByRole('link', { name: 'Open in browser' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reload preview' })).toBeVisible();
  const open = panel.getByRole('button', { name: 'Open', exact: true });
  for (const [value, message] of [
    ['', 'Enter an address.'],
    ['http://127.0.0.1.evil.com/', 'Only local addresses are accepted'],
    ['http://evil.com@localhost:5173/', 'username or password'],
    ['file:///etc/passwd', 'Only http:// or https://'],
    [new URL(page.url()).origin, 'The preview cannot open Adelic itself.'],
  ]) {
    await address.fill(value);
    await open.click();
    await expect(panel.getByRole('alert')).toContainText(message);
  }
  await noPortuguese(panel, ['endereço', 'Endereço', 'aceitos', 'Abrir']);
  await panel.getByRole('button', { name: 'Close tools' }).click();
  await expect(panel).toBeHidden();
});

test('project orchestration and code map in English', async ({ page, request }) => {
  const name = await openProject(page, request, 'Tools en');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
  const orchestration = page.locator('.project-orchestration-card');
  await expect(orchestration.getByRole('heading', { name: 'Project orchestration' })).toBeVisible();
  await expect(orchestration).toContainText(`${name} · changes apply from the next turn.`);
  await expect(orchestration.getByText('Coordinator context')).toBeVisible();
  await expect(orchestration.getByRole('button', { name: 'Refresh project overview' })).toBeVisible();
  const delegate = orchestration.getByRole('switch', { name: 'Enable project orchestration' });
  const wasEnabled = (await delegate.getAttribute('aria-checked')) === 'true';
  if (!wasEnabled) await delegate.click();
  await expect(orchestration.getByText('Concurrent workers')).toBeVisible();
  await expect(orchestration.locator('select').first().locator('option')).toHaveText([
    '1 worker',
    '2 workers',
    '3 workers',
  ]);
  await expect(orchestration.getByText('Independent review')).toBeVisible();
  await expect(orchestration.getByRole('combobox', { name: /^Worker/ })).toContainText(
    'Inherit the conversation agent',
  );
  await expect(orchestration.getByRole('combobox', { name: /^Model/ }).first()).toContainText('Agent default');
  await noPortuguese(orchestration, ['Orquestração', 'executores', 'Revisão', 'Herdar', 'Modelo', 'Contexto']);

  const graph = page.locator('.graphify-card');
  await expect(graph.getByRole('heading', { name: 'Code map (Graphify)' })).toBeVisible();
  await expect(graph.getByText('Use the project map')).toBeVisible();
  await expect(graph.getByRole('switch', { name: 'Enable the project map' })).toBeVisible();
  // The status name comes from src/labels.ts (converted separately): only this card's own text is checked.
  await noPortuguese(graph, ['Mapa de código', 'Usar mapa', 'Consultar mapa', 'Criar índice', 'Indexar novamente']);
  if (!wasEnabled) await delegate.click();
});
