import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scheduled automations (docs/specs/automations.md) against the real backend with the scripted
// provider: "Executar agora" runs the prompt in the automation's own conversation ("⏱ <name>"),
// and the list shows the last result. The global switch is turned off again after each test.

let repo: string;
test.beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-auto-')));
});
test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { automations: false } })).ok()).toBe(true);
  rmSync(repo, { recursive: true, force: true });
});
async function createProject(request: APIRequestContext) {
  const name = `Auto ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `auto-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  return name;
}
const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegação principal' });

test('creates an automation disabled, turns it on and runs it now into its own conversation', async ({
  page,
  request,
}) => {
  const project = await createProject(request);
  const name = `Resumo ${Date.now().toString(36)}`;
  await page.goto('/');
  await nav(page).getByRole('button', { name: 'Automações' }).click();
  await expect(page.getByRole('heading', { name: 'Automações', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Automações desativadas' })).toBeVisible();

  await page.getByRole('button', { name: 'Nova automação' }).click();
  const form = page.getByRole('form', { name: 'Nova automação' });
  // Validation uses the API's messages.
  await form.getByRole('button', { name: 'Criar automação' }).click();
  await expect(form.getByRole('alert')).toContainText('Nome obrigatório');
  await form.getByLabel('Nome').fill(name);
  await form.getByLabel('Projeto').selectOption({ label: project });
  await form.getByLabel('Pedido').fill('[normal] resuma o dia');
  await form.getByLabel('Repetição').selectOption('weekly');
  for (const day of ['Seg', 'Ter', 'Qua', 'Qui', 'Sex']) await form.getByLabel(day, { exact: true }).uncheck();
  await form.getByRole('button', { name: 'Criar automação' }).click();
  await expect(form.getByRole('alert')).toContainText('Agenda inválida');
  await form.getByLabel('Seg', { exact: true }).check();
  await form.getByLabel('Horário', { exact: true }).fill('07:30');
  await form.getByLabel('Fuso horário').fill('America/Sao_Paulo');
  const preview = form.getByRole('list', { name: 'Próximas execuções' });
  await expect(preview.getByRole('listitem')).toHaveCount(3);
  await expect(preview.getByRole('listitem').first()).toContainText('07:30');
  await expect(preview.getByRole('listitem').first()).toContainText(/seg/i);
  await expect(form.getByLabel('Minutos até negar aprovações')).toHaveValue('30');
  await form.getByRole('button', { name: 'Criar automação' }).click();
  await expect(form).toBeHidden();

  const item = page.getByRole('listitem', { name: name });
  await expect(item).toContainText('Seg às 07:30');
  await expect(item).toContainText('Desligada');
  await expect(item).toContainText('Nunca executada');
  const toggle = item.getByRole('switch', { name: `Ativar ${name}` });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // Global switch off: nothing can run.
  await expect(item.getByRole('button', { name: 'Executar agora' })).toBeDisabled();

  await page.getByRole('button', { name: 'Abrir configurações' }).click();
  const global = page.getByRole('switch', { name: 'Automações ativadas' });
  await expect(global).toHaveAttribute('aria-checked', 'false');
  await global.click();
  await expect(global).toHaveAttribute('aria-checked', 'true');

  await nav(page).getByRole('button', { name: 'Automações' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Automações desativadas' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(item.getByText('Próxima execução').locator('..')).toContainText('07:30');

  await item.getByRole('button', { name: 'Executar agora' }).click();
  await expect(item).toContainText('Concluída', { timeout: 10_000 });
  await expect(item).toContainText('(manual)');

  await item.getByRole('button', { name: 'Abrir conversa' }).click();
  await expect(page.getByRole('heading', { name: `⏱ ${name}` }).or(page.getByText(`⏱ ${name}`).first())).toBeVisible();
  const conversation = page.getByRole('region', { name: 'Conversa', exact: true });
  await expect(conversation.getByText('[normal] resuma o dia')).toBeVisible();
  await expect(conversation.getByText('Automação', { exact: true })).toBeVisible();
  await expect(conversation.getByText('Resposta E2E pronta.')).toBeVisible();

  // Running again reuses the same conversation.
  await nav(page).getByRole('button', { name: 'Automações' }).click();
  await item.getByRole('button', { name: 'Executar agora' }).click();
  await expect(item).toContainText('Concluída', { timeout: 10_000 });
  const list = (await (await request.get('/api/automations')).json()) as {
    automations: { name: string; conversationId: string }[];
  };
  const saved = list.automations.find((a) => a.name === name)!;
  const detail = (await (await request.get(`/api/sessions/${saved.conversationId}`)).json()) as {
    messages: { role: string; automationId?: string }[];
  };
  expect(detail.messages.filter((m) => m.role === 'user' && m.automationId)).toHaveLength(2);

  // Delete with confirmation; the conversation stays.
  await item.getByRole('button', { name: `Excluir ${name}` }).click();
  await item.getByRole('button', { name: 'Confirmar exclusão' }).click();
  await expect(item).toHaveCount(0);
  expect((await request.get(`/api/sessions/${saved.conversationId}`)).ok()).toBe(true);
});

test('the Automações page and form fit a 360px screen', async ({ page, request }) => {
  const project = await createProject(request);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await nav(page).getByRole('button', { name: 'Automações' }).click();
  await page.getByRole('button', { name: 'Nova automação' }).click();
  const form = page.getByRole('form', { name: 'Nova automação' });
  await form.getByLabel('Nome').fill('Estreita');
  await form.getByLabel('Projeto').selectOption({ label: project });
  await form.getByLabel('Pedido').fill('[normal] ok');
  const formBox = (await form.boundingBox())!;
  expect(formBox.x).toBeGreaterThanOrEqual(0);
  expect(formBox.x + formBox.width).toBeLessThanOrEqual(360);
  await form.getByRole('button', { name: 'Criar automação' }).click();
  const item = page.getByRole('listitem', { name: 'Estreita' }).first();
  await expect(item).toBeVisible();
  const box = (await item.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await expect(item.getByRole('button', { name: 'Executar agora' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const id = (
    (await (await request.get('/api/automations')).json()) as { automations: { id: string; name: string }[] }
  ).automations.find((a) => a.name === 'Estreita')!.id;
  expect((await request.delete(`/api/automations/${id}`, { data: {} })).status()).toBe(204);
});
