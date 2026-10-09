import { expect, test, type APIRequestContext, type Page } from './fixtures';

// Usage limits (docs/specs/spend-limits.md) against the real backend with the scripted
// provider: `[pesado]` reports 500 000 input tokens (+5 output), `[normal]` about 4 600.
// The database is shared across tests, so limits are set relative to today's usage.

const conversation = (page: Page) => page.getByRole('region', { name: 'Conversa', exact: true });
const input = (page: Page) => page.getByRole('textbox', { name: 'Mensagem para o agente' });

async function usedToday(request: APIRequestContext) {
  return ((await (await request.get('/api/usage')).json()) as { today: { tokens: number } }).today.tokens;
}
async function newConversation(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  await expect(input(page)).toBeVisible();
}
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press('Enter');
}
async function answered(page: Page, text: string, count: number) {
  await expect(conversation(page).locator('.markdown-content', { hasText: text })).toHaveCount(count);
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
}

test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { spendLimits: { enabled: false } } })).ok()).toBe(true);
});

test('warns at 80%, refuses at the limit and continues once with "Continuar mesmo assim"', async ({
  page,
  request,
}) => {
  // One [pesado] (500 005 tokens) puts usage between 83% and 99% of this limit whatever came
  // before (the database is shared), and a second one passes it.
  const limit = (await usedToday(request)) + 600_000;
  expect(
    (await request.patch('/api/settings', { data: { spendLimits: { enabled: true, dailyTokens: limit } } })).ok(),
  ).toBe(true);
  await newConversation(page);
  await send(page, '[pesado] primeira');
  await answered(page, 'Resposta pesada.', 1);
  // Over 80%: a non-blocking banner, and the next message still goes.
  const banner = page.locator('.spend-warning');
  await expect(banner).toContainText(/Uso em (8[3-9]|9\d)% do limite de tokens hoje/);
  await send(page, '[pesado] segunda');
  await answered(page, 'Resposta pesada.', 2);
  await expect(banner).toContainText('Limite de tokens hoje atingido');

  // Over the limit: refused with the reason, nothing sent, the text stays in the composer.
  await send(page, '[normal] terceira');
  const notice = page.locator('.spend-limit-notice');
  await expect(notice).toContainText(/Limite de uso atingido: tokens hoje \([\d.]+\/[\d.]+\)/);
  await expect(notice).toContainText("Ajuste em Configurações ou use 'Continuar mesmo assim'.");
  await expect(conversation(page).locator('.user-bubble', { hasText: 'terceira' })).toHaveCount(0);
  await expect(input(page)).toHaveValue('[normal] terceira');

  await notice.getByRole('button', { name: 'Continuar mesmo assim' }).click();
  await expect(conversation(page).locator('.user-bubble', { hasText: 'terceira' })).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
  await expect(input(page)).toHaveValue('');
  await expect(notice).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();

  // The override was for that one message: the next is refused again.
  await send(page, '[normal] quarta');
  await expect(page.locator('.spend-limit-notice')).toContainText('Limite de uso atingido: tokens hoje');
  await page.locator('.spend-limit-notice').getByRole('button', { name: 'Dispensar aviso' }).click();

  // A message queued during a run that meets the limit pauses the queue with the reason.
  await input(page).fill('[medio] longa');
  await page.locator('.spend-limit-notice').waitFor({ state: 'detached' });
  await page.getByRole('textbox', { name: 'Mensagem para o agente' }).press('Enter');
  await page.locator('.spend-limit-notice').getByRole('button', { name: 'Continuar mesmo assim' }).click();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await send(page, '[normal] na fila');
  const queue = page.getByRole('region', { name: 'Mensagens na fila' });
  await expect(queue).toContainText('Fila pausada.', { timeout: 10_000 });
  await expect(queue).toContainText('Limite de uso atingido');
  await queue.getByRole('button', { name: 'Continuar mesmo assim' }).click();
  await expect(conversation(page).locator('.user-bubble', { hasText: 'na fila' })).toBeVisible();
  await expect(queue).toBeHidden();
});

test('the Settings card sets a limit, shows usage, and everything fits a 360px screen', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  const card = page.getByRole('region', { name: 'Limites de uso' });
  await card.scrollIntoViewIfNeeded();
  const toggle = card.getByRole('switch', { name: 'Limitar uso' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card.locator('.usage-summary')).toContainText('Hoje');
  await expect(card.locator('.usage-summary')).toContainText('custo não informado');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const daily = card.getByRole('textbox', { name: 'Tokens por dia' });
  await daily.fill('-3');
  await expect(daily).toHaveAttribute('aria-invalid', 'true');
  // A limit equal to today's usage is already reached (independent of the other tests).
  const used = await usedToday(request);
  await daily.fill(String(used));
  await daily.press('Enter');
  await expect
    .poll(async () => (await (await request.get('/api/usage')).json()).limits.global)
    .toEqual({ enabled: true, dailyTokens: used });
  const box = (await daily.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  // A new message is refused on the small screen.
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  await expect(input(page)).toBeVisible();
  await send(page, '[normal] tela pequena');
  const notice = page.locator('.spend-limit-notice');
  await expect(notice).toContainText('Limite de uso atingido');
  const noticeBox = (await notice.boundingBox())!;
  expect(noticeBox.x).toBeGreaterThanOrEqual(0);
  expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(360);
  const button = notice.getByRole('button', { name: 'Continuar mesmo assim' });
  const buttonBox = (await button.boundingBox())!;
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await button.click();
  await expect(conversation(page).locator('.user-bubble', { hasText: 'tela pequena' })).toBeVisible();
});
