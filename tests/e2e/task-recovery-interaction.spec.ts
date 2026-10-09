import { expect, test } from './fixtures';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('recovery controls follow refreshed terminal evidence without remounting', async ({ page, request }) => {
  const projectPath = mkdtempSync(join(tmpdir(), 'adelic-e2e-recovery-interaction-'));
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

    const projectName = `Recovery interaction ${Date.now()}`;
    const projectResponse = await request.post('/api/projects', {
      data: { name: projectName, path: projectPath, memoryWorkspace: 'e2e', memoryProject: 'recovery-interaction' },
    });
    expect(projectResponse.ok()).toBe(true);
    const project = (await projectResponse.json()) as { id: string };

    await page.goto('/');
    const before = (await (await request.get('/api/bootstrap')).json()) as {
      sessions: Array<{ id: string; projectId: string | null }>;
    };
    const existingSessionIds = new Set(before.sessions.map((session) => session.id));
    await page.getByRole('button', { name: `Nova conversa em ${projectName}` }).click();
    let sessionId: string | undefined;
    await expect
      .poll(async () => {
        const bootstrap = (await (await request.get('/api/bootstrap')).json()) as {
          sessions: Array<{ id: string; projectId: string | null }>;
        };
        const created = bootstrap.sessions.filter(
          (session) => session.projectId === project.id && !existingSessionIds.has(session.id),
        );
        sessionId = created.length === 1 ? created[0].id : undefined;
        return created.length;
      })
      .toBe(1);
    expect(sessionId).toBeTruthy();

    const started = await request.post(`/api/sessions/${sessionId}/messages`, {
      data: { content: '[normal] prepare recovery interaction' },
    });
    expect(started.status()).toBe(202);
    await expect
      .poll(async () => {
        const detail = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
          runs: Array<{ status: string }>;
        };
        return detail.runs.at(-1)?.status;
      })
      .toBe('completed');

    const seededResponse = await request.post('/e2e/task-recovery/seed', {
      data: { projectId: project.id, sessionId },
    });
    expect(seededResponse.ok()).toBe(true);
    const seeded = (await seededResponse.json()) as { runId: string; siblingId: string; noChangesId: string };

    // The test fixture inserts these persisted tasks after the conversation was loaded.
    await page.reload();
    await page.getByRole('button', { name: 'Buscar conversas' }).click();
    const search = page.getByRole('textbox', { name: 'Buscar nas conversas' });
    await search.fill('prepare recovery interaction');
    const conversation = page.getByRole('listitem').filter({ hasText: 'prepare recovery interaction' });
    await expect(conversation).toBeVisible();
    await conversation.click();
    const activity = page.locator(`#run-activity-${seeded.runId}`);
    await expect(activity).toBeVisible();
    await activity.locator('summary').first().click();

    const delivered = activity.locator(`[aria-label="Recuperação da tarefa: Irmã já entregue (${seeded.siblingId})"]`);
    await expect(delivered.getByTestId('task-recovery-retry')).toHaveCount(0);

    const noChanges = activity.locator(
      `[aria-label="Recuperação da tarefa: Tarefa sem alterações (${seeded.noChangesId})"]`,
    );
    const retry = noChanges.getByTestId('task-recovery-retry');
    await expect(retry).toBeEnabled();
    // The E2E scripted provider cannot persist a complete artifact manifest. Keep the actual
    // executor run in this test, then model a terminal, complete no-change detail response at
    // the API boundary so the mounted component's positive retry transition is exercised.
    let knownEmptyRefresh = false;
    await page.route(`**/api/sessions/${sessionId}`, async (route) => {
      const response = await route.fetch();
      const detail = (await response.json()) as {
        tasks?: Array<{
          id: string;
          retryRunStatus?: string;
          retryRunDelivered?: boolean;
          retryHistoryState?: 'none' | 'empty' | 'delivered' | 'unknown';
        }>;
      };
      const retriedTask = detail.tasks?.find((task) => task.id === seeded.noChangesId);
      if (retriedTask?.retryRunStatus === 'completed') {
        retriedTask.retryRunDelivered = false;
        retriedTask.retryHistoryState = 'empty';
        knownEmptyRefresh = true;
      }
      await route.fulfill({ response, json: detail });
    });
    page.on('dialog', (dialog) => dialog.accept());
    await retry.click();

    await expect
      .poll(
        async () => {
          const task = (await (await request.get(`/api/tasks/${seeded.noChangesId}`)).json()) as {
            retryRunStatus?: string;
            retryRunDelivered?: boolean;
          };
          return { status: task.retryRunStatus, delivered: task.retryRunDelivered };
        },
        { timeout: 15_000 },
      )
      .toMatchObject({ status: 'completed' });
    const refreshedTask = (await (await request.get(`/api/tasks/${seeded.noChangesId}`)).json()) as {
      retryRunDelivered?: boolean;
    };
    // The actual backend remains conservative (unknown); the detail response above represents
    // the complete terminal no-change evidence that permits another retry.
    expect(refreshedTask.retryRunDelivered).toBeUndefined();
    await expect.poll(() => knownEmptyRefresh).toBe(true);
    // Same TaskRecovery identity, no reload: terminal false evidence removes the done/busy lock.
    await expect(retry).toBeEnabled();
    const inspect = noChanges.getByTestId('task-recovery-inspect');
    await expect(inspect).toBeEnabled();
    await inspect.click();
    await expect(noChanges.locator('details.task-recovery-inspection')).toBeVisible();

    // No project file was written by the retry, and the delivered sibling remains non-retryable.
    expect(git(['status', '--porcelain'])).toBe('');
    await expect(delivered.getByTestId('task-recovery-retry')).toHaveCount(0);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
});
