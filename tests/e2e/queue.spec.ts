import { expect, test, type Page } from '@playwright/test';

// Message queue while the agent works (docs/specs/message-queue.md), against the real
// backend with the scripted provider: [lento] streams until cancelled, [medio] finishes
// after about two seconds, [normal] answers right away.

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
const queue = (page: Page) => page.getByRole('region', { name: 'Mensagens na fila' });

test('queues a message while the agent works and starts it when the answer completes', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[medio] primeira');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  // The composer stays enabled; Enter queues instead of failing.
  await expect(input).toBeEnabled();
  await input.fill('[normal] segunda, na fila');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(queue(page).getByText('Na fila (1)')).toBeVisible();
  await expect(queue(page).getByText('[normal] segunda, na fila')).toBeVisible();
  // When the first answer completes, the queued message starts on its own.
  await expect(conversation(page).locator('.markdown-content', { hasText: 'Resposta média concluída.' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(conversation(page).locator('.user-bubble', { hasText: '[normal] segunda, na fila' })).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
  await expect(queue(page)).toBeHidden();
});

test('pauses the queue on cancel, keeps it across a reload, and resumes it', async ({ page }) => {
  const input = await newConversation(page);
  const title = `[lento] longa ${Date.now()}`; // unique: the database is shared across tests
  await input.fill(title);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await input.fill('[normal] fica na fila');
  await input.press('Enter');
  await input.fill('descartar esta');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect(queue(page).getByText('Na fila (2)')).toBeVisible();

  // Edit the first chip, remove the second.
  await queue(page).getByRole('button', { name: 'Editar mensagem 1 da fila' }).click();
  const editor = queue(page).getByRole('textbox', { name: 'Editar mensagem 1 da fila' });
  await editor.fill('[normal] editada na fila');
  await editor.press('Enter');
  await expect(queue(page).getByText('[normal] editada na fila')).toBeVisible();
  await queue(page).getByRole('button', { name: 'Remover mensagem 2 da fila' }).click();
  await expect(queue(page).getByText('Na fila (1)')).toBeVisible();

  await page.getByRole('button', { name: 'Cancelar execução' }).click();
  await expect(queue(page).getByText('Fila pausada.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();

  // The queue lives on the server: it survives a reload, still paused.
  await page.reload();
  await page.locator('.session-list').getByText(title).click();
  await expect(queue(page).getByText('[normal] editada na fila')).toBeVisible();
  await expect(queue(page).getByText('Fila pausada.')).toBeVisible();

  await queue(page).getByRole('button', { name: 'Retomar fila' }).click();
  await expect(queue(page)).toBeHidden();
  await expect(conversation(page).locator('.user-bubble', { hasText: '[normal] editada na fila' })).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
});

test('Ctrl+Enter asks before interrupting, then sends right away', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[lento] para interromper');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await input.fill('[normal] urgente');
  await input.press('Control+Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Confirmar envio imediato' });
  await expect(confirm).toBeVisible();
  // Waiting keeps the run and the draft.
  await confirm.getByRole('button', { name: 'Continuar esperando' }).click();
  await expect(confirm).toBeHidden();
  await expect(input).toHaveValue('[normal] urgente');
  await input.press('Control+Enter');
  await page.getByRole('button', { name: 'Interromper e enviar' }).click();
  await expect(input).toHaveValue('');
  await expect(conversation(page).locator('.user-bubble', { hasText: '[normal] urgente' })).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
});
