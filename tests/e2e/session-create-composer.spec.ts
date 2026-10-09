import { expect, test } from './fixtures';

test('keeps the composer unavailable until a newly created conversation is selected', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();

  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();

  const previousMessage = `conversa anterior ${Date.now()}`;
  await input.fill(previousMessage);
  await input.press('Enter');

  const previousConversation = page.getByRole('region', { name: 'Conversa', exact: true });
  await expect(previousConversation.getByText(previousMessage)).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' })).toBeVisible();

  let releaseCreate!: () => void;
  let resolveCreated!: () => void;
  const creationGate = new Promise<void>((resolve) => (releaseCreate = resolve));
  const createReachedServer = new Promise<void>((resolve) => (resolveCreated = resolve));

  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    resolveCreated();
    await creationGate;
    await route.fulfill({ response });
  });

  try {
    await page
      .getByRole('button', { name: /Nova conversa/ })
      .first()
      .click();
    await createReachedServer;

    await expect(input).toBeVisible();
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue('');

    releaseCreate();
    await expect(input).toBeEnabled();

    const firstMessage = `mensagem inicial ${Date.now()}`;
    await input.fill(firstMessage);
    await input.press('Enter');

    const conversation = page.getByRole('region', { name: 'Conversa', exact: true });
    await expect(conversation.getByText(firstMessage)).toBeVisible();
    await expect(page.locator('.markdown-content strong', { hasText: 'E2E' })).toBeVisible();
  } finally {
    releaseCreate();
  }
});
