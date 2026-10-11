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
  mode?: 'auto' | 'deep' | 'fast';
  review?: boolean;
  reviewStaticOnly?: boolean;
  workerFailure?: boolean;
  toolEvent?: boolean;
  artifactChange?: boolean;
  largeArtifact?: boolean;
  gitProject?: boolean;
  parallelTasks?: boolean;
  dirtyProject?: boolean;
  integrationConflict?: boolean;
  realExecutor?: boolean;
  noGitSerialExecutor?: boolean;
  synthesisStreaming?: boolean;
  synthesisResponse?: string;
  fastResponse?: string;
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
    mode: options.mode ?? 'deep',
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
      if (options.workerFailure && input.prompt.includes('Você é um executor delegado')) {
        emit({
          type: 'approval',
          approval: {
            id: 'blocked-fixture-approval',
            runId: input.runId,
            sessionId: session.id,
            title: 'Comando bloqueado pelas regras do projeto',
            detail: 'npm test',
            kind: 'command',
            status: 'denied',
            command: 'npm test',
            blocked: 'npm test',
          },
        });
        throw new Error('fixture worker failure');
      }
      if (options.reviewStaticOnly && input.prompt.includes('Faça revisão independente')) {
        return {
          text: 'Revisão estática apenas. O runtime recusou executar Git/typecheck em modo somente leitura; validação dinâmica não realizada.',
          stopReason: 'completed',
        };
      }
      if (options.reviewStaticOnly && input.prompt.includes('Responda ao pedido completo')) {
        return {
          text: 'A tarefa foi concluída; a revisão foi apenas estática e a validação dinâmica não foi realizada.',
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
      if (input.prompt.includes('Fatos estruturados de execução')) {
        if (options.synthesisStreaming) emit({ type: 'delta', text: 'Resposta da síntese.' });
        return { text: options.synthesisResponse ?? 'Resposta da síntese.', stopReason: 'completed' };
      }
      return { text: options.fastResponse ?? 'completed', stopReason: 'completed' };
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
  it('runs a simple README inspection through the fast path before preparing the worker', async () => {
    const test = setup({ review: false });
    let terminal!: () => void;
    const done = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Read README.md');
      await done;
      expect(test.store.getRun(started.runId)?.status).toBe('completed');
    } finally {
      unsubscribe();
    }
    expect(test.inputs.some((input) => input.prompt.includes('Você é um executor delegado'))).toBe(true);
    expect(test.inputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
  });

  it('routes read-only automatic validation through Orchestrator.remoteFor and the real isolated executor', async () => {
    const env = setup({});
    const controller = new AbortController();
    const { remote } = env.orchestrator.remoteFor(
      { ...env.store.getProject('project')!, path: process.cwd() },
      'read-only',
      controller.signal,
      'review-validation',
      'automatic',
      'codex',
    );
    expect(remote).toBeDefined();
    try {
      const typecheck = (await remote!.call(
        'exec',
        { command: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], timeoutMs: 30000 },
        controller.signal,
      )) as { exitCode: number; stdout: string; stderr: string };
      expect(typecheck).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
      const npmVersion = (await remote!.call(
        'exec',
        { command: ['npm', '--version'], timeoutMs: 10000 },
        controller.signal,
      )) as { exitCode: number; stdout: string; stderr: string };
      expect(npmVersion.exitCode).toBe(0);
      await expect(remote!.call('exec', { command: 'node --version' }, controller.signal)).rejects.toThrow(
        /comandos de shell e escrita|somente leitura/i,
      );
      const result = (await remote!.call(
        'exec',
        {
          command: [
            'node',
            '-e',
            'const fs=require("node:fs");try{fs.writeFileSync("/workspace/denied","x");process.exit(7)}catch(e){if(e.code!=="EROFS")process.exit(8);fs.writeFileSync("/var/tmp/adelic-review-check","ok");fs.unlinkSync("/var/tmp/adelic-review-check");console.log("read-only; scratch-cleaned")}',
          ],
        },
        controller.signal,
      )) as { exitCode: number; stdout: string; stderr: string };
      expect(result).toMatchObject({ exitCode: 0, stdout: 'read-only; scratch-cleaned\n' });
      expect(existsSync(join(env.projectRoot, 'denied'))).toBe(false);
      expect(existsSync('/var/tmp/adelic-review-check')).toBe(false);

      // A portable fixture with Node-backed scripts demonstrates that the compartment,
      // not a native auto-safe npm allowlist, decides which checks can execute.
      const fixtureBase = join(process.cwd(), '.adelic/test-tmp');
      mkdirSync(fixtureBase, { recursive: true });
      const fixture = mkdtempSync(join(fixtureBase, 'readonly-portable-fixture-'));
      cleanup.push(() => rmSync(fixture, { recursive: true, force: true }));
      mkdirSync(join(fixture, 'node_modules/typescript/bin'), { recursive: true });
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          name: 'portable-readonly-fixture',
          scripts: {
            typecheck: 'node node_modules/typescript/bin/tsc --noEmit',
            test: 'node smoke.test.mjs',
          },
        }),
      );
      writeFileSync(
        join(fixture, 'node_modules/typescript/bin/tsc'),
        'if (process.argv[2] !== "--noEmit") process.exit(2); console.log("fixture typecheck ok");\n',
      );
      writeFileSync(join(fixture, 'smoke.test.mjs'), 'console.log("fixture smoke ok");\n');
      const fixturePackage = readFileSync(join(fixture, 'package.json'), 'utf8');
      const fixtureRemote = env.orchestrator.remoteFor(
        { ...env.store.getProject('project')!, path: fixture },
        'read-only',
        controller.signal,
        'review-portable-fixture',
        'automatic',
        'codex',
      ).remote!;
      const fixtureTypecheck = (await fixtureRemote.call(
        'exec',
        { command: ['npm', 'run', 'typecheck'], timeoutMs: 10000 },
        controller.signal,
      )) as { exitCode: number; stdout: string; stderr: string };
      expect(fixtureTypecheck).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('fixture typecheck ok') });
      const fixtureTest = (await fixtureRemote.call(
        'exec',
        { command: ['npm', 'test'], timeoutMs: 10000 },
        controller.signal,
      )) as { exitCode: number; stdout: string; stderr: string };
      expect(fixtureTest).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('fixture smoke ok') });
      expect(readFileSync(join(fixture, 'package.json'), 'utf8')).toBe(fixturePackage);
      expect(existsSync(join(fixture, 'smoke.test.mjs'))).toBe(true);
    } finally {
      controller.abort();
    }
  }, 30000);
  it('uses one delegated worker for a short follow-up while retaining planner for broad work', async () => {
    const test = setup({ review: true });
    const finishRun = async (content: string) => {
      const started = await test.orchestrator.start(test.session, content);
      if (test.store.getRun(started.runId)?.status !== 'running') return started.runId;
      await new Promise<void>((resolve) => {
        const unsubscribe = test.orchestrator.subscribe((event) => {
          if (event.type === 'run' && event.run.id === started.runId && event.run.status !== 'running') {
            unsubscribe();
            resolve();
          }
        });
        if (test.store.getRun(started.runId)?.status !== 'running') {
          unsubscribe();
          resolve();
        }
      });
      return started.runId;
    };

    await finishRun('Add a filter button to src/Tasks.tsx.');
    const firstPlannerCount = test.inputs.filter((input) =>
      input.prompt.includes('Produza somente JSON válido'),
    ).length;
    expect(firstPlannerCount).toBe(0);

    const beforeFollowUp = test.inputs.length;
    const followUpRunId = await finishRun('Now keep the filter persistent.');
    const followUpInputs = test.inputs.slice(beforeFollowUp);
    expect(followUpInputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
    const followUpWorkerInput = followUpInputs.find((input) =>
      input.prompt.includes('Now keep the filter persistent.'),
    )!;
    expect(followUpWorkerInput.history.map((message) => message.content).join('\\n')).toContain(
      'Add a filter button to src/Tasks.tsx.',
    );
    const followUpTasks = test.store.listSessionTasks(test.session.id).filter((task) => task.runId === followUpRunId);
    expect(followUpTasks.map((task) => task.role).sort()).toEqual(['reviewer', 'synthesis', 'worker']);
    expect(followUpTasks.find((task) => task.role === 'worker')).toMatchObject({
      title: 'Continuar tarefa coesa',
      status: 'completed',
    });
    expect(followUpTasks.find((task) => task.role === 'synthesis')).toMatchObject({ status: 'completed' });
    const followUpSynthesis = followUpInputs.find((input) => input.prompt.includes('Fatos estruturados de execução'))!;
    expect(followUpSynthesis.prompt).toContain('O status da própria síntese durante esta chamada é transitório');
    expect(followUpSynthesis.prompt).not.toContain('"role":"synthesis"');
    expect(followUpSynthesis.prompt).toContain('"role":"worker"');
    expect(followUpSynthesis.prompt).toContain('"status":"completed"');
  });

  it('passes the referenced user goal to the effective worker after a long assistant answer', async () => {
    const test = setup({ review: false });
    const oldGoal = 'PREVIOUS_GOAL_RETENTION_RULE: implement retention policy of seven days in retention.ts';
    test.store.addMessage({
      id: 'prior-user',
      sessionId: test.session.id,
      runId: 'prior-run',
      role: 'user',
      content: oldGoal,
      createdAt: new Date().toISOString(),
    });
    test.store.addMessage({
      id: 'prior-assistant',
      sessionId: test.session.id,
      runId: 'prior-run',
      role: 'assistant',
      content: 'Long response. '.repeat(200),
      createdAt: new Date().toISOString(),
    });
    const started = await test.orchestrator.start(test.session, 'Now implement it in retention.ts.');
    await new Promise<void>((resolve) => {
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.id === started.runId && event.run.status !== 'running') {
          unsubscribe();
          resolve();
        }
      });
      if (test.store.getRun(started.runId)?.status !== 'running') {
        unsubscribe();
        resolve();
      }
    });
    const inputs = test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].prompt).toContain(oldGoal);
    expect(inputs[0].prompt).toContain('Now implement it in retention.ts.');
    expect(test.inputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
    expect(
      test.store
        .listSessionTasks(test.session.id)
        .filter((task) => task.runId === started.runId)
        .map((task) => task.role),
    ).toContain('worker');
  });

  it('keeps broad architecture work on the planner in auto and deep after simple and complex histories', async () => {
    for (const mode of ['auto', 'deep'] as const)
      for (const previous of [
        'Add a filter button to src/Tasks.tsx',
        'Implement dependencies across several modules.',
      ]) {
        const test = setup({ review: true, mode });
        const finishRun = async (content: string) => {
          const started = await test.orchestrator.start(test.session, content);
          if (test.store.getRun(started.runId)?.status !== 'running') return started.runId;
          await new Promise<void>((resolve) => {
            const unsubscribe = test.orchestrator.subscribe((event) => {
              if (event.type === 'run' && event.run.id === started.runId && event.run.status !== 'running') {
                unsubscribe();
                resolve();
              }
            });
            if (test.store.getRun(started.runId)?.status !== 'running') {
              unsubscribe();
              resolve();
            }
          });
          return started.runId;
        };
        await finishRun(previous);
        const beforeBroadRequest = test.inputs.length;
        const broadRunId = await finishRun('Now change the Architecture Across Multiple Modules in the project.');
        const broadInputs = test.inputs.slice(beforeBroadRequest);
        expect(broadInputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(true);
        const broadTasks = test.store.listSessionTasks(test.session.id).filter((task) => task.runId === broadRunId);
        expect(broadTasks.map((task) => task.role)).toEqual(
          expect.arrayContaining(['planner', 'worker', 'reviewer', 'synthesis']),
        );
        expect(broadTasks.find((task) => task.role === 'reviewer')?.status).toBe('completed');
        expect(broadTasks.find((task) => task.role === 'synthesis')?.status).toBe('completed');

        const beforeMultiArea = test.inputs.length;
        const multiAreaRunId = await finishRun('Add a button to the UI. Also migrate the database and change the API.');
        expect(
          test.inputs.slice(beforeMultiArea).some((input) => input.prompt.includes('Produza somente JSON válido')),
        ).toBe(true);
        expect(
          test.store
            .listSessionTasks(test.session.id)
            .some((task) => task.runId === multiAreaRunId && task.role === 'planner'),
        ).toBe(true);
      }
  });

  it('gives the final answer completed task facts and preserves static-only review limitations', async () => {
    const test = setup({ review: true, reviewStaticOnly: true });
    let terminal!: () => void;
    const done = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      await test.orchestrator.start(test.session, 'Now keep the filter persistent.');
      await done;
    } finally {
      unsubscribe();
    }
    const runId = test.store.listRuns(test.session.id)[0].id;
    const synthesis = test.inputs.find((input) => input.prompt.includes('Fatos estruturados de execução'))!;
    expect(synthesis.prompt).toContain('Revisão estática apenas.');
    expect(synthesis.prompt).toContain('validação dinâmica não realizada');
    expect(synthesis.prompt).not.toContain('"role":"synthesis"');
    expect(synthesis.prompt).toContain('"role":"worker"');
    expect(synthesis.prompt).toContain('"status":"completed"');
    expect(
      test.store.listSessionTasks(test.session.id).find((task) => task.runId === runId && task.role === 'synthesis'),
    ).toMatchObject({ status: 'completed' });
    const answer = test.store
      .listMessages(test.session.id)
      .find((message) => message.runId === runId && message.role === 'assistant');
    expect(answer?.content).toContain(
      'A tarefa foi concluída; a revisão foi apenas estática e a validação dinâmica não foi realizada.',
    );
    expect(answer?.content).toContain('Verificações de entrega registradas: nenhuma');
    expect(answer?.content).not.toMatch(/síntese.*em execução|synthesis.*running/i);
  });

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
    const answer = test.store
      .listMessages(test.session.id)
      .find((message) => message.runId === task.runId && message.role === 'assistant');
    expect(answer?.content).toContain('integração bloqueada');
    expect(answer?.content).toContain('validação não confirmada');
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

  it.each([false, true])(
    'persists and streams synthesis disclosure (streaming=%s) without duplicating model text',
    async (synthesisStreaming) => {
      const test = setup({ synthesisStreaming });
      let terminal!: () => void;
      const done = new Promise<void>((resolve) => (terminal = resolve));
      const deltas: string[] = [];
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'delta' && event.sessionId === test.session.id) deltas.push(event.text);
        if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
          terminal();
      });
      try {
        const started = await test.orchestrator.start(test.session, 'Implement a coordinated change');
        await done;
        const answer = test.store
          .listMessages(test.session.id)
          .find((message) => message.runId === started.runId && message.role === 'assistant');
        expect(answer?.content).toContain('Resposta da síntese.');
        expect(answer?.content).toContain('Fatos finais registrados pelo orquestrador');
        expect(answer?.content.split('Resposta da síntese.')).toHaveLength(2);
        expect(deltas.join('')).toBe(answer?.content);
        expect(deltas.join('')).toContain('Fatos finais registrados pelo orquestrador');
      } finally {
        unsubscribe();
      }
    },
  );

  it('reports a failed worker and absent checks even when synthesis overclaims success', async () => {
    const test = setup({ workerFailure: true, synthesisResponse: 'completed' });
    let terminal!: () => void;
    const done = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      await test.orchestrator.start(test.session, 'Implement a broad feature spanning UI, storage, and API.');
      await done;
    } finally {
      unsubscribe();
    }
    const runId = test.store.listRuns(test.session.id)[0]!.id;
    const answer = test.store
      .listMessages(test.session.id)
      .find((message) => message.runId === runId && message.role === 'assistant');
    expect(answer?.content).toContain('completed');
    expect(answer?.content).toContain('processo failed');
    expect(answer?.content).toContain('fixture worker failure');
    expect(answer?.content).toContain('Ação recusada/bloqueada');
    expect(answer?.content).toContain('npm test');
    expect(answer?.content).toContain('validação não confirmada');
    expect(
      test.store.listSessionTasks(test.session.id).find((task) => task.runId === runId && task.role === 'worker')
        ?.status,
    ).toBe('failed');
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
      await test.orchestrator.start(test.session, 'Implement an architecture change across multiple modules.');
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

  it('includes resolved continuity in the effective RunInput for route.fast after long intervening replies', async () => {
    const longReply = 'intermediate answer '.repeat(220);
    const test = setup({ mode: 'fast', fastResponse: longReply });
    const fastSession = { ...test.session, mode: 'fast' as const };
    test.store.putSession(fastSession);
    const send = async (content: string) => {
      let complete!: () => void;
      const done = new Promise<void>((resolve) => (complete = resolve));
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === fastSession.id && event.run.status !== 'running')
          complete();
      });
      try {
        await test.orchestrator.start(fastSession, content);
        await done;
      } finally {
        unsubscribe();
      }
    };

    await send('Implement retention policy of seven days in retention.ts.');
    await send('Also preserve retries during restart.');
    await send('Now keep expiry checks deterministic.');
    await send('Also retain original timestamps.');
    await send('Now implement it in retention.ts.');

    const finalInput = test.inputs.at(-1)!;
    expect(test.store.listMessages(fastSession.id).at(-1)?.route?.level).toBe('fast');
    expect(finalInput.prompt).toContain('seven days');
    expect(finalInput.prompt).toContain('preserve retries during restart');
    expect(finalInput.prompt).toContain('expiry checks deterministic');
    expect(finalInput.prompt).toContain('retain original timestamps');
    expect(finalInput.history.map((message) => message.content).join(' ')).not.toContain(
      'Implement retention policy of seven days',
    );
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
