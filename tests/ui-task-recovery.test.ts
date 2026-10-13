import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DelegatedTask } from '../shared/contracts';
import { api } from '../src/api';
import { TaskRecovery } from '../src/components/TaskRecovery';

afterEach(() => vi.unstubAllGlobals());

const task = (overrides: Partial<DelegatedTask> = {}): DelegatedTask => ({
  id: 'pending/task',
  agentId: 'agent-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  runId: 'run-1',
  role: 'worker',
  title: 'Tarefa pendente A',
  instructions: 'fazer',
  scope: [],
  dependsOn: [],
  providerId: 'codex',
  status: 'completed',
  createdAt: new Date(0).toISOString(),
  delivery: {
    status: 'not_implemented',
    reason: 'Sem alterações entregues.',
    evidence: [],
    recovery: { action: 'retry', reason: 'Tentar novamente somente esta tarefa.' },
    recordedAt: new Date(0).toISOString(),
  },
  integration: { status: 'not_required', cleanup: 'not_required', recordedAt: new Date(0).toISOString() },
  ...overrides,
});

describe('task worktree recovery API actions', () => {
  it('posts explicit apply action and returns the backend result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ applied: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.applyTaskWorktree('task/1')).resolves.toEqual({ applied: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task%2F1/worktree',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'apply' }),
      }),
    );
  });

  it('preserves an explicit no-changes apply result instead of coercing it to applied', async () => {
    const result = {
      applied: false,
      task: { ...task(), delivery: { ...task().delivery!, status: 'not_implemented' as const } },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.applyTaskWorktree('pending/task')).resolves.toMatchObject({ applied: false });
  });

  it('posts the selected task id to its task-only retry endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: 'retry-run' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.retryTask('pending/task')).resolves.toEqual({ runId: 'retry-run' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/pending%2Ftask/retry',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }) }),
    );
  });

  it('surfaces retry conflicts without changing the task-only retry contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'Task já em execução.' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.retryTask('pending/task')).rejects.toMatchObject({ status: 409, message: 'Task já em execução.' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/pending%2Ftask/retry',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }) }),
    );
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('requests task-scoped inspection evidence instead of loading an ambiguous run output', async () => {
    const payload = {
      task: { id: 'task-a', output: 'Persisted output' },
      events: [],
      artifacts: { project: { status: 'unknown', reason: 'unverified', files: [] } },
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.inspectTask('task/a')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task%2Fa/inspect', expect.any(Object));
  });

  it('requires backend confirmation to discard and surfaces recoverable conflict errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'conflict', conflicts: ['src/a.ts'] }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.discardTaskWorktree('t')).rejects.toMatchObject({ status: 409, message: 'conflict' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t/worktree',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    );
  });
});

describe('TaskRecovery states and controls', () => {
  it('keeps a completed process distinct from a pending no-changes delivery and offers task retry', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task(),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('data-testid="task-process-status">Concluído');
    expect(html).toContain('data-testid="task-integration-status">Não necessária');
    expect(html).toContain('data-testid="task-recovery-retry"');
    expect(html).toContain('data-testid="task-recovery-inspect"');
    expect(html).toContain('Inspecionar tarefa: Tarefa pendente A (pending/task)');
    expect(html).toContain('Retomar somente a tarefa: Tarefa pendente A (pending/task)');
    expect(html).not.toContain('Reexecutar pedido completo');
  });

  it('does not offer retry after the task delivery is applied, and displays cleanup independently', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({
          delivery: {
            status: 'implemented',
            reason: 'Aplicada.',
            evidence: ['file:a'],
            recovery: { action: 'none', reason: 'Entrega concluída.' },
            recordedAt: new Date(0).toISOString(),
          },
          integration: {
            status: 'applied',
            cleanup: 'pending',
            reason: 'Integração concluída; limpeza pendente.',
            recordedAt: new Date(0).toISOString(),
          },
        }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('Aplicada ao projeto');
    expect(html).toContain('Pendente');
    expect(html).not.toContain('data-testid="task-recovery-retry"');
    expect(html).toContain('data-testid="task-recovery-inspect"');
  });

  it('keeps inspection available for a pending recover_worktree state', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({
          delivery: {
            status: 'partial',
            reason: 'Alterações aguardam inspeção no checkout isolado.',
            evidence: ['integration:pending'],
            recovery: { action: 'recover_worktree', reason: 'Inspecionar ou recuperar checkout.' },
            recordedAt: new Date(0).toISOString(),
          },
          recoveryWorktree: {
            path: '/tmp/task-a',
            branch: 'task-a',
            base: 'abc',
            createdAt: new Date(0).toISOString(),
            ownershipVerified: true,
            executionStarted: true,
          },
        }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('data-testid="task-recovery-inspect"');
    expect(html).toContain('data-testid="task-recovery-apply"');
    expect(html).toContain('task-a');
  });

  it('shows unverified recovery intent but blocks automatic apply and discard controls', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({
          recoveryWorktree: {
            path: '/private/worktrees/task-a',
            branch: 'adelic/task-a',
            base: 'abc',
            createdAt: new Date(0).toISOString(),
            ownershipVerified: false,
            preparationFailed: true,
            executionStarted: false,
            recoveryReason: 'Criação parcial; descoberta do admin excedeu o prazo.',
            recoveryEvidence: {
              intentRecorded: true,
              creation: 'unknown',
              ownership: 'unknown',
              preparation: 'incomplete',
              taskExecution: 'not_started',
            },
          },
        }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('task-recovery-unverified');
    expect(html).toContain('propriedade deste candidato é desconhecida');
    expect(html).toContain('Aplicar ou descartar está bloqueado');
    expect(html).toContain('recursos e referência foram preservados');
    expect(html).toContain('task-recovery-preparation-incomplete');
    expect(html).toContain('task-recovery-not-started');
    expect(html).toContain('Detalhe reportado: Criação parcial; descoberta do admin excedeu o prazo.');
    expect(html).toContain('criação desconhecida');
    expect(html).toContain('propriedade desconhecida');
    expect(html).toContain('preparação incompleta');
    expect(html).toContain('execução não iniciada');
    expect(html).toContain('data-testid="task-recovery-inspect"');
    expect(html).toContain('data-testid="task-recovery-retry"');
    expect(html).not.toContain('data-testid="task-recovery-apply"');
    expect(html).not.toContain('data-testid="task-recovery-discard"');
  });

  it('fails closed for legacy recovery records without an ownership proof', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({
          recoveryWorktree: {
            path: '/private/worktrees/task-a',
            branch: 'adelic/task-a',
            base: 'abc',
            createdAt: new Date(0).toISOString(),
          },
        }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('task-recovery-unverified');
    expect(html).not.toContain('data-testid="task-recovery-apply"');
    expect(html).not.toContain('data-testid="task-recovery-discard"');
  });

  it('shows incomplete preparation and permits only explicit discard for owned resources', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({
          recoveryWorktree: {
            path: '/private/worktrees/task-a',
            branch: 'adelic/task-a',
            base: 'abc',
            createdAt: new Date(0).toISOString(),
            ownershipVerified: true,
            preparationFailed: true,
            executionStarted: false,
            recoveryReason: 'Baseline não preparado; execução não iniciada.',
            recoveryEvidence: {
              intentRecorded: true,
              creation: 'confirmed',
              ownership: 'confirmed',
              preparation: 'incomplete',
              taskExecution: 'not_started',
            },
          },
        }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('task-recovery-preparation-incomplete');
    expect(html).toContain('task-recovery-evidence');
    expect(html).toContain('criação confirmada');
    expect(html).toContain('execução não iniciada');
    expect(html).toContain('data-testid="task-recovery-inspect"');
    expect(html).not.toContain('data-testid="task-recovery-apply"');
    expect(html).toContain('data-testid="task-recovery-discard"');
  });

  it('does not offer a second retry while the persisted task process is queued', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({ status: 'queued' }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('data-testid="task-process-status">Na fila');
    expect(html).not.toContain('data-testid="task-recovery-retry"');
    expect(html).toContain('data-testid="task-recovery-inspect"');
  });

  it('aligns retry visibility with persisted reservation and linked retry outcome', () => {
    const render = (overrides: Partial<DelegatedTask>) =>
      renderToStaticMarkup(
        createElement(TaskRecovery, {
          task: task(overrides),
          onRefresh: async () => undefined,
          onInspect: async () => undefined,
        }),
      );
    expect(render({ retryStartedAt: new Date(1).toISOString() })).not.toContain('data-testid="task-recovery-retry"');
    expect(render({ retryRunId: 'retry-1', retryRunStatus: 'completed', retryRunDelivered: false })).toContain(
      'data-testid="task-recovery-retry"',
    );
    expect(
      render({ retryRunId: 'retry-delivered', retryRunStatus: 'completed', retryRunDelivered: true }),
    ).not.toContain('data-testid="task-recovery-retry"');
    expect(render({ retryRunId: 'retry-failed-empty', retryRunStatus: 'failed', retryRunDelivered: false })).toContain(
      'data-testid="task-recovery-retry"',
    );
    expect(render({ retryRunId: 'retry-failed-unknown', retryRunStatus: 'failed' })).not.toContain(
      'data-testid="task-recovery-retry"',
    );
    expect(render({ retryHistoryState: 'delivered', retryRunDelivered: true })).not.toContain(
      'data-testid="task-recovery-retry"',
    );
    expect(render({ retryHistoryState: 'unknown' })).not.toContain('data-testid="task-recovery-retry"');
    expect(render({ retryHistoryState: 'empty', retryRunDelivered: false })).toContain(
      'data-testid="task-recovery-retry"',
    );
    expect(render({ retryHistoryState: 'none' })).toContain('data-testid="task-recovery-retry"');
  });

  it('gives each task action an unambiguous accessible label', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecovery, {
        task: task({
          recoveryWorktree: {
            path: '/tmp/task-a',
            branch: 'task-a',
            base: 'abc',
            createdAt: new Date(0).toISOString(),
            ownershipVerified: true,
            executionStarted: true,
          },
        }),
        onRefresh: async () => undefined,
        onInspect: async () => undefined,
      }),
    );
    expect(html).toContain('aria-label="Retomar somente a tarefa: Tarefa pendente A (pending/task)"');
    expect(html).toContain('aria-label="Integrar alterações da tarefa: Tarefa pendente A (pending/task)"');
    expect(html).toContain('aria-label="Limpar checkout da tarefa: Tarefa pendente A (pending/task)"');
  });
});
