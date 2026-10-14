import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import type { ProviderRegistry, Run, Session } from '../shared/contracts.js';

const resources: { server: Server; store: Store; shutdown: () => Promise<void>; dir: string }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await item.shutdown();
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    item.store.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-run-artifacts-http-'));
  const root = join(dir, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'result.txt'), 'project result');
  writeFileSync(join(root, 'unlisted.txt'), 'not an artifact');
  const store = new Store(dir);
  const now = new Date().toISOString();
  const session: Session = {
    id: 'session-artifacts',
    projectId: null,
    title: 'Artifacts',
    providerId: 'codex',
    mode: 'fast',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const run: Run = {
    id: '2fa9bd61-5bd7-4cfe-a395-1b9f4f1ad82d',
    sessionId: session.id,
    providerId: 'codex',
    status: 'completed',
    route: { level: 'fast', reason: 'test', tools: true, memory: false, contextBudget: 6000 },
    startedAt: now,
    completedAt: now,
    artifactRoot: root,
    artifacts: { status: 'available', files: [{ path: 'result.txt', status: 'added' }], capturedAt: now },
  };
  store.putRun(run);
  const providers: ProviderRegistry = {
    list: async () => [],
    run: async () => ({ text: '', stopReason: 'completed' }),
    approve: async () => undefined,
    shutdown: async () => undefined,
  };
  const backend = createBackend(store, providers, undefined, {
    bind: '127.0.0.2',
    port: 4318,
    token: 'artifact-test-token-with-at-least-32-characters',
  });
  await backend.orchestrator.runEvidence.put({
    runId: run.id,
    sessionId: session.id,
    capturedAt: now,
    source: { state: 'unknown' },
    environment: [],
    artifacts: run.artifacts,
    checks: [
      {
        eventId: 'failed-check-event',
        name: 'tests',
        status: 'failed',
        exitCode: 1,
        command: 'npm test',
        output: 'private failure log',
        source: null,
        environment: null,
      },
    ],
    outcome: { status: 'completed' },
    review: 'bounded review excerpt',
    fullReview: 'bounded review excerpt ... HTTP-FINAL-ONLY-MARKER',
  });
  const server = createServer(backend.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push({
    server,
    store,
    shutdown: async () => {
      await backend.orchestrator.shutdown();
      backend.access.stop();
    },
    dir,
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, remote = false) =>
    fetch(base + path, {
      headers: remote
        ? {
            'tailscale-user-login': 'owner@example.test',
            authorization: 'Bearer artifact-test-token-with-at-least-32-characters',
          }
        : { origin: base },
    });
  const file = (path: string) => `/api/runs/${run.id}/artifacts/file?path=${encodeURIComponent(path)}`;
  return { dir, root, run, store, backend, get, file };
}

describe('run artifact HTTP access', () => {
  it('serves only listed current files locally without caching their contents', async () => {
    const { get, file, run } = await setup();
    const listing = await get(`/api/runs/${run.id}/artifacts`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ files: [{ path: 'result.txt', status: 'added' }] });

    const allowed = await get(file('result.txt'));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(await allowed.json()).toEqual({ path: 'result.txt', content: 'project result', truncated: false });

    expect((await get(file('unlisted.txt'))).status).toBe(404);
    expect((await get(file('../result.txt'))).status).toBe(404);
  });

  it('refuses artifact metadata and content to a nonlocal client', async () => {
    const { get, file, run } = await setup();
    expect((await get(`/api/runs/${run.id}/artifacts`, true)).status).toBe(403);
    expect((await get(file('result.txt'), true)).status).toBe(403);
  });

  it('serves persisted evidence indexes compactly and raw check logs only on an authorized request', async () => {
    const { get, run, backend } = await setup();
    const persisted = await backend.orchestrator.runEvidence.get(run.id);
    expect(persisted).toMatchObject({ outcome: { status: 'completed' }, checks: [{ status: 'failed', exitCode: 1 }] });
    const indexResponse = await get(`/api/runs/${run.id}/evidence`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get('cache-control')).toBe('no-store');
    const index = await indexResponse.json();

    expect(index.checks[0]).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(index.outcome.status).toBe('completed');
    expect(index.review).toBe('bounded review excerpt');
    expect(JSON.stringify(index)).not.toContain('HTTP-FINAL-ONLY-MARKER');
    expect(JSON.stringify(index)).not.toContain('private failure log');
    const reviewPage = await get(`/api/runs/${run.id}/evidence?review=true&offset=22&limit=50`);
    expect(await reviewPage.json()).toMatchObject({ review: ' ... HTTP-FINAL-ONLY-MARKER', nextOffset: null });

    const detail = await get(`/api/runs/${run.id}/evidence?checkEventId=failed-check-event`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ status: 'failed', exitCode: 1, output: 'private failure log' });
    expect((await get(`/api/runs/${run.id}/evidence?checkEventId=unknown`)).status).toBe(404);
    expect((await get(`/api/runs/${run.id}/evidence`, true)).status).toBe(403);
  });

  it('rejects a listed traversal path and a root redirected after the run', async () => {
    const { dir, root, run, store, get, file } = await setup();
    run.artifacts!.files.push({ path: '../secret.txt', status: 'added' });
    store.putRun(run);
    expect((await get(file('../secret.txt'))).status).toBe(409);

    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'result.txt'), 'outside secret');
    renameSync(root, `${root}.old`);
    symlinkSync(outside, root);
    const redirected = await get(file('result.txt'));
    expect(redirected.status).toBe(409);
    expect(await redirected.text()).not.toContain('outside secret');
  });
});
