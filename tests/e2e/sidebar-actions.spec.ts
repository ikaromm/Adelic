import { expect, test } from './fixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('gerencia conversa por menu contextual e persiste mudanças de pasta e fixação', async ({ page, request }) => {
  const projectPath = mkdtempSync(join(tmpdir(), 'adelic-e2e-sidebar-'));
  let projectId = '';
  let sessionId = '';
  let unpinnedSessionId = '';
  try {
    const projectResponse = await request.post('/api/projects', {
      data: { name: 'Projeto das conversas', path: projectPath, memoryWorkspace: 'e2e', memoryProject: 'sidebar' },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json();
    projectId = project.id;
    const folderResponse = await request.post(`/api/projects/${project.id}/folders`, {
      data: { name: 'Reuniões', parentId: null },
    });
    expect(folderResponse.ok()).toBe(true);
    const folder = await folderResponse.json();
    const unpinnedResponse = await request.post('/api/sessions', {
      data: { title: 'Sem fixação', projectId: project.id, folderId: folder.id },
    });
    expect(unpinnedResponse.ok()).toBe(true);
    const unpinned = await unpinnedResponse.json();
    unpinnedSessionId = unpinned.id;
    const sessionResponse = await request.post('/api/sessions', { data: { title: 'Rascunho de reunião' } });
    expect(sessionResponse.ok()).toBe(true);
    const session = await sessionResponse.json();
    sessionId = session.id;

    await page.goto('/');
    const row = page.locator(`[data-session-id="${session.id}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /^Ações de / }).click();
    await page.getByRole('menuitem', { name: 'Fixar' }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.pinnedAt)
      .toBeTruthy();

    await row.getByRole('button', { name: /^Ações de / }).click();
    await page.getByRole('menuitem', { name: 'Renomear' }).click();
    const title = row.getByRole('textbox', { name: 'Novo título da conversa' });
    await title.fill('Reunião com notas');
    await title.press('Enter');
    await expect(row.getByRole('button', { name: /^Reunião com notas/ })).toBeVisible();
    await expect
      .poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.title)
      .toBe('Reunião com notas');

    await row.getByRole('button', { name: /^Ações de / }).click();
    await page.getByRole('menuitem', { name: 'Mover' }).click();
    const dialog = page.getByRole('dialog', { name: 'Mover conversa' });
    await dialog.getByLabel('Projeto').selectOption(project.id);
    await dialog.getByLabel('Pasta virtual').selectOption(folder.id);
    await dialog.getByRole('button', { name: 'Mover conversa' }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => {
        const saved = (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
        return [saved.projectId, saved.folderId];
      })
      .toEqual([project.id, folder.id]);
    await page.getByRole('button', { name: 'Projeto das conversas', exact: true }).click();

    await row.getByRole('button', { name: /^Ações de / }).click();
    await page.getByRole('menuitem', { name: 'Arquivar' }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.archivedAt)
      .toBeTruthy();
    await page.getByRole('button', { name: /Mostrar arquivadas/ }).click();
    const archivedRow = page.locator(`[data-session-id="${session.id}"]`);
    await archivedRow.getByRole('button', { name: /^Ações de / }).click();
    await page.getByRole('menuitem', { name: 'Restaurar' }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.archivedAt)
      .toBeFalsy();
    await expect(archivedRow).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: 'Projeto das conversas', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Reunião com notas/ })).toBeVisible();
    await expect
      .poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.pinnedAt)
      .toBeTruthy();
    const folderRows = page
      .locator('.project-folder-node')
      .filter({ hasText: 'Reuniões' })
      .first()
      .locator('.project-folder-contents > .session-row');
    await expect(folderRows.nth(0)).toContainText('Reunião com notas');
    await expect(folderRows.nth(1)).toContainText('Sem fixação');
  } finally {
    if (unpinnedSessionId) await request.delete(`/api/sessions/${unpinnedSessionId}`).catch(() => undefined);
    if (sessionId) await request.delete(`/api/sessions/${sessionId}`).catch(() => undefined);
    if (projectId) await request.delete(`/api/projects/${projectId}`).catch(() => undefined);
    rmSync(projectPath, { recursive: true, force: true });
  }
});

test('menu é acessível, esc fecha e ações ficam bloqueadas durante execução em 390px', async ({ page, request }) => {
  const session = await (await request.post('/api/sessions', { data: { title: 'Conversa em execução' } })).json();
  await page.goto('/');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  const row = page.locator('.session-row').filter({ has: page.getByRole('button', { name: /^Conversa em execução/ }) });
  const trigger = row.getByRole('button', { name: /^Ações de / });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await row.getByRole('button', { name: /^Conversa em execução/ }).click();
  const input = page.getByRole('textbox', { name: 'Mensagem para o agente' });
  await input.fill('[lento]');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: 'Fixar' })).toBeDisabled();
  await expect(page.getByRole('menu')).toContainText('Ações indisponíveis enquanto a conversa está em execução.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expect
    .poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.activeRunId)
    .toBeTruthy();
});
