import { expect, test } from './fixtures';

test('conversation autonomy is explicit, saved, and can inherit again', async ({ page, request }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();

  const autonomy = page.getByRole('button', { name: /^Autonomia:/ });
  await expect(autonomy).toBeVisible();
  await autonomy.click();
  const dialog = page.getByRole('dialog', { name: 'Autonomia' });
  await dialog.locator('.choice-option').nth(3).click();
  await expect(page.getByRole('button', { name: 'Autonomia: Automático' })).toBeVisible();
  const bootstrap = await (await request.get('/api/bootstrap')).json();
  expect(bootstrap.sessions.some((session: { approvalMode?: string }) => session.approvalMode === 'automatic')).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Autonomia: Automático' }).click();
  await page
    .getByRole('dialog', { name: 'Autonomia' })
    .getByRole('button', { name: /Herdar configuração/ })
    .click();
  await expect(page.getByRole('button', { name: /Autonomia: Herdar configuração/ })).toBeVisible();
});

test('Automatic permission labels preserve scoped approval when sandbox changes', async ({ page, request }) => {
  const before = await (await request.get('/api/bootstrap')).json();
  try {
    await page.goto('/');
    await page.locator('.new-chat-button').click();

    await page.getByRole('button', { name: /^Autonomia:/ }).click();
    await page.getByRole('dialog', { name: 'Autonomia' }).locator('.choice-option').nth(3).click();
    await expect(page.getByRole('button', { name: 'Autonomia: Automático' })).toBeVisible();

    const currentSandboxLabel = before.settings.sandbox === 'workspace-write' ? 'Escrita' : 'Leitura';
    const nextSandbox = before.settings.sandbox === 'read-only' ? 'workspace-write' : 'read-only';
    const sandboxLabel = nextSandbox === 'workspace-write' ? 'Escrita' : 'Leitura';
    const currentAutomaticPermissions = page.getByRole('button', {
      name: `Permissões: ${currentSandboxLabel} · Automático`,
    });
    await expect(currentAutomaticPermissions).toBeVisible();
    await currentAutomaticPermissions.click();
    await page
      .getByRole('dialog', { name: 'Permissões' })
      .getByRole('button', { name: `${sandboxLabel} · Automático` })
      .click();
    const afterSandbox = await (await request.get('/api/bootstrap')).json();
    expect(afterSandbox.settings.sandbox).toBe(nextSandbox);
    expect(afterSandbox.settings.approvalMode).toBe(before.settings.approvalMode);
    const automaticSession = afterSandbox.sessions.find(
      (item: { approvalMode?: string }) => item.approvalMode === 'automatic',
    );
    expect(automaticSession).toBeTruthy();
    const automaticPermissions = page.getByRole('button', {
      name: `Permissões: ${sandboxLabel} · Automático`,
    });
    await expect(automaticPermissions).toBeVisible();

    await automaticPermissions.click();
    await page
      .getByRole('dialog', { name: 'Permissões' })
      .getByRole('button', { name: new RegExp(`${sandboxLabel} · Manual`) })
      .click();
    await expect(page.getByRole('button', { name: `Permissões: ${sandboxLabel} · Manual` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Autonomia: Manual' })).toBeVisible();
    const afterManual = await (await request.get('/api/bootstrap')).json();
    expect(afterManual.settings.approvalMode).toBe(before.settings.approvalMode);
    expect(afterManual.sessions.find((item: { id: string }) => item.id === automaticSession.id).approvalMode).toBe(
      'manual',
    );
  } finally {
    await request.patch('/api/settings', { data: { sandbox: before.settings.sandbox } });
  }
});

test('autonomy selector translates in English', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { language: 'en' } });
  try {
    await page.goto('/');
    await page
      .getByRole('button', { name: /^New conversation/ })
      .first()
      .click();
    const autonomy = page.getByRole('button', { name: /^Autonomy:/ });
    await expect(autonomy).toBeVisible();
    await autonomy.click();
    const dialog = page.getByRole('dialog', { name: 'Autonomy' });
    await expect(dialog.getByText('Automatic', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Safe automatic', { exact: true })).toBeVisible();
  } finally {
    await request.patch('/api/settings', { data: { language: 'auto' } });
  }
});

test('Automatic is unavailable for Claude even if its catalog advertises tools', async ({ page }) => {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.providers.push({
      id: 'claude',
      name: 'Claude (E2E)',
      installed: true,
      available: true,
      status: 'ready',
      detail: '',
      models: [{ id: 'claude-e2e', name: 'Claude model' }],
      defaultModel: 'claude-e2e',
      capabilities: { fast: false, tools: true, approvals: true, cancel: true },
    });
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  const modelPicker = page.getByRole('button', { name: /Escolher modelo e provedor/ });
  await expect(modelPicker).toBeVisible();
  await modelPicker.click();
  await page.getByRole('list', { name: 'Provedores' }).getByRole('button', { name: 'Claude (E2E)' }).click();
  await page.getByRole('option', { name: /Modelo padrão/ }).click();
  await expect(page.getByRole('button', { name: /Claude \(E2E\)/ })).toBeVisible();
  await page.getByRole('button', { name: /^Autonomia:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Autonomia' });
  await expect(dialog.locator('.choice-option').nth(3)).toBeDisabled();
  await expect(dialog).toContainText('Indisponível neste runtime');
});

test('new conversation stays disabled until a delayed bootstrap is ready', async ({ page }) => {
  await page.route('**/api/bootstrap', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.goto('/');
  const newConversation = page.getByRole('button', { name: /^Nova conversa/ }).first();
  await expect(newConversation).toBeDisabled();
  await expect(newConversation).toBeEnabled({ timeout: 10_000 });
  await newConversation.click();
  await expect(page.getByRole('button', { name: /Escolher modelo e provedor/ })).toBeVisible();
});

test('frontend error telemetry records only a generic event name', async ({ page }) => {
  const canary = `UI_ERROR_PRIVATE_${Date.now()}`;
  await page.goto('/');
  const telemetry = page.waitForResponse(
    (response) => response.url().endsWith('/api/observability/client-events') && response.request().method() === 'POST',
  );
  await page.evaluate((message) => {
    window.dispatchEvent(new ErrorEvent('error', { message, error: new Error(message) }));
  }, canary);
  await telemetry;
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Observabilidade' })
    .click();
  await expect(page.getByRole('heading', { name: 'Eventos recentes' })).toBeVisible();
  await expect(page.locator('.observability-event-list')).toContainText('ui.error');
  await expect(page.locator('.page-content')).not.toContainText(canary);
});

test('an expanded run timeline refreshes with the overview polling cycle', async ({ page }) => {
  let timelineCalls = 0;
  await page.route('**/api/observability/runs/*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    timelineCalls++;
    body.events = body.events.map((event: { status: string }) => ({
      ...event,
      status: timelineCalls === 1 ? 'running' : 'success',
    }));
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  await page.locator('.composer-input').fill('[normal]');
  await page.locator('.composer-input').press('Enter');
  await expect(page.locator('.assistant-row').last()).toBeVisible({ timeout: 15_000 });

  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Observabilidade' })
    .click();
  const row = page.locator('.observability-run').first();
  await expect(row).toBeVisible();
  await row.locator('.observability-run-head').click();
  const trace = row.locator('.observability-trace');
  await expect(trace).toContainText('Em execução');
  await expect(trace).toContainText('Concluída', { timeout: 10_000 });
  expect(timelineCalls).toBeGreaterThanOrEqual(2);
});

test('observability expands a run timeline without exposing conversation prompts', async ({ page }) => {
  const secretPrompt = `OBSERVABILITY_PROMPT_PRIVATE_${Date.now()}`;
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  const input = page.locator('.composer-input');
  await input.fill(`[normal] ${secretPrompt}`);
  await input.press('Enter');
  await expect(page.locator('.assistant-row').last()).toBeVisible({ timeout: 15_000 });

  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Observabilidade' })
    .click();
  await expect(page.getByRole('heading', { name: 'Observabilidade', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Eventos recentes' })).toBeVisible();
  await expect(page.locator('.observability-event-list .trace-event').first()).toBeVisible();
  const row = page.locator('.observability-run').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('.observability-run-head').click();
  await expect(row.locator('.observability-trace')).toBeVisible();
  await expect(page.locator('.page-content')).not.toContainText(secretPrompt);
});

test('observability filters and autonomy selector fit a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const checkNoHorizontalOverflow = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  };

  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Observabilidade' })
    .click();
  const filters = page.locator('.observability-filters');
  await expect(filters).toBeVisible();
  await expect(filters.getByLabel('Projeto')).toBeVisible();
  await expect(filters.getByLabel('Conversa')).toBeVisible();
  await checkNoHorizontalOverflow();

  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();
  const autonomy = page.getByRole('button', { name: /^Autonomia:/ });
  await autonomy.click();
  const dialog = page.getByRole('dialog', { name: 'Autonomia' });
  await expect(dialog.locator('.choice-option').nth(1)).toContainText('Automático seguro');
  await expect(dialog.locator('.choice-option').nth(2)).toContainText('Manual');
  await expect(dialog.locator('.choice-option').nth(3)).toContainText('Automático');
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await checkNoHorizontalOverflow();
});
