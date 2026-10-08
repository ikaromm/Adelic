import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RemoteRuntime, RemoteToolName } from '../shared/remote-hosts.js';
import { REMOTE_RUNNER_SOURCE } from './remote/runner-source.js';
import { terminateChildProcess } from './providers/process.js';

const MAX_FRAME = 1024 * 1024;
const MAX_TIMEOUT = 300_000;
const TOOL_NAMES = new Set<RemoteToolName>(['exec', 'read_file', 'write_file', 'list', 'stat', 'search', 'git']);
const within = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export async function findHostNode(
  hostHome: string,
  processPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates = new Set<string>([processPath]);
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.add(path.join(directory, 'node'));
    candidates.add(path.join(directory, 'nodejs'));
  }
  const installRoots = [
    path.join(env.MISE_DATA_DIR?.trim() || path.join(hostHome, '.local/share/mise'), 'installs/node'),
    path.join(env.XDG_DATA_HOME?.trim() || path.join(hostHome, '.local/share'), 'mise/installs/node'),
    path.join(env.ASDF_DATA_DIR?.trim() || path.join(hostHome, '.asdf'), 'installs/node'),
    path.join(env.NVM_DIR?.trim() || path.join(hostHome, '.nvm'), 'versions/node'),
  ];
  for (const root of installRoots) {
    let versions: string[];
    try {
      versions = await readdir(root);
    } catch {
      continue;
    }
    for (const version of versions) candidates.add(path.join(root, version, 'bin/node'));
  }
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if (!['node', 'nodejs'].includes(path.basename(resolved))) continue;
      await access(resolved, constants.X_OK);
      if ((await stat(resolved)).isFile()) return resolved;
    } catch {
      /* No usable local Node runtime at this path. */
    }
  }
  return undefined;
}

export interface LocalExecutor extends RemoteRuntime {
  close(): Promise<void>;
}

/**
 * Starts the credential-free remote-tool runner inside a dedicated bubblewrap namespace.
 * Only the project is mounted into the tool's visible filesystem, at /workspace.
 */
export async function createLocalExecutor(
  projectPath: string,
  sandbox: 'read-only' | 'workspace-write',
): Promise<LocalExecutor> {
  if (process.platform !== 'linux') throw new Error('O modo automático local exige Linux e bubblewrap.');
  const bwrap = '/usr/bin/bwrap';
  await access(bwrap).catch(() => {
    throw new Error('O modo automático local exige bubblewrap; nenhuma ferramenta foi executada.');
  });
  const workspace = await realpath(path.resolve(projectPath));
  const homePath = path.resolve(os.homedir());
  const hostHome = await realpath(homePath).catch(() => homePath);
  if (!(await stat(workspace)).isDirectory()) throw new Error('A pasta do projeto não é um diretório.');
  if (workspace === '/' || within(workspace, hostHome) || workspace === '/home' || workspace === '/root')
    throw new Error('O modo automático não aceita a raiz do sistema nem uma pasta que contenha o diretório pessoal.');
  const protectedRoots = ['/bin', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr'];
  const storageRoots = ['/media', '/mnt', '/opt', '/srv', '/tmp', '/var'];
  if (protectedRoots.some((root) => within(root, workspace)) || storageRoots.includes(workspace))
    throw new Error('O modo automático não aceita pastas de sistema, temporárias ou de runtime como projeto.');
  const nodeBinary = await findHostNode(hostHome);
  return new LocalExecutorFactory(workspace, sandbox, () =>
    spawnLocalExecutorProcess(workspace, sandbox, hostHome, nodeBinary),
  );
}

async function spawnLocalExecutorProcess(
  workspace: string,
  sandbox: 'read-only' | 'workspace-write',
  hostHome: string,
  nodeBinary: string | undefined,
): Promise<LocalExecutorProcess> {
  const bwrap = '/usr/bin/bwrap';
  const handles: FileHandle[] = [];
  try {
    const bind = async (source: string, target: string, readonly = true) => {
      const handle = await open(source, 'r');
      const childFd = handles.length + 3;
      handles.push(handle);
      return [readonly ? '--ro-bind-fd' : '--bind-fd', String(childFd), target];
    };
    const ensureDir = (args: string[], target: string) => {
      const parts = target.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += `/${part}`;
        args.push('--dir', current);
      }
    };
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-net',
      '--tmpfs',
      '/',
      '--dir',
      '/proc',
      '--proc',
      '/proc',
      '--dir',
      '/dev',
      '--dev',
      '/dev',
      '--dir',
      '/usr',
      ...(await bind('/usr', '/usr')),
      '--symlink',
      '/usr/bin',
      '/bin',
      '--symlink',
      '/usr/bin',
      '/sbin',
      '--symlink',
      '/usr/lib',
      '/lib',
      '--symlink',
      '/usr/lib64',
      '/lib64',
      '--dir',
      '/etc',
    ];
    for (const target of ['/home', '/root', '/run', '/tmp', '/var', '/mnt', '/media', '/opt', '/srv']) {
      ensureDir(args, target);
      args.push('--tmpfs', target);
    }
    const hiddenPrefixes = ['/home', '/root', '/run', '/tmp', '/var', '/mnt', '/media', '/opt', '/srv'];
    if (!hiddenPrefixes.some((base) => within(base, hostHome))) {
      ensureDir(args, path.dirname(hostHome));
      ensureDir(args, hostHome);
      args.push('--tmpfs', hostHome);
    }
    ensureDir(args, '/workspace');
    args.push(...(await bind(workspace, '/workspace', sandbox !== 'workspace-write')));
    let localRuntime = false;
    if (nodeBinary && !within('/usr', nodeBinary)) {
      const nodeRoot = path.dirname(path.dirname(nodeBinary));
      const npmRoot = path.join(nodeRoot, 'lib/node_modules/npm');
      ensureDir(args, '/opt/adelic-runtimes/node/bin');
      args.push(...(await bind(nodeBinary, '/opt/adelic-runtimes/node/bin/node')));
      try {
        const canonicalNpmRoot = await realpath(npmRoot);
        if (within(nodeRoot, canonicalNpmRoot) && (await stat(canonicalNpmRoot)).isDirectory()) {
          ensureDir(args, '/opt/adelic-runtimes/node/lib/node_modules/npm');
          args.push(...(await bind(canonicalNpmRoot, '/opt/adelic-runtimes/node/lib/node_modules/npm')));
          args.push(
            '--symlink',
            '../lib/node_modules/npm/bin/npm-cli.js',
            '/opt/adelic-runtimes/node/bin/npm',
            '--symlink',
            '../lib/node_modules/npm/bin/npx-cli.js',
            '/opt/adelic-runtimes/node/bin/npx',
          );
        }
        localRuntime = true;
      } catch {
        // Keep the exact Node executable if npm is not installed alongside it.
        localRuntime = true;
      }
    }
    args.push('--chdir', '/workspace', '--', '/usr/bin/python3', '-c', REMOTE_RUNNER_SOURCE, '--root', '/workspace');
    if (localRuntime) args.push('--runtime-path', '/opt/adelic-runtimes/node/bin');
    const child = spawn(bwrap, args, {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe', ...handles.map((handle) => handle.fd)],
      windowsHide: true,
      detached: true,
    });
    return new LocalExecutorProcess(child as ChildProcessWithoutNullStreams, sandbox, workspace);
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }
}

class LocalExecutorFactory implements LocalExecutor {
  readonly label = 'Local isolado';
  readonly root = '/workspace';
  readonly executionKind = 'isolated-local' as const;
  private closed = false;
  private closing?: Promise<void>;
  private readonly active = new Set<LocalExecutorProcess>();
  private readonly spawning = new Set<Promise<LocalExecutorProcess>>();

  constructor(
    readonly workspace: string,
    private readonly sandbox: 'read-only' | 'workspace-write',
    private readonly spawnProcess: () => Promise<LocalExecutorProcess>,
  ) {}

  async call(tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Executor local isolado está fechado.');
    const opening = this.spawnProcess();
    this.spawning.add(opening);
    let instance: LocalExecutorProcess;
    try {
      instance = await opening;
    } finally {
      this.spawning.delete(opening);
    }
    if (this.closed) {
      await instance.close();
      throw new Error('Executor local isolado está fechado.');
    }
    this.active.add(instance);
    try {
      return await instance.call(tool, args, signal);
    } finally {
      await instance.close();
      this.active.delete(instance);
    }
  }

  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      await Promise.all([
        ...[...this.active].map((instance) => instance.close()),
        ...[...this.spawning].map((opening) =>
          opening.then(
            (instance) => instance.close(),
            () => undefined,
          ),
        ),
      ]);
    })());
  }
}

class LocalExecutorProcess implements LocalExecutor {
  readonly label = 'Local isolado';
  readonly root = '/workspace';
  readonly executionKind = 'isolated-local' as const;
  private buffer = '';
  private closed = false;
  private failed?: Error;
  private nextId = 1;
  private cancelled = new Set<string>();
  private closing?: Promise<void>;
  private pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; signal: AbortSignal; abort: () => void }
  >();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly sandbox: 'read-only' | 'workspace-write',
    readonly workspace: string,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.resume(); // Tool and setup stderr may contain project paths or sensitive data.
    child.stdin.on('error', () => this.fail(new Error('Executor local isolado encerrou o canal de entrada.')));
    child.once('error', (error) => this.fail(new Error(`Executor local isolado não iniciou: ${error.message}`)));
    child.once('close', (code, signal) =>
      this.fail(new Error(`Executor local isolado encerrou (${signal ?? code ?? 'desconhecido'}).`)),
    );
    this.timer = setInterval(() => {
      if (!this.closed && !this.failed) {
        try {
          this.write({ method: 'heartbeat' });
        } catch {
          this.fail(new Error('Executor local isolado perdeu a conexão.'));
        }
      }
    }, 5000);
    this.timer.unref();
  }

  call(tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!TOOL_NAMES.has(tool)) return Promise.reject(new Error('Ferramenta automática não suportada.'));
    if (signal.aborted)
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Execução cancelada.'));
    if (this.closed || this.failed)
      return Promise.reject(this.failed ?? new Error('Executor local isolado está fechado.'));
    if (this.sandbox === 'read-only' && (tool === 'exec' || tool === 'write_file'))
      return Promise.reject(new Error('A ferramenta de escrita está desativada no modo somente leitura.'));
    if (
      tool === 'exec' &&
      args.timeoutMs !== undefined &&
      (typeof args.timeoutMs !== 'number' ||
        !Number.isFinite(args.timeoutMs) ||
        args.timeoutMs < 1 ||
        args.timeoutMs > MAX_TIMEOUT)
    )
      return Promise.reject(new Error('O limite de tempo da ferramenta excede a política local.'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.cancelled.add(id);
        if (this.cancelled.size > 1024) {
          void this.close();
          return;
        }
        reject(signal.reason instanceof Error ? signal.reason : new Error('Execução cancelada.'));
        try {
          this.write({ method: 'cancel', id });
        } catch {
          void this.close();
        }
      };
      this.pending.set(id, { resolve, reject, signal, abort });
      signal.addEventListener('abort', abort, { once: true });
      try {
        const frame = JSON.stringify({
          id,
          method: 'call',
          tool,
          args: this.sandbox === 'read-only' ? { ...args, readOnly: true } : args,
        });
        if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME)
          throw new Error('A chamada de ferramenta excede o limite permitido.');
        this.write(frame);
      } catch (error) {
        this.pending.delete(id);
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(value: string | Record<string, unknown>) {
    if (!this.child.stdin.writable) throw new Error('Executor local isolado não aceita chamadas.');
    this.child.stdin.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME * 2) {
      void this.close();
      this.fail(new Error('O executor local excedeu o limite do protocolo.'));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) {
        this.fail(new Error('O executor local enviou uma resposta grande demais.'));
        void this.close();
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(line);
      } catch {
        this.fail(new Error('O executor local enviou uma resposta inválida.'));
        void this.close();
        return;
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        this.fail(new Error('O executor local enviou uma resposta inválida.'));
        void this.close();
        return;
      }
      const response = envelope as Record<string, unknown>;
      const id = String(response.id);
      if (this.cancelled.delete(id)) continue;
      const item = this.pending.get(id);
      if (!item) {
        this.fail(new Error('O executor local enviou uma resposta sem chamada correspondente.'));
        void this.close();
        return;
      }
      this.pending.delete(id);
      item.signal.removeEventListener('abort', item.abort);
      if (response.ok === true && Object.hasOwn(response, 'result')) item.resolve(response.result);
      else if (response.ok === false && typeof response.error === 'string')
        item.reject(new Error(response.error.slice(0, 2000)));
      else {
        item.reject(new Error('O executor local enviou uma resposta inválida.'));
        this.fail(new Error('O executor local enviou uma resposta inválida.'));
        void this.close();
        return;
      }
    }
  }

  private fail(error: Error) {
    if (!this.failed) this.failed = error;
    for (const [id, item] of this.pending) {
      this.pending.delete(id);
      item.signal.removeEventListener('abort', item.abort);
      item.reject(this.failed);
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.closeProcess();
    return this.closing;
  }

  private async closeProcess() {
    clearInterval(this.timer);
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once('close', () => resolve());
    });
    this.child.stdin.end();
    let timeout: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), 2500);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!closed) await terminateChildProcess(this.child);
    this.fail(new Error('Executor local isolado encerrado.'));
  }
}
