import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Settings cards in English (docs/i18n.md): remote access, usage limits, saved commands, MCP,
// diagnostics/update, checks and blocks, and the "New project" dialog. Each card must read in
// English and keep none of the Portuguese it showed before. Data (project names, built-in command
// descriptions, server texts) is left out of the word check.

const PORTUGUESE = [
  'Acesso remoto',
  'Usuário',
  'senha',
  'Sessões',
  'Limites',
  'Hoje',
  'Este mês',
  'execuç',
  'Comandos',
  'Editar',
  'Excluir',
  'Servidores',
  'Nenhum',
  'Diagnóstico',
  'Verificar',
  'Atualizar',
  'Versão',
  'Canal',
  'Verificaç',
  'bloqueios',
  'Salvar',
  'Cancelar',
  'Projeto',
  'Caminho',
];

let repo: string;
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-i18n-settings-')));
  expect((await request.patch('/api/settings', { data: { language: 'en' } })).ok()).toBe(true);
  await request.post('/e2e/update/reset', { data: {} });
});
// Back to the default `auto` (pt-BR under the pinned browser locale): i18n.spec.ts starts from it.
test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'auto' } })).ok()).toBe(true);
  await request.patch('/api/settings', { data: { spendLimits: { enabled: false } } });
  rmSync(repo, { recursive: true, force: true });
});

async function expectNoPortuguese(locator: Locator, skip: string[] = []) {
  const text = await locator.innerText();
  for (const word of PORTUGUESE) if (!skip.includes(word)) expect(text, word).not.toContain(word);
}

async function openSettings(page: Page) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

test('global Settings cards read in English', async ({ page, request }) => {
  expect((await request.patch('/api/settings', { data: { spendLimits: { enabled: true } } })).ok()).toBe(true);
  await page.goto('/');
  await openSettings(page);

  const remote = page.getByRole('region', { name: 'Remote access' });
  await expect(remote).toContainText('Username and password to open Adelic from another device');
  await expect(
    remote.getByRole('switch', { name: 'Over the internet, require manual approval for commands' }),
  ).toBeVisible();
  await expect(remote).toContainText('Active sessions');
  await expectNoPortuguese(remote);

  const limits = page.getByRole('region', { name: 'Usage limits' });
  await expect(limits.getByRole('switch', { name: 'Limit usage' })).toBeChecked();
  await expect(limits).toContainText('Tokens per day');
  await expect(limits.getByRole('textbox', { name: 'Cost per month (USD)' })).toHaveAttribute(
    'placeholder',
    'No limit',
  );
  await expect(limits.locator('.usage-summary')).toContainText('Today');
  await expect(limits.locator('.usage-summary')).toContainText('This month');
  await expect(limits.locator('.usage-summary')).toContainText(/\d+ runs?/);
  await limits.getByRole('textbox', { name: 'Tokens per day' }).fill('1,5');
  await expect(limits).toContainText('Use a whole number of tokens, or leave it empty.');
  await limits.getByRole('textbox', { name: 'Tokens per day' }).press('Escape');
  await expectNoPortuguese(limits);

  const commands = page.getByRole('region', { name: 'Commands' });
  await expect(commands).toContainText('at the start of a message');
  await expect(commands.getByRole('combobox', { name: 'Show commands for' })).toHaveValue('');
  await expect(commands.getByRole('list', { name: 'Available commands' })).toContainText('Built-in');
  await commands.getByRole('button', { name: 'New command' }).click();
  const form = commands.getByRole('form', { name: 'New command' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveAttribute('placeholder', 'e.g. review-pr');
  await form.getByRole('button', { name: 'Create global command' }).click();
  await expect(form.getByRole('alert')).toContainText('Invalid name');
  // Built-in command descriptions are server data (pt-BR); check only the frame and the form.
  await expectNoPortuguese(commands.locator('.settings-card-heading'));
  await expectNoPortuguese(form);
  await form.getByRole('button', { name: 'Cancel' }).click();

  const mcp = page.getByRole('region', { name: 'MCP servers' });
  await expect(mcp.getByRole('note')).toHaveText(
    "MCP servers run programs as your user inside the agent's sandbox. Tool calls still ask for approval; nothing is approved automatically.",
  );
  await mcp.getByRole('button', { name: 'New MCP server' }).click();
  const mcpForm = mcp.getByRole('form', { name: 'New MCP server' });
  await mcpForm.getByRole('button', { name: 'Add variable' }).click();
  await expect(mcpForm.getByRole('combobox', { name: 'Variable 1 source' })).toContainText('Pass through from Adelic');
  await mcpForm.getByRole('button', { name: 'Create server' }).click();
  await expect(mcpForm.getByRole('alert')).toHaveText(
    'Invalid name: use 1 to 48 lowercase letters, digits, _ or -, starting with a letter or digit',
  );
  await expectNoPortuguese(mcp);
  await mcpForm.getByRole('button', { name: 'Cancel' }).click();

  const diagnostics = page.locator('section[aria-labelledby="diagnostics-title"]');
  await diagnostics.scrollIntoViewIfNeeded();
  await expect(diagnostics.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(diagnostics.getByRole('switch', { name: 'Check for new versions' })).toBeVisible();
  await expect(diagnostics).toContainText('Version 0.4.0 · a1b2c3d4e5f6 · git checkout (npm start)');
  await expect(diagnostics.getByRole('combobox', { name: 'Update channel' })).toContainText('master (stable)');
  await diagnostics.getByRole('button', { name: 'Check for updates' }).click();
  await expect(diagnostics.getByText('2 new commits on origin/master.')).toBeVisible();
  await diagnostics.getByRole('button', { name: 'Update now' }).click();
  const dialog = page.getByRole('dialog', { name: 'Update Adelic?' });
  await expect(dialog).toContainText('Advance to origin/master (2 commits, fast-forward only)');
  await expectNoPortuguese(dialog, ['Atualizar']);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await diagnostics.getByRole('button', { name: 'Generate diagnostics' }).click();
  await expect(diagnostics.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(diagnostics).toContainText('Database schema');
  // Commit subjects in the list are data ("feat: botão Atualizar Adelic").
  await expectNoPortuguese(diagnostics, ['Atualizar']);
  await expect(diagnostics.locator('.self-update .setting-row').first()).not.toContainText('Atualizar');
});

test('project cards and the New project dialog read in English', async ({ page, request }) => {
  const name = `I18n ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `i18n-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `New conversation in ${name}` }).click();
  await openSettings(page);

  const hooks = page.getByRole('region', { name: 'Checks and blocks' });
  await expect(hooks).toContainText(`${name} · checks run after a run that changed files`);
  await expect(hooks).toContainText('No checks. E.g. tests or typecheck.');
  await hooks.getByRole('button', { name: 'Add check' }).click();
  const first = hooks.getByRole('listitem', { name: 'Check 1' });
  await expect(first.getByRole('spinbutton', { name: 'Timeout (s)' })).toHaveValue('120');
  await hooks.getByRole('button', { name: 'Save checks' }).click();
  await expect(hooks.getByRole('alert')).toHaveText('Check 1: name required (up to 60 characters)');
  await expect(hooks.getByRole('switch', { name: 'Fix automatically' })).toBeVisible();
  await expect(hooks).toContainText('Blocked commands');
  await expectNoPortuguese(hooks);

  const projectUsage = page.getByRole('region', { name: 'Project usage' });
  await expect(projectUsage).toContainText('conversations linked to this project');
  await expect(projectUsage).toContainText('The limits apply when "Limit usage" is on.');
  await expect(projectUsage).toContainText('Project tokens per month');
  await expectNoPortuguese(projectUsage);

  const mcp = page.getByRole('region', { name: 'MCP servers' });
  await expect(mcp.getByRole('group', { name: `MCP servers per agent in ${name}` })).toContainText(
    `In ${name}, per agent`,
  );

  await page.getByRole('button', { name: 'Add project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toContainText('Connect a folder on your computer.');
  await expect(dialog.getByRole('textbox', { name: 'Project name' })).toHaveAttribute('placeholder', 'E.g. My app');
  await expect(dialog.getByRole('textbox', { name: 'Folder path' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Memory project' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
  await expectNoPortuguese(dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
