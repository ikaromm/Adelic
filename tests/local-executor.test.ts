import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalExecutor,
  externalWorkspaceBindings,
  findHostNode,
  preflightLocalExecutor,
} from '../server/local-executor';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('isolated local automatic executor', () => {
  it('binds only identity-matched linked-worktree metadata and canonical in-origin dependencies', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-binding-fixture-'));
    temporaryDirectories.push(parent);
    const checkout = path.join(parent, 'checkout');
    const workspace = path.join(parent, 'worktree');
    const common = path.join(checkout, '.git');
    const admin = path.join(common, 'worktrees', 'fixture');
    const dependencies = path.join(checkout, 'node_modules');
    await mkdir(admin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(common, 'objects'), { recursive: true });
    await mkdir(path.join(common, 'refs'), { recursive: true });
    await mkdir(dependencies);
    await writeFile(path.join(checkout, 'package.json'), '{}');
    await writeFile(path.join(workspace, '.git'), `gitdir: ${admin}\n`);
    await writeFile(path.join(admin, 'commondir'), '../..\n');
    await writeFile(path.join(admin, 'gitdir'), `${path.join(workspace, '.git')}\n`);
    await writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(common, 'config'), '[user]\n\temail = host-config-canary@example.invalid\n');

    const bindings = await externalWorkspaceBindings(workspace);
    const isolatedConfig = bindings.find((binding) => binding.target === path.join(common, 'config'));
    expect(isolatedConfig).toMatchObject({ target: path.join(common, 'config'), kind: 'empty-git-config' });
    expect(isolatedConfig!.source).not.toBe('/dev/null');
    await expect(readFile(isolatedConfig!.source, 'utf8')).resolves.toBe('');
    expect(bindings).toContainEqual({
      source: await realpath(dependencies),
      target: path.join(workspace, 'node_modules'),
      kind: 'dependency',
    });
    expect(
      bindings
        .filter(({ kind }) => !kind)
        .every(({ source, target }) => source.startsWith(common) && target.startsWith(common)),
    ).toBe(true);

    const ordinaryRepo = path.join(parent, 'ordinary-repo');
    const ordinaryGit = path.join(ordinaryRepo, '.git');
    await mkdir(ordinaryGit, { recursive: true });
    await writeFile(path.join(ordinaryGit, 'config'), '[user]\\n\\temail=private@example.invalid\\n');
    const ordinaryBindings = await externalWorkspaceBindings(ordinaryRepo);
    expect(ordinaryBindings).toHaveLength(1);
    expect(ordinaryBindings[0]).toMatchObject({
      target: path.join(ordinaryGit, 'config'),
      kind: 'empty-git-config',
    });
    await expect(readFile(ordinaryBindings[0]!.source, 'utf8')).resolves.toBe('');

    // A reverse pointer to a different worktree invalidates all external mounts.
    await writeFile(path.join(admin, 'gitdir'), `${path.join(parent, 'different-worktree', '.git')}\n`);
    expect(await externalWorkspaceBindings(workspace)).toEqual([]);

    // An external symlink cannot authorize dependencies, and an existing worktree
    // node_modules path is never shadowed by a dependency mount.
    await writeFile(path.join(admin, 'gitdir'), `${path.join(workspace, '.git')}\n`);
    const external = path.join(parent, 'external-node-modules');
    await mkdir(external);
    await rm(dependencies, { recursive: true, force: true });
    await symlink(external, dependencies);
    expect((await externalWorkspaceBindings(workspace)).some(({ kind }) => kind === 'dependency')).toBe(false);
    await rm(dependencies);
    await mkdir(dependencies);
    await mkdir(path.join(workspace, 'node_modules'));
    expect((await externalWorkspaceBindings(workspace)).some(({ kind }) => kind === 'dependency')).toBe(false);
  });

  it('overlays an empty Git config in an ordinary repository without breaking git status', async () => {
    await access('/usr/bin/bwrap');
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-ordinary-git-config-'));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, 'repository');
    await mkdir(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', '--local', 'adelicprobe.canary', 'SYNTHETIC_CONFIG_CANARY']);
    const executor = await createLocalExecutor(workspace, 'workspace-write');
    try {
      const signal = new AbortController().signal;
      const canary = await executor.call(
        'exec',
        { command: 'git -C /workspace config --local --get adelicprobe.canary', timeoutMs: 5000 },
        signal,
      );
      expect(canary).toMatchObject({ exitCode: 1, stdout: '' });
      await expect(executor.call('git', { args: ['status'] }, signal)).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      await executor.close();
    }
  });

  it('runs actionable executor preflight before starting a tool process', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-preflight-'));
    temporaryDirectories.push(parent);
    const result = await preflightLocalExecutor(parent);
    if (process.platform === 'linux') {
      expect(result).toMatchObject({ ready: true, issues: [] });
    } else {
      expect(result.ready).toBe(false);
      expect(result.issues[0]).toMatchObject({ category: 'executor' });
    }
  });

  it('finds a standalone Node runtime when the application executable is Electron', async () => {
    const found = await findHostNode(os.homedir(), '/opt/adelic/Adelic', process.env);
    expect(found).toBeTruthy();
    expect(path.basename(found!)).toMatch(/^node(js)?$/);
  });

  it('restricts reads and writes to a canonical project root and blocks host credentials and networking', async () => {
    await access('/usr/bin/bwrap');
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-local-executor-'));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, 'workspace');
    await mkdir(workspace);
    await expect(createLocalExecutor(os.tmpdir(), 'workspace-write')).rejects.toThrow(/pastas de sistema/);
    await writeFile(path.join(workspace, 'source.txt'), 'inside');
    await writeFile(path.join(parent, 'outside-secret.txt'), 'outside-secret-canary');
    const hostHomeCanary = await mkdtemp(path.join(os.homedir(), '.adelic-security-test-'));
    temporaryDirectories.push(hostHomeCanary);
    const hostSecret = path.join(hostHomeCanary, 'ssh-key-canary');
    await writeFile(hostSecret, 'host-home-secret-canary');
    await symlink(path.join(parent, 'outside-secret.txt'), path.join(workspace, 'outside-link.txt'));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
    const executor = await createLocalExecutor(workspace, 'workspace-write');
    try {
      await expect(
        executor.call('read_file', { path: 'source.txt' }, new AbortController().signal),
      ).resolves.toMatchObject({
        content: 'inside',
      });
      const missing = await executor
        .call('read_file', { path: 'synthetic-secret-missing.txt' }, new AbortController().signal)
        .then(
          () => undefined,
          (error: Error & { category?: string }) => error,
        );
      expect(missing).toMatchObject({ category: 'not_found', message: 'file does not exist' });
      expect(missing?.message).not.toContain('synthetic-secret');
      const ambiguous = await executor
        .call(
          'replace_text',
          { path: 'source.txt', oldText: 'absent-secret', newText: 'replacement' },
          new AbortController().signal,
        )
        .then(
          () => undefined,
          (error: Error & { category?: string }) => error,
        );
      expect(ambiguous).toMatchObject({ category: 'conflict', message: 'oldText must match exactly once' });
      expect(ambiguous?.message).not.toContain('absent-secret');
      await expect(
        executor.call('read_file', { path: path.join(parent, 'outside-secret.txt') }, new AbortController().signal),
      ).rejects.toThrow(/escapes project root/);
      await expect(
        executor.call('read_file', { path: 'outside-link.txt' }, new AbortController().signal),
      ).rejects.toThrow(/escapes project root/);
      const hiddenHome = await executor.call(
        'exec',
        { command: `cat '${hostSecret}'`, timeoutMs: 5000 },
        new AbortController().signal,
      );
      expect((hiddenHome as { exitCode: number }).exitCode).not.toBe(0);
      expect((hiddenHome as { stdout: string }).stdout).not.toContain('host-home-secret-canary');
      await expect(
        executor.call('write_file', { path: 'output.txt', content: 'safe' }, new AbortController().signal),
      ).resolves.toMatchObject({ bytesWritten: 4 });
      await expect(readFile(path.join(workspace, 'output.txt'), 'utf8')).resolves.toBe('safe');
      await expect(
        executor.call(
          'replace_text',
          { path: 'source.txt', oldText: 'inside', newText: 'changed' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ matches: 1 });
      await expect(readFile(path.join(workspace, 'source.txt'), 'utf8')).resolves.toBe('changed');

      const node = await executor.call(
        'exec',
        { command: `node -p 'process.version'`, timeoutMs: 5000 },
        new AbortController().signal,
      );
      expect(node).toMatchObject({ exitCode: 0 });
      expect((node as { stdout: string }).stdout.trim()).toMatch(/^v\d+/);
      const npm = await executor.call(
        'exec',
        { command: 'npm --version', timeoutMs: 10000 },
        new AbortController().signal,
      );
      expect(npm).toMatchObject({ exitCode: 0 });

      const network = await executor.call(
        'exec',
        {
          command: `/usr/bin/python3 -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect(("127.0.0.1", ${address.port})); print("connected")'`,
          timeoutMs: 5000,
        },
        new AbortController().signal,
      );
      expect((network as { exitCode: number }).exitCode).not.toBe(0);
      expect((network as { stdout: string }).stdout).not.toContain('connected');

      const hiddenPath = await executor.call(
        'exec',
        { command: `cat '${path.join(parent, 'outside-secret.txt')}'`, timeoutMs: 5000 },
        new AbortController().signal,
      );
      expect((hiddenPath as { exitCode: number }).exitCode).not.toBe(0);
      expect((hiddenPath as { stdout: string }).stdout).not.toContain('outside-secret-canary');
      const hiddenOpt = await executor.call(
        'exec',
        { command: 'ls -A /opt', timeoutMs: 5000 },
        new AbortController().signal,
      );
      expect((hiddenOpt as { exitCode: number }).exitCode).toBe(0);
      expect((hiddenOpt as { stdout: string }).stdout.trim()).toBe('adelic-runtimes');

      const backgroundMarker = path.join(workspace, 'background-marker.txt');
      const background = await executor.call(
        'exec',
        {
          command: `setsid /bin/sh -c 'sleep 1; echo escaped > /workspace/background-marker.txt' >/dev/null 2>&1 &`,
          timeoutMs: 5000,
        },
        new AbortController().signal,
      );
      expect(background).toMatchObject({ exitCode: 0 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(readFile(backgroundMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        executor.call('exec', { command: 'echo next-call', timeoutMs: 5000 }, new AbortController().signal),
      ).resolves.toMatchObject({ exitCode: 0, stdout: 'next-call\n' });
    } finally {
      server.close();
      await executor.close();
    }
  });

  it('serializes concurrent edits made by separate local executor processes', async () => {
    await access('/usr/bin/bwrap');
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-local-edit-lock-'));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'shared.txt'), 'target');
    const first = await createLocalExecutor(workspace, 'workspace-write');
    const second = await createLocalExecutor(workspace, 'workspace-write');
    try {
      const page = (await first.call('read_file', { path: 'shared.txt' }, new AbortController().signal)) as {
        revision: string;
      };
      await expect(
        second.call(
          'read_file',
          { path: 'shared.txt', offset: 3, revision: page.revision },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ offset: 3, content: 'get' });
      const args = { path: 'shared.txt', oldText: 'target', expectedRevision: page.revision };
      const results = await Promise.allSettled([
        first.call('replace_text', { ...args, newText: 'alpha' }, new AbortController().signal),
        second.call('replace_text', { ...args, newText: 'bravo' }, new AbortController().signal),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { category: 'conflict', message: 'file changed before edit' },
      });
      await expect(readFile(path.join(workspace, 'shared.txt'), 'utf8')).resolves.toMatch(/^(alpha|bravo)$/);
      await expect(access(path.join(workspace, '.adelic-locks'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('uses physical root and canonical resource identity for locks across aliases and same-named roots', async () => {
    await access('/usr/bin/bwrap');
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-lock-identity-'));
    temporaryDirectories.push(parent);
    const rootA = path.join(parent, 'one', 'project');
    const rootB = path.join(parent, 'two', 'project');
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    await writeFile(path.join(rootA, 'shared.txt'), 'root-a');
    await writeFile(path.join(rootB, 'shared.txt'), 'root-b');
    const aliasA = path.join(parent, 'alias-project');
    await symlink(rootA, aliasA);
    const physicalRootA = await realpath(rootA);
    const rootStat = await stat(rootA);
    const identity = createHash('sha256')
      .update(physicalRootA)
      .update(Buffer.from([0]))
      .update(`${rootStat.dev}:${rootStat.ino}`)
      .digest('hex');
    const lockKey = createHash('sha256')
      .update(identity)
      .update(Buffer.from([0]))
      .update('shared.txt')
      .digest('hex');
    const lockHeldPath = path.join(rootA, 'lock-held');
    const previousTmpdir = process.env.TMPDIR;
    const customTmpdir = path.join(parent, 'custom-tmp');
    await mkdir(customTmpdir);
    process.env.TMPDIR = customTmpdir;
    const alias = await createLocalExecutor(aliasA, 'workspace-write');
    const other = await createLocalExecutor(rootB, 'workspace-write');
    let holder: ReturnType<typeof spawn> | undefined;
    let aliasProcess: ReturnType<typeof spawn> | undefined;
    try {
      const pageA = (await alias.call('read_file', { path: 'shared.txt' }, new AbortController().signal)) as {
        revision: string;
      };
      const pageB = (await other.call('read_file', { path: 'shared.txt' }, new AbortController().signal)) as {
        revision: string;
      };
      const lockFilePath = path.join(customTmpdir, `adelic-locks-${process.getuid?.() ?? 'user'}`, `${lockKey}.lock`);
      holder = spawn(
        'python3',
        [
          '-c',
          'import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); open(sys.argv[2],"w").write("flock-acquired"); time.sleep(30)',
          lockFilePath,
          lockHeldPath,
        ],
        { stdio: 'ignore' },
      );
      let lockHeld = false;
      for (let attempt = 0; attempt < 80 && !lockHeld; attempt++) {
        try {
          await access(lockHeldPath);
          lockHeld = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(lockHeld, 'the independent holder must signal only after acquiring the backing flock').toBe(true);
      await expect(readFile(lockHeldPath, 'utf8')).resolves.toBe('flock-acquired');

      const startOther = Date.now();
      await expect(
        other.call(
          'replace_text',
          {
            path: 'shared.txt',
            oldText: 'root-b',
            newText: 'edited-b',
            expectedRevision: pageB.revision,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ matches: 1 });
      expect(Date.now() - startOther).toBeLessThan(800);

      const aliasArgs = {
        path: 'shared.txt',
        oldText: 'root-a',
        newText: 'edited-a',
        expectedRevision: pageA.revision,
      };
      const moduleUrl = new URL('../server/local-executor.ts', import.meta.url).href;
      const aliasScript = `import { createLocalExecutor } from ${JSON.stringify(moduleUrl)}; const executor = await createLocalExecutor(${JSON.stringify(aliasA)}, 'workspace-write'); try { console.log('LOCK_CALL_STARTED'); const result = await executor.call('replace_text', ${JSON.stringify(aliasArgs)}, new AbortController().signal); console.log(JSON.stringify(result)); } finally { await executor.close(); }`;
      aliasProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', aliasScript], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: customTmpdir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let aliasOutput = '';
      let aliasExitCode: number | null = null;
      const aliasReady = new Promise<void>((resolve, reject) => {
        aliasProcess!.stdout!.setEncoding('utf8').on('data', (chunk) => {
          aliasOutput += chunk;
          if (aliasOutput.includes('LOCK_CALL_STARTED')) resolve();
        });
        aliasProcess!.stderr!.setEncoding('utf8').on('data', () => undefined);
        aliasProcess!.once('error', reject);
        aliasProcess!.on('exit', (code) => (aliasExitCode = code));
      });
      await aliasReady;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(aliasExitCode, 'a separate alias process must remain blocked by the backing flock').toBe(null);
      holder.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 100));
      let aliasApplied = false;
      for (let attempt = 0; attempt < 100 && !aliasApplied; attempt++) {
        aliasApplied = (await readFile(path.join(rootA, 'shared.txt'), 'utf8')) === 'edited-a';
        if (!aliasApplied) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(aliasApplied, 'releasing the external flock must allow the alias edit to continue').toBe(true);
      await expect(
        access(path.join(customTmpdir, `adelic-locks-${process.getuid?.() ?? 'user'}`, `${lockKey}.lock`)),
      ).resolves.toBeUndefined();
      await expect(readFile(path.join(rootA, 'shared.txt'), 'utf8')).resolves.toBe('edited-a');
      await expect(readFile(path.join(rootB, 'shared.txt'), 'utf8')).resolves.toBe('edited-b');
    } finally {
      if (aliasProcess && aliasProcess.exitCode === null) aliasProcess.kill('SIGKILL');
      if (holder && holder.exitCode === null) holder.kill('SIGKILL');
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      await Promise.all([alias.close(), other.close()]);
    }
  }, 30_000);

  it('enforces read-only mode and terminates a cancelled tool process tree', async () => {
    await access('/usr/bin/bwrap');
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-local-readonly-'));
    temporaryDirectories.push(parent);
    const workspace = path.join(parent, 'workspace');
    await mkdir(workspace);
    const executor = await createLocalExecutor(workspace, 'read-only');
    try {
      await expect(
        executor.call('write_file', { path: 'no.txt', content: 'no' }, new AbortController().signal),
      ).rejects.toThrow(/somente leitura/);
      await writeFile(path.join(workspace, 'read-only.txt'), 'unchanged');
      await expect(
        executor.call('read_file', { path: 'read-only.txt' }, new AbortController().signal),
      ).resolves.toMatchObject({ content: 'unchanged' });
      const diagnostic = (await executor.call('diagnose', {}, new AbortController().signal)) as {
        git: string;
        tmp: Record<string, boolean>;
        browsers: string[];
        browserFunctional: string[];
        binaries: Record<string, boolean>;
        hostDependentTests: string;
      };
      expect(['repository', 'binary-only', 'unavailable', 'unverified']).toContain(diagnostic.git);
      expect(diagnostic.browserFunctional.every((name) => diagnostic.browsers.includes(name))).toBe(true);
      expect(diagnostic.tmp).toHaveProperty('/var/tmp');
      expect(diagnostic.binaries).toHaveProperty('python3');
      expect(diagnostic.hostDependentTests).toContain('host services');
      await writeFile(path.join(workspace, '.git'), 'gitdir: /outside/namespace/missing\\n');
      await expect(executor.call('diagnose', {}, new AbortController().signal)).resolves.toMatchObject({
        git: 'unverified',
      });
      await expect(executor.call('list', { path: '.' }, new AbortController().signal)).resolves.toBeDefined();
      await expect(
        executor.call('stat', { path: 'read-only.txt' }, new AbortController().signal),
      ).resolves.toBeDefined();
      await expect(
        executor.call('search', { query: 'unchanged' }, new AbortController().signal),
      ).resolves.toBeDefined();
      await expect(
        executor.call(
          'replace_text',
          { path: 'read-only.txt', oldText: 'unchanged', newText: 'changed' },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/somente leitura/);
      await expect(readFile(path.join(workspace, 'read-only.txt'), 'utf8')).resolves.toBe('unchanged');
      await expect(access(path.join(workspace, '.adelic-locks'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(executor.call('exec', { command: 'true' }, new AbortController().signal)).rejects.toThrow(
        /somente leitura/,
      );
      await expect(
        executor.call('write_file', { path: 'no.txt', content: 'no' }, new AbortController().signal),
      ).rejects.toThrow(/somente leitura/);
    } finally {
      await executor.close();
    }

    const writable = await createLocalExecutor(workspace, 'workspace-write');
    const controller = new AbortController();
    try {
      const pending = writable.call(
        'exec',
        { command: '/bin/sh -c "sleep 1; echo escaped > /workspace/cancel-marker.txt"', timeoutMs: 30000 },
        controller.signal,
      );
      setTimeout(() => controller.abort(new Error('cancelled by test')), 100).unref();
      await expect(pending).rejects.toThrow(/cancelled by test/);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await expect(readFile(path.join(workspace, 'cancel-marker.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await writable.close();
    }
  });

  it('verifies Git metadata and private scratch in an automatic checkout', async () => {
    await access('/usr/bin/bwrap');
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'adelic-worktree-capability-'));
    temporaryDirectories.push(worktree);
    const initialStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    let worktreeAdded = false;
    let executor: Awaited<ReturnType<typeof createLocalExecutor>> | undefined;
    try {
      execFileSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], {
        cwd: process.cwd(),
        stdio: 'ignore',
      });
      worktreeAdded = true;
      executor = await createLocalExecutor(worktree, 'workspace-write');
      const signal = new AbortController().signal;
      const diagnostic = (await executor.call('diagnose', {}, signal)) as {
        git: string;
        tmp: Record<string, boolean>;
        hostDependentTests: string;
      };
      expect(diagnostic.git).toBe('repository');
      expect(diagnostic.tmp['/tmp']).toBe(true);
      expect(diagnostic.tmp['/var/tmp']).toBe(true);
      expect(diagnostic.hostDependentTests).toContain('host SSH account/agent');

      const status = await executor.call('git', { args: ['status'] }, signal);
      expect(status).toMatchObject({ exitCode: 0 });
      const hiddenConfig = await executor.call(
        'exec',
        { command: 'git -C /workspace config --local --list', timeoutMs: 5000 },
        signal,
      );
      // An empty synthetic config keeps Git's local config query usable without exposing host config.
      expect(hiddenConfig).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
      const scratch = 'adelic-private-scratch-capability';
      const scratchWrite = await executor.call(
        'exec',
        { command: `printf private > /var/tmp/${scratch}`, timeoutMs: 5000 },
        signal,
      );
      expect(scratchWrite).toMatchObject({ exitCode: 0 });
      await expect(access(path.join('/var/tmp', scratch))).rejects.toMatchObject({ code: 'ENOENT' });
      const dependencyWrite = await executor.call(
        'exec',
        { command: 'touch /workspace/node_modules/.adelic-readonly-canary', timeoutMs: 5000 },
        signal,
      );
      expect(dependencyWrite).toMatchObject({ exitCode: 1 });
      await expect(access(path.join(process.cwd(), 'node_modules/.adelic-readonly-canary'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await executor?.close();
      if (worktreeAdded) {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], {
          cwd: process.cwd(),
          stdio: 'ignore',
        });
      }
    }
    expect(
      execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }),
    ).toBe(initialStatus);
  });
});
