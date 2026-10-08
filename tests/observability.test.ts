import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservabilityRunSummary } from '../shared/observability.js';
import { observabilityRoutes } from '../server/http/observability.js';
import { Store } from '../server/store.js';
import { createBackend } from '../server/index.js';
import { createObservability } from '../server/observability.js';

const cleanup: (() => void)[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dispose of cleanup.splice(0)) dispose();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-observability-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanup.push(() => store.close());
  store.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('project-a', '{}');
  store.putSession({
    id: 'session-a',
    projectId: 'project-a',
    title: 'Private title',
    providerId: 'codex',
    mode: 'auto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const app = express();
  app.use(express.json());
  app.use(observabilityRoutes({ store, providerList: async () => [] } as never));
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  return { store, server };
}

const run = (n: number, updates: Partial<ObservabilityRunSummary> = {}): ObservabilityRunSummary => ({
  runId: `run-${n}`,
  traceId: `run-${n}`,
  sessionId: 'session-a',
  projectId: 'project-a',
  providerId: 'codex',
  status: 'success',
  startedAt: new Date(Date.now() - n * 1000).toISOString(),
  completedAt: new Date(Date.now() - n * 1000 + 500).toISOString(),
  durationMs: 500,
  firstTokenMs: 100,
  usage: { inputTokens: 10, outputTokens: 20, costUsd: null },
  error: null,
  ...updates,
});

async function base(server: Server) {
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('observability store and API', () => {
  it('queries all matching history in SQL and paginates beyond the activity screen cap', async () => {
    const { store, server } = setup();
    for (let n = 0; n < 135; n++) store.upsertObservabilityRun(run(n));
    const origin = await base(server);
    const response = await fetch(
      `${origin}/api/observability?projectId=project-a&providerId=codex&limit=20&offset=100`,
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pagination).toEqual({ offset: 100, limit: 20, total: 135 });
    expect(data.runs).toHaveLength(20);
    expect(data.overview.totals.runs).toBe(135);
    expect(data.overview.durationMs).toEqual({ p50: 500, p95: 500 });
    expect(data.overview.usage).toEqual({ inputTokens: 1350, outputTokens: 2700, costUsd: null });
  });

  it('filters component and status, and the trace contains metadata without prompt or error text', async () => {
    const { store, server } = setup();
    store.upsertObservabilityRun(run(1, { status: 'error', error: 'PRIVATE_FAILURE_TOKEN' }));
    store.recordObservabilityEvent({
      runId: 'run-1',
      traceId: 'run-1',
      sessionId: 'session-a',
      projectId: 'project-a',
      at: new Date().toISOString(),
      name: 'provider.call',
      component: 'provider',
      kind: 'span',
      status: 'error',
      attributes: {
        operation: 'completion',
        prompt: 'PRIVATE_PROMPT_TOKEN',
        command: 'PRIVATE_COMMAND_TOKEN',
        reason: 'PRIVATE_FAILURE_TOKEN',
      },
    });
    store.addEvent({
      id: 'approval-event',
      runId: 'run-1',
      sessionId: 'session-a',
      type: 'approval',
      text: 'PRIVATE_APPROVAL_TEXT',
      createdAt: new Date().toISOString(),
      status: 'approved',
      decision: { source: 'automatic' },
    });
    store.upsertObservabilityRun(run(2, { projectId: 'other-project' }));
    const origin = await base(server);
    const response = await fetch(`${origin}/api/observability?projectId=project-a&status=error&component=provider`);
    const data = await response.json();
    expect(data.pagination.total).toBe(1);
    expect(data.runs[0].error).toBe('A execução falhou');
    const trace = await (await fetch(`${origin}/api/observability/runs/run-1`)).json();
    expect(trace.events.some((event: { component: string }) => event.component === 'provider')).toBe(true);
    expect(
      trace.events.some((event: { attributes: Record<string, unknown> }) => event.attributes.decision === 'automatic'),
    ).toBe(true);
    const serialized = JSON.stringify(trace) + JSON.stringify(data);
    expect(serialized).not.toContain('PRIVATE_PROMPT_TOKEN');
    expect(serialized).not.toContain('PRIVATE_COMMAND_TOKEN');
    expect(serialized).not.toContain('PRIVATE_FAILURE_TOKEN');
    expect(serialized).not.toContain('PRIVATE_APPROVAL_TEXT');
  });

  it('returns null for unknown per-run usage and rejects malformed filters and arbitrary client data', async () => {
    const { store, server } = setup();
    store.upsertObservabilityRun(run(3, { usage: null }));
    const origin = await base(server);
    const data = await (await fetch(`${origin}/api/observability`)).json();
    expect(data.runs[0].usage).toBeNull();
    expect(data.overview.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
    expect((await fetch(`${origin}/api/observability?since=not-a-date`)).status).toBe(400);
    const clientEvent = await fetch(`${origin}/api/observability/client-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ui.error', text: 'secret' }),
    });
    expect(clientEvent.status).toBe(400);
  });

  it('preserves failed tools and waiting approvals as metadata outcomes', () => {
    const { store } = setup();
    for (const [id, type, status] of [
      ['failed-tool', 'tool', 'failed'],
      ['pending-approval', 'approval', 'pending'],
      ['blocked-approval', 'approval', 'blocked'],
    ] as const)
      store.addEvent({
        id,
        type,
        status,
        runId: 'event-run',
        sessionId: 'session-a',
        text: 'PRIVATE_CONTENT',
        createdAt: new Date().toISOString(),
      });
    expect(store.db.prepare("SELECT status FROM observability_events WHERE id='blocked-approval'").get()).toMatchObject(
      { status: 'error' },
    );
    expect(store.db.prepare("SELECT status FROM observability_events WHERE id='failed-tool'").get()).toMatchObject({
      status: 'error',
    });
    expect(store.db.prepare("SELECT status FROM observability_events WHERE id='pending-approval'").get()).toMatchObject(
      { status: 'queued' },
    );
  });

  it('keeps partial usage totals unknown rather than displaying a reported subtotal as complete', async () => {
    const { store, server } = setup();
    store.upsertObservabilityRun(run(1, { usage: { inputTokens: 10, outputTokens: 20, costUsd: 1 } }));
    store.upsertObservabilityRun(run(2, { usage: { inputTokens: 30, outputTokens: null, costUsd: null } }));
    const data = await (await fetch(`${await base(server)}/api/observability`)).json();
    expect(data.overview.usage).toEqual({ inputTokens: 40, outputTokens: null, costUsd: null });
    expect(data.runs.find((row: { runId: string }) => row.runId === 'run-1').usage.costUsd).toBe(1);
  });

  it('uses nearest-rank percentiles for a small sample', async () => {
    const { store, server } = setup();
    store.upsertObservabilityRun(run(1, { durationMs: 100 }));
    store.upsertObservabilityRun(run(2, { durationMs: 200 }));
    const origin = await base(server);
    const data = await (await fetch(`${origin}/api/observability`)).json();
    expect(data.overview.durationMs).toEqual({ p50: 100, p95: 200 });
  });

  it('prunes events older than thirty days and scopes async contexts to the bound store', async () => {
    const first = setup();
    const second = setup();
    const obsA = createObservability(first.store);
    const obsB = createObservability(second.store);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    first.store.recordObservabilityEvent({
      runId: 'old',
      sessionId: 'session-a',
      at: old,
      name: 'old.event',
      component: 'ui',
      status: 'success',
    });
    for (let n = 0; n < 99; n++)
      first.store.recordObservabilityEvent({
        runId: 'new',
        sessionId: 'session-a',
        at: new Date().toISOString(),
        name: 'new.event',
        component: 'ui',
        status: 'success',
      });
    await obsA.withObservationContext({ runId: 'scoped-a', sessionId: 'session-a' }, async () => {
      await obsA.withObservation('inside', 'http', {}, async () => undefined);
      await obsB.withObservation('other-store', 'http', { runId: 'other-store' }, async () => undefined);
    });
    expect(
      first.store.db
        .prepare('SELECT COUNT(*) n FROM observability_events WHERE at < ?')
        .get(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ).toMatchObject({ n: 0 });
    expect(
      first.store.db.prepare("SELECT COUNT(*) n FROM observability_events WHERE run_id='scoped-a'").get(),
    ).toMatchObject({ n: 1 });
    expect(
      second.store.db.prepare("SELECT COUNT(*) n FROM observability_events WHERE run_id='scoped-a'").get(),
    ).toMatchObject({ n: 0 });
    expect(
      second.store.db.prepare("SELECT COUNT(*) n FROM observability_events WHERE run_id='other-store'").get(),
    ).toMatchObject({ n: 1 });
  });

  it('keeps at most ten thousand local trace events', () => {
    const { store } = setup();
    const at = new Date().toISOString();
    for (let n = 0; n < 10_050; n++)
      store.recordObservabilityEvent({
        id: `event-${n}`,
        runId: 'bounded',
        sessionId: 'session-a',
        at,
        name: 'bounded.event',
        component: 'ui',
        status: 'success',
      });
    expect(store.db.prepare('SELECT COUNT(*) n FROM observability_events').get()).toMatchObject({ n: 10_000 });
  });

  it('removes observation mirrors when their conversation is deleted', () => {
    const { store } = setup();
    store.upsertObservabilityRun(run(1));
    store.deleteSession('session-a');
    expect(store.db.prepare('SELECT COUNT(*) n FROM observability_runs').get()).toMatchObject({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) n FROM observability_events').get()).toMatchObject({ n: 0 });
  });
  it('marks returned provider failures and cancellations without changing results', async () => {
    const { store } = setup();
    const obs = createObservability(store);
    const result = await obs.withObservation(
      'provider.run',
      'provider',
      { runId: 'failed', sessionId: 'session-a' },
      async () => ({ status: 'failed', error: 'PRIVATE_OUTPUT' }),
    );
    expect(result.status).toBe('failed');
    expect(
      store.db.prepare("SELECT status,attributes FROM observability_events WHERE run_id='failed'").get(),
    ).toMatchObject({ status: 'error', attributes: '{}' });
    await expect(
      obs.withObservation('ssh.tool', 'ssh', { runId: 'cancelled', sessionId: 'session-a' }, async () => {
        throw Object.assign(new Error('PRIVATE_CANCEL'), { cancelled: true });
      }),
    ).rejects.toThrow('PRIVATE_CANCEL');
    expect(store.db.prepare("SELECT status FROM observability_events WHERE run_id='cancelled'").get()).toMatchObject({
      status: 'cancelled',
    });
  });
  it('returns recent component events that have no conversation run, without request content', async () => {
    const { server } = setup();
    const url = await base(server);
    await fetch(url + '/api/observability/client-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ui.error', status: 'error' }),
    });
    const report = await (await fetch(url + '/api/observability?component=ui')).json();
    expect(report.recentEvents).toHaveLength(1);
    expect(report.recentEvents[0]).toMatchObject({ name: 'ui.error', status: 'error', attributes: {} });
    expect(report.pagination.total).toBe(0);
  });
});

it('repairs active telemetry after restart alongside the operational run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-observability-restart-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Store(dir);
  first.putSession({
    id: 'restart-session',
    projectId: null,
    title: 'Private',
    providerId: 'codex',
    mode: 'auto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  first.putRun({
    id: 'restart-run',
    route: { level: 'fast', reason: 'Restart test', tools: false, memory: false, effort: 'low', contextBudget: 0 },
    sessionId: 'restart-session',
    providerId: 'codex',
    status: 'running',
    startedAt: new Date(Date.now() - 2000).toISOString(),
  });
  first.recordObservabilityEvent({
    id: 'unfinished-provider',
    runId: 'restart-run',
    sessionId: 'restart-session',
    at: new Date(Date.now() - 1000).toISOString(),
    name: 'provider.run',
    component: 'provider',
    kind: 'span',
    status: 'running',
  });
  first.close();
  const second = new Store(dir);
  cleanup.push(() => second.close());
  expect(second.getRun('restart-run')?.status).toBe('interrupted');
  expect(second.db.prepare("SELECT status FROM observability_runs WHERE run_id='restart-run'").get()).toMatchObject({
    status: 'error',
  });
  expect(
    second.db.prepare("SELECT status,duration_ms FROM observability_events WHERE id='unfinished-provider'").get(),
  ).toMatchObject({ status: 'error', duration_ms: expect.any(Number) });
  expect(second.db.prepare("SELECT COUNT(*) n FROM observability_events WHERE status='running'").get()).toMatchObject({
    n: 0,
  });
});

it('does not copy arbitrary request path identifiers into HTTP telemetry', async () => {
  const { store } = setup();
  const backend = createBackend(store, { list: async () => [] } as never);
  const server = createServer(backend.app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  const origin = await base(server);
  const privateId = 'PRIVATE_REQUEST_PATH_CANARY';
  expect((await fetch(`${origin}/api/projects/${privateId}/files`)).status).toBe(404);
  const data = await (await fetch(`${origin}/api/observability`)).json();
  expect(data.recentEvents.some((event: { name: string }) => event.name === 'http.request')).toBe(true);
  expect(JSON.stringify(data)).not.toContain(privateId);
});
