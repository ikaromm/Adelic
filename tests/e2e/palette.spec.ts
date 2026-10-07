import { expect, test, type Page } from './fixtures';

// Command palette (docs/specs/command-palette.md) against the real backend and web build.

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
const palette = (page: Page) => page.getByRole('dialog', { name: 'Paleta de comandos' });
const field = (page: Page) => page.getByRole('combobox', { name: 'Buscar ações' });
async function openPalette(page: Page) {
  await page.keyboard.press('Control+p');
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

test('Ctrl+P opens the palette, filters and opens a conversation; Esc returns focus', async ({ page }) => {
  // A conversation with a unique title to find later (the database is shared across tests).
  const title = `Paleta alvo ${Date.now().toString(36)}`;
  const input = await newConversation(page);
  await input.fill(`[normal] ${title}`);
  await input.press('Enter');
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' })).toBeVisible();
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  await expect(input).toBeFocused();

  await openPalette(page);
  const listbox = palette(page).getByRole('listbox', { name: 'Ações' });
  await expect(listbox.getByRole('group', { name: 'Ações' })).toBeVisible();
  await expect(field(page)).toHaveAttribute('aria-activedescendant', /.+/);
  // Esc closes and focus goes back to the composer.
  await field(page).press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(input).toBeFocused();

  await openPalette(page);
  // Accent-insensitive subsequence filter over conversation titles.
  await field(page).fill(title.replace('Paleta', 'páleta').toLowerCase());
  const option = listbox.getByRole('option', { name: new RegExp(title) });
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await field(page).press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('.topbar strong', { hasText: title })).toBeVisible();

  // Keyboard: End/Home move the active option to the last/first row.
  await openPalette(page);
  const options = listbox.getByRole('option');
  await field(page).press('End');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await field(page).press('Home');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  // The recent selection is listed first.
  await expect(listbox.getByRole('group', { name: 'Recentes' }).getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('switches the conversation mode and inserts a saved command into the composer', async ({ page }) => {
  const input = await newConversation(page);
  await openPalette(page);
  await field(page).fill('completo');
  await expect(
    palette(page)
      .getByRole('option', { name: /Completo/ })
      .first(),
  ).toHaveAttribute('aria-selected', 'true');
  await field(page).press('Enter');
  await expect(page.getByRole('button', { name: /^Projeto e modo da conversa/ })).toContainText('Completo');

  await openPalette(page);
  await field(page).fill('/revisar');
  await field(page).press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect(input).toHaveValue('/revisar ');
  await expect(input).toBeFocused();
  await input.pressSequentially('src/app.ts');
  await expect(input).toHaveValue('/revisar src/app.ts');
});

test('agent and mode actions are disabled while a run is active', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[lento] resposta longa');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await openPalette(page);
  await field(page).fill('rapido');
  const option = palette(page)
    .getByRole('option', { name: /Rápido/ })
    .first();
  await expect(option).toHaveAttribute('aria-disabled', 'true');
  await expect(option).toContainText('Indisponível durante a execução');
  // The active row skips disabled options, and clicking one does nothing.
  await expect(option).toHaveAttribute('aria-selected', 'false');
  await option.click({ force: true });
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await field(page).press('Escape');
  await page.getByRole('button', { name: 'Cancelar execução' }).click();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
});

test('the palette fits a 360px screen and is listed in the help', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'O que vamos construir hoje?' })).toBeVisible();
  await openPalette(page);
  const box = (await palette(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // Settings opens from the palette on a small screen too.
  await field(page).fill('configuracoes');
  await field(page).press('Enter');
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Ajuda' }).click();
  await expect(page.getByRole('dialog', { name: 'Como usar o Adelic' })).toContainText('Paleta de comandos');
});
