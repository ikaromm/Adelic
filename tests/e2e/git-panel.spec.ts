import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Git panel: stage a file, read its diff, commit and see it in the log; at desktop and 360px.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

let repo: string;
test.beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-git-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Pessoa E2E');
  git(repo, 'config', 'user.email', 'e2e@example.invalid');
  git(repo, 'config', 'commit.gpgSign', 'false');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha original\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'Commit inicial');
  // A planted hook must not run: commits from the panel have hooks off by default.
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${join(repo, 'hook-ran')}'\n`, {
    mode: 0o755,
  });
});
test.afterEach(() => rmSync(repo, { recursive: true, force: true }));

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: '360px', width: 360, height: 740 },
]) {
  test(`stages, shows the diff, commits and lists the commit (${viewport.name})`, async ({ page, request }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const name = `Git ${viewport.name} ${Date.now()}`;
    const created = await request.post('/api/projects', {
      data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `git-${Date.now()}` },
    });
    expect(created.ok()).toBe(true);
    writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha alterada no painel\n');
    writeFileSync(join(repo, 'novo arquivo é.txt'), 'olá\n');

    await page.goto('/');
    if (viewport.width < 600) await page.getByRole('button', { name: 'Abrir navegação' }).click();
    await page.getByRole('button', { name, exact: true }).click();
    if (viewport.width < 600) await page.getByRole('button', { name: 'Fechar navegação' }).first().click();
    await page.getByRole('button', { name: `Git do projeto ${name}` }).click();
    await expect(page.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
    await expect(page.getByLabel('Branch atual')).toContainText('main');
    await expect(page.getByLabel('Branch atual')).toContainText('sem upstream');
    await expect(page.getByRole('button', { name: 'Enviar (git push)' })).toHaveCount(0);

    const changes = page.getByLabel('Alterações');
    await expect(changes.getByRole('heading', { name: /Não staged/ })).toBeVisible();
    await expect(changes.getByRole('heading', { name: /Não rastreados/ })).toBeVisible();

    await page.getByRole('button', { name: 'Adicionar ao stage README.md' }).click();
    await expect(changes.getByRole('heading', { name: /Staged/ })).toBeVisible();
    await changes.getByRole('button', { name: 'modificado README.md', exact: true }).click();
    const diff = page.getByLabel('Diferenças em README.md');
    await expect(diff.locator('.diff-add')).toHaveText('+linha alterada no painel');
    await expect(diff.locator('.diff-del')).toHaveText('-linha original');

    const commit = page.getByRole('button', { name: 'Fazer commit' });
    await expect(commit).toBeDisabled();
    await page.getByLabel('Mensagem do commit').fill('Altera o README pelo painel');
    await commit.click();
    await expect(page.getByText(/Commit [0-9a-f]{7} criado\./)).toBeVisible();
    const log = page.getByLabel('Commits recentes');
    await expect(log.locator('li').first()).toContainText('Altera o README pelo painel');
    await expect(log.locator('li').first()).toContainText('Pessoa E2E');
    await expect(log.locator('li')).toHaveCount(2);

    // The untracked file stays; the committed one left the list.
    await expect(changes.getByRole('button', { name: 'não rastreado novo arquivo é.txt', exact: true })).toBeVisible();
    await expect(changes.getByRole('button', { name: /README\.md/ })).toHaveCount(0);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Altera o README pelo painel\n');
    expect(existsSync(join(repo, 'hook-ran'))).toBe(false);

    // Discarding an untracked file deletes it, after a confirmation.
    await page.getByRole('button', { name: 'Descartar novo arquivo é.txt' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Descartar alterações?' });
    await expect(dialog).toContainText('será apagado do disco');
    await dialog.getByRole('button', { name: 'Descartar' }).click();
    await expect(page.getByText('Nenhuma alteração.')).toBeVisible();
    expect(existsSync(join(repo, 'novo arquivo é.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('linha alterada no painel');

    // Nothing spills sideways at small widths.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
