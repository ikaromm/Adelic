import { expect, test } from './fixtures';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real SQLite recovery survives reload, preserves delivered siblings, and retries only pending work', async ({
  page,
  request,
}) => {
  const projectPath = mkdtempSync(join(tmpdir(), 'adelic-e2e-task-recovery-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', projectPath, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Adelic E2E']);
    git(['config', 'user.email', 'e2e@example.invalid']);
    writeFileSync(join(projectPath, 'README.md'), 'baseline\n');
    git(['add', 'README.md']);
    git(['commit', '-qm', 'fixture baseline']);

    const projectName = `Recovery ${Date.now()}`;
    const projectResponse = await request.post('/api/projects', {
      data: { name: projectName, path: projectPath, memoryWorkspace: 'e2e', memoryProject: 'recovery' },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as { id: string };

    await page.goto('/');
    const before = (await (await request.get('/api/bootstrap')).json()) as {
      sessions: Array<{ id: string; projectId: string | null }>;
    };
    const existingSessionIds = new Set(before.sessions.map((session) => session.id));
    await page.getByRole('button', { name: `Nova conversa em ${projectName}` }).click();
    let createdSessionId: string | undefined;
    await expect
      .poll(async () => {
        const bootstrap = (await (await request.get('/api/bootstrap')).json()) as {
          sessions: Array<{ id: string; projectId: string | null }>;
        };
        const createdSessions = bootstrap.sessions.filter(
          (session) => session.projectId === project.id && !existingSessionIds.has(session.id),
        );
        createdSessionId = createdSessions.length === 1 ? createdSessions[0].id : undefined;
        return createdSessions.length;
      })
      .toBe(1);
    const sessionId = createdSessionId;
    expect(sessionId).toBeTruthy();
    const sessionRow = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(sessionRow).toBeVisible();
    const started = await request.post(`/api/sessions/${sessionId}/messages`, {
      data: { content: '[normal] prepare recovery E2E run' },
    });
    expect(started.status()).toBe(202);
    await expect
      .poll(
        async () => {
          const detail = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
            runs: Array<{ status: string }>;
          };
          return detail.runs.at(-1)?.status;
        },
        { timeout: 10_000 },
      )
      .toBe('completed');
    const seededResponse = await request.post('/e2e/task-recovery/seed', {
      data: { projectId: project.id, sessionId },
    });
    expect(seededResponse.ok()).toBe(true);
    const seeded = (await seededResponse.json()) as {
      runId: string;
      siblingId: string;
      pendingId: string;
      noChangesId: string;
      interruptedId: string;
    };

    await page.reload();
    await page.getByRole('button', { name: 'Buscar conversas' }).click();
    const conversationSearch = page.getByRole('textbox', { name: 'Buscar nas conversas' });
    await conversationSearch.fill('prepare recovery E2E run');
    const recoveryConversation = page.getByRole('listitem').filter({ hasText: 'prepare recovery E2E run' });
    await expect(recoveryConversation).toBeVisible();
    await recoveryConversation.click();
    const activity = page.locator(`#run-activity-${seeded.runId}`);
    await expect(activity).toBeVisible();
    await activity.locator('summary').first().click();
    const interrupted = activity.locator(
      `[aria-label="Recuperação da tarefa: Conclusão antes da integração (${seeded.interruptedId})"]`,
    );
    await expect(interrupted).toBeVisible();
    await expect(interrupted.getByTestId('task-process-status')).toContainText('Concluído');
    await expect(interrupted.getByTestId('task-delivery-status')).toContainText('Resultado parcial');
    await expect(interrupted).toContainText('Inspecionar ou integrar checkout preservado.');
    const inspect = interrupted.getByTestId('task-recovery-inspect');
    await expect(inspect).toHaveAttribute('data-task-id', seeded.interruptedId);
    await inspect.click();
    const inspection = interrupted.locator('details.task-recovery-inspection');
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Evidências persistidas desta tarefa');
    await expect(inspection.locator('pre')).toContainText('Processo concluído; integração interrompida.');

    const noChanges = activity.locator(
      `[aria-label="Recuperação da tarefa: Tarefa sem alterações (${seeded.noChangesId})"]`,
    );
    await expect(noChanges.getByTestId('task-delivery-status')).toContainText('Não implementada');
    const noChangesRetry = noChanges.getByTestId('task-recovery-retry');
    await expect(noChangesRetry).toBeEnabled();
    const noChangesApply = noChanges.getByTestId('task-recovery-apply');
    await expect(noChangesApply).toBeEnabled();
    page.on('dialog', (dialog) => dialog.accept());
    await noChangesApply.click();
    await expect(noChanges).toContainText(
      'Nenhuma alteração foi integrada. A tarefa continua pendente e pode ser retomada.',
    );
    await expect(noChanges.getByTestId('task-recovery-retry')).toBeEnabled();
    const noChangesAfterApply = (await (await request.get(`/api/tasks/${seeded.noChangesId}`)).json()) as {
      delivery: { status: string };
      integration?: { status: string };
      recoveryWorktree?: unknown;
    };
    expect(noChangesAfterApply.delivery.status).toBe('not_implemented');
    expect(noChangesAfterApply.integration?.status).not.toBe('applied');
    expect(noChangesAfterApply.recoveryWorktree).toBeTruthy();

    // The preceding full-page reload fetched these states from isolated SQLite, then reopened the session.
    const reloadedActivity = page.locator(`#run-activity-${seeded.runId}`);
    await expect(reloadedActivity).toBeVisible();

    const reloadedInterrupted = reloadedActivity.locator(
      `[aria-label="Recuperação da tarefa: Conclusão antes da integração (${seeded.interruptedId})"]`,
    );
    const apply = reloadedInterrupted.getByTestId('task-recovery-apply');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(reloadedInterrupted.getByTestId('task-integration-status')).toContainText('Aplicada');
    await expect(reloadedInterrupted.getByTestId('task-cleanup-status')).toContainText('Concluída');
    await expect(reloadedInterrupted).toContainText('Alterações aplicadas e checkout removido.');
    expect(readFileSync(join(projectPath, 'recovery.txt'), 'utf8')).toContain('alteração preservada');
    const interruptedState = (await (await request.get(`/api/tasks/${seeded.interruptedId}`)).json()) as {
      status: string;
      integration?: { status: string; cleanup: string; reason: string };
      recoveryWorktree?: unknown;
    };
    expect(interruptedState).toMatchObject({
      status: 'completed',
      integration: { status: 'applied', cleanup: 'complete', reason: 'Alterações aplicadas e checkout removido.' },
    });
    expect(interruptedState.recoveryWorktree).toBeUndefined();

    const deliveredSibling = reloadedActivity.locator(
      `[aria-label="Recuperação da tarefa: Irmã já entregue (${seeded.siblingId})"]`,
    );
    await expect(deliveredSibling.getByTestId('task-integration-status')).toContainText('Aplicada ao projeto');
    await expect(deliveredSibling.getByTestId('task-cleanup-status')).toContainText('Concluída');
    const deliveredState = (await (await request.get(`/api/tasks/${seeded.siblingId}`)).json()) as {
      status: string;
      integration?: { status: string };
    };
    expect(deliveredState).toMatchObject({ status: 'completed', integration: { status: 'applied' } });
    await expect(
      reloadedActivity.locator(`[data-testid="task-recovery-retry"][data-task-id="${seeded.siblingId}"]`),
    ).toHaveCount(0);

    const retryButton = reloadedActivity.locator(
      `[data-testid="task-recovery-retry"][data-task-id="${seeded.pendingId}"]`,
    );
    await expect(retryButton).toBeEnabled();
    await retryButton.click();
    await expect
      .poll(
        async () => {
          const detail = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
            runs: Array<{ id: string; status: string }>;
          };
          return detail.runs.find((run) => run.id !== seeded.runId)?.status;
        },
        { timeout: 10_000 },
      )
      .toBe('completed');
    const detail = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
      messages: Array<{ role: string; content: string }>;
      runs: Array<{ id: string; status: string }>;
    };
    const retryMessage = detail.messages.findLast((message) => message.role === 'user');
    expect(retryMessage?.content).toContain('Tarefa pendente específica');
    expect(retryMessage?.content).toContain('Retome somente esta tarefa pendente');
    expect(retryMessage?.content).not.toContain('Irmã já entregue');
    expect(retryMessage?.content).not.toContain('Tarefa sem alterações');
    expect(detail.runs.filter((run) => run.id !== seeded.runId)).toHaveLength(1);
    await expect(
      reloadedActivity.locator(`[data-testid="task-recovery-retry"][data-task-id="${seeded.siblingId}"]`),
    ).toHaveCount(0);
    await expect(
      reloadedActivity.locator(`[data-testid="task-recovery-retry"][data-task-id="${seeded.pendingId}"]`),
    ).toHaveCount(0);
    const noChangesAfter = (await (await request.get(`/api/tasks/${seeded.noChangesId}`)).json()) as {
      delivery: { status: string };
      integration?: { status: string };
    };
    expect(noChangesAfter.delivery.status).toBe('not_implemented');
    expect(noChangesAfter.integration?.status).not.toBe('applied');

    const retriedState = (await (await request.get(`/api/tasks/${seeded.pendingId}`)).json()) as {
      retryRunId?: string;
      retryRunStatus?: string;
    };
    expect(retriedState.retryRunId).toBeTruthy();
    expect(retriedState.retryRunStatus).toBe('completed');

    // Reload again after the retry completed: the original task must no longer be retryable,
    // while inspection must include persisted events from the new retry run.
    await page.reload();
    await page.getByRole('button', { name: 'Buscar conversas' }).click();
    const postRetrySearch = page.getByRole('textbox', { name: 'Buscar nas conversas' });
    await postRetrySearch.fill('prepare recovery E2E run');
    const postRetryConversation = page.getByRole('listitem').filter({ hasText: 'prepare recovery E2E run' });
    await expect(postRetryConversation).toBeVisible();
    await postRetryConversation.click();
    const postRetryActivity = page.locator(`#run-activity-${seeded.runId}`);
    await expect(postRetryActivity).toBeVisible();
    await postRetryActivity.locator('summary').first().click();
    const postRetryTask = postRetryActivity.locator(
      `[aria-label="Recuperação da tarefa: Tarefa pendente específica (${seeded.pendingId})"]`,
    );
    await expect(postRetryTask.getByTestId('task-recovery-retry')).toHaveCount(0);
    const postRetryInspect = postRetryTask.getByTestId('task-recovery-inspect');
    await expect(postRetryInspect).toBeEnabled();
    await postRetryInspect.click();
    const postRetryInspection = postRetryTask.locator('details.task-recovery-inspection');
    await expect(postRetryInspection).toBeVisible();
    const inspectionResponse = await request.get(`/api/tasks/${seeded.pendingId}/inspect`);
    expect(inspectionResponse.ok()).toBe(true);
    const inspectedRetry = (await inspectionResponse.json()) as {
      events: Array<{ runId: string; taskId?: string }>;
    };
    expect(inspectedRetry.events.some((event) => event.runId === retriedState.retryRunId)).toBe(true);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
});
