import { expect, test, type Page } from './fixtures';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Plan mode (docs/specs/plan-mode.md) against the real backend with the scripted provider:
// a planning prompt answers a fixed spec with two tasks; each task run answers "Tarefa concluída".

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });
const card = (page: Page) => conversation(page).getByRole('region', { name: 'Exportar relatório' }).last();
const tasks = (page: Page) => card(page).getByRole('list', { name: 'Tarefas do plano' }).getByRole('listitem');

async function newConversation(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}

test.beforeEach(async ({ request }) => {
  // Writing allowed in settings: the planning run must still be read-only.
  expect((await request.patch('/api/settings', { data: { sandbox: 'workspace-write' } })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { sandbox: 'read-only' } })).ok()).toBe(true);
});

test('"Planejar antes" plans read-only, then approving runs every task in order', async ({ page }) => {
  const input = await newConversation(page);
  const toggle = page.getByRole('button', { name: 'Planejar antes' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await input.fill('Quero exportar o relatório');
  await input.press('Enter');

  await expect(card(page)).toBeVisible();
  await expect(card(page).getByText('Rascunho')).toBeVisible();
  await expect(card(page).getByText('Sandbox do planejamento: read-only.')).toBeVisible();
  await expect(tasks(page)).toHaveCount(2);
  await expect(tasks(page).first().getByRole('img', { name: 'Pendente' })).toBeVisible();

  // Hold the task runs so the running state stays on screen until the test has seen it
  // (a fixed 400 ms task was racing the assertion on loaded machines).
  await page.request.post('/e2e/plan-tasks', { data: { hold: true } });
  try {
    await card(page).getByRole('button', { name: 'Aprovar e executar' }).click();
    await expect(card(page).getByText('Executando')).toBeVisible();
    await expect(tasks(page).first().getByRole('img', { name: 'Em execução' })).toBeVisible();
  } finally {
    await page.request.post('/e2e/plan-tasks', { data: { hold: false } });
  }
  await expect(card(page).getByText('Concluído', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(tasks(page).nth(0).getByRole('img', { name: 'Concluída' })).toBeVisible();
  await expect(tasks(page).nth(1).getByRole('img', { name: 'Concluída' })).toBeVisible();
  await expect(card(page).getByText('2 de 2 tarefas concluídas')).toBeVisible();
  await expect(conversation(page).locator('.user-bubble', { hasText: 'Tarefa 2/2 do plano' })).toBeVisible();
  await expect(conversation(page).locator('.markdown-content', { hasText: 'Tarefa concluída' })).toHaveCount(2);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('/plano runs once; edit, skip, next task only, discard', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('/plano exportar o relatório');
  await input.press('Enter');
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Planejar antes' })).toHaveAttribute('aria-pressed', 'false');

  // Edit the Markdown: add a task, keep the others.
  await card(page).getByRole('button', { name: 'Editar plano' }).click();
  const editor = card(page).getByRole('textbox', { name: 'Markdown do plano' });
  await editor.fill(`${await editor.inputValue()}\n- [ ] Documentar a exportação\n`);
  await card(page).getByRole('button', { name: 'Salvar plano' }).click();
  await expect(tasks(page)).toHaveCount(3);

  await card(page).getByRole('button', { name: 'Pular tarefa 1' }).click();
  await expect(tasks(page).first().getByRole('img', { name: 'Pulada' })).toBeVisible();
  await card(page).getByRole('button', { name: 'Executar só a próxima tarefa' }).click();
  await expect(tasks(page).nth(1).getByRole('img', { name: 'Concluída' })).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByText('Aprovado')).toBeVisible();
  await expect(tasks(page).nth(2).getByRole('img', { name: 'Pendente' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Continuar execução' })).toBeVisible();

  await card(page).getByRole('button', { name: 'Descartar' }).click();
  await expect(card(page).getByText('Descartado')).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Continuar execução' })).toHaveCount(0);
});

test('a failing task stops the plan; saving to the project asks before overwriting', async ({ page, request }) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-plan-')));
  try {
    const name = `Plano ${Date.now()}`;
    const created = await request.post('/api/projects', {
      data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `plano-${Date.now()}` },
    });
    expect(created.ok()).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
    const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
    await input.fill('/plano [falhar-tarefa] exportar');
    await input.press('Enter');
    await expect(tasks(page)).toHaveCount(3);
    await card(page).getByRole('button', { name: 'Aprovar e executar' }).click();
    await expect(tasks(page).nth(2).getByRole('img', { name: 'Falhou' })).toBeVisible({ timeout: 10_000 });
    await expect(card(page).getByRole('alert')).toContainText('A tarefa 3 falhou');
    await expect(tasks(page).nth(2)).toContainText('A tarefa de teste falhou');
    await expect(card(page).getByText('2 de 3 tarefas concluídas')).toBeVisible();

    const file = join(repo, '.adelic/specs/exportar-relatorio.md');
    expect(existsSync(file)).toBe(false);
    await card(page).getByRole('button', { name: 'Salvar no projeto' }).click();
    await expect(card(page).getByText('Salvo em .adelic/specs/exportar-relatorio.md')).toBeVisible();
    expect(readFileSync(file, 'utf8')).toContain('## Tarefas');
    await card(page).getByRole('button', { name: 'Salvar no projeto' }).click();
    const confirm = card(page).getByRole('alertdialog', { name: 'Substituir arquivo do plano?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Manter o arquivo' }).click();
    await expect(confirm).toBeHidden();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the plan card fits a 360 px screen', async ({ page }) => {
  // Start at desktop size (the sidebar has the button), then shrink.
  const input = await newConversation(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await input.fill('/plano exportar o relatório');
  await input.press('Enter');
  await expect(card(page)).toBeVisible();
  const box = await card(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(card(page).getByRole('button', { name: 'Aprovar e executar' })).toBeInViewport();
});
