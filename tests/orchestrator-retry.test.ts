import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../server/orchestrator.js';
import { Store } from '../server/store.js';
import { createLocalExecutor } from '../server/local-executor.js';
import type { ProviderEvent, ProviderRegistry, Run, RunInput, RunResult, Session } from '../shared/contracts.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Script = (input: RunInput, emit: (e: ProviderEvent) => void, attempt: number) => Promise<RunResult>;

function setup(
  script: Script,
  opts: {
    coordinated?: boolean;
    autoRetry?: boolean;
    defaultExecutionBudget?: { totalMs: number; finalizationReserveMs: number };
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-retry-'));
  dirs.push(dir);
  const store = new Store(dir);
  const now = new Date().toISOString();
  store.putProject({
    id: 'p',
    name: 'P',
    path: dir,
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: opts.coordinated
      ? { enabled: true, maxWorkers: 1, review: false }
      : { enabled: false, maxWorkers: 1, review: false },
  });
  if (opts.autoRetry === false) store.setSettings({ ...store.getSettings()!, autoRetry: false });
  const session: Session = {
    id: 's',
    projectId: 'p',
    title: 'T',
    providerId: 'codex',
    // Deep mode in a coordinated project goes through planner, workers and synthesis.
    mode: opts.coordinated ? 'deep' : 'fast',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const attempts = new Map<string, number>();
  const providers: ProviderRegistry = {
    async list() {
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: '',
          models: [{ id: 'm', name: 'm', isDefault: true }],
          defaultModel: 'm',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    },
    async run(input, emit) {
      const key = input.prompt.includes('Produza somente JSON válido') ? 'planner' : input.runId;
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      return script(input, emit, n);
    },
    async approve() {},
    async shutdown() {},
  };
  const orchestrator = new Orchestrator(
    store,
    providers,
    undefined,
    undefined,
    undefined,
    {
      baseDelayMs: 5,
      maxDelayMs: 20,
    },
    undefined,
    undefined,
    opts.defaultExecutionBudget,
  );
  const finished = new Promise<void>((resolve) =>
    orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.status !== 'running') resolve();
    }),
  );
  return { store, session, orchestrator, finished, attempts };
}

describe('automatic retry in the orchestrator', () => {
  it('continues a public task retry with the original absolute budget', async () => {
    const inputs: RunInput[] = [];
    const { store, session, orchestrator } = setup(
      async (input) => {
        inputs.push(input);
        return { text: 'ok', stopReason: 'completed' };
      },
      { defaultExecutionBudget: { totalMs: 30_000, finalizationReserveMs: 2_000 } },
    );
    const startedAt = new Date().toISOString();
    const first = await orchestrator.start(session, 'Original journey');
    await new Promise<void>((resolve) => {
      const unsubscribe = orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.id === first.runId && event.run.status !== 'running') {
          unsubscribe();
          resolve();
        }
      });
    });
    const source = store.getRun(first.runId)!;
    const taskId = 'budget-retry-task';
    store.putTask({
      id: taskId,
      agentId: 'budget-agent',
      projectId: 'p',
      sessionId: session.id,
      runId: source.id,
      role: 'worker',
      title: 'Recover',
      instructions: 'Continue this task.',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status: 'failed',
      createdAt: startedAt,
      completedAt: startedAt,
      delivery: {
        status: 'blocked',
        reason: 'retry',
        evidence: ['process:failed'],
        recovery: { action: 'retry', reason: 'Retry.' },
        recordedAt: startedAt,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    let retryTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      retryTerminal = resolve;
    });
    const unsubscribe = orchestrator.subscribe((event) => {
      if (
        event.type === 'run' &&
        event.run.sessionId === session.id &&
        event.run.id !== first.runId &&
        event.run.status !== 'running'
      ) {
        unsubscribe();
        retryTerminal();
      }
    });
    const retry = await orchestrator.retryTask(taskId);
    await terminal;
    const retried = store.getRun(retry.runId)!;
    const sourceInput = inputs.find((input) => input.runId === first.runId)!;
    const retryInput = inputs.find((input) => input.runId === retry.runId)!;
    expect(retried.budget?.deadlineAt).toBe(source.budget?.deadlineAt);
    expect(retryInput.budget?.deadlineAt).toBe(sourceInput.budget?.deadlineAt);
    expect(retryInput.budget?.remainingMs).toBeLessThan(sourceInput.budget?.remainingMs ?? Infinity);
    await orchestrator.shutdown();
    store.close();
  });
  it('refuses an expired task continuation instead of minting a default budget', async () => {
    const { store, session, orchestrator } = setup(async () => ({ text: 'ok', stopReason: 'completed' }), {
      defaultExecutionBudget: { totalMs: 30_000, finalizationReserveMs: 2_000 },
    });
    const first = await orchestrator.start(session, 'Original journey');
    await new Promise<void>((resolve) => {
      const unsubscribe = orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.id === first.runId && event.run.status !== 'running') {
          unsubscribe();
          resolve();
        }
      });
    });
    const source = store.getRun(first.runId)!;
    store.putRun({ ...source, budget: { ...source.budget!, deadlineAt: new Date(Date.now() - 1).toISOString() } });
    const now = new Date().toISOString();
    const taskId = 'expired-budget-task';
    store.putTask({
      id: taskId,
      agentId: 'expired-agent',
      projectId: 'p',
      sessionId: session.id,
      runId: source.id,
      role: 'worker',
      title: 'Recover',
      instructions: 'Continue this task.',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status: 'failed',
      createdAt: now,
      completedAt: now,
      delivery: {
        status: 'blocked',
        reason: 'retry',
        evidence: ['process:failed'],
        recovery: { action: 'retry', reason: 'Retry.' },
        recordedAt: now,
      },
    });
    const count = store.listRuns(session.id).length;
    await expect(orchestrator.retryTask(taskId)).rejects.toMatchObject({ status: 409 });
    expect(store.listRuns(session.id)).toHaveLength(count);
    expect(store.getTask(taskId)?.retryRunId).toBeUndefined();
    await orchestrator.shutdown();
    store.close();
  });

  it('does not mint a default budget when retrying a legacy run, and refuses an expired inherited deadline', async () => {
    const noBudget = setup(async () => ({ text: 'ok', stopReason: 'completed' }), {
      defaultExecutionBudget: { totalMs: 30_000, finalizationReserveMs: 3_000 },
    });
    const origin = await noBudget.orchestrator.start(noBudget.session, 'Legacy request', undefined, [], {
      continuation: true,
    });
    await noBudget.finished;
    expect(noBudget.store.getRun(origin.runId)?.budget).toBeUndefined();
    const retry = await noBudget.orchestrator.retryRun(origin.runId);
    expect(noBudget.store.getRun(retry.runId)?.budget).toBeUndefined();
    await noBudget.orchestrator.shutdown();
    noBudget.store.close();

    const expired = setup(async () => ({ text: 'ok', stopReason: 'completed' }), {
      defaultExecutionBudget: { totalMs: 30_000, finalizationReserveMs: 3_000 },
    });
    const budgeted = await expired.orchestrator.start(expired.session, 'Budgeted request');
    await expired.finished;
    const source = expired.store.getRun(budgeted.runId)!;
    expired.store.putRun({
      ...source,
      budget: { ...source.budget!, deadlineAt: new Date(Date.now() - 1).toISOString() },
    });
    const count = expired.store.listRuns(expired.session.id).length;
    await expect(expired.orchestrator.retryRun(budgeted.runId)).rejects.toMatchObject({ status: 409 });
    expect(expired.store.listRuns(expired.session.id)).toHaveLength(count);
    await expired.orchestrator.shutdown();
    expired.store.close();
  });

  it('keeps unbudgeted plan tasks as continuations, including automatic next tasks', async () => {
    const { store, session, orchestrator } = setup(async () => ({ text: 'ok', stopReason: 'completed' }), {
      defaultExecutionBudget: { totalMs: 30_000, finalizationReserveMs: 3_000 },
    });
    const now = new Date().toISOString();
    store.putPlan({
      id: 'legacy-plan',
      sessionId: session.id,
      runId: 'legacy-planning-run',
      title: 'Legacy plan',
      status: 'approved',
      requirements: '',
      design: '',
      tasks: [
        { id: 'task-1', text: 'First', status: 'pending' },
        { id: 'task-2', text: 'Second', status: 'pending' },
      ],
      markdown: '## Tarefas\\n- [ ] First\\n- [ ] Second',
      createdAt: now,
      updatedAt: now,
    });
    await orchestrator.plans.approve('legacy-plan', 'all');
    const deadline = Date.now() + 2_000;
    while (store.listRuns(session.id).filter((run) => run.status !== 'running').length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const taskRuns = store.listRuns(session.id);
    expect(taskRuns).toHaveLength(2);
    expect(taskRuns.every((run) => run.budget === undefined)).toBe(true);
    expect(taskRuns.every((run) => run.plan?.kind === 'task')).toBe(true);
    await orchestrator.shutdown();
    store.close();
  });

  it('retries a direct run that timed out before answering, and records it', async () => {
    const { store, session, orchestrator, finished } = setup(async (_input, emit, attempt) => {
      if (attempt < 3) throw new Error('Kiro stream failed: The operation timed out.');
      emit({ type: 'delta', text: 'ok' });
      return { text: 'ok', stopReason: 'completed' };
    });
    await orchestrator.start(session, 'Quanto é 2+2?');
    await finished;
    const run = store.listRuns('s')[0];
    expect(run).toMatchObject({ status: 'completed', retries: 2 });
    expect(store.listMessages('s').at(-1)?.content).toBe('ok');
    const retries = store.listEvents('s').filter((e) => e.type === 'retry');
    expect(retries.map((e) => [e.attempt, e.of])).toEqual([
      [2, 3],
      [3, 3],
    ]);
    expect(retries[0].text).toMatch(/tempo esgotado; tentando de novo \(2\/3\)/);
    await orchestrator.shutdown();
    store.close();
  });

  it('does not repeat a run that already showed text, and marks it retryable for the user', async () => {
    const { store, session, orchestrator, finished, attempts } = setup(async (_input, emit) => {
      emit({ type: 'delta', text: 'parcial…' });
      throw new Error('stream failed');
    });
    await orchestrator.start(session, 'Explique');
    await finished;
    const run = store.listRuns('s')[0];
    expect(run.status).toBe('failed');
    expect(run.retries ?? 0).toBe(0);
    expect(run.failure).toMatchObject({
      kind: 'transient',
      retryable: true,
      why: expect.stringMatching(/texto já exibido/),
    });
    expect([...attempts.values()]).toEqual([1]);
    await orchestrator.shutdown();
    store.close();
  });

  it('never retries permanent errors, and respects the setting', async () => {
    const auth = setup(async () => {
      throw new Error('401 Unauthorized');
    });
    await auth.orchestrator.start(auth.session, 'Oi');
    await auth.finished;
    expect(auth.store.listRuns('s')[0].failure).toMatchObject({ kind: 'permanent', retryable: false });
    expect([...auth.attempts.values()]).toEqual([1]);
    await auth.orchestrator.shutdown();
    auth.store.close();

    const off = setup(
      async () => {
        throw new Error('timed out');
      },
      { autoRetry: false },
    );
    await off.orchestrator.start(off.session, 'Oi');
    await off.finished;
    expect([...off.attempts.values()]).toEqual([1]);
    expect(off.store.listRuns('s')[0].failure).toMatchObject({ kind: 'transient', retryable: true });
    await off.orchestrator.shutdown();
    off.store.close();
  });

  it('retries a delegated task (planner) without losing the coordinated run', async () => {
    const { store, session, orchestrator, finished, attempts } = setup(
      async (input, emit, attempt) => {
        if (input.prompt.includes('Produza somente JSON válido')) {
          if (attempt === 1) throw new Error('Selected model is at capacity. Please try a different model.');
          return {
            text: JSON.stringify({
              tasks: [{ id: 't1', title: 'Fazer', instructions: 'x', scope: [], dependsOn: [] }],
            }),
            stopReason: 'completed',
          };
        }
        if (input.prompt.includes('Responda ao pedido completo')) {
          emit({ type: 'delta', text: 'Pronto' });
          return { text: 'Pronto', stopReason: 'completed' };
        }
        return { text: 'feito', stopReason: 'completed' };
      },
      { coordinated: true },
    );
    await orchestrator.start(session, 'Implemente um endpoint para esta aplicação');
    await finished;
    expect(attempts.get('planner')).toBe(2);
    expect(store.listRuns('s')[0]).toMatchObject({ status: 'completed', retries: 1 });
    expect(store.listEvents('s').find((e) => e.type === 'retry')?.text).toMatch(
      /Planejar execução: modelo sobrecarregado/,
    );
    await orchestrator.shutdown();
    store.close();
  });

  it('dispatches distinct executor tasks from a safely repaired truncated planner response', async () => {
    const planned = {
      tasks: [
        {
          id: 'coordination',
          title: 'Planejamento e delegação',
          instructions: 'Corrija o fluxo de planejamento e delegação.',
          scope: ['server/coordination.ts'],
          dependsOn: [],
        },
        {
          id: 'tests',
          title: 'Testes do planejamento',
          instructions: 'Adicione testes da delegação pelo fluxo real.',
          scope: ['tests/coordination.test.ts'],
          dependsOn: [],
        },
      ],
    };
    const incomplete = JSON.stringify(planned).slice(0, -2);
    const { store, session, orchestrator, finished } = setup(
      async (input, emit) => {
        if (input.prompt.includes('Produza somente JSON válido')) {
          expect(input.prompt).toMatch(/1 a 6 tarefas/);
          return { text: incomplete, stopReason: 'completed' };
        }
        if (input.prompt.includes('Responda ao pedido completo')) {
          emit({ type: 'delta', text: 'Concluído' });
          return { text: 'Concluído', stopReason: 'completed' };
        }
        return { text: 'Implementado', stopReason: 'completed' };
      },
      { coordinated: true },
    );
    await orchestrator.start(
      session,
      'Implemente melhorias em coordenação e cobertura de testes como frentes distintas.',
    );
    await finished;
    const tasks = store.listSessionTasks(session.id).filter((task) => task.role === 'worker');
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.title).sort()).toEqual(['Planejamento e delegação', 'Testes do planejamento']);
    expect(Object.fromEntries(tasks.map((task) => [task.title, task.scope]))).toEqual({
      'Planejamento e delegação': ['server/coordination.ts'],
      'Testes do planejamento': ['tests/coordination.test.ts'],
    });
    expect(store.listRuns(session.id)[0].status).toBe('completed');
    await orchestrator.shutdown();
    store.close();
  });

  it('blocks a duplicate when a real Git checkpoint proves delivery despite unknown artifact capture', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-git-'));
    dirs.push(dataDir);
    const projectPath = join(dataDir, 'repo');
    mkdirSync(projectPath);
    execFileSync('git', ['init', '-q'], { cwd: projectPath });
    writeFileSync(join(projectPath, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: projectPath });
    execFileSync(
      'git',
      ['-c', 'user.name=Adelic Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'],
      { cwd: projectPath },
    );

    const store = new Store(join(dataDir, 'store'));
    const now = new Date().toISOString();
    store.setSettings({ ...store.getSettings()!, sandbox: 'workspace-write' });
    store.putProject({
      id: 'git-project',
      name: 'Git project',
      path: projectPath,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const session: Session = {
      id: 'git-session',
      projectId: 'git-project',
      title: 'Git retry',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    store.putTask({
      id: 'git-task',
      agentId: 'git-agent',
      projectId: 'git-project',
      sessionId: session.id,
      runId: 'original-run',
      role: 'worker',
      title: 'Create file',
      instructions: 'Create one file.',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status: 'failed',
      createdAt: now,
      completedAt: now,
      delivery: {
        status: 'blocked',
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry', reason: 'Retry this task.' },
        recordedAt: now,
      },
    });
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'Deterministic local executor fixture',
            installed: true,
            available: true,
            status: 'ready',
            detail: '',
            models: [{ id: 'm', name: 'm', isDefault: true }],
            defaultModel: 'm',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input) {
        const executor = await createLocalExecutor(input.cwd, 'workspace-write');
        try {
          const result = await executor.call(
            'write_file',
            { path: 'delivered.txt', content: 'delivered' },
            new AbortController().signal,
          );
          expect(result).toMatchObject({ bytesWritten: 9 });
        } finally {
          await executor.close();
        }
        return { text: 'File delivered.', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const finished = new Promise<void>((resolve) => {
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status !== 'running') resolve();
      });
    });
    const started = await orchestrator.retryTask('git-task');
    await finished;
    const deliveredRun = store.getRun(started.runId)!;
    expect(deliveredRun.checkpoint).toMatchObject({
      available: true,
      files: [expect.objectContaining({ path: 'delivered.txt', status: 'added' })],
    });
    store.putRun({
      ...deliveredRun,
      artifacts: { status: 'unknown', reason: 'fixture: incomplete capture', files: [], capturedAt: now },
    });
    expect(store.getTask('git-task')?.retryRunDelivered).toBe(true);
    await expect(orchestrator.retryTask('git-task')).rejects.toMatchObject({ status: 409 });

    await orchestrator.shutdown();
    store.close();
  });

  it('blocks another retry when the real local executor delivered a large file but capture is unknown', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-large-'));
    dirs.push(dataDir);
    const projectPath = join(dataDir, 'project');
    mkdirSync(projectPath);
    const store = new Store(join(dataDir, 'store'));
    const now = new Date().toISOString();
    store.setSettings({ ...store.getSettings()!, sandbox: 'workspace-write' });
    store.putProject({
      id: 'large-project',
      name: 'Large project',
      path: projectPath,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const session: Session = {
      id: 'large-session',
      projectId: 'large-project',
      title: 'Large retry',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    store.putTask({
      id: 'large-task',
      agentId: 'large-agent',
      projectId: 'large-project',
      sessionId: session.id,
      runId: 'original-run',
      role: 'worker',
      title: 'Create large file',
      instructions: 'Create the requested file once.',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status: 'failed',
      createdAt: now,
      completedAt: now,
      delivery: {
        status: 'blocked',
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry', reason: 'Retry this task.' },
        recordedAt: now,
      },
    });
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'Deterministic local executor fixture',
            installed: true,
            available: true,
            status: 'ready',
            detail: '',
            models: [{ id: 'm', name: 'm', isDefault: true }],
            defaultModel: 'm',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, _emit) {
        const executor = await createLocalExecutor(input.cwd, 'workspace-write');
        try {
          const written = await executor.call(
            'exec',
            { command: "python3 -c \"open('large-file.bin', 'wb').write(b'x' * 2097153)\"" },
            new AbortController().signal,
          );
          expect(written).toMatchObject({ exitCode: 0 });
        } finally {
          await executor.close();
        }
        return { text: 'File created.', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers, undefined, undefined, undefined, {
      baseDelayMs: 5,
      maxDelayMs: 20,
    });
    const finished = new Promise<void>((resolve) => {
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status !== 'running') resolve();
      });
    });
    const started = await orchestrator.retryTask('large-task');
    await finished;

    expect(statSync(join(projectPath, 'large-file.bin')).size).toBe(2_097_153);
    const retryRun = store.getRun(started.runId)!;
    expect(retryRun).toMatchObject({ status: 'completed', artifacts: { status: 'unknown' } });
    expect(store.getTask('large-task')?.retryRunDelivered).toBeUndefined();
    await expect(orchestrator.retryTask('large-task')).rejects.toMatchObject({ status: 409 });

    await orchestrator.shutdown();
    const persistedDataDir = store.dataDir;
    store.close();
    const reloaded = new Store(persistedDataDir);
    const reloadedOrchestrator = new Orchestrator(reloaded, {} as ProviderRegistry);
    expect(reloaded.getTask('large-task')?.retryRunDelivered).toBeUndefined();
    await expect(reloadedOrchestrator.retryTask('large-task')).rejects.toMatchObject({ status: 409 });
    await reloadedOrchestrator.shutdown();
    reloaded.close();
  });

  it('restores the last retry marker when a later start fails before persisting a run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adelic-retry-start-failure-'));
    dirs.push(dataDir);
    const store = new Store(join(dataDir, 'store'));
    const now = new Date().toISOString();
    const session: Session = {
      id: 'start-failure-session',
      projectId: null,
      title: 'Start failure',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
      activeRunId: 'busy-run',
    };
    store.putSession(session);
    const task = {
      id: 'start-failure-task',
      agentId: 'start-failure-agent',
      projectId: null,
      sessionId: session.id,
      runId: 'original-run',
      role: 'worker' as const,
      title: 'Recover task',
      instructions: 'Create a file once.',
      scope: [],
      dependsOn: [],
      providerId: 'codex' as const,
      status: 'failed' as const,
      createdAt: now,
      completedAt: now,
      retryRunId: 'retry-b',
      retryStartedAt: now,
      delivery: {
        status: 'blocked' as const,
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry' as const, reason: 'Retry task.' },
        recordedAt: now,
      },
    };
    store.putTask(task);
    const retryRun = (id: string, artifacts?: Run['artifacts']) =>
      store.putRun({
        id,
        sessionId: session.id,
        providerId: 'codex',
        status: 'completed',
        route: { level: 'fast', reason: 'fixture', tools: false, memory: false, contextBudget: 0 },
        startedAt: now,
        retryOfTaskId: task.id,
        ...(artifacts ? { artifacts } : {}),
      });
    retryRun('retry-a', { status: 'available', files: [], capturedAt: now });
    retryRun('retry-b', { status: 'available', files: [], capturedAt: now });

    let providerCalls = 0;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'No-model-call fixture',
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
      async run() {
        providerCalls++;
        return { text: 'unexpected', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    await expect(orchestrator.retryTask(task.id)).rejects.toMatchObject({ status: 409 });
    expect(store.getTask(task.id)).toMatchObject({ retryRunId: 'retry-b', retryRunDelivered: false });
    expect(store.getRun('retry-a')).toBeDefined();
    expect(store.getRun('retry-b')).toBeDefined();

    // Simulate the preserved checkout being applied after the failed start. The
    // executor writes it; persisted evidence for A changes from empty to delivered.
    const checkout = join(dataDir, 'preserved-checkout');
    mkdirSync(checkout);
    const executor = await createLocalExecutor(checkout, 'workspace-write');
    try {
      await executor.call(
        'write_file',
        {
          path: 'delivered.txt',
          content: 'applied later',
        },
        new AbortController().signal,
      );
    } finally {
      await executor.close();
    }
    const changed = {
      status: 'available' as const,
      files: [{ path: 'delivered.txt', status: 'added' as const }],
      capturedAt: new Date().toISOString(),
    };
    retryRun('retry-a', changed);

    const idle = store.getSession(session.id)!;
    delete idle.activeRunId;
    store.putSession(idle);
    expect(store.getTask(task.id)).toMatchObject({ retryRunId: 'retry-b', retryRunDelivered: true });
    await expect(orchestrator.retryTask(task.id)).rejects.toMatchObject({ status: 409 });
    expect(providerCalls).toBe(0);
    await orchestrator.shutdown();
    store.close();
  });

  it('blocks retrying a coordinated origin after a produced child retry delivers through the executor', async () => {
    const { store, session, orchestrator, attempts } = setup(
      async (input, emit) => {
        if (input.prompt.includes('Produza somente JSON válido')) {
          return {
            text: JSON.stringify({
              tasks: [
                {
                  id: 'child',
                  title: 'Create requested file',
                  instructions: 'Create delivered-child.txt once.',
                  scope: ['delivered-child.txt'],
                  dependsOn: [],
                },
              ],
            }),
            stopReason: 'completed',
          };
        }
        if (input.prompt.includes('Responda ao pedido completo')) {
          emit({ type: 'delta', text: 'Coordinated retry finished.' });
          return { text: 'Coordinated retry finished.', stopReason: 'completed' };
        }
        if (!input.runId.includes(':') && input.prompt.includes('Retome somente esta tarefa pendente')) {
          const executor = await createLocalExecutor(input.cwd, 'workspace-write');
          try {
            await executor.call(
              'write_file',
              {
                path: 'delivered-child.txt',
                content: 'delivered by child retry',
              },
              new AbortController().signal,
            );
          } finally {
            await executor.close();
          }
          return { text: 'Created by local executor.', stopReason: 'completed' };
        }
        if (input.runId.includes(':')) throw new Error('Initial child worker failed before delivery.');
        return { text: 'No changes in the initial worker attempt.', stopReason: 'completed' };
      },
      { coordinated: true },
    );
    store.setSettings({ ...store.getSettings()!, sandbox: 'workspace-write' });
    store.putTask({
      id: 'coordinated-origin',
      agentId: 'coordinated-origin-agent',
      projectId: 'p',
      sessionId: session.id,
      runId: 'original-run',
      role: 'worker',
      title: 'Recover coordinated work',
      instructions: 'Create one requested file.',
      scope: ['delivered-child.txt'],
      dependsOn: [],
      providerId: 'codex',
      status: 'failed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      delivery: {
        status: 'blocked',
        reason: 'Original attempt failed.',
        evidence: ['process:failed'],
        recovery: { action: 'retry', reason: 'Retry this task.' },
        recordedAt: new Date().toISOString(),
      },
    });

    const originRun = await orchestrator.retryTask('coordinated-origin');
    const waitForRun = (runId: string) =>
      new Promise<void>((resolve) => {
        const unsubscribe = orchestrator.subscribe((event) => {
          if (event.type === 'run' && event.run.id === runId && event.run.status !== 'running') {
            unsubscribe();
            resolve();
          }
        });
      });
    await waitForRun(originRun.runId);
    const child = store
      .listSessionTasks(session.id)
      .find((task) => task.runId === originRun.runId && task.role === 'worker');
    expect(child).toMatchObject({ status: 'failed', delivery: { status: 'blocked' } });
    // Retrying one failed child is intentionally task-local; it executes its retained
    // instructions directly rather than creating a new parent plan.
    expect(attempts.has('planner')).toBe(false);

    // Retrying a child is task-local. Force this follow-up through the direct fast
    // route; the child itself was created by the real coordinated Orchestrator flow.
    const latestSession = store.getSession(session.id)!;
    latestSession.mode = 'fast';
    store.putSession(latestSession);
    const project = store.getProject('p')!;
    project.orchestration = { enabled: false, maxWorkers: 1, review: false };
    store.putProject(project);
    const childRun = await orchestrator.retryTask(child!.id);
    await waitForRun(childRun.runId);
    const projectPath = store.getProject(session.projectId!)!.path;
    expect(statSync(join(projectPath, 'delivered-child.txt')).size).toBeGreaterThan(0);

    expect(store.getTask('coordinated-origin')).toMatchObject({ retryRunId: originRun.runId, retryRunDelivered: true });
    await expect(orchestrator.retryTask('coordinated-origin')).rejects.toMatchObject({ status: 409 });
    await orchestrator.shutdown();
    store.close();
  });
});
