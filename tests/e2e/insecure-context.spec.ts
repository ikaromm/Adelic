import { expect, test } from '@playwright/test';

// Remote access over plain HTTP (a Tailscale IP, docs/specs/remote-access.md) is not a secure
// context, so browsers omit APIs such as crypto.randomUUID and navigator.clipboard. The tests
// run on localhost (secure), so remove those APIs before the app loads to match that case.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
  });
});

test('sends a message and copies the answer without secure-context APIs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page
    .getByRole('button', { name: /Nova conversa/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  const text = `Sem contexto seguro ${Date.now()}`;
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByRole('region', { name: 'Conversa', exact: true }).getByText(text)).toBeVisible();
  await expect(page.locator('pre code', { hasText: 'const soma = 2 + 2;' })).toBeVisible();
  // Queue while running also creates client ids.
  await input.fill('[lento] devagar');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await input.fill('na fila');
  await input.press('Enter');
  await expect(page.getByText('Na fila (1)')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar execução' }).click();
  expect(errors).toEqual([]);
});
