import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderAttemptUsageSchema, CheckSourceSchema, RunDeliveryStateSchema } from '../shared/schemas.js';
import { Store } from '../server/store.js';
import type { Run } from '../shared/contracts.js';
import { runOutcomeState } from '../src/run-activity';
import { Orchestrator } from '../server/orchestrator';
import type { ProviderInfo, ProviderRegistry } from '../shared/contracts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-run-telemetry-'));
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  store.putSession({
    id: 'session',
    projectId: null,
    title: 'test',
    providerId: 'codex',
    mode: 'auto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return store;
}

const route = { level: 'deep' as const, reason: 'test', tools: false, memory: false, contextBudget: 1000 };
function run(id: string): Run {
  return {
    id,
    sessionId: 'session',
    providerId: 'codex',
    status: 'completed',
    route,
    startedAt: new Date().toISOString(),
  };
}

describe('factual run telemetry contracts', () => {
  it('validates attempt usage and keeps unknown measurements null', () => {
    const parsed = ProviderAttemptUsageSchema.parse({
      attemptId: 'call-1',
      inputTokens: 10,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
      costUsd: null,
    });
    expect(parsed.outputTokens).toBeNull();
    expect(() => ProviderAttemptUsageSchema.parse({ ...parsed, inputTokens: -1 })).toThrow();
  });

  it('does not invent check provenance or objective fulfillment', () => {
    expect(
      CheckSourceSchema.safeParse({
        runId: 'run-1',
        state: 'unknown',
        scope: 'filesystem-except-.git-and-node_modules',
      }).success,
    ).toBe(true);
    expect(CheckSourceSchema.safeParse({ runId: 'run-1' }).success).toBe(false);
    expect(
      RunDeliveryStateSchema.parse({
        response: 'completed',
        integration: 'unknown',
        objective: 'unknown',
        recordedAt: '2026-10-13T00:00:00.000Z',
      }).objective,
    ).toBe('unknown');
  });

  it('round-trips known telemetry and leaves legacy data unknown after Store reload', () => {
    const store = setup();
    const current = {
      ...run('current'),
      providerAttempts: [
        {
          attemptId: 'provider-call-1',
          inputTokens: 11,
          outputTokens: 7,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
          costUsd: null,
        },
      ],
      checkSource: {
        runId: 'current',
        root: '/project',
        state: 'verified' as const,
        scope: 'filesystem-except-.git-and-node_modules' as const,
        revision: { kind: 'source_tree' as const, value: 'abc1234' },
      },
      delivery: {
        response: 'completed' as const,
        integration: 'applied' as const,
        objective: 'unknown' as const,
        recordedAt: '2026-10-13T00:00:00.000Z',
      },
    };
    store.putRun(current);
    store.putRun(run('legacy'));
    store.recordObservabilityEvent({
      id: 'span:provider-call-1',
      traceId: 'current',
      runId: 'current',
      sessionId: 'session',
      at: '2026-10-13T00:00:00.000Z',
      name: 'provider_call',
      component: 'provider',
      kind: 'span',
      status: 'success',
      durationMs: 21,
      attributes: { providerId: 'codex' },
    });
    const dir = store.dataDir;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reloaded = new Store(dir);
    stores.push(reloaded);
    expect(reloaded.getRun('current')).toMatchObject({
      providerAttempts: current.providerAttempts,
      checkSource: current.checkSource,
      delivery: current.delivery,
    });
    expect(runOutcomeState(reloaded.getRun('current'))).toEqual({
      response: 'completed',
      integration: 'applied',
      objective: 'unknown',
    });
    expect(runOutcomeState(reloaded.getRun('legacy'))).toEqual({
      response: 'unknown',
      integration: 'unknown',
      objective: 'unknown',
    });
    expect(reloaded.getRun('legacy')).not.toHaveProperty('delivery');
    expect(reloaded.getRun('legacy')).not.toHaveProperty('providerAttempts');
    const span = reloaded.db
      .prepare('SELECT kind,duration_ms FROM observability_events WHERE id=?')
      .get('span:provider-call-1') as { kind: string; duration_ms: number };
    expect(span).toEqual({ kind: 'span', duration_ms: 21 });
  });

  it('records provider-emitted usage for failed and successful task attempts through Store reload', async () => {
    const store = setup();
    const now = new Date().toISOString();
    const projectRoot = store.dataDir;
    store.putProject({
      id: 'project',
      name: 'telemetry',
      path: projectRoot,
      createdAt: now,
      memoryWorkspace: 'workspace',
      memoryProject: 'project',
      graphify: { enabled: false },
      orchestration: { enabled: true, maxWorkers: 1, review: false },
    });
    const session = { ...store.getSession('session')!, projectId: 'project', mode: 'deep' as const };
    store.putSession(session);
    store.setSettings({ ...store.getSettings()!, autoRetry: true });
    let taskCalls = 0;
    let providerEnteredCancel!: () => void;
    const cancelProviderEntered = new Promise<void>((resolve) => (providerEnteredCancel = resolve));
    const info: ProviderInfo = {
      id: 'codex',
      name: 'controlled',
      installed: true,
      available: true,
      status: 'ready',
      detail: '',
      models: [{ id: 'm', name: 'm', isDefault: true }],
      defaultModel: 'm',
      capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
    };
    const providers: ProviderRegistry = {
      async list() {
        return [info];
      },
      async run(input, emit, signal) {
        if (input.prompt.includes('cancel telemetry')) {
          emit({ type: 'usage', inputTokens: 9 });
          providerEnteredCancel();
          return await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          });
        }
        if (input.prompt.includes('Produza somente JSON válido')) {
          return {
            text: JSON.stringify({
              tasks: [{ id: 'worker', title: 'worker', instructions: 'do work', scope: [], dependsOn: [] }],
            }),
            stopReason: 'completed',
          };
        }
        if (input.prompt.includes('Fatos estruturados de execução'))
          return { text: 'síntese', stopReason: 'completed' };
        taskCalls++;
        emit({ type: 'usage', inputTokens: taskCalls === 1 ? 17 : 5 });
        if (taskCalls === 1) throw new Error('connection reset');
        return { text: 'feito', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers, undefined, undefined, undefined, {
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const finished = new Promise<void>((resolve) => {
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status !== 'running') resolve();
      });
    });
    const started = await orchestrator.start(session, 'implementar uma tarefa');
    await finished;
    store.putProject({
      ...store.getProject('project')!,
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const cancelSession = { ...store.getSession(session.id)!, mode: 'fast' as const };
    const cancelFinished = new Promise<void>((resolve) => {
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status !== 'running' && event.run.id !== started.runId) resolve();
      });
    });
    const cancelled = await orchestrator.start(cancelSession, 'cancel telemetry');
    await cancelProviderEntered;
    await orchestrator.cancel(session.id);
    await cancelFinished;
    expect(store.getRun(cancelled.runId)?.status).toBe('cancelled');
    expect(store.getRun(cancelled.runId)?.providerAttempts?.[0]).toMatchObject({
      inputTokens: 9,
      outputTokens: null,
      costUsd: null,
    });
    await orchestrator.shutdown();

    const task = store
      .listSessionTasks(session.id, 20)
      .find((item) => item.runId === started.runId && item.role === 'worker');
    expect(task).toBeDefined();
    expect(taskCalls).toBe(2);
    expect(task!.providerAttempts).toHaveLength(2);
    expect(task!.providerAttempts).toMatchObject([
      { inputTokens: 17, outputTokens: null, costUsd: null },
      { inputTokens: 5, outputTokens: null, costUsd: null },
    ]);
    const runBeforeReload = store.getRun(started.runId)!;
    expect(runBeforeReload.inputTokens).toBe(22);
    expect(runBeforeReload.providerAttempts?.filter((attempt) => attempt.taskId === task!.id)).toHaveLength(2);

    const dir = store.dataDir;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reloaded = new Store(dir);
    stores.push(reloaded);
    expect(reloaded.getRun(started.runId)?.inputTokens).toBe(22);
    expect(reloaded.getRun(cancelled.runId)).toMatchObject({
      status: 'cancelled',
      inputTokens: 9,
      providerAttempts: [{ inputTokens: 9, outputTokens: null, costUsd: null }],
    });
    const reloadedTask = reloaded.getTask(task!.id)!;
    expect(reloadedTask.providerAttempts?.map((attempt) => attempt.inputTokens)).toEqual([17, 5]);
    const spans = reloaded.db
      .prepare(
        "SELECT attributes FROM observability_events WHERE run_id=? AND kind='span' AND json_extract(attributes,'$.attemptId') IS NOT NULL AND json_extract(attributes,'$.taskId')=?",
      )
      .all(started.runId, task!.id) as { attributes: string }[];
    const correlated = spans.map(({ attributes }) => JSON.parse(attributes) as Record<string, string>);
    expect(correlated).toHaveLength(2);
    for (const attributes of correlated) {
      expect(attributes.taskId).toBe(task!.id);
      expect(attributes.agentId).toBe(task!.agentId);
      expect(attributes.phase).toBe('worker');
      expect(attributes.attemptId).toBeTruthy();
    }
    expect(new Set(correlated.map((attributes) => attributes.attemptId))).toEqual(
      new Set(reloadedTask.providerAttempts?.map((attempt) => attempt.attemptId)),
    );
  });
});
