import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `@file` mentions (docs/specs/mentions.md): the composer suggests the project's files, and
// the scripted provider's [mencoes] marker answers the "[Arquivo mencionado: …]" labels it got.

let folder: string;
test.beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-mentions-')));
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'src', 'App.tsx'), 'export const App = 1;\n');
  writeFileSync(join(folder, 'src', 'api.ts'), 'export const api = {};\n');
  writeFileSync(join(folder, 'notas da equipe.md'), '# Notas\n');
});
test.afterEach(() => rmSync(folder, { recursive: true, force: true }));

async function projectConversation(page: Page, request: APIRequestContext) {
  const name = `Menções ${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, path: folder, memoryWorkspace: 'e2e', memoryProject: `mencoes-${Date.now()}` },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: `Nova conversa em ${name}` }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  return input;
}
const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });
const files = (page: Page) => page.getByRole('listbox', { name: 'Arquivos do projeto' });

test('suggests files, inserts the mention and the agent receives the file', async ({ page, request }) => {
  const input = await projectConversation(page, request);
  await input.pressSequentially('[mencoes] veja @src/app');
  await expect(files(page)).toBeVisible();
  await expect(input).toHaveAttribute('aria-controls', /.+/);
  const first = files(page).getByRole('option').first();
  await expect(first).toHaveAccessibleName('src/App.tsx');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  // Enter inserts the mention instead of sending.
  await input.press('Enter');
  await expect(input).toHaveValue('[mencoes] veja @src/App.tsx ');
  await expect(files(page)).toBeHidden();

  // Mouse selection, with a quoted path for names with spaces.
  await input.pressSequentially('e @notas');
  await files(page).getByRole('option', { name: 'notas da equipe.md' }).click();
  await expect(input).toHaveValue('[mencoes] veja @src/App.tsx e @"notas da equipe.md" ');
  await input.pressSequentially('e @falta.ts');
  await expect(page.getByRole('status').filter({ hasText: 'Nenhum arquivo encontrado' })).toBeVisible();
  // Without options, Enter sends as typed.
  await input.press('Enter');

  const bubble = conversation(page).locator('.user-bubble').last();
  await expect(bubble.locator('.mention-chip')).toHaveText(['@src/App.tsx', '@"notas da equipe.md"', '@falta.ts']);
  await expect(conversation(page).locator('.markdown-content').last()).toHaveText(
    'Arquivos mencionados: src/App.tsx, notas da equipe.md.',
  );
  const activity = conversation(page).getByRole('region', { name: 'Atividade desta execução' }).last();
  await activity.locator('summary').first().click();
  await expect(activity.getByText('Menção ignorada: falta.ts (arquivo não encontrado)')).toBeVisible();
});

test('arrows, Tab and Escape; never opens with the command list nor in an e-mail', async ({ page, request }) => {
  const input = await projectConversation(page, request);
  await input.fill('@src/');
  await input.press('End');
  await input.pressSequentially('a');
  await expect(files(page).getByRole('option')).toHaveCount(2);
  await input.press('ArrowDown');
  await expect(files(page).getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp');
  await input.press('Escape');
  await expect(files(page)).toBeHidden();
  await input.pressSequentially('p');
  await expect(files(page)).toBeVisible();
  await input.press('Tab');
  await expect(input).toHaveValue(/^@src\/(App\.tsx|api\.ts) $/);

  await input.fill('');
  await input.pressSequentially('fale com dev@src');
  await expect(files(page)).toBeHidden();
  await input.fill('');
  await input.pressSequentially('/');
  await expect(page.getByRole('listbox', { name: 'Comandos salvos' })).toBeVisible();
  await expect(files(page)).toBeHidden();
});

test('a conversation without a project asks for one, and the list fits 360px', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Começar uma conversa' }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.pressSequentially('@');
  await expect(
    page.getByRole('status').filter({ hasText: 'Escolha um projeto para mencionar arquivos' }),
  ).toBeVisible();
  await input.press('Escape');
  await expect(page.getByText('Escolha um projeto para mencionar arquivos')).toBeHidden();

  // The sidebar is collapsed at 360px: open the project conversation wide, then shrink.
  await page.setViewportSize({ width: 1280, height: 800 });
  const projectInput = await projectConversation(page, request);
  await page.setViewportSize({ width: 360, height: 640 });
  await projectInput.pressSequentially('@');
  await expect(files(page)).toBeVisible();
  const box = (await files(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
