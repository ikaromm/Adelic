import { describe, expect, it } from 'vitest';
import type { Approval, Run, RunEvent } from '../shared/contracts';
import { deriveRunProgress } from '../src/components/RunProgressBanner';

const startedAt = '2026-10-08T00:00:00.000Z';
const base = Date.parse(startedAt);
const run: Run = {
  id: 'current',
  sessionId: 'session',
  providerId: 'codex',
  status: 'running',
  startedAt,
  route: { level: 'fast', reason: 'test', tools: true, memory: false, effort: 'low', contextBudget: 6000 },
};
const event = (id: string, offset: number, type: RunEvent['type'], status?: string): RunEvent => ({
  id,
  runId: run.id,
  sessionId: run.sessionId,
  type,
  status,
  text: 'npm test',
  toolName: 'commandExecution',
  toolCallId: 'same-call',
  createdAt: new Date(base + offset).toISOString(),
});
const state = (events: RunEvent[], extra = {}) =>
  deriveRunProgress({ run, events, tasks: [], approvals: [], eventsConnected: true, now: base + 50_000, ...extra });

describe('run progress across event lifecycles', () => {
  it('does not show an already completed command as still running', () => {
    expect(state([event('start', 1000, 'tool', 'running')]).phase).toBe('tool');
    expect(state([event('start', 1000, 'tool', 'running'), event('end', 2000, 'tool', 'completed')]).phase).toBe(
      'waiting',
    );
  });
  it('does not keep a historical retry after a newer tool or answer delta', () => {
    const retry = event('retry', 1000, 'retry');
    expect(state([retry]).phase).toBe('retry');
    expect(state([retry, event('completed', 2000, 'tool', 'completed')]).phase).toBe('waiting');
    expect(state([retry], { streamUpdatedAt: base + 49_000 }).phase).toBe('generating');
  });
  it('ignores an approval from an earlier run and surfaces a lost event connection', () => {
    const approval: Approval = {
      id: 'approval',
      runId: 'previous',
      sessionId: run.sessionId,
      title: 'old command',
      detail: '',
      kind: 'command',
      status: 'pending',
    };
    expect(state([], { approvals: [approval], eventsConnected: false }).phase).toBe('connection');
    expect(state([], { approvals: [{ ...approval, runId: run.id }], eventsConnected: false }).phase).toBe('approval');
  });
});
