import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import {
  applyWorktree,
  branchName,
  createExecutorWorktree,
  createWorktree,
  executorIsolation,
  integrateExecutorWorktree,
  inspectExecutorWorktree,
  removeWorktree,
  verifyExecutorWorktreeCandidate,
  worktreeStatus,
} from '../server/worktrees.js';
import type { ProviderRegistry, Run, RunInput, Session, WorktreeStatus } from '../shared/contracts.js';
import { gitIn } from './git-fixtures.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false'];
// Full real-Git isolation/integration workflows have a finite local ceiling, consistent with the two
// dirty-workspace workflows that took 1.65s/2.06s in the complete suite; a separate real-Git flow exceeded 5s.
// Product deadline assertions and deliberately slow cutoff/cancellation probes keep their separate timeouts.
const DIRTY_INTEGRATION_TIMEOUT_MS = 15_000;
const REAL_GIT_WORKFLOW_TIMEOUT_MS = DIRTY_INTEGRATION_TIMEOUT_MS;
// Large artifact snapshot/integration is materially slower under coverage instrumentation.
const LARGE_ARTIFACT_WORKFLOW_TIMEOUT_MS = 30_000;
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

function waitForRunIdle(store: Pick<Store, 'getRun'>, isActive: (sessionId: string) => boolean, runId: string) {
  return new Promise<Run>((resolve) => {
    const check = () => {
      const run = store.getRun(runId);
      if (run && run.status !== 'running' && !isActive(run.sessionId)) return resolve(run);
      setTimeout(check, 10);
    };
    check();
  });
}

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
  const finished = (runId: string) => waitForRunIdle(store, (sessionId) => orchestrator.isActive(sessionId), runId);
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
  return {
    store,
    orchestrator,
    providers,
    finished,
    session,
    api,
    inputs,
    waiting,
    release,
    send,
    enable,
    dataDir,
    close,
  };
}

function slowGitCommand(repo: string, command: 'ls-tree' | 'config' | 'worktree' | 'apply', delaySeconds = 4) {
  const shimDir = mkdtempSync(join(tmpdir(), 'adelic-slow-git-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const marker = join(shimDir, 'entered');
  const shim = join(shimDir, 'git');
  const originalPath = process.env.PATH ?? '';
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$PWD" = "${repo}" ]; then
  case " $* " in
    *" ${command} "*)
      echo entered >> "${marker}"
      sleep ${delaySeconds}
      ;;
  esac
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return {
    marker,
    restore() {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

describe('automatic executor worktrees', () => {
  it('session worktree continuity rejects a replacement checkout at the same path and branch', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const session = t.session('Session ownership');
    const owned = await createWorktree(project, session, t.dataDir);
    expect(owned).toMatchObject({ ownershipVerified: true });
    expect(owned.ownershipProofRef?.startsWith('refs/adelic/recovery-intents/')).toBe(true);

    gitIn(repo, 'worktree', 'remove', '--force', owned.path);
    gitIn(repo, 'worktree', 'add', '--quiet', '--force', owned.path, owned.branch);
    writeFileSync(join(owned.path, 'foreign-session.txt'), 'preserve this\\n');
    await expect(removeWorktree(project, owned, t.dataDir)).rejects.toThrow(/ocupante atual.*não foi comprovado/i);
    expect(readFileSync(join(owned.path, 'foreign-session.txt'), 'utf8')).toBe('preserve this\\n');
    expect(gitIn(owned.path, 'branch', '--show-current').trim()).toBe(owned.branch);

    gitIn(repo, 'worktree', 'remove', '--force', owned.path);
    gitIn(repo, 'update-ref', '-d', `refs/heads/${owned.branch}`, owned.base);
    gitIn(repo, 'update-ref', '-d', owned.ownershipProofRef!, owned.base);
  });

  it('refuses to delete a branch advanced after checkout verification and before the cleanup sink', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const owned = await createExecutorWorktree(project, { id: 'authorized-tip-race', title: 'Tip race' }, t.dataDir);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-tip-race-'));
    const shim = join(shimDir, 'git');
    const originalPath = process.env.PATH ?? '';
    const advanced = gitIn(repo, ...ID, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'concurrent tip').trim();
    writeFileSync(
      shim,
      `#!/bin/sh
case " $* " in
  *" worktree remove "*)
    "${realGit}" -C "${repo}" update-ref "refs/heads/${owned.branch}" "${advanced}" "${owned.base}"
    ;;
esac
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    try {
      const removed = await removeWorktree(project, owned, t.dataDir, { deleteBranch: true });
      expect(removed.removed).toBe(true);
      expect(removed.branchDeleted).toBe(false);
      // The advanced OID is observable, but it was not the authorized cleanup version.
      expect(removed.branchTip).toBeUndefined();
      expect(gitIn(repo, 'rev-parse', `refs/heads/${owned.branch}`).trim()).toBe(advanced);
    } finally {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
    gitIn(repo, 'update-ref', '-d', `refs/heads/${owned.branch}`, advanced);
    gitIn(repo, 'update-ref', '-d', owned.ownershipProofRef!, owned.base);
  });

  it('retries deletion of its proof ref after the checkout and branch are already gone', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const owned = await createExecutorWorktree(project, { id: 'proof-tail-retry', title: 'Proof retry' }, t.dataDir);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-proof-retry-'));
    const shim = join(shimDir, 'git');
    const failOnce = join(shimDir, 'fail-once');
    const originalPath = process.env.PATH ?? '';
    writeFileSync(
      shim,
      `#!/bin/sh
case " $* " in
  *" -d ${owned.ownershipProofRef} "*)
    if [ ! -e "${failOnce}" ]; then
      : > "${failOnce}"
      exit 47
    fi
    ;;
esac
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    try {
      await expect(removeWorktree(project, owned, t.dataDir, { deleteBranch: true })).rejects.toThrow();
      expect(existsSync(owned.path)).toBe(false);
      expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${owned.branch}`).trim()).toBe('');
      expect(gitIn(repo, 'rev-parse', owned.ownershipProofRef!).trim()).toBe(owned.base);
      expect(await verifyExecutorWorktreeCandidate(project, owned, t.dataDir)).toBe(true);
      const retried = await removeWorktree(project, owned, t.dataDir, { deleteBranch: true });
      expect(retried.cleanupResources).toEqual({
        worktree: 'removed',
        branch: 'removed',
        ownershipProof: 'removed',
      });
      expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', owned.ownershipProofRef!).trim()).toBe('');
    } finally {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
  it('records an unverified branch residue when real Git fails before creating AdminDir', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const gitDir = gitIn(repo, 'rev-parse', '--absolute-git-dir').trim();
    const adminRoot = join(gitDir, 'worktrees');
    mkdirSync(adminRoot, { recursive: true });
    const originalHead = head(repo);
    const session = t.session('Partial admin failure');
    const branch = branchName(session.id, session.title);
    chmodSync(adminRoot, 0o500);
    try {
      let failure:
        | (Error & {
            recoveryWorktree?: {
              ownershipVerified?: boolean;
              branch: string;
              base: string;
              path: string;
              createdAt: string;
            };
          })
        | undefined;
      try {
        await createExecutorWorktree(project, { id: session.id, title: session.title }, t.dataDir);
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.recoveryWorktree).toMatchObject({ branch, base: originalHead, ownershipVerified: false });
      expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(originalHead);
      await expect(removeWorktree(project, failure!.recoveryWorktree!, t.dataDir)).rejects.toThrow(
        /Propriedade.*não comprovada/,
      );
      expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(originalHead);
    } finally {
      chmodSync(adminRoot, 0o700);
    }
  });

  it('persists factual creation and incomplete preparation but blocks it as a delivery', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    writeFileSync(join(repo, 'README.md'), 'main dirty baseline\n');
    const id = 'preparation-failed-worktree';
    const path = join(t.dataDir, 'worktrees', id);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-prep-git-'));
    const shim = join(shimDir, 'git');
    const originalPath = process.env.PATH ?? '';
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$PWD" = "${path}" ]; then
  case " $* " in
    *" apply --binary - "*) exit 73 ;;
  esac
fi
case " $* " in
  *" worktree remove "*)
    sleep 5
    ;;
esac
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    try {
      let failure: (Error & { recoveryWorktree?: Record<string, unknown> }) | undefined;
      try {
        await createExecutorWorktree(project, { id, title: 'Preparation failure' }, t.dataDir, {
          deadlineAt: new Date(Date.now() + 2_500).toISOString(),
          reserveMs: 0,
        });
      } catch (error) {
        failure = error as typeof failure;
      }
      const recovery = failure?.recoveryWorktree as
        (Session['worktree'] & { preparationFailed?: boolean; executionStarted?: boolean }) | undefined;
      expect(recovery).toMatchObject({
        path,
        ownershipVerified: true,
        preparationFailed: true,
        executionStarted: false,
        recoveryReason: expect.stringContaining('baseline capturada'),
      });
      expect(recovery?.snapshotTree).toBeTruthy();
      expect(existsSync(path)).toBe(true);
      expect(await worktreeStatus(project, recovery!).then((s) => s.applyBlocked)).toMatch(
        /preparação\/baseline incompleta/,
      );
      await expect(applyWorktree(project, recovery!, 'Do not apply')).rejects.toThrow(/preparação.*incompleta/i);
      await expect(inspectExecutorWorktree(project, recovery!)).rejects.toThrow(/preparação.*incompleta/i);
      await expect(integrateExecutorWorktree(project, recovery!)).rejects.toThrow(/preparação.*incompleta/i);
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('main dirty baseline\n');
    } finally {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it('does not promote or mutate an unknown candidate created by another checkout after the intent ref', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const base = head(repo);
    const id = 'unknown-candidate-1234';
    const branch = branchName(id, 'Unknown candidate');
    const path = join(t.dataDir, 'worktrees', id);
    const ownershipProofRef = 'refs/adelic/recovery-intents/test-proof';
    gitIn(repo, 'update-ref', ownershipProofRef, base);
    gitIn(repo, 'branch', branch, base);
    const candidate = {
      path,
      branch,
      base,
      createdAt: new Date().toISOString(),
      ownershipVerified: false,
      ownershipProofRef,
    };

    // A concurrent actor uses the same main repository, branch, and expected destination.
    gitIn(repo, 'worktree', 'add', '--quiet', '--force', path, branch);
    writeFileSync(join(path, 'foreign.txt'), 'conteúdo do outro ator\n');
    expect(await verifyExecutorWorktreeCandidate(project, candidate, t.dataDir)).toBe(false);
    const status = await worktreeStatus(project, candidate);
    expect(status.applyBlocked).toMatch(/Propriedade não comprovada/);
    expect(status.files).toBeUndefined();
    await expect(applyWorktree(project, candidate, 'Apply unknown candidate')).rejects.toThrow(
      /Propriedade.*não comprovada/,
    );
    await expect(inspectExecutorWorktree(project, candidate)).rejects.toThrow(/Propriedade.*não comprovada/);
    await expect(integrateExecutorWorktree(project, candidate)).rejects.toThrow(/Propriedade.*não comprovada/);
    await expect(removeWorktree(project, candidate, t.dataDir)).rejects.toThrow(/Propriedade.*não comprovada/);

    expect(head(repo)).toBe(base);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('linha 1\nlinha 2\nlinha 3\n');
    expect(readFileSync(join(path, 'foreign.txt'), 'utf8')).toBe('conteúdo do outro ator\n');
    expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(base);
    expect(gitIn(repo, 'rev-parse', ownershipProofRef).trim()).toBe(base);
    gitIn(repo, 'worktree', 'remove', '--force', path);
    gitIn(repo, 'update-ref', '-d', `refs/heads/${branch}`, base);
    gitIn(repo, 'update-ref', '-d', ownershipProofRef, base);
  });

  it('preserves a recreated checkout at the same path and branch despite historical ownership proof', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const owned = await createExecutorWorktree(project, { id: 'reuse-same-occupant', title: 'Owner' }, t.dataDir);
    gitIn(repo, 'worktree', 'remove', '--force', owned.path);
    gitIn(repo, 'worktree', 'add', '--quiet', '--force', owned.path, owned.branch);
    writeFileSync(join(owned.path, 'foreign-uncommitted.txt'), 'must survive\\n');

    expect(await verifyExecutorWorktreeCandidate(project, owned, t.dataDir)).toBe(false);
    await expect(removeWorktree(project, owned, t.dataDir)).rejects.toThrow(/ocupante atual.*não foi comprovado/i);
    expect(readFileSync(join(owned.path, 'foreign-uncommitted.txt'), 'utf8')).toBe('must survive\\n');
    expect(gitIn(owned.path, 'branch', '--show-current').trim()).toBe(owned.branch);
    expect(gitIn(repo, 'rev-parse', `refs/heads/${owned.branch}`).trim()).toBe(owned.base);

    gitIn(repo, 'worktree', 'remove', '--force', owned.path);
    gitIn(repo, 'update-ref', '-d', `refs/heads/${owned.branch}`, owned.base);
    gitIn(repo, 'update-ref', '-d', owned.ownershipProofRef!, owned.base);
  });

  it('preserves a different checkout at a recovered path despite historical ownership and no proof ref', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const owned = await createExecutorWorktree(project, { id: 'reuse-path-owner', title: 'Owner' }, t.dataDir);
    gitIn(repo, 'worktree', 'remove', '--force', owned.path);
    const foreignBranch = 'foreign/reused-path';
    gitIn(repo, 'branch', foreignBranch, head(repo));
    gitIn(repo, 'worktree', 'add', '--quiet', owned.path, foreignBranch);
    writeFileSync(join(owned.path, 'uncommitted-foreign.txt'), 'preserve me\n');
    const staleRecord = {
      ...owned,
      ownershipVerified: true,
      ownershipProofRef: undefined,
      preparationFailed: true,
      executionStarted: false,
    };
    await expect(removeWorktree(project, staleRecord, t.dataDir)).rejects.toThrow(/continuidade.*não comprovada/i);
    expect(readFileSync(join(owned.path, 'uncommitted-foreign.txt'), 'utf8')).toBe('preserve me\n');
    expect(gitIn(owned.path, 'branch', '--show-current').trim()).toBe(foreignBranch);
    gitIn(repo, 'worktree', 'remove', '--force', owned.path);
    gitIn(repo, 'branch', '-D', foreignBranch);
    gitIn(repo, 'update-ref', '-d', owned.ownershipProofRef!, owned.base);
  });

  it('does not issue a recovery proof for a worktree already present at the reserved path', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const created = await createExecutorWorktree(project, { id: 'preexisting-worktree', title: 'Existing' }, t.dataDir);
    let failure: (Error & { recoveryWorktree?: unknown }) | undefined;
    try {
      await createExecutorWorktree(project, { id: 'preexisting-worktree', title: 'Existing' }, t.dataDir);
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure?.message).toContain('Já existe uma pasta de cópia isolada');
    expect(failure).not.toHaveProperty('recoveryWorktree');
    expect(created.ownershipProofRef).toMatch(/^refs\/adelic\/recovery-intents\//);
    expect(gitIn(repo, 'rev-parse', created.ownershipProofRef!).trim()).toBe(created.base);
    await removeWorktree(project, created, t.dataDir, { deleteBranch: true });
    expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', 'refs/adelic/recovery-intents').trim()).toBe('');
  });

  it('limits cleanup Git calls to the supplied deadline and preserves resources on timeout or cancellation', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const timed = await createExecutorWorktree(project, { id: 'cleanup-timeout-1234', title: 'Timeout' }, t.dataDir);
    const delay = slowGitCommand(repo, 'worktree');
    try {
      const started = Date.now();
      await expect(
        removeWorktree(project, timed, t.dataDir, { deadlineAt: new Date(started + 400).toISOString() }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(existsSync(timed.path)).toBe(true);
      expect(gitIn(repo, 'branch', '--list', timed.branch)).toContain(timed.branch);
    } finally {
      delay.restore();
    }
    const cancelled = new AbortController();
    cancelled.abort(new Error('cleanup cancelled'));
    await expect(removeWorktree(project, timed, t.dataDir, { signal: cancelled.signal })).rejects.toThrow();
    expect(existsSync(timed.path)).toBe(true);
    expect(gitIn(repo, 'branch', '--list', timed.branch)).toContain(timed.branch);
    await removeWorktree(project, timed, t.dataDir);
  });

  it('does not follow an Adel ic symbolic ref when conditionally deleting a branch', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const wt = await createExecutorWorktree(project, { id: 'symref-cas-12345678', title: 'Symbolic ref' }, t.dataDir);
    const originalHead = head(repo);
    gitIn(repo, 'symbolic-ref', `refs/heads/${wt.branch}`, 'refs/heads/main');
    const removed = await removeWorktree(project, wt, t.dataDir, { deleteBranch: true });
    expect(removed.branchDeleted).toBe(false);
    expect(gitIn(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(originalHead);
    expect(head(repo)).toBe(originalHead);
    expect(gitIn(repo, 'symbolic-ref', `refs/heads/${wt.branch}`).trim()).toBe('refs/heads/main');
    gitIn(repo, 'symbolic-ref', '--delete', `refs/heads/${wt.branch}`);
  });

  it('bounds partial-add cleanup discovery to the reserved tail and reports preserved residue', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const id = 'partial-add-cleanup';
    const branch = branchName(id, 'Partial cleanup');
    const path = join(t.dataDir, 'worktrees', id);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-partial-git-'));
    const shim = join(shimDir, 'git');
    const originalPath = process.env.PATH ?? '';
    writeFileSync(
      shim,
      `#!/bin/sh
case " $* " in
  *" worktree add "*)
    "${realGit}" "$@"
    exit 73
    ;;
  *" --git-common-dir "*)
    sleep 5
    ;;
esac
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    let recoveredCandidate:
      | {
          path: string;
          branch: string;
          base: string;
          createdAt: string;
          ownershipVerified?: boolean;
          recoveryReason?: string;
          ownershipProofRef?: string;
        }
      | undefined;
    try {
      const started = Date.now();
      let failure:
        | (Error & {
            recoveryWorktree?: {
              path: string;
              branch: string;
              base: string;
              createdAt: string;
              ownershipVerified?: boolean;
              recoveryReason?: string;
              ownershipProofRef?: string;
            };
          })
        | undefined;
      try {
        await createExecutorWorktree(project, { id, title: 'Partial cleanup' }, t.dataDir, {
          deadlineAt: new Date(started + 2_500).toISOString(),
          reserveMs: 800,
        });
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.message).toMatch(/limpeza interrompida/);
      expect(Date.now() - started).toBeLessThan(3_500);
      expect(failure?.recoveryWorktree).toMatchObject({
        path,
        branch,
        base: head(repo),
        ownershipVerified: false,
        ownershipProofRef: expect.stringMatching(/^refs\/adelic\/recovery-intents\//),
      });
      expect(failure?.recoveryWorktree?.recoveryReason).toContain('Intenção registrada');
      recoveredCandidate = failure?.recoveryWorktree;
      expect(existsSync(path)).toBe(true);
      expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(head(repo));
    } finally {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
    expect(recoveredCandidate).toBeDefined();
    expect(await verifyExecutorWorktreeCandidate(project, recoveredCandidate!, t.dataDir)).toBe(false);
    await expect(removeWorktree(project, recoveredCandidate!, t.dataDir)).rejects.toThrow(
      /Propriedade.*não comprovada/,
    );
    gitIn(repo, 'worktree', 'remove', '--force', path);
    gitIn(repo, 'update-ref', '-d', `refs/heads/${branch}`, head(repo));
    gitIn(repo, 'update-ref', '-d', recoveredCandidate!.ownershipProofRef!, head(repo));
  });

  it('keeps a branch used by a second checkout when post-add finalization fails', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const id = 'post-add-branch-guard';
    const branch = branchName(id, 'Post add guard');
    const second = join(t.dataDir, 'second-checkout');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-post-add-git-'));
    const shim = join(shimDir, 'git');
    const originalPath = process.env.PATH ?? '';
    writeFileSync(
      shim,
      `#!/bin/sh
case " $* " in
  *"^{tree}"*)
    "${realGit}" worktree add --quiet --force "${second}" "${branch}"
    exit 73
    ;;
esac
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    let failure: (Error & { recoveryWorktree?: Session['worktree'] }) | undefined;
    try {
      try {
        await createExecutorWorktree(project, { id, title: 'Post add guard' }, t.dataDir);
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.recoveryWorktree).toMatchObject({ branch, ownershipVerified: true });
      expect(failure?.recoveryWorktree?.path).toBe(join(t.dataDir, 'worktrees', id));
      expect(existsSync(failure!.recoveryWorktree!.path)).toBe(false);
      expect(existsSync(second)).toBe(true);
      expect(gitIn(second, 'branch', '--show-current').trim()).toBe(branch);
      expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(head(repo));
      expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe(readFileSync(join(repo, 'README.md'), 'utf8'));
      expect(head(repo)).toBe(gitIn(second, 'rev-parse', 'HEAD').trim());
    } finally {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
    const recovery = failure!.recoveryWorktree!;
    expect(await verifyExecutorWorktreeCandidate(project, recovery, t.dataDir)).toBe(true);
    const advanced = gitIn(
      repo,
      ...ID,
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      'HEAD',
      '-m',
      'changed recovery ref',
    ).trim();
    gitIn(repo, 'update-ref', 'refs/heads/' + branch, advanced, head(repo));
    expect(await verifyExecutorWorktreeCandidate(project, recovery, t.dataDir)).toBe(false);
    gitIn(repo, 'update-ref', 'refs/heads/' + branch, head(repo), advanced);
    expect(await verifyExecutorWorktreeCandidate(project, recovery, t.dataDir)).toBe(true);
    const partialCleanup = await removeWorktree(project, recovery, t.dataDir);
    expect(partialCleanup).toMatchObject({ removed: true, branchDeleted: false });
    expect(gitIn(repo, 'rev-parse', recovery.ownershipProofRef!).trim()).toBe(recovery.base);
    expect(await verifyExecutorWorktreeCandidate(project, recovery, t.dataDir)).toBe(true);
    gitIn(repo, 'worktree', 'remove', '--force', second);
    expect(await verifyExecutorWorktreeCandidate(project, recovery, t.dataDir)).toBe(true);
    const discarded = await removeWorktree(project, recovery, t.dataDir, { deleteBranch: true });
    expect(discarded).toMatchObject({ removed: true, branchDeleted: true });
    expect(() => gitIn(repo, 'rev-parse', '--verify', 'refs/heads/' + branch)).toThrow();
  });

  it('preserves an Adelic branch referenced by a detached checkout in a conflicting rebase', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const owned = await createExecutorWorktree(
      project,
      { id: 'rebase-branch-protection', title: 'Rebase protection' },
      t.dataDir,
    );
    const branch = owned.branch;
    const checkout = join(t.dataDir, 'second-rebase-checkout');
    gitIn(repo, 'worktree', 'add', '--force', '--quiet', checkout, branch);
    writeFileSync(join(checkout, 'README.md'), 'target branch change\\nlinha 2\\nlinha 3\\n');
    gitIn(checkout, ...ID, 'commit', '-qam', 'target change');
    writeFileSync(join(repo, 'README.md'), 'main conflicting change\\nlinha 2\\nlinha 3\\n');
    gitIn(repo, ...ID, 'commit', '-qam', 'main conflict');
    expect(() => gitIn(checkout, 'rebase', 'main')).toThrow();
    expect(() => gitIn(checkout, 'symbolic-ref', '-q', '--short', 'HEAD')).toThrow();
    expect(gitIn(checkout, 'rev-parse', '--git-path', 'rebase-merge/head-name').trim()).not.toBe('');

    const removed = await removeWorktree(project, owned, t.dataDir, { deleteBranch: true });
    expect(removed.branchDeleted).toBe(false);
    expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).not.toBe('');
    expect(gitIn(checkout, 'status', '--porcelain')).not.toBe('');
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toContain('<<<<<<<');
    gitIn(checkout, 'rebase', '--abort');
    gitIn(repo, 'worktree', 'remove', '--force', checkout);
    const retried = await removeWorktree(project, { ...owned, cleanupBranchTip: removed.branchTip }, t.dataDir, {
      deleteBranch: true,
    });
    expect(retried.branchDeleted).toBe(true);
  });

  it('preserves a branch used by an active bisect so bisect reset can restore it', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    for (const message of ['second', 'third']) {
      const commit = gitIn(repo, ...ID, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', message).trim();
      gitIn(repo, 'reset', '--hard', commit);
    }
    const project = t.store.getProject('p')!;
    const owned = await createExecutorWorktree(
      project,
      { id: 'bisect-branch-guard', title: 'Bisect protection' },
      t.dataDir,
    );
    const base = owned.base;
    const branch = owned.branch;
    const checkout = join(t.dataDir, 'second-bisect-checkout');
    gitIn(repo, 'worktree', 'add', '--force', '--quiet', checkout, branch);
    gitIn(checkout, 'bisect', 'start', 'HEAD', 'HEAD~2');
    expect(() => gitIn(checkout, 'symbolic-ref', '-q', '--short', 'HEAD')).toThrow();
    const bisectState = gitIn(checkout, 'rev-parse', '--git-path', 'BISECT_START').trim();
    expect(readFileSync(bisectState, 'utf8').trim()).toBe(branch);

    const removed = await removeWorktree(project, owned, t.dataDir, { deleteBranch: true });
    expect(removed.branchDeleted).toBe(false);
    expect(gitIn(repo, 'rev-parse', `refs/heads/${branch}`).trim()).toBe(base);
    gitIn(checkout, 'bisect', 'reset');
    expect(gitIn(checkout, 'symbolic-ref', '-q', '--short', 'HEAD').trim()).toBe(branch);
    gitIn(repo, 'worktree', 'remove', '--force', checkout);
    const retried = await removeWorktree(project, { ...owned, cleanupBranchTip: removed.branchTip }, t.dataDir, {
      deleteBranch: true,
    });
    expect(retried.branchDeleted).toBe(true);
  });

  it('does not delete a branch advanced concurrently after its eligibility check', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const wt = await createExecutorWorktree(project, { id: 'cas-branch-12345678', title: 'CAS' }, t.dataDir);
    const originalHead = head(repo);
    const advanced = gitIn(repo, ...ID, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'advanced ref').trim();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'adelic-cas-git-'));
    const shim = join(shimDir, 'git');
    const originalPath = process.env.PATH ?? '';
    writeFileSync(
      shim,
      `#!/bin/sh
if [ "$PWD" = "${repo}" ] && [ "$1" = "-c" ]; then
  case " $* " in
    *" worktree list --porcelain -z "*)
      "${realGit}" update-ref refs/heads/${wt.branch} "${advanced}"
      ;;
  esac
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    try {
      const removed = await removeWorktree(project, wt, t.dataDir, { deleteBranch: true });
      expect(removed.branchDeleted).toBe(false);
      expect(gitIn(repo, 'rev-parse', `refs/heads/${wt.branch}`).trim()).toBe(advanced);
      expect(head(repo)).toBe(originalHead);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      process.env.PATH = originalPath;
      rmSync(shimDir, { recursive: true, force: true });
    }
    await gitIn(repo, 'update-ref', '-d', `refs/heads/${wt.branch}`, advanced);
  });

  it('preserves an Adelic branch attached to another checkout, including on retry after removal', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const wt = await createExecutorWorktree(
      project,
      { id: 'shared-branch-checkout', title: 'Shared branch' },
      t.dataDir,
    );
    const second = join(t.dataDir, 'second-checkout');
    gitIn(repo, 'worktree', 'add', '--force', '--quiet', second, wt.branch);
    const expected = gitIn(second, 'rev-parse', 'HEAD').trim();

    const first = await removeWorktree(project, wt, t.dataDir, { deleteBranch: true });
    expect(first).toMatchObject({ removed: true, branchDeleted: false });
    expect(gitIn(second, 'rev-parse', 'HEAD').trim()).toBe(expected);
    expect(gitIn(repo, 'rev-parse', `refs/heads/${wt.branch}`).trim()).toBe(expected);

    // A retry no longer has the original admin folder to inspect; it must still discover
    // the other checkout rather than treating the missing original as proof of ownership.
    const retry = await removeWorktree(project, wt, t.dataDir, { deleteBranch: true });
    expect(retry.branchDeleted).toBe(false);
    expect(gitIn(second, 'rev-parse', 'HEAD').trim()).toBe(expected);
    expect(gitIn(repo, 'rev-parse', `refs/heads/${wt.branch}`).trim()).toBe(expected);

    gitIn(repo, 'worktree', 'remove', '--force', second);
    gitIn(repo, 'update-ref', '--no-deref', '-d', `refs/heads/${wt.branch}`, expected);
  });

  it.each(['inspect', 'integrate'] as const)(
    'interrupts delayed baseline ls-tree for %s before its worktree budget cutoff',
    async (mode) => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      const wt = await createExecutorWorktree(project, { id: `slow-${mode}-12345678`, title: 'Slow' }, t.dataDir);
      const delay = slowGitCommand(wt.path, 'ls-tree');
      try {
        const started = Date.now();
        const options = { deadlineAt: new Date(started + 1_200).toISOString() };
        const operation =
          mode === 'inspect'
            ? inspectExecutorWorktree(project, wt, options)
            : integrateExecutorWorktree(project, wt, options);
        await expect(operation).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(existsSync(delay.marker)).toBe(true);
      } finally {
        delay.restore();
      }
    },
    8_000,
  );

  it('shares one absolute cutoff across both hardened configNames queries', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const delay = slowGitCommand(repo, 'config', 0.8);
    try {
      const started = Date.now();
      const result = await executorIsolation(project, {
        deadlineAt: new Date(started + 1_250).toISOString(),
        reserveMs: 0,
      });
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(readFileSync(delay.marker, 'utf8').match(/entered/g)).toHaveLength(2);
      expect(result.mode).toBe('blocked');
    } finally {
      delay.restore();
    }
  }, 8_000);

  it('interrupts a delayed hardened configNames query rather than swallowing it as no-match', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const wt = await createExecutorWorktree(project, { id: 'slow-config-12345678', title: 'Slow' }, t.dataDir);
    const delay = slowGitCommand(repo, 'config');
    try {
      const started = Date.now();
      await expect(
        integrateExecutorWorktree(project, wt, {
          deadlineAt: new Date(started + 1_200).toISOString(),
        }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(existsSync(delay.marker)).toBe(true);
    } finally {
      delay.restore();
    }
  }, 8_000);

  it('propagates an inconclusive exact-reapplication probe without applying after its deadline', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const wt = await createExecutorWorktree(project, { id: 'slow-reapply-12345678', title: 'Slow reapply' }, t.dataDir);
    writeFileSync(join(wt.path, 'created.txt'), 'task output\\n');
    const delay = slowGitCommand(repo, 'apply');
    try {
      const started = Date.now();
      await expect(
        integrateExecutorWorktree(project, wt, {
          deadlineAt: new Date(started + 1_200).toISOString(),
        }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(existsSync(delay.marker)).toBe(true);
      expect(existsSync(join(repo, 'created.txt'))).toBe(false);
      expect(existsSync(join(wt.path, 'created.txt'))).toBe(true);
    } finally {
      delay.restore();
    }
  }, 8_000);
  it('refuses executor isolation and worktree creation at the cutoff or on cancellation before writes', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const originalHead = head(repo);
    const originalIndex = gitIn(repo, 'write-tree').trim();
    const deadlineAt = new Date(Date.now() + 80).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await executorIsolation(project, { deadlineAt })).toMatchObject({ mode: 'blocked' });
    await expect(
      createExecutorWorktree(project, { id: 'cutoff-task-12345678', title: 'Cutoff' }, t.dataDir, {
        deadlineAt,
        reserveMs: 0,
      }),
    ).rejects.toThrow(/deadline|prazo/i);
    const controller = new AbortController();
    controller.abort(new Error('cancelled before prep'));
    await expect(
      createExecutorWorktree(project, { id: 'cancel-task-12345678', title: 'Cancelled' }, t.dataDir, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(head(repo)).toBe(originalHead);
    expect(gitIn(repo, 'write-tree').trim()).toBe(originalIndex);
    expect(gitIn(repo, 'branch', '--list', 'adelic/cutoff-task*')).toBe('');
    expect(gitIn(repo, 'branch', '--list', 'adelic/cancel-task*')).toBe('');
    expect(existsSync(join(t.dataDir, 'worktrees', 'cutoff-task-12345678'))).toBe(false);
    expect(existsSync(join(t.dataDir, 'worktrees', 'cancel-task-12345678'))).toBe(false);
  });

  it('inspects pending task worktree changes against the persisted base before showing them', async () => {
    const root = makeRepo();
    const fixture = setup(root);
    const project = fixture.store.getProject('p')!;
    const session = fixture.session('Inspect pending checkout');
    const taskId = 'inspect-live-worktree';
    writeFileSync(join(root, 'README.md'), 'staged baseline\\n');
    gitIn(root, 'add', 'README.md');
    writeFileSync(join(root, 'README.md'), 'staged and unstaged baseline\\n');
    writeFileSync(join(root, 'user-work.txt'), 'untracked baseline\\n');
    const worktree = await createExecutorWorktree(
      project,
      { id: taskId, title: 'Inspect live worktree' },
      fixture.dataDir,
    );
    try {
      writeFileSync(join(worktree.path, 'pending-change.txt'), 'observed change\\n');
      const now = new Date().toISOString();
      fixture.store.putRun({
        id: 'inspect-live-run',
        sessionId: session.id,
        providerId: 'codex',
        status: 'completed',
        route: { level: 'fast', reason: 'test', tools: false, memory: false, contextBudget: 6000 },
        startedAt: now,
      });
      fixture.store.putTask({
        id: taskId,
        agentId: 'inspect-live-agent',
        projectId: project.id,
        sessionId: session.id,
        runId: 'inspect-live-run',
        role: 'worker',
        title: 'Inspect live worktree',
        instructions: 'Inspect',
        scope: [],
        dependsOn: [],
        providerId: 'codex',
        status: 'completed',
        createdAt: now,
        recoveryWorktree: { ...worktree, ownershipVerified: true, executionStarted: true },
        delivery: {
          status: 'partial',
          reason: 'Pending changes require inspection.',
          evidence: [],
          recovery: { action: 'recover_worktree', reason: 'Inspect pending changes.' },
          recordedAt: now,
        },
      });

      const inspected = await fixture.api<{ artifacts: { worktree?: { status: string; files: { path: string }[] } } }>(
        `/api/tasks/${taskId}/inspect`,
      );
      expect(inspected.status).toBe(200);
      expect(inspected.body.artifacts.worktree).toMatchObject({ status: 'available' });
      expect(inspected.body.artifacts.worktree?.files.map((file) => file.path)).toEqual(['pending-change.txt']);
    } finally {
      await removeWorktree(project, worktree, fixture.dataDir);
      await fixture.close();
    }
  });

  it(
    'inspects task changes against its captured dirty baseline, excluding inherited and sibling changes',
    async () => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;

      // Capture all three forms of pre-existing user state: staged, unstaged, and untracked.
      writeFileSync(join(repo, 'README.md'), 'linha 1\\nstaged\\nlinha 3\\n');
      gitIn(repo, 'add', 'README.md');
      writeFileSync(join(repo, 'README.md'), 'linha 1\\nstaged + unstaged\\nlinha 3\\n');
      writeFileSync(join(repo, 'user-work.txt'), 'herdado\\n');
      const headBefore = head(repo);
      const indexBefore = gitIn(repo, 'write-tree').trim();
      const stagedBefore = gitIn(repo, 'show', ':README.md');

      // A previous sibling has already integrated its own file before this task starts.
      const sibling = await createExecutorWorktree(
        project,
        { id: 'sibling-task-12345678', title: 'Sibling' },
        t.dataDir,
      );
      writeFileSync(join(sibling.path, 'sibling-owned.txt'), 'sibling\\n');
      expect(await integrateExecutorWorktree(project, sibling)).toMatchObject({
        changed: true,
        files: ['sibling-owned.txt'],
      });

      const task = await createExecutorWorktree(project, { id: 'inspect-task-12345678', title: 'Inspect' }, t.dataDir);
      expect(task.snapshotTree).toMatch(/^[a-f0-9]+$/);
      expect(readFileSync(join(task.path, 'README.md'), 'utf8')).toBe('linha 1\\nstaged + unstaged\\nlinha 3\\n');
      expect(readFileSync(join(task.path, 'user-work.txt'), 'utf8')).toBe('herdado\\n');
      expect(readFileSync(join(task.path, 'sibling-owned.txt'), 'utf8')).toBe('sibling\\n');

      writeFileSync(join(task.path, 'task-owned.txt'), 'task\\n');
      const changes = await inspectExecutorWorktree(project, task);
      expect(changes.map((change) => change.path)).toEqual(['task-owned.txt']);

      // Inspection is read-only with respect to the user's checkout, index and inherited contents.
      expect(head(repo)).toBe(headBefore);
      expect(gitIn(repo, 'write-tree').trim()).toBe(indexBefore);
      expect(gitIn(repo, 'show', ':README.md')).toBe(stagedBefore);
      expect(status(repo)).toBe('MM README.md\n?? sibling-owned.txt\n?? user-work.txt\n');
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('linha 1\\nstaged + unstaged\\nlinha 3\\n');
      expect(readFileSync(join(repo, 'user-work.txt'), 'utf8')).toBe('herdado\\n');
      expect(readFileSync(join(repo, 'sibling-owned.txt'), 'utf8')).toBe('sibling\\n');

      await removeWorktree(project, sibling, t.dataDir);
      await removeWorktree(project, task, t.dataDir);
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'allows parallel executors in distinct checkouts and integrates diffs without commits',
    async () => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      const before = head(repo);
      const [a, b] = await Promise.all([
        createExecutorWorktree(project, { id: 'task-a-12345678', title: 'Executor A' }, t.dataDir),
        createExecutorWorktree(project, { id: 'task-b-12345678', title: 'Executor B' }, t.dataDir),
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.path).not.toBe(b!.path);
      writeFileSync(join(a!.path, 'README.md'), 'linha 1\nalteração A\nlinha 3\n');
      const applied = await integrateExecutorWorktree(project, a!);
      expect(applied).toMatchObject({ changed: true, files: ['README.md'] });
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('linha 1\nalteração A\nlinha 3\n');
      expect(head(repo)).toBe(before);
      expect(status(repo)).toContain('README.md');
      await removeWorktree(project, a!, t.dataDir);
      await removeWorktree(project, b!, t.dataDir);
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'delivers artifacts larger than the bounded artifact reader from two real executor worktrees',
    async () => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      const originalHead = head(repo);
      const originalIndex = gitIn(repo, 'write-tree').trim();
      const [a, b] = await Promise.all([
        createExecutorWorktree(project, { id: 'large-task-a-12345678', title: 'Large A' }, t.dataDir),
        createExecutorWorktree(project, { id: 'large-task-b-12345678', title: 'Large B' }, t.dataDir),
      ]);
      expect(a.path).not.toBe(b.path);
      const payloadA = Buffer.alloc(2_097_153, 0x61);
      const payloadB = Buffer.alloc(2_097_153, 0x62);
      writeFileSync(join(a.path, 'large-a.bin'), payloadA);
      writeFileSync(join(b.path, 'large-b.bin'), payloadB);

      expect(await integrateExecutorWorktree(project, a)).toMatchObject({ changed: true, files: ['large-a.bin'] });
      expect(await integrateExecutorWorktree(project, b)).toMatchObject({ changed: true, files: ['large-b.bin'] });
      expect(readFileSync(join(repo, 'large-a.bin'))).toEqual(payloadA);
      expect(readFileSync(join(repo, 'large-b.bin'))).toEqual(payloadB);
      expect(head(repo)).toBe(originalHead);
      expect(gitIn(repo, 'write-tree').trim()).toBe(originalIndex);
      expect(status(repo)).toContain('large-a.bin');
      expect(status(repo)).toContain('large-b.bin');

      await removeWorktree(project, a, t.dataDir);
      await removeWorktree(project, b, t.dataDir);
    },
    LARGE_ARTIFACT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'preserves an eligible baseline file when the task changes .gitignore, but applies real deletions',
    async () => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      writeFileSync(join(repo, 'untracked.keep'), 'baseline user data\n');
      const ignoredBefore = 'segredo pré-existente\n';
      writeFileSync(join(repo, 'ignored.log'), ignoredBefore);
      const worktree = await createExecutorWorktree(
        project,
        { id: 'task-ignore-12345678', title: 'Ignore' },
        t.dataDir,
      );
      expect(readFileSync(join(worktree.path, 'untracked.keep'), 'utf8')).toBe('baseline user data\n');
      expect(existsSync(join(worktree.path, 'ignored.log'))).toBe(false);

      writeFileSync(join(worktree.path, '.gitignore'), 'ignored.log\nuntracked.keep\n');
      const applied = await integrateExecutorWorktree(project, worktree);
      expect(applied).toMatchObject({ changed: true, files: ['.gitignore'] });
      expect(readFileSync(join(repo, 'untracked.keep'), 'utf8')).toBe('baseline user data\n');
      expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe(ignoredBefore);
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('ignored.log\nuntracked.keep\n');
      const failedCleanup = await removeWorktree(undefined, worktree, join(t.dataDir, 'wrong-root'));
      expect(failedCleanup.removed).toBe(false);
      expect(existsSync(worktree.path)).toBe(true);
      expect(await integrateExecutorWorktree(project, worktree)).toMatchObject({
        changed: false,
        alreadyApplied: true,
        files: ['.gitignore'],
      });
      expect(readFileSync(join(repo, 'untracked.keep'), 'utf8')).toBe('baseline user data\n');
      await removeWorktree(project, worktree, t.dataDir);

      const deleted = await createExecutorWorktree(project, { id: 'task-delete-12345678', title: 'Delete' }, t.dataDir);
      rmSync(join(deleted.path, 'README.md'));
      const deletion = await integrateExecutorWorktree(project, deleted);
      expect(deletion).toMatchObject({ changed: true, files: ['README.md'] });
      expect(existsSync(join(repo, 'README.md'))).toBe(false);
      await removeWorktree(project, deleted, t.dataDir);
    },
    DIRTY_INTEGRATION_TIMEOUT_MS,
  );

  it(
    'integrates only unapplied whole-file deltas from a mixed 13-file patch',
    async () => {
      const repo = makeRepo();
      writeFileSync(join(repo, 'mode.sh'), '#!/bin/sh\\necho base\\n');
      writeFileSync(join(repo, 'delete-me.txt'), 'remove me\\n');
      gitIn(repo, 'add', '-A');
      gitIn(repo, ...ID, 'commit', '-qm', 'integration fixtures');
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      const worktree = await createExecutorWorktree(project, { id: 'mixed-thirteen-files', title: 'Mixed' }, t.dataDir);

      chmodSync(join(worktree.path, 'mode.sh'), 0o755);
      writeFileSync(join(worktree.path, 'mode.sh'), '#!/bin/sh\\necho task\\n');
      rmSync(join(worktree.path, 'delete-me.txt'));
      writeFileSync(join(worktree.path, 'already-applied.txt'), 'exact task output\\n');
      for (let i = 0; i < 10; i++) writeFileSync(join(worktree.path, `pending-${i}.txt`), `pending ${i}\\n`);

      // Simulate a concurrent integration that has already applied exactly this one file delta.
      writeFileSync(join(repo, 'already-applied.txt'), 'exact task output\\n');
      const applied = await integrateExecutorWorktree(project, worktree);
      expect(applied).toMatchObject({
        changed: true,
        alreadyApplied: false,
        files: expect.arrayContaining(['already-applied.txt', 'delete-me.txt', 'mode.sh']),
      });
      expect(applied.files).toHaveLength(13);
      expect(readFileSync(join(repo, 'already-applied.txt'), 'utf8')).toBe('exact task output\\n');
      expect(readFileSync(join(repo, 'mode.sh'), 'utf8')).toBe('#!/bin/sh\\necho task\\n');
      expect((await import('node:fs')).statSync(join(repo, 'mode.sh')).mode & 0o111).toBe(0o111);
      expect(existsSync(join(repo, 'delete-me.txt'))).toBe(false);
      for (let i = 0; i < 10; i++) expect(readFileSync(join(repo, `pending-${i}.txt`), 'utf8')).toBe(`pending ${i}\\n`);
      expect(await integrateExecutorWorktree(project, worktree)).toMatchObject({
        changed: false,
        alreadyApplied: true,
        files: expect.arrayContaining(['already-applied.txt', 'delete-me.txt', 'mode.sh']),
      });
      await removeWorktree(project, worktree, t.dataDir);
    },
    DIRTY_INTEGRATION_TIMEOUT_MS,
  );

  it('does not treat a partially applied hunk set as an already-applied file delta', async () => {
    const repo = makeRepo();
    const initialLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`);
    writeFileSync(join(repo, 'multi-hunk.txt'), initialLines.join(''));
    gitIn(repo, 'add', 'multi-hunk.txt');
    gitIn(repo, ...ID, 'commit', '-qm', 'multi-hunk fixture');
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(project, { id: 'partial-hunks', title: 'Partial hunks' }, t.dataDir);
    const taskLines = [...initialLines];
    taskLines[1] = 'task line 2\n';
    taskLines[28] = 'task line 29\n';
    writeFileSync(join(worktree.path, 'multi-hunk.txt'), taskLines.join(''));
    const partiallyAppliedLines = [...initialLines];
    partiallyAppliedLines[1] = 'task line 2\n';
    writeFileSync(join(repo, 'multi-hunk.txt'), partiallyAppliedLines.join(''));

    await expect(integrateExecutorWorktree(project, worktree)).rejects.toThrow();
    expect(readFileSync(join(repo, 'multi-hunk.txt'), 'utf8')).toBe(partiallyAppliedLines.join(''));
    expect(readFileSync(join(worktree.path, 'multi-hunk.txt'), 'utf8')).toBe(taskLines.join(''));
    await removeWorktree(project, worktree, t.dataDir);
  });

  it('keeps a real conflict from partially writing otherwise-applicable file deltas', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(
      project,
      { id: 'atomic-integration-conflict', title: 'Conflict' },
      t.dataDir,
    );
    writeFileSync(join(worktree.path, 'aaa-pending.txt'), 'must not be partially written\\n');
    writeFileSync(join(worktree.path, 'README.md'), 'worker conflict\\n');
    writeFileSync(join(repo, 'README.md'), 'concurrent conflict\\n');
    await expect(integrateExecutorWorktree(project, worktree)).rejects.toThrow();
    expect(existsSync(join(repo, 'aaa-pending.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('concurrent conflict\\n');
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toBe('worker conflict\\n');
    await removeWorktree(project, worktree, t.dataDir);
  });

  it('preserves arbitrary non-UTF-8 text bytes while splitting and applying file deltas', async () => {
    const repo = makeRepo();
    const original = Buffer.from([0x6f, 0x6c, 0x64, 0xff, 0x0a]);
    writeFileSync(join(repo, 'bytes.txt'), original);
    gitIn(repo, 'add', 'bytes.txt');
    gitIn(repo, ...ID, 'commit', '-qm', 'non-UTF-8 text fixture');
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(project, { id: 'non-utf8-delta', title: 'Bytes' }, t.dataDir);
    const expected = Buffer.from([0x6e, 0x65, 0x77, 0xff, 0x0a]);
    writeFileSync(join(worktree.path, 'bytes.txt'), expected);
    expect(await integrateExecutorWorktree(project, worktree)).toMatchObject({
      changed: true,
      files: ['bytes.txt'],
    });
    expect(readFileSync(join(repo, 'bytes.txt'))).toEqual(expected);
    await removeWorktree(project, worktree, t.dataDir);
  });

  it('treats bracketed added paths literally when guarding collisions', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(project, { id: 'glob-path-collision', title: 'Glob' }, t.dataDir);
    writeFileSync(join(worktree.path, '[id].txt'), 'expected exact path\\n');
    writeFileSync(join(repo, '[id].txt'), 'preserve literal collision\\n');
    // A glob-like include for [id].txt must not obtain a false empty/successful reverse check.
    await expect(integrateExecutorWorktree(project, worktree)).rejects.toThrow();
    expect(readFileSync(join(repo, '[id].txt'), 'utf8')).toBe('preserve literal collision\\n');
    expect(existsSync(join(worktree.path, '[id].txt'))).toBe(true);
    await removeWorktree(project, worktree, t.dataDir);
  });

  it(
    'recognizes exact reapplication of a created file but blocks a different-content collision',
    async () => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      const created = await createExecutorWorktree(project, { id: 'task-new-12345678', title: 'New file' }, t.dataDir);
      writeFileSync(join(created.path, 'synthetic-result.txt'), 'synthetic task output\\n');
      expect(await integrateExecutorWorktree(project, created)).toMatchObject({
        changed: true,
        files: ['synthetic-result.txt'],
      });
      expect(await integrateExecutorWorktree(project, created)).toMatchObject({
        changed: false,
        alreadyApplied: true,
        files: ['synthetic-result.txt'],
      });
      expect(readFileSync(join(repo, 'synthetic-result.txt'), 'utf8')).toBe('synthetic task output\\n');
      await removeWorktree(project, created, t.dataDir);

      const collided = await createExecutorWorktree(project, { id: 'task-clash-12345678', title: 'Clash' }, t.dataDir);
      writeFileSync(join(collided.path, 'synthetic-clash.txt'), 'expected patch content\\n');
      writeFileSync(join(repo, 'synthetic-clash.txt'), 'different pre-existing content\\n');
      await expect(integrateExecutorWorktree(project, collided)).rejects.toThrow();
      expect(readFileSync(join(repo, 'synthetic-clash.txt'), 'utf8')).toBe('different pre-existing content\\n');
      await removeWorktree(project, collided, t.dataDir);
    },
    DIRTY_INTEGRATION_TIMEOUT_MS,
  );

  it('snapshots a dirty tracked and eligible untracked workspace without touching the index, HEAD, branch or ignored files', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    writeFileSync(join(repo, 'README.md'), 'linha 1\nuser dirty\nlinha 3\n');
    writeFileSync(join(repo, 'user-work.txt'), 'preservar\n');
    writeFileSync(join(repo, 'ignored.log'), 'segredo não copiar\n');
    gitIn(repo, 'add', 'README.md');
    const beforeHead = head(repo);
    const beforeBranch = gitIn(repo, 'branch', '--show-current').trim();
    const beforeIndex = readFileSync(join(repo, '.git', 'index'));
    const worktree = await createExecutorWorktree(project, { id: 'task-dirty-12345678', title: 'Dirty' }, t.dataDir);
    expect(worktree.snapshotTree).toMatch(/^[a-f0-9]+$/);
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toContain('user dirty');
    expect(readFileSync(join(worktree.path, 'user-work.txt'), 'utf8')).toBe('preservar\n');
    expect(existsSync(join(worktree.path, 'ignored.log'))).toBe(false);
    expect(head(repo)).toBe(beforeHead);
    expect(gitIn(repo, 'branch', '--show-current').trim()).toBe(beforeBranch);
    expect(readFileSync(join(repo, '.git', 'index'))).toEqual(beforeIndex);
    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toContain('segredo');
    await removeWorktree(project, worktree, t.dataDir);
  });

  it(
    'integrates disjoint task changes over a dirty baseline and retains conflicts for retry',
    async () => {
      const repo = makeRepo();
      const t = setup(repo);
      const project = t.store.getProject('p')!;
      writeFileSync(join(repo, 'README.md'), 'linha 1\nuser baseline\nlinha 3\n');
      writeFileSync(join(repo, 'user-work.txt'), 'preservar\n');
      const [a, b] = await Promise.all([
        createExecutorWorktree(project, { id: 'task-a-dirty-123', title: 'A' }, t.dataDir),
        createExecutorWorktree(project, { id: 'task-b-dirty-123', title: 'B' }, t.dataDir),
      ]);
      writeFileSync(join(a.path, 'alpha.txt'), 'A\n');
      writeFileSync(join(b.path, 'beta.txt'), 'B\n');
      expect(await integrateExecutorWorktree(project, a)).toMatchObject({ changed: true, files: ['alpha.txt'] });
      expect(await integrateExecutorWorktree(project, b)).toMatchObject({ changed: true, files: ['beta.txt'] });
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('user baseline');
      expect(readFileSync(join(repo, 'user-work.txt'), 'utf8')).toBe('preservar\n');
      expect(readFileSync(join(repo, 'alpha.txt'), 'utf8')).toBe('A\n');
      expect(readFileSync(join(repo, 'beta.txt'), 'utf8')).toBe('B\n');
      await Promise.all([removeWorktree(project, a, t.dataDir), removeWorktree(project, b, t.dataDir)]);

      const c = await createExecutorWorktree(project, { id: 'task-conflict-dirty', title: 'Conflict' }, t.dataDir);
      writeFileSync(join(c.path, 'README.md'), 'linha 1\nworker edit\nlinha 3\n');
      writeFileSync(join(repo, 'README.md'), 'linha 1\nconcurrent user edit\nlinha 3\n');
      await expect(integrateExecutorWorktree(project, c)).rejects.toThrow();
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('concurrent user edit');
      expect(readFileSync(join(c.path, 'README.md'), 'utf8')).toContain('worker edit');
      expect(existsSync(c.path)).toBe(true);
      // Once the user returns the conflicting file to the recorded baseline, retry is safe.
      writeFileSync(join(repo, 'README.md'), 'linha 1\nuser baseline\nlinha 3\n');
      expect(await integrateExecutorWorktree(project, c)).toMatchObject({ changed: true, files: ['README.md'] });
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('worker edit');
      await removeWorktree(project, c, t.dataDir);
    },
    DIRTY_INTEGRATION_TIMEOUT_MS,
  );
});

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
    expect(await executorIsolation(t.store.getProject('p')!)).toMatchObject({ mode: 'serial' });
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
    expect(await executorIsolation(t.store.getProject('q')!)).toMatchObject({ mode: 'blocked' });
    const inSub = t.session('Sub', 'q');
    expect((await t.api(`/api/sessions/${inSub.id}/worktree`)).body).toMatchObject({
      available: false,
      reason: 'a pasta do projeto não é a raiz do repositório git',
    });
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-empty-')));
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }));
    gitIn(empty, 'init', '-q', '-b', 'main');
    t.store.putProject({ ...t.store.getProject('p')!, id: 'e', path: empty });
    expect(await executorIsolation(t.store.getProject('e')!)).toMatchObject({ mode: 'blocked' });
    expect((await t.api(`/api/sessions/${t.session('E', 'e').id}/worktree`)).body).toMatchObject({
      reason: 'o repositório ainda não tem commits',
    });

    const malformed = makeRepo();
    writeFileSync(join(malformed, '.git', 'HEAD'), 'not-a-symbolic-ref\n');
    t.store.putProject({ ...t.store.getProject('p')!, id: 'm', path: malformed });
    expect(await executorIsolation(t.store.getProject('m')!)).toMatchObject({
      mode: 'blocked',
      reason: 'Metadados Git inválidos ou inacessíveis; execução bloqueada.',
    });

    const invalid = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-invalid-git-')));
    cleanup.push(() => rmSync(invalid, { recursive: true, force: true }));
    writeFileSync(join(invalid, '.git'), 'gitdir: /path/does/not/exist\\n');
    t.store.putProject({ ...t.store.getProject('p')!, id: 'i', path: invalid });
    expect(await executorIsolation(t.store.getProject('i')!)).toMatchObject({
      mode: 'blocked',
      reason: 'Metadados Git inválidos ou inacessíveis; execução bloqueada.',
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

  it(
    'applies with a commit in the worktree and a --no-ff merge commit in the main checkout',
    async () => {
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
      // Forced deletion of a merged session branch remains available only by explicit choice.
      const gone = await t.api<{ branchDeleted: boolean; session: Session }>(`/api/sessions/${s.id}/worktree`, {
        method: 'DELETE',
        body: { deleteBranch: true },
      });
      expect(gone.body.branchDeleted).toBe(true);
      expect(gone.body.session.worktree).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
      expect(gitIn(repo, 'branch', '--list', wt.branch).trim()).toBe('');
      expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt.path);
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

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

  it(
    'never runs repository hooks, filters or merge drivers',
    async () => {
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
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'discards with or without deleting the unmerged branch',
    async () => {
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
        body: { deleteBranch: false },
      });
      expect(r1.body).toMatchObject({ removed: true, branchDeleted: false });
      expect(existsSync(kept.path)).toBe(false);
      expect(gitIn(repo, 'branch', '--list', kept.branch).trim()).toContain(kept.branch);
      expect(t.store.getSession(keep.id)!.worktree).toBeUndefined();
      expect(() => gitIn(repo, 'rev-parse', '--verify', kept.ownershipProofRef!)).toThrow();

      const drop = t.session('Apagar branch');
      const dropped = await t.enable(drop.id);
      await t.finished((await t.send(drop.id, 'mude')).body.runId);
      expect(t.store.getSession(drop.id)?.activeRunId).toBeUndefined();
      expect(t.orchestrator.isActive(drop.id)).toBe(false);
      const r2 = await t.api<{ branchDeleted: boolean }>(`/api/sessions/${drop.id}/worktree`, {
        method: 'DELETE',
        body: { deleteBranch: true },
      });
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(r2.body.branchDeleted).toBe(true);
      expect(existsSync(dropped.path)).toBe(false);
      expect(t.store.getSession(drop.id)?.worktree).toBeUndefined();
      expect(gitIn(repo, 'branch', '--list', dropped.branch).trim()).toBe('');
      expect(status(repo)).toBe('');
      expect(gitIn(repo, 'branch', '--show-current').trim()).toBe('main');
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it('keeps committed session branches by default in both the HTTP and orchestrator APIs', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const viaHttp = t.session('HTTP conservador');
    const httpWorktree = await t.enable(viaHttp.id);
    writeFileSync(join(httpWorktree.path, 'committed.txt'), 'keep\n');
    gitIn(httpWorktree.path, 'add', 'committed.txt');
    gitIn(httpWorktree.path, ...ID, 'commit', '-qm', 'user commit');
    const response = await t.api(`/api/sessions/${viaHttp.id}/worktree`, { method: 'DELETE', body: {} });
    expect(response.status).toBe(200);
    expect(gitIn(repo, 'branch', '--list', httpWorktree.branch)).toContain(httpWorktree.branch);
    expect(t.store.getSession(viaHttp.id)?.worktree).toBeUndefined();

    const viaMethod = t.session('Método conservador');
    const methodWorktree = await t.enable(viaMethod.id);
    writeFileSync(join(methodWorktree.path, 'committed.txt'), 'keep\n');
    gitIn(methodWorktree.path, 'add', 'committed.txt');
    gitIn(methodWorktree.path, ...ID, 'commit', '-qm', 'user commit');
    const discarded = await t.orchestrator.discardWorktree(viaMethod.id);
    expect(discarded.removed).toBe(true);
    expect(discarded.branchDeleted).toBe(false);
    expect(gitIn(repo, 'branch', '--list', methodWorktree.branch)).toContain(methodWorktree.branch);
    expect(t.store.getSession(viaMethod.id)?.worktree).toBeUndefined();
  });

  it('preserves a merged branch by default unless deletion is explicit', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const session = t.session('Merged branch default');
    const worktree = await t.enable(session.id);
    writeFileSync(join(worktree.path, 'merged.txt'), 'merged\\n');
    gitIn(worktree.path, 'add', 'merged.txt');
    gitIn(worktree.path, ...ID, 'commit', '-qm', 'branch commit');
    gitIn(repo, ...ID, 'merge', '--no-ff', '--no-edit', worktree.branch);

    const removed = await t.api(`/api/sessions/${session.id}/worktree`, { method: 'DELETE', body: {} });
    expect(removed.status).toBe(200);
    expect((removed.body as { branchDeleted: boolean }).branchDeleted).toBe(false);
    expect(gitIn(repo, 'branch', '--list', worktree.branch)).toContain(worktree.branch);
    expect(t.store.getSession(session.id)?.worktree).toBeUndefined();
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

  it('preserves pre-cleanupPending pinned ownership records across prune and reload', async () => {
    const repo = makeRepo();
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-legacy-cleanup-')));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const t = setup(repo, { dataDir });
    const session = t.session('Legacy cleanup record');
    const worktree = await t.enable(session.id);
    writeFileSync(join(worktree.path, 'owned.txt'), 'committed by executor\n');
    gitIn(worktree.path, 'add', 'owned.txt');
    gitIn(worktree.path, ...ID, 'commit', '-qm', 'owned commit');
    const tip = gitIn(worktree.path, 'rev-parse', 'HEAD').trim();
    const protector = join(dataDir, 'legacy-branch-protector');
    gitIn(repo, 'worktree', 'add', '--quiet', '--force', protector, worktree.branch);

    const pending = await t.orchestrator.discardWorktree(session.id, true);
    expect(pending.cleanupResources).toMatchObject({
      worktree: 'removed',
      branch: 'preserved',
      ownershipProof: 'preserved',
    });
    const sessionRecord = t.store.getSession(session.id)!;
    expect(sessionRecord.worktree).toMatchObject({
      ownershipVerified: true,
      ownershipProofRef: worktree.ownershipProofRef,
      cleanupBranchTip: tip,
      cleanupPending: true,
    });

    // This is the persisted format from before cleanupPending existed; all original proof,
    // tip and ownership facts remain untouched.
    delete sessionRecord.worktree!.cleanupPending;
    t.store.putSession(sessionRecord);
    expect(t.store.getSession(session.id)?.worktree?.cleanupPending).toBeUndefined();
    expect(await t.orchestrator.pruneWorktrees()).not.toContain(session.id);
    expect(t.store.getSession(session.id)?.worktree).toMatchObject({
      ownershipVerified: true,
      ownershipProofRef: worktree.ownershipProofRef,
      cleanupBranchTip: tip,
      cleanupPending: true,
    });

    await t.close();
    const reloadedStore = new Store(dataDir);
    const restarted = createBackend(reloadedStore, t.providers).orchestrator;
    cleanup.push(async () => {
      await restarted.shutdown();
      reloadedStore.close();
    });
    expect(await restarted.pruneWorktrees()).not.toContain(session.id);
    expect(reloadedStore.getSession(session.id)?.worktree).toMatchObject({
      cleanupBranchTip: tip,
      cleanupPending: true,
    });
    const run = await restarted.start(reloadedStore.getSession(session.id)!, 'run in project');
    expect(await waitForRunIdle(reloadedStore, (sessionId) => restarted.isActive(sessionId), run.runId)).toMatchObject({
      status: 'completed',
    });
    expect(t.inputs.at(-1)?.cwd).toBe(repo);

    gitIn(repo, 'worktree', 'remove', '--force', protector);
    const retried = await restarted.discardWorktree(session.id, true);
    expect(retried.cleanupResources).toEqual({
      worktree: 'removed',
      branch: 'removed',
      ownershipProof: 'removed',
    });
    expect(reloadedStore.getSession(session.id)?.worktree).toBeUndefined();
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
    expect(existsSync(wt.path)).toBe(false);
    // The branch ref and prunable admin record are distinct resources; only the path was
    // removed here, so Git may continue reporting its stale admin record until verified prune.
    expect(gitIn(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).toContain('prunable');
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
    // Legacy metadata (no creation-bound proof) never authorizes cleanup, even without a project.
    await expect(removeWorktree(undefined, { ...meta, path }, dataDir)).rejects.toThrow(/continuidade.*não comprovada/);
    expect(existsSync(path)).toBe(true);
    await expect(removeWorktree(undefined, { ...meta, path: other }, dataDir)).rejects.toThrow(
      /continuidade.*não comprovada/,
    );
    expect(existsSync(other)).toBe(true);
  });

  it('retains recovery proof for an executor commit protected by another checkout', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(
      project,
      { id: 'committed-protected-branch', title: 'Committed branch' },
      t.dataDir,
    );
    writeFileSync(join(worktree.path, 'executor-commit.txt'), 'committed by executor\\n');
    gitIn(worktree.path, 'add', 'executor-commit.txt');
    gitIn(worktree.path, ...ID, 'commit', '-qm', 'executor commit');
    const taskTip = gitIn(worktree.path, 'rev-parse', 'HEAD').trim();
    const protector = join(t.dataDir, 'protect-committed-branch');
    gitIn(repo, 'worktree', 'add', '--force', '--quiet', protector, worktree.branch);

    const cleanupResult = await removeWorktree(project, worktree, t.dataDir);
    expect(cleanupResult).toMatchObject({
      removed: true,
      branchDeleted: false,
      cleanupResources: { worktree: 'removed', branch: 'preserved', ownershipProof: 'preserved' },
      branchTip: taskTip,
    });
    expect(gitIn(repo, 'rev-parse', `refs/heads/${worktree.branch}`).trim()).toBe(taskTip);
    expect(gitIn(repo, 'rev-parse', worktree.ownershipProofRef!).trim()).toBe(worktree.base);
    expect(
      await verifyExecutorWorktreeCandidate(
        project,
        { ...worktree, cleanupBranchTip: cleanupResult.branchTip },
        t.dataDir,
      ),
    ).toBe(true);

    gitIn(repo, 'worktree', 'remove', '--force', protector);
    const retry = await removeWorktree(project, { ...worktree, cleanupBranchTip: cleanupResult.branchTip }, t.dataDir, {
      deleteBranch: true,
    });
    expect(retry).toMatchObject({
      branchDeleted: true,
      cleanupResources: { branch: 'removed', ownershipProof: 'removed' },
    });
    expect(() => gitIn(repo, 'rev-parse', '--verify', `refs/heads/${worktree.branch}`)).toThrow();
    expect(() => gitIn(repo, 'rev-parse', '--verify', worktree.ownershipProofRef!)).toThrow();
  });

  it('recognizes a previously authorized record after every cleanup resource is already absent', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(
      project,
      { id: 'already-cleaned-worktree', title: 'Already cleaned' },
      t.dataDir,
    );
    const removed = await removeWorktree(project, worktree, t.dataDir, { deleteBranch: true });
    expect(removed).toMatchObject({
      removed: true,
      branchDeleted: true,
      cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
    });
    expect(await verifyExecutorWorktreeCandidate(project, worktree, t.dataDir)).toBe(true);
    expect(await removeWorktree(project, worktree, t.dataDir)).toMatchObject({
      removed: true,
      cleanupResources: { worktree: 'removed', branch: 'removed', ownershipProof: 'removed' },
    });

    // An absent/legacy ownership record is still not authority, even if its path is empty.
    expect(await verifyExecutorWorktreeCandidate(project, { ...worktree, ownershipVerified: false }, t.dataDir)).toBe(
      false,
    );
  });

  it('ends the active session link when keeping a committed branch and allows a new worktree', async () => {
    const repo = makeRepo();
    const t = setup(repo);
    const session = t.session('Keep committed branch');
    const worktree = await t.enable(session.id);
    writeFileSync(join(worktree.path, 'kept.txt'), 'branch content\\n');
    gitIn(worktree.path, 'add', 'kept.txt');
    gitIn(worktree.path, ...ID, 'commit', '-qm', 'keep branch commit');

    const discarded = await t.orchestrator.discardWorktree(session.id, false);
    expect(discarded.removed).toBe(true);
    expect(discarded.branchDeleted).toBe(false);
    expect(existsSync(worktree.path)).toBe(false);
    expect(gitIn(repo, 'branch', '--list', worktree.branch)).toContain(worktree.branch);
    expect(t.store.getSession(session.id)?.worktree).toBeUndefined();

    const started = await t.send(session.id, 'responder no projeto');
    expect(started.status).toBe(202);
    const run = await t.finished(started.body.runId!);
    expect(run.status).toBe('completed');
    expect(t.inputs.at(-1)?.cwd).toBe(repo);

    const replacement = await t.enable(session.id);
    expect(replacement.branch).not.toBe(worktree.branch);
    expect(existsSync(replacement.path)).toBe(true);
    expect(gitIn(repo, 'branch', '--list', worktree.branch)).toContain(worktree.branch);
  });

  it('preserves cleanup-only session records across prune and Store reload until a protected committed branch can be removed', async () => {
    const repo = makeRepo();
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-wt-reload-')));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const t = setup(repo, { dataDir });
    const session = t.session('Pending committed branch');
    const worktree = await t.enable(session.id);
    writeFileSync(join(worktree.path, 'committed.txt'), 'owned commit\\n');
    gitIn(worktree.path, 'add', 'committed.txt');
    gitIn(worktree.path, ...ID, 'commit', '-qm', 'session commit');
    const taskTip = gitIn(worktree.path, 'rev-parse', 'HEAD').trim();
    const protector = join(dataDir, 'protect-session-branch');
    gitIn(repo, 'worktree', 'add', '--quiet', '--force', protector, worktree.branch);

    const first = await t.orchestrator.discardWorktree(session.id, true);
    expect(first.removed).toBe(true);
    expect(first.branchDeleted).toBe(false);
    expect(t.store.getSession(session.id)?.worktree).toMatchObject({
      cleanupPending: true,
      cleanupBranchTip: taskTip,
      ownershipProofRef: worktree.ownershipProofRef,
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(gitIn(repo, 'rev-parse', 'refs/heads/' + worktree.branch).trim()).toBe(taskTip);
    expect(gitIn(repo, 'rev-parse', worktree.ownershipProofRef!).trim()).toBe(worktree.base);

    expect(await t.orchestrator.pruneWorktrees()).not.toContain(session.id);
    expect(t.store.getSession(session.id)?.worktree?.cleanupPending).toBe(true);

    await t.close();
    const reloadedStore = new Store(dataDir);
    const restarted = createBackend(reloadedStore, t.providers).orchestrator;
    cleanup.push(async () => {
      await restarted.shutdown();
      reloadedStore.close();
    });
    expect(reloadedStore.getSession(session.id)?.worktree).toMatchObject({ cleanupPending: true });
    expect(await restarted.pruneWorktrees()).not.toContain(session.id);
    expect(reloadedStore.getSession(session.id)?.worktree?.cleanupPending).toBe(true);

    // A retained cleanup handle is not a live workspace; post-restart runs use the project root.
    const resumed = await restarted.start(reloadedStore.getSession(session.id)!, 'run in project');
    expect(
      await waitForRunIdle(reloadedStore, (sessionId) => restarted.isActive(sessionId), resumed.runId),
    ).toMatchObject({ status: 'completed' });
    expect(t.inputs.at(-1)?.cwd).toBe(repo);

    gitIn(repo, 'worktree', 'remove', '--force', protector);
    const retried = await restarted.discardWorktree(session.id, true);
    expect(retried.branchDeleted).toBe(true);
    expect(reloadedStore.getSession(session.id)?.worktree).toBeUndefined();
    expect(() => gitIn(repo, 'rev-parse', '--verify', 'refs/heads/' + worktree.branch)).toThrow();
    expect(() => gitIn(repo, 'rev-parse', '--verify', worktree.ownershipProofRef!)).toThrow();
  });

  it(
    'reapplies pending mode and type deltas when reverse-check only warns, then recognizes exact reapplication',
    async () => {
      const repo = makeRepo();
      writeFileSync(join(repo, 'tool.sh'), '#!/bin/sh\\necho ok\\n');
      chmodSync(join(repo, 'tool.sh'), 0o755);
      writeFileSync(join(repo, 'link target.txt'), 'original\\n');
      gitIn(repo, 'add', '-A');
      gitIn(repo, ...ID, 'commit', '-qm', 'mode and type fixtures');

      const t = setup(repo);
      const worktree = await createExecutorWorktree(
        t.store.getProject('p')!,
        { id: 'mode-reapply', title: 'Mode reapply' },
        t.dataDir,
      );
      chmodSync(join(worktree.path, 'README.md'), 0o755);
      chmodSync(join(worktree.path, 'tool.sh'), 0o644);
      writeFileSync(join(worktree.path, 'link target.txt'), 'updated\\n');

      expect(await integrateExecutorWorktree(t.store.getProject('p')!, worktree)).toMatchObject({ changed: true });
      expect(readFileSync(join(repo, 'link target.txt'), 'utf8')).toBe('updated\\n');

      // Leave post-delta bytes in place but revert modes in both directions. Reverse --check
      // may succeed with a warning; expected tree modes must keep both file deltas pending.
      chmodSync(join(repo, 'README.md'), 0o644);
      chmodSync(join(repo, 'tool.sh'), 0o755);

      expect(await integrateExecutorWorktree(t.store.getProject('p')!, worktree)).toMatchObject({ changed: true });
      expect((await import('node:fs')).lstatSync(join(repo, 'README.md')).mode & 0o100).not.toBe(0);
      expect((await import('node:fs')).lstatSync(join(repo, 'tool.sh')).mode & 0o100).toBe(0);
      expect(readFileSync(join(repo, 'README.md'))).toEqual(readFileSync(join(worktree.path, 'README.md')));
      expect(readFileSync(join(repo, 'tool.sh'))).toEqual(readFileSync(join(worktree.path, 'tool.sh')));
      expect(readFileSync(join(repo, 'link target.txt'))).toEqual(readFileSync(join(worktree.path, 'link target.txt')));

      expect(await integrateExecutorWorktree(t.store.getProject('p')!, worktree)).toMatchObject({
        changed: false,
        alreadyApplied: true,
      });

      // The bytes match through the link, but the expected Git entry is a regular file.
      writeFileSync(join(repo, 'type target.txt'), readFileSync(join(worktree.path, 'link target.txt')));
      rmSync(join(repo, 'link target.txt'));
      symlinkSync('type target.txt', join(repo, 'link target.txt'));
      let typeMismatch: unknown;
      try {
        await integrateExecutorWorktree(t.store.getProject('p')!, worktree);
      } catch (error) {
        typeMismatch = error;
      }
      expect(typeMismatch).toBeInstanceOf(Error);
      expect((await import('node:fs')).lstatSync(join(repo, 'link target.txt')).isSymbolicLink()).toBe(true);
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it(
    'applies and reapplies complete regular-file/symlink deltas in both directions',
    async () => {
      const regularRepo = makeRepo();
      writeFileSync(join(regularRepo, 'convert.txt'), 'regular baseline\\n');
      gitIn(regularRepo, 'add', 'convert.txt');
      gitIn(regularRepo, ...ID, 'commit', '-qm', 'regular type fixture');
      const regularSetup = setup(regularRepo);
      const regularWorktree = await createExecutorWorktree(
        regularSetup.store.getProject('p')!,
        { id: 'regular-to-link', title: 'Regular to link' },
        regularSetup.dataDir,
      );
      rmSync(join(regularWorktree.path, 'convert.txt'));
      symlinkSync('symlink target\\xff', join(regularWorktree.path, 'convert.txt'));
      expect(await integrateExecutorWorktree(regularSetup.store.getProject('p')!, regularWorktree)).toMatchObject({
        changed: true,
        files: ['convert.txt'],
      });
      expect((await import('node:fs')).lstatSync(join(regularRepo, 'convert.txt')).isSymbolicLink()).toBe(true);
      expect((await import('node:fs')).readlinkSync(join(regularRepo, 'convert.txt'), { encoding: 'buffer' })).toEqual(
        Buffer.from('symlink target\\xff'),
      );
      expect(await integrateExecutorWorktree(regularSetup.store.getProject('p')!, regularWorktree)).toMatchObject({
        changed: false,
        alreadyApplied: true,
        files: ['convert.txt'],
      });
      await removeWorktree(regularSetup.store.getProject('p')!, regularWorktree, regularSetup.dataDir);

      const linkRepo = makeRepo();
      symlinkSync('original target\\xff', join(linkRepo, 'convert.txt'));
      gitIn(linkRepo, 'add', 'convert.txt');
      gitIn(linkRepo, ...ID, 'commit', '-qm', 'symlink type fixture');
      const linkSetup = setup(linkRepo);
      const linkWorktree = await createExecutorWorktree(
        linkSetup.store.getProject('p')!,
        { id: 'link-to-regular', title: 'Link to regular' },
        linkSetup.dataDir,
      );
      rmSync(join(linkWorktree.path, 'convert.txt'));
      writeFileSync(join(linkWorktree.path, 'convert.txt'), Buffer.from([0x72, 0x65, 0x67, 0xff, 0x0a]));
      expect(await integrateExecutorWorktree(linkSetup.store.getProject('p')!, linkWorktree)).toMatchObject({
        changed: true,
        files: ['convert.txt'],
      });
      expect((await import('node:fs')).lstatSync(join(linkRepo, 'convert.txt')).isFile()).toBe(true);
      expect(readFileSync(join(linkRepo, 'convert.txt'))).toEqual(Buffer.from([0x72, 0x65, 0x67, 0xff, 0x0a]));
      expect(await integrateExecutorWorktree(linkSetup.store.getProject('p')!, linkWorktree)).toMatchObject({
        changed: false,
        alreadyApplied: true,
        files: ['convert.txt'],
      });
      await removeWorktree(linkSetup.store.getProject('p')!, linkWorktree, linkSetup.dataDir);
    },
    REAL_GIT_WORKFLOW_TIMEOUT_MS,
  );

  it('recognizes a merged task patch on retry while preserving a distant concurrent edit', async () => {
    const repo = makeRepo();
    const lines = Array.from({ length: 30 }, (_, index) => `linha ${index + 1}`);
    writeFileSync(join(repo, 'README.md'), `${lines.join('\n')}\n`);
    gitIn(repo, 'add', 'README.md');
    gitIn(repo, ...ID, 'commit', '-qm', 'distant reapply fixture');

    const t = setup(repo);
    const project = t.store.getProject('p')!;
    const worktree = await createExecutorWorktree(
      project,
      { id: 'distant-reapply', title: 'Distant reapply' },
      t.dataDir,
    );
    lines[14] = 'alteração da tarefa';
    writeFileSync(join(worktree.path, 'README.md'), `${lines.join('\n')}\n`);

    expect(await integrateExecutorWorktree(project, worktree)).toMatchObject({ changed: true });
    lines[0] = 'edição distante';
    writeFileSync(join(repo, 'README.md'), `${lines.join('\n')}\n`);

    expect(await integrateExecutorWorktree(project, worktree)).toMatchObject({
      changed: false,
      alreadyApplied: true,
    });
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe(`${lines.join('\n')}\n`);
  });
});
