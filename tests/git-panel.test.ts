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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { compareUrl, gitCommit, gitDiff, gitStatus, parseStatus } from '../server/git-panel.js';
import type { GitStatus, ProviderRegistry, Run, Session } from '../shared/contracts.js';
import { gitIn } from './git-fixtures.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false'];

/** A repository with its own identity (local config), one commit and a few kinds of change. */
function makeRepo(opts: { identity?: boolean } = {}) {
  const dir = temp('adelic-gitpanel-');
  gitIn(dir, 'init', '-q', '-b', 'main');
  if (opts.identity !== false) {
    gitIn(dir, 'config', 'user.name', 'Pessoa Teste');
    gitIn(dir, 'config', 'user.email', 'pessoa@example.invalid');
  }
  gitIn(dir, 'config', 'commit.gpgSign', 'false');
  writeFileSync(join(dir, 'README.md'), 'linha 1\nlinha 2\n');
  writeFileSync(join(dir, 'antigo nome.txt'), 'conteúdo que será renomeado\n');
  writeFileSync(join(dir, 'apagar.txt'), 'tchau\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, ...ID, 'commit', '-qm', 'init');
  return dir;
}
/** Isolated HOME so the developer's global identity never leaks into the "missing identity" test. */
function isolateHome() {
  const home = temp('adelic-gitpanel-home-');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  cleanup.push(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}

function setup(projectPath: string, opts: { runHooks?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adelic-gitpanel-data-'));
  const store = new Store(dataDir);
  store.setSettings({ ...store.getSettings()!, sandbox: 'workspace-write' });
  const now = new Date().toISOString();
  store.putProject({
    id: 'p',
    name: 'P',
    path: projectPath,
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: { enabled: false, maxWorkers: 1, review: false },
    ...(opts.runHooks ? { git: { runHooks: true } } : {}),
  });
  const gates: (() => void)[] = [];
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
      if (input.prompt.includes('[esperar]')) await new Promise<void>((r) => gates.push(r));
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
  const base = new Promise<string>((r) => {
    const done = () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    if (server.listening) done();
    else server.once('listening', done);
  });
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${await base}/api/projects/p/git/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const session = () => {
    const s: Session = {
      id: `s-${Math.random().toString(36).slice(2)}`,
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
    return s;
  };
  const finished = (runId: string) =>
    new Promise<Run>((resolve) => {
      const check = () => {
        const run = store.getRun(runId);
        if (run && run.status !== 'running') return resolve(run);
        setTimeout(check, 10);
      };
      check();
    });
  const waiting = async () => {
    while (!gates.length) await new Promise((r) => setTimeout(r, 10));
  };
  const release = () => gates.splice(0).forEach((g) => g());
  return { store, orchestrator, api, session, finished, waiting, release, base };
}
const files = (status: Record<string, unknown>) =>
  (status.files as { path: string; area: string; letter: string; origPath?: string }[]).map((f) =>
    [f.area, f.letter, f.path, f.origPath].filter(Boolean).join(' '),
  );

describe('git status parsing', () => {
  it('parses branch, upstream, renames, spaces, unicode and conflicts from porcelain v2', () => {
    const out = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb com espaço é.txt',
      '1 .D N... 100644 100644 000000 aaa aaa apagado.txt',
      '2 RM N... 100644 100644 100644 aaa aaa R100 novo nome.txt',
      'velho nome.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflito.txt',
      '? não rastreado ü.md',
      '',
    ].join('\0');
    const parsed = parseStatus(out);
    expect(parsed).toMatchObject({
      branch: 'feat/x',
      head: '0123456789ab',
      upstream: 'origin/feat/x',
      ahead: 2,
      behind: 1,
    });
    expect(parsed.files).toEqual([
      { path: 'com espaço é.txt', area: 'staged', letter: 'M' },
      { path: 'apagado.txt', area: 'unstaged', letter: 'D' },
      { path: 'novo nome.txt', area: 'staged', letter: 'R', origPath: 'velho nome.txt' },
      { path: 'novo nome.txt', area: 'unstaged', letter: 'M' },
      { path: 'conflito.txt', area: 'unstaged', letter: 'U' },
      { path: 'não rastreado ü.md', area: 'untracked', letter: '?' },
    ]);
    expect(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0')).toMatchObject({
      head: null,
      branch: null,
      files: [],
    });
  });

  it('reads a real repository: rename, deletion, spaces and unicode, and no upstream', async () => {
    const repo = makeRepo();
    gitIn(repo, 'mv', 'antigo nome.txt', 'novo nome ç.txt');
    writeFileSync(join(repo, 'README.md'), 'linha 1\nlinha 2 editada\n');
    rmSync(join(repo, 'apagar.txt'));
    mkdirSync(join(repo, 'pasta nova'));
    writeFileSync(join(repo, 'pasta nova', 'código ü.ts'), 'x\n');
    const status = await gitStatus({ path: repo });
    expect(status).toMatchObject({ repo: true, branch: 'main', runHooks: false });
    expect(status.repo && status.upstream).toBeFalsy();
    expect(files(status as unknown as Record<string, unknown>)).toEqual([
      'unstaged M README.md',
      'unstaged D apagar.txt',
      'staged R novo nome ç.txt antigo nome.txt',
      'untracked ? pasta nova/código ü.ts',
    ]);
    expect(await gitStatus({ path: temp('adelic-nogit-') })).toEqual({
      repo: false,
      reason: 'não é um repositório git',
    });
  });
});

describe('git panel API', () => {
  it('stages, unstages, diffs and commits with the repository identity', async () => {
    const repo = makeRepo();
    const { api } = setup(repo);
    writeFileSync(join(repo, 'README.md'), 'linha 1\nlinha 2 editada\n');
    writeFileSync(join(repo, 'novo é.txt'), 'olá\n');

    const working = await api(`diff?path=${encodeURIComponent('README.md')}`);
    expect(working.status).toBe(200);
    expect(working.body.diff).toContain('+linha 2 editada');
    expect((await api(`diff?path=${encodeURIComponent('novo é.txt')}`)).body.diff).toContain('+olá');
    // Only paths from the status list, in the right area.
    expect((await api('diff?path=README.md&staged=1')).status).toBe(404);
    expect((await api(`diff?path=${encodeURIComponent('../../etc/passwd')}`)).status).toBe(404);
    expect((await api('diff')).status).toBe(400);
    expect((await api('stage', { paths: ['../fora.txt'] })).status).toBe(400);
    expect((await api('stage', {})).status).toBe(400);

    const staged = await api('stage', { paths: ['README.md', 'novo é.txt'] });
    expect(staged.status).toBe(200);
    expect(files(staged.body)).toEqual(['staged M README.md', 'staged A novo é.txt']);
    expect((await api('diff?path=README.md&staged=1')).body.diff).toContain('-linha 2');

    const unstaged = await api('unstage', { paths: ['novo é.txt'] });
    expect(files(unstaged.body)).toEqual(['staged M README.md', 'untracked ? novo é.txt']);
    expect(files((await api('stage', { all: true })).body)).toEqual(['staged M README.md', 'staged A novo é.txt']);
    expect(files((await api('unstage', { all: true })).body)).toEqual([
      'unstaged M README.md',
      'untracked ? novo é.txt',
    ]);
    await api('stage', { all: true });

    expect((await api('commit', { message: '   ' })).status).toBe(400);
    expect((await api('commit', { message: 'x'.repeat(5001) })).status).toBe(400);
    const commit = await api('commit', { message: 'Primeira mudança\n\nCorpo com acentuação' });
    expect(commit.status).toBe(201);
    expect(gitIn(repo, 'log', '-1', '--format=%an <%ae>|%s')).toBe(
      'Pessoa Teste <pessoa@example.invalid>|Primeira mudança\n',
    );
    expect((await api('status')).body.files).toEqual([]);
    expect((await api('commit', { message: 'nada' })).status).toBe(409);

    const log = await api('log');
    const commits = log.body.commits as {
      hash: string;
      short: string;
      subject: string;
      author: string;
      date: string;
    }[];
    expect(commits.map((c) => c.subject)).toEqual(['Primeira mudança', 'init']);
    expect(commits[0]).toMatchObject({ hash: commit.body.hash, author: 'Pessoa Teste' });
    expect(commits[0].date).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('discards working changes, deletes untracked files and asks again for mixed files', async () => {
    const repo = makeRepo();
    const { api } = setup(repo);
    writeFileSync(join(repo, 'README.md'), 'staged\n');
    gitIn(repo, 'add', 'README.md');
    writeFileSync(join(repo, 'README.md'), 'staged e depois editado\n');
    writeFileSync(join(repo, 'apagar.txt'), 'editado\n');
    mkdirSync(join(repo, 'só aqui'));
    writeFileSync(join(repo, 'só aqui', 'lixo.txt'), 'x\n');

    expect((await api('discard', { paths: ['apagar.txt'] })).status).toBe(400);
    const mixed = await api('discard', { paths: ['README.md'], confirm: true });
    expect(mixed.status).toBe(409);
    expect(mixed.body.error).toMatch(/também têm alterações no índice/);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('staged e depois editado\n');

    const result = await api('discard', {
      paths: ['README.md', 'apagar.txt', 'só aqui/lixo.txt'],
      confirm: true,
      mixed: true,
    });
    expect(result.status).toBe(200);
    // Back to the staged content; the index keeps the staged change.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('staged\n');
    expect(readFileSync(join(repo, 'apagar.txt'), 'utf8')).toBe('tchau\n');
    expect(existsSync(join(repo, 'só aqui'))).toBe(false);
    expect(files(result.body)).toEqual(['staged M README.md']);
  });

  it('caps diffs at 200 KB', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'grande.txt'), 'linha comprida de teste\n'.repeat(20_000));
    const diff = await gitDiff({ path: repo }, 'grande.txt', false);
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(200 * 1024);
    expect(diff.diff.endsWith('\n')).toBe(true);
  });

  it('never runs filters or textconv configured in the repository', async () => {
    const repo = makeRepo();
    const marker = join(temp('adelic-marker-'), 'ran');
    gitIn(repo, 'config', 'filter.evil.clean', `touch '${marker}'; cat`);
    gitIn(repo, 'config', 'filter.evil.smudge', `touch '${marker}'; cat`);
    gitIn(repo, 'config', 'diff.evil.textconv', `touch '${marker}'; cat`);
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil diff=evil\n');
    writeFileSync(join(repo, 'apagar.txt'), 'editado\n');
    const { api } = setup(repo);
    await api('status');
    await api('diff?path=apagar.txt');
    expect((await api('stage', { all: true })).status).toBe(200);
    expect((await api('commit', { message: 'com filtro' })).status).toBe(201);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('commit safety', () => {
  function plantHooks(repo: string) {
    const marker = join(temp('adelic-hook-'), 'hook-ran');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    // Config-defined hooks bypass core.hooksPath; they must be off too.
    const configMarker = `${marker}-config`;
    gitIn(repo, 'config', 'hook.planted.command', `touch '${configMarker}'`);
    gitIn(repo, 'config', 'hook.planted.event', 'pre-commit');
    return { marker, configMarker };
  }

  it('does not run a planted pre-commit hook by default', async () => {
    const repo = makeRepo();
    const { marker, configMarker } = plantHooks(repo);
    const { api } = setup(repo);
    writeFileSync(join(repo, 'README.md'), 'mudou\n');
    await api('stage', { all: true });
    expect((await api('commit', { message: 'sem hooks' })).status).toBe(201);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(configMarker)).toBe(false);
  });

  it('runs the hooks when the project opted in', async () => {
    const repo = makeRepo();
    const { marker, configMarker } = plantHooks(repo);
    const { api } = setup(repo, { runHooks: true });
    expect((await api('status')).body.runHooks).toBe(true);
    writeFileSync(join(repo, 'README.md'), 'mudou\n');
    await api('stage', { all: true });
    expect((await api('commit', { message: 'com hooks' })).status).toBe(201);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(configMarker)).toBe(true);
  });

  it('saves the opt-in on the project through PATCH', async () => {
    const repo = makeRepo();
    const { base, store } = setup(repo);
    const patch = async (body: unknown) =>
      fetch(`${await base}/api/projects/p`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await patch({ git: { runHooks: true } })).status).toBe(200);
    expect(store.getProject('p')?.git).toEqual({ runHooks: true });
    expect((await patch({ git: { runHooks: 'sim' } })).status).toBe(400);
  });

  it('answers 409 when user.name or user.email is missing, and does not set them', async () => {
    isolateHome();
    const repo = makeRepo({ identity: false });
    writeFileSync(join(repo, 'README.md'), 'mudou\n');
    gitIn(repo, 'add', 'README.md');
    const head = gitIn(repo, 'rev-parse', 'HEAD');
    const { api } = setup(repo);
    const result = await api('commit', { message: 'sem identidade' });
    expect(result).toEqual({ status: 409, body: { error: 'Configure user.name e user.email no git' } });
    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(() => gitIn(repo, 'config', '--get', 'user.name')).toThrow();
    await expect(gitCommit({ path: repo }, 'x')).rejects.toMatchObject({ status: 409 });
  });
});

describe('push', () => {
  function withRemote() {
    const repo = makeRepo();
    const bare = temp('adelic-bare-');
    gitIn(bare, 'init', '-q', '--bare', '-b', 'main');
    gitIn(repo, 'remote', 'add', 'origin', bare);
    gitIn(repo, 'push', '-q', '-u', 'origin', 'main');
    return { repo, bare };
  }

  it('refuses without an upstream', async () => {
    const repo = makeRepo();
    const { api } = setup(repo);
    expect((await api('push-target')).body).toEqual({ target: null });
    expect((await api('push', {})).status).toBe(400);
    const result = await api('push', { confirm: true });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/não tem upstream/);
  });

  it('pushes to a bare remote and reports ahead/behind from local refs', async () => {
    const { repo, bare } = withRemote();
    const { api } = setup(repo);
    writeFileSync(join(repo, 'README.md'), 'mudou\n');
    await api('stage', { all: true });
    await api('commit', { message: 'para enviar' });
    expect((await api('status')).body).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0 });
    expect((await api('push-target')).body).toEqual({
      target: { remote: 'origin', branch: 'main', remoteBranch: 'main' },
    });
    const pushed = await api('push', { confirm: true });
    expect(pushed).toEqual({ status: 200, body: { remote: 'origin', branch: 'main', remoteBranch: 'main' } });
    expect(gitIn(bare, 'log', '-1', '--format=%s', 'main')).toBe('para enviar\n');
    expect((await api('status')).body).toMatchObject({ ahead: 0, behind: 0 });
  });

  it('never forces: a diverged remote rejects the push and keeps its commits', async () => {
    const { repo, bare } = withRemote();
    const other = temp('adelic-clone-');
    gitIn(other, 'clone', '-q', bare, '.');
    writeFileSync(join(other, 'outro.txt'), 'x\n');
    gitIn(other, 'add', '-A');
    gitIn(other, ...ID, 'commit', '-qm', 'do outro lado');
    gitIn(other, 'push', '-q');
    const remoteHead = gitIn(bare, 'rev-parse', 'main');
    writeFileSync(join(repo, 'README.md'), 'local\n');
    gitIn(repo, 'add', '-A');
    gitIn(repo, ...ID, 'commit', '-qm', 'local');
    const { api } = setup(repo);
    const result = await api('push', { confirm: true });
    expect(result.status).toBe(502);
    expect(result.body.error).toMatch(/O envio falhou/);
    expect(gitIn(bare, 'rev-parse', 'main')).toBe(remoteHead);
  });

  it('refuses when the repository config would run a program during push', async () => {
    const { repo } = withRemote();
    const marker = join(temp('adelic-marker-'), 'ran');
    gitIn(repo, 'config', 'remote.origin.receivepack', `touch '${marker}'; git-receive-pack`);
    const { api } = setup(repo);
    const result = await api('push', { confirm: true });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/remote\.origin\.receivepack/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('mutations while a run writes', () => {
  it('answers 409 for stage/discard/commit/push while a writing run is active, then allows them', async () => {
    const repo = makeRepo();
    const { api, orchestrator, session, finished, waiting, release } = setup(repo);
    writeFileSync(join(repo, 'README.md'), 'mudou\n');
    const { runId } = await orchestrator.start(session(), '[esperar] escreva');
    await waiting();
    const status = (await api('status')).body as unknown as Extract<GitStatus, { repo: true }>;
    expect(status.blocked).toMatch(/execução alterando arquivos/);
    for (const [path, body] of [
      ['stage', { all: true }],
      ['unstage', { all: true }],
      ['discard', { paths: ['README.md'], confirm: true }],
      ['commit', { message: 'x' }],
      ['push', { confirm: true }],
    ] as const) {
      const result = await api(path, body);
      expect(result.status, path).toBe(409);
    }
    // Reads stay available.
    expect((await api('diff?path=README.md')).status).toBe(200);
    release();
    await finished(runId);
    expect((await api('status')).body.blocked).toBeUndefined();
    expect((await api('stage', { all: true })).status).toBe(200);
  });

  it('refuses a new run while a git operation is in progress in the project', async () => {
    const repo = makeRepo();
    const { orchestrator, session } = setup(repo);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const op = orchestrator.withGitOperation(repo, () => gate);
    await expect(orchestrator.start(session(), 'oi')).rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.withGitOperation(repo, async () => undefined)).rejects.toMatchObject({ status: 409 });
    release();
    await op;
    expect(orchestrator.gitBlock(repo)).toBeUndefined();
  });

  it('answers 404 for an unknown project and 409 for a folder that is not a repository', async () => {
    const dir = temp('adelic-nogit-');
    const { api, base } = setup(dir);
    expect((await api('status')).body).toEqual({ repo: false, reason: 'não é um repositório git' });
    expect((await api('log')).status).toBe(409);
    expect((await api('stage', { all: true })).status).toBe(409);
    const missing = await fetch(`${await base}/api/projects/nao-existe/git/status`);
    expect(missing.status).toBe(404);
  });
});

describe('pull request compare URL', () => {
  it.each([
    ['https://github.com/dono/repo.git', 'https://github.com/dono/repo/compare/main...feat/x?expand=1'],
    ['https://user:token@github.com/dono/repo', 'https://github.com/dono/repo/compare/main...feat/x?expand=1'],
    ['git@github.com:dono/repo.git', 'https://github.com/dono/repo/compare/main...feat/x?expand=1'],
    ['ssh://git@github.com/dono/repo.git', 'https://github.com/dono/repo/compare/main...feat/x?expand=1'],
    [
      'git@gitlab.com:grupo/sub/repo.git',
      'https://gitlab.com/grupo/sub/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main',
    ],
    [
      'https://gitlab.empresa.example/grupo/repo',
      'https://gitlab.empresa.example/grupo/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main',
    ],
  ])('%s', (remote, expected) => {
    expect(compareUrl(remote, 'main', 'feat/x')?.url).toBe(expected);
  });

  it('returns nothing for other hosts, local paths and odd URLs', () => {
    for (const remote of [
      'https://bitbucket.org/dono/repo.git',
      '/srv/git/repo.git',
      'file:///srv/repo',
      'https://github.com/dono',
      'https://github.com/dono/re%20po',
      'ext::sh -c touch',
      'nem uma url',
    ])
      expect(compareUrl(remote, 'main', 'feat/x'), remote).toBeUndefined();
    expect(compareUrl('git@github.com:a/b.git', undefined, 'feat/é')?.url).toBe(
      'https://github.com/a/b/compare/feat/%C3%A9?expand=1',
    );
  });

  it('builds the URL from origin through the API, against the default branch', async () => {
    const repo = makeRepo();
    gitIn(repo, 'remote', 'add', 'origin', 'git@github.com:dono/repo.git');
    gitIn(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const { api } = setup(repo);
    expect((await api('pr-url')).status).toBe(409); // on the default branch
    gitIn(repo, 'checkout', '-q', '-b', 'feat/painel');
    expect((await api('pr-url')).body).toEqual({
      provider: 'github',
      url: 'https://github.com/dono/repo/compare/main...feat/painel?expand=1',
      base: 'main',
      branch: 'feat/painel',
    });
    gitIn(repo, 'remote', 'set-url', 'origin', 'https://example.com/dono/repo.git');
    expect((await api('pr-url')).status).toBe(422);
    gitIn(repo, 'remote', 'remove', 'origin');
    expect((await api('pr-url')).status).toBe(409);
  });
});
