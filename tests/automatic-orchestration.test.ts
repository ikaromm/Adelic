import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../server/orchestrator';
import { Store } from '../server/store';
import type { ProviderInfo, ProviderRegistry, RunInput, Session } from '../shared/contracts';
import { gitIn } from './git-fixtures';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

function provider(id: 'codex' | 'kiro' | 'claude'): ProviderInfo {
  return {
    id,
    name: id,
    installed: true,
    available: true,
    status: 'ready',
    detail: 'fixture',
    models: [
      {
        id: 'model',
        name: 'Model',
        efforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        isDefault: true,
      },
    ],
    defaultModel: 'model',
    capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
  };
}

function setup(options: {
  worker?: 'codex' | 'kiro' | 'claude';
  reviewer?: 'codex' | 'kiro' | 'claude';
  review?: boolean;
  toolEvent?: boolean;
  artifactChange?: boolean;
  largeArtifact?: boolean;
  gitProject?: boolean;
  parallelTasks?: boolean;
  dirtyProject?: boolean;
  integrationConflict?: boolean;
  realExecutor?: boolean;
  noGitSerialExecutor?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'adelic-auto-coordination-'));
  const projectRoot = join(directory, 'project-root');
  mkdirSync(projectRoot);
  if (options.gitProject) {
    writeFileSync(join(projectRoot, 'README.md'), 'base\\n');
    gitIn(projectRoot, 'init', '-q', '-b', 'main');
    gitIn(projectRoot, 'add', '-A');
    gitIn(projectRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
    if (options.dirtyProject) writeFileSync(join(projectRoot, 'user-work.txt'), 'preservar\\n');
  }
  const store = new Store(directory);
  const now = new Date().toISOString();
  store.putProject({
    id: 'project',
    name: 'Project',
    path: projectRoot,
    createdAt: now,
    memoryWorkspace: 'workspace',
    memoryProject: 'project',
    graphify: { enabled: false },
    orchestration: {
      enabled: true,
      maxWorkers: options.parallelTasks ? 2 : 1,
      review: options.review ?? false,
      ...(options.worker ? { workerProviderId: options.worker } : {}),
      ...(options.reviewer ? { reviewerProviderId: options.reviewer } : {}),
    },
  });
  const session: Session = {
    id: 'session',
    projectId: 'project',
    title: 'Test',
    providerId: 'codex',
    mode: 'deep',
    approvalMode: 'automatic',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  store.setSettings({
    ...store.getSettings()!,
    approvalMode: 'manual',
    ...(options.artifactChange || options.realExecutor || options.noGitSerialExecutor
      ? { sandbox: 'workspace-write' as const }
      : {}),
  });
  const inputs: RunInput[] = [];
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let isolatedArrivals = 0;
  let releaseIsolated!: () => void;
  const bothIsolated = new Promise<void>((resolve) => (releaseIsolated = resolve));
  const providers: ProviderRegistry = {
    async list() {
      return [provider('codex'), provider('kiro'), provider('claude')];
    },
    async run(input, emit) {
      calls++;
      inputs.push(input);
      if (input.prompt.includes('Produza somente JSON válido')) {
        return {
          text: JSON.stringify({
            tasks: options.parallelTasks
              ? [
                  { id: 'one', title: 'Task A', instructions: 'Create task-a.txt', scope: [], dependsOn: [] },
                  { id: 'two', title: 'Task B', instructions: 'Create task-b.txt', scope: [], dependsOn: [] },
                ]
              : [{ id: 'one', title: 'Task', instructions: 'Inspect the project', scope: [], dependsOn: [] }],
          }),
          stopReason: 'completed',
        };
      }
      if (input.prompt.includes('Você é um executor delegado') && options.noGitSerialExecutor) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const taskName = /Task ([AB])/.exec(input.prompt)?.[1];
        if (!taskName || !input.remote) throw new Error('Ferramenta real indisponível para fallback serial.');
        expect(input.cwd).toBe(projectRoot);
        await expect(
          input.remote.call('write_file', { path: '../outside.txt', content: 'fora' }, new AbortController().signal),
        ).rejects.toThrow(/path escapes project root/);
        const filename = options.largeArtifact
          ? `large-task-${taskName.toLowerCase()}.bin`
          : `task-${taskName.toLowerCase()}.txt`;
        const content = options.largeArtifact
          ? Buffer.alloc(2_097_153, taskName === 'A' ? 0x61 : 0x62).toString()
          : 'authorized serial\\n';
        if (options.largeArtifact) {
          const byte = taskName === 'A' ? 'a' : 'b';
          await input.remote.call(
            'exec',
            { command: `python3 -c "from pathlib import Path; Path('${filename}').write_bytes(b'${byte}' * 2097153)"` },
            new AbortController().signal,
          );
        } else {
          await input.remote.call('write_file', { path: filename, content }, new AbortController().signal);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight--;
        emit({
          type: 'tool',
          name: options.largeArtifact ? 'exec' : 'write_file',
          description: taskName,
          status: 'completed',
        });
      } else if (input.prompt.includes('Você é um executor delegado') && options.realExecutor) {
        const taskA = input.prompt.includes('Task A');
        const filename = options.largeArtifact
          ? taskA
            ? 'large-task-a.bin'
            : 'large-task-b.bin'
          : taskA
            ? 'task-a.txt'
            : 'task-b.txt';
        if (!input.remote)
          throw new Error(
            `Tarefa isolada sem ferramenta real configurada: ${JSON.stringify({ filename, tools: input.plan.tools, sandbox: input.sandbox, approvalMode: input.approvalMode, cwd: input.cwd })}`,
          );
        expect(readFileSync(join(input.cwd, 'user-work.txt'), 'utf8')).toBe('preservar\\n');
        const content = options.largeArtifact
          ? Buffer.alloc(2_097_153, taskA ? 0x61 : 0x62).toString()
          : 'isolated executor\\n';
        if (options.largeArtifact) {
          const byte = taskA ? 'a' : 'b';
          await input.remote.call(
            'exec',
            { command: `python3 -c "from pathlib import Path; Path('${filename}').write_bytes(b'${byte}' * 2097153)"` },
            new AbortController().signal,
          );
        } else {
          await input.remote.call('write_file', { path: filename, content }, new AbortController().signal);
        }
        expect(input.cwd).not.toBe(projectRoot);
        expect(existsSync(join(input.cwd, filename))).toBe(true);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        isolatedArrivals++;
        if (isolatedArrivals === 2) releaseIsolated();
        await bothIsolated;
        inFlight--;
        expect(existsSync(join(projectRoot, filename))).toBe(false);
        emit({
          type: 'tool',
          name: options.largeArtifact ? 'exec' : 'write_file',
          description: filename,
          status: 'completed',
          toolCallId: 'isolated-write',
        });
      } else if (input.prompt.includes('Você é um executor delegado') && options.artifactChange) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (options.parallelTasks) {
          isolatedArrivals++;
          if (isolatedArrivals === 2) releaseIsolated();
          await bothIsolated;
        }
        mkdirSync(join(input.cwd, 'src'), { recursive: true });
        const taskFile = /(task-[ab]\.txt)/.exec(input.prompt)?.[1];
        const filename = options.largeArtifact
          ? input.prompt.includes('Task A')
            ? 'large-task-a.bin'
            : 'large-task-b.bin'
          : (taskFile ?? 'src/implemented.ts');
        mkdirSync(join(input.cwd, filename.includes('/') ? 'src' : '.'), { recursive: true });
        if (options.largeArtifact) {
          const byte = filename === 'large-task-a.bin' ? 0x61 : 0x62;
          writeFileSync(join(input.cwd, filename), Buffer.alloc(2_097_153, byte));
        } else {
          writeFileSync(join(input.cwd, filename), 'export const implemented = true;\\n');
        }
        if (options.integrationConflict && filename === 'src/implemented.ts') {
          mkdirSync(join(projectRoot, 'src'), { recursive: true });
          writeFileSync(join(projectRoot, filename), 'user change\\n');
        }
        inFlight--;
        emit({ type: 'tool', name: 'apply_patch', description: filename, status: 'completed', toolCallId: 'tool-1' });
      } else if (options.toolEvent && input.prompt.includes('Você é um executor delegado')) {
        emit({
          type: 'tool',
          name: 'read_file',
          description: 'src/example.ts',
          status: 'completed',
          toolCallId: 'tool-1',
        });
      }
      return { text: 'completed', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const orchestrator = new Orchestrator(store, providers);
  cleanup.push(async () => {
    await orchestrator.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, session, orchestrator, inputs, calls: () => calls, maxInFlight: () => maxInFlight, projectRoot };
}

describe('automatic orchestration', () => {
  it('binds real bwrap tool calls to each task worktree before integrating either result', async () => {
    const test = setup({ realExecutor: true, gitProject: true, dirtyProject: true, parallelTasks: true });
    let completed!: () => void;
    let terminalStatus = '';
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
        terminalStatus = event.run.status;
        completed();
      }
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const workers = test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'));
    expect(terminalStatus, JSON.stringify(test.store.listSessionTasks(test.session.id))).toBe('completed');
    expect(workers).toHaveLength(2);
    expect(new Set(workers.map((input) => input.cwd)).size).toBe(2);
    expect(workers.every((input) => input.remote?.executionKind === 'isolated-local')).toBe(true);
    expect(readFileSync(join(test.projectRoot, 'task-a.txt'), 'utf8')).toBe('isolated executor\\n');
    expect(readFileSync(join(test.projectRoot, 'task-b.txt'), 'utf8')).toBe('isolated executor\\n');
  });

  it('runs two no-Git tasks serially through real tools within the authorized root', async () => {
    const test = setup({ noGitSerialExecutor: true, parallelTasks: true });
    let completed!: () => void;
    let terminalStatus = '';
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
        terminalStatus = event.run.status;
        completed();
      }
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const workers = test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'));
    expect(terminalStatus, JSON.stringify(test.store.listSessionTasks(test.session.id))).toBe('completed');
    expect(workers).toHaveLength(2);
    expect(workers.every((input) => input.cwd === test.projectRoot)).toBe(true);
    expect(
      workers.every(
        (input) =>
          input.prompt.includes('execução serial direta') && input.prompt.includes('sem isolamento ou paralelismo'),
      ),
    ).toBe(true);
    expect(test.maxInFlight()).toBe(1);
    expect(existsSync(join(test.projectRoot, '.git'))).toBe(false);
    expect(readFileSync(join(test.projectRoot, 'task-a.txt'), 'utf8')).toBe('authorized serial\\n');
    expect(readFileSync(join(test.projectRoot, 'task-b.txt'), 'utf8')).toBe('authorized serial\\n');
  });

  it('keeps no-Git large-file delivery unverified when bounded artifact capture is incomplete', async () => {
    const test = setup({ noGitSerialExecutor: true, largeArtifact: true, parallelTasks: true });
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
        completed();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto');
      await done;
    } finally {
      unsubscribe();
    }

    const payloadA = Buffer.alloc(2_097_153, 0x61);
    const payloadB = Buffer.alloc(2_097_153, 0x62);
    expect(readFileSync(join(test.projectRoot, 'large-task-a.bin'))).toEqual(payloadA);
    expect(readFileSync(join(test.projectRoot, 'large-task-b.bin'))).toEqual(payloadB);
    expect(test.maxInFlight()).toBe(1);
    const tasks = test.store.listSessionTasks(test.session.id).filter((task) => task.role === 'worker');
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.delivery?.status === 'unverified')).toBe(true);
    expect(tasks.every((task) => task.delivery?.evidence.includes('artifact:snapshot-unknown'))).toBe(true);
    expect(tasks.every((task) => task.delivery?.recovery.action === 'inspect')).toBe(true);
  }, 30_000);

  it('runs authorized writers concurrently only in distinct automatic worktrees and integrates their files', async () => {
    const test = setup({ artifactChange: true, gitProject: true, parallelTasks: true });
    let completed!: () => void;
    let terminalStatus = '';
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
        terminalStatus = event.run.status;
        completed();
      }
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    expect(
      terminalStatus,
      JSON.stringify({
        runs: test.store.listRuns(test.session.id),
        tasks: test.store.listSessionTasks(test.session.id),
        inputs: test.inputs.map((input) => input.cwd),
      }),
    ).toBe('completed');
    const workers = test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'));
    expect(workers).toHaveLength(2);
    expect(new Set(workers.map((input) => input.cwd)).size).toBe(2);
    expect(workers.every((input) => input.cwd !== test.projectRoot)).toBe(true);
    expect(test.maxInFlight()).toBe(2);
    expect(readFileSync(join(test.projectRoot, 'task-a.txt'), 'utf8')).toContain('implemented');
    expect(readFileSync(join(test.projectRoot, 'task-b.txt'), 'utf8')).toContain('implemented');
    expect(test.store.listSessionTasks(test.session.id).filter((task) => task.role === 'worker')).toHaveLength(2);
  });

  it('integrates two executor files larger than artifact-read limits without changing HEAD or index', async () => {
    const test = setup({
      realExecutor: true,
      largeArtifact: true,
      gitProject: true,
      dirtyProject: true,
      parallelTasks: true,
    });
    const originalHead = gitIn(test.projectRoot, 'rev-parse', 'HEAD').trim();
    const originalIndex = gitIn(test.projectRoot, 'write-tree').trim();
    let terminalStatus = '';
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
        terminalStatus = event.run.status;
        completed();
      }
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto');
      await done;
    } finally {
      unsubscribe();
    }

    expect(terminalStatus, JSON.stringify(test.store.listSessionTasks(test.session.id))).toBe('completed');
    expect(test.maxInFlight()).toBe(2);
    const payloadA = Buffer.alloc(2_097_153, 0x61);
    const payloadB = Buffer.alloc(2_097_153, 0x62);
    expect(readFileSync(join(test.projectRoot, 'large-task-a.bin'))).toEqual(payloadA);
    expect(readFileSync(join(test.projectRoot, 'large-task-b.bin'))).toEqual(payloadB);
    expect(gitIn(test.projectRoot, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
    expect(gitIn(test.projectRoot, 'write-tree').trim()).toBe(originalIndex);
    expect(test.store.listSessionTasks(test.session.id).filter((task) => task.role === 'worker')).toHaveLength(2);
    expect(
      test.store
        .listSessionTasks(test.session.id)
        .filter((task) => task.role === 'worker')
        .every((task) => task.integration?.status === 'applied' && task.integration.cleanup === 'complete'),
    ).toBe(true);
  }, 30_000);

  it('isolates a dirty workspace from its captured tracked and untracked baseline, then integrates the task delta', async () => {
    const test = setup({ artifactChange: true, gitProject: true, dirtyProject: true });
    let terminal!: () => void;
    const done = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const worker = test.inputs.find((input) => input.prompt.includes('Você é um executor delegado'))!;
    expect(worker.cwd).not.toBe(test.projectRoot);
    expect(readFileSync(join(test.projectRoot, 'user-work.txt'), 'utf8')).toBe('preservar\\n');
    expect(readFileSync(join(test.projectRoot, 'src', 'implemented.ts'), 'utf8')).toContain('implemented');
    expect(
      test.store.listSessionTasks(test.session.id).find((task) => task.role === 'worker')?.isolationReason,
    ).toBeUndefined();
  });
  it('retains integration conflicts for retry or explicit discard and records recovery events', async () => {
    const test = setup({ artifactChange: true, gitProject: true, integrationConflict: true });
    let terminal!: () => void;
    const done = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const task = test.store.listSessionTasks(test.session.id).find((entry) => entry.role === 'worker')!;
    expect(task.status).toBe('completed');
    expect(task.integration).toMatchObject({ status: 'blocked', cleanup: 'pending' });
    expect(task.recoveryWorktree?.path).toBeTruthy();
    expect(task.delivery).toMatchObject({
      status: 'partial',
      evidence: expect.arrayContaining(['integration:blocked', 'recovery:workspace-retained']),
      recovery: { action: 'recover_worktree' },
    });
    const synthesis = test.inputs.find((input) => input.prompt.includes('Fatos estruturados de execução'))!;
    expect(synthesis).toBeDefined();
    expect(synthesis.prompt).toContain('"role":"worker"');
    expect(synthesis.prompt).toContain('"status":"completed"');
    expect(synthesis.prompt).toContain('"status":"partial"');
    expect(synthesis.prompt).toContain('"action":"recover_worktree"');
    expect(synthesis.prompt).toContain('"available":true,"retainedWorkspace":true');
    expect(synthesis.prompt).toContain('integration:blocked');
    expect(synthesis.prompt).toContain('Integração bloqueada; entrega não integrada');
    expect(readFileSync(join(test.projectRoot, 'src/implemented.ts'), 'utf8')).toBe('user change\\n');

    rmSync(join(test.projectRoot, 'src/implemented.ts'));
    const recovered = await test.orchestrator.recoverTaskWorktree(task.id, 'apply');
    expect(recovered.applied).toBe(true);
    expect(readFileSync(join(test.projectRoot, 'src/implemented.ts'), 'utf8')).toContain('implemented');
    expect(recovered.task.delivery).toMatchObject({ status: 'implemented', recovery: { action: 'inspect' } });
    expect(recovered.task.recoveryWorktree).toBeUndefined();
    const recoveryEvent = test.store.listEvents(test.session.id).find((event) => event.text.includes('recuperadas'));
    expect(recoveryEvent).toMatchObject({ taskId: task.id, agentId: task.agentId, phase: 'worker' });
  });

  it('keeps a recovery retryable when integration reports no newly applicable changes', async () => {
    const test = setup({ artifactChange: true, gitProject: true, integrationConflict: true });
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
        completed();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const task = test.store.listSessionTasks(test.session.id).find((entry) => entry.role === 'worker')!;
    expect(task.recoveryWorktree).toBeDefined();
    // Remove the executor's added artifact so applying the preserved checkout is a no-op.
    rmSync(join(task.recoveryWorktree!.path, 'src/implemented.ts'));
    const result = await test.orchestrator.recoverTaskWorktree(task.id, 'apply');
    expect(result.applied).toBe(false);
    expect(result.task.integration).toBeUndefined();
    expect(result.task.delivery).toMatchObject({ status: 'not_implemented', recovery: { action: 'retry' } });
    expect(result.task.recoveryWorktree).toBeDefined();
    expect(readFileSync(join(test.projectRoot, 'src/implemented.ts'), 'utf8')).toContain('user change');

    const discarded = await test.orchestrator.recoverTaskWorktree(task.id, 'discard');
    expect(discarded.task.recoveryWorktree).toBeUndefined();
    expect(discarded.task.integration).toMatchObject({
      status: 'not_required',
      cleanup: 'complete',
      reason: expect.stringContaining('Checkout descartado'),
    });
  });

  it.each([
    { worker: 'claude' as const, reviewer: undefined, role: 'executor' },
    { worker: 'kiro' as const, reviewer: 'claude' as const, review: true, role: 'revisor' },
  ])('rejects an unsupported $role before creating a run or calling a provider', async (options) => {
    const test = setup(options);
    await expect(test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto')).rejects.toMatchObject({
      key: 'orchestrator.automaticUnsupportedDelegate',
    });
    expect(test.calls()).toBe(0);
    expect(test.store.listRuns(test.session.id)).toEqual([]);
    expect(test.store.listMessages(test.session.id)).toEqual([]);
  });

  it('captures automatic policy only for tool-enabled workers; tool-less planner and synthesis stay manual', async () => {
    const test = setup({ worker: 'kiro' });
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status === 'completed')
        completed();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    expect(test.calls()).toBe(3);
    const planner = test.inputs.find((input) => input.prompt.includes('Produza somente JSON válido'))!;
    const worker = test.inputs.find((input) => input.prompt.includes('Você é um executor delegado'))!;
    const synthesis = test.inputs.find((input) => input.prompt.includes('Responda ao pedido completo'))!;
    expect(planner).toMatchObject({ approvalMode: 'manual', plan: { tools: false } });
    expect(planner.remote).toBeUndefined();
    expect(worker).toMatchObject({
      approvalMode: 'automatic',
      plan: { tools: true },
      remote: { executionKind: 'isolated-local' },
    });
    expect(synthesis).toMatchObject({ approvalMode: 'manual', plan: { tools: false } });
    expect(synthesis.remote).toBeUndefined();
    expect(synthesis.prompt).toContain('Fatos estruturados de execução (JSON observado pelo orquestrador)');
    expect(synthesis.prompt).toContain('"providerId":"kiro","model":"model","effort":"high"');
    expect(synthesis.prompt).toContain('"status":"completed"');
    expect(synthesis.prompt).toContain('"status":"not_implemented"');
    const workerTask = test.store.listSessionTasks(test.session.id).find((task) => task.role === 'worker')!;
    expect(workerTask).toMatchObject({
      agentId: expect.any(String),
      providerId: 'kiro',
      model: 'model',
      status: 'completed',
      delivery: { status: 'not_implemented', recovery: { action: 'retry' } },
    });
    const tasksById = new Map(test.store.listSessionTasks(test.session.id).map((task) => [task.id, task]));
    expect(
      test.store
        .listEvents(test.session.id)
        .every((event) => !event.taskId || event.agentId === tasksById.get(event.taskId)?.agentId),
    ).toBe(true);
  });

  it('links provider tool calls to task/agent/phase and persists an inspectable unverified outcome', async () => {
    const test = setup({ worker: 'kiro', toolEvent: true });
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status === 'completed')
        completed();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const worker = test.store.listSessionTasks(test.session.id).find((task) => task.role === 'worker')!;
    const tool = test.store.listEvents(test.session.id).find((event) => event.type === 'tool')!;
    expect(tool).toMatchObject({
      taskId: worker.id,
      agentId: worker.agentId,
      phase: 'worker',
      toolName: 'read_file',
      toolCallId: expect.stringMatching(/:tool-1$/),
    });
    expect(worker).toMatchObject({
      status: 'completed',
      toolCalls: [{ name: 'read_file', status: 'completed' }],
      delivery: {
        status: 'not_implemented',
        recovery: { action: 'retry' },
      },
    });
  });

  it('marks delivery implemented only when the isolated task run observes a tool call and changed artifact', async () => {
    const test = setup({ worker: 'kiro', artifactChange: true, gitProject: true });
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status === 'completed')
        completed();
    });
    try {
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await done;
    } finally {
      unsubscribe();
    }
    const worker = test.store.listSessionTasks(test.session.id).find((task) => task.role === 'worker')!;
    expect(worker.delivery).toMatchObject({
      status: 'implemented',
      evidence: expect.arrayContaining(['artifact:src/implemented.ts']),
    });
  });

  it('does not reject an unsupported configured reviewer when the fast path will not run review', async () => {
    const test = setup({ reviewer: 'claude', review: true });
    const fastSession = { ...test.session, mode: 'fast' as const };
    test.store.putSession(fastSession);
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === fastSession.id && event.run.status === 'completed')
        completed();
    });
    try {
      await test.orchestrator.start(fastSession, 'Quanto é 2+2?');
      await done;
    } finally {
      unsubscribe();
    }
    expect(test.calls()).toBe(1);
    expect(test.inputs[0]).toMatchObject({ providerId: 'codex', approvalMode: 'automatic', plan: { tools: true } });
  });
});
