import { describe, expect, it } from 'vitest';
import type { DelegatedTask, RunEvent } from '../shared/contracts';
import {
  activityForRun,
  activityIsVisible,
  actionNeedsDisclosure,
  commandPreview,
  runStatusLabel,
  statusLabel,
} from '../src/run-activity';

const task = (id: string, runId: string): DelegatedTask => ({
  id,
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
