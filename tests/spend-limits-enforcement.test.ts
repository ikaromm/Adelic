import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { COMPACTION_PROMPT_MARKER } from '../server/compaction.js';
import { HANDOFF_PROMPT_MARKER } from '../server/provider-handoff.js';
import { PLAN_PROMPT_MARKER, TASK_PROMPT_MARKER } from '../server/plan-markdown.js';
import type { ProviderInfo, ProviderRegistry, RunInput, Session, Settings } from '../shared/contracts.js';

// Usage limits enforced at every model-calling entry point (docs/specs/spend-limits.md),
// against the real backend with a scripted provider.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-limits-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const caps = { fast: true, tools: true, approvals: true, cancel: true, reasoning: true };
const provider = (id: 'codex' | 'kiro', models: string[]): ProviderInfo => ({
  id,
  name: id === 'codex' ? 'Codex' : 'Kiro',
  installed: true,
  available: true,
  status: 'ready',
  detail: '',
  models: models.map((m, i) => ({ id: m, name: m, isDefault: i === 0 })),
  defaultModel: models[0],
  capabilities: caps,
});
const LIMIT = 'Limite de uso atingido';

/**
 * Each call reports 100 input + 10 output tokens (no cost, like Codex). `[lento]` waits for the
 * test; the model "busy" is overloaded before any output and reports 50 tokens first.
 */
function scripted() {
  const inputs: RunInput[] = [];
  const waiting: (() => void)[] = [];
  const providers: ProviderRegistry = {
    async list() {
      return [provider('codex', ['big', 'small']), provider('kiro', ['k1'])];
    },
    async run(input, emit, signal) {
      inputs.push(input);
      if (input.model === 'busy') {
        emit({ type: 'usage', inputTokens: 50 });
        throw new Error('Selected model is at capacity. Please try a different model.');
      }
      if (input.prompt.includes('[lento]'))
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      const text = input.prompt.startsWith(PLAN_PROMPT_MARKER)
        ? '# Plano\n\n## Tarefas\n- [ ] Um\n- [ ] Dois\n'
        : input.prompt.startsWith(HANDOFF_PROMPT_MARKER)
          ? 'Resumo da passagem'
          : input.prompt.startsWith(COMPACTION_PROMPT_MARKER)
            ? '## Objetivo\nResumo'
            : 'resposta';
      emit({ type: 'delta', text });
      emit({ type: 'usage', inputTokens: 100, outputTokens: 10 });
      return { text, stopReason: signal.aborted ? 'cancelled' : 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  return {
    providers,
    inputs,
    release: () => waiting.shift()?.(),
    calls: (marker?: string) => inputs.filter((i) => (marker ? i.prompt.startsWith(marker) : true)).length,
  };
}

async function setup(over: Partial<Settings> = {}, orchestration = false) {
  const store = new Store(tempDir());
  const now = new Date().toISOString();
  store.putProject({
    id: 'p',
    name: 'P',
    path: tempDir(),
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: { enabled: orchestration, maxWorkers: 1, review: false },
  });
  store.setSettings({ ...store.getSettings()!, autoRetry: false, ...over });
  const session: Session = {
    id: 's',
    projectId: 'p',
    title: 'Nova conversa',
    providerId: 'codex',
    mode: 'auto',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const p = scripted();
  const { app, orchestrator } = createBackend(store, p.providers, undefined, undefined, {
    retries: 0,
    baseDelayMs: 1,
    maxDelayMs: 1,
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    await orchestrator.shutdown();
    await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in assertions
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  const idle = async () => {
    for (let i = 0; i < 400 && (orchestrator.isActive('s') || store.getSession('s')!.activeRunId); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(orchestrator.isActive('s')).toBe(false);
  };
  const send = async (content: string, extra: Record<string, unknown> = {}) => {
    const response = await call('POST', '/api/sessions/s/messages', { content, ...extra });
    await idle();
    return response;
  };
  /** Turns the limits on with a daily token limit (each call uses 110 tokens). */
  const limit = (dailyTokens: number, extra: Record<string, unknown> = {}) =>
    call('PATCH', '/api/settings', { spendLimits: { enabled: true, dailyTokens, ...extra } });
  return { store, orchestrator, provider: p, call, idle, send, limit };
}

describe('enforcement', () => {
  it('refuses a new message once a limit is reached, before any provider call, and overrides once', async () => {
    const t = await setup();
    expect((await t.send('um')).status).toBe(202); // limits off by default: never blocked
    expect((await t.limit(110)).body.spendLimits).toEqual({ enabled: true, dailyTokens: 110 });
    const before = t.provider.calls();
    const refused = await t.send('dois');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'spend_limit',
      error: "Limite de uso atingido: tokens hoje (110/110). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
      limit: { kind: 'daily-tokens', used: 110, limit: 110 },
    });
    expect(t.provider.calls()).toBe(before);
    expect(t.store.listMessages('s')).toHaveLength(2); // no run, no message
    // "Continuar mesmo assim": that one message only.
    expect((await t.send('dois', { overrideLimit: true })).status).toBe(202);
    expect(t.provider.calls()).toBe(before + 1);
    expect((await t.send('três')).status).toBe(409);
    // Never persisted anywhere.
    expect(JSON.stringify(t.store.listRuns('s'))).not.toContain('overrideLimit');
    expect(JSON.stringify(t.store.getSettings())).not.toContain('overrideLimit');
    // Raising the limit unblocks.
    await t.limit(10_000);
    expect((await t.send('quatro')).status).toBe(202);
  });

  it('never stops a run in progress, and refuses the next', async () => {
    const t = await setup();
    await t.limit(1);
    const started = await t.call('POST', '/api/sessions/s/messages', { content: '[lento] longo', overrideLimit: true });
    expect(started.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    t.provider.release();
    await t.idle();
    expect(t.store.getRun(started.body.runId)).toMatchObject({ status: 'completed', inputTokens: 100 });
    expect((await t.send('outra')).status).toBe(409);
  });

  it('checks edit and resend, retry and compaction', async () => {
    const t = await setup();
    const first = await t.send('primeira');
    await t.limit(110);
    const message = t.store.listMessages('s').find((m) => m.role === 'user')!;
    expect((await t.call('POST', `/api/sessions/s/messages/${message.id}/edit`, { content: 'editada' })).status).toBe(
      409,
    );
    expect((await t.call('POST', `/api/runs/${first.body.runId}/retry`, {})).body.code).toBe('spend_limit');
    expect((await t.call('POST', '/api/sessions/s/compact', {})).status).toBe(409);
    expect((await t.call('POST', '/api/sessions/s/messages', { content: '/compactar' })).status).toBe(409);
    expect(t.provider.calls()).toBe(1);
    const compacted = await t.call('POST', '/api/sessions/s/compact', { overrideLimit: true });
    expect(compacted.status).toBe(202);
    await t.idle();
    // The compaction's own usage is recorded on its run and counted.
    expect(t.store.getRun(compacted.body.runId)).toMatchObject({ compaction: { auto: false }, inputTokens: 100 });
    expect((await t.call('GET', '/api/usage')).body.today.tokens).toBe(220);
    const retried = await t.call('POST', `/api/runs/${first.body.runId}/retry`, { overrideLimit: true });
    expect(retried.status).toBe(202);
    await t.idle();
    const edited = await t.call('POST', `/api/sessions/s/messages/${message.id}/edit`, {
      content: 'editada',
      overrideLimit: true,
    });
    expect(edited.status).toBe(202);
    await t.idle();
  });

  it('checks the handoff summary only when it calls a model, and records its usage', async () => {
    const t = await setup();
    await t.send('primeira');
    await t.limit(110);
    const refused = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    expect(refused).toMatchObject({ status: 409, body: { code: 'spend_limit' } });
    expect(t.store.getSession('s')!.providerId).toBe('codex'); // nothing switched
    // Without a model call nothing is checked.
    expect((await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'local' })).status).toBe(
      202,
    );
    await t.call('PATCH', '/api/sessions/s', { providerId: 'codex' });
    const accepted = await t.call('POST', '/api/sessions/s/handoff', {
      providerId: 'kiro',
      summary: 'model',
      overrideLimit: true,
    });
    expect(accepted.status).toBe(202);
    expect(t.provider.calls(HANDOFF_PROMPT_MARKER)).toBe(1);
    const summaryRun = t.store.listRuns('s').find((r) => r.handoff)!;
    expect(summaryRun).toMatchObject({ status: 'completed', inputTokens: 100, outputTokens: 10 });
    expect((await t.call('GET', '/api/usage')).body.today).toMatchObject({ tokens: 220, runs: 2 });
  });

  it('checks plan approval; the override lets only the first task through', async () => {
    const t = await setup();
    await t.send('/plano exportar relatório');
    const [plan] = t.orchestrator.plans.list('s');
    expect(plan.tasks).toHaveLength(2);
    await t.limit(110);
    const refused = await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    expect(refused).toMatchObject({ status: 409, body: { code: 'spend_limit' } });
    expect(t.orchestrator.plans.list('s')[0].status).toBe('draft');
    const approved = await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all', overrideLimit: true });
    expect(approved.status).toBe(202);
    await t.idle();
    await new Promise((r) => setTimeout(r, 30));
    await t.idle();
    expect(t.provider.calls(TASK_PROMPT_MARKER)).toBe(1);
    const after = t.orchestrator.plans.list('s')[0];
    expect(after.tasks.map((task) => task.status)).toEqual(['done', 'pending']);
    expect(after).toMatchObject({ status: 'approved', error: expect.stringContaining(LIMIT) });
  });

  it('counts coordinated tasks and the per-project monthly limit', async () => {
    const t = await setup({}, true);
    await t.send('Implemente a alteração no projeto');
    const run = t.store.listRuns('s')[0];
    const tasks = t.store.listSessionTasks('s').filter((task) => task.runId === run.id);
    expect(tasks.length).toBeGreaterThan(1);
    // Every delegated call reported 100 + 10; the run carries their sum.
    expect(run.inputTokens).toBe(100 * tasks.length);
    expect((await t.call('GET', '/api/usage?projectId=p')).body.project.month.tokens).toBe(110 * tasks.length);
    await t.call('PATCH', '/api/settings', { spendLimits: { enabled: true } });
    expect(
      (await t.call('PATCH', '/api/projects/p', { spendLimits: { monthlyTokens: 100 } })).body.spendLimits,
    ).toEqual({ monthlyTokens: 100 });
    const refused = await t.send('mais');
    expect(refused.body.error).toMatch(/tokens do projeto no mês/);
    // A detached conversation is not bound by the project's limit.
    const detached = await t.call('POST', '/api/sessions', { projectId: null, providerId: 'codex' });
    expect((await t.call('POST', `/api/sessions/${detached.body.id}/messages`, { content: 'avulsa' })).status).toBe(
      202,
    );
    expect((await t.call('PATCH', '/api/projects/p', { spendLimits: { monthlyTokens: null } })).body.spendLimits).toBe(
      undefined,
    );
    expect((await t.call('PATCH', '/api/projects/p', { spendLimits: { monthlyCostUsd: 2 } })).body.spendLimits).toEqual(
      { monthlyCostUsd: 2 },
    );
    expect((await t.call('PATCH', '/api/projects/p', { spendLimits: null })).body.spendLimits).toBeUndefined();
  });

  it('counts the usage of an overloaded attempt and of the model that answered instead', async () => {
    const t = await setup({ modelFallback: { enabled: true, models: [{ providerId: 'codex', model: 'small' }] } });
    await t.call('PATCH', '/api/sessions/s', { model: 'big' });
    // Make the conversation's model the overloaded one.
    t.store.putSession({ ...t.store.getSession('s')!, model: 'busy' });
    await t.send('olá');
    const run = t.store.listRuns('s')[0];
    expect(run).toMatchObject({ status: 'completed', fallback: { to: { model: 'small' } } });
    expect(run).toMatchObject({ inputTokens: 150, outputTokens: 10 });
  });
});

describe('queue', () => {
  it('pauses with reason limit, keeps the message and continues once with the override', async () => {
    const t = await setup();
    await t.limit(220);
    const running = await t.call('POST', '/api/sessions/s/messages', { content: '[lento] primeira' });
    expect(running.status).toBe(202);
    await t.call('POST', '/api/sessions/s/queue', { content: 'segunda' });
    await t.call('POST', '/api/sessions/s/queue', { content: 'terceira' });
    t.provider.release(); // 110 tokens: the second starts (below 220)
    await new Promise((r) => setTimeout(r, 30));
    await t.idle();
    // After the second (220 tokens) the third hits the limit: paused, not failed silently.
    let queue = (await t.call('GET', '/api/sessions/s/queue')).body;
    expect(queue.items.map((i: { content: string }) => i.content)).toEqual(['terceira']);
    expect(queue.paused).toMatchObject({ reason: 'limit', error: expect.stringContaining(LIMIT) });
    // "Retomar fila" checks again: still paused.
    await t.call('POST', '/api/sessions/s/queue/resume', {});
    queue = (await t.call('GET', '/api/sessions/s/queue')).body;
    expect(queue.paused?.reason).toBe('limit');
    // "Continuar mesmo assim": the next item only.
    await t.call('POST', '/api/sessions/s/queue', { content: 'quarta' });
    const resumed = await t.call('POST', '/api/sessions/s/queue/resume', { overrideLimit: true });
    expect(resumed.body.started).toBeTruthy();
    await t.idle();
    await new Promise((r) => setTimeout(r, 30));
    queue = (await t.call('GET', '/api/sessions/s/queue')).body;
    expect(queue.items.map((i: { content: string }) => i.content)).toEqual(['quarta']);
    expect(queue.paused?.reason).toBe('limit');
    expect((await t.call('POST', '/api/sessions/s/queue/resume', { overrideLimit: 'x' })).status).toBe(400);
  });

  it('honours the override on a message that starts right away and on send-now', async () => {
    const t = await setup();
    await t.send('um');
    await t.limit(110);
    const queued = await t.call('POST', '/api/sessions/s/queue', { content: 'dois', overrideLimit: true });
    expect(queued.status).toBe(202);
    await t.idle();
    const now = await t.call('POST', '/api/sessions/s/send-now', { content: 'três', overrideLimit: true });
    expect(now.status).toBe(202);
    await t.idle();
    const refused = await t.call('POST', '/api/sessions/s/send-now', { content: 'quatro' });
    expect(refused.status).toBe(202); // the queue route accepts; the start is refused and pauses
    await t.idle();
    expect((await t.call('GET', '/api/sessions/s/queue')).body.paused?.reason).toBe('limit');
    expect(t.provider.calls()).toBe(3);
  });
});

describe('routes', () => {
  it('GET /api/usage reports totals, limits and warnings; settings merge and validate', async () => {
    const t = await setup();
    await t.send('um');
    const empty = await t.call('GET', '/api/usage');
    expect(empty.body).toMatchObject({
      today: { tokens: 110, costUsd: null, runs: 1, runsWithoutCost: 1 },
      limits: { enabled: false },
      warnings: [],
      reached: [],
    });
    expect((await t.call('GET', '/api/usage?projectId=nope')).status).toBe(404);
    await t.limit(130, { monthlyCostUsd: 5 });
    // Merged field by field; null clears one.
    expect((await t.call('PATCH', '/api/settings', { spendLimits: { dailyCostUsd: 1.5 } })).body.spendLimits).toEqual({
      enabled: true,
      dailyTokens: 130,
      monthlyCostUsd: 5,
      dailyCostUsd: 1.5,
    });
    expect(
      (await t.call('PATCH', '/api/settings', { spendLimits: { monthlyCostUsd: null } })).body.spendLimits,
    ).toEqual({ enabled: true, dailyTokens: 130, dailyCostUsd: 1.5 });
    const warned = (await t.call('GET', '/api/usage?projectId=p')).body;
    expect(warned.warnings.map((w: { kind: string; percent: number }) => [w.kind, w.percent])).toEqual([
      ['daily-tokens', 84],
    ]);
    expect(warned.reached).toEqual([]);
    expect(warned.project.today.tokens).toBe(110);
    expect((await t.call('PATCH', '/api/settings', { spendLimits: { dailyTokens: -5 } })).status).toBe(400);
    expect((await t.call('PATCH', '/api/settings', { spendLimits: { dailyCostUsd: 0.001 } })).status).toBe(400);
    expect((await t.call('PATCH', '/api/projects/p', { spendLimits: { monthlyTokens: 1.5 } })).status).toBe(400);
    expect((await t.call('POST', '/api/sessions/s/messages', { content: 'x', overrideLimit: 1 })).status).toBe(400);
    expect((await t.call('POST', '/api/sessions/s/compact', { overrideLimit: 'sim' })).status).toBe(400);
  });
});
