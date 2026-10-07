import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { branchName, removeWorktree } from '../server/worktrees.js';
import type { ProviderRegistry, Run, RunInput, Session, WorktreeStatus } from '../shared/contracts.js';
import { gitIn } from './git-fixtures.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false'];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A clean repository on `main` with one commit; local config has no identity. */
function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-repo-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'linha 1\nlinha 2\nlinha 3\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, ...ID, 'commit', '-qm', 'init');
  return dir;
}
const status = (dir: string) => gitIn(dir, 'status', '--porcelain');
const head = (dir: string) => gitIn(dir, 'rev-parse', 'HEAD').trim();

function setup(projectPath: string, opts: { dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-data-')));
  const store = new Store(dataDir);
  store.setSettings({ ...store.getSettings()!, sandbox: 'workspace-write' });
  const now = new Date().toISOString();
  if (!store.getProject('p'))
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
      const file = /\[arquivo (\S+)\]/.exec(input.prompt)?.[1];
      if (input.sandbox === 'workspace-write') {
        if (file) writeFileSync(join(input.cwd, file), 'do agente\n');
        else {
          writeFileSync(join(input.cwd, 'README.md'), 'linha 1\nalterada pelo agente\nlinha 3\n');
          writeFileSync(join(input.cwd, 'criado pelo agente.txt'), 'novo\n');
        }
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
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await orchestrator.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  cleanup.push(async () => {
    await close();
    if (!opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  const base = new Promise<string>((r) => {
    const done = () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    if (server.listening) done();
    else server.once('listening', done);
  });
  const finished = (runId: string) =>
    new Promise<Run>((resolve) => {
      const check = () => {
        const run = store.getRun(runId);
        if (run && run.status !== 'running') return resolve(run);
        setTimeout(check, 10);
      };
      check();
    });
  const session = (title = 'Corrigir o relatório', projectId: string | null = 'p') => {
    const s: Session = {
      id: `s${Math.random().toString(36).slice(2)}-${Date.now()}`,
      projectId,
      title,
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
    return s;
  };
  const api = async <T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown }) => {
    const response = await fetch(`${await base}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  const waiting = async (n = 1) => {
    while (gates.length < n) await new Promise((r) => setTimeout(r, 10));
  };
  const release = () => gates.splice(0).forEach((g) => g());
  const send = async (id: string, content: string) => {
    const r = await api<{ runId: string; error?: string }>(`/api/sessions/${id}/messages`, {
      method: 'POST',
      body: { content },
    });
    return r;
  };
  const enable = async (id: string) => {
    const r = await api<{ session: Session; status: WorktreeStatus; error?: string }>(`/api/sessions/${id}/worktree`, {
      method: 'POST',
      body: {},
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.session.worktree!;
  };
  return { store, orchestrator, finished, session, api, inputs, waiting, release, send, enable, dataDir, close };
}

describe('worktree per conversation', () => {
  it('creates the worktree outside the repository and runs there, leaving the main checkout untouched', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const info = await t.api<WorktreeStatus>(`/api/sessions/${s.id}/worktree`);
    expect(info.body).toMatchObject({ enabled: false, available: true });
    const before = head(repo);
    const wt = await t.enable(s.id);
    expect(wt.path).toBe(join(t.dataDir, 'worktrees', s.id));
    expect(wt.branch).toBe(branchName(s.id, s.title));
    expect(wt.branch).toMatch(/^adelic\/[a-z0-9]{8}-corrigir-o-relatorio$/);
    expect(wt.base).toBe(before);
    expect(gitIn(wt.path, 'branch', '--show-current').trim()).toBe(wt.branch);
    expect(status(repo)).toBe('');

    const { body } = await t.send(s.id, 'mude o README');
    const run = await t.finished(body.runId);
    expect(t.inputs.at(-1)!.cwd).toBe(wt.path);
    expect(readFileSync(join(wt.path, 'README.md'), 'utf8')).toContain('alterada pelo agente');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('linha 1\nlinha 2\nlinha 3\n');
    expect(status(repo)).toBe('');
    expect(head(repo)).toBe(before);
    expect(gitIn(repo, 'branch', '--show-current').trim()).toBe('main');
    // The checkpoint was taken in the worktree.
    expect(run.checkpoint).toMatchObject({ available: true, root: wt.path });
    expect(run.checkpoint!.files!.map((f) => f.path).sort()).toEqual(['README.md', 'criado pelo agente.txt']);
    const restored = await t.api(`/api/runs/${run.id}/restore`, { method: 'POST', body: { confirm: true } });
    expect(restored.status).toBe(200);
    expect(existsSync(join(wt.path, 'criado pelo agente.txt'))).toBe(false);

    const panel = await t.api<WorktreeStatus>(`/api/sessions/${s.id}/worktree`);
    expect(panel.body).toMatchObject({ enabled: true, exists: true, files: [], commits: 0, mainBranch: 'main' });
    expect(panel.body.applyBlocked).toBe('Não há alterações para aplicar');
  });

  it('lists changed files against the base, with diffs, and refuses a second worktree or a busy conversation', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const wt = await t.enable(s.id);
    expect((await t.api(`/api/sessions/${s.id}/worktree`, { method: 'POST', body: {} })).status).toBe(409);
    expect((await t.api(`/api/sessions/${s.id}/worktree`, { method: 'POST', body: { x: 1 } })).status).toBe(400);
    writeFileSync(join(wt.path, 'README.md'), 'linha 1\nlinha 2 editada\nlinha 3\n');
    writeFileSync(join(wt.path, 'ignored.log'), 'local\n');
    gitIn(wt.path, 'add', 'README.md');
    gitIn(wt.path, ...ID, 'commit', '-qm', 'no branch');
    writeFileSync(join(wt.path, 'novo.txt'), 'novo\n');
    const panel = (await t.api<WorktreeStatus>(`/api/sessions/${s.id}/worktree`)).body;
    expect(panel.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
      { path: 'novo.txt', status: 'added', additions: 1, deletions: 0 },
    ]);
    expect(panel).toMatchObject({ commits: 1, dirty: true, merged: false, branchMerged: false });
    expect(panel.applyBlocked).toBeUndefined();
    const diff = await t.api<{ diff: string }>(`/api/sessions/${s.id}/worktree/diff?path=README.md`);
    expect(diff.body.diff).toContain('+linha 2 editada');
    expect((await t.api(`/api/sessions/${s.id}/worktree/diff?path=ignored.log`)).status).toBe(404);
    expect((await t.api(`/api/sessions/${s.id}/worktree/diff`)).status).toBe(400);

    const started = await t.send(s.id, '[esperar] devagar');
    await t.waiting();
    for (const [path, method, body] of [
      [`/api/sessions/${s.id}/worktree/apply`, 'POST', { confirm: true }],
      [`/api/sessions/${s.id}/worktree`, 'DELETE', {}],
    ] as const)
      expect((await t.api(path, { method, body })).status).toBe(409);
    expect((await t.api(`/api/sessions/${s.id}`, { method: 'PATCH', body: { projectId: null } })).status).toBe(409);
    t.release();
    await t.finished(started.body.runId);
    const moved = await t.api<{ error: string }>(`/api/sessions/${s.id}`, {
      method: 'PATCH',
      body: { projectId: null },
    });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toContain('cópia isolada');
  });

  it('is unavailable for folders that are not a repository root, detached conversations and unknown ones', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-plain-')));
    cleanup.push(() => rmSync(plain, { recursive: true, force: true }));
    const t = setup(plain);
    const s = t.session();
    expect((await t.api(`/api/sessions/${s.id}/worktree`)).body).toMatchObject({
      enabled: false,
      available: false,
      reason: 'a pasta do projeto não é um repositório git',
    });
    expect((await t.api(`/api/sessions/${s.id}/worktree`, { method: 'POST', body: {} })).status).toBe(409);
    const detached = t.session('Avulsa', null);
    expect((await t.api(`/api/sessions/${detached.id}/worktree`)).status).toBe(409);
    expect((await t.api('/api/sessions/nope/worktree')).status).toBe(404);
    expect((await t.api('/api/sessions/nope/worktree', { method: 'POST', body: {} })).status).toBe(404);
    expect((await t.api('/api/sessions/nope/worktree/apply', { method: 'POST', body: { confirm: true } })).status).toBe(
      404,
    );
    expect((await t.api('/api/sessions/nope/worktree', { method: 'DELETE', body: {} })).status).toBe(404);
    expect(
      (await t.api(`/api/sessions/${s.id}/worktree/apply`, { method: 'POST', body: { confirm: true } })).status,
    ).toBe(404);
    expect((await t.api(`/api/sessions/${s.id}/worktree`, { method: 'DELETE', body: {} })).status).toBe(404);
    expect((await t.api(`/api/sessions/${s.id}/worktree/diff?path=a`)).status).toBe(404);

    const sub = makeRepo();
    const nested = join(sub, 'pasta');
    rmSync(nested, { force: true, recursive: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(nested);
    t.store.putProject({ ...t.store.getProject('p')!, id: 'q', path: nested });
    const inSub = t.session('Sub', 'q');
    expect((await t.api(`/api/sessions/${inSub.id}/worktree`)).body).toMatchObject({
      available: false,
      reason: 'a pasta do projeto não é a raiz do repositório git',
    });
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-empty-')));
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }));
    gitIn(empty, 'init', '-q', '-b', 'main');
    t.store.putProject({ ...t.store.getProject('p')!, id: 'e', path: empty });
    expect((await t.api(`/api/sessions/${t.session('E', 'e').id}/worktree`)).body).toMatchObject({
      reason: 'o repositório ainda não tem commits',
    });
  });

  it('runs in the worktree and in the main checkout at the same time; two runs of one worktree serialize', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const isolated = t.session('Isolada');
    const main = t.session('Principal');
    const wt = await t.enable(isolated.id);
    const a = await t.send(isolated.id, '[esperar] [arquivo a.txt]');
    expect(a.status).toBe(202);
    const b = await t.send(main.id, '[esperar] [arquivo b.txt]');
    expect(b.status).toBe(202);
    await t.waiting(2);
    // A third conversation on the main checkout conflicts with the main run, not the worktree one.
    const third = await t.send(t.session('Outra').id, 'qualquer');
    expect(third.status).toBe(409);
    // Apply is refused while a run is active in the main checkout.
    t.release();
    await Promise.all([t.finished(a.body.runId), t.finished(b.body.runId)]);
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
    expect(existsSync(join(repo, 'b.txt'))).toBe(true);
    expect(existsSync(join(repo, 'a.txt'))).toBe(false);

    // The same worktree is still reserved by its own run.
    const first = await t.send(isolated.id, '[esperar] [arquivo c.txt]');
    await t.waiting();
    const blocked = await t.send(main.id, '[esperar] [arquivo d.txt]');
    expect(blocked.status).toBe(202);
    await t.waiting(2);
    const apply = await t.api<{ error: string }>(`/api/sessions/${isolated.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(apply.status).toBe(409);
    t.release();
    await Promise.all([t.finished(first.body.runId), t.finished(blocked.body.runId)]);
    const busyMain = t.session('Principal 2');
    const holding = await t.send(busyMain.id, '[esperar] [arquivo e.txt]');
    await t.waiting();
    const refused = await t.api<{ error: string }>(`/api/sessions/${isolated.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('execução em andamento no projeto');
    t.release();
    await t.finished(holding.body.runId);
  });

  it('a worktree run blocks the git panel only for its own folder, and the panel blocks applying', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const isolated = t.session('Isolada');
    const wt = await t.enable(isolated.id);
    const run = await t.send(isolated.id, '[esperar] [arquivo a.txt]');
    expect(run.status).toBe(202);
    await t.waiting();
    // Writing in the worktree: the main checkout's git panel stays usable, the worktree's is blocked.
    expect(t.orchestrator.gitBlock(repo)).toBeUndefined();
    expect(t.orchestrator.gitBlock(wt.path)).toMatch(/execução alterando arquivos/);
    t.release();
    await t.finished(run.body.runId);
    // A git panel operation on the main checkout makes "Aplicar no projeto" wait (409).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const op = t.orchestrator.withGitOperation(repo, () => gate);
    const apply = await t.api<{ error: string }>(`/api/sessions/${isolated.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(apply.status).toBe(409);
    release();
    await op;
  });

  it('applies with a commit in the worktree and a --no-ff merge commit in the main checkout', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session('Aplicar mudança');
    const wt = await t.enable(s.id);
    await t.finished((await t.send(s.id, 'mude')).body.runId);
    const before = head(repo);
    expect((await t.api(`/api/sessions/${s.id}/worktree/apply`, { method: 'POST', body: {} })).status).toBe(400);
    const r = await t.api<{ commit: string; branch: string; status: WorktreeStatus }>(
      `/api/sessions/${s.id}/worktree/apply`,
      { method: 'POST', body: { confirm: true } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.branch).toBe('main');
    expect(head(repo)).toBe(r.body.commit);
    expect(gitIn(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    expect(gitIn(repo, 'rev-parse', 'HEAD^1').trim()).toBe(before);
    expect(gitIn(repo, 'log', '-1', '--format=%s', 'HEAD^2').trim()).toBe('Adelic: Aplicar mudança');
    // Without a configured identity (repository or global), the Adelic one is used.
    const configuredName = (() => {
      try {
        return gitIn(repo, 'config', 'user.name').trim();
      } catch {
        return '';
      }
    })();
    expect(gitIn(repo, 'log', '-1', '--format=%an', 'HEAD^2').trim()).toBe(configuredName || 'Adelic');
    expect(gitIn(repo, 'config', '--local', '--list')).not.toContain('user.');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('alterada pelo agente');
    expect(status(repo)).toBe('');
    expect(gitIn(repo, 'branch', '--show-current').trim()).toBe('main');
    expect(r.body.status).toMatchObject({ merged: true, branchMerged: true, dirty: false });
    expect(r.body.status.applyBlocked).toBe('As alterações já estão no projeto');
    // Discarding a merged worktree also deletes its branch.
    const gone = await t.api<{ branchDeleted: boolean; session: Session }>(`/api/sessions/${s.id}/worktree`, {
      method: 'DELETE',
      body: {},
    });
    expect(gone.body.branchDeleted).toBe(true);
    expect(gone.body.session.worktree).toBeUndefined();
    expect(existsSync(wt.path)).toBe(false);
    expect(gitIn(repo, 'branch', '--list', wt.branch).trim()).toBe('');
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
  });

  it('uses the repository identity when configured', async () => {
    const repo = makeRepo();
    gitIn(repo, 'config', 'user.name', 'Pessoa');
    gitIn(repo, 'config', 'user.email', 'pessoa@example.invalid');
    const t = setup(repo);
    const s = t.session('Com identidade');
    await t.enable(s.id);
    await t.finished((await t.send(s.id, 'mude')).body.runId);
    const r = await t.api(`/api/sessions/${s.id}/worktree/apply`, { method: 'POST', body: { confirm: true } });
    expect(r.status).toBe(200);
    expect(gitIn(repo, 'log', '-1', '--format=%an <%ae>', 'HEAD^2').trim()).toBe('Pessoa <pessoa@example.invalid>');
    expect(gitIn(repo, 'log', '-1', '--format=%an', 'HEAD').trim()).toBe('Pessoa');
  });

  it('refuses to apply on a dirty main checkout or a detached HEAD, without touching it', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    await t.enable(s.id);
    await t.finished((await t.send(s.id, 'mude')).body.runId);
    writeFileSync(join(repo, 'trabalho.txt'), 'do usuário\n');
    const dirty = await t.api<{ error: string }>(`/api/sessions/${s.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(dirty.status).toBe(409);
    expect(dirty.body.error).toContain('alterações não commitadas (trabalho.txt)');
    expect(status(repo)).toBe('?? trabalho.txt\n');
    expect(gitIn(repo, 'stash', 'list')).toBe('');
    expect((await t.api<WorktreeStatus>(`/api/sessions/${s.id}/worktree`)).body.applyBlocked).toContain(
      'não commitadas',
    );
    rmSync(join(repo, 'trabalho.txt'));
    const before = head(repo);
    gitIn(repo, 'checkout', '-q', '--detach');
    const detached = await t.api<{ error: string }>(`/api/sessions/${s.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(detached.status).toBe(409);
    expect(detached.body.error).toContain('HEAD destacado');
    expect(head(repo)).toBe(before);
    expect(status(repo)).toBe('');
    // A merge in progress also blocks.
    gitIn(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${before}\n`);
    expect(
      (
        await t.api<{ error: string }>(`/api/sessions/${s.id}/worktree/apply`, {
          method: 'POST',
          body: { confirm: true },
        })
      ).body.error,
    ).toContain('operação do git em andamento');
    rmSync(join(repo, '.git', 'MERGE_HEAD'));
  });

  it('aborts a conflicting merge, restores the main checkout and reports the files', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const wt = await t.enable(s.id);
    await t.finished((await t.send(s.id, 'mude')).body.runId);
    writeFileSync(join(repo, 'README.md'), 'linha 1\nalterada pelo usuário\nlinha 3\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, ...ID, 'commit', '-qm', 'usuário');
    const before = head(repo);
    const r = await t.api<{ error: string; conflicts: string[] }>(`/api/sessions/${s.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(r.status).toBe(409);
    expect(r.body.conflicts).toEqual(['README.md']);
    expect(r.body.error).toContain('o merge foi desfeito');
    expect(head(repo)).toBe(before);
    expect(status(repo)).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('linha 1\nalterada pelo usuário\nlinha 3\n');
    // The worktree changes were committed on its branch and are kept.
    expect(status(wt.path)).toBe('');
    expect(gitIn(repo, 'log', '-1', '--format=%s', wt.branch).trim()).toBe('Adelic: Corrigir o relatório');
  });

  it('refuses to overwrite ignored files of the main checkout', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const wt = await t.enable(s.id);
    writeFileSync(join(wt.path, '.gitignore'), '');
    writeFileSync(join(wt.path, 'ignored.log'), 'do agente\n');
    writeFileSync(join(repo, 'ignored.log'), 'segredo local\n');
    const r = await t.api<{ conflicts: string[] }>(`/api/sessions/${s.id}/worktree/apply`, {
      method: 'POST',
      body: { confirm: true },
    });
    expect(r.status).toBe(409);
    expect(r.body.conflicts).toEqual(['ignored.log']);
    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('segredo local\n');
  });

  it('never runs repository hooks, filters or merge drivers', async () => {
    const repo = makeRepo();
    const marker = join(realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-marker-'))), 'ran');
    cleanup.push(() => rmSync(join(marker, '..'), { recursive: true, force: true }));
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil merge=evil\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, ...ID, 'commit', '-qm', 'attrs');
    for (const [key, value] of [
      ['filter.evil.clean', `touch ${marker}; cat`],
      ['filter.evil.smudge', `touch ${marker}; cat`],
      ['filter.evil.process', `touch ${marker}`],
      ['filter.evil.required', 'true'],
      ['merge.evil.driver', `touch ${marker}; false`],
      ['hook.spy.event', 'post-checkout'],
      ['hook.spy.command', `touch ${marker}`],
    ])
      gitIn(repo, 'config', '--add', key, value);
    for (const event of ['pre-commit', 'post-checkout', 'post-merge', 'pre-merge-commit', 'commit-msg'])
      writeFileSync(join(repo, '.git', 'hooks', event), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const t = setup(repo);
    const s = t.session();
    await t.enable(s.id);
    await t.finished((await t.send(s.id, 'mude')).body.runId);
    expect((await t.api(`/api/sessions/${s.id}/worktree`)).status).toBe(200);
    const r = await t.api(`/api/sessions/${s.id}/worktree/apply`, { method: 'POST', body: { confirm: true } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(existsSync(marker)).toBe(false);
  });

  it('discards with or without deleting the unmerged branch', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const keep = t.session('Manter branch');
    const kept = await t.enable(keep.id);
    await t.finished((await t.send(keep.id, 'mude')).body.runId);
    gitIn(kept.path, 'add', '-A');
    gitIn(kept.path, ...ID, 'commit', '-qm', 'trabalho');
    expect(
      (await t.api(`/api/sessions/${keep.id}/worktree`, { method: 'DELETE', body: { deleteBranch: 'x' } })).status,
    ).toBe(400);
    const r1 = await t.api<{ branchDeleted: boolean; removed: boolean }>(`/api/sessions/${keep.id}/worktree`, {
      method: 'DELETE',
      body: {},
    });
    expect(r1.body).toMatchObject({ removed: true, branchDeleted: false });
    expect(existsSync(kept.path)).toBe(false);
    expect(gitIn(repo, 'branch', '--list', kept.branch).trim()).toContain(kept.branch);
    expect(t.store.getSession(keep.id)!.worktree).toBeUndefined();

    const drop = t.session('Apagar branch');
    const dropped = await t.enable(drop.id);
    await t.finished((await t.send(drop.id, 'mude')).body.runId);
    const r2 = await t.api<{ branchDeleted: boolean }>(`/api/sessions/${drop.id}/worktree`, {
      method: 'DELETE',
      body: { deleteBranch: true },
    });
    expect(r2.body.branchDeleted).toBe(true);
    expect(gitIn(repo, 'branch', '--list', dropped.branch).trim()).toBe('');
    expect(status(repo)).toBe('');
    expect(gitIn(repo, 'branch', '--show-current').trim()).toBe('main');
  });

  it('removes the worktree with the conversation and keeps the unmerged branch', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const wt = await t.enable(s.id);
    await t.finished((await t.send(s.id, 'mude')).body.runId);
    gitIn(wt.path, 'add', '-A');
    gitIn(wt.path, ...ID, 'commit', '-qm', 'trabalho');
    expect((await t.api(`/api/sessions/${s.id}`, { method: 'DELETE', body: {} })).status).toBe(204);
    expect(existsSync(wt.path)).toBe(false);
    expect(gitIn(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
    expect(status(repo)).toBe('');
  });

  it('prunes records of worktrees whose folder is gone on startup', async () => {
    const repo = makeRepo();
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-data-')));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = setup(repo, { dataDir });
    const gone = first.session('Some');
    const stays = first.session('Fica');
    const goneWt = await first.enable(gone.id);
    const staysWt = await first.enable(stays.id);
    await first.close();
    rmSync(goneWt.path, { recursive: true, force: true });
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain(goneWt.path);
    const second = setup(repo, { dataDir });
    const pruned = await second.orchestrator.pruneWorktrees();
    expect(pruned).toEqual([gone.id]);
    expect(second.store.getSession(gone.id)!.worktree).toBeUndefined();
    expect(second.store.getSession(stays.id)!.worktree).toEqual(staysWt);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(goneWt.path);
    expect(gitIn(repo, 'branch', '--list', goneWt.branch)).toContain(goneWt.branch);
    expect(status(repo)).toBe('');
  });

  it('reports a missing worktree folder instead of running elsewhere', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const wt = await t.enable(s.id);
    rmSync(wt.path, { recursive: true, force: true });
    const run = await t.send(s.id, 'mude');
    expect(run.status).toBe(409);
    const panel = (await t.api<WorktreeStatus>(`/api/sessions/${s.id}/worktree`)).body;
    expect(panel).toMatchObject({ exists: false });
    expect(panel.applyBlocked).toContain('não existe mais');
    expect(
      (await t.api(`/api/sessions/${s.id}/worktree/apply`, { method: 'POST', body: { confirm: true } })).status,
    ).toBe(409);
    expect((await t.api(`/api/sessions/${s.id}/worktree/diff?path=README.md`)).status).toBe(410);
    expect((await t.api(`/api/sessions/${s.id}/worktree`, { method: 'DELETE', body: {} })).status).toBe(200);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
  });

  it('lists the worktree files for mentions of that conversation', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const s = t.session();
    const wt = await t.enable(s.id);
    writeFileSync(join(wt.path, 'so-na-copia.md'), 'x\n');
    const own = await t.api<{ files: string[] }>(`/api/projects/p/files?query=copia&sessionId=${s.id}`);
    expect(own.body.files).toEqual(['so-na-copia.md']);
    const project = await t.api<{ files: string[] }>('/api/projects/p/files?query=copia');
    expect(project.body.files).toEqual([]);
  });

  it('branch names are bounded slugs and removal outside a project only drops our folder', async () => {
    expect(branchName('12345678-aaaa', 'Ação: corrigir   o «bug» já!')).toBe('adelic/12345678-acao-corrigir-o-bug-ja');
    expect(branchName('x', '***')).toBe('adelic/x-conversa');
    expect(branchName('abc', 'a'.repeat(100)).length).toBeLessThanOrEqual('adelic/abc-'.length + 40);
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-data-')));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const { mkdirSync } = await import('node:fs');
    const path = join(dataDir, 'worktrees', 'sx');
    mkdirSync(path, { recursive: true });
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-other-')));
    cleanup.push(() => rmSync(other, { recursive: true, force: true }));
    const meta = { branch: 'adelic/sx', base: 'x', createdAt: '' };
    expect((await removeWorktree(undefined, { ...meta, path }, dataDir)).removed).toBe(true);
    expect((await removeWorktree(undefined, { ...meta, path: other }, dataDir)).removed).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
