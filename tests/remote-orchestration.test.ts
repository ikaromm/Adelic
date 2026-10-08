import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import type { ProviderInfo, ProviderRegistry, RunInput, Session } from '../shared/contracts.js';

const resources: { server: Server; store: Store; shutdown: () => Promise<void>; dir: string }[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    await item.shutdown();
    item.store.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

const caps = { fast: true, tools: true, approvals: true, cancel: true, reasoning: true };
const providersInfo: ProviderInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    installed: true,
    available: true,
    status: 'ready',
    detail: '',
    models: [{ id: 'busy', name: 'Busy', isDefault: true }],
    defaultModel: 'busy',
    capabilities: caps,
  },
  {
    id: 'claude',
    name: 'Claude',
    installed: true,
    available: true,
    status: 'ready',
    detail: '',
    models: [{ id: 'local', name: 'Local' }],
    defaultModel: 'local',
    capabilities: caps,
  },
  {
    id: 'kiro',
    name: 'Kiro',
    installed: true,
    available: true,
    status: 'ready',
    detail: '',
    models: [{ id: 'remote', name: 'Remote' }],
    defaultModel: 'remote',
    capabilities: caps,
  },
];

function setup(fallbackModels: { providerId: 'claude' | 'kiro'; model: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-remote-orchestration-'));
  mkdirSync(join(dir, 'bootstrap'));
  const store = new Store(dir);
  const now = new Date().toISOString();
  store.putRemoteHost({
    id: 'host',
    name: 'Build host',
    target: 'build.example.test',
    port: 22,
    fingerprint: 'SHA256:fixture',
    hostKey: 'ssh-ed25519 fixture',
    runnerPath: '/home/shared/runner.py',
    createdAt: now,
  });
  store.putProject({
    id: 'project',
    name: 'Remote project',
    path: join(dir, 'bootstrap'),
    createdAt: now,
    memoryWorkspace: 'test',
    memoryProject: 'remote',
    remote: { hostId: 'host', path: '/srv/work' },
    orchestration: { enabled: false, maxWorkers: 1, review: false },
    graphify: { enabled: false },
  });
  const session: Session = {
    id: 'session',
    projectId: 'project',
    title: 'Remote chat',
    providerId: 'codex',
    model: 'busy',
    mode: 'fast',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  store.setSettings({
    ...store.getSettings()!,
    sandbox: 'workspace-write',
    modelFallback: { enabled: true, models: fallbackModels },
  });
  const calls: RunInput[] = [];
  const providers: ProviderRegistry = {
    list: async () => providersInfo,
    async run(input) {
      calls.push(input);
      if (input.providerId === 'codex') throw new Error('Selected model is at capacity.');
      return { text: `${input.providerId} answered`, stopReason: 'completed' };
    },
    approve: async () => undefined,
    shutdown: async () => undefined,
  };
  const backend = createBackend(store, providers, undefined, undefined, { retries: 0 });
  const server = createServer(backend.app);
  server.listen(0, '127.0.0.1');
  resources.push({ server, store, shutdown: () => backend.orchestrator.shutdown(), dir });
  return { store, session, orchestrator: backend.orchestrator, calls };
}

async function runAndWait(orchestrator: ReturnType<typeof setup>['orchestrator'], session: Session) {
  const ended = new Promise<void>((resolve) => {
    const stop = orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === session.id && event.run.status !== 'running') {
        stop();
        resolve();
      }
    });
  });
  await orchestrator.start(session, 'Inspect the project files.');
  await ended;
}

describe('remote run routing', () => {
  it('skips an available local-only fallback and carries the SSH target to Kiro', async () => {
    const { store, session, orchestrator, calls } = setup([
      { providerId: 'claude', model: 'local' },
      { providerId: 'kiro', model: 'remote' },
    ]);
    await runAndWait(orchestrator, session);
    expect(calls.map((input) => input.providerId)).toEqual(['codex', 'kiro']);
    expect(calls.every((input) => input.remote?.root === '/srv/work')).toBe(true);
    expect(calls.every((input) => input.remote?.label.includes('Build host'))).toBe(true);
    expect(calls.every((input) => input.approvalMode === 'manual')).toBe(true);
    expect(store.listRuns(session.id)[0]).toMatchObject({
      status: 'completed',
      fallback: { to: { providerId: 'kiro', model: 'remote' } },
    });
  });

  it('fails the remote turn rather than trying a local-only fallback', async () => {
    const { store, session, orchestrator, calls } = setup([{ providerId: 'claude', model: 'local' }]);
    await runAndWait(orchestrator, session);
    expect(calls.map((input) => input.providerId)).toEqual(['codex']);
    expect(store.listRuns(session.id)[0]).toMatchObject({ status: 'failed' });
    expect(store.listRuns(session.id)[0]?.fallback).toBeUndefined();
  });
});
