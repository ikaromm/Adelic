import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { NOT_GIT, REF_PREFIX } from '../server/checkpoints.js';
import type { ProviderRegistry, Run, RunInput, Session } from '../shared/contracts.js';
import { gitIn, makeGitRepo } from './git-fixtures.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const makeRepo = () => {
  const dir = makeGitRepo();
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Fake provider: writes into input.cwd during run(), as an agent with workspace-write would. */
function setup(projectPath: string, opts: { sandbox?: 'read-only' | 'workspace-write' } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adelic-ckpt-data-'));
  const store = new Store(dataDir);
  store.setSettings({ ...store.getSettings()!, sandbox: opts.sandbox ?? 'workspace-write' });
  const now = new Date().toISOString();
  store.putProject({
    id: 'p',
    name: 'P',
    path: projectPath,
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: { enabled: false, maxWorkers: 1, review: false },
  });
  const gates: (() => void)[] = [];
  const inputs: RunInput[] = [];
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
      inputs.push(input);
      if (input.prompt.includes('[esperar]')) await new Promise<void>((r) => gates.push(r));
      if (input.sandbox === 'workspace-write') {
        const later = input.prompt.includes('[esperar]') ? ' de novo' : '';
        writeFileSync(join(input.cwd, 'README.md'), `linha 1\nalterada pelo agente${later}\nlinha 3\n`);
        writeFileSync(join(input.cwd, 'criado pelo agente.txt'), 'novo\n');
      }
      emit({ type: 'delta', text: 'feito' });
      return { text: 'feito', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers);
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  cleanup.push(async () => {
    await orchestrator.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = new Promise<string>((r) =>
    server.listening
      ? r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
      : server.once('listening', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)),
  );
  const finished = (runId: string) =>
    new Promise<Run>((resolve) => {
      const check = () => {
        const run = store.getRun(runId);
        if (run && run.status !== 'running') return resolve(run);
        setTimeout(check, 10);
      };
      check();
    });
  const session = (projectId: string | null = 'p') => {
    const s: Session = {
      id: `s-${Math.random().toString(36).slice(2)}`,
      projectId,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
    return s;
  };
  const api = async (path: string, init?: { method?: string; body?: unknown }) => {
    const response = await fetch(`${await base}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  /** Resolves once a `[esperar]` run is inside the provider (after its checkpoint). */
  const waiting = async () => {
    while (!gates.length) await new Promise((r) => setTimeout(r, 10));
  };
  const release = () => gates.splice(0).forEach((g) => g());
  return { store, orchestrator, finished, session, api, inputs, waiting, release };
}

describe('checkpoints around runs', () => {
  it('records what a writing run changed, shows the diff and undoes it through the API', async () => {
    const repo = makeRepo();
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const { orchestrator, finished, session, api } = setup(repo);
    const { runId } = await orchestrator.start(session(), 'Oi');
    const run = await finished(runId);
    expect(run.checkpoint).toMatchObject({ available: true, root: realpathSync(repo) });

    const changes = await api(`/api/runs/${runId}/changes`);
    expect(changes).toEqual({
      status: 200,
      body: {
        available: true,
        files: [
          { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
          { path: 'criado pelo agente.txt', status: 'added', additions: 1, deletions: 0 },
        ],
      },
    });
    const diff = await api(`/api/runs/${runId}/diff?path=${encodeURIComponent('README.md')}`);
    expect(diff.status).toBe(200);
    expect(diff.body.diff).toContain('+alterada pelo agente');
    expect(diff.body.diff).toContain('-linha 2 editada pelo usuário');
    // Only paths from the run's file list are served.
    expect((await api(`/api/runs/${runId}/diff?path=untracked.txt`)).status).toBe(404);
    expect((await api(`/api/runs/${runId}/diff?path=${encodeURIComponent('../../etc/passwd')}`)).status).toBe(404);
    expect((await api(`/api/runs/${runId}/diff`)).status).toBe(400);

    expect((await api(`/api/runs/${runId}/restore`, { method: 'POST', body: {} })).status).toBe(400);
    const restored = await api(`/api/runs/${runId}/restore`, { method: 'POST', body: { confirm: true } });
    expect(restored.status).toBe(200);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('editada pelo usuário');
    expect(existsSync(join(repo, 'criado pelo agente.txt'))).toBe(false);
    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect((await api(`/api/runs/${runId}/changes`)).body.restoredAt).toEqual(expect.any(String));
    // A second undo is refused.
    expect((await api(`/api/runs/${runId}/restore`, { method: 'POST', body: { confirm: true } })).status).toBe(409);
  });

  it('answers 409 with the files edited since the run, and keeps them', async () => {
    const repo = makeRepo();
    const { orchestrator, finished, session, api } = setup(repo);
    const { runId } = await orchestrator.start(session(), 'Oi');
    await finished(runId);
    writeFileSync(join(repo, 'README.md'), 'edição posterior\n');
    const result = await api(`/api/runs/${runId}/restore`, { method: 'POST', body: { confirm: true } });
    expect(result.status).toBe(409);
    expect(result.body.conflicts).toEqual(['README.md']);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('edição posterior\n');
    expect(existsSync(join(repo, 'criado pelo agente.txt'))).toBe(true);
  });

  it('refuses to undo while another run is active in the same project', async () => {
    const repo = makeRepo();
    const { orchestrator, finished, session, api, waiting, release } = setup(repo);
    const first = await orchestrator.start(session(), 'Oi');
    await finished(first.runId);
    const second = await orchestrator.start(session(), '[esperar] mais uma');
    await waiting();
    const blocked = await api(`/api/runs/${first.runId}/restore`, { method: 'POST', body: { confirm: true } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/execução em andamento/);
    release();
    await finished(second.runId);
    // Once it finished, the newer run's edits are what the older undo would overwrite.
    const later = await api(`/api/runs/${first.runId}/restore`, { method: 'POST', body: { confirm: true } });
    expect(later).toMatchObject({ status: 409, body: { conflicts: ['README.md'] } });
  });

  it('skips non-git projects and records why', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-nogit-')));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'README.md'), 'x\n');
    const { orchestrator, finished, session, api } = setup(dir);
    const { runId } = await orchestrator.start(session(), 'Oi');
    expect((await finished(runId)).checkpoint).toEqual({ available: false, reason: NOT_GIT });
    expect((await api(`/api/runs/${runId}/changes`)).body).toEqual({ available: false, reason: NOT_GIT, files: [] });
    expect((await api(`/api/runs/${runId}/restore`, { method: 'POST', body: { confirm: true } })).status).toBe(404);
  });

  it('takes no checkpoint for read-only runs, nor for detached conversations without their own repository', async () => {
    const repo = makeRepo();
    const ro = setup(repo, { sandbox: 'read-only' });
    const roRun = await ro.orchestrator.start(ro.session(), 'Oi');
    expect((await ro.finished(roRun.runId)).checkpoint).toBeUndefined();
    expect(gitIn(repo, 'for-each-ref', REF_PREFIX)).toBe('');

    const rw = setup(repo);
    const detached = await rw.orchestrator.start(rw.session(null), 'Oi');
    expect((await rw.finished(detached.runId)).checkpoint).toEqual({ available: false, reason: NOT_GIT });
  });
});
