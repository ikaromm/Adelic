import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalExecutor, findHostNode } from '../server/local-executor';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('isolated local automatic executor', () => {
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
});
