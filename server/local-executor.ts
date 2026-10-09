import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  writeFile,
  realpath,
  rmdir,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RemoteRuntime, RemoteToolName } from '../shared/remote-hosts.js';
import { REMOTE_RUNNER_SOURCE } from './remote/runner-source.js';
import { terminateChildProcess } from './providers/process.js';

const MAX_FRAME = 1024 * 1024;
const MAX_TIMEOUT = 300_000;
const TOOL_NAMES = new Set<RemoteToolName>([
  'exec',
  'read_file',
  'write_file',
  'replace_text',
  'list',
  'stat',
  'search',
  'git',
  'diagnose',
]);
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

export interface LocalExecutorPreflight {
  ready: boolean;
  issues: Array<{ category: 'not_found' | 'permission' | 'invalid_request' | 'executor'; message: string }>;
}

/** Check required runtime capabilities before a tool call and return safe recovery guidance. */
export async function preflightLocalExecutor(projectPath: string): Promise<LocalExecutorPreflight> {
  const issues: LocalExecutorPreflight['issues'] = [];
  if (process.platform !== 'linux') {
    issues.push({ category: 'executor', message: 'isolated local execution requires Linux' });
    return { ready: false, issues };
  }
  for (const [binary, label] of [
    ['/usr/bin/bwrap', 'bubblewrap'],
    ['/usr/bin/python3', 'Python 3'],
  ] as const) {
    try {
      await access(binary, constants.X_OK);
    } catch {
      issues.push({ category: 'not_found', message: `${label} is not installed or executable` });
    }
  }
  try {
    const info = await stat(path.resolve(projectPath));
    if (!info.isDirectory()) issues.push({ category: 'invalid_request', message: 'project path is not a directory' });
  } catch (error) {
    const category = error instanceof Error && 'code' in error && error.code === 'EACCES' ? 'permission' : 'not_found';
    issues.push({
      category,
      message: category === 'permission' ? 'project path is not accessible' : 'project path was not found',
    });
  }
  return { ready: issues.length === 0, issues };
}

/**
 * Starts the credential-free remote-tool runner inside a dedicated bubblewrap namespace.
 * The requested project is mounted at /workspace. External linked-worktree Git metadata and
 * shared Node dependencies are individually exposed read-only; host configs and temp trees are excluded.
 */
export async function createLocalExecutor(
  projectPath: string,
  sandbox: 'read-only' | 'workspace-write',
): Promise<LocalExecutor> {
  const preflight = await preflightLocalExecutor(projectPath);
  if (!preflight.ready) {
    const issue = preflight.issues[0]!;
    const error = new Error(
      issue.category === 'not_found' && issue.message.includes('bubblewrap')
        ? 'O diagnóstico prévio não encontrou bubblewrap executável; instale bubblewrap e tente novamente. Nenhuma ferramenta foi executada.'
        : issue.category === 'not_found' && issue.message.includes('Python')
          ? 'O diagnóstico prévio não encontrou Python 3 executável; instale Python 3 e tente novamente. Nenhuma ferramenta foi executada.'
          : issue.message === 'project path is not a directory'
            ? 'O diagnóstico prévio encontrou um caminho de projeto que não é diretório; selecione uma pasta válida.'
            : issue.category === 'permission'
              ? 'O diagnóstico prévio encontrou acesso negado à pasta do projeto; confira as permissões.'
              : issue.category === 'executor'
                ? 'O diagnóstico prévio detectou que o executor isolado exige Linux; nenhuma ferramenta foi executada.'
                : 'O diagnóstico prévio não encontrou a pasta do projeto; confira o caminho.',
    ) as Error & { category?: string };
    error.category = issue.category;
    throw error;
  }
  if (process.platform !== 'linux') throw new Error('O modo automático local exige Linux e bubblewrap.');
  const requestedWorkspace = path.resolve(projectPath);
  // Check the requested spelling before realpath: isolated executors may map host /tmp
  // onto their workspace, which must not make the system temp root look like a project.
  if (
    requestedWorkspace === path.resolve(os.tmpdir()) ||
    ['/media', '/mnt', '/opt', '/srv', '/tmp', '/var'].includes(requestedWorkspace)
  )
    throw new Error('O modo automático não aceita pastas de sistema, temporárias ou de runtime como projeto.');
  const workspace = await realpath(requestedWorkspace);
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
  const workspaceStat = await stat(workspace);
  // Opaque identity for the physical root, independent of its /workspace spelling.
  const workspaceIdentity = createHash('sha256')
    .update(`${workspace}\0${workspaceStat.dev}:${workspaceStat.ino}`)
    .digest('hex');
  return new LocalExecutorFactory(workspace, sandbox, () =>
    spawnLocalExecutorProcess(workspace, sandbox, hostHome, nodeBinary, workspaceIdentity),
  );
}

async function sharedEditLockDirectory(): Promise<string> {
  const directory = path.join(os.tmpdir(), `adelic-locks-${process.getuid?.() ?? 'user'}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new Error('O diretório externo de bloqueios não é privado e seguro.');
  return directory;
}

async function isolatedGitConfigBinding(target: string): Promise<ExternalWorkspaceBinding> {
  const directory = await sharedEditLockDirectory();
  const source = path.join(directory, 'empty-git-config');
  try {
    await writeFile(source, '', { flag: 'wx', mode: 0o400 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const info = await lstat(source);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (info.mode & 0o222) !== 0
    )
      throw new Error('O arquivo local vazio do Git não é seguro.', { cause: error });
  }
  return { source, target, kind: 'empty-git-config' };
}

interface ExternalWorkspaceBinding {
  source: string;
  target: string;
  kind?: 'dependency' | 'empty-git-config';
}

const workspaceExecutionTails = new Map<string, Promise<void>>();
async function acquireWorkspaceExecutionLock(workspace: string): Promise<() => void> {
  const previous = workspaceExecutionTails.get(workspace) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceExecutionTails.set(workspace, tail);
  await previous;
  return () => {
    release();
    if (workspaceExecutionTails.get(workspace) === tail) workspaceExecutionTails.delete(workspace);
  };
}

/** Expose only the Git objects/index needed for inspection and shared dependencies, never Git config. */
export async function externalWorkspaceBindings(workspace: string): Promise<ExternalWorkspaceBinding[]> {
  const root = await realpath(workspace).catch(() => undefined);
  if (!root || root !== workspace) return [];
  const gitMarker = path.join(root, '.git');
  let gitDirectory: string;
  try {
    const marker = await lstat(gitMarker);
    if (marker.isDirectory() && !marker.isSymbolicLink()) {
      const bindings = [await isolatedGitConfigBinding(path.join(gitMarker, 'config'))];
      try {
        const packageFile = path.join(root, 'package.json');
        const packageInfo = await lstat(packageFile);
        const dependencyPath = path.join(root, 'node_modules');
        const dependencyInfo = await lstat(dependencyPath);
        const dependencyRoot = await realpath(dependencyPath);
        const localDependencies =
          dependencyInfo.isDirectory() && !dependencyInfo.isSymbolicLink() && within(root, dependencyRoot);
        const sharedDependencies =
          dependencyInfo.isSymbolicLink() &&
          path.resolve(root, await readlink(dependencyPath)) === '/opt/adelic-shared/node_modules' &&
          dependencyRoot === (await realpath('/opt/adelic-shared/node_modules'));
        if (packageInfo.isFile() && !packageInfo.isSymbolicLink() && (localDependencies || sharedDependencies)) {
          bindings.push({ source: dependencyRoot, target: dependencyPath, kind: 'dependency' });
        }
      } catch {
        /* Dependencies absent, linked elsewhere, or otherwise outside the authorized origin. */
      }
      return bindings;
    }
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 4096) return [];
    const contents = await readFile(gitMarker, 'utf8');
    const match = /^gitdir:\s*([^\r\n]+)\s*$/m.exec(contents);
    if (!match) return [];
    gitDirectory = await realpath(path.resolve(root, match[1]!));
    if (!(await stat(gitDirectory)).isDirectory()) return [];
  } catch {
    return [];
  }

  let commonDirectory: string;
  try {
    const commonMarker = path.join(gitDirectory, 'commondir');
    const commonPath = (await readFile(commonMarker, 'utf8')).trim();
    if (!commonPath || path.isAbsolute(commonPath)) return [];
    commonDirectory = await realpath(path.resolve(gitDirectory, commonPath));
    if (!(await stat(commonDirectory)).isDirectory()) return [];
  } catch {
    return [];
  }

  // A mount is authorized only for the exact linked-worktree admin layout and only
  // when Git's inverse gitdir pointer identifies this workspace's own .git marker.
  const adminDirectory = path.join(commonDirectory, 'worktrees', path.basename(gitDirectory));
  if (
    path.basename(commonDirectory) !== '.git' ||
    path.resolve(gitDirectory) !== path.resolve(adminDirectory) ||
    path.dirname(gitDirectory) !== path.join(commonDirectory, 'worktrees')
  )
    return [];
  try {
    const inverse = (await readFile(path.join(gitDirectory, 'gitdir'), 'utf8')).trim();
    if (!inverse) return [];
    const inverseMarker = await realpath(path.resolve(gitDirectory, inverse));
    if (inverseMarker !== gitMarker) return [];
  } catch {
    return [];
  }

  const checkoutRoot = path.dirname(commonDirectory);
  const bindings: ExternalWorkspaceBinding[] = [];
  const seen = new Set<string>();
  const add = async (source: string, kind?: ExternalWorkspaceBinding['kind']) => {
    try {
      const info = await stat(source);
      if (!info.isDirectory() && !info.isFile()) return;
      const resolved = await realpath(source);
      // Canonical sources and destinations must stay within the narrowly authorized
      // Git metadata origin. Never follow a link into another host tree.
      if (
        within(root, resolved) ||
        within(resolved, root) ||
        seen.has(resolved) ||
        !within(commonDirectory, source) ||
        !within(commonDirectory, resolved)
      )
        return;
      if (kind === 'dependency') return;
      seen.add(resolved);
      bindings.push({ source: resolved, target: source });
    } catch {
      /* Optional Git metadata is absent in some repository states. */
    }
  };
  for (const name of ['HEAD', 'index', 'commondir', 'gitdir']) await add(path.join(gitDirectory, name));
  for (const name of ['objects', 'refs']) await add(path.join(commonDirectory, name));
  for (const name of ['HEAD', 'packed-refs', 'shallow']) await add(path.join(commonDirectory, name));
  // Git needs a readable local config path. Mount a private empty regular file rather
  // than exposing the host's config or substituting a device node.
  bindings.push(await isolatedGitConfigBinding(path.join(commonDirectory, 'config')));

  // Dependencies may be mounted only from this checkout, or from the single
  // runtime-managed shared-dependency location used by the isolated executor.
  try {
    const packageFile = path.join(checkoutRoot, 'package.json');
    const packageInfo = await lstat(packageFile);
    const dependencyPath = path.join(checkoutRoot, 'node_modules');
    const dependencyInfo = await lstat(dependencyPath);
    const dependencyRoot = await realpath(dependencyPath);
    const localDependencies =
      dependencyInfo.isDirectory() && !dependencyInfo.isSymbolicLink() && within(checkoutRoot, dependencyRoot);
    const sharedDependencies =
      dependencyInfo.isSymbolicLink() &&
      path.resolve(checkoutRoot, await readlink(dependencyPath)) === '/opt/adelic-shared/node_modules' &&
      dependencyRoot === (await realpath('/opt/adelic-shared/node_modules'));
    if (
      packageInfo.isFile() &&
      !packageInfo.isSymbolicLink() &&
      (localDependencies || sharedDependencies) &&
      !(await lstat(path.join(root, 'node_modules')).then(
        () => true,
        () => false,
      ))
    ) {
      bindings.push({ source: dependencyRoot, target: path.join(root, 'node_modules'), kind: 'dependency' });
    }
  } catch {
    /* Dependencies absent, linked elsewhere, or otherwise outside the authorized origin. */
  }
  return bindings;
}

async function spawnLocalExecutorProcess(
  workspace: string,
  sandbox: 'read-only' | 'workspace-write',
  hostHome: string,
  nodeBinary: string | undefined,
  workspaceIdentity: string,
): Promise<LocalExecutorProcess> {
  const bwrap = '/usr/bin/bwrap';
  const handles: FileHandle[] = [];
  const releaseWorkspaceLock = await acquireWorkspaceExecutionLock(workspace);
  let lockTransferred = false;
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
    // Private scratch under /var/tmp; the host's /var/tmp is never mounted.
    ensureDir(args, '/var/tmp');
    if (sandbox === 'workspace-write') {
      const lockDirectory = await sharedEditLockDirectory();
      const lockTarget = `/tmp/${path.basename(lockDirectory)}`;
      ensureDir(args, lockTarget);
      args.push(...(await bind(lockDirectory, lockTarget, false)));
    }
    const hiddenPrefixes = ['/home', '/root', '/run', '/tmp', '/var', '/mnt', '/media', '/opt', '/srv'];
    if (!hiddenPrefixes.some((base) => within(base, hostHome))) {
      ensureDir(args, path.dirname(hostHome));
      ensureDir(args, hostHome);
      args.push('--tmpfs', hostHome);
    }
    ensureDir(args, '/workspace');
    args.push(...(await bind(workspace, '/workspace', sandbox !== 'workspace-write')));
    const bindings = await externalWorkspaceBindings(workspace);
    const hasDependencyMount = bindings.some((binding) => binding.kind === 'dependency');
    for (const binding of bindings) {
      if (binding.kind === 'dependency') {
        // A bind mount is namespace-local; unlike --symlink this never writes an
        // operational node_modules entry into the authorized checkout/worktree.
        args.push(...(await bind(binding.source, '/workspace/node_modules')));
      } else {
        const target = within(workspace, binding.target)
          ? path.join('/workspace', path.relative(workspace, binding.target))
          : binding.target;
        ensureDir(args, path.dirname(target));
        args.push(...(await bind(binding.source, target)));
      }
    }
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
    args.push(
      '--chdir',
      '/workspace',
      '--',
      '/usr/bin/python3',
      '-c',
      REMOTE_RUNNER_SOURCE,
      '--root',
      '/workspace',
      '--workspace-id',
      workspaceIdentity,
    );
    if (localRuntime) args.push('--runtime-path', '/opt/adelic-runtimes/node/bin');
    const child = spawn(bwrap, args, {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/nonexistent',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TMPDIR: '/var/tmp',
        XDG_CACHE_HOME: '/var/tmp/.cache',
        npm_config_cache: '/var/tmp/.npm',
      },
      stdio: ['pipe', 'pipe', 'pipe', ...handles.map((handle) => handle.fd)],
      windowsHide: true,
      detached: true,
    });
    const cleanupWorkspace = async () => {
      try {
        if (hasDependencyMount) {
          const mountpoint = path.join(workspace, 'node_modules');
          const info = await lstat(mountpoint);
          if (info.isDirectory() && !info.isSymbolicLink() && (await readdir(mountpoint)).length === 0)
            await rmdir(mountpoint);
        }
      } catch {
        // Leave user-created or non-empty node_modules data untouched.
      } finally {
        releaseWorkspaceLock();
      }
    };
    lockTransferred = true;
    return new LocalExecutorProcess(child as ChildProcessWithoutNullStreams, sandbox, workspace, cleanupWorkspace);
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    if (!lockTransferred) releaseWorkspaceLock();
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
  private readonly readProgress = new Map<string, { revision: string; next: number; complete: boolean }>();

  constructor(
    readonly workspace: string,
    private readonly sandbox: 'read-only' | 'workspace-write',
    private readonly spawnProcess: () => Promise<LocalExecutorProcess>,
  ) {}

  async call(tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Executor local isolado está fechado.');
    let forwarded = args;
    const fileKey =
      tool === 'read_file' || tool === 'replace_text'
        ? path.resolve('/workspace', String(args.path ?? '.'))
        : undefined;
    if (tool === 'read_file' && fileKey && Number(args.offset ?? 0) > 0) {
      const progress = this.readProgress.get(fileKey);
      if (progress && args.revision !== undefined && args.revision !== progress.revision) {
        this.readProgress.delete(fileKey);
        const error = new Error('file changed while reading') as Error & { category?: string };
        error.category = 'conflict';
        throw error;
      }
      if (progress) forwarded = { ...args, revision: progress.revision };
    }
    if (tool === 'replace_text' && fileKey) {
      const progress = this.readProgress.get(fileKey);
      const suppliedRevision =
        typeof args.expectedRevision === 'string'
          ? args.expectedRevision
          : typeof args.readRevision === 'string'
            ? args.readRevision
            : undefined;
      if (!suppliedRevision && !progress?.complete) {
        const error = new Error('file must be read completely before replace_text') as Error & { category?: string };
        error.category = 'conflict';
        throw error;
      }
      const { readRevision: _legacyRevision, ...replaceArgs } = args;
      forwarded = { ...replaceArgs, expectedRevision: suppliedRevision ?? progress!.revision };
    }
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
      const result = await instance.call(tool, forwarded, signal);
      if (tool === 'read_file' && fileKey && result && typeof result === 'object' && !Array.isArray(result)) {
        const page = result as { revision?: unknown; offset?: unknown; nextOffset?: unknown; truncated?: unknown };
        const previous = this.readProgress.get(fileKey);
        if (
          typeof page.revision === 'string' &&
          Number.isSafeInteger(page.offset) &&
          Number.isSafeInteger(page.nextOffset) &&
          typeof page.truncated === 'boolean'
        ) {
          if (page.offset === 0) {
            this.readProgress.set(fileKey, {
              revision: page.revision,
              next: page.nextOffset as number,
              complete: !page.truncated,
            });
          } else if (previous && previous.revision === page.revision) {
            // Random-access reads are valid; only advance the sequential cursor when
            // this page is actually the next contiguous page.
            if (previous.next === page.offset && !previous.complete) {
              previous.next = page.nextOffset as number;
              previous.complete = !page.truncated;
            }
          } else {
            this.readProgress.set(fileKey, {
              revision: page.revision,
              next: page.nextOffset as number,
              complete: false,
            });
          }
        }
      }
      return result;
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
    private readonly cleanupWorkspace?: () => Promise<void>,
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
    if (this.sandbox === 'read-only' && (tool === 'exec' || tool === 'write_file' || tool === 'replace_text'))
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
          args: this.sandbox === 'read-only' && tool === 'git' ? { ...args, readOnly: true } : args,
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
      else if (response.ok === false && typeof response.error === 'string') {
        const allowedCategories = ['timeout', 'not_found', 'permission', 'invalid_request', 'conflict', 'executor'];
        const category = allowedCategories.includes(String(response.errorCategory))
          ? String(response.errorCategory)
          : undefined;
        const safeMessages = [
          'file does not exist',
          'file exceeds read limit',
          'file must be read completely before replace_text',
          'file changed before edit',
          'file changed while reading',
          'offset exceeds file size',
          'offset is not a UTF-8 boundary',
          'read limit must be between 1 and 49152 bytes',
          'read limit is too small for a UTF-8 character',
          'unable to read UTF-8 boundary',
          'file exceeds edit limit',
          'file is not valid UTF-8',
          'oldText must match exactly once',
          'parent directory does not exist',
          'path escapes project root',
          'path must be a string',
          'args must be an object',
          'tool arguments do not match the supported schema',
          'cwd is not a directory',
          'write_file is disabled for a read-only call',
          'replace_text is disabled for a read-only call',
          'content must be a string',
          'content exceeds write limit',
          'oldText must be a non-empty string',
          'newText must be a string',
          'replacement text exceeds limit',
          'edited file exceeds limit',
          'path is not a directory',
          'command cancelled',
        ];
        const message = safeMessages.includes(response.error)
          ? response.error
          : category === 'timeout'
            ? 'command timed out'
            : category === 'not_found'
              ? 'requested path was not found'
              : category === 'permission'
                ? 'permission denied'
                : category === 'invalid_request'
                  ? 'invalid tool request or file'
                  : category === 'conflict'
                    ? 'file changed or replacement is ambiguous'
                    : 'remote tool failed';
        const error = new Error(message) as Error & { category?: string };
        if (category) error.category = category;
        item.reject(error);
      } else {
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
    await this.cleanupWorkspace?.();
  }
}
