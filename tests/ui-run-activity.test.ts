import { describe, expect, it } from 'vitest';
import type { DelegatedTask, RunEvent } from '../shared/contracts';
import {
  activityForRun,
  deliveryChecks,
  activityIsVisible,
  actionNeedsDisclosure,
  checksSummary,
  commandPreview,
  runStatusLabel,
  statusLabel,
  taskOutcome,
  taskPhases,
  runOutcomeState,
  toolActionDescription,
  toolActionStatus,
} from '../src/run-activity';

const task = (id: string, runId: string): DelegatedTask => ({
  id,
  agentId: `agent-${id}`,
  runId,
  sessionId: 's',
  projectId: null,
  role: 'worker',
  title: id,
  instructions: '',
  scope: [],
  dependsOn: [],
  providerId: 'codex',
  status: 'completed',
  createdAt: '2026-10-01T00:00:00Z',
});
const event = (id: string, runId: string, type: RunEvent['type'], status?: string, text = 'npm test'): RunEvent => ({
  id,
  runId,
  sessionId: 's',
  type,
  status,
  toolName: type === 'tool' ? 'commandExecution' : undefined,
  text,
  createdAt: `2026-10-01T00:00:0${id.slice(-1)}Z`,
});

describe('conversation activity grouping', () => {
  it('keeps each turn separate and deduplicates only a running/completed lifecycle pair', () => {
    const tasks = [task('first-task', 'run-1'), task('second-task', 'run-2')];
    const events = [
      event('tool-start1', 'run-1', 'tool', 'running'),
      event('tool-end2', 'run-1', 'tool', 'completed'),
      event('tool-end3', 'run-1', 'tool', 'completed'),
      event('other-end4', 'run-2', 'tool', 'completed', 'npm test'),
      event('error-5', 'run-1', 'error', undefined, 'Falha no comando'),
    ];
    const first = activityForRun('run-1', tasks, events);
    expect(first.tasks.map((item) => item.id)).toEqual(['first-task']);
    expect(first.actions.map((item) => item.id)).toEqual(['tool-end2', 'tool-end3']);
    expect(first.errors.map((item) => item.text)).toEqual(['Falha no comando']);
    expect(activityForRun('run-2', tasks, events).actions.map((item) => item.id)).toEqual(['other-end4']);
  });

  it('keeps empty fast turns quiet while errors remain visible', () => {
    expect(activityIsVisible(activityForRun('empty', [], [event('status-1', 'empty', 'status')]))).toBe(false);
    expect(
      activityIsVisible(activityForRun('failed', [], [event('error-1', 'failed', 'error', undefined, 'Falhou')])),
    ).toBe(true);
  });

  it('surfaces final interrupted outcomes even when a turn produced no task or action', () => {
    expect(runStatusLabel('cancelled')).toBe('Cancelada');
    expect(runStatusLabel('interrupted')).toBe('Interrompida');
    expect(runStatusLabel('failed')).toBe('Falhou');
    expect(runStatusLabel('completed')).toBeNull();
    expect(activityIsVisible(activityForRun('cancelled-run', [], []))).toBe(false);
  });

  it('tracks Kiro-style lifecycle states by tool call ID without merging identical calls', () => {
    const withCall = (id: string, callId: string, state: string, text = 'npm test') =>
      ({ ...event(id, 'kiro-run', 'tool', state, text), toolCallId: callId }) as RunEvent;
    const activity = activityForRun(
      'kiro-run',
      [],
      [
        withCall('call-a1', 'child-a:call-1', 'pending'),
        withCall('call-a2', 'child-a:call-1', 'in_progress'),
        withCall('call-a3', 'child-a:call-1', 'completed', 'npm test (concluído)'),
        withCall('call-b4', 'child-a:call-2', 'completed'),
      ],
    );
    expect(activity.actions.map((item) => item.id)).toEqual(['call-a3', 'call-b4']);
    expect(activity.actions[0].text).toBe('npm test (concluído)');
    expect(statusLabel('pending')).toBe('Em andamento');
    expect(statusLabel('in_progress')).toBe('Em andamento');
  });

  it('keeps long action payloads behind their own disclosure', () => {
    expect(actionNeedsDisclosure(event('short-1', 'r', 'tool', 'completed', 'ls'))).toBe(true);
    expect(
      actionNeedsDisclosure({
        ...event('short-2', 'r', 'tool', 'completed', 'arquivo alterado'),
        toolName: 'fileChange',
      }),
    ).toBe(false);
    expect(
      actionNeedsDisclosure({ ...event('long-3', 'r', 'tool', 'completed', 'x'.repeat(161)), toolName: 'mcpToolCall' }),
    ).toBe(true);
  });

  it('previews the command itself on one line, without the runtime shell wrapper', () => {
    expect(commandPreview(`/usr/bin/bash -lc 'grep -n "routeMessage" server/router.ts'`)).toBe(
      'grep -n "routeMessage" server/router.ts',
    );
    expect(commandPreview('bash -lc "git diff --check; echo \\"ok\\""')).toBe('git diff --check; echo "ok"');
    expect(commandPreview("sh -c 'npm test\nnpm run build'")).toBe('npm test');
    expect(commandPreview('npm run typecheck')).toBe('npm run typecheck');
    expect(commandPreview(`bash -lc 'cat a' && rm -rf b`)).toBe(`bash -lc 'cat a' && rm -rf b`);
    expect(commandPreview(`bash -lc 'cat a' && echo 'x'`)).toBe(`bash -lc 'cat a' && echo 'x'`);
    expect(commandPreview(`bash -lc 'echo '\\''oi'\\'''`)).toBe(`echo 'oi'`);
    expect(commandPreview(`bash -lc "a" && echo "b"`)).toBe(`bash -lc "a" && echo "b"`);
    const long = commandPreview(`bash -lc '${'x'.repeat(400)}'`);
    expect(long).toHaveLength(240);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('MCP tool diagnostics in the UI', () => {
  it('shows only bounded, reported server/tool/state/error facts and preserves unknown values', () => {
    const runtimeFailure = {
      ...event(
        'mcp-call1',
        'r',
        'tool',
        'failed',
        'Servidor: github · Ferramenta: search_repositories · Estado: failed · Erro: HTTP 403: token=sk-12345678901234567890',
      ),
      toolName: 'mcpToolCall',
    };
    const formatted = toolActionDescription(runtimeFailure);
    expect(formatted).toContain('Servidor: github');
    expect(formatted).toContain('Ferramenta: search_repositories');
    expect(formatted).toContain('Estado reportado: failed');
    expect(formatted).toContain('Erro reportado: HTTP 403: token=sk-12345678901234567890');
    expect(formatted).not.toContain('arguments');
    expect(statusLabel('unknown')).toBe('Não informado');

    const noDiagnostics = {
      ...event(
        'mcp-call2',
        'r',
        'tool',
        'unknown',
        'Servidor: não informado · Ferramenta: não informada · Estado: não informado · Erro: não reportado',
      ),
      toolName: 'mcpToolCall',
    };
    expect(toolActionDescription(noDiagnostics)).toBe(
      'Servidor: não informado · Ferramenta: não informada · Estado reportado: não informado · Erro reportado: não reportado',
    );
    expect(statusLabel(noDiagnostics.status)).toBe('Não informado');
  });

  it('preserves factual historical lifecycle states through the activity UI status flow', () => {
    const persisted = [
      { id: 'mcp-run1', status: 'running' },
      { id: 'mcp-fail2', status: 'failed' },
      { id: 'mcp-cancel3', status: 'cancelled' },
      { id: 'mcp-done4', status: 'completed' },
      { id: 'mcp-unknown5', status: 'unknown' },
      { id: 'mcp-absent6', status: undefined },
    ].map(({ id, status }) => ({
      ...event(id, 'r', 'tool', status, id),
      toolName: 'mcpToolCall',
    }));
    const visibleActions = activityForRun('r', [], persisted).actions;

    // RunActivityPanel uses these same helpers for its activity-action-status class and label.
    expect(
      visibleActions.map((action) => ({
        persisted: action.status ?? 'absent',
        status: toolActionStatus(action),
        label: statusLabel(toolActionStatus(action)),
      })),
    ).toEqual([
      { persisted: 'running', status: 'running', label: 'Em andamento' },
      { persisted: 'failed', status: 'failed', label: 'Falhou' },
      { persisted: 'cancelled', status: 'cancelled', label: 'Cancelada' },
      { persisted: 'completed', status: 'unknown', label: 'Não informado' },
      { persisted: 'unknown', status: 'unknown', label: 'Não informado' },
      { persisted: 'absent', status: 'unknown', label: 'Não informado' },
    ]);
  });

  it('keeps historical descriptions readable and bounds malformed diagnostic text', () => {
    const legacy = { ...event('mcp-old1', 'r', 'tool', 'completed', 'mcpToolCall'), toolName: 'mcpToolCall' };
    expect(toolActionDescription(legacy)).toBe(
      'Servidor: não informado · Ferramenta: não informada · Estado reportado: não informado · Erro reportado: não reportado',
    );
    expect(toolActionStatus(legacy)).toBe('unknown');
    const malformed = { ...legacy, text: 'argumentos e resultados não são diagnósticos' };
    expect(toolActionDescription(malformed)).toContain('Servidor: não informado');
    expect(toolActionDescription(malformed)).not.toContain('argumentos e resultados');
    const longValue = 'Servidor: ' + 's'.repeat(300) + ' · Ferramenta: search · Estado: failed · Erro: denied';
    const bounded = toolActionDescription({ ...legacy, text: longValue });
    expect(bounded).toContain('s'.repeat(159) + '…');
    expect(bounded).not.toContain('s'.repeat(161));
    expect(toolActionDescription({ ...legacy, toolName: 'commandExecution', text: 'npm test' })).toBe('npm test');
  });
});

describe('project checks in the run activity', () => {
  const at = (id: string, extra: Partial<RunEvent>): RunEvent => ({
    id,
    runId: 'r',
    sessionId: 's',
    type: 'status',
    text: id,
    createdAt: `2026-10-07T00:00:0${id.length}Z`,
    ...extra,
  });
  it('separates checks and blocked commands from the other events and summarises the checks', () => {
    const events = [
      at('c1', { type: 'check', check: { name: 'a', status: 'passed' } }),
      at('c22', { type: 'check', check: { name: 'b', status: 'failed', exitCode: 1 } }),
      at('b333', { type: 'approval', status: 'blocked', text: 'Comando bloqueado pelas regras do projeto: git push' }),
      at('s4444', { type: 'approval', status: 'denied' }),
    ];
    const activity = activityForRun('r', [], events);
    expect(activity.checks.map((e) => e.id)).toEqual(['c1', 'c22']);
    expect(activity.blocked.map((e) => e.id)).toEqual(['b333']);
    expect(activity.events.map((e) => e.id)).toEqual(['s4444']);
    expect(activityIsVisible(activityForRun('r', [], [events[2]!]))).toBe(true);
    expect(checksSummary(activity.checks)).toBe('2 verificações · 1 falhou');
    expect(checksSummary([events[0]!])).toBe('1 verificação ok');
    expect(checksSummary([at('x', { type: 'check', check: { name: 'x', status: 'running' } })])).toBe(
      '1 verificação · rodando',
    );
    expect(
      checksSummary([
        at('failed-running', { type: 'check', check: { name: 'lint', status: 'failed' } }),
        at('still-running', { type: 'check', check: { name: 'typecheck', status: 'running' } }),
      ]),
    ).toBe('2 verificações · 1 falhou · 1 rodando');
    expect(checksSummary([])).toBe('');
  });
});

describe('delivery check lifecycle', () => {
  it('retains running checks without a command and counts completed results once', () => {
    const checks: RunEvent[] = [
      { ...event('check1', 'run', 'check'), check: { name: 'lint', status: 'running' } },
      { ...event('check1', 'run', 'check'), check: { name: 'lint', status: 'running', output: 'progress' } },
      { ...event('check1', 'run', 'check'), check: { name: 'lint', status: 'passed', command: 'npm run lint' } },
      { ...event('check4', 'run', 'check'), check: { name: 'lint', status: 'running' } },
    ];
    expect(deliveryChecks(checks)).toEqual([
      { name: 'lint', status: 'passed', output: 'progress', command: 'npm run lint' },
      { name: 'lint', status: 'running' },
    ]);
  });
});

describe('agent phase and task outcomes', () => {
  it('groups planned phases in stable orchestration order and classifies mixed results', () => {
    const tasks: DelegatedTask[] = [
      { ...task('review', 'r'), role: 'reviewer', status: 'completed' },
      {
        ...task('worker-blocked', 'r'),
        role: 'worker',
        status: 'blocked' as unknown as DelegatedTask['status'],
        error: 'worktree conflict',
      },
      { ...task('planner', 'r'), role: 'planner', status: 'completed' },
      {
        ...task('worker-partial', 'r'),
        role: 'worker',
        status: 'partial' as unknown as DelegatedTask['status'],
      },
    ];
    expect(taskPhases(tasks).map(({ phase, tasks: grouped }) => [phase, grouped.map(({ id }) => id)])).toEqual([
      ['planner', ['planner']],
      ['worker', ['worker-blocked', 'worker-partial']],
      ['reviewer', ['review']],
    ]);
    expect(taskOutcome('completed')).toBe('completed');
    expect(taskOutcome('blocked')).toBe('blocked');
    expect(taskOutcome('conflict')).toBe('blocked');
    expect(taskOutcome('partial')).toBe('partial');
    expect(taskOutcome('failed')).toBe('failed');
    expect(tasks[1]?.error).toContain('conflict');
  });
});

describe('run outcome facts in the UI', () => {
  it('renders typed run delivery and keeps absent legacy evidence unknown', () => {
    expect(runOutcomeState()).toEqual({ response: 'unknown', integration: 'unknown', objective: 'unknown' });
    expect(
      runOutcomeState({
        delivery: {
          response: 'completed',
          integration: 'applied',
          objective: 'partial',
          recordedAt: '2026-10-01T00:00:00Z',
        },
      }),
    ).toEqual({ response: 'completed', integration: 'applied', objective: 'partial' });
    expect(
      runOutcomeState({
        delivery: {
          response: 'completed',
          integration: 'unknown',
          objective: 'unknown',
          recordedAt: '2026-10-01T00:00:00Z',
        },
      }),
    ).toEqual({ response: 'completed', integration: 'unknown', objective: 'unknown' });
  });
});
