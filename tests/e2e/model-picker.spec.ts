import { expect, test } from './fixtures';

test.beforeEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'pt-BR' } })).ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  expect((await request.patch('/api/settings', { data: { language: 'auto' } })).ok()).toBe(true);
});

test('filters models, favorites one, and restores the favorite after reload', async ({ page, request }) => {
  const bootstrap = await (await request.get('/api/bootstrap')).json();
  const provider = bootstrap.providers.find((item: { models: { id: string }[] }) => item.models.length > 0);
  if (!provider) {
    test.skip(true, 'This test environment exposes no provider models.');
    return;
  }
  const model = provider.models[0];

  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  const trigger = page.getByRole('button', { name: /^Escolher modelo e provedor/ });
  await trigger.click();

  const menu = page.getByRole('dialog', { name: 'Escolher modelo e provedor' });
  const search = menu.getByRole('textbox', { name: 'Buscar modelos' });
  await expect(search).toBeFocused();
  await search.fill(model.id);
  const choice = menu.getByRole('button', {
    name: new RegExp(`^${escapeRegex(model.name)} · ${escapeRegex(provider.name)} · ${escapeRegex(model.id)}`),
  });
  await expect(choice).toBeVisible();
  const favoriteLabel = `Adicionar ${model.id} de ${provider.name} aos favoritos`;
  await menu.getByRole('button', { name: favoriteLabel }).click();
  await expect(menu.getByRole('region', { name: 'Modelos correspondentes' })).toContainText('Favoritos');
  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem('adelic.model-picker.favorites.v1')))
    .toContain(`${provider.id}:${model.id}`);

  await page.reload();
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  await page.getByRole('button', { name: /^Escolher modelo e provedor/ }).click();
  const reopened = page.getByRole('dialog', { name: 'Escolher modelo e provedor' });
  await expect(reopened.getByRole('region', { name: 'Modelos correspondentes' })).toContainText('Favoritos');
  await expect(
    reopened.getByRole('button', { name: `Remover ${model.id} de ${provider.name} dos favoritos` }),
  ).toBeVisible();
});

test('model picker stays inside a 390px mobile viewport', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Escolher modelo e provedor/ }).click();
  const menu = page.getByRole('dialog', { name: 'Escolher modelo e provedor' });
  await expect(menu.getByRole('textbox', { name: 'Buscar modelos' })).toBeVisible();
  const bounds = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: document.documentElement.clientWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
});

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
