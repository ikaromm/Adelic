import { expect, test } from './fixtures';

test('access menu keeps workspace sandbox and conversation approval separate', async ({ page, request }) => {
  const before = await (await request.get('/api/bootstrap')).json();
  const sessionIds = new Set<string>(before.sessions.map((item: { id: string }) => item.id));
  try {
    await page.goto('/');
    await page.locator('.new-chat-button').click();

    const access = page.getByRole('button', { name: /^Acesso: / });
    await expect(access).toBeVisible();
    await access.click();
    const menu = page.getByRole('dialog', { name: 'Acesso' });
    await expect(menu.getByText('Acesso à pasta do projeto')).toBeVisible();
    await expect(menu.getByText('Aprovação efetiva')).toBeVisible();
    await expect(menu.getByText('Configuração global deste computador, aplicada às próximas execuções.')).toBeVisible();
    const inheritChoice = menu.getByRole('button', { name: /Usar configuração herdada/ });
    await expect(inheritChoice).toHaveAttribute('aria-pressed', 'true');
    await expect(menu.getByText(/^Atual:/)).toBeVisible();

    const nextSandbox = before.settings.sandbox === 'read-only' ? 'workspace-write' : 'read-only';
    const workspaceChoice = nextSandbox === 'workspace-write' ? 'Escrita no projeto' : 'Somente leitura';
    await menu.getByRole('button', { name: new RegExp(workspaceChoice) }).click();

    await expect
      .poll(async () => (await (await request.get('/api/bootstrap')).json()).settings.sandbox)
      .toBe(nextSandbox);
    const afterSandbox = await (await request.get('/api/bootstrap')).json();
    expect(afterSandbox.settings.approvalMode).toBe(before.settings.approvalMode);

    await page.getByRole('button', { name: /^Acesso: / }).click();
    const approvalMenu = page.getByRole('dialog', { name: 'Acesso' });
    await approvalMenu.getByRole('button', { name: /^Manual/ }).click();
    await expect(page.getByRole('button', { name: /^Acesso: / })).toHaveAttribute('title', /Manual/);
    const afterApproval = await (await request.get('/api/bootstrap')).json();
    expect(afterApproval.settings.sandbox).toBe(nextSandbox);
    const created = afterApproval.sessions.find((item: { id: string }) => !sessionIds.has(item.id));
    expect(created?.approvalMode).toBe('manual');
    expect(afterApproval.settings.approvalMode).toBe(before.settings.approvalMode);

    await page.getByRole('button', { name: /^Acesso: / }).click();
    await page
      .getByRole('dialog', { name: 'Acesso' })
      .getByRole('button', { name: /Usar configuração herdada/ })
      .click();
    const afterInherit = await (await request.get('/api/bootstrap')).json();
    const inheritedSession = afterInherit.sessions.find((item: { id: string }) => item.id === created.id);
    expect(inheritedSession?.approvalMode).toBeUndefined();
  } finally {
    await request.patch('/api/settings', { data: { sandbox: before.settings.sandbox } });
  }
});

test('composer controls remain visible and keyboard reachable at 390px', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('.new-chat-button').click();
  await expect(page.getByRole('textbox', { name: 'Mensagem para o agente' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('composer-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });

  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  const access = page.getByRole('button', { name: /^Acesso: / });
  const attach = page.getByRole('button', { name: 'Anexar arquivos ou imagens' });
  const send = page.getByRole('button', { name: 'Enviar mensagem' });
  await expect(input).toBeVisible();
  await expect(access).toBeVisible();
  await expect(attach).toBeVisible();
  await expect(send).toBeVisible();

  const overflow = await page.locator('.composer-box').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.scrollWidth > box.width + 1;
  });
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('composer-mobile.png'), animations: 'disabled' });

  await access.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Acesso' })).toBeVisible();
  const optionOverflow = await page.locator('.composer-access-menu .choice-option').evaluateAll((options) =>
    options.some((option) => {
      const box = option.getBoundingClientRect();
      return Array.from(option.children).some((child) => {
        const text = child.getBoundingClientRect();
        return text.top < box.top || text.bottom > box.bottom;
      });
    }),
  );
  expect(optionOverflow).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Acesso' })).toBeHidden();
  await expect(access).toBeFocused();
});
