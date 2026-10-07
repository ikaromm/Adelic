import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// MCP catalog (docs/specs/mcp-catalog.md) against the real backend: CRUD in Settings, the
// per-project toggle and the 360px layout. No MCP server is ever started here; the catalog
// only stores definitions, and the scripted provider ignores them.

const unique = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);

async function openSettings(page: Page) {
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  return page.getByRole('region', { name: 'Servidores MCP' });
}
async function createProject(request: APIRequestContext) {
  const name = `MCP ${unique()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: mkdtempSync(join(tmpdir(), 'adelic-e2e-mcp-')), memoryWorkspace: 'e2e', memoryProject: name },
  });
  expect(created.ok()).toBe(true);
  return { name, id: ((await created.json()) as { id: string }).id };
}

test('creates, edits and deletes an MCP server in Settings without showing literal values', async ({
  page,
  request,
}) => {
  const name = `docs-${unique()}`;
  await page.goto('/');
  const card = await openSettings(page);
  await expect(card.getByRole('note')).toContainText(
    'Servidores MCP executam programas com o seu usuário dentro do sandbox do agente',
  );
  await card.getByRole('button', { name: 'Novo servidor MCP' }).click();
  const form = card.getByRole('form', { name: 'Novo servidor MCP' });
  await form.getByLabel('Nome', { exact: true }).fill('Inválido!');
  await form.getByLabel('Comando').fill('sh');
  await form.getByRole('button', { name: 'Criar servidor' }).click();
  await expect(form.getByRole('alert')).toContainText('Nome inválido');

  await form.getByLabel('Nome', { exact: true }).fill(name);
  await form.getByLabel('Descrição').fill('Busca na documentação local');
  await form.getByLabel('Comando').fill('nao-existe-mcp-e2e');
  await form.getByRole('button', { name: 'Criar servidor' }).click();
  await expect(form.getByRole('alert')).toContainText('não encontrado no PATH');

  // A bare name is resolved to its absolute path when saved.
  await form.getByLabel('Comando').fill('sh');
  await form.getByLabel('Argumentos (um por linha)').fill('-c\nexit 0');
  await form.getByRole('button', { name: 'Adicionar variável' }).click();
  await form.getByLabel('Nome da variável 1').fill('HOME');
  await form.getByRole('button', { name: 'Adicionar variável' }).click();
  await form.getByLabel('Nome da variável 2').fill('API_KEY');
  await form.getByLabel('Origem da variável 2').selectOption('literal');
  await form.getByLabel('Valor da variável 2').fill('segredo-e2e');
  await form.getByRole('button', { name: 'Criar servidor' }).click();
  await expect(form).toBeHidden();

  const row = card.getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText('Busca na documentação local');
  await expect(row.locator('.mcp-command')).toHaveText(/^\/\S*\/sh -c exit 0$/);
  await expect(row).toContainText('API_KEY=••••');
  await expect(row).toContainText('HOME (do ambiente do Adelic)');
  const listing = await request.get('/api/mcp-servers');
  expect(await listing.text()).not.toContain('segredo-e2e');

  // Editing keeps the stored literal when its field is left empty.
  await card.getByRole('button', { name: `Editar ${name}` }).click();
  const edit = card.getByRole('form', { name: 'Editar servidor MCP' });
  await expect(edit.getByLabel('Valor da variável 2')).toHaveValue('');
  await expect(edit.getByLabel('Valor da variável 2')).toHaveAttribute('placeholder', '•••• (manter)');
  await edit.getByLabel('Ferramentas permitidas (uma por linha; vazio = todas)').fill('search');
  await edit.getByRole('button', { name: 'Salvar servidor' }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText('1 ferramenta permitida');
  await expect(row).toContainText('API_KEY=••••');

  await card.getByRole('button', { name: `Excluir ${name}` }).click();
  await card.getByRole('button', { name: 'Confirmar exclusão' }).click();
  await expect(card.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
});

test('enables a catalog server for one project only and shows what each agent would use', async ({ page, request }) => {
  const name = `proj-${unique()}`;
  const created = await request.post('/api/mcp-servers', { data: { name, command: 'sh' } });
  expect(created.status()).toBe(201);
  const project = await createProject(request);
  const other = await createProject(request);

  await page.goto('/');
  await page.getByRole('button', { name: project.name, exact: true }).click();
  const card = await openSettings(page);
  const toggle = card.getByRole('switch', { name: `Usar ${name} em ${project.name}` });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const report = card.getByRole('group', { name: `Servidores MCP por agente em ${project.name}` });
  await expect(report.getByRole('listitem').filter({ hasText: 'Codex' })).toContainText('nenhum');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(report.getByRole('listitem').filter({ hasText: 'Codex' })).toContainText(name);
  await expect(report.getByRole('listitem').filter({ hasText: 'Kiro' })).toContainText(name);
  await expect(report.getByRole('listitem').filter({ hasText: 'Claude' })).toContainText('nenhum');

  // Persisted per project; the other project stays off.
  expect(
    ((await (await request.get(`/api/projects/${project.id}/mcp`)).json()) as { enabled: string[] }).enabled,
  ).toHaveLength(1);
  expect(
    ((await (await request.get(`/api/projects/${other.id}/mcp`)).json()) as { enabled: string[] }).enabled,
  ).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  const again = await openSettings(page);
  await expect(again.getByRole('switch', { name: `Usar ${name} em ${project.name}` })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await again.getByRole('switch', { name: `Usar ${name} em ${project.name}` }).click();
  await expect(again.getByRole('switch', { name: `Usar ${name} em ${project.name}` })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test('the MCP card and form fit a 360px screen', async ({ page, request }) => {
  const name = `estreito-${unique()}`;
  await request.post('/api/mcp-servers', {
    data: {
      name,
      command: 'sh',
      args: ['-c', 'x'.repeat(120)],
      env: [{ name: 'A_VERY_LONG_VARIABLE_NAME', from: 'adelic-env' }],
    },
  });
  const project = await createProject(request);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  // The mobile sidebar stays open after choosing a project, so Settings is reachable directly.
  const card = await openSettings(page);
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('switch', { name: `Usar ${name} em ${project.name}` })).toBeVisible();
  await card.getByRole('button', { name: 'Novo servidor MCP' }).click();
  await card.getByRole('button', { name: 'Adicionar variável' }).click();
  await card.getByLabel('Origem da variável 1').selectOption('literal');
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // No visible text below the 11px floor inside the card.
  const smallest = await card.evaluate((root) =>
    Math.min(
      ...[...root.querySelectorAll<HTMLElement>('*')]
        .filter(
          (el) =>
            el.offsetParent !== null &&
            el.childNodes.length &&
            [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()),
        )
        .map((el) => parseFloat(getComputedStyle(el).fontSize)),
    ),
  );
  expect(smallest).toBeGreaterThanOrEqual(11);
});
