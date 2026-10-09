import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegatedTask, RunEvent } from '../shared/contracts.js';
import { assessTaskDelivery } from '../server/coordination.js';
import { Store } from '../server/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const task = (status: DelegatedTask['status']): DelegatedTask => ({
  id: 'task-1',
  agentId: 'agent-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  runId: 'run-1',
  role: 'worker',
  title: 'Implement change',
  instructions: 'Edit a file',
  scope: ['src/a.ts'],
  dependsOn: [],
  providerId: 'codex',
  model: 'gpt-6-luna',
  effort: 'high',
  status,
  createdAt: new Date().toISOString(),
});

describe('delegated task outcomes and persistence', () => {
  it('separates clean process completion from delivery and records observed evidence/recovery', () => {
    const noImplementation = assessTaskDelivery('worker', 'completed', undefined, []);
    expect(noImplementation).toMatchObject({
      status: 'not_implemented',
      recovery: { action: 'retry' },
    });
    expect(noImplementation.evidence).toContain('process:completed');

    const toolOnly = assessTaskDelivery('worker', 'completed', undefined, [{ name: 'read_file', status: 'completed' }]);
    expect(toolOnly).toMatchObject({ status: 'unverified', recovery: { action: 'inspect' } });

    const changed = assessTaskDelivery(
      'worker',
      'completed',
      undefined,
      [{ name: 'apply_patch', status: 'completed' }],
      ['src/a.ts'],
    );
    expect(changed).toMatchObject({ status: 'implemented', recovery: { action: 'inspect' } });
    expect(changed.evidence).toContain('artifact:src/a.ts');

    const blocked = assessTaskDelivery('worker', 'failed', 'executor unavailable', []);
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'executor unavailable', recovery: { action: 'retry' } });
    expect(
      assessTaskDelivery('worker', 'cancelled', 'cancel requested', [{ name: 'write_file', status: 'completed' }]),
    ).toMatchObject({ status: 'partial', recovery: { action: 'inspect' } });
  });

  it('persists task/agent/phase and tool-event links, then marks interrupted work blocked on restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-task-results-'));
    dirs.push(dir);
    let store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'project-1',
      name: 'Project',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
    });
    store.putSession({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Session',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    });
    const pending = task('running');
    pending.toolCalls = [
      { callId: 'run-1:call-1', name: 'apply_patch', status: 'completed', recordedAt: new Date().toISOString() },
    ];
    store.putTask(pending);
    const event: RunEvent = {
      id: 'event-1',
      sessionId: pending.sessionId,
      runId: pending.runId,
      taskId: pending.id,
      agentId: pending.agentId,
      phase: pending.role,
      type: 'tool',
      text: 'Patch applied',
      toolName: 'apply_patch',
      toolCallId: 'run-1:call-1',
      status: 'completed',
      createdAt: new Date().toISOString(),
    };
    store.addEvent(event);
    store.close();

    store = new Store(dir);
    expect(store.getTask(pending.id)).toMatchObject({
      agentId: 'agent-1',
      model: 'gpt-6-luna',
      effort: 'high',
      status: 'interrupted',
      delivery: {
        status: 'blocked',
        evidence: ['process:interrupted', 'tool:apply_patch:completed'],
        recovery: { action: 'retry' },
      },
    });
    expect(store.listEvents(pending.sessionId)[0]).toMatchObject({
      taskId: 'task-1',
      agentId: 'agent-1',
      phase: 'worker',
      toolCallId: 'run-1:call-1',
    });
    store.close();
  });
});
