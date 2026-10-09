import { expect, test, type Page } from './fixtures';

// "Atualizar Adelic" (docs/specs/self-update.md) against the E2E server's scripted updater
// (tests/e2e/fake-updater.ts): a checkout two commits behind, whose "restart" flips the
// reported commit and boot id like a real one.
test.beforeEach(async ({ request }) => {
  await request.post('/e2e/update/reset', { data: {} });
});

async function openDiagnostics(page: Page, narrow = false, navigate = true) {
  if (navigate) await page.goto('/');
  if (narrow) await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Avançado', exact: true }).click();
  const card = page.locator('section[aria-labelledby="diagnostics-title"]');
  await card.scrollIntoViewIfNeeded();
  return card;
}

test('checks, confirms, shows the steps, restarts and reconnects on the new commit', async ({ page }) => {
  const card = await openDiagnostics(page);
  await expect(card).toContainText('Versão 0.4.0 · a1b2c3d4e5f6 · checkout git (npm start)');
  await expect(card.getByRole('combobox', { name: 'Canal de atualização' })).toHaveValue('master');
  await expect(card.getByRole('button', { name: 'Atualizar agora' })).toHaveCount(0);

  await card.getByRole('button', { name: 'Verificar atualizações' }).click();
  await expect(card.getByText('2 commits novos em origin/master.')).toBeVisible();
  const commits = card.getByRole('list', { name: 'Commits da atualização' });
  await expect(commits.getByRole('listitem')).toHaveText([
    'f6e5d4c feat: botão Atualizar Adelic',
    'b7c8d9e fix: reconectar depois de reiniciar',
  ]);

  // The confirmation lists what will happen; Cancel does nothing.
  await card.getByRole('button', { name: 'Atualizar agora' }).click();
  const dialog = page.getByRole('dialog', { name: 'Atualizar o Adelic?' });
  await expect(dialog).toContainText('Avançar para origin/master (2 commits, só fast-forward)');
  await expect(dialog).toContainText('Reiniciar o servidor');
  await expect(dialog).toContainText('feat: botão Atualizar Adelic');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await (await page.request.get('/api/update/progress')).json()).state).toBe('idle');

  await card.getByRole('button', { name: 'Atualizar agora' }).click();
  await dialog.getByRole('button', { name: 'Atualizar e reiniciar' }).click();
  const steps = card.getByRole('list', { name: 'Etapas da atualização' });
  await expect(steps.getByRole('listitem', { name: 'Buscar atualizações: concluído' })).toBeVisible();
  await expect(steps.getByRole('listitem', { name: 'Compilar (npm run build): concluído' })).toBeVisible();
  // Skipped steps (no branch switch, no lockfile change) are not listed.
  await expect(steps.getByText('Instalar dependências (npm ci)')).toHaveCount(0);
  await expect(card.getByText(/Reiniciando…/)).toBeVisible();

  // The page reloads once the "new process" answers (a new boot id), now on the new commit.
  await expect(page.getByText(/Reiniciando…/)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toHaveCount(0);
  const after = await openDiagnostics(page, false, false);
  await expect(after).toContainText('Versão 0.4.0 · f6e5d4c3b2a1 · checkout git (npm start)');
  await expect(after.getByText('Adelic atualizado e reiniciado (f6e5d4c3b2a1).')).toBeVisible();
  await expect(after.getByRole('list', { name: 'Etapas da atualização' })).toHaveCount(0);
  await expect(after.getByRole('button', { name: 'Atualizar agora' })).toHaveCount(0);
});

test('refuses to apply without confirm: true and while an update runs', async ({ request }) => {
  await request.post('/api/update/check', { data: {} });
  expect((await request.post('/api/update/apply', { data: {} })).status()).toBe(400);
  expect((await request.post('/api/update/apply', { data: { confirm: true } })).status()).toBe(202);
  expect((await request.post('/api/update/apply', { data: { confirm: true } })).status()).toBe(409);
  // Runs wait until the update is over.
  const session = await (await request.post('/api/sessions', { data: {} })).json();
  const message = await request.post(`/api/sessions/${session.id}/messages`, { data: { content: '[normal] oi' } });
  expect(message.status()).toBe(409);
  await expect
    .poll(async () => (await (await request.get('/api/update/status')).json()).commit, { timeout: 10_000 })
    .toBe('f6e5d4c3b2a1');
});

test('the update section and its dialog fit a 360px screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const card = await openDiagnostics(page, true);
  await card.getByRole('button', { name: 'Verificar atualizações' }).click();
  await expect(card.getByText('2 commits novos em origin/master.')).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await card.getByRole('button', { name: 'Atualizar agora' }).click();
  const dialog = page.getByRole('dialog', { name: 'Atualizar o Adelic?' });
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(360);
  await expect(dialog.getByRole('button', { name: 'Atualizar e reiniciar' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
});
