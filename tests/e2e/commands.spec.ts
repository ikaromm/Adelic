import { expect, test, type Page } from './fixtures';

// Saved commands (docs/specs/saved-commands.md) against the real backend with the scripted
// provider: the template starts with [eco], so the agent answers with the text it received.
// That shows the server expanded `/name args` while the conversation keeps what was typed.

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
async function openSettings(page: Page) {
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  return page.getByRole('region', { name: 'Comandos' });
}
const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });

test('creates a command in Settings, completes it in the composer and the agent gets the template', async ({
  page,
}) => {
  // Unique per run: the database is shared across tests (and CI retries).
  const name = `eco-${Date.now().toString(36)}`;
  await page.goto('/');
  const card = await openSettings(page);
  // Built-ins are listed read-only.
  await expect(card.getByText('/revisar', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Editar /revisar' })).toHaveCount(0);

  await card.getByRole('button', { name: 'Novo comando' }).click();
  const form = card.getByRole('form', { name: 'Novo comando' });
  await form.getByLabel('Nome').fill('ruim!');
  await form.getByLabel('Modelo').fill('[eco] x');
  await form.getByRole('button', { name: /Criar comando/ }).click();
  await expect(form.getByRole('alert')).toContainText('Nome inválido');
  await form.getByLabel('Nome').fill(name);
  await form.getByLabel('Descrição').fill('Ecoa o pedido expandido');
  await form.getByLabel('Modelo').fill('[eco] Pedido expandido: {{args}}');
  await form.getByRole('button', { name: /Criar comando/ }).click();
  await expect(form).toBeHidden();
  await expect(card.getByText(`/${name}`, { exact: true })).toBeVisible();

  const input = await newConversation(page);
  await input.fill(`/${name.slice(0, 5)}`);
  const listbox = page.getByRole('listbox', { name: 'Comandos salvos' });
  await expect(listbox).toBeVisible();
  await expect(input).toHaveAttribute('aria-controls', /.+/);
  await expect(listbox.getByRole('option', { name: new RegExp(`/${name}`) })).toHaveAttribute('aria-selected', 'true');
  // Enter completes the name instead of sending.
  await input.press('Enter');
  await expect(input).toHaveValue(`/${name} `);
  await expect(listbox).toBeHidden();
  await input.pressSequentially('alfa beta');
  await input.press('Enter');

  await expect(conversation(page).locator('.user-bubble', { hasText: `/${name} alfa beta` })).toBeVisible();
  await expect(
    conversation(page).locator('.markdown-content', { hasText: 'Eco: [eco] Pedido expandido: alfa beta' }),
  ).toBeVisible();

  // Back in Settings: delete it (DELETE carries a JSON body for the origin guard).
  await page.reload();
  const again = await openSettings(page);
  await again.getByRole('button', { name: `Excluir /${name}` }).click();
  await again.getByRole('button', { name: 'Confirmar exclusão' }).click();
  await expect(again.getByText(`/${name}`, { exact: true })).toBeHidden();
});

test('arrows move, Tab completes and Escape closes the list; unknown commands are sent as typed', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('/');
  const listbox = page.getByRole('listbox', { name: 'Comandos salvos' });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown');
  await expect(listbox.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await expect(listbox).toBeHidden();
  await expect(input).toHaveValue('/');
  await input.pressSequentially('tes');
  await expect(listbox).toBeVisible();
  await input.press('Tab');
  await expect(input).toHaveValue('/testes ');
  // Unknown name: plain text, the agent sees it unchanged.
  await input.fill('/nao-existe [eco] texto livre');
  await expect(listbox).toBeHidden();
  await input.press('Enter');
  await expect(
    conversation(page).locator('.markdown-content', { hasText: 'Eco: /nao-existe [eco] texto livre' }),
  ).toBeVisible();
});

test('the command list and the Commands card fit a 360px screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Começar uma conversa' }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('/');
  const listbox = page.getByRole('listbox', { name: 'Comandos salvos' });
  await expect(listbox).toBeVisible();
  const box = (await listbox.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await input.fill('');
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  const card = await openSettings(page);
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('button', { name: 'Novo comando' })).toBeVisible();
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
