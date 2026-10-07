import { expect, test, type Page } from '@playwright/test';

// Edit and resend, and branch a conversation (docs/specs/edit-branch.md), against the real
// backend with the scripted provider: [eco] answers "Eco: <current request>".

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
const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });
const answer = (page: Page, text: string) => conversation(page).locator('.markdown-content', { hasText: text });

async function say(page: Page, input: ReturnType<Page['getByRole']>, text: string) {
  await input.fill(`[eco] ${text}`);
  await input.press('Enter');
  await expect(answer(page, `Eco: [eco] ${text}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
}

test('edits a message, confirms discarding the later ones and resends the new text', async ({ page }) => {
  const input = await newConversation(page);
  const id = Date.now();
  await say(page, input, `alfa ${id}`);
  await say(page, input, 'beta');
  await say(page, input, 'gama');

  const beta = conversation(page).locator('.user-row', { hasText: '[eco] beta' });
  await beta.hover();
  await beta.getByRole('button', { name: 'Editar' }).click();
  const editor = conversation(page).getByRole('textbox', { name: 'Editar mensagem' });
  await expect(editor).toHaveValue('[eco] beta');
  // Esc cancels without changes.
  await editor.press('Escape');
  await expect(editor).toBeHidden();
  await beta.hover();
  await beta.getByRole('button', { name: 'Editar' }).click();
  await editor.fill('[eco] beta editada');
  await page.getByRole('button', { name: 'Salvar e reenviar' }).click();
  // Three later messages: beta's answer, gama and gama's answer.
  const confirm = page.getByRole('alertdialog', { name: 'Confirmar edição' });
  await expect(confirm).toContainText('as 3 mensagens seguintes');
  await confirm.getByRole('button', { name: 'Descartar e reenviar' }).click();

  await expect(answer(page, 'Eco: [eco] beta editada')).toBeVisible({ timeout: 10_000 });
  await expect(conversation(page).locator('.user-bubble', { hasText: '[eco] gama' })).toHaveCount(0);
  await expect(answer(page, 'Eco: [eco] gama')).toHaveCount(0);
  await expect(conversation(page).locator('.user-bubble')).toHaveText([`[eco] alfa ${id}`, '[eco] beta editada']);

  // The server agrees after a reload; search no longer finds the discarded message.
  await page.reload();
  await page.locator('.session-list').getByText(`[eco] alfa ${id}`).click();
  await expect(conversation(page).locator('.user-bubble')).toHaveText([`[eco] alfa ${id}`, '[eco] beta editada']);
  await expect(answer(page, 'Eco: [eco] beta editada')).toBeVisible();
});

test('branches from a message, opens the copy and links back to the original', async ({ page }) => {
  const input = await newConversation(page);
  const title = `[eco] raiz ${Date.now()}`;
  await say(page, input, title.replace('[eco] ', ''));
  await say(page, input, 'segunda');

  const firstAnswer = conversation(page).locator('.assistant-row', { hasText: `Eco: ${title}` });
  await firstAnswer.hover();
  await firstAnswer.getByRole('button', { name: 'Ramificar daqui' }).click();

  // The branch opens with the messages up to that answer.
  await expect(page.locator('.breadcrumbs strong')).toHaveText(`${title} (ramo)`);
  await expect(conversation(page).locator('.user-bubble')).toHaveText([title]);
  await expect(answer(page, `Eco: ${title}`)).toBeVisible();
  const origin = page.getByRole('button', { name: `Ramo de ${title}` });
  await expect(origin).toBeVisible();

  // The branch continues on its own.
  await say(page, input, 'no ramo');
  await expect(conversation(page).locator('.user-bubble')).toHaveText([title, '[eco] no ramo']);

  // The link opens the original, untouched.
  await origin.click();
  await expect(page.locator('.breadcrumbs strong')).toHaveText(title);
  await expect(conversation(page).locator('.user-bubble')).toHaveText([title, '[eco] segunda']);
});

test('edit and branch fit a 360px screen', async ({ page }) => {
  const input = await newConversation(page);
  // The sidebar is a drawer at 360 px: start the conversation first, then narrow the window.
  await page.setViewportSize({ width: 360, height: 640 });
  await say(page, input, `estreita ${Date.now()}`);
  await say(page, input, 'depois');
  const first = conversation(page).locator('.user-row').first();
  await first.getByRole('button', { name: 'Editar' }).click();
  await page.getByRole('button', { name: 'Salvar e reenviar' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Confirmar edição' });
  await expect(confirm).toBeVisible();
  for (const box of [
    await page.locator('.message-editor').boundingBox(),
    await confirm.getByRole('button', { name: 'Descartar e reenviar' }).boundingBox(),
  ]) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  }
  await confirm.getByRole('button', { name: 'Voltar' }).click();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();

  await conversation(page).locator('.assistant-row').first().getByRole('button', { name: 'Ramificar daqui' }).click();
  const origin = page.locator('.branch-origin');
  await expect(origin).toBeVisible();
  const box = await origin.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
