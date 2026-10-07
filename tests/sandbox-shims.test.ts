import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bubblewrap, sshAgentBinding, systemConfigShims } from '../server/providers/sandbox.js';
import { sandboxedTerminal } from '../server/terminal.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function tempDir(prefix = 'adelic-shims-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const mode = async (file: string) => (await stat(file)).mode & 0o777;

/** A synthetic `/etc` with an OpenSSH client config, its include folder and server files. */
async function fakeEtc() {
  const root = await tempDir();
  const etc = path.join(root, 'etc');
  const elsewhere = path.join(root, 'usr-lib');
  await mkdir(path.join(etc, 'ssh', 'ssh_config.d'), { recursive: true });
  await mkdir(elsewhere);
  await writeFile(path.join(etc, 'ssh', 'ssh_config'), 'Include /etc/ssh/ssh_config.d/*.conf\n');
  await writeFile(path.join(etc, 'ssh', 'ssh_host_ed25519_key'), 'SECRET HOST KEY');
  await writeFile(path.join(etc, 'ssh', 'sshd_config'), 'PermitRootLogin no\n');
  await writeFile(path.join(etc, 'ssh', 'ssh_config.d', '10-plain.conf'), 'Host *\n  ServerAliveInterval 15\n');
  await writeFile(path.join(elsewhere, 'proxy.conf'), 'Host .host\n  CheckHostIP no\n');
  await symlink(path.join(elsewhere, 'proxy.conf'), path.join(etc, 'ssh', 'ssh_config.d', '20-proxy.conf'));
  await symlink(path.join(elsewhere, 'missing.conf'), path.join(etc, 'ssh', 'ssh_config.d', '30-dangling.conf'));
  await mkdir(path.join(etc, 'ssh', 'ssh_config.d', '40-a-folder.conf'));
  return { root, etc };
}

describe('system config shims (builder)', () => {
  it('copies only the OpenSSH client files, follows symlinks and binds them over /etc', async () => {
    const { root, etc } = await fakeEtc();
    const dir = path.join(root, 'run', 'system-shims');
    await mkdir(path.dirname(dir));
    const bindings = await systemConfigShims({ etcRoot: etc, dir });

    expect(bindings).toEqual([
      { source: dir, target: dir, directory: true },
      { source: path.join(dir, 'ssh', 'ssh_config'), target: '/etc/ssh/ssh_config' },
      { source: path.join(dir, 'ssh', 'ssh_config.d'), target: '/etc/ssh/ssh_config.d', directory: true },
    ]);
    expect((await readdir(path.join(dir, 'ssh'))).sort()).toEqual(['ssh_config', 'ssh_config.d']);
    expect((await readdir(path.join(dir, 'ssh', 'ssh_config.d'))).sort()).toEqual(['10-plain.conf', '20-proxy.conf']);
    expect(await readFile(path.join(dir, 'ssh', 'ssh_config.d', '20-proxy.conf'), 'utf8')).toContain('CheckHostIP');
    // The copy is a real file owned by the user, never a symlink back to the original.
    const copy = await stat(path.join(dir, 'ssh', 'ssh_config.d', '20-proxy.conf'));
    expect(copy.isFile()).toBe(true);
    expect(copy.uid).toBe(process.getuid!());
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(path.join(dir, 'ssh'))).toBe(0o755);
    expect(await mode(path.join(dir, 'ssh', 'ssh_config.d'))).toBe(0o755);
    expect(await mode(path.join(dir, 'ssh', 'ssh_config'))).toBe(0o644);

    // Rebuilding the same run folder starts from scratch.
    await writeFile(path.join(dir, 'ssh', 'stale'), 'x');
    await systemConfigShims({ etcRoot: etc, dir });
    expect(existsSync(path.join(dir, 'ssh', 'stale'))).toBe(false);
  });

  it('copies ssh_known_hosts only when it exists, and skips a missing include folder', async () => {
    const root = await tempDir();
    const etc = path.join(root, 'etc');
    await mkdir(path.join(etc, 'ssh'), { recursive: true });
    await writeFile(path.join(etc, 'ssh', 'ssh_known_hosts'), 'host ssh-ed25519 AAAA\n');
    const dir = path.join(root, 'shims');
    const bindings = await systemConfigShims({ etcRoot: etc, dir });
    expect(bindings.map((binding) => binding.target)).toEqual([dir, '/etc/ssh/ssh_known_hosts']);
  });

  it('bounds the number and size of copied files', async () => {
    const { root, etc } = await fakeEtc();
    await writeFile(path.join(etc, 'ssh', 'ssh_config.d', '05-big.conf'), 'x'.repeat(2048));
    const dir = path.join(root, 'shims');
    await systemConfigShims({ etcRoot: etc, dir, maxFiles: 1, maxFileBytes: 1024 });
    // 05-big is too big and skipped, then only one file fits the count limit.
    expect(await readdir(path.join(dir, 'ssh', 'ssh_config.d'))).toEqual(['10-plain.conf']);
  });

  it('refuses a shared cache folder that is not private', async () => {
    const { etc } = await fakeEtc();
    const tmp = await tempDir('adelic-shim-tmp-');
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    cleanup.push(() => {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    });
    const cache = path.join(tmp, `adelic-system-shims-${process.getuid!()}`);
    await mkdir(cache, { mode: 0o755 });
    await chmod(cache, 0o755);
    await expect(systemConfigShims({ etcRoot: etc })).rejects.toThrow(/não é privada/);
    await rm(cache, { recursive: true });
    await symlink(tmp, cache);
    await expect(systemConfigShims({ etcRoot: etc })).rejects.toThrow(/não é privada/);
  });

  it('returns nothing without an /etc/ssh folder', async () => {
    const root = await tempDir();
    expect(await systemConfigShims({ etcRoot: path.join(root, 'none'), dir: path.join(root, 'shims') })).toEqual([]);
    expect(existsSync(path.join(root, 'shims'))).toBe(false);
  });

  it('shares one private, content-addressed copy per user when no run folder is given', async () => {
    const { etc } = await fakeEtc();
    const first = await systemConfigShims({ etcRoot: etc });
    const second = await systemConfigShims({ etcRoot: etc });
    expect(second).toEqual(first);
    const cache = path.dirname(path.dirname(path.dirname(first[0]!.source)));
    expect(cache).toBe(path.join(os.tmpdir(), `adelic-system-shims-${process.getuid!()}`));
    expect(await mode(cache)).toBe(0o700);
    // No staging leftovers.
    expect((await readdir(cache)).filter((name) => name.startsWith('.staging-'))).toEqual([]);
    expect(first.map((binding) => binding.target)).toEqual(['/etc/ssh/ssh_config', '/etc/ssh/ssh_config.d']);
  });
});

async function listen(socket: string) {
  const server: Server = createServer((connection) => connection.end('agent\n'));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
}

describe('ssh-agent socket', () => {
  it('binds a socket under /tmp and ignores anything else', async () => {
    const dir = await tempDir('adelic-agent-');
    const socket = path.join(dir, 'agent.sock');
    await listen(socket);
    expect(await sshAgentBinding({ SSH_AUTH_SOCK: socket })).toEqual([
      { source: socket, target: socket, socket: true },
    ]);
    expect(await sshAgentBinding({})).toEqual([]);
    expect(await sshAgentBinding({ SSH_AUTH_SOCK: 'relative.sock' })).toEqual([]);
    expect(await sshAgentBinding({ SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.socket' })).toEqual([]);
    expect(await sshAgentBinding({ SSH_AUTH_SOCK: path.join(dir, 'missing.sock') })).toEqual([]);
    await writeFile(path.join(dir, 'file.sock'), '');
    expect(await sshAgentBinding({ SSH_AUTH_SOCK: path.join(dir, 'file.sock') })).toEqual([]);
  });
});

function execute(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, env });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

const bwrapWorks =
  existsSync('/usr/bin/bwrap') &&
  spawnSync(
    '/usr/bin/bwrap',
    ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--', '/bin/true'],
    { timeout: 10_000, stdio: 'ignore' },
  ).status === 0;

describe.skipIf(!bwrapWorks)('system config shims in the real bubblewrap sandbox', () => {
  it.skipIf(!existsSync('/usr/bin/ssh') || !existsSync('/etc/ssh'))(
    'lets ssh parse the system config (and shows the failure it fixes when this machine has it)',
    async () => {
      const args = ['-G', '-o', 'BatchMode=yes', 'example.invalid'];
      const shimmed = await bubblewrap('/usr/bin/ssh', args, process.cwd(), 'read-only');
      const ok = await execute(shimmed.command, shimmed.args);
      expect(ok.code, ok.output).toBe(0);
      expect(ok.output).not.toMatch(/Bad owner/);
      expect(ok.output).toMatch(/^hostname example\.invalid$/m);

      const plain = await bubblewrap('/usr/bin/ssh', args, process.cwd(), 'read-only', [], [], {
        systemShims: false,
      });
      const failed = await execute(plain.command, plain.args);
      // Only machines with root-owned system configs that ssh checks reproduce the bug.
      if (/Bad owner/.test(failed.output)) expect(failed.code).not.toBe(0);
    },
  );

  it('keeps run-folder copies read-only even inside a writable runtime folder', async () => {
    const { root, etc } = await fakeEtc();
    const run = path.join(root, 'run');
    await mkdir(run);
    const shims = await systemConfigShims({ etcRoot: etc, dir: path.join(run, 'system-shims') });
    // Bound only over the run folder here (not /etc), to observe the read-only grant.
    const wrapped = await bubblewrap(
      '/bin/sh',
      [
        '-c',
        `touch ${JSON.stringify(path.join(run, 'ok'))} && ! touch ${JSON.stringify(shims[1]!.source)} 2>/dev/null`,
      ],
      process.cwd(),
      'read-only',
      [run],
      [shims[0]!],
      { systemShims: false },
    );
    const result = await execute(wrapped.command, wrapped.args);
    expect(result.code, result.output).toBe(0);
  });

  it('makes an ssh-agent socket under /tmp reachable at the same path', async () => {
    const dir = await tempDir('adelic-agent-');
    const socket = path.join(dir, 'agent.sock');
    await listen(socket);
    const previous = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = socket;
    cleanup.push(() => {
      if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previous;
    });
    const probe = ['-c', 'test -S "$SSH_AUTH_SOCK" && echo REACHABLE'];
    const wrapped = await bubblewrap('/bin/sh', probe, process.cwd(), 'read-only');
    expect(wrapped.args.join(' ')).toContain(`--ro-bind ${socket} ${socket}`);
    const result = await execute(wrapped.command, wrapped.args);
    expect(result.output).toContain('REACHABLE');

    // Offline sandboxes (project checks) and an explicit opt-out bind no agent.
    for (const options of [{ network: false }, { sshAgent: false }]) {
      const offline = await bubblewrap('/bin/sh', probe, process.cwd(), 'read-only', [], [], options);
      expect(offline.args).not.toContain(socket);
    }
  });

  it.skipIf(!existsSync('/etc/ssh/ssh_config'))('gives the integrated terminal the shim bindings', async () => {
    const wrapped = await sandboxedTerminal('/bin/true', [], process.cwd(), 'read-only');
    const index = wrapped.args.findIndex(
      (arg, i) => arg === '/etc/ssh/ssh_config' && wrapped.args[i - 2] === '--ro-bind',
    );
    expect(index, wrapped.args.join(' ')).toBeGreaterThan(0);
    expect(wrapped.args[index - 1]).toMatch(/adelic-system-shims-\d+\/[0-9a-f]{24}\/ssh\/ssh_config$/);
  });
});
