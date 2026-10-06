import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../server/orchestrator.js';
import { Store } from '../server/store.js';
import type { ProviderEvent, ProviderRegistry, RunInput, RunResult, Session } from '../shared/contracts.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Script = (input: RunInput, emit: (e: ProviderEvent) => void, attempt: number) => Promise<RunResult>;

function setup(script: Script, opts: { coordinated?: boolean; autoRetry?: boolean } = {}) {
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
  const orchestrator = new Orchestrator(store, providers, undefined, undefined, undefined, {
    baseDelayMs: 5,
    maxDelayMs: 20,
  });
  const finished = new Promise<void>((resolve) =>
    orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.status !== 'running') resolve();
    }),
  );
  return { store, session, orchestrator, finished, attempts };
}

describe('automatic retry in the orchestrator', () => {
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
});
