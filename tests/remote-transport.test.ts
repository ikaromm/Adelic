import { mkdtemp, readFile, rm, stat, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteHostService } from '../server/remote/transport.js';
import { REMOTE_RUNNER_SOURCE } from '../server/remote/runner-source.js';
import type { RemoteHost } from '../shared/remote-hosts.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
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
  if (!bin?.stdout.trim()) return;
  const user = process.env.USER;
  if (!user) return;
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
  it('probes, pins, installs and runs the credential-free runner over a configured SSH alias', async (context) => {
    if (!harness) context.skip();
    const { root, service, host, project } = harness!;
    const probe = await service.probe(host.target, host.port);
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
      expect(await connection.call('read_file', { path: 'remote.txt' }, AbortSignal.timeout(5000))).toMatchObject({
        content: 'from ssh',
      });
      expect(
        await connection.call('exec', { command: ['printf', 'ok'], timeoutMs: 5000 }, AbortSignal.timeout(5000)),
      ).toMatchObject({ exitCode: 0, stdout: 'ok' });
    } finally {
      await connection.close();
    }
    expect(await service.test(host)).toMatchObject({ protocol: 1, platform: 'Linux', root: '/' });
    await expect(readFile(join(root, 'ssh', 'local-command-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, 'ssh', 'shared-control'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30000);

  it('rejects a host key whose fingerprint does not match', async () => {
    if (!harness) return;
    const { service, host } = harness;
    await expect(service.test({ ...host, fingerprint: 'SHA256:invalid' })).rejects.toThrow(/fingerprint/);
  });

  it('refuses SSH config SetEnv instead of forwarding configured values', async () => {
    if (!harness) return;
    const { root, host } = harness;
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
