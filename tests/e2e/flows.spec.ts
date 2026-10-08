import { expect, test, type Page } from './fixtures';

// Critical user flows against the real backend and web build, with a scripted provider
// (tests/e2e/server.ts). Each test starts its own conversation, so they do not depend
// on one another even though they share the temporary database.

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

test('renders the shell with the brand, navigation and an empty state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.brand-mark')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'O que vamos construir hoje?' })).toBeVisible();
});

test('sends a message and renders the streamed Markdown answer with a copyable code block', async ({ page }) => {
  const input = await newConversation(page);
  const title = `Explique a soma ${Date.now()}`; // unique: the database is shared across tests
  await input.fill(title);
  await input.press('Enter');
  await expect(page.getByRole('region', { name: 'Conversa', exact: true }).getByText(title)).toBeVisible();
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' })).toBeVisible();
  await expect(page.locator('pre code', { hasText: 'const soma = 2 + 2;' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  // The conversation is persisted: it survives a reload.
  await page.reload();
  await expect(page.locator('.session-list').getByText(title)).toBeVisible();
});

test('approves a pending command and shows the outcome', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[aprovar] um comando');
  await input.press('Enter');
  const approve = page.getByRole('button', { name: 'Aprovar', exact: true });
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.locator('.markdown-content', { hasText: 'Comando aprovado e executado.' })).toBeVisible();
  await expect(approve).toBeHidden();
});

test('denies a pending command and nothing runs', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[aprovar] outro comando');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Negar', exact: true }).click();
  await expect(page.locator('.markdown-content', { hasText: 'Comando negado; nada foi executado.' })).toBeVisible();
});

test('cancels a running answer and re-enables the composer', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[lento] resposta');
  await input.press('Enter');
  const cancel = page.getByRole('button', { name: 'Cancelar execução' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  await input.fill('[normal] depois do cancelamento');
  await input.press('Enter');
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
});

test('navigates to Observability and Settings and shows the scripted provider', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('button', { name: 'Observabilidade' }).click();
  await expect(page.getByRole('heading', { name: 'Observabilidade', level: 1 })).toBeVisible();
  await nav.getByRole('button', { name: 'Configurações' }).click();
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
  await expect(page.locator('.provider-row', { hasText: 'Codex (E2E)' })).toContainText(
    'Provedor simulado para testes E2E',
  );
});

test('shows a clear error in Memory when ai-memory is unavailable, not an empty catalog', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: /Memória/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Memória', level: 1 })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/ai-memory/);
  await expect(page.getByText('Nenhum escopo disponível no catálogo.')).toBeHidden();
});

test('keeps the layout usable on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/');
  // On small screens the sidebar is a drawer; the empty state offers its own start button.
  await page.getByRole('button', { name: 'Começar uma conversa' }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await expect(page.getByRole('button', { name: /Nova conversa/ }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('generates a diagnostics report in Settings without conversation content', async ({ page }) => {
  const input = await newConversation(page);
  const secret = `conteudo-privado-${Date.now()}`;
  await input.fill(`[normal] ${secret}`);
  await input.press('Enter');
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await page.getByRole('button', { name: 'Gerar diagnóstico' }).click();
  const card = page.getByRole('region', { name: 'Diagnóstico' });
  await expect(card.getByText('Esquema da base')).toBeVisible();
  await expect(card).toContainText('indisponível em http://127.0.0.1:9');
  await expect(card).toContainText('codex');
  await expect(card).not.toContainText(secret);
  const report = await page.evaluate(async () => (await fetch('/api/diagnostics')).text());
  expect(report).not.toContain(secret);
  await expect(card.getByRole('button', { name: 'Baixar JSON' })).toBeVisible();
});

test('Ctrl+K starts a conversation and Escape closes the mobile drawer', async ({ page }) => {
  await page.goto('/');
  // The shortcut is ignored until the app has loaded its data.
  await expect(page.getByRole('heading', { name: 'O que vamos construir hoje?' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('textbox', { name: 'Mensagem para o agente' })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await expect(page.locator('.sidebar-mobile-open')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar-mobile-open')).toHaveCount(0);
});

test('keeps reading position when scrolled up and offers a jump to the latest message', async ({ page }) => {
  const input = await newConversation(page);
  for (let i = 0; i < 6; i++) {
    await input.fill(`[normal] mensagem ${i} ${'texto '.repeat(40)}`);
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeVisible();
  }
  const conversation = page.getByRole('region', { name: 'Conversa', exact: true });
  await conversation.evaluate((el) => el.scrollTo({ top: 0 }));
  const jump = page.getByRole('button', { name: 'Ir para a mensagem mais recente' });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  // The jump scrolls smoothly; wait for it to arrive.
  await expect
    .poll(() => conversation.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(96);
});

test('update check is off by default, and when enabled shows a newer release without installing', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.update-notice')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await nav.getByRole('button', { name: 'Configurações' }).click();
  const toggle = page.getByRole('switch', { name: 'Verificar novas versões' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const notice = page.locator('.update-notice');
  await expect(notice).toContainText('Versão 99.0.0 disponível');
  await expect(notice).toHaveAttribute('href', 'https://github.com/ikaromm/Adelic/releases/tag/v99.0.0');
  await page.getByRole('button', { name: 'Verificar agora' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Nova versão 99.0.0' })).toBeVisible();
  await toggle.click();
  await expect(notice).toHaveCount(0);
});

test('searches every conversation and opens the match; exports the open one as Markdown', async ({ page }) => {
  const input = await newConversation(page);
  const word = `girassol${Date.now()}`;
  await input.fill(`[normal] fale sobre ${word}`);
  await input.press('Enter');
  await expect(page.locator('.markdown-content strong', { hasText: 'E2E' }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Nova conversa' }).first().click();
  await page.keyboard.press('Control+Shift+F');
  const box = page.getByRole('textbox', { name: 'Buscar nas conversas' });
  await box.fill(word.slice(0, 12));
  const hit = page.getByRole('listitem').filter({ hasText: word });
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark').first()).toBeVisible();
  await hit.click();
  await expect(
    page.getByRole('region', { name: 'Conversa', exact: true }).getByText(`fale sobre ${word}`),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Exportar conversa em Markdown' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^adelic-normal-fale-sobre-girassol\d+\.md$/);
  const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
  expect(text).toContain(`## Você`);
  expect(text).toContain(word);
});

test('shows tokens reported by the provider and leaves an unknown cost unknown', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[normal] quanto custou?');
  await input.press('Enter');
  const activity = page.getByRole('region', { name: 'Atividade desta execução' }).last();
  await expect(activity).toContainText('4,6 mil tokens');
  await expect(activity).not.toContainText('US$');
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Observabilidade' })
    .click();
  await expect(page.locator('.metric-card', { hasText: 'Tokens' })).toContainText('Custo não informado');
  await expect(page.locator('.observability-run').first()).toContainText('4,6 mil entrada · 5 saída');
});

test('creates a project from the dialog with a slugged memory id', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Adicionar projeto|Novo projeto/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Novo projeto' });
  await dialog.getByRole('textbox', { name: 'Nome do projeto' }).fill('Meu Aplicativo Ágil');
  await expect(dialog.getByRole('textbox', { name: 'Projeto na memória' })).toHaveValue('meu-aplicativo-agil');
  await dialog.getByRole('textbox', { name: 'Caminho da pasta' }).fill('/nao/existe');
  await dialog.getByRole('button', { name: 'Criar projeto' }).click();
  await expect(dialog.locator('.form-error')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Caminho da pasta' }).fill('/tmp');
  await dialog.getByRole('button', { name: 'Criar projeto' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.sidebar-projects').getByText('Meu Aplicativo Ágil').first()).toBeVisible();
});

test('delegates in a project and loads a task output on demand', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Adicionar projeto' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo projeto' });
  const name = `Delegação ${Date.now()}`;
  await dialog.getByRole('textbox', { name: 'Nome do projeto' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Caminho da pasta' }).fill('/tmp');
  await dialog.getByRole('button', { name: 'Criar projeto' }).click();
  await expect(dialog).toBeHidden();
  await page
    .locator('.sidebar-projects')
    .getByRole('button', { name: `Nova conversa em ${name}` })
    .click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('Revise a estrutura do projeto e explique em detalhes cada pasta');
  await input.press('Enter');
  const activity = page.getByRole('region', { name: 'Atividade desta execução' }).last();
  await expect(activity).toContainText(/tarefa/, { timeout: 15_000 });
  await activity.locator('summary').first().click();
  const load = activity.getByRole('button', { name: 'Carregar saída completa' }).first();
  await load.click();
  await expect(load).toBeHidden();
  // The output was fetched from /api/tasks/:id (it is not part of the session detail).
  await activity.getByText('Ver saída completa').first().click();
  await expect(activity.locator('.activity-output pre').first()).not.toBeEmpty();
  await expect(activity).toContainText('Executor');
});

test('retries a timeout automatically and shows that it did', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[instavel] responda');
  await input.press('Enter');
  await expect(
    page.locator('.markdown-content', { hasText: 'Recuperado depois de uma nova tentativa.' }),
  ).toBeVisible();
  const activity = page.getByRole('region', { name: 'Atividade desta execução' }).last();
  await expect(activity).toContainText('1 nova tentativa');
  await activity.locator('summary').first().click();
  await expect(activity.locator('.activity-event.retry')).toContainText('tempo esgotado; tentando de novo (2/3)');
  await expect(page.locator('.retry-notice')).toHaveCount(0);
});

test('does not repeat a run that already answered partially; offers Tentar de novo', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[quebra] responda');
  await input.press('Enter');
  const notice = page.locator('.retry-notice');
  await expect(notice).toContainText('Falha temporária');
  await expect(notice).toContainText('texto já exibido');
  await expect(page.locator('.activity-event.retry')).toHaveCount(0);
  await notice.getByRole('button', { name: 'Tentar de novo' }).click();
  // The same request is sent again as a new run (it fails again in this fixture).
  await expect(page.getByRole('region', { name: 'Conversa', exact: true }).getByText('[quebra] responda')).toHaveCount(
    2,
  );
  await expect(page.locator('.retry-notice')).toHaveCount(1);
});
