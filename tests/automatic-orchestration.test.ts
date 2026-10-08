import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../server/orchestrator';
import { Store } from '../server/store';
import type { ProviderInfo, ProviderRegistry, RunInput, Session } from '../shared/contracts';

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
    models: [{ id: 'model', name: 'Model', isDefault: true }],
    defaultModel: 'model',
    capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
  };
}

function setup(options: {
  worker?: 'codex' | 'kiro' | 'claude';
  reviewer?: 'codex' | 'kiro' | 'claude';
  review?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'adelic-auto-coordination-'));
  const store = new Store(directory);
  const now = new Date().toISOString();
  store.putProject({
    id: 'project',
    name: 'Project',
    path: directory,
    createdAt: now,
    memoryWorkspace: 'workspace',
    memoryProject: 'project',
    graphify: { enabled: false },
    orchestration: {
      enabled: true,
      maxWorkers: 1,
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
  store.setSettings({ ...store.getSettings()!, approvalMode: 'manual' });
  const inputs: RunInput[] = [];
  let calls = 0;
  const providers: ProviderRegistry = {
    async list() {
      return [provider('codex'), provider('kiro'), provider('claude')];
    },
    async run(input) {
      calls++;
      inputs.push(input);
      if (input.prompt.includes('Produza somente JSON válido')) {
        return {
          text: JSON.stringify({
            tasks: [{ id: 'one', title: 'Task', instructions: 'Inspect the project', scope: [], dependsOn: [] }],
          }),
          stopReason: 'completed',
        };
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
  return { store, session, orchestrator, inputs, calls: () => calls };
}

describe('automatic orchestration', () => {
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
