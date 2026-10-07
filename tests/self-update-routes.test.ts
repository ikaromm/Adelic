// Routes and runtime of "Atualizar Adelic" (docs/specs/self-update.md): loopback only,
// zod-validated bodies, 409 while runs are active, and the restart that waits for the ports.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SelfUpdateStatus, Settings, UpdateProgress } from '../shared/contracts.js';
import { BOOT_ID, type SelfUpdater, type UpdateGuard } from '../server/self-update.js';
import { retryInUse, startServer, type RunningServer } from '../server/runtime.js';

const TOKEN = 'c'.repeat(40);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Raw HTTP so the client can bind 127.0.0.2 (remote for the guard, still on this machine). */
function call(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(url);
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: init.method ?? 'GET',
        localAddress: u.hostname === '127.0.0.2' ? '127.0.0.2' : undefined,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...init.headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fakeUpdater() {
  const seen: { settings?: Settings; guard?: UpdateGuard; options?: unknown } = {};
  const status = (): SelfUpdateStatus => ({
    kind: 'checkout',
    version: '0.4.0',
    bootId: BOOT_ID,
    channel: 'master',
    releaseUrl: 'https://github.com/ikaromm/Adelic/releases',
    available: true,
    canApply: !seen.guard?.block(),
    busy: false,
  });
  const progress: UpdateProgress = { state: 'running', steps: [], log: '' };
  const updater: SelfUpdater = {
    status: vi.fn(async (settings, guard) => ((seen.settings = settings), (seen.guard = guard), status())),
    check: vi.fn(async (settings, guard) => ((seen.guard = guard), status())),
    apply: vi.fn(async (_settings, guard, options) => {
      seen.options = options;
      guard.begin();
      return progress;
    }),
    progress: () => progress,
  };
  return { updater, seen };
}

async function start(updater: SelfUpdater, remote = false) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-update-routes-'));
  const server: RunningServer = await startServer({
    port: 0,
    dataDir: dir,
    selfUpdater: updater,
    remote: remote ? { bind: '127.0.0.2', port: 0, token: TOKEN } : null,
  });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => server.close(),
  );
  return server;
}

const json = { 'content-type': 'application/json' };

describe('update routes', () => {
  it('answer only on this computer: remote requests get 403 even with the token', async () => {
    const { updater } = fakeUpdater();
    const server = await start(updater, true);
    const remote = server.remoteUrl!;
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await call(`${remote}/api/health`, { headers: auth })).status).toBe(200);
    for (const [method, path, body] of [
      ['GET', '/api/update/status', undefined],
      ['GET', '/api/update/progress', undefined],
      ['POST', '/api/update/check', {}],
      ['POST', '/api/update/apply', { confirm: true }],
    ] as const) {
      const res = await call(`${remote}${path}`, { method, headers: auth, body });
      expect(res.status, path).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/neste computador/);
    }
    expect(updater.apply).not.toHaveBeenCalled();
    expect(updater.check).not.toHaveBeenCalled();
    expect((await call(`${server.url}/api/update/status`)).status).toBe(200);
  });

  it('refuse internet requests that arrive on loopback (Tailscale Funnel or serve headers)', async () => {
    const { updater } = fakeUpdater();
    const server = await start(updater);
    for (const headers of <Record<string, string>[]>[
      { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
      { 'x-forwarded-for': '203.0.113.9' },
      { 'tailscale-user-login': 'alguem@example.com' },
    ]) {
      const res = await call(`${server.url}/api/update/apply`, {
        method: 'POST',
        headers: { ...json, origin: server.url, ...headers },
        body: { confirm: true },
      });
      expect([401, 403]).toContain(res.status);
    }
    expect(updater.apply).not.toHaveBeenCalled();
  });

  it('validate bodies and require confirm: true', async () => {
    const { updater, seen } = fakeUpdater();
    const server = await start(updater);
    const post = (path: string, body: unknown) =>
      fetch(`${server.url}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await post('/api/update/apply', {})).status).toBe(400);
    expect((await post('/api/update/apply', { confirm: 'yes' })).status).toBe(400);
    expect((await post('/api/update/apply', { confirm: true, channel: 'main' })).status).toBe(400);
    expect((await post('/api/update/apply', { confirm: true, target: '$(rm)' })).status).toBe(400);
    expect((await post('/api/update/check', { channel: 'nightly' })).status).toBe(400);
    expect((await post('/api/update/check', { extra: 1 })).status).toBe(400);
    expect((await post('/api/update/check', { channel: 'develop' })).status).toBe(200);
    expect(updater.check).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'develop');
    const applied = await post('/api/update/apply', { confirm: true, channel: 'develop', target: 'abcdef1234' });
    expect(applied.status).toBe(202);
    expect(seen.options).toEqual({ channel: 'develop', target: 'abcdef1234' });
  });

  it('pass the saved channel and refuse with 409 while an update holds the orchestrator', async () => {
    const { updater, seen } = fakeUpdater();
    const server = await start(updater);
    await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ updateChannel: 'develop' }),
    });
    expect((await fetch(`${server.url}/api/update/status`)).status).toBe(200);
    expect(seen.settings?.updateChannel).toBe('develop');
    const bad = await fetch(`${server.url}/api/settings`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ updateChannel: 'main' }),
    });
    expect(bad.status).toBe(400);
    const apply = () =>
      fetch(`${server.url}/api/update/apply`, { method: 'POST', headers: json, body: '{"confirm":true}' });
    expect((await apply()).status).toBe(202);
    // The fake never releases: the orchestrator now holds runs and a second update off.
    const second = await apply();
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/atualização já está em andamento/);
    const session = await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: json, body: '{}' });
    const { id } = (await session.json()) as { id: string };
    const message = await fetch(`${server.url}/api/sessions/${id}/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ content: 'oi' }),
    });
    expect(message.status).toBe(409);
    expect((await message.json()).error).toMatch(/sendo atualizado/);
  });
});

describe('restart wait', () => {
  it('retries while the port is in use, then listens once it is free', async () => {
    const blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', done));
    const port = (blocker.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), 'adelic-restart-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(startServer({ port, dataDir: dir, restartWaitMs: 0 })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    setTimeout(() => blocker.close(), 400);
    const started = Date.now();
    const server = await startServer({ port, dataDir: dir, restartWaitMs: 10_000 });
    cleanup.push(() => server.close());
    expect(server.port).toBe(port);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  });

  it('waits for the data lock of the previous process too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-restart-lock-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = await startServer({ port: 0, dataDir: dir });
    setTimeout(() => void first.close(), 300);
    const second = await startServer({ port: 0, dataDir: dir, restartWaitMs: 10_000 });
    cleanup.push(() => second.close());
    expect((await fetch(`${second.url}/api/health`)).status).toBe(200);
  });

  it('gives up after the wait and passes other errors through at once', async () => {
    const inUse = Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
    const work = vi.fn(async () => Promise.reject(inUse));
    await expect(retryInUse(work, 250)).rejects.toBe(inUse);
    expect(work.mock.calls.length).toBeGreaterThan(1);
    const other = vi.fn(async () => Promise.reject(new Error('EACCES')));
    await expect(retryInUse(other, 5000)).rejects.toThrow('EACCES');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('reads ADELIC_RESTART_WAIT once and removes it from the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-restart-env-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env.ADELIC_RESTART_WAIT = '5000';
    const server = await startServer({ port: 0, dataDir: dir });
    cleanup.push(() => server.close());
    expect(process.env.ADELIC_RESTART_WAIT).toBeUndefined();
  });

  it('wires the restart option to the updater with this server close() and data folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-restart-hook-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const restart = vi.fn(async (close: () => Promise<void>, _context: { dataDir: string }) => close());
    let wired: (() => Promise<void> | void) | undefined;
    const server = await startServer({
      port: 0,
      dataDir: dir,
      restart,
      selfUpdater: (fn) => ((wired = fn), fakeUpdater().updater),
    });
    cleanup.push(() => server.close());
    expect(restart).not.toHaveBeenCalled();
    await wired!();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart.mock.calls[0][1]).toEqual({ dataDir: realpathSync(dir) });
    await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
  });
});
