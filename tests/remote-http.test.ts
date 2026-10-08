import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import type { ProviderInfo, ProviderRegistry } from '../shared/contracts.js';
import type { RemoteHost } from '../shared/remote-hosts.js';

const resources: { server: Server; store: Store; shutdown: () => Promise<void>; dir: string }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    await item.shutdown();
    item.store.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
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
    models: [{ id: 'codex-test', name: 'Codex test', isDefault: true }],
    defaultModel: 'codex-test',
    capabilities: caps,
  },
  {
    id: 'claude',
    name: 'Claude',
    installed: true,
    available: true,
    status: 'ready',
    detail: '',
    models: [{ id: 'claude-test', name: 'Claude test', isDefault: true }],
    defaultModel: 'claude-test',
    capabilities: caps,
  },
];

function publicKey() {
  const type = Buffer.from('ssh-ed25519');
  const raw = Buffer.alloc(32, 37);
  const blob = Buffer.concat([Buffer.from([0, 0, 0, type.length]), type, Buffer.from([0, 0, 0, raw.length]), raw]);
  return {
    hostKey: `ssh-ed25519 ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-remote-http-'));
  const store = new Store(dir);
  const providers: ProviderRegistry = {
    list: async () => catalog,
    run: async () => ({ text: 'ok', stopReason: 'completed' }),
    approve: async () => undefined,
    shutdown: async () => undefined,
  };
  const backend = createBackend(store, providers, undefined, {
    bind: '127.0.0.2',
    port: 4318,
    token: 'remote-test-token-with-at-least-32-characters',
  });
  const server = createServer(backend.app);
  server.listen(0, '127.0.0.1');
  resources.push({
    server,
    store,
    shutdown: async () => {
      await backend.orchestrator.shutdown();
      backend.access.stop();
    },
    dir,
  });
  const host: RemoteHost = {
    id: 'host-test',
    name: 'Build host',
    target: 'build.example.test',
    port: 22,
    ...publicKey(),
    runnerPath: '/home/shared/runner.py',
    createdAt: new Date().toISOString(),
  };
  store.putRemoteHost(host);
  const ssh = vi.spyOn(backend.orchestrator.remoteHosts, 'call').mockImplementation(async (_host, cwd, tool) => {
    if (tool !== 'stat') throw new Error(`unexpected SSH tool ${tool}`);
    if (cwd === '/missing') throw new Error('remote folder does not exist');
    return { path: cwd, type: cwd === '/file' ? 'file' : 'directory', size: 0, mtime: 1 };
  });
  return { store, backend, server, host, ssh };
}

async function url(server: Server) {
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function call(base: string, method: string, path: string, body?: unknown, remote = false) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(remote
        ? {
            'tailscale-user-login': 'owner@example.test',
            authorization: 'Bearer remote-test-token-with-at-least-32-characters',
          }
        : { origin: base }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}

const projectBody = (hostId: string, path: string) => ({
  name: 'Remote work',
  remote: { hostId, path },
  memoryWorkspace: 'test',
  memoryProject: 'remote',
});

describe('SSH remote HTTP contracts', () => {
  it('rejects a mismatched pinned host-key fingerprint without saving the host', async () => {
    const { server, store, host } = setup();
    const base = await url(server);
    const before = store.listRemoteHosts().length;
    const result = await call(base, 'POST', '/api/remote-hosts', {
      name: 'Wrong key',
      target: host.target,
      port: 22,
      hostKey: host.hostKey,
      fingerprint: `SHA256:${'A'.repeat(43)}`,
      runnerPath: host.runnerPath,
    });
    expect(result.status).toBe(400);
    expect(store.listRemoteHosts()).toHaveLength(before);
  });

  it('validates the remote directory before persistence and disables local project features', async () => {
    const { server, store, host, ssh } = setup();
    const base = await url(server);
    expect((await call(base, 'POST', '/api/projects', projectBody(host.id, '/missing'))).status).toBe(400);
    expect((await call(base, 'POST', '/api/projects', projectBody(host.id, '/file'))).status).toBe(400);
    expect(
      (
        await call(base, 'POST', '/api/projects', {
          ...projectBody(host.id, '/work'),
          orchestration: { enabled: true, maxWorkers: 1, review: false },
        })
      ).status,
    ).toBe(409);
    expect(store.listProjects()).toHaveLength(0);
    const created = await call(base, 'POST', '/api/projects', projectBody(host.id, '/work'));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      remote: { hostId: host.id, path: '/work' },
      orchestration: { enabled: false },
      graphify: { enabled: false },
    });
    expect(ssh).toHaveBeenCalledTimes(3);
    const id = String(created.body?.id);
    expect((await call(base, 'PATCH', `/api/projects/${id}`, { graphify: { enabled: true } })).status).toBe(409);
    expect((await call(base, 'PATCH', `/api/projects/${id}`, { orchestration: { enabled: true } })).status).toBe(409);
    expect(store.getProject(id)?.orchestration?.enabled).toBe(false);
  });

  it('chooses Codex when the global default is unsupported and rejects explicit unsupported providers', async () => {
    const { server, store, host } = setup();
    const base = await url(server);
    const project = await call(base, 'POST', '/api/projects', projectBody(host.id, '/work'));
    const projectId = String(project.body?.id);
    store.setSettings({ ...store.getSettings()!, defaultProviderId: 'claude' });
    const explicit = await call(base, 'POST', '/api/sessions', { projectId, providerId: 'claude' });
    expect(explicit.status).toBe(409);
    const implicit = await call(base, 'POST', '/api/sessions', { projectId });
    expect(implicit.status).toBe(201);
    expect(implicit.body?.providerId).toBe('codex');
    const sessionId = String(implicit.body?.id);
    expect((await call(base, 'PATCH', `/api/sessions/${sessionId}`, { providerId: 'claude' })).status).toBe(409);
    expect(store.getSession(sessionId)?.providerId).toBe('codex');
  });

  it('refuses SSH actions from an authenticated nonlocal browser', async () => {
    const { server, store, host, ssh } = setup();
    const base = await url(server);
    const project = await call(base, 'POST', '/api/projects', projectBody(host.id, '/work'));
    const projectId = String(project.body?.id);
    const sessionsBefore = store.listSessions().length;
    const callsBefore = ssh.mock.calls.length;
    expect((await call(base, 'GET', '/api/remote-hosts', undefined, true)).status).toBe(403);
    expect((await call(base, 'POST', '/api/projects', projectBody(host.id, '/work'), true)).status).toBe(403);
    expect((await call(base, 'GET', `/api/projects/${projectId}/files?query=x`, undefined, true)).status).toBe(403);
    expect((await call(base, 'POST', '/api/sessions', { projectId }, true)).status).toBe(403);
    expect(store.listSessions()).toHaveLength(sessionsBefore);
    expect(ssh).toHaveBeenCalledTimes(callsBefore);
  });
});
