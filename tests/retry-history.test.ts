import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../server/orchestrator.js';
import { Store } from '../server/store.js';
import { createLocalExecutor } from '../server/local-executor.js';
import { createExecutorWorktree, integrateExecutorWorktree, removeWorktree } from '../server/worktrees.js';
import { gitIn } from './git-fixtures.js';
import type { ProviderEvent, ProviderRegistry, Run, RunInput, RunResult, Session } from '../shared/contracts.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('retry attempt lineage', () => {
  it('rejects retry pointers whose run belongs to another session or task after Store reload', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-invalid-links-'));
    dirs.push(dataDir);
    let store = new Store(dataDir);
    const now = new Date().toISOString();
    for (const id of ['retry-link-session', 'other-retry-link-session'])
      store.putSession({
        id,
        projectId: null,
        title: id,
        providerId: 'codex',
        mode: 'fast',
        createdAt: now,
        updatedAt: now,
      });
    const makeTask = (id: string, retryRunId: string) => ({
      id,
      agentId: id,
      projectId: null,
      sessionId: 'retry-link-session',
      runId: 'source-run',
      retryRunId,
      retryStartedAt: now,
      role: 'worker' as const,
      title: id,
      instructions: 'Retry only this task.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      delivery: {
        status: 'blocked' as const,
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry task.' },
        recordedAt: now,
      },
    });
    const baseRun = (id: string, sessionId: string, retryOfTaskId: string) => ({
      id,
      sessionId,
      providerId: 'codex' as const,
      status: 'failed' as const,
      route: { level: 'fast' as const, reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      completedAt: now,
      retryOfTaskId,
    });
    store.putTask(makeTask('missing-backlink-task', 'missing-backlink-run'));
    store.putTask(makeTask('wrong-origin-task', 'wrong-origin-run'));
    store.putTask(makeTask('foreign-session-task', 'foreign-session-run'));
    store.putRun({
      ...baseRun('missing-backlink-run', 'retry-link-session', 'missing-backlink-task'),
      retryOfTaskId: undefined,
    });
    store.putRun(baseRun('wrong-origin-run', 'retry-link-session', 'some-other-task'));
    store.putRun(baseRun('foreign-session-run', 'other-retry-link-session', 'foreign-session-task'));
    for (const id of ['missing-backlink-task', 'wrong-origin-task', 'foreign-session-task'])
      expect(store.getTask(id)).not.toHaveProperty('retryRunStatus');
    store.close();

    store = new Store(dataDir);
    for (const id of ['missing-backlink-task', 'wrong-origin-task', 'foreign-session-task']) {
      expect(store.getTask(id)).not.toHaveProperty('retryRunId');
      expect(store.getTask(id)).not.toHaveProperty('retryStartedAt');
      expect(store.getTask(id)).toMatchObject({ retryHistoryState: 'none' });
    }
    store.close();
  });

  it('blocks after earlier applied integration survives a later empty retry and Store reopen', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-lineage-'));
    dirs.push(dataDir);
    let store = new Store(dataDir);
    const now = new Date().toISOString();
    const session: Session = {
      id: 'lineage-session',
      projectId: null,
      title: 'Retry lineage',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);

    const originalTask = {
      id: 'delivered-history',
      agentId: 'delivered-history-agent',
      projectId: null,
      sessionId: session.id,
      runId: 'original-run',
      role: 'worker' as const,
      title: 'Recover original task',
      instructions: 'Do this task once.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      retryRunId: 'retry-b',
      delivery: {
        status: 'blocked' as const,
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry the task.' },
        recordedAt: now,
      },
    };
    store.putTask(originalTask);
    const run = (id: string, retryOfTaskId: string, artifacts?: Run['artifacts']) =>
      store.putRun({
        id,
        sessionId: session.id,
        providerId: 'codex',
        status: 'completed',
        route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
        startedAt: now,
        retryOfTaskId,
        ...(artifacts ? { artifacts } : {}),
      });
    run('retry-a', originalTask.id);
    run('retry-b', originalTask.id, { status: 'available', files: [], capturedAt: now });
    store.putTask({
      ...originalTask,
      id: 'retry-a-delivered-child',
      agentId: 'retry-a-delivered-child-agent',
      runId: 'retry-a',
      retryRunId: undefined,
      status: 'completed',
      integration: { status: 'applied', cleanup: 'not_required', recordedAt: now },
      delivery: {
        status: 'implemented',
        reason: 'The isolated retry was physically applied.',
        evidence: ['integration:applied'],
        recovery: { action: 'inspect', reason: 'Already delivered.' },
        recordedAt: now,
      },
    });
    const unrelatedTask = {
      ...originalTask,
      id: 'unrelated-task',
      agentId: 'unrelated-task-agent',
      runId: 'unrelated-original-run',
      retryRunId: 'unrelated-retry',
    };
    store.putTask(unrelatedTask);
    run('unrelated-retry', unrelatedTask.id, { status: 'available', files: [], capturedAt: now });
    store.close();

    store = new Store(dataDir);
    expect(store.getTask(originalTask.id)).toMatchObject({
      retryRunId: 'retry-b',
      retryRunStatus: 'completed',
      retryRunDelivered: true,
    });
    expect(store.getTask(unrelatedTask.id)).toMatchObject({
      retryRunId: 'unrelated-retry',
      retryRunDelivered: false,
    });

    let providerCalls = 0;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'fixture',
            installed: true,
            available: true,
            status: 'ready',
            detail: '',
            models: [{ id: 'm', name: 'm', isDefault: true }],
            defaultModel: 'm',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(_input: RunInput, emit: (event: ProviderEvent) => void): Promise<RunResult> {
        providerCalls++;
        emit({ type: 'delta', text: 'retried' });
        return { text: 'retried', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    await expect(orchestrator.retryTask(originalTask.id)).rejects.toMatchObject({ status: 409 });
    expect(providerCalls).toBe(0);

    const finished = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status !== 'running') resolve();
      }),
    );
    const started = await orchestrator.retryTask(unrelatedTask.id);
    expect(started.runId).toBeTruthy();
    await finished;
    await orchestrator.shutdown();
    expect(providerCalls).toBeGreaterThan(0);
    store.close();
  });

  it('carries real executor worktree integration into retry lineage after reload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adelic-retry-physical-'));
    dirs.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    gitIn(repoPath, 'init', '-q', '-b', 'main');
    writeFileSync(join(repoPath, 'README.md'), 'base\n');
    gitIn(repoPath, 'add', '-A');
    gitIn(repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');

    const dataDir = join(root, 'store');
    let store = new Store(dataDir);
    const now = new Date().toISOString();
    const project = {
      id: 'physical-project',
      name: 'Physical retry fixture',
      path: repoPath,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1 as const, review: false },
    };
    store.putProject(project);
    const session: Session = {
      id: 'physical-session',
      projectId: project.id,
      title: 'Physical retry',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    const task = {
      id: 'physical-original-task',
      agentId: 'physical-original-agent',
      projectId: project.id,
      sessionId: session.id,
      runId: 'physical-original-run',
      role: 'worker' as const,
      title: 'Create delivered file',
      instructions: 'Create the file once.',
      scope: ['delivered.txt'],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      retryRunId: 'physical-retry-b',
      delivery: {
        status: 'blocked' as const,
        reason: 'The original task failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry the task.' },
        recordedAt: now,
      },
    };
    store.putTask(task);

    const worktree = await createExecutorWorktree(
      project,
      { id: 'physical-retry-a-child', title: task.title },
      dataDir,
    );
    const executor = await createLocalExecutor(worktree.path, 'workspace-write');
    try {
      await executor.call(
        'write_file',
        { path: 'delivered.txt', content: 'written by local executor\n' },
        new AbortController().signal,
      );
    } finally {
      await executor.close();
    }
    const integrated = await integrateExecutorWorktree(project, worktree);
    expect(integrated).toMatchObject({ changed: true, files: ['delivered.txt'] });
    expect(readFileSync(join(repoPath, 'delivered.txt'), 'utf8')).toBe('written by local executor\n');

    const baseRun = {
      sessionId: session.id,
      providerId: 'codex' as const,
      status: 'completed' as const,
      route: { level: 'fast' as const, reason: 'fixture', tools: true, memory: false, contextBudget: 1000 },
      startedAt: now,
    };
    store.putRun({ ...baseRun, id: 'physical-retry-a', retryOfTaskId: task.id });
    store.putTask({
      ...task,
      id: 'physical-retry-a-child',
      agentId: 'physical-retry-a-agent',
      runId: 'physical-retry-a',
      retryRunId: undefined,
      status: 'completed',
      integration: { status: 'applied', cleanup: 'not_required', recordedAt: now },
      delivery: {
        status: 'implemented',
        reason: 'The isolated executor worktree was integrated.',
        evidence: ['integration:applied'],
        recovery: { action: 'inspect', reason: 'Integration is already recorded.' },
        recordedAt: now,
      },
    });
    store.putRun({
      ...baseRun,
      id: 'physical-retry-b',
      retryOfTaskId: task.id,
      artifacts: { status: 'available', files: [], capturedAt: now },
    });
    await removeWorktree(project, worktree, dataDir);
    store.close();

    store = new Store(dataDir);
    expect(readFileSync(join(repoPath, 'delivered.txt'), 'utf8')).toBe('written by local executor\n');
    expect(store.getTask(task.id)).toMatchObject({
      retryRunId: 'physical-retry-b',
      retryRunDelivered: true,
    });
    const orchestrator = new Orchestrator(store, {} as ProviderRegistry);
    await expect(orchestrator.retryTask(task.id)).rejects.toMatchObject({ status: 409 });
    await orchestrator.shutdown();
    store.close();
  });

  it('derives applied delivery in runtime without the latest retry marker', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-no-marker-'));
    dirs.push(dataDir);
    const store = new Store(dataDir);
    const now = new Date().toISOString();
    const sessionId = 'no-marker-session';
    store.putSession({
      id: sessionId,
      projectId: null,
      title: 'Retry without marker',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const task = {
      id: 'no-marker-task',
      agentId: 'no-marker-agent',
      projectId: null,
      sessionId,
      runId: 'original',
      role: 'worker' as const,
      title: 'Already delivered',
      instructions: 'Do not repeat.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      // Deliberately no retryRunId: this models the runtime state after a failed
      // start cleared the pointer, while the earlier run's delivery was later applied.
      delivery: {
        status: 'blocked' as const,
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry task.' },
        recordedAt: now,
      },
    };
    store.putTask(task);
    store.putRun({
      id: 'no-marker-retry',
      sessionId,
      providerId: 'codex',
      status: 'completed',
      route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId: task.id,
    });
    store.putTask({
      ...task,
      id: 'no-marker-child',
      agentId: 'no-marker-child-agent',
      runId: 'no-marker-retry',
      status: 'completed',
      integration: { status: 'applied', cleanup: 'not_required', recordedAt: now },
      delivery: {
        status: 'implemented' as const,
        reason: 'Applied after the retry run.',
        evidence: ['integration:applied'],
        recovery: { action: 'inspect' as const, reason: 'Already delivered.' },
        recordedAt: now,
      },
    });

    expect(store.getTask(task.id)).toMatchObject({ retryRunDelivered: true });
    expect(store.getTask(task.id)?.retryRunStatus).toBeUndefined();
    store.close();
  });

  it('follows retry runs of associated child tasks without mixing independent tasks or sessions', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-descendant-'));
    dirs.push(dataDir);
    let store = new Store(dataDir);
    const now = new Date().toISOString();
    const sessionId = 'descendant-session';
    store.putSession({
      id: sessionId,
      projectId: null,
      title: 'Descendant retries',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    store.putSession({
      id: 'other-session',
      projectId: null,
      title: 'Independent session',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const makeTask = (id: string, runId: string, session = sessionId) => ({
      id,
      agentId: id + '-agent',
      projectId: null,
      sessionId: session,
      runId,
      role: 'worker' as const,
      title: id,
      instructions: 'Fixture task.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      delivery: {
        status: 'blocked' as const,
        reason: 'Fixture failure.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry.' },
        recordedAt: now,
      },
    });
    const baseRun = (id: string, session: string, retryOfTaskId: string) => ({
      id,
      sessionId: session,
      providerId: 'codex' as const,
      status: 'completed' as const,
      route: { level: 'fast' as const, reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId,
    });

    const root = makeTask('descendant-root', 'original');
    const child = makeTask('descendant-child', 'root-retry');
    const independent = makeTask('independent-root', 'independent-original');
    const otherSession = makeTask('other-session-root', 'other-original', 'other-session');
    store.putTask(root);
    store.putTask(child);
    store.putTask(independent);
    store.putTask(otherSession);
    store.putRun(baseRun('root-retry', sessionId, root.id));
    store.putRun({
      ...baseRun('child-retry', sessionId, child.id),
      artifacts: { status: 'available', files: [{ path: 'delivered.txt', status: 'added' }], capturedAt: now },
    });
    store.putRun({
      ...baseRun('independent-retry', sessionId, independent.id),
      artifacts: { status: 'available', files: [], capturedAt: now },
    });
    const sibling = makeTask('sibling-root', 'sibling-original');
    store.putTask(sibling);
    store.putRun(baseRun('sibling-retry', sessionId, sibling.id));
    store.putTask({
      ...makeTask('sibling-applied-child', 'sibling-retry'),
      status: 'completed',
      integration: { status: 'applied', cleanup: 'not_required', recordedAt: now },
      delivery: {
        status: 'implemented',
        reason: 'Sibling task delivery.',
        evidence: ['integration:applied'],
        recovery: { action: 'inspect', reason: 'Already delivered.' },
        recordedAt: now,
      },
    });
    store.putRun(baseRun('other-session-retry', 'other-session', otherSession.id));

    // State is deliberately seeded through Store APIs, not produced by the
    // coordinated-run executor. The assertions exercise live Store queries.
    expect(store.getTask(root.id)?.retryRunDelivered).toBe(true);
    expect(store.getTask(independent.id)?.retryRunDelivered).toBe(false);
    expect(store.getTask(sibling.id)?.retryRunDelivered).toBe(true);
    expect(store.getTask(otherSession.id)?.retryRunDelivered).toBeUndefined();
    store.close();

    store = new Store(dataDir);
    expect(store.getTask(root.id)).toMatchObject({ retryRunDelivered: true });
    expect(store.getTask(independent.id)?.retryRunDelivered).toBe(false);
    expect(store.getTask(sibling.id)?.retryRunDelivered).toBe(true);
    expect(store.getTask(otherSession.id)?.retryRunDelivered).toBeUndefined();
    store.close();
  });

  it('keeps unknown historical evidence from becoming proof of no delivery', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-unknown-'));
    dirs.push(dataDir);
    const store = new Store(dataDir);
    const now = new Date().toISOString();
    store.putSession({
      id: 'unknown-session',
      projectId: null,
      title: 'Unknown retry',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const task = {
      id: 'unknown-task',
      agentId: 'unknown-task-agent',
      projectId: null,
      sessionId: 'unknown-session',
      runId: 'original',
      role: 'worker' as const,
      title: 'Unknown task',
      instructions: 'Do not infer absence.'.padEnd(1200, 'i'),
      output: 'private large output'.repeat(500),
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      retryRunId: 'empty-latest',
      delivery: {
        status: 'blocked' as const,
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry task.' },
        recordedAt: now,
      },
    };
    store.putTask(task);
    store.putRun({
      id: 'unknown-earlier',
      sessionId: task.sessionId,
      providerId: 'codex',
      status: 'completed',
      route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId: task.id,
    });
    store.putRun({
      id: 'empty-latest',
      sessionId: task.sessionId,
      providerId: 'codex',
      status: 'running',
      route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId: task.id,
      checkpoint: { available: true, files: [] },
      artifacts: { status: 'unknown', reason: 'capture still running', files: [], truncated: true },
    });
    expect(store.getTask(task.id)).toMatchObject({ retryRunStatus: 'running' });
    expect(store.getTask(task.id)?.retryRunDelivered).toBeUndefined();
    const metadata = store.listSessionTaskMetadata(task.sessionId)[0];
    expect(metadata.retryRunStatus).toBe('running');
    expect(metadata.retryRunDelivered).toBeUndefined();
    expect(metadata.output).toBeUndefined();
    expect(metadata.instructions).toHaveLength(600);

    const positiveTask = { ...task, id: 'positive-with-unknown', retryRunId: 'positive-with-unknown-run' };
    store.putTask(positiveTask);
    store.putRun({
      id: 'positive-with-unknown-run',
      sessionId: task.sessionId,
      providerId: 'codex',
      status: 'completed',
      route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId: positiveTask.id,
      checkpoint: {
        available: true,
        files: [{ path: 'delivered.txt', status: 'added', additions: 1, deletions: 0 }],
      },
      artifacts: { status: 'unknown', reason: 'incomplete capture', files: [], truncated: true },
    });
    expect(store.getTask(positiveTask.id)?.retryRunDelivered).toBe(true);
    store.close();
  });

  it('keeps a first retry eligible and derives false only from complete known-empty sources', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-known-empty-'));
    dirs.push(dataDir);
    const store = new Store(dataDir);
    const now = new Date().toISOString();
    const sessionId = 'known-empty-session';
    store.putSession({
      id: sessionId,
      projectId: null,
      title: 'Known empty retry',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const task = {
      id: 'known-empty-task',
      agentId: 'known-empty-agent',
      projectId: null,
      sessionId,
      runId: 'original',
      role: 'worker' as const,
      title: 'First retry',
      instructions: 'Retry this task.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      retryRunId: 'known-empty-retry',
      delivery: {
        status: 'blocked' as const,
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry task.' },
        recordedAt: now,
      },
    };
    store.putTask(task);

    // No retry run is a non-applicable evidence source, not evidence against retry.
    expect(store.getTask(task.id)?.retryRunDelivered).toBeUndefined();

    store.putRun({
      id: 'known-empty-retry',
      sessionId,
      providerId: 'codex',
      status: 'completed',
      route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId: task.id,
      checkpoint: { available: true, files: [] },
      artifacts: { status: 'available', files: [], capturedAt: now },
    });
    expect(store.getTask(task.id)).toMatchObject({
      retryRunStatus: 'completed',
      retryRunDelivered: false,
    });
    expect(store.listSessionTaskMetadata(sessionId)[0]).toMatchObject({
      retryRunStatus: 'completed',
      retryRunDelivered: false,
    });

    store.putRun({
      id: 'active-empty-retry',
      sessionId,
      providerId: 'codex',
      status: 'running',
      route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
      startedAt: now,
      retryOfTaskId: task.id,
      checkpoint: { available: true, files: [] },
      artifacts: { status: 'available', files: [], capturedAt: now },
    });
    store.putTask({ ...task, retryRunId: 'active-empty-retry' });
    expect(store.getTask(task.id)).toMatchObject({ retryRunStatus: 'running' });
    expect(store.getTask(task.id)?.retryRunDelivered).toBeUndefined();
    store.close();
  });

  it('uses Store history at the real retry boundary without requiring markers', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-boundary-'));
    dirs.push(dataDir);
    const store = new Store(dataDir);
    const now = new Date().toISOString();
    const makeTask = (id: string, sessionId: string) => ({
      id,
      agentId: `${id}-agent`,
      projectId: null,
      sessionId,
      runId: `${id}-original`,
      role: 'worker' as const,
      title: id,
      instructions: 'Repeat only if safe.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      delivery: {
        status: 'blocked' as const,
        reason: 'Original task failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry this task.' },
        recordedAt: now,
      },
    });
    const addSession = (id: string) =>
      store.putSession({
        id,
        projectId: null,
        title: id,
        providerId: 'codex',
        mode: 'fast',
        createdAt: now,
        updatedAt: now,
      });
    const addRetryRun = (
      taskId: string,
      sessionId: string,
      id: string,
      artifacts?: Run['artifacts'],
      checkpoint?: Run['checkpoint'],
    ) =>
      store.putRun({
        id,
        sessionId,
        providerId: 'codex',
        status: 'completed',
        route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
        startedAt: now,
        retryOfTaskId: taskId,
        ...(artifacts ? { artifacts } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      });

    for (const id of [
      'delivered-markerless',
      'unknown-markerless',
      'failed-checkpoint',
      'legacy-checkpoint',
      'empty-markerless',
      'first-retry',
    ]) {
      addSession(`${id}-session`);
      store.putTask(makeTask(id, `${id}-session`));
    }
    addRetryRun('delivered-markerless', 'delivered-markerless-session', 'delivered-history-run');
    store.putTask({
      ...makeTask('delivered-child', 'delivered-markerless-session'),
      runId: 'delivered-history-run',
      status: 'completed',
      integration: { status: 'applied', cleanup: 'not_required', recordedAt: now },
      delivery: {
        status: 'implemented',
        reason: 'Applied by the retry.',
        evidence: ['integration:applied'],
        recovery: { action: 'inspect', reason: 'Delivered.' },
        recordedAt: now,
      },
    });
    addRetryRun('unknown-markerless', 'unknown-markerless-session', 'unknown-history-run');
    addRetryRun(
      'failed-checkpoint',
      'failed-checkpoint-session',
      'failed-checkpoint-run',
      { status: 'available', files: [], capturedAt: now },
      { available: false, captureState: 'failed', reason: 'synthetic capture failure' },
    );
    addRetryRun(
      'legacy-checkpoint',
      'legacy-checkpoint-session',
      'legacy-checkpoint-run',
      { status: 'available', files: [], capturedAt: now },
      { available: false, reason: 'historical unavailable checkpoint without classification' },
    );
    addRetryRun(
      'empty-markerless',
      'empty-markerless-session',
      'empty-history-run',
      { status: 'available', files: [], capturedAt: now },
      { available: false, captureState: 'not_applicable' },
    );

    expect(store.getTask('delivered-markerless')).toMatchObject({
      retryRunDelivered: true,
      retryHistoryState: 'delivered',
    });
    expect(store.getTask('unknown-markerless')).toMatchObject({ retryHistoryState: 'unknown' });
    expect(store.getTask('failed-checkpoint')).toMatchObject({ retryHistoryState: 'unknown' });
    expect(store.getTask('legacy-checkpoint')).toMatchObject({ retryHistoryState: 'unknown' });
    expect(store.getTask('empty-markerless')).toMatchObject({
      retryRunDelivered: false,
      retryHistoryState: 'empty',
    });
    expect(store.getTask('first-retry')).toMatchObject({ retryHistoryState: 'none' });

    let providerCalls = 0;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'deterministic',
            installed: true,
            available: true,
            status: 'ready',
            detail: '',
            models: [{ id: 'm', name: 'm', isDefault: true }],
            defaultModel: 'm',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(_input: RunInput, emit: (event: ProviderEvent) => void): Promise<RunResult> {
        providerCalls++;
        emit({ type: 'delta', text: 'deterministic result' });
        return { text: 'deterministic result', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);

    for (const id of ['delivered-markerless', 'unknown-markerless', 'failed-checkpoint', 'legacy-checkpoint']) {
      const before = store.listRuns(`${id}-session`).length;
      await expect(orchestrator.retryTask(id)).rejects.toMatchObject({ status: 409 });
      expect(store.listRuns(`${id}-session`)).toHaveLength(before);
    }
    expect(providerCalls).toBe(0);

    const emptyStarted = await orchestrator.retryTask('empty-markerless');
    expect(store.getRun(emptyStarted.runId)?.retryOfTaskId).toBe('empty-markerless');
    const firstStarted = await orchestrator.retryTask('first-retry');
    expect(store.getRun(firstStarted.runId)?.retryOfTaskId).toBe('first-retry');

    await orchestrator.shutdown();
    expect(providerCalls).toBeGreaterThan(0);
    store.close();
  });
});
