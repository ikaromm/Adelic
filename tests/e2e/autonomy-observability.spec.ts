import { expect, test } from './fixtures';

test('conversation approval is explicit, saved, and can inherit again', async ({ page, request }) => {
  const before = await (await request.get('/api/bootstrap')).json();
  const existingIds = new Set<string>(before.sessions.map((item: { id: string }) => item.id));
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Nova conversa/ })
    .first()
    .click();

  const access = page.getByRole('button', { name: /^Acesso: / });
  await expect(access).toBeVisible();
  await access.click();
  const dialog = page.getByRole('dialog', { name: 'Acesso' });
  const automatic = dialog.getByRole('button', { name: /^Automático(?! seguro)/ });
  await expect(automatic).toBeEnabled();
  await automatic.click();
  await page.getByRole('button', { name: /^Acesso: / }).click();
  await expect(page.getByRole('dialog', { name: 'Acesso' })).toContainText(
    'Atual: Automático · Substituição salva nesta conversa.',
  );
  await page.keyboard.press('Escape');

  await expect
    .poll(async () => {
      const state = await (await request.get('/api/bootstrap')).json();
      return state.sessions.find((item: { id: string }) => !existingIds.has(item.id))?.approvalMode;
    })
    .toBe('automatic');
  const afterAutomatic = await (await request.get('/api/bootstrap')).json();
  const created = afterAutomatic.sessions.find((item: { id: string }) => !existingIds.has(item.id));
  expect(created?.approvalMode).toBe('automatic');
  expect(afterAutomatic.settings.approvalMode).toBe(before.settings.approvalMode);

  await page.getByRole('button', { name: /^Acesso: / }).click();
  const inherit = page.getByRole('dialog', { name: 'Acesso' }).getByRole('button', {
    name: /Usar configuração herdada/,
  });
  await expect(inherit).toHaveAttribute('aria-pressed', 'false');
  await inherit.click();
  await expect
    .poll(async () => {
      const state = await (await request.get('/api/bootstrap')).json();
      return state.sessions.find((item: { id: string }) => item.id === created.id)?.approvalMode;
    })
    .toBeFalsy();
  await page.getByRole('button', { name: /^Acesso: / }).click();
  await expect(
    page.getByRole('dialog', { name: 'Acesso' }).getByRole('button', { name: /Usar configuração herdada/ }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('sandbox stays global while approval stays scoped to the conversation', async ({ page, request }) => {
  const before = await (await request.get('/api/bootstrap')).json();
  const existingIds = new Set<string>(before.sessions.map((item: { id: string }) => item.id));
  try {
    await page.goto('/');
    await page.locator('.new-chat-button').click();

    const access = page.getByRole('button', { name: /^Acesso: / });
    await access.click();
    const menu = page.getByRole('dialog', { name: 'Acesso' });
    await menu.getByRole('button', { name: /^Automático(?! seguro)/ }).click();

    await expect
      .poll(async () => {
        const state = await (await request.get('/api/bootstrap')).json();
        return state.sessions.find((item: { id: string }) => !existingIds.has(item.id))?.approvalMode;
      })
      .toBe('automatic');
    const afterOverride = await (await request.get('/api/bootstrap')).json();
    const overrideSession = afterOverride.sessions.find((item: { id: string }) => !existingIds.has(item.id));
    expect(overrideSession?.approvalMode).toBe('automatic');

    const nextSandbox = before.settings.sandbox === 'read-only' ? 'workspace-write' : 'read-only';
    await page.getByRole('button', { name: /^Acesso: / }).click();
    const accessMenu = page.getByRole('dialog', { name: 'Acesso' });
    await accessMenu
      .getByRole('button', {
        name: new RegExp(nextSandbox === 'workspace-write' ? '^Escrita no projeto' : '^Somente leitura'),
      })
      .click();
    await expect
      .poll(async () => (await (await request.get('/api/bootstrap')).json()).settings.sandbox)
      .toBe(nextSandbox);
    const afterSandbox = await (await request.get('/api/bootstrap')).json();
    expect(afterSandbox.settings.approvalMode).toBe(before.settings.approvalMode);
    expect(afterSandbox.sessions.find((item: { id: string }) => item.id === overrideSession.id)?.approvalMode).toBe(
      'automatic',
    );
    await expect(page.getByRole('button', { name: /^Acesso: / })).toHaveAccessibleName(
      `Acesso: ${nextSandbox === 'workspace-write' ? 'Escrita no projeto' : 'Somente leitura'}`,
    );

    await page.getByRole('button', { name: /^Acesso: / }).click();
    await page
      .getByRole('dialog', { name: 'Acesso' })
      .getByRole('button', { name: /^Manual/ })
      .click();
    await expect
      .poll(async () => {
        const state = await (await request.get('/api/bootstrap')).json();
        return state.sessions.find((item: { id: string }) => item.id === overrideSession.id)?.approvalMode;
      })
      .toBe('manual');
    const afterManual = await (await request.get('/api/bootstrap')).json();
    expect(afterManual.settings.approvalMode).toBe(before.settings.approvalMode);
    expect(afterManual.settings.sandbox).toBe(nextSandbox);
    expect(afterManual.sessions.find((item: { id: string }) => item.id === overrideSession.id).approvalMode).toBe(
      'manual',
    );

    await page.getByRole('button', { name: /^Acesso: / }).click();
    await page
      .getByRole('dialog', { name: 'Acesso' })
      .getByRole('button', { name: /Usar configuração herdada/ })
      .click();
    await expect
      .poll(async () => {
        const state = await (await request.get('/api/bootstrap')).json();
        return state.sessions.find((item: { id: string }) => item.id === overrideSession.id)?.approvalMode;
      })
      .toBeFalsy();
    const afterInherit = await (await request.get('/api/bootstrap')).json();
    expect(
      afterInherit.sessions.find((item: { id: string }) => item.id === overrideSession.id)?.approvalMode,
    ).toBeFalsy();
    expect(afterInherit.settings.sandbox).toBe(nextSandbox);
  } finally {
    await request.patch('/api/settings', { data: { sandbox: before.settings.sandbox } });
  }
});

test('access menu translates in English', async ({ page, request }) => {
  await request.patch('/api/settings', { data: { language: 'en' } });
  try {
    await page.goto('/');
    await page
      .getByRole('button', { name: /^New conversation/ })
      .first()
      .click();
    const access = page.getByRole('button', { name: /^Access: / });
    await expect(access).toBeVisible();
    await access.click();
    const dialog = page.getByRole('dialog', { name: 'Access' });
    await expect(dialog.getByText('Automatic', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Safe automatic', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Use inherited setting', { exact: true })).toBeVisible();
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
  await page
    .getByRole('dialog', { name: 'Escolher modelo e provedor', exact: true })
    .getByRole('button', { name: /^Modelo padrão/ })
    .click();
  await expect(page.getByRole('button', { name: /Claude \(E2E\)/ })).toBeVisible();
  await page.getByRole('button', { name: /^Acesso: / }).click();
  const dialog = page.getByRole('dialog', { name: 'Acesso' });
  await expect(dialog.getByRole('button', { name: /^Automático(?! seguro)/ })).toHaveCount(0);
  await expect(dialog).toContainText('Atual:');
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

test('observability filters and access menu fit a 390px viewport', async ({ page }) => {
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
  const access = page.getByRole('button', { name: /^Acesso: / });
  await access.click();
  const dialog = page.getByRole('dialog', { name: 'Acesso' });
  await expect(dialog.getByRole('button', { name: /Usar configuração herdada/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Automático seguro/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Manual/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Automático(?! seguro)/ })).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await checkNoHorizontalOverflow();
});

test('observability filters align with cards at desktop and narrow widths', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Observabilidade' })
    .click();
  for (const width of [2048, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const heading = await page.locator('.observability-page .page-heading').boundingBox();
    const filters = await page.locator('.observability-filters').boundingBox();
    const metrics = await page.locator('.observability-metrics').boundingBox();
    expect(heading).not.toBeNull();
    expect(filters).not.toBeNull();
    expect(metrics).not.toBeNull();
    expect(Math.abs(filters!.x - heading!.x)).toBeLessThan(2);
    expect(Math.abs(filters!.x - metrics!.x)).toBeLessThan(2);
    expect(Math.abs(filters!.width - metrics!.width)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});
