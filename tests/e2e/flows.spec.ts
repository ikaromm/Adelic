import { expect, test, type Page } from '@playwright/test';

// Critical user flows against the real backend and web build, with a scripted provider
// (tests/e2e/server.ts). Each test starts its own conversation, so they do not depend
// on one another even though they share the temporary database.

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

test('renders the shell with the brand, navigation and an empty state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.brand-mark')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'O que vamos construir hoje?' })).toBeVisible();
});

test('sends a message and renders the streamed Markdown answer with a copyable code block', async ({ page }) => {
  const input = await newConversation(page);
  const title = `Explique a soma ${Date.now()}`; // unique: the database is shared across tests
  await input.fill(title);
  await input.press('Enter');
  await expect(page.getByRole('region', { name: 'Conversa', exact: true }).getByText(title)).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' })).toBeVisible();
  await expect(page.locator('pre code', { hasText: 'const soma = 2 + 2;' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  // The conversation is persisted: it survives a reload.
  await page.reload();
  await expect(page.locator('.session-list').getByText(title)).toBeVisible();
});

test('approves a pending command and shows the outcome', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[aprovar] um comando');
  await input.press('Enter');
  const approve = page.getByRole('button', { name: 'Aprovar', exact: true });
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.locator('.markdown-content', { hasText: 'Comando aprovado e executado.' })).toBeVisible();
  await expect(approve).toBeHidden();
});

test('denies a pending command and nothing runs', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[aprovar] outro comando');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Negar', exact: true }).click();
  await expect(page.locator('.markdown-content', { hasText: 'Comando negado; nada foi executado.' })).toBeVisible();
});

test('cancels a running answer and re-enables the composer', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[lento] resposta');
  await input.press('Enter');
  const cancel = page.getByRole('button', { name: 'Cancelar execução' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  await input.fill('[normal] depois do cancelamento');
  await input.press('Enter');
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
});

test('navigates to Activity and Settings and shows the scripted provider', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('button', { name: 'Atividade' }).click();
  await expect(page.getByRole('heading', { name: 'Atividade', level: 1 })).toBeVisible();
  await nav.getByRole('button', { name: 'Configurações' }).click();
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
  await expect(page.locator('.provider-row', { hasText: 'Codex (E2E)' })).toContainText(
    'Provedor simulado para testes E2E',
  );
});

test('shows a clear error in Memory when ai-memory is unavailable, not an empty catalog', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: /Memória/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Memória', level: 1 })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/ai-memory/);
  await expect(page.getByText('Nenhum escopo disponível no catálogo.')).toBeHidden();
});

test('keeps the layout usable on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  // On small screens the sidebar is a drawer; the empty state offers its own start button.
  await page.getByRole('button', { name: 'Começar uma conversa' }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await expect(page.getByRole('button', { name: /Nova conversa/ }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
