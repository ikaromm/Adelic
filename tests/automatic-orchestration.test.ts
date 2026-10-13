import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Orchestrator } from '../server/orchestrator';
import { Store } from '../server/store';
import { createExecutorWorktree, removeWorktree } from '../server/worktrees';
import type { ProviderInfo, ProviderRegistry, RunInput, Session } from '../shared/contracts';
import { gitIn } from './git-fixtures';

// Full real-Git isolation/integration workflows get a finite local ceiling; product budgets stay independently asserted.
const REAL_GIT_WORKFLOW_TIMEOUT_MS = 15_000;
// Capturing and integrating multi-megabyte artifacts needs more headroom under coverage.
const LARGE_ARTIFACT_WORKFLOW_TIMEOUT_MS = 30_000;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  reviewerFailure?: boolean;
  slowReviewer?: boolean;
  reviewerCleanupDelayMs?: number;
  workerFailure?: boolean;
  toolEvent?: boolean;
  artifactChange?: boolean;
  largeArtifact?: boolean;
  gitProject?: boolean;
  parallelTasks?: boolean;
  threeTaskTimeout?: boolean;
  dirtyProject?: boolean;
  integrationConflict?: boolean;
  commitExecutorChanges?: boolean;
  realExecutor?: boolean;
  noGitSerialExecutor?: boolean;
  synthesisStreaming?: boolean;
  synthesisResponse?: string;
  fastResponse?: string;
  orchestrationEnabled?: boolean;
  slowDiscovery?: boolean;
  slowDiscoveryCall?: number;
  autoCompact?: boolean;
  directProviderFailure?: boolean;
  slowWorktreeCreation?: boolean;
  retainBranchCheckout?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'adelic-auto-coordination-'));
  const projectRoot = join(directory, 'project-root');
  const branchProtectorPath = join(directory, 'branch-protector');
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
      enabled: options.orchestrationEnabled ?? true,
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
    ...(options.autoCompact ? { autoCompact: true, autoCompactTokens: 1000 } : {}),
    ...(options.artifactChange || options.realExecutor || options.noGitSerialExecutor
      ? { sandbox: 'workspace-write' as const }
      : {}),
  });
  const inputs: RunInput[] = [];
  let calls = 0;
  let activeReviewerCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let isolatedArrivals = 0;
  let releaseIsolated!: () => void;
  const bothIsolated = new Promise<void>((resolve) => (releaseIsolated = resolve));
  let listCalls = 0;
  const providers: ProviderRegistry = {
    async list() {
      listCalls++;
      if (options.slowDiscovery || options.slowDiscoveryCall === listCalls)
        await new Promise<void>((resolve) => setTimeout(resolve, 10_500));
      return [provider('codex'), provider('kiro'), provider('claude')];
    },
    async run(input, emit, signal) {
      calls++;
      inputs.push(input);
      if (options.directProviderFailure) throw new Error('fixture direct provider failure');
      if (input.prompt.includes('Produza somente JSON válido')) {
        return {
          text: JSON.stringify({
            tasks: options.threeTaskTimeout
              ? [
                  { id: 'one', title: 'Task 1', instructions: 'Observe a fact', scope: [], dependsOn: [] },
                  { id: 'two', title: 'Task 2', instructions: 'Wait for interruption', scope: [], dependsOn: ['one'] },
                  { id: 'three', title: 'Task 3', instructions: 'Must remain pending', scope: [], dependsOn: ['two'] },
                ]
              : options.parallelTasks
                ? [
                    { id: 'one', title: 'Task A', instructions: 'Create task-a.txt', scope: [], dependsOn: [] },
                    { id: 'two', title: 'Task B', instructions: 'Create task-b.txt', scope: [], dependsOn: [] },
                  ]
                : [
                    {
                      id: 'one',
                      title: 'Task',
                      instructions: options.slowWorktreeCreation ? 'Create src/implemented.ts' : 'Inspect the project',
                      scope: [],
                      dependsOn: [],
                    },
                  ],
          }),
          stopReason: 'completed',
        };
      }
      if (options.threeTaskTimeout && input.prompt.includes('Você é um executor delegado')) {
        if (input.prompt.includes('Task 2')) {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => setTimeout(() => reject(new Error('second task cleaned after abort')), 250);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        if (input.prompt.includes('Task 1'))
          return { text: 'FATO_OBSERVADO_PELA_PRIMEIRA_TAREFA', stopReason: 'completed' };
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
      if (input.prompt.includes('Faça revisão independente') && options.slowReviewer) {
        activeReviewerCalls++;
        await new Promise<void>((resolve, reject) => {
          const cleanupAndReject = () => {
            setTimeout(() => {
              activeReviewerCalls--;
              reject(new Error('reviewer aborted after process cleanup'));
            }, options.reviewerCleanupDelayMs ?? 0);
          };
          if (signal.aborted) cleanupAndReject();
          else signal.addEventListener('abort', cleanupAndReject, { once: true });
        });
      }
      if (input.prompt.includes('Faça revisão independente') && options.reviewerFailure)
        throw new Error('fixture reviewer failure');
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
        if (options.commitExecutorChanges) {
          gitIn(
            input.cwd,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            '-c',
            'commit.gpgSign=false',
            'add',
            '-A',
          );
          gitIn(
            input.cwd,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '-qm',
            'executor-owned task commit',
          );
        }
        if (options.retainBranchCheckout) {
          const branch = gitIn(input.cwd, 'branch', '--show-current').trim();
          gitIn(projectRoot, 'worktree', 'add', '--quiet', '--force', branchProtectorPath, branch);
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
  return {
    store,
    session,
    orchestrator,
    providers,
    inputs,
    calls: () => calls,
    activeReviewerCalls: () => activeReviewerCalls,
    maxInFlight: () => maxInFlight,
    projectRoot,
    branchProtectorPath,
    listCalls: () => listCalls,
  };
}

function slowFinalCheckpointGit(projectRoot: string) {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-finalization-'));
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const counter = join(shimDir, 'write-tree-count');
  const shim = join(shimDir, 'git');
  writeFileSync(counter, '0');
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$GIT_WORK_TREE" = "${projectRoot}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "write-tree" ]; then
      n=$(cat "${counter}")
      n=$((n + 1))
      echo "$n" > "${counter}"
      if [ "$n" -eq 2 ]; then sleep 10.5; fi
      break
    fi
  done
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    counter,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

function slowWorktreeRemoveGit() {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-cleanup-budget-'));
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const marker = join(shimDir, 'remove-entered');
  const shim = join(shimDir, 'git');
  writeFileSync(
    shim,
    `#!/bin/sh
previous=
for arg in "$@"; do
  if [ "$previous" = "worktree" ] && [ "$arg" = "remove" ]; then
    echo entered > "${marker}"
    sleep 10.5
    break
  fi
  previous="$arg"
done
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    marker,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

function slowConfigGit(projectRoot: string) {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-config-budget-'));
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const marker = join(shimDir, 'entered');
  const shim = join(shimDir, 'git');
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$GIT_WORK_TREE" = "${projectRoot}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "config" ]; then
      echo entered > "${marker}"
      sleep 12
      break
    fi
  done
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    marker,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

function slowInitialCheckpointGit(projectRoot: string) {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-initialization-'));
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const counter = join(shimDir, 'write-tree-count');
  const shim = join(shimDir, 'git');
  writeFileSync(counter, '0');
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$GIT_WORK_TREE" = "${projectRoot}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "write-tree" ]; then
      n=$(cat "${counter}")
      n=$((n + 1))
      echo "$n" > "${counter}"
      if [ "$n" -eq 1 ]; then sleep 10.5; fi
      break
    fi
  done
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    counter,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

function waitForMarker(path: string, timeoutMs: number, diagnostic: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename?.toString() === basename(path) && existsSync(path)) finish();
    });
    const timeout = setTimeout(
      () => finish(new Error(`Timed out after ${timeoutMs}ms waiting for ${diagnostic} (marker: ${path})`)),
      timeoutMs,
    );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    // Close the check/watch race if the shim wrote the marker as the watcher was installed.
    if (existsSync(path)) finish();
  });
}

function slowWorktreeAddGit(projectRoot: string, createBeforeDelay = false) {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-worktree-add-'));
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const entered = join(shimDir, 'entered');
  const created = join(shimDir, 'created');
  const resumed = join(shimDir, 'resumed');
  const shim = join(shimDir, 'git');
  writeFileSync(
    shim,
    `#!/usr/bin/env python3
import os, sys, time, subprocess
args = sys.argv[1:]
if any(args[i:i+2] == ["worktree", "add"] for i in range(len(args) - 1)):
    with open("${entered}", "w") as f: f.write(str(os.getpid()))
    if ${createBeforeDelay ? 'True' : 'False'}:
        result = subprocess.run(["${realGit}", *args], check=False)
        with open("${created}", "w") as f: f.write(str(result.returncode))
    time.sleep(10.5)
    with open("${resumed}", "w") as f: f.write("late")
    if ${createBeforeDelay ? 'True' : 'False'}:
        sys.exit(result.returncode)
os.execv("${realGit}", ["${realGit}", *args])
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    entered,
    created,
    resumed,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

function slowInitialUpdateRefGit(projectRoot: string) {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-update-ref-'));
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const counter = join(shimDir, 'update-ref-count');
  const shim = join(shimDir, 'git');
  writeFileSync(counter, '0');
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$GIT_WORK_TREE" = "${projectRoot}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "update-ref" ]; then
      n=$(cat "${counter}")
      n=$((n + 1))
      echo "$n" > "${counter}"
      if [ "$n" -eq 1 ]; then sleep 10.5; fi
      break
    fi
  done
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    counter,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

describe('automatic orchestration', () => {
  it('bounds scheduler-level executor isolation and pauses the queue without launching a worker', async () => {
    const test = setup({ gitProject: true, artifactChange: true });
    const git = slowConfigGit(test.projectRoot);
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    try {
      const started = await test.orchestrator.start(
        test.session,
        'Implement dependencies across several modules in this project.',
        undefined,
        [],
        {
          budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
        },
      );
      await test.orchestrator.enqueue(
        test.session.id,
        'Keep queued after isolation timeout.',
        'queued-isolation-timeout',
      );
      await finished;
      const run = test.store.getRun(started.runId)!;
      expect(run).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(existsSync(git.marker)).toBe(true);
      expect(test.calls()).toBe(1);
      expect(test.inputs.some((input) => input.prompt.includes('Você é um executor delegado'))).toBe(false);
      expect(test.orchestrator.queue(test.session.id)).toMatchObject({
        paused: { reason: 'timeout' },
        items: [{ content: 'Keep queued after isolation timeout.' }],
      });
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 15_000);

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
      const fixtureBase = join(tmpdir(), 'adelic-test-fixtures');
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

  it(
    'binds real bwrap tool calls to each task worktree before integrating either result',
    async () => {
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
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

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
      const started = await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto', undefined, [], {
        budget: { totalMs: 30_000, finalizationReserveMs: 2_000 },
      });
      await done;
      expect(test.store.getRun(started.runId)).toMatchObject({
        status: 'completed',
        budget: { finalizationReserveMs: 2_000 },
      });
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

  it(
    'runs authorized writers concurrently only in distinct automatic worktrees and integrates their files',
    async () => {
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
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'integrates two executor files larger than artifact-read limits without changing HEAD or index',
    async () => {
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
    },
    LARGE_ARTIFACT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'removes the executor directory, branch, and ownership proof after successful automatic integration',
    async () => {
      const test = setup({ artifactChange: true, gitProject: true });
      let completed!: () => void;
      const done = new Promise<void>((resolve) => (completed = resolve));
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
          completed();
      });
      let observedWorktree: { path: string; branch: string; ownershipProofRef?: string } | undefined;
      let runId = '';
      try {
        const started = await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
        runId = started.runId;
        for (let attempt = 0; attempt < 2_000; attempt++) {
          const worker = test.store
            .listSessionTasks(test.session.id)
            .find((task) => task.runId === runId && task.role === 'worker');
          if (worker?.recoveryWorktree?.ownershipProofRef) {
            observedWorktree = {
              path: worker.recoveryWorktree.path,
              branch: worker.recoveryWorktree.branch,
              ownershipProofRef: worker.recoveryWorktree.ownershipProofRef,
            };
            break;
          }
          if (test.store.getRun(runId)?.status !== 'running') break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await done;
      } finally {
        unsubscribe();
      }

      expect(observedWorktree, 'the real executor worktree and proof should be persisted before cleanup').toBeDefined();
      const worktree = observedWorktree!;
      const worker = test.store
        .listSessionTasks(test.session.id)
        .find((task) => task.runId === runId && task.role === 'worker')!;
      expect(test.store.getRun(runId)?.status).toBe('completed');
      expect(readFileSync(join(test.projectRoot, 'src/implemented.ts'), 'utf8')).toContain('implemented');
      expect(existsSync(worktree.path)).toBe(false);
      expect(gitIn(test.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(worktree.path);
      expect(gitIn(test.projectRoot, 'branch', '--list', worktree.branch).trim()).toBe('');
      expect(() => gitIn(test.projectRoot, 'show-ref', '--verify', '--quiet', worktree.ownershipProofRef!)).toThrow();
      expect(worker.integration).toMatchObject({
        status: 'applied',
        cleanup: 'complete',
        cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
      });
      expect(worker.recoveryWorktree).toBeUndefined();
      expect(test.store.getTask(worker.id)?.integration).toMatchObject({
        cleanup: 'complete',
        cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
      });
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it('bounds real post-integration worktree cleanup by the original run budget and waits before releasing the queue', async () => {
    const test = setup({ realExecutor: true, gitProject: true, dirtyProject: true, parallelTasks: true });
    const git = slowWorktreeRemoveGit();
    const startedAt = Date.now();
    let completed!: () => void;
    const done = new Promise<void>((resolve) => (completed = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
        completed();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Implemente duas tarefas no projeto', undefined, [], {
        budget: { totalMs: 12_000, finalizationReserveMs: 2_000 },
      });
      for (let attempt = 0; attempt < 2_000 && !existsSync(git.marker); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(existsSync(git.marker), 'the real integration must reach worktree remove').toBe(true);
      const providerCallsAtCleanup = test.calls();
      await test.orchestrator.enqueue(test.session.id, 'Wait for prior cleanup.', 'queued-during-cleanup');
      // The operation has entered its deliberately slow Git remove. Its writer/Run must still
      // own the project reservation and queue; terminal notification here would be early release.
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(test.store.getRun(started.runId)?.status).toBe('running');
      expect(test.orchestrator.queue(test.session.id)).toMatchObject({
        items: [{ content: 'Wait for prior cleanup.' }],
      });
      await done;

      const run = test.store.getRun(started.runId)!;
      const worker = test.store
        .listSessionTasks(test.session.id)
        .find((task) => task.runId === run.id && task.role === 'worker')!;
      expect(readFileSync(join(test.projectRoot, 'task-a.txt'), 'utf8')).toContain('isolated executor');
      expect(readFileSync(join(test.projectRoot, 'task-b.txt'), 'utf8')).toContain('isolated executor');
      expect(worker.integration).toMatchObject({ status: 'applied', cleanup: 'pending' });
      expect(run).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(Date.now() - startedAt).toBeLessThan(13_500);
      expect(test.calls()).toBe(providerCallsAtCleanup);
      expect(test.orchestrator.queue(test.session.id)).toMatchObject({
        paused: { reason: 'timeout' },
        items: [{ content: 'Wait for prior cleanup.' }],
      });
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('cancels a queued cleanup writer without releasing the FIFO lock before its predecessor ends', async () => {
    const test = setup({});
    const writes = test.orchestrator as unknown as {
      withProjectWrite<T>(projectId: string, work: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
    };
    let releaseOwner!: () => void;
    let ownerEntered!: () => void;
    const ownerGate = new Promise<void>((resolve) => (releaseOwner = resolve));
    const entered = new Promise<void>((resolve) => (ownerEntered = resolve));
    const owner = writes.withProjectWrite('fifo-test', async () => {
      ownerEntered();
      await ownerGate;
    });
    await entered;

    const controller = new AbortController();
    let cancelledCleanupRan = false;
    const cancelledCleanup = writes.withProjectWrite(
      'fifo-test',
      async () => {
        cancelledCleanupRan = true;
      },
      { signal: controller.signal },
    );
    controller.abort(new Error('run budget exhausted'));
    await expect(cancelledCleanup).rejects.toThrow('run budget exhausted');

    let successorRan = false;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error('budget already exhausted'));
    let preAbortedCleanupRan = false;
    const preAbortedCleanup = writes.withProjectWrite(
      'fifo-test',
      async () => {
        preAbortedCleanupRan = true;
      },
      { signal: alreadyAborted.signal },
    );
    await expect(preAbortedCleanup).rejects.toThrow('budget already exhausted');

    const successor = writes.withProjectWrite('fifo-test', async () => {
      successorRan = true;
    });
    await Promise.resolve();
    expect(cancelledCleanupRan).toBe(false);
    expect(preAbortedCleanupRan).toBe(false);
    expect(successorRan).toBe(false);
    releaseOwner();
    await Promise.all([owner, successor]);
    expect(cancelledCleanupRan).toBe(false);
    expect(preAbortedCleanupRan).toBe(false);
    expect(successorRan).toBe(true);
  });

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
  it(
    'retains integration conflicts for retry or explicit discard and records recovery events',
    async () => {
      const test = setup({ artifactChange: true, gitProject: true, integrationConflict: true });
      let terminal!: () => void;
      const done = new Promise<void>((resolve) => (terminal = resolve));
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
          terminal();
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
      const recoveryWorktree = task.recoveryWorktree!;
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
      expect(recovered.task.integration).toMatchObject({
        status: 'applied',
        cleanup: 'complete',
        cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
      });
      expect(recovered.task.recoveryWorktree).toBeUndefined();
      expect(gitIn(test.projectRoot, 'branch', '--list', recoveryWorktree.branch).trim()).toBe('');
      expect(existsSync(recoveryWorktree.path)).toBe(false);
      expect(gitIn(test.projectRoot, 'worktree', 'list', '--porcelain')).not.toContain(recoveryWorktree.path);
      expect(() =>
        gitIn(test.projectRoot, 'show-ref', '--verify', '--quiet', recoveryWorktree.ownershipProofRef!),
      ).toThrow();
      expect(test.store.getTask(task.id)?.integration).toMatchObject({
        status: 'applied',
        cleanup: 'complete',
        cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
      });
      const recoveryEvent = test.store.listEvents(test.session.id).find((event) => event.text.includes('recuperadas'));
      expect(recoveryEvent).toMatchObject({ taskId: task.id, agentId: task.agentId, phase: 'worker' });
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it('explicitly discards an owned task checkout and its exclusive branch, then reloads complete cleanup facts', async () => {
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
    const worktree = task.recoveryWorktree!;
    expect(worktree.ownershipVerified).toBe(true);
    const discarded = await test.orchestrator.recoverTaskWorktree(task.id, 'discard');
    expect(discarded.cleanupPending).toBe(false);
    expect(discarded.task.recoveryWorktree).toBeUndefined();
    expect(discarded.task.integration).toMatchObject({
      cleanup: 'complete',
      cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(gitIn(test.projectRoot, 'branch', '--list', worktree.branch).trim()).toBe('');
    const reloaded = new Store(test.store.dataDir);
    expect(reloaded.getTask(task.id)?.integration).toMatchObject({
      cleanup: 'complete',
      cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
    });
    reloaded.close();
  });

  it('persists the authorized tip for a real executor commit and recovers it after Store reload', async () => {
    const test = setup({
      artifactChange: true,
      gitProject: true,
      retainBranchCheckout: true,
      commitExecutorChanges: true,
    });
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
    expect(task.integration).toMatchObject({
      status: 'applied',
      cleanup: 'pending',
      cleanupResources: { worktree: 'removed', branch: 'preserved', ownershipProof: 'preserved' },
    });
    expect(task.recoveryWorktree?.cleanupBranchTip).toMatch(/^[0-9a-f]{40}$/);
    expect(task.recoveryWorktree).toMatchObject({
      executionStarted: true,
      recoveryEvidence: { taskExecution: 'started' },
    });
    const authorizedTip = task.recoveryWorktree!.cleanupBranchTip!;
    expect(authorizedTip).not.toBe(task.recoveryWorktree!.base);
    expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${task.recoveryWorktree!.branch}`).trim()).toBe(
      authorizedTip,
    );
    expect(test.inputs.find((input) => input.prompt.includes('Você é um executor delegado'))?.cwd).not.toBe(
      test.projectRoot,
    );
    const resumedStore = new Store(test.store.dataDir);
    expect(resumedStore.getTask(task.id)?.recoveryWorktree).toMatchObject({
      cleanupBranchTip: authorizedTip,
      executionStarted: true,
      recoveryEvidence: { taskExecution: 'started' },
    });
    await test.orchestrator.shutdown();
    const resumed = new Orchestrator(resumedStore, test.providers);
    try {
      gitIn(test.projectRoot, 'worktree', 'remove', '--force', test.branchProtectorPath);
      const recovered = await resumed.recoverTaskWorktree(task.id, 'apply');
      expect(recovered.cleanupPending).toBe(false);
      expect(recovered.task.integration).toMatchObject({
        cleanup: 'complete',
        cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
      });
      expect(gitIn(test.projectRoot, 'branch', '--list', task.recoveryWorktree!.branch).trim()).toBe('');
    } finally {
      await resumed.shutdown();
      resumedStore.close();
    }
  });

  it(
    'reconciles completed physical task cleanup after Store reload',
    async () => {
      const test = setup({ artifactChange: true, gitProject: true, retainBranchCheckout: true });
      let terminal!: () => void;
      const done = new Promise<void>((resolve) => (terminal = resolve));
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running')
          terminal();
      });
      try {
        await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
        await done;
      } finally {
        unsubscribe();
      }
      const task = test.store.listSessionTasks(test.session.id).find((entry) => entry.role === 'worker')!;
      expect(task.integration).toMatchObject({ status: 'applied', cleanup: 'pending' });
      gitIn(test.projectRoot, 'worktree', 'remove', '--force', test.branchProtectorPath);
      // Automatic cleanup already removed the original folder while preserving its pinned branch;
      // create a real executor checkout to reproduce the narrower remove-return interruption.
      const worktree = await createExecutorWorktree(
        test.store.getProject(task.projectId!)!,
        { id: 'interrupted-cleanup-task', title: 'Interrupted cleanup' },
        test.store.dataDir,
      );
      task.recoveryWorktree = { ...worktree, executionStarted: true };
      test.store.putTask(task);
      gitIn(test.projectRoot, 'worktree', 'add', '--quiet', '--force', test.branchProtectorPath, worktree.branch);
      await expect(
        removeWorktree(test.store.getProject(task.projectId!)!, worktree, test.store.dataDir, {
          deleteBranch: true,
          onCleanupAuthorized: async (tip) => {
            task.recoveryWorktree = { ...worktree, cleanupBranchTip: tip };
            test.store.putTask(task);
          },
          // Simulate process interruption after the filesystem operation, not an OS crash.
          afterWorktreeRemoval: async () => {
            expect(existsSync(worktree.path)).toBe(false);
            throw new Error('simulated interruption after physical removal');
          },
        }),
      ).rejects.toThrow('simulated interruption after physical removal');
      expect(readFileSync(join(test.projectRoot, 'src/implemented.ts'), 'utf8')).toContain('implemented');
      const authorizedTip = task.recoveryWorktree!.cleanupBranchTip!;
      expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${worktree.branch}`).trim()).toBe(authorizedTip);

      const resumedStore = new Store(test.store.dataDir);
      expect(resumedStore.getTask(task.id)?.recoveryWorktree?.cleanupBranchTip).toBe(authorizedTip);
      await test.orchestrator.shutdown();
      const resumed = new Orchestrator(resumedStore, test.providers);
      try {
        const firstRecovery = await resumed.recoverTaskWorktree(task.id, 'discard');
        expect(firstRecovery.cleanupPending).toBe(true);
        expect(firstRecovery.task.recoveryWorktree?.cleanupBranchTip).toBe(authorizedTip);
        expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${worktree.branch}`).trim()).toBe(authorizedTip);
        gitIn(test.projectRoot, 'worktree', 'remove', '--force', test.branchProtectorPath);
        const recovered = await resumed.recoverTaskWorktree(task.id, 'discard');
        expect(recovered.cleanupPending).toBe(false);
        expect(recovered.task.recoveryWorktree).toBeUndefined();
        expect(recovered.task.integration).toMatchObject({
          cleanup: 'complete',
          cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
        });
      } finally {
        await resumed.shutdown();
        resumedStore.close();
      }
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it('reloads pre-catch automatic cleanup authorization and applies from that checkpoint', async () => {
    const test = setup({ artifactChange: true, gitProject: true, retainBranchCheckout: true });
    const checkpointDataDir = join(test.store.dataDir, 'pre-catch-checkpoint');
    mkdirSync(checkpointDataDir);
    symlinkSync(join(test.store.dataDir, 'worktrees'), join(checkpointDataDir, 'worktrees'), 'dir');
    const checkpointPath = join(checkpointDataDir, 'adelic.sqlite');
    let captureCheckpoint!: () => void;
    const checkpointCaptured = new Promise<void>((resolve) => (captureCheckpoint = resolve));
    const putTask = test.store.putTask.bind(test.store);
    let interrupted = false;
    test.store.putTask = (task) => {
      const savedTask = putTask(task);
      const worktree = task.recoveryWorktree;
      if (interrupted || !worktree?.cleanupBranchTip || !worktree.executionStarted) return savedTask;
      interrupted = true;
      // Snapshot the durable authorization callback before it returns to removeWorktree.
      // Throwing here simulates an interruption in that window; it is not a real crash.
      const escapedPath = checkpointPath.replaceAll("'", "''");
      test.store.db.exec(`VACUUM main INTO '${escapedPath}'`);
      captureCheckpoint();
      throw new Error('simulated interruption after durable cleanup authorization');
    };

    try {
      // Do not wait for the Run terminal event: the callback itself signals the checkpoint.
      await test.orchestrator.start(test.session, 'Implemente uma melhoria no projeto');
      await checkpointCaptured;
    } finally {
      test.store.putTask = putTask;
    }

    const checkpointStore = new Store(checkpointDataDir);
    const task = checkpointStore.listSessionTasks(test.session.id).find((entry) => entry.role === 'worker')!;
    const worktree = task.recoveryWorktree!;
    expect(task.integration).toMatchObject({ status: 'applied', cleanup: 'pending' });
    expect(worktree.cleanupBranchTip).toMatch(/^[0-9a-f]{40}$/);
    expect(worktree).toMatchObject({
      ownershipVerified: true,
      executionStarted: true,
      recoveryEvidence: { taskExecution: 'started' },
    });
    expect(worktree.ownershipProofRef).toMatch(/^refs\/adelic\/recovery-intents\//);
    // These checkpoint assertions fail if authorization persists a metadata-free snapshot.
    expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${worktree.branch}`).trim()).toBe(
      worktree.cleanupBranchTip,
    );
    expect(existsSync(worktree.path)).toBe(true);

    const resumed = new Orchestrator(checkpointStore, test.providers);
    try {
      gitIn(test.projectRoot, 'worktree', 'remove', '--force', test.branchProtectorPath);
      const recovered = await resumed.recoverTaskWorktree(task.id, 'apply');
      expect(recovered.applied).toBe(true);
      expect(recovered.cleanupPending).toBe(false);
      expect(recovered.task.integration).toMatchObject({
        status: 'applied',
        cleanup: 'complete',
        cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
      });
      expect(recovered.task.recoveryWorktree).toBeUndefined();
      expect(existsSync(worktree.path)).toBe(false);
      expect(gitIn(test.projectRoot, 'branch', '--list', worktree.branch).trim()).toBe('');
    } finally {
      await resumed.shutdown();
      checkpointStore.close();
    }
  });

  it('preserves an automatic recovery branch advanced after cleanup authorization', async () => {
    const test = setup({ artifactChange: true, gitProject: true, retainBranchCheckout: true });
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
    const worktree = task.recoveryWorktree!;
    expect(worktree.cleanupBranchTip).toBeTruthy();
    writeFileSync(join(test.branchProtectorPath, 'later.txt'), 'advanced after cleanup authorization\\n');
    gitIn(test.branchProtectorPath, 'add', '-A');
    gitIn(
      test.branchProtectorPath,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'advance after authorization',
    );
    const advancedTip = gitIn(test.projectRoot, 'rev-parse', `refs/heads/${worktree.branch}`).trim();
    expect(advancedTip).not.toBe(worktree.cleanupBranchTip);
    await expect(test.orchestrator.recoverTaskWorktree(task.id, 'discard')).rejects.toThrow();
    expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${worktree.branch}`).trim()).toBe(advancedTip);
    expect(gitIn(test.projectRoot, 'rev-parse', worktree.ownershipProofRef!).trim()).toBe(worktree.base);
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

  it(
    'keeps a recovery retryable when integration reports no newly applicable changes',
    async () => {
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
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

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

  it('preserves earlier worker facts and distinguishes budget interruption from user cancellation', async () => {
    const test = setup({ threeTaskTimeout: true });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 10_000, finalizationReserveMs: 9_500 },
      });
      await finished;
      const run = test.store.getRun(started.runId)!;
      const tasks = test.store.listSessionTasks(test.session.id).filter((task) => task.runId === run.id);
      const message = test.store.listMessages(test.session.id).at(-1)!;
      const first = tasks.find((task) => task.title === 'Task 1')!;
      const second = tasks.find((task) => task.title === 'Task 2')!;
      const third = tasks.find((task) => task.title === 'Task 3')!;
      expect(run).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(first).toMatchObject({ status: 'completed', output: 'FATO_OBSERVADO_PELA_PRIMEIRA_TAREFA' });
      expect(message.content).toContain('FATO_OBSERVADO_PELA_PRIMEIRA_TAREFA');
      expect(second).toMatchObject({ status: 'failed' });
      expect(second.error).toMatch(/limite global de orçamento/);
      expect(third).toMatchObject({ status: 'failed' });
      expect(third.error).toMatch(/Não iniciada: prazo do orçamento global/);
      expect(third.error).not.toMatch(/Execução cancelada/);
      expect(message.content).toContain('timeout');
      expect(message.content).toContain('FATO_OBSERVADO_PELA_PRIMEIRA_TAREFA');
      expect(message.content).toContain('não é sucesso');
    } finally {
      unsubscribe();
    }
  }, 15_000);

  it('records user cancellation separately on interrupted and not-started coordinated tasks', async () => {
    const test = setup({ threeTaskTimeout: true });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    const started = await test.orchestrator.start(test.session, 'Implement a small feature.');
    for (let attempt = 0; attempt < 300; attempt++) {
      const second = test.store
        .listSessionTasks(test.session.id)
        .find((task) => task.runId === started.runId && task.title === 'Task 2');
      if (second?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await test.orchestrator.cancel(test.session.id);
    await finished;
    unsubscribe();
    const run = test.store.getRun(started.runId)!;
    const tasks = test.store.listSessionTasks(test.session.id).filter((task) => task.runId === run.id);
    expect(run).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
    expect(tasks.find((task) => task.title === 'Task 2')).toMatchObject({ status: 'cancelled' });
    expect(tasks.find((task) => task.title === 'Task 2')?.error).toMatch(/cancelamento solicitado pelo usuário/);
    expect(tasks.find((task) => task.title === 'Task 3')).toMatchObject({ status: 'cancelled' });
    expect(tasks.find((task) => task.title === 'Task 3')?.error).toMatch(/cancelada pelo usuário/);
  }, 15_000);

  it('persists factual timeout when the independent reviewer exceeds the reserved budget', async () => {
    const test = setup({ review: true, slowReviewer: true, reviewerCleanupDelayMs: 40 });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
      budget: { totalMs: 10_000, finalizationReserveMs: 9_500 },
    });
    await test.orchestrator.enqueue(
      test.session.id,
      'Do not start until prior cleanup completes.',
      'queued-after-timeout',
    );
    await finished;
    unsubscribe();
    const run = test.store.getRun(started.runId)!;
    const tasks = test.store.listSessionTasks(test.session.id).filter((task) => task.runId === run.id);
    const message = test.store.listMessages(test.session.id).at(-1)!;
    expect(run).toMatchObject({ status: 'failed', termination: 'timeout' });
    expect(test.activeReviewerCalls()).toBe(0);
    expect(test.orchestrator.queue(test.session.id)).toMatchObject({
      paused: { reason: 'timeout' },
      items: [{ content: 'Do not start until prior cleanup completes.' }],
    });
    expect(tasks.find((task) => task.role === 'reviewer')).toMatchObject({ status: 'failed' });
    expect(tasks.find((task) => task.role === 'synthesis')).toMatchObject({ status: 'failed' });
    expect(message.content).toContain('timeout');
    expect(message.content).toContain('Revisão independente');
    expect(message.content).toContain('Trabalhos observados: Task [completed]: completed');
    expect(message.content).toContain('não é sucesso');
  });

  it('keeps a user cancellation distinct from the budget timeout and waits for provider cleanup', async () => {
    const test = setup({ review: true, slowReviewer: true, reviewerCleanupDelayMs: 40 });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    const started = await test.orchestrator.start(test.session, 'Implement a small feature.');
    for (let attempt = 0; attempt < 200; attempt++) {
      const reviewer = test.store
        .listSessionTasks(test.session.id)
        .find((task) => task.runId === started.runId && task.role === 'reviewer');
      if (reviewer?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await test.orchestrator.cancel(test.session.id);
    await finished;
    unsubscribe();
    const run = test.store.getRun(started.runId)!;
    expect(run).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
    expect(test.activeReviewerCalls()).toBe(0);
  });

  it('persists worker and review facts when the reviewer provider fails', async () => {
    const test = setup({ review: true, reviewerFailure: true });
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    const started = await test.orchestrator.start(test.session, 'Implement a small feature.');
    await finished;
    unsubscribe();
    const run = test.store.getRun(started.runId)!;
    const review = test.store
      .listSessionTasks(test.session.id)
      .find((task) => task.runId === run.id && task.role === 'reviewer');
    const message = test.store.listMessages(test.session.id).at(-1)!;
    expect(run).toMatchObject({ status: 'failed', termination: 'provider_failure' });
    expect(review).toMatchObject({ status: 'failed', error: expect.stringContaining('fixture reviewer failure') });
    expect(message.content).toContain('Resultado factual');
    expect(message.content).toContain('Trabalhos observados: Task [completed]: completed');
    expect(message.content).toContain('Revisão independente: Revisão independente falhou');
    expect(test.inputs.some((input) => input.prompt.includes('Fatos estruturados de execução'))).toBe(false);
  });

  it('refuses admission after provider discovery consumes the global execution window', async () => {
    vi.useFakeTimers();
    const test = setup({ orchestrationEnabled: false, slowDiscovery: true });
    test.store.putSession({ ...test.session, thinking: 'high' });
    const starting = test.orchestrator.start(test.session, 'Reply briefly.', undefined, [], {
      budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
    });

    // This is the real Orchestrator.start caller: stop waiting at the safe cutoff, not
    // only after the shared read-only discovery operation's 10.5-second completion.
    const rejected = expect(starting).rejects.toMatchObject({
      status: 409,
      key: 'orchestrator.admissionBudgetExpired',
    });
    expect(test.orchestrator.isActive(test.session.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(9_000);
    await rejected;
    // Let the fixture's shared discovery promise settle as the production registry would;
    // the start waiter is already gone and no Run was persisted.
    await vi.advanceTimersByTimeAsync(1_500);

    expect(test.store.listRuns(test.session.id)).toHaveLength(0);
    expect(test.store.listMessages(test.session.id)).toHaveLength(0);
    expect(test.calls()).toBe(0);
    expect(test.orchestrator.isActive(test.session.id)).toBe(false);
  });

  it('cancels the real start discovery awaiter promptly before the budget expires', async () => {
    vi.useFakeTimers();
    const test = setup({ orchestrationEnabled: false, slowDiscovery: true });
    test.store.putSession({ ...test.session, thinking: 'high' });
    const starting = test.orchestrator.start(test.session, 'Reply briefly.', undefined, [], {
      budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
    });
    const rejected = expect(starting).rejects.toMatchObject({ cancelled: true });
    expect(test.orchestrator.isActive(test.session.id)).toBe(true);
    await test.orchestrator.cancel(test.session.id);
    await rejected;
    // Cancellation stops this journey's wait; settle the synthetic read-only discovery too.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(test.store.listRuns(test.session.id)).toHaveLength(0);
    expect(test.store.listMessages(test.session.id)).toHaveLength(0);
    expect(test.calls()).toBe(0);
    expect(test.orchestrator.isActive(test.session.id)).toBe(false);
  });

  it('cancels coordinated internal provider discovery before planner or worker calls', async () => {
    vi.useFakeTimers();
    const test = setup({ slowDiscoveryCall: 2 });
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
      });
      for (let i = 0; i < 20 && test.listCalls() < 2; i++) await vi.advanceTimersByTimeAsync(0);
      expect(test.listCalls()).toBe(2); // first is execute preparation; second is executeCoordinated
      await test.orchestrator.cancel(test.session.id);
      await finished;
      expect(test.store.getRun(started.runId)).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
      expect(test.calls()).toBe(0);
      expect(test.inputs).toEqual([]);
      // The shared read-only discovery may settle after this run has ended, but cannot start a provider.
      await vi.advanceTimersByTimeAsync(10_500);
      expect(test.calls()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('cuts off coordinated internal provider discovery before the finalization reserve', async () => {
    vi.useFakeTimers();
    const test = setup({ slowDiscoveryCall: 2 });
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
      });
      for (let i = 0; i < 20 && test.listCalls() < 2; i++) await vi.advanceTimersByTimeAsync(0);
      expect(test.listCalls()).toBe(2);
      await test.orchestrator.enqueue(test.session.id, 'queued follow-up');
      await vi.advanceTimersByTimeAsync(9_000);
      await finished;
      expect(test.store.getRun(started.runId)).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(test.calls()).toBe(0);
      expect(test.store.getQueue(test.session.id)).toMatchObject({
        paused: { reason: 'timeout' },
        items: [{ content: 'queued follow-up' }],
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(test.calls()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('cancels autocompact context discovery and continues only after cancellation ends the run', async () => {
    vi.useFakeTimers();
    const test = setup({ orchestrationEnabled: false, autoCompact: true, slowDiscoveryCall: 3 });
    const initial = await test.orchestrator.start(test.session, 'First question.');
    for (let i = 0; i < 20 && test.orchestrator.isActive(test.session.id); i++) await vi.advanceTimersByTimeAsync(0);
    expect(test.store.getRun(initial.runId)?.status).toBe('completed');
    const previous = test.store.getRun(initial.runId)!;
    previous.inputTokens = 2_000;
    test.store.putRun(previous);
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Second question.');
      for (let i = 0; i < 20 && test.listCalls() < 3; i++) await vi.advanceTimersByTimeAsync(0);
      expect(test.listCalls()).toBe(3); // second turn catalog, then summarise catalog
      await test.orchestrator.cancel(test.session.id);
      await finished;
      expect(test.store.getRun(started.runId)).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
      expect(test.calls()).toBe(1); // only the first user turn reached the provider
      expect(test.store.listCompactions(test.session.id)).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(test.calls()).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('propagates an optional budget to direct calls while preserving legacy unbudgeted behavior', async () => {
    const direct = setup({ orchestrationEnabled: false });
    const waitForTerminal = (orchestrator: Orchestrator, sessionId: string) =>
      new Promise<void>((resolve) => {
        const unsubscribe = orchestrator.subscribe((event) => {
          if (event.type === 'run' && event.run.sessionId === sessionId && event.run.status !== 'running') {
            unsubscribe();
            resolve();
          }
        });
      });
    const boundedDone = waitForTerminal(direct.orchestrator, direct.session.id);
    const bounded = await direct.orchestrator.start(direct.session, 'Reply briefly.', undefined, [], {
      budget: { totalMs: 20_000, finalizationReserveMs: 2_000 },
    });
    await boundedDone;
    expect(direct.store.getRun(bounded.runId)?.budget).toMatchObject({ finalizationReserveMs: 2_000 });
    expect(direct.inputs[0]?.budget).toMatchObject({ finalizationReserveMs: 2_000 });
    expect(direct.inputs[0]?.budget?.remainingMs).toBeGreaterThan(0);

    const legacy = setup({ orchestrationEnabled: false });
    const legacyDone = waitForTerminal(legacy.orchestrator, legacy.session.id);
    const unbounded = await legacy.orchestrator.start(legacy.session, 'Reply briefly.');
    await legacyDone;
    expect(legacy.store.getRun(unbounded.runId)?.budget).toBeUndefined();
    expect(legacy.inputs[0]?.budget).toBeUndefined();
  });

  it('propagates the same journey deadline into coordinated worker and review calls', async () => {
    const test = setup({ review: true });
    const done = new Promise<void>((resolve) => {
      const unsubscribe = test.orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
          unsubscribe();
          resolve();
        }
      });
    });
    const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
      budget: { totalMs: 30_000, finalizationReserveMs: 2_000 },
    });
    await done;
    const deadlineAt = test.store.getRun(started.runId)?.budget?.deadlineAt;
    expect(deadlineAt).toBeTruthy();
    const coordinatedCalls = test.inputs.filter((input) => input.budget);
    expect(coordinatedCalls.length).toBeGreaterThan(0);
    expect(coordinatedCalls.every((input) => input.budget?.deadlineAt === deadlineAt)).toBe(true);
    expect(coordinatedCalls.every((input) => input.budget!.remainingMs >= 0)).toBe(true);
  });

  it('bounds initial Orchestrator.execute Git update-ref by the journey deadline before provider calls', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro' });
    const git = slowInitialUpdateRefGit(test.projectRoot);
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    const startedAt = Date.now();
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
      });
      await finished;
      const run = test.store.getRun(started.runId)!;
      expect(run).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(run.checkpoint).toMatchObject({ available: false, captureState: 'failed' });
      expect(test.calls()).toBe(0);
      expect(test.inputs).toHaveLength(0);
      expect(readFileSync(git.counter, 'utf8').trim()).toBe('1');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('persists real partial-AdminDir residue and blocks a worker provider call', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro', slowWorktreeCreation: true });
    const gitDir = gitIn(test.projectRoot, 'rev-parse', '--absolute-git-dir').trim();
    const adminRoot = join(gitDir, 'worktrees');
    mkdirSync(adminRoot, { recursive: true });
    const originalHead = gitIn(test.projectRoot, 'rev-parse', 'HEAD').trim();
    chmodSync(adminRoot, 0o500);
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Create src/implemented.ts in the project.');
      await finished;
      const run = test.store.getRun(started.runId)!;
      const task = test.store
        .listSessionTasks(test.session.id)
        .find((entry) => entry.runId === run.id && entry.role === 'worker');
      expect(task).toMatchObject({
        status: 'failed',
        recoveryWorktree: { base: originalHead, ownershipVerified: false },
        delivery: {
          status: 'unverified',
          evidence: ['worktree:intent-recorded', 'worktree:ownership-unknown', 'worktree:proof-ref-is-intent-only'],
        },
      });
      expect(task!.recoveryWorktree!.branch.startsWith('adelic/')).toBe(true);
      expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${task!.recoveryWorktree!.branch}`).trim()).toBe(
        originalHead,
      );
      expect(test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'))).toHaveLength(0);
      expect(task!.recoveryWorktree!.recoveryReason).toMatch(/criação parcial|descoberta|limpeza/i);

      // A second actor in the same repository occupies the intended path/branch after the
      // failed create. Intent metadata must not turn this foreign checkout into owned output.
      const candidate = task!.recoveryWorktree!;
      // Restore the repository admin directory after the fault injection so the competing
      // actor itself can register a real checkout under the same Git repository.
      chmodSync(adminRoot, 0o700);
      execFileSync('git', ['worktree', 'add', '--quiet', '--force', candidate.path, candidate.branch], {
        cwd: test.projectRoot,
      });
      const foreignContent = 'foreign candidate content';
      mkdirSync(join(candidate.path, 'src'), { recursive: true });
      writeFileSync(join(candidate.path, 'src/foreign.ts'), foreignContent);
      const refBefore = gitIn(test.projectRoot, 'rev-parse', `refs/heads/${candidate.branch}`).trim();
      await expect(test.orchestrator.inspectTaskWorktree(task!.id)).resolves.toMatchObject({
        status: 'unknown',
        files: [],
      });
      await expect(test.orchestrator.recoverTaskWorktree(task!.id, 'apply')).rejects.toThrow(
        /A propriedade desta worktree candidata ainda não foi verificada/,
      );
      await expect(test.orchestrator.recoverTaskWorktree(task!.id, 'discard')).rejects.toThrow(
        /A propriedade desta worktree candidata ainda não foi verificada/,
      );
      expect(existsSync(join(test.projectRoot, 'src/foreign.ts'))).toBe(false);
      expect(readFileSync(join(candidate.path, 'src/foreign.ts'), 'utf8')).toBe(foreignContent);
      expect(existsSync(candidate.path)).toBe(true);
      expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${candidate.branch}`).trim()).toBe(refBefore);

      await expect(test.orchestrator.inspectTaskWorktree(task!.id)).resolves.toMatchObject({ status: 'unknown' });
      await expect(test.orchestrator.recoverTaskWorktree(task!.id, 'apply')).rejects.toThrow(
        /A propriedade desta worktree candidata ainda não foi verificada/,
      );
      await expect(test.orchestrator.recoverTaskWorktree(task!.id, 'discard')).rejects.toThrow(
        /A propriedade desta worktree candidata ainda não foi verificada/,
      );
      const reloaded = new Store(test.store.dataDir);
      expect(reloaded.getTask(task!.id)?.recoveryWorktree).toMatchObject({
        path: task!.recoveryWorktree!.path,
        branch: task!.recoveryWorktree!.branch,
        base: originalHead,
        ownershipVerified: false,
        recoveryEvidence: {
          intentRecorded: true,
          creation: 'unknown',
          ownership: 'unknown',
          preparation: 'unknown',
          taskExecution: 'unknown',
        },
      });
      expect(existsSync(join(candidate.path, 'src/foreign.ts'))).toBe(true);
      expect(readFileSync(join(candidate.path, 'src/foreign.ts'), 'utf8')).toBe(foreignContent);
      expect(gitIn(test.projectRoot, 'rev-parse', `refs/heads/${candidate.branch}`).trim()).toBe(refBefore);
      reloaded.close();
    } finally {
      chmodSync(adminRoot, 0o700);
      unsubscribe();
    }
  });

  it('cuts off coordinated worktree creation at the execution window without starting a provider or writing later', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro', slowWorktreeCreation: true });
    const git = slowWorktreeAddGit(test.projectRoot);
    let terminal!: () => void;
    let terminalRun: ReturnType<typeof test.store.getRun>;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
        terminalRun = event.run;
        terminal();
      }
    });
    const startedAt = Date.now();
    try {
      const started = await test.orchestrator.start(
        test.session,
        'Create src/implemented.ts in the project.',
        undefined,
        [],
        {
          budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
        },
      );
      await test.orchestrator.enqueue(test.session.id, 'queued follow-up');
      await finished;
      terminalRun = test.store.getRun(started.runId);
      expect(existsSync(git.entered)).toBe(true);
      expect(terminalRun).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(terminalRun!.durationMs).toBeLessThan(11_800);
      expect(existsSync(git.entered)).toBe(true);
      // Wait past the fixture's full 10.5-second delay: a live writer would resume and leave this marker.
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      expect(existsSync(git.resumed)).toBe(false);
      expect(test.calls()).toBe(0); // synthetic planner shortcut; no delegated worker provider
      expect(test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'))).toHaveLength(0);
      expect(test.store.getQueue(test.session.id)).toMatchObject({
        paused: { reason: 'timeout' },
        items: [{ content: 'queued follow-up' }],
      });
      const workerTask = test.store
        .listSessionTasks(test.session.id)
        .find((task) => task.runId === started.runId && task.role === 'worker')!;
      expect(existsSync(join(test.store.dataDir, 'worktrees', workerTask.id))).toBe(false);
      expect(test.orchestrator.isActive(test.session.id)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(12_800);
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('cancels a real coordinated worktree-add process and preserves the user cancellation cause', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro', slowWorktreeCreation: true });
    const git = slowWorktreeAddGit(test.projectRoot, true);
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(
        test.session,
        'Create src/implemented.ts in the project.',
        undefined,
        [],
        {
          budget: { totalMs: 60_000, finalizationReserveMs: 1_000 },
        },
      );
      // start() can finish before Git reaches the shim; synchronize on the shim's actual
      // process-entry marker, then on real Git's completed worktree-add marker before cancelling.
      const markerDeadline = Date.now() + REAL_GIT_WORKFLOW_TIMEOUT_MS;
      await waitForMarker(git.entered, markerDeadline - Date.now(), 'worktree-add shim entry');
      await waitForMarker(git.created, markerDeadline - Date.now(), 'real Git worktree creation');
      expect(existsSync(git.created), 'real Git must create the checkout before cancellation').toBe(true);
      await test.orchestrator.cancel(test.session.id);
      await finished;
      expect(test.store.getRun(started.runId)).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
      expect(test.calls()).toBe(0); // planner shortcut; no worker started
      expect(test.inputs.filter((input) => input.prompt.includes('Você é um executor delegado'))).toHaveLength(0);
      expect(existsSync(git.resumed)).toBe(false);
      // The test shim is a child process inside Git's private PID namespace. Waiting beyond its
      // full delay proves it did not survive cancellation and resume a late write.
      await new Promise((resolve) => setTimeout(resolve, 10_600));
      expect(existsSync(git.resumed)).toBe(false);
      const workerTask = test.store
        .listSessionTasks(test.session.id)
        .find((task) => task.runId === started.runId && task.role === 'worker')!;
      const abandonedPath = join(test.store.dataDir, 'worktrees', workerTask.id);
      // Git created the checkout, but cancellation interrupted the creation boundary before
      // ownership could be confirmed. It remains available for explicit recovery; never erase it
      // merely to make the terminal cancellation look like successful cleanup.
      expect(workerTask.recoveryWorktree).toMatchObject({
        path: abandonedPath,
        ownershipVerified: false,
      });
      expect(existsSync(abandonedPath)).toBe(true);
      expect(gitIn(test.projectRoot, 'branch', '--list')).toContain(workerTask.recoveryWorktree!.branch);
      expect(test.orchestrator.isActive(test.session.id)).toBe(false);
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('bounds initial Orchestrator.execute Git write-tree by the journey deadline before provider calls', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro' });
    const git = slowInitialCheckpointGit(test.projectRoot);
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    const startedAt = Date.now();
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
      });
      await finished;
      const run = test.store.getRun(started.runId)!;
      expect(run).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(run.checkpoint).toMatchObject({ available: false, captureState: 'failed' });
      expect(test.calls()).toBe(0);
      expect(test.inputs).toHaveLength(0);
      expect(readFileSync(git.counter, 'utf8').trim()).toBe('1');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('keeps user cancellation primary while initial Git preparation is active', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro' });
    const git = slowInitialCheckpointGit(test.projectRoot);
    let terminal!: () => void;
    const finished = new Promise<void>((resolve) => (terminal = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') terminal();
    });
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 60_000, finalizationReserveMs: 1_000 },
      });
      for (let attempt = 0; attempt < 400; attempt++) {
        if (readFileSync(git.counter, 'utf8').trim() === '1') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(readFileSync(git.counter, 'utf8').trim()).toBe('1');
      await test.orchestrator.cancel(test.session.id);
      await finished;
      expect(test.store.getRun(started.runId)).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
      expect(test.calls()).toBe(0);
      expect(test.inputs).toHaveLength(0);
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('bounds final git write-tree by the absolute run deadline and records incomplete finalization', async () => {
    const test = setup({ artifactChange: true, gitProject: true, worker: 'kiro' });
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-git-deadline-'));
    const originalPath = process.env.PATH ?? '';
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const counter = join(shimDir, 'write-tree-count');
    const shim = join(shimDir, 'git');
    writeFileSync(counter, '0');
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$GIT_WORK_TREE" = "${test.projectRoot}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "write-tree" ]; then
      n=$(cat "${counter}")
      n=$((n + 1))
      echo "$n" > "${counter}"
      if [ "$n" -eq 2 ]; then sleep 10.5; fi
      break
    fi
  done
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    let terminalRun: ReturnType<typeof test.store.getRun>;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') {
        terminalRun = event.run;
        done();
      }
    });
    const startedAt = Date.now();
    try {
      const started = await test.orchestrator.start(test.session, 'Implement a small feature.', undefined, [], {
        budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
      });
      await finished;
      terminalRun = test.store.getRun(started.runId);
      expect(terminalRun).toMatchObject({ status: 'failed', termination: 'timeout' });
      expect(terminalRun!.durationMs).toBeLessThan(10_800);
      expect(terminalRun!.checkpoint).toMatchObject({ available: false, captureState: 'failed' });
      expect(test.store.listMessages(test.session.id).at(-1)?.content).toContain('timeout');
      expect(readFileSync(counter, 'utf8').trim()).toBe('2');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9_000);
    } finally {
      unsubscribe();
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps an accepted cancellation primary when final checkpoint cleanup crosses the deadline', async () => {
    const test = setup({ gitProject: true, orchestrationEnabled: false });
    test.store.setSettings({ ...test.store.getSettings()!, sandbox: 'workspace-write' });
    const git = slowFinalCheckpointGit(test.projectRoot);
    let clockOffset = 0;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    try {
      const started = await test.orchestrator.start(
        test.session,
        'Inspect README.md and explain its contents.',
        undefined,
        [],
        {
          budget: { totalMs: 60_000, finalizationReserveMs: 1_000 },
        },
      );
      test.store.enqueue({
        id: 'queued-after-cancel',
        sessionId: test.session.id,
        content: 'Wait for prior cleanup.',
        createdAt: new Date().toISOString(),
      });
      for (let attempt = 0; attempt < 400; attempt++) {
        if (readFileSync(git.counter, 'utf8').trim() === '2') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(readFileSync(git.counter, 'utf8').trim()).toBe('2');
      await test.orchestrator.cancel(test.session.id);
      // Advance only the logical clock after cancellation so final Git capture encounters
      // an expired absolute deadline without waiting a minute in this regression test.
      clockOffset = 61_000;
      await finished;

      const run = test.store.getRun(started.runId)!;
      expect(run).toMatchObject({ status: 'cancelled', termination: 'user_cancelled' });
      expect(run.checkpoint).toMatchObject({ available: false, captureState: 'failed' });
      expect(test.store.listMessages(test.session.id).at(-1)?.content).toContain('entrega não está verificada');
      expect(test.orchestrator.queue(test.session.id)).toMatchObject({
        paused: { reason: 'cancelled' },
        items: [{ content: 'Wait for prior cleanup.' }],
      });
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);

  it('preserves provider failure as the primary cause when final checkpoint capture is slow', async () => {
    const test = setup({ gitProject: true, orchestrationEnabled: false, directProviderFailure: true });
    test.store.setSettings({ ...test.store.getSettings()!, sandbox: 'workspace-write' });
    const git = slowFinalCheckpointGit(test.projectRoot);
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsubscribe = test.orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === test.session.id && event.run.status !== 'running') done();
    });
    try {
      const started = await test.orchestrator.start(
        test.session,
        'Inspect README.md and explain its contents.',
        undefined,
        [],
        {
          budget: { totalMs: 10_000, finalizationReserveMs: 1_000 },
        },
      );
      await finished;
      const run = test.store.getRun(started.runId)!;
      expect(run).toMatchObject({ status: 'failed', termination: 'provider_failure' });
      expect(run.checkpoint).toMatchObject({ available: false, captureState: 'failed' });
      expect(run.error).toContain('fixture direct provider failure');
      const message = test.store.listMessages(test.session.id).at(-1)!;
      expect(message.content).toContain('fixture direct provider failure');
      expect(message.content).not.toContain('Aviso de timeout');
    } finally {
      unsubscribe();
      git.restore();
    }
  }, 30_000);
});
