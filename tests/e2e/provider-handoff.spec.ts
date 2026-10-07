import { expect, test, type Page } from './fixtures';

// Provider handoff (docs/specs/provider-handoff.md) against the real backend with two scripted
// providers, "Codex (E2E)" and "Kiro (E2E)". The handoff prompt gets a fixed summary;
// [historico] makes the agent answer with the history it received.

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });

async function conversationWithOneAnswer(page: Page, text: string) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill(text);
  await input.press('Enter');
  await expect(conversation(page).locator('.markdown-content', { hasText: 'Resposta E2E pronta.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toHaveCount(0);
  return input;
}

async function pickKiroInModelMenu(page: Page) {
  await page.getByRole('button', { name: 'Escolher modelo e provedor' }).click();
  await page.getByRole('button', { name: 'Kiro (E2E)' }).click();
  await page.getByRole('option', { name: /Kiro E2E Model/ }).click();
}

test('picking another agent asks about a summary, shows the handoff card and the new agent gets it', async ({
  page,
}) => {
  const input = await conversationWithOneAnswer(page, 'Quero exportar o relatório em CSV');
  await pickKiroInModelMenu(page);
  const dialog = page.getByRole('dialog', { name: 'Levar um resumo da conversa?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Com resumo/ })).toBeFocused();
  await dialog.getByRole('button', { name: /Com resumo/ }).click();
  await expect(dialog).toBeHidden();

  const card = conversation(page).getByRole('region', { name: 'Passagem para Kiro (E2E)' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Resumo levado para Kiro (E2E) · Resumo escrito por Codex (E2E)');
  // Collapsed by default; opens on click.
  const toggle = card.getByRole('button', { name: /Passagem para Kiro/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(card).toContainText('Ligar o botão Exportar (resumo E2E)');
  await expect(page.getByRole('button', { name: 'Escolher modelo e provedor' })).toContainText('Kiro (E2E)');

  await input.fill('[historico] continue');
  await input.press('Enter');
  const reply = conversation(page).locator('.markdown-content', { hasText: 'Agente kiro recebeu:' });
  await expect(reply).toBeVisible();
  await expect(reply).toContainText('resumo E2E');
  await expect(reply).not.toContainText('Quero exportar o relatório');
});

test('the header action with "Só o histórico recente" switches without a summary and keeps recent messages', async ({
  page,
}) => {
  const input = await conversationWithOneAnswer(page, 'Pergunta sobre o relatório trimestral');
  await page.getByRole('button', { name: 'Continuar com outro agente' }).click();
  const dialog = page.getByRole('dialog', { name: 'Continuar com outro agente' });
  await expect(dialog.getByRole('combobox').first()).toHaveValue('kiro');
  await dialog.getByRole('button', { name: /Só o histórico recente/ }).click();
  await expect(dialog).toBeHidden();
  await expect(conversation(page).locator('.handoff-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Escolher modelo e provedor' })).toContainText('Kiro (E2E)');

  await input.fill('[historico] continue');
  await input.press('Enter');
  const reply = conversation(page).locator('.markdown-content', { hasText: 'Agente kiro recebeu:' });
  await expect(reply).toContainText('Pergunta sobre o relatório trimestral');
});

test('a failed summary falls back to a local one and says so; Cancelar keeps the agent', async ({ page }) => {
  await conversationWithOneAnswer(page, '[resumo-falha] pedido inicial');
  await pickKiroInModelMenu(page);
  const dialog = page.getByRole('dialog', { name: 'Levar um resumo da conversa?' });
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Escolher modelo e provedor' })).toContainText('Codex (E2E)');

  await pickKiroInModelMenu(page);
  await page
    .getByRole('dialog', { name: 'Levar um resumo da conversa?' })
    .getByRole('button', { name: /Com resumo/ })
    .click();
  const card = conversation(page).getByRole('region', { name: 'Passagem para Kiro (E2E)' });
  await expect(card).toContainText('Resumo local: o resumo pelo Codex (E2E) falhou');
  await expect(page.getByRole('alert').filter({ hasText: 'Resumo gerado localmente' })).toBeVisible();
  await card.getByRole('button', { name: /Passagem para Kiro/ }).click();
  await expect(card).toContainText('[resumo-falha] pedido inicial');
});

test('the handoff card fits a 360px screen', async ({ page }) => {
  await conversationWithOneAnswer(page, 'Pedido curto');
  await page.getByRole('button', { name: 'Continuar com outro agente' }).click();
  await page
    .getByRole('dialog', { name: 'Continuar com outro agente' })
    .getByRole('button', { name: /Com resumo/ })
    .click();
  await page.setViewportSize({ width: 360, height: 640 });
  const card = conversation(page).locator('.handoff-card');
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
