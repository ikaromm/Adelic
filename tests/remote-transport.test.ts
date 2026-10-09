import { mkdtemp, readFile, rm, stat, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteHostService, reconstructRemoteError, validateRemoteResult } from '../server/remote/transport.js';
import { remoteToolError } from '../server/providers/remote-tools.js';
import { REMOTE_RUNNER_SOURCE } from '../server/remote/runner-source.js';
import type { RemoteHost } from '../shared/remote-hosts.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
let harnessUnavailableReason: string | undefined;
let harness:
  | {
      root: string;
      service: ReturnType<typeof RemoteHostService>;
      host: RemoteHost;
      project: string;
      shutdown(): Promise<void>;
    }
  | undefined;

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
};

const waitUntilSshReady = async (port: number, child: ReturnType<typeof spawn>): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('sshd exited before becoming ready');
    const connected = await new Promise<boolean>((resolve) => {
      const client = new Socket();
      client.setTimeout(100);
      client.once('connect', () => {
        client.destroy();
        resolve(true);
      });
      client.once('error', () => resolve(false));
      client.once('timeout', () => {
        client.destroy();
        resolve(false);
      });
      client.connect(port, '127.0.0.1');
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('sshd did not become ready');
};

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'adelic-remote-transport-'));
  roots.push(base);
  const bin = await execFileAsync('sh', ['-lc', 'command -v sshd']).catch(() => undefined);
  if (!bin?.stdout.trim()) {
    harnessUnavailableReason = 'sshd executable unavailable';
    return;
  }
  const user = process.env.USER;
  if (!user) {
    harnessUnavailableReason = 'USER is unset; no local SSH account is available';
    return;
  }
  const sshDir = join(base, 'ssh');
  await mkdir(sshDir, { mode: 0o700 });
  const clientKey = join(sshDir, 'client_key');
  const hostKey = join(sshDir, 'host_key');
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  const authorized = join(sshDir, 'authorized_keys');
  await writeFile(authorized, await readFile(`${clientKey}.pub`, 'utf8'), { mode: 0o600 });
  const port = await freePort();
  const sshConfig = join(sshDir, 'config');
  const daemonConfig = join(sshDir, 'sshd_config');
  const pidFile = join(sshDir, 'sshd.pid');
  await writeFile(
    sshConfig,
    `Host shared-lab\n  HostName 127.0.0.1\n  Port ${port}\n  User ${user}\n  IdentityFile ${clientKey}\n  IdentitiesOnly yes\n  BatchMode yes\n  ForwardAgent yes\n  ForwardX11 yes\n  ControlMaster yes\n  ControlPath ${join(sshDir, 'shared-control')}\n  RemoteForward 45678 127.0.0.1:22\n  PermitLocalCommand yes\n  LocalCommand touch ${join(sshDir, 'local-command-ran')}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    daemonConfig,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `PidFile ${pidFile}`,
      `AuthorizedKeysFile ${authorized}`,
      'PubkeyAuthentication yes',
      'AuthenticationMethods publickey',
      'PasswordAuthentication no',
      'PermitRootLogin no',
      'StrictModes no',
      'UsePAM no',
      'UseDNS no',
      'AllowTcpForwarding no',
      'X11Forwarding no',
      'PermitTunnel no',
      'PermitUserEnvironment no',
      'LogLevel ERROR',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  await chmod(sshDir, 0o700);
  const sshd = spawn(bin.stdout.trim(), ['-D', '-e', '-f', daemonConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
  let daemonError = '';
  sshd.stderr.setEncoding('utf8');
  sshd.stderr.on('data', (chunk: string) => {
    daemonError += chunk;
  });
  try {
    await waitUntilSshReady(port, sshd);
  } catch (error) {
    sshd.kill('SIGTERM');
    if (/privilege separation|root|permission denied/i.test(daemonError)) return;
    throw error;
  }
  const dataDir = join(base, 'data');
  const project = join(base, 'project');
  const remoteHome = join(base, 'remote-home');
  await mkdir(project);
  const service = RemoteHostService(dataDir, { configFile: sshConfig });
  const probe = await service.probe('shared-lab', port);
  const host: RemoteHost = {
    id: 'shared-lab-test',
    name: 'Local SSH integration test',
    target: 'shared-lab',
    port,
    fingerprint: probe.fingerprint,
    hostKey: probe.hostKey,
    runnerPath: join(remoteHome, '.local', 'share', 'adelic', 'runner.py'),
    createdAt: new Date().toISOString(),
  };
  harness = {
    root: base,
    service,
    host,
    project,
    async shutdown() {
      await service.shutdown();
      sshd.kill('SIGTERM');
      await new Promise<void>((resolve) => sshd.once('close', () => resolve()));
    },
  };
}, 20000);

afterAll(async () => {
  if (harness) await harness.shutdown();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SSH remote host transport', () => {
  it('validates bounded executor capability diagnostics', () => {
    const report = {
      git: 'binary-only',
      tmp: { '/tmp': true, '/var/tmp': false },
      browsers: [],
      browserFunctional: [],
      binaries: { git: true },
      hostDependentTests: 'Host tests may not run.',
    };
    expect(validateRemoteResult('diagnose', report)).toEqual(report);
    // Older installed SSH runners omit browserFunctional; absence means not verified, not failure.
    const legacyReport = { ...report } as Record<string, unknown>;
    delete legacyReport.browserFunctional;
    expect(validateRemoteResult('diagnose', legacyReport)).toEqual(legacyReport);
    expect(() => validateRemoteResult('diagnose', { ...report, tmp: {} })).toThrow(/diagnose result/);
  });

  it('reconstructs only allowlisted error categories and sanitizes legacy or invalid messages', () => {
    const valid = reconstructRemoteError('SYNTHETIC_SECRET', 'not_found');
    expect(valid.category).toBe('not_found');
    expect(valid.message).toBe('requested path was not found');
    const legacy = reconstructRemoteError('SYNTHETIC_SECRET', undefined);
    expect(legacy.category).toBeUndefined();
    expect(legacy.message).toBe('remote tool failed');
    const invalid = reconstructRemoteError('SYNTHETIC_SECRET', 'SYNTHETIC_SECRET_CATEGORY');
    expect(invalid.category).toBeUndefined();
    expect(invalid.message).toBe('remote tool failed');
    for (const error of [valid, legacy, invalid]) expect(error.message).not.toContain('SYNTHETIC_SECRET');
  });

  it('validates the bounded replace_text result shape from an untrusted executor', () => {
    expect(
      validateRemoteResult('replace_text', {
        path: '/project/large.txt',
        matches: 1,
        bytesWritten: 2 * 1024 * 1024,
      }),
    ).toEqual({ path: '/project/large.txt', matches: 1, bytesWritten: 2 * 1024 * 1024 });
    expect(validateRemoteResult('replace_text', { path: '/project/file.txt', matches: 1, bytesWritten: 5 })).toEqual({
      path: '/project/file.txt',
      matches: 1,
      bytesWritten: 5,
    });
    for (const malformed of [
      { path: '/project/file.txt', matches: 0, bytesWritten: 5 },
      { path: '/project/file.txt', matches: 2, bytesWritten: 5 },
      { path: '/project/file.txt', matches: 1, bytesWritten: -1 },
      { path: '/project/file.txt', matches: 1, bytesWritten: 32 * 1024 * 1024 + 1 },
      { path: '/project/file.txt', matches: true, bytesWritten: 5 },
    ])
      expect(() => validateRemoteResult('replace_text', malformed)).toThrow(/did not match its schema/);
  });

  it('validates complete paged-read metadata from an untrusted executor', () => {
    const valid = {
      path: '/project/file.txt',
      content: 'hello',
      offset: 0,
      bytesRead: 5,
      totalBytes: 10,
      truncated: true,
      nextOffset: 5,
      revision: '1:2:10:3:4',
    };
    expect(validateRemoteResult('read_file', valid)).toEqual(valid);
    for (const malformed of [
      { ...valid, nextOffset: 6 },
      { ...valid, bytesRead: 4 },
      { ...valid, content: 'x'.repeat(48 * 1024 + 1) },
      { ...valid, revision: '../path' },
    ])
      expect(() => validateRemoteResult('read_file', malformed)).toThrow(/did not match its schema/);
  });

  it('probes, pins, installs and runs the credential-free runner over a configured SSH alias', async (context) => {
    if (!harness)
      context.skip(`SSH integration infrastructure unavailable: ${harnessUnavailableReason ?? 'fixture setup failed'}`);
    const { root, service, host, project } = harness!;
    const probe = await service.probe(host.target);
    expect(probe).toMatchObject({
      target: 'shared-lab',
      port: host.port,
      hostname: '127.0.0.1',
      fingerprint: host.fingerprint,
    });
    await service.install(host);
    expect(await readFile(host.runnerPath, 'utf8')).toBe(REMOTE_RUNNER_SOURCE);
    expect((await stat(join(root, 'data', 'remote-hosts', 'known_hosts', host.id))).mode & 0o777).toBe(0o600);
    const connection = await service.connect(host, project);
    try {
      expect(await connection.info()).toMatchObject({ protocol: 1, root: project });
      const diagnostic = (await connection.call('diagnose', {}, AbortSignal.timeout(5000))) as {
        git: string;
        browsers: string[];
        browserFunctional: string[];
      };
      expect(['repository', 'binary-only', 'unavailable', 'unverified']).toContain(diagnostic.git);
      expect(diagnostic.browserFunctional.every((name) => diagnostic.browsers.includes(name))).toBe(true);
      const controller = new AbortController();
      const slow = connection.call('exec', { command: 'sleep 30', timeoutMs: 60000 }, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error('test cancellation'));
      await expect(slow).rejects.toThrow('test cancellation');
      expect(
        await connection.call(
          'exec',
          { command: ['printf', 'still-alive'], timeoutMs: 5000 },
          AbortSignal.timeout(5000),
        ),
      ).toMatchObject({ exitCode: 0, stdout: 'still-alive' });
      expect(
        await connection.call('write_file', { path: 'remote.txt', content: 'from ssh' }, AbortSignal.timeout(5000)),
      ).toMatchObject({ bytesWritten: 8 });
      await connection.call('read_file', { path: 'remote.txt' }, AbortSignal.timeout(5000));
      expect(
        await connection.call(
          'replace_text',
          { path: 'remote.txt', oldText: 'from ssh', newText: 'edited' },
          AbortSignal.timeout(5000),
        ),
      ).toMatchObject({ matches: 1, bytesWritten: 6 });
      expect(await connection.call('read_file', { path: 'remote.txt' }, AbortSignal.timeout(5000))).toMatchObject({
        content: 'edited',
      });
      const missing = await connection.call('read_file', { path: 'missing.txt' }, AbortSignal.timeout(5000)).then(
        () => undefined,
        (error: Error & { category?: string }) => error,
      );
      expect(missing).toMatchObject({ category: 'not_found', message: 'file does not exist' });
      const mismatch = await connection
        .call(
          'replace_text',
          { path: 'remote.txt', oldText: 'absent', newText: 'replacement' },
          AbortSignal.timeout(5000),
        )
        .then(
          () => undefined,
          (error: Error & { category?: string }) => error,
        );
      expect(mismatch).toMatchObject({ category: 'conflict', message: 'oldText must match exactly once' });
      const largeSource = 'á😀'.repeat(40_000);
      await writeFile(join(project, 'too-large.txt'), largeSource, 'utf8');
      let offset = 0;
      let revision: string | undefined;
      let recovered = '';
      let pageCount = 0;
      for (;;) {
        const page = (await connection.call(
          'read_file',
          {
            path: 'too-large.txt',
            offset,
            limit: 49_152,
            ...(revision ? { revision } : {}),
          },
          AbortSignal.timeout(5000),
        )) as {
          content: string;
          nextOffset: number;
          truncated: boolean;
          revision: string;
          totalBytes: number;
        };
        expect(page.totalBytes).toBe(Buffer.byteLength(largeSource, 'utf8'));
        recovered += page.content;
        offset = page.nextOffset;
        revision = page.revision;
        pageCount++;
        if (!page.truncated) break;
      }
      expect(pageCount).toBeGreaterThan(2);
      expect(recovered).toBe(largeSource);
      expect(offset).toBe(Buffer.byteLength(largeSource, 'utf8'));
      const prefix = 'SSH-á😀\n'.repeat(12000);
      const oldText = 'REMOTE-TARGET-ø🧪';
      const suffix = '\nSSH-tail-ç🚀'.repeat(12000);
      const largeEditable = oldText + prefix + suffix;
      await writeFile(join(project, 'large-edit.txt'), largeEditable, 'utf8');
      const inspection = (await connection.call(
        'read_file',
        { path: 'large-edit.txt', offset: 0, limit: 49_152 },
        AbortSignal.timeout(5000),
      )) as { revision: string; truncated: boolean; content: string };
      expect(inspection.truncated).toBe(true);
      expect(inspection.content).toContain(oldText);
      expect(
        await connection.call(
          'replace_text',
          { path: 'large-edit.txt', oldText, newText: 'REMOTE-DONE-ø🚀', expectedRevision: inspection.revision },
          AbortSignal.timeout(5000),
        ),
      ).toMatchObject({ matches: 1 });
      expect(await readFile(join(project, 'large-edit.txt'), 'utf8')).toBe('REMOTE-DONE-ø🚀' + prefix + suffix);
      expect(
        await connection.call('exec', { command: ['printf', 'ok'], timeoutMs: 5000 }, AbortSignal.timeout(5000)),
      ).toMatchObject({ exitCode: 0, stdout: 'ok' });
    } finally {
      await connection.close();
    }
    const readOnlyConnection = await service.connect(host, project, { readOnly: true });
    try {
      const beforeReadonlyEdit = await readOnlyConnection.call(
        'read_file',
        { path: 'remote.txt' },
        AbortSignal.timeout(5000),
      );
      await expect(readOnlyConnection.call('list', { path: '.' }, AbortSignal.timeout(5000))).resolves.toMatchObject({
        entries: expect.any(Array),
      });
      await expect(
        readOnlyConnection.call('stat', { path: 'remote.txt' }, AbortSignal.timeout(5000)),
      ).resolves.toMatchObject({ type: 'file' });
      await expect(
        readOnlyConnection.call('search', { query: 'edited', path: '.' }, AbortSignal.timeout(5000)),
      ).resolves.toMatchObject({ results: expect.any(Array) });
      await expect(readOnlyConnection.call('diagnose', {}, AbortSignal.timeout(5000))).resolves.toMatchObject({
        git: expect.any(String),
      });
      await expect(
        readOnlyConnection.call('git', { operation: 'status', cwd: '.' }, AbortSignal.timeout(5000)),
      ).resolves.toMatchObject({ exitCode: expect.any(Number) });
      await expect(
        readOnlyConnection.call('write_file', { path: 'blocked.txt', content: 'unsafe' }, AbortSignal.timeout(5000)),
      ).rejects.toThrow(/read-only/);
      await expect(readOnlyConnection.call('exec', { command: ['true'] }, AbortSignal.timeout(5000))).rejects.toThrow(
        /read-only/,
      );
      const readonlyEdit = await readOnlyConnection
        .call(
          'replace_text',
          {
            path: 'remote.txt',
            oldText: 'edited',
            newText: 'unsafe',
            expectedRevision: (beforeReadonlyEdit as { revision: string }).revision,
          },
          AbortSignal.timeout(5000),
        )
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(readonlyEdit).toBeInstanceOf(Error);
      expect(readonlyEdit?.message).toMatch(/read-only/);
      expect(await readFile(join(project, 'remote.txt'), 'utf8')).toBe('edited');
      await expect(stat(join(project, '.adelic-locks'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await readOnlyConnection.close();
    }
    expect(await service.test(host)).toMatchObject({ protocol: 1, platform: 'Linux', root: '/' });
    await expect(readFile(join(root, 'ssh', 'local-command-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'ssh', 'shared-control'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);

  it('preserves valid error categories and safely handles old or invalid categories over real local SSH', async (context) => {
    if (!harness)
      context.skip(`SSH integration infrastructure unavailable: ${harnessUnavailableReason ?? 'fixture setup failed'}`);
    const { service, host } = harness!;
    // The disposable SSH daemon and runner path are inside this test's temporary directory.
    // This synthetic runner exercises protocol compatibility without contacting production.
    await writeFile(
      host.runnerPath,
      [
        'import json,sys',
        'for line in sys.stdin:',
        ' req=json.loads(line)',
        ' if req.get("method") == "heartbeat": continue',
        ' mode=req.get("args",{}).get("mode")',
        ' response={"id":str(req["id"]),"ok":False,"error":"SYNTHETIC_SECRET_do_not_forward"}',
        ' if mode == "valid": response["errorCategory"]="not_found"',
        ' elif mode == "invalid": response["errorCategory"]="SYNTHETIC_SECRET_CATEGORY"',
        ' print(json.dumps(response),flush=True)',
      ].join('\n') + '\n',
      { mode: 0o700 },
    );
    const connection = await service.connect(host, harness!.project);
    try {
      for (const [mode, category] of [
        ['valid', 'not_found'],
        ['invalid', undefined],
        ['absent', undefined],
      ] as const) {
        const error = await connection.call('stat', { mode }, AbortSignal.timeout(5000)).then(
          () => undefined,
          (value: unknown) => value as Error & { category?: string },
        );
        expect(error).toBeInstanceOf(Error);
        expect(error?.category).toBe(category);
        expect(error?.message).not.toContain('SYNTHETIC_SECRET');
        expect(remoteToolError(error)).not.toContain('SYNTHETIC_SECRET');
      }
    } finally {
      await connection.close();
    }
  }, 20000);

  it('rejects a host key whose fingerprint does not match', async (context) => {
    if (!harness)
      context.skip(`SSH integration infrastructure unavailable: ${harnessUnavailableReason ?? 'fixture setup failed'}`);
    const { service, host } = harness!;
    await expect(service.test({ ...host, fingerprint: 'SHA256:invalid' })).rejects.toThrow(/fingerprint/);
  });

  it('refuses SSH config SetEnv instead of forwarding configured values', async (context) => {
    if (!harness)
      context.skip(`SSH integration infrastructure unavailable: ${harnessUnavailableReason ?? 'fixture setup failed'}`);
    const { root, host } = harness!;
    const configFile = join(root, 'ssh', 'credential-config');
    await writeFile(
      configFile,
      `Host shared-lab\n  HostName 127.0.0.1\n  Port ${host.port}\n  User ${process.env.USER}\n  IdentityFile ${join(root, 'ssh', 'client_key')}\n  SetEnv CODEX_AUTH_TOKEN=must-not-be-sent\n`,
      { mode: 0o600 },
    );
    const service = RemoteHostService(join(root, 'data'), { configFile });
    await expect(service.test(host)).rejects.toThrow(/SetEnv is configured/);
  });
});
