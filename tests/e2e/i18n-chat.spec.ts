import { expect, test, type APIRequestContext, type Locator, type Page } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// English conversation screens (docs/i18n.md): welcome and help, transcript, run activity and
// changes, approvals, the message queue, the command palette and the plan card. Each test switches
// Settings.language to English through the API and restores `auto` afterwards (the pt-BR browser
// locale of playwright.config.ts resolves it to Portuguese, which tests/e2e/i18n.spec.ts expects).
// Conversation titles, prompts and agent output are data and stay as typed, so the "no Portuguese
// left" checks only look at UI chrome.

async function setLanguage(request: APIRequestContext, language: 'en' | 'auto') {
  expect((await request.patch('/api/settings', { data: { language } })).ok()).toBe(true);
}
async function setSandbox(request: APIRequestContext, sandbox: 'read-only' | 'workspace-write') {
  expect((await request.patch('/api/settings', { data: { sandbox } })).ok()).toBe(true);
}
test.beforeEach(async ({ request }) => setLanguage(request, 'en'));
test.afterEach(async ({ request }) => setLanguage(request, 'auto'));

async function newConversation(page: Page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page
    .getByRole('button', { name: /^New conversation/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Message to the agent' });
  await expect(input).toBeVisible();
  return input;
}
const conversation = (page: Page) => page.getByRole('region', { name: 'Conversation', exact: true });

async function openMobileNavigation(page: Page) {
  const sidebar = page.locator('.sidebar');
  if (!(await sidebar.evaluate((node) => node.classList.contains('sidebar-mobile-open')))) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await expect(sidebar).toHaveClass(/sidebar-mobile-open/);
}

async function closeMobileNavigation(page: Page) {
  const sidebar = page.locator('.sidebar');
  if (await sidebar.evaluate((node) => node.classList.contains('sidebar-mobile-open'))) {
    await sidebar.getByRole('button', { name: 'Close navigation' }).click();
  }
  await expect(sidebar).not.toHaveClass(/sidebar-mobile-open/);
}

/** None of these Portuguese UI words (whole words) is left in the visible text of the elements `region` matches. */
async function expectNoPortuguese(region: Locator, words: string[]) {
  await expect(region.first()).toBeVisible();
  const text = (await region.allInnerTexts()).join('\n');
  for (const word of words)
    expect(text, `"${word}" in: ${text}`).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}($|[^\\p{L}])`, 'u'));
}

test('welcome screen, help dialog and empty conversation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const welcome = page.locator('.welcome-view');
  await expect(welcome.getByRole('heading', { name: 'What are we building today?' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Start a conversation' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Summarize an idea for me' })).toBeVisible();
  await expectNoPortuguese(welcome, ['construir', 'Começar', 'Resuma', 'ideia']);

  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'How to use Adelic' });
  await expect(help).toContainText('Start with a conversation.');
  await expect(help).toContainText('Command palette');
  await expectNoPortuguese(help, ['Comece', 'conversa', 'Enviar', 'Paleta', 'Fechar', 'Entendi']);
  await help.getByRole('button', { name: 'Got it' }).click();
  await expect(help).toBeHidden();

  await newConversation(page);
  const empty = page.locator('.conversation-empty');
  await expect(empty.getByRole('heading', { name: 'A good conversation starts with a question.' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Explain what recursion is' })).toBeVisible();
  await expectNoPortuguese(empty, ['conversa', 'pergunta', 'Explique', 'Me ajude']);
});

test('answer, run activity and changes of a run that writes files', async ({ page, request }) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-i18n-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# Projeto\n\nlinha original\n');
    git('add', '-A');
    git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-qm', 'init');
    await setSandbox(request, 'workspace-write');
    const name = `Repo en ${Date.now()}`;
    const created = await request.post('/api/projects', {
      data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `repo-en-${Date.now()}` },
    });
    expect(created.ok()).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: `New conversation in ${name}` }).click();
    const input = page.getByRole('textbox', { name: 'Message to the agent' });
    await expect(page.locator('.conversation-empty')).toContainText(`The agent uses the context of ${name}`);
    await input.fill('[escrever] 1');
    await input.press('Enter');

    const activity = conversation(page).getByRole('region', { name: 'Activity for this run' });
    await expect(activity.getByText('Changed 2 files (+2 −1)')).toBeVisible();
    await expect(activity.locator('.activity-headline')).toHaveText(/^(Worked for .+|Activity)$/);
    await expect(activity.locator('.activity-counts')).toContainText('1 action');
    await activity.locator('.activity-details > summary').click();
    await expect(activity.locator('.activity-action-status')).toHaveText('Completed');
    await activity.getByText('Changed 2 files (+2 −1)').click();
    await activity.getByRole('button', { name: /modified README\.md/ }).click();
    await expect(page.getByLabel('Diff of README.md').locator('.diff-add')).toHaveText('+linha alterada pelo agente 1');
    await expect(activity.getByRole('button', { name: 'Undo this run’s changes' })).toBeVisible();
    await expect(conversation(page).getByRole('button', { name: 'Copy message' })).toBeAttached();
    await expect(conversation(page).getByRole('button', { name: 'Copy answer' })).toBeAttached();
    await expectNoPortuguese(activity.locator('.run-activity-content, .activity-details > summary, .run-changes'), [
      'Alterou',
      'Trabalhou',
      'ação',
      'Concluída',
      'Desfazer',
      'alterado',
    ]);

    await activity.getByRole('button', { name: 'Undo this run’s changes' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Undo this run’s changes?' });
    await expect(dialog).toContainText('The changed or deleted file goes back');
    await expectNoPortuguese(dialog, ['Desfazer', 'arquivo', 'Cancelar']);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await setSandbox(request, 'read-only');
    rmSync(repo, { recursive: true, force: true });
  }
});

test('approval card and message queue', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[aprovar] en');
  await input.press('Enter');
  const card = conversation(page).locator('.approval-card');
  await expect(card).toContainText('Command · confirm this action to continue');
  const runningActivity = conversation(page).getByRole('region', { name: 'Activity for this run' }).first();
  await expect(runningActivity).toContainText('Waiting for approval: Executar comando de teste');
  await expect(runningActivity).toContainText(/No update for/);
  await expectNoPortuguese(card.locator('.approval-actions, .approval-copy > span'), ['Comando', 'Negar', 'Aprovar']);

  // The run waits for the approval: what is typed now goes to the queue.
  await input.fill('[normal] queued in English');
  await input.press('Enter');
  const queue = page.getByRole('region', { name: 'Queued messages' });
  await expect(queue.getByText('Queued (1)')).toBeVisible();
  await expect(queue.getByText('Starts when the current answer finishes.')).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Edit queued message 1' })).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Remove queued message 1' })).toBeVisible();
  await expectNoPortuguese(queue.locator('.message-queue-header'), ['Na fila', 'Começa', 'resposta']);

  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(conversation(page).locator('.user-bubble', { hasText: 'queued in English' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(queue).toBeHidden();
  // Activity rows the server writes with a key (shared/event-text.ts) show in English too.
  const activity = conversation(page).getByRole('region', { name: 'Activity for this run' }).first();
  await activity.locator('summary').first().click();
  await expect(activity.getByText('Approved', { exact: true })).toBeVisible();
  await expectNoPortuguese(activity.locator('.activity-event'), ['Aprovado', 'Negado']);
});

test('shows that the model is still responding before its first token', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[espera-modelo]');
  await input.press('Enter');
  const activity = conversation(page).getByRole('region', { name: 'Activity for this run' }).last();
  await expect(activity).toContainText('Waiting for the model response');
  await expect(activity).toContainText(/No update for/);
  await expect(conversation(page).getByText('Resposta após a espera.', { exact: true }).last()).toBeVisible({
    timeout: 10_000,
  });
});

test('organizes project conversations in nested virtual folders', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-e2e-folders-')));
  try {
    const name = `Folders ${Date.now()}`;
    const created = await request.post('/api/projects', {
      data: { name, path: repo, memoryWorkspace: 'e2e', memoryProject: `folders-${Date.now()}` },
    });
    expect(created.ok()).toBe(true);
    await page.goto('/');
    await openMobileNavigation(page);
    await page.getByRole('button', { name: `New conversation in ${name}` }).click();
    await expect(page.getByRole('combobox', { name: 'Move conversation to a folder' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive conversation' })).toBeVisible();
    await expect(page.locator('.topbar').evaluate((node) => node.scrollWidth <= node.clientWidth)).resolves.toBe(true);
    await openMobileNavigation(page);
    const tree = page.getByLabel('Project folders and conversations');
    await expect(tree).toBeVisible();
    await tree.getByRole('button', { name: 'Create project folder' }).click();
    await tree.getByRole('textbox', { name: 'Folder name' }).fill('Product');
    await tree.getByRole('button', { name: 'Create folder' }).click();
    await tree.getByRole('button', { name: 'Create subfolder in Product' }).click();
    await tree.getByRole('textbox', { name: 'Folder name' }).fill('Research');
    await tree.getByRole('button', { name: 'Create folder' }).click();

    const folderSelect = page.getByRole('combobox', { name: 'Move conversation to a folder' });
    const researchId = await folderSelect.locator('option').filter({ hasText: 'Research' }).getAttribute('value');
    expect(researchId).toBeTruthy();
    await closeMobileNavigation(page);
    await folderSelect.selectOption(researchId!);
    await openMobileNavigation(page);
    await expect(tree).toContainText('Nova conversa');

    await tree.getByRole('button', { name: 'Rename Product' }).click();
    await tree.getByRole('textbox', { name: 'Rename folder' }).fill('Product area');
    await tree.getByRole('button', { name: 'Save folder name' }).click();
    await expect(tree).toContainText('Product area');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('archives a conversation and restores it from the archived list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openMobileNavigation(page);
  await page
    .getByRole('button', { name: /^New conversation/ })
    .first()
    .click();
  const input = page.getByRole('textbox', { name: 'Message to the agent' });
  await expect(input).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Move conversation to a folder' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive conversation' })).toBeVisible();
  await expect(page.locator('.topbar').evaluate((node) => node.scrollWidth <= node.clientWidth)).resolves.toBe(true);
  await input.fill('[normal] archive this');
  await input.press('Enter');
  await expect(conversation(page).getByText('Resposta E2E pronta.', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Archive conversation' }).click();
  await expect(page.getByText('This conversation is archived. Restore it to send more messages.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message to the agent' })).toBeDisabled();
  await openMobileNavigation(page);
  await page.getByRole('button', { name: /Show archived/ }).click();
  await expect(page.locator('.session-archived-icon')).toBeVisible();
  await closeMobileNavigation(page);
  await page.getByRole('button', { name: 'Restore conversation' }).click();
  await expect(page.getByText('This conversation is archived. Restore it to send more messages.')).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Message to the agent' })).toBeEnabled();
});

test('offers a visible steer action separately from queueing while a run is active', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('[lento]');
  await input.press('Enter');
  await input.fill('Siga pelo resumo da conversa');
  const steer = page.getByRole('button', { name: 'Steer now' });
  await expect(steer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to queue' })).toBeVisible();
  await steer.click();
  await expect(
    conversation(page)
      .locator('.assistant-row .markdown-content')
      .filter({ hasText: 'Orientado: Siga pelo resumo da conversa' })
      .last(),
  ).toBeVisible({
    timeout: 10_000,
  });
});

test('keeps a steer queued in its original conversation when navigation happens during enqueue', async ({
  page,
  request,
}) => {
  const other = await request.post('/api/sessions', { data: { title: 'Other conversation' } });
  expect(other.ok()).toBe(true);

  await page.goto('/');
  const createdResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/sessions'),
  );
  await page
    .getByRole('button', { name: /^New conversation/ })
    .first()
    .click();
  const current = await (await createdResponse).json();
  const input = page.getByRole('textbox', { name: 'Message to the agent' });
  await input.fill('[lento]');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible();

  let notifyEnqueueStarted!: () => void;
  const enqueueStarted = new Promise<void>((resolve) => {
    notifyEnqueueStarted = resolve;
  });
  let releaseEnqueue!: () => void;
  const holdEnqueue = new Promise<void>((resolve) => {
    releaseEnqueue = resolve;
  });
  await page.route('**/api/sessions/*/queue', async (route) => {
    if (route.request().method() === 'POST') {
      notifyEnqueueStarted();
      await holdEnqueue;
    }
    await route.continue();
  });

  const queuedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith(`/api/sessions/${current.id}/queue`),
  );
  await input.fill('Steer belongs to the first chat');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await enqueueStarted;
  await page.locator('.session-item[title="Other conversation"]').click();
  await expect(page.locator('.breadcrumbs > strong')).toHaveText('Other conversation');
  releaseEnqueue();
  expect((await queuedResponse).ok()).toBe(true);

  await expect(page.getByRole('textbox', { name: 'Message to the agent' })).toBeEnabled();
  const queueResponse = await request.get(`/api/sessions/${current.id}/queue`);
  expect(queueResponse.ok()).toBe(true);
  const queue = await queueResponse.json();
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0].content).toBe('Steer belongs to the first chat');
});

test('command palette', async ({ page }) => {
  await newConversation(page);
  await page.keyboard.press('Control+p');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  const field = palette.getByRole('combobox', { name: 'Search actions' });
  await expect(field).toHaveAttribute('placeholder', 'Action, conversation, project or command…');
  const list = palette.getByRole('listbox', { name: 'Actions' });
  await expect(list.getByRole('group', { name: 'Actions' })).toBeVisible();
  await expect(list.getByRole('group', { name: 'Mode' })).toBeVisible();
  await expect(list.getByRole('option', { name: /^Open settings/ })).toBeVisible();
  const headings = (await list.locator('.palette-group-title').allInnerTexts()).join(' | ');
  for (const word of ['Ações', 'Conversas', 'Projetos', 'Agente', 'Modo', 'Recentes'])
    expect(headings).not.toContain(word);
  await expectNoPortuguese(palette.locator('.palette-hint'), ['navegar', 'executar', 'fechar']);
  // The filter matches the English labels.
  await field.fill('toggle sidebar');
  await expect(list.getByRole('option').first()).toContainText('Toggle sidebar');
  await field.fill('zzzz-nothing');
  await expect(palette).toContainText('Nothing found for “zzzz-nothing”.');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('plan card from /plano', async ({ page }) => {
  const input = await newConversation(page);
  await input.fill('/plano exportar o relatório');
  await input.press('Enter');
  // The plan itself (title, sections, tasks) is agent output and stays in Portuguese.
  const card = conversation(page).getByRole('region', { name: 'Exportar relatório' }).last();
  await expect(card).toBeVisible();
  await expect(card.locator('.plan-status-badge')).toHaveText('Draft');
  await expect(card.getByText('0 of 2 tasks done')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Plan tasks' }).getByRole('img', { name: 'Pending' })).toHaveCount(2);
  await expect(card.getByRole('button', { name: 'Approve and run' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Run only the next task' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Skip task 1' })).toBeVisible();
  await expect(card.getByText('Requirements', { exact: true })).toBeVisible();
  await expectNoPortuguese(card.locator('.plan-card-meta, .plan-actions, .plan-section > summary, h3'), [
    'Rascunho',
    'tarefas',
    'Aprovar',
    'Executar',
    'Descartar',
    'Requisitos',
  ]);
  await card.getByRole('button', { name: 'Edit plan' }).click();
  await expect(card.locator('.plan-hint')).toContainText('Unchanged tasks keep their status.');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(card.locator('.plan-status-badge')).toHaveText('Discarded');
});
