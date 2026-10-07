import { expect, test, type Page } from '@playwright/test';

// Conversation compaction (docs/specs/compaction.md) against the real backend with the scripted
// provider: a compaction prompt answers a fixed summary ("Resumo-E2E…"), and `[eco]` answers
// with the request plus "| Resumo recebido: …" when the run carried a summary.

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });
const summaryCard = (page: Page) => conversation(page).getByRole('region', { name: 'Resumo da conversa' });

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
async function send(page: Page, text: string, answer: string | RegExp) {
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill(text);
  await input.press('Enter');
  await expect(conversation(page).locator('.markdown-content', { hasText: answer }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
}

test.afterEach(async ({ request }) => {
  expect(
    (await request.patch('/api/settings', { data: { autoCompact: false, autoCompactTokens: 150_000 } })).ok(),
  ).toBe(true);
});

test('compacts from the conversation menu; later prompts carry the summary', async ({ page }) => {
  await newConversation(page);
  await send(page, '[eco] primeira mensagem antiga', 'Eco: [eco] primeira mensagem antiga');
  await expect(conversation(page).locator('.markdown-content', { hasText: 'Resumo recebido' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Ações da conversa' }).click();
  await page.getByRole('menuitem', { name: /Compactar conversa/ }).click();
  await expect(summaryCard(page)).toBeVisible();
  await expect(summaryCard(page)).toContainText('Resumo-E2E da conversa.');
  // The covered messages are folded, still there and openable.
  const earlier = conversation(page).locator('details.compacted-messages');
  await expect(earlier.locator('> summary')).toHaveText('Mensagens anteriores ao resumo (2)');
  await expect(earlier.locator('.user-bubble')).toBeHidden();
  await earlier.locator('> summary').click();
  await expect(earlier.locator('.user-bubble', { hasText: 'primeira mensagem antiga' })).toBeVisible();
  // No user bubble for the compaction itself.
  await expect(conversation(page).locator('.user-bubble')).toHaveCount(1);

  await send(page, '[eco] depois do resumo', /Eco: .*depois do resumo \| Resumo recebido: ## Objetivo Resumo-E2E/);

  // A second compaction includes the previous summary and replaces it as the current one.
  // The command list suggests /compactar: Enter completes the name, the next Enter sends it.
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('/compac');
  await expect(
    page.getByRole('listbox', { name: 'Comandos salvos' }).getByRole('option', { name: /\/compactar/ }),
  ).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('/compactar ');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(summaryCard(page)).toContainText('(inclui o resumo anterior)');
  await expect(conversation(page).getByRole('region', { name: 'Resumo anterior da conversa' })).toBeVisible();
  await expect(conversation(page).locator('.user-bubble', { hasText: '/compactar' })).toHaveCount(0);

  // Earlier messages stay searchable.
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('dialog').getByRole('textbox').first();
  await search.fill('primeira mensagem antiga');
  await expect(page.getByRole('dialog')).toContainText('primeira mensagem antiga');
});

test('automatic compaction runs before the next message once the threshold is passed', async ({ page, request }) => {
  expect((await request.patch('/api/settings', { data: { autoCompact: true, autoCompactTokens: 1000 } })).ok()).toBe(
    true,
  );
  await newConversation(page);
  // Reports 500k input tokens: the next message compacts first.
  await send(page, '[pesado] contexto grande', 'Resposta pesada.');
  await send(page, '[eco] seguinte', /Eco: .*seguinte \| Resumo recebido: ## Objetivo Resumo-E2E/);
  await expect(summaryCard(page)).toContainText('Compactada automaticamente');
  await expect(conversation(page).locator('details.compacted-messages > summary')).toHaveText(
    'Mensagens anteriores ao resumo (2)',
  );
  // The activity of that message records the compaction.
  const activity = conversation(page).getByRole('region', { name: 'Atividade desta execução' }).last();
  await activity.locator('summary').first().click();
  await expect(activity).toContainText('Conversa compactada antes desta mensagem');
});

test('a failed automatic compaction lets the message continue without a summary', async ({ page, request }) => {
  expect((await request.patch('/api/settings', { data: { autoCompact: true, autoCompactTokens: 1000 } })).ok()).toBe(
    true,
  );
  await newConversation(page);
  // The transcript sent to the summary carries [falhar-resumo], so that call fails.
  await send(page, '[pesado] [falhar-resumo]', 'Resposta pesada.');
  await send(page, '[eco] continua', 'Eco: [eco] continua');
  await expect(conversation(page).locator('.markdown-content', { hasText: 'Resumo recebido' })).toHaveCount(0);
  await expect(summaryCard(page)).toHaveCount(0);
  await expect(conversation(page)).toContainText('a mensagem seguiu sem compactar');
});

test('the conversation menu, the summary card and the setting fit a 360px screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Começar uma conversa' }).click();
  await send(page, '[eco] tela pequena', 'Eco: [eco] tela pequena');
  await page.getByRole('button', { name: 'Ações da conversa' }).click();
  const menu = page.getByRole('menu', { name: 'Ações da conversa' });
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await page.getByRole('menuitem', { name: /Compactar conversa/ }).click();
  await expect(summaryCard(page)).toBeVisible();
  const card = (await summaryCard(page).boundingBox())!;
  expect(card.x + card.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const toggle = page.getByRole('switch', { name: 'Compactar automaticamente conversas longas' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const threshold = page.getByRole('spinbutton', { name: 'Limite para compactar' });
  await expect(threshold).toHaveValue('150000');
  await threshold.fill('200000');
  await threshold.press('Enter');
  await expect
    .poll(async () => (await (await page.request.get('/api/bootstrap')).json()).settings.autoCompactTokens)
    .toBe(200000);
  const inputBox = (await threshold.boundingBox())!;
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
