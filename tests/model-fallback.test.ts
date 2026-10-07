import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import type {
  ProviderEvent,
  ProviderInfo,
  ProviderRegistry,
  RunInput,
  RunResult,
  Session,
  Settings,
} from '../shared/contracts.js';
import { availableModel, modelAlternatives, modelLabel, retryAlternatives } from '../shared/model-fallback.js';
import { ModelFallbackSchema, SettingsPatchSchema, parseBody } from '../shared/schemas.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const caps = { fast: true, tools: true, approvals: true, cancel: true, reasoning: true };
const catalog: ProviderInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    installed: true,
    available: true,
    status: 'ready',
    detail: '',
    models: [
      { id: 'big', name: 'Big', isDefault: true, efforts: ['low', 'high'] },
      { id: 'small', name: 'Small', efforts: ['low'] },
      { id: 'mini', name: 'Mini' },
      { id: 'nano', name: 'Nano' },
    ],
    defaultModel: 'big',
    capabilities: caps,
  },
  {
    id: 'kiro',
    name: 'Kiro',
    installed: false,
    available: false,
    status: 'missing',
    detail: 'Kiro não instalado',
    models: [{ id: 'k1', name: 'K1', isDefault: true }],
    defaultModel: 'k1',
    capabilities: caps,
  },
  {
    id: 'claude',
    name: 'Claude',
    installed: true,
    available: true,
    status: 'ready',
    detail: '',
    models: [{ id: 'c1', name: 'C1', isDefault: true }],
    defaultModel: 'c1',
    capabilities: caps,
  },
];

describe('model alternatives', () => {
  it('lists other models of the same provider, then other available providers, up to three', () => {
    expect(modelAlternatives(catalog, { providerId: 'codex', model: 'small' })).toEqual([
      { providerId: 'codex', model: 'big' },
      { providerId: 'codex', model: 'mini' },
      { providerId: 'codex', model: 'nano' },
    ]);
    // No model means the provider's default, which is excluded too.
    expect(modelAlternatives(catalog, { providerId: 'codex' }, 5)).toEqual([
      { providerId: 'codex', model: 'small' },
      { providerId: 'codex', model: 'mini' },
      { providerId: 'codex', model: 'nano' },
      { providerId: 'claude', model: 'c1' },
    ]);
    // Unavailable providers (kiro) are never offered.
    expect(modelAlternatives(catalog, { providerId: 'claude' })).toEqual([{ providerId: 'codex', model: 'big' }]);
    expect(modelAlternatives(catalog, { providerId: 'kiro' })).toEqual([
      { providerId: 'codex', model: 'big' },
      { providerId: 'claude', model: 'c1' },
    ]);
  });

  it('labels models and checks availability', () => {
    expect(modelLabel(catalog, { providerId: 'codex' })).toBe('Codex · Big');
    expect(modelLabel(catalog, { providerId: 'opencode', model: 'x' })).toBe('opencode · x');
    expect(availableModel(catalog, { providerId: 'kiro', model: 'k1' })).toBe(false);
    expect(availableModel(catalog, { providerId: 'codex', model: 'nope' })).toBe(false);
    expect(availableModel(catalog, { providerId: 'codex', model: 'mini' })).toBe(true);
  });

  it('offers alternatives only for capacity failures, skipping models the fallback already tried', () => {
    const failure = { kind: 'overloaded' as const, reason: 'modelo sobrecarregado', retryable: true };
    expect(retryAlternatives(catalog, undefined)).toEqual([]);
    expect(
      retryAlternatives(catalog, {
        providerId: 'codex',
        failure: { kind: 'transient', reason: 'x', retryable: true },
      }),
    ).toEqual([]);
    expect(retryAlternatives(catalog, { providerId: 'claude', failure }).map((a) => a.label)).toEqual(['Codex · Big']);
    expect(
      retryAlternatives(catalog, {
        providerId: 'codex',
        failure: { ...failure, kind: 'rate_limit' },
        fallback: {
          from: { providerId: 'codex', model: 'big' },
          to: { providerId: 'codex', model: 'small' },
          reason: '',
        },
      }).map((a) => a.ref.model),
    ).toEqual(['mini', 'nano', 'c1']);
    // Runs stored before the split keep their "capacity" kind.
    expect(
      retryAlternatives(catalog, { providerId: 'claude', failure: { ...failure, kind: 'capacity' } }),
    ).toHaveLength(1);
  });
});

describe('model fallback settings schema', () => {
  it('accepts up to three distinct catalog-shaped entries', () => {
    const value = { enabled: true, models: [{ providerId: 'codex', model: 'small' }] };
    expect(ModelFallbackSchema.parse(value)).toEqual(value);
    const parsed = parseBody(SettingsPatchSchema, { modelFallback: value }, 'x');
    expect(parsed).toEqual({ ok: true, data: expect.objectContaining({ modelFallback: value }) });
  });

  it('rejects more than three, duplicates, unknown providers and extra keys', () => {
    const entry = (model: string) => ({ providerId: 'codex', model });
    for (const bad of [
      { enabled: true, models: [entry('a'), entry('b'), entry('c'), entry('d')] },
      { enabled: true, models: [entry('a'), entry('a')] },
      { enabled: true, models: [{ providerId: 'gemini', model: 'a' }] },
      { enabled: true, models: [{ ...entry('a'), extra: 1 }] },
      { enabled: 'yes', models: [] },
      { enabled: true, models: [entry('  ')] },
    ]) {
      const parsed = parseBody(SettingsPatchSchema, { modelFallback: bad }, 'x');
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/modelFallback inválido/);
    }
  });
});

type Script = (input: RunInput, emit: (e: ProviderEvent) => void) => Promise<RunResult>;

function setup(
  script: Script,
  opts: { fallback?: Settings['modelFallback']; coordinated?: boolean; session?: Partial<Session> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-fallback-'));
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
  if (opts.fallback) store.setSettings({ ...store.getSettings()!, modelFallback: opts.fallback });
  const session: Session = {
    id: 's',
    projectId: 'p',
    title: 'T',
    providerId: 'codex',
    model: 'big',
    mode: opts.coordinated ? 'deep' : 'fast',
    nativeSessionId: 'native-1',
    createdAt: now,
    updatedAt: now,
    ...opts.session,
  };
  store.putSession(session);
  const calls: RunInput[] = [];
  const providers: ProviderRegistry = {
    async list() {
      return catalog;
    },
    async run(input, emit) {
      calls.push(input);
      return script(input, emit);
    },
    async approve() {},
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers, undefined, undefined, {
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  const ended = () =>
    new Promise<void>((resolve) => {
      const stop = orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status !== 'running') {
          stop();
          resolve();
        }
      });
    });
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  const base = () =>
    new Promise<string>((r) => {
      const url = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (server.listening) r(url());
      else server.once('listening', () => r(url()));
    });
  return { store, session, orchestrator, calls, ended, base };
}

const overloaded: Script = async (input, emit) => {
  if (input.model === 'big') throw new Error('Selected model is at capacity. Please try a different model.');
  emit({ type: 'session', nativeSessionId: `native-${input.providerId}-${input.model}` });
  emit({ type: 'delta', text: `ok de ${input.providerId}/${input.model}` });
  return { text: `ok de ${input.providerId}/${input.model}`, stopReason: 'completed' };
};

describe('automatic model fallback', () => {
  it('switches model only after the retries are exhausted, for this run only', async () => {
    const t = setup(overloaded, {
      fallback: { enabled: true, models: [{ providerId: 'codex', model: 'small' }] },
    });
    const done = t.ended();
    await t.orchestrator.start(t.session, 'Oi');
    await done;
    // 1 attempt + 2 automatic retries on "big", then one attempt on "small".
    expect(t.calls.map((c) => c.model)).toEqual(['big', 'big', 'big', 'small']);
    const run = t.store.listRuns('s')[0];
    expect(run).toMatchObject({
      status: 'completed',
      retries: 2,
      model: 'big',
      fallback: {
        from: { providerId: 'codex', model: 'big' },
        to: { providerId: 'codex', model: 'small' },
        reason: 'modelo sobrecarregado',
      },
    });
    const event = t.store.listEvents('s').find((e) => e.type === 'fallback');
    expect(event?.text).toBe('Modelo sobrecarregado: trocado de Codex · Big para Codex · Small');
    // The conversation keeps its model and native session; the fallback's session is not adopted.
    expect(t.store.getSession('s')).toMatchObject({ providerId: 'codex', model: 'big', nativeSessionId: 'native-1' });
    expect(t.store.listMessages('s').at(-1)?.content).toBe('ok de codex/small');
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('drops the native session and carries the history when the fallback is another provider', async () => {
    const t = setup(overloaded, {
      fallback: {
        enabled: true,
        models: [
          { providerId: 'kiro', model: 'k1' }, // unavailable: skipped
          { providerId: 'claude', model: 'c1' },
        ],
      },
    });
    const first = t.ended();
    t.store.setSettings({ ...t.store.getSettings()!, modelFallback: { enabled: false, models: [] } });
    // A first, successful exchange on the same provider builds history (no fallback needed).
    t.store.putSession({ ...t.store.getSession('s')!, model: 'small' });
    await t.orchestrator.start(t.store.getSession('s')!, 'Primeira pergunta');
    await first;
    t.store.putSession({ ...t.store.getSession('s')!, model: 'big', nativeSessionId: 'native-1' });
    t.store.setSettings({
      ...t.store.getSettings()!,
      modelFallback: {
        enabled: true,
        models: [
          { providerId: 'kiro', model: 'k1' },
          { providerId: 'claude', model: 'c1' },
        ],
      },
    });
    t.calls.length = 0;
    const second = t.ended();
    await t.orchestrator.start(t.store.getSession('s')!, 'Segunda pergunta');
    await second;
    expect(t.calls.map((c) => `${c.providerId}/${c.model}`)).toEqual([
      'codex/big',
      'codex/big',
      'codex/big',
      'claude/c1',
    ]);
    expect(t.calls[0].nativeSessionId).toBe('native-1');
    const switched = t.calls[3];
    expect(switched.nativeSessionId).toBeUndefined();
    expect(switched.history.map((m) => m.content)).toEqual(
      expect.arrayContaining(['Primeira pergunta', 'ok de codex/small']),
    );
    expect(switched.sandbox).toBe(t.calls[0].sandbox);
    expect(switched.approvalMode).toBe(t.calls[0].approvalMode);
    const run = t.store.listRuns('s').find((r) => r.fallback);
    expect(run?.fallback?.to).toEqual({ providerId: 'claude', model: 'c1' });
    expect(t.store.listMessages('s').at(-1)).toMatchObject({ providerId: 'claude', content: 'ok de claude/c1' });
    expect(t.store.getSession('s')).toMatchObject({ providerId: 'codex', model: 'big', nativeSessionId: 'native-1' });
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('tries each entry once and fails with the last error when all are overloaded', async () => {
    const t = setup(
      async () => {
        throw new Error('429 Too Many Requests');
      },
      {
        fallback: {
          enabled: true,
          models: [
            { providerId: 'codex', model: 'big' }, // the failing model itself: skipped
            { providerId: 'codex', model: 'small' },
            { providerId: 'claude', model: 'c1' },
          ],
        },
      },
    );
    const done = t.ended();
    await t.orchestrator.start(t.session, 'Oi');
    await done;
    expect(t.calls.map((c) => `${c.providerId}/${c.model}`)).toEqual([
      'codex/big',
      'codex/big',
      'codex/big',
      'codex/small',
      'claude/c1',
    ]);
    const run = t.store.listRuns('s')[0];
    expect(run.status).toBe('failed');
    expect(run.failure).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(run.fallback).toMatchObject({ from: { model: 'big' }, to: { providerId: 'claude', model: 'c1' } });
    expect(t.store.listEvents('s').filter((e) => e.type === 'fallback')).toHaveLength(2);
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('never falls back after a visible effect, on other kinds of failure, or when disabled', async () => {
    const effect = setup(
      async (_input, emit) => {
        emit({ type: 'delta', text: 'parcial' });
        throw new Error('overloaded');
      },
      { fallback: { enabled: true, models: [{ providerId: 'codex', model: 'small' }] } },
    );
    let done = effect.ended();
    await effect.orchestrator.start(effect.session, 'Oi');
    await done;
    expect(effect.calls).toHaveLength(1);
    expect(effect.store.listRuns('s')[0].fallback).toBeUndefined();
    await effect.orchestrator.shutdown();
    effect.store.close();

    const timeout = setup(
      async () => {
        throw new Error('The operation timed out.');
      },
      { fallback: { enabled: true, models: [{ providerId: 'codex', model: 'small' }] } },
    );
    done = timeout.ended();
    await timeout.orchestrator.start(timeout.session, 'Oi');
    await done;
    expect(timeout.calls.map((c) => c.model)).toEqual(['big', 'big', 'big']);
    await timeout.orchestrator.shutdown();
    timeout.store.close();

    const off = setup(overloaded, { fallback: { enabled: false, models: [{ providerId: 'codex', model: 'small' }] } });
    done = off.ended();
    await off.orchestrator.start(off.session, 'Oi');
    await done;
    expect(off.calls.map((c) => c.model)).toEqual(['big', 'big', 'big']);
    expect(off.store.listRuns('s')[0].failure).toMatchObject({ kind: 'overloaded' });
    await off.orchestrator.shutdown();
    off.store.close();
  });

  it('stops when the fallback attempt shows text and then fails', async () => {
    const t = setup(
      async (input, emit) => {
        if (input.model === 'small') emit({ type: 'delta', text: 'meio' });
        throw new Error('overloaded');
      },
      {
        fallback: {
          enabled: true,
          models: [
            { providerId: 'codex', model: 'small' },
            { providerId: 'claude', model: 'c1' },
          ],
        },
      },
    );
    const done = t.ended();
    await t.orchestrator.start(t.session, 'Oi');
    await done;
    expect(t.calls.map((c) => c.model)).toEqual(['big', 'big', 'big', 'small']);
    expect(t.store.listRuns('s')[0].failure?.why).toMatch(/texto já exibido/);
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('applies to the failing delegated call of a coordinated run', async () => {
    const t = setup(
      async (input) => {
        if (input.prompt.includes('Produza somente JSON válido'))
          return {
            text: JSON.stringify({
              tasks: [{ id: 't1', title: 'Fazer', instructions: 'x', scope: [], dependsOn: [] }],
            }),
            stopReason: 'completed',
          };
        if (input.model === 'big' && input.prompt.includes('executor delegado')) throw new Error('overloaded_error');
        return { text: `feito por ${input.model}`, stopReason: 'completed' };
      },
      { coordinated: true, fallback: { enabled: true, models: [{ providerId: 'codex', model: 'small' }] } },
    );
    const done = t.ended();
    await t.orchestrator.start(t.session, 'Implemente um endpoint para esta aplicação');
    await done;
    const run = t.store.listRuns('s')[0];
    expect(run).toMatchObject({ status: 'completed', fallback: { to: { model: 'small' } } });
    const worker = t.store.listSessionTasks('s', 10).find((task) => task.role === 'worker');
    expect(worker).toMatchObject({ status: 'completed', model: 'small' });
    expect(t.store.listEvents('s').find((e) => e.type === 'fallback')?.text).toMatch(/\(Fazer\)$/);
    expect(t.store.getSession('s')?.model).toBe('big');
    await t.orchestrator.shutdown();
    t.store.close();
  });
});

describe('POST /api/runs/:id/retry', () => {
  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    });

  it('validates the target and refuses while a run is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(async (input) => {
      if (input.prompt.includes('[esperar]')) await gate;
      return { text: 'ok', stopReason: 'completed' };
    });
    const base = await t.base();
    expect((await post(base, '/api/runs/nope/retry', {})).status).toBe(404);
    let done = t.ended();
    const first = await t.orchestrator.start(t.session, 'Oi');
    await done;
    const path = `/api/runs/${first.runId}/retry`;
    const bad = await post(base, path, { providerId: 'gemini' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('providerId inválido');
    const unknown = await post(base, path, { model: 'nope' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe('Modelo não anunciado para este provedor');
    const unavailable = await post(base, path, { providerId: 'kiro', model: 'k1' });
    expect(unavailable.status).toBe(400);
    expect((await unavailable.json()).error).toBe('Kiro não instalado');
    expect(t.store.getSession('s')).toMatchObject({ providerId: 'codex', model: 'big' });

    done = t.ended();
    await t.orchestrator.start(t.store.getSession('s')!, '[esperar]');
    const busy = await post(base, path, { model: 'small' });
    expect(busy.status).toBe(409);
    expect(t.store.getSession('s')?.model).toBe('big');
    release();
    await done;
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('switches the conversation to another provider and resends with history, without the native session', async () => {
    const t = setup(
      async (input, emit) => {
        if (input.model === 'big') throw new Error('overloaded');
        emit({ type: 'delta', text: 'resposta nova' });
        return { text: 'resposta nova', stopReason: 'completed' };
      },
      { session: { thinking: 'high' } },
    );
    const base = await t.base();
    let done = t.ended();
    const failed = await t.orchestrator.start(t.session, 'Pergunta difícil');
    await done;
    expect(t.store.getRun(failed.runId)).toMatchObject({ status: 'failed', failure: { kind: 'overloaded' } });
    t.calls.length = 0;
    done = t.ended();
    const res = await post(base, `/api/runs/${failed.runId}/retry`, { providerId: 'claude', model: 'c1' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.session).toMatchObject({ providerId: 'claude', model: 'c1', thinking: 'auto' });
    expect(body.session.nativeSessionId).toBeUndefined();
    await done;
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ providerId: 'claude', model: 'c1' });
    expect(t.calls[0].nativeSessionId).toBeUndefined();
    expect(t.calls[0].prompt).toContain('Pergunta difícil');
    // The failed exchange stays in the history the new provider receives.
    expect(t.calls[0].history.map((m) => m.content)).toContain('Pergunta difícil');
    expect(t.store.getRun(body.runId)).toMatchObject({ status: 'completed', providerId: 'claude', model: 'c1' });
    const s = t.store.getSession('s')!;
    expect(s).toMatchObject({ providerId: 'claude', model: 'c1' });
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('repeats with the same model when no target is given, and keeps the native session', async () => {
    const t = setup(async () => ({ text: 'ok', stopReason: 'completed' }));
    const base = await t.base();
    let done = t.ended();
    const first = await t.orchestrator.start(t.session, 'Oi');
    await done;
    t.calls.length = 0;
    done = t.ended();
    const res = await post(base, `/api/runs/${first.runId}/retry`, {});
    expect(res.status).toBe(202);
    await done;
    expect(t.calls[0]).toMatchObject({ providerId: 'codex', model: 'big', nativeSessionId: 'native-1' });
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('switching model within the provider keeps the thinking it supports and drops the native session', async () => {
    const t = setup(async () => ({ text: 'ok', stopReason: 'completed' }), { session: { thinking: 'low' } });
    let done = t.ended();
    const first = await t.orchestrator.start(t.session, 'Oi');
    await done;
    done = t.ended();
    const started = await t.orchestrator.retryRun(first.runId, { model: 'small' });
    await done;
    expect(started.session).toMatchObject({ providerId: 'codex', model: 'small', thinking: 'low' });
    expect(started.session.nativeSessionId).toBeUndefined();
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('puts the conversation back when the new run cannot start', async () => {
    const t = setup(async () => ({ text: 'ok', stopReason: 'completed' }));
    const done = t.ended();
    const first = await t.orchestrator.start(t.session, 'Oi');
    await done;
    // start() refuses once the orchestrator is shutting down: the switch must be undone.
    await t.orchestrator.shutdown();
    await expect(t.orchestrator.retryRun(first.runId, { providerId: 'claude' })).rejects.toThrow(/encerrando/);
    expect(t.store.getSession('s')).toMatchObject({ providerId: 'codex', model: 'big', nativeSessionId: 'native-1' });
    t.store.close();
  });
});
