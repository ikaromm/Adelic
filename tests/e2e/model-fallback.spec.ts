import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Switching model when the current one is overloaded (docs/specs/retries.md, "Troca de modelo").
// The scripted provider (tests/e2e/server.ts) fails `[sobrecarga]` as overloaded on its default
// model (E2E Model) and answers on any other (E2E Reserva).

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
async function setFallback(
  request: APIRequestContext,
  enabled: boolean,
  models: { providerId: string; model: string }[],
) {
  const res = await request.patch('/api/settings', { data: { modelFallback: { enabled, models } } });
  expect(res.ok()).toBe(true);
}
const modelPill = (page: Page) => page.getByRole('button', { name: 'Escolher modelo e provedor' });

test.afterEach(async ({ request }) => {
  await setFallback(request, false, []);
});

test('offers another model after an overloaded failure and switches the conversation to it', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[sobrecarga] responda');
  await input.press('Enter');
  const notice = page.locator('.retry-notice');
  await expect(notice).toContainText('Motivo: modelo sobrecarregado', { timeout: 15_000 });
  await expect(notice).toContainText('2 novas tentativas automáticas');
  await notice.getByText('Tentar com outro modelo').click();
  const options = notice.getByRole('list', { name: 'Outros modelos' });
  // The failed default model is not offered: the other model of the same provider comes
  // first, then the default model of each other available provider.
  await expect(options.getByRole('button')).toHaveText(['Codex (E2E) · E2E Reserva', 'Kiro (E2E) · Kiro E2E Model']);
  await options.getByRole('button', { name: 'Codex (E2E) · E2E Reserva' }).click();
  await expect(page.locator('.markdown-content', { hasText: 'Respondido por e2e-reserva.' })).toBeVisible();
  await expect(page.locator('.retry-notice')).toHaveCount(0);
  // The request was sent again as a new run, and the conversation now uses the new model.
  await expect(
    page.getByRole('region', { name: 'Conversa', exact: true }).getByText('[sobrecarga] responda'),
  ).toHaveCount(2);
  await expect(modelPill(page)).toContainText('E2E Reserva');
});

test('switches model automatically when enabled, for that answer only', async ({ page, request }) => {
  await setFallback(request, true, [{ providerId: 'codex', model: 'e2e-reserva' }]);
  const input = await newConversation(page);
  await input.fill('[sobrecarga] automático');
  await input.press('Enter');
  await expect(page.locator('.markdown-content', { hasText: 'Respondido por e2e-reserva.' })).toBeVisible({
    timeout: 15_000,
  });
  const activity = page.getByRole('region', { name: 'Atividade desta execução' }).last();
  await expect(activity).toContainText('modelo trocado');
  await activity.locator('summary').first().click();
  await expect(activity.locator('.activity-event.fallback')).toHaveText(
    /Modelo sobrecarregado: trocado de Codex \(E2E\) · E2E Model para Codex \(E2E\) · E2E Reserva/,
  );
  await expect(page.locator('.retry-notice')).toHaveCount(0);
  // The conversation keeps its model (the provider default, never set to the fallback).
  await expect(modelPill(page)).toContainText('Modelo padrão');
  await expect(modelPill(page)).not.toContainText('Reserva');
});

test('Settings picks the fallback models from the catalog and fits a 360px screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  const toggle = page.getByRole('switch', { name: 'Trocar de modelo se o atual estiver sobrecarregado' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Escolha pelo menos um modelo')).toBeVisible();
  const add = page.getByRole('combobox', { name: 'Adicionar modelo alternativo' });
  await add.selectOption({ label: 'Codex (E2E) · E2E Reserva' });
  await add.selectOption({ label: 'Codex (E2E) · E2E Model' });
  const list = page.getByRole('list', { name: 'Modelos alternativos, em ordem' });
  await expect(list.locator('.fallback-name')).toHaveText(['Codex (E2E) · E2E Reserva', 'Codex (E2E) · E2E Model']);
  await list.getByRole('button', { name: 'Subir Codex (E2E) · E2E Model' }).click();
  await expect(list.locator('.fallback-name')).toHaveText(['Codex (E2E) · E2E Model', 'Codex (E2E) · E2E Reserva']);
  // Only the other provider's model is left to add (plus the placeholder).
  await expect(add.locator('option')).toHaveText(['Adicionar modelo…', 'Kiro (E2E) · Kiro E2E Model']);
  const box = await page.locator('.fallback-models').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  // Saved on the server.
  const settings = await (await page.request.get('/api/bootstrap')).json();
  expect(settings.settings.modelFallback).toEqual({
    enabled: true,
    models: [
      { providerId: 'codex', model: 'e2e-model' },
      { providerId: 'codex', model: 'e2e-reserva' },
    ],
  });
  await list.getByRole('button', { name: 'Remover Codex (E2E) · E2E Model' }).click();
  await expect(list.locator('.fallback-name')).toHaveText(['Codex (E2E) · E2E Reserva']);
});
