import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Sandbox } from '../../shared/contracts';

export interface WrappedCommand {
  command: string;
  args: string[];
}
export interface ReadonlyFileBinding {
  source: string;
  target: string;
  directory?: boolean;
  /** A unix socket (the ssh-agent's), bound at the same path. */
  socket?: boolean;
}

export interface SystemShimOptions {
  /** Stand-in for `/etc` as the copy source (tests). Targets are always the real `/etc` paths. */
  etcRoot?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface BubblewrapOptions {
  /** `false` adds a private network namespace (project checks); agents keep the default. */
  network?: boolean;
  /**
   * User-owned read-only copies of root-owned client configs (OpenSSH), bound over the
   * originals; default on. `dir` keeps the copies in a run-owned folder removed with it,
   * otherwise a private per-process cache under the system temp folder is used.
   */
  systemShims?: false | { dir?: string };
  /** Binds `SSH_AUTH_SOCK` when it lives under the hidden /tmp; default on. */
  sshAgent?: boolean;
}

const TMP_ROOT = '/tmp';
const SHIM_MAX_FILES = 64;
const SHIM_MAX_FILE_BYTES = 64 * 1024;

function isWithin(directory: string, root: string) {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function addTmpDirectories(args: string[], target: string, alreadyAdded: Set<string>) {
  if (!isWithin(target, TMP_ROOT) || target === TMP_ROOT) return;
  const relative = path.relative(TMP_ROOT, target);
  let current = TMP_ROOT;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (alreadyAdded.has(current)) continue;
    args.push('--dir', current);
    alreadyAdded.add(current);
  }
}

interface ShimFile {
  /** Path inside the shim folder, e.g. `ssh/ssh_config.d/20-x.conf`. */
  relative: string;
  content: Buffer;
}
interface ShimPlan {
  files: ShimFile[];
  /** Folders (inside the shim folder) to create even when empty. */
  dirs: string[];
  /** What to bind: shim-relative source over the real system path. */
  binds: { relative: string; target: string; directory?: boolean }[];
}

/** Reads one regular file (symlinks followed), or undefined when absent, not regular or too big. */
async function readBounded(file: string, maxBytes: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const content = await handle.readFile();
    return content.length > maxBytes ? undefined : content;
  } finally {
    await handle.close();
  }
}

async function isDirectory(directory: string) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plans the OpenSSH client shims. Inside the sandbox's user namespace only the user's uid is
 * mapped, so root-owned files show up owned by `nobody`, and ssh refuses a system config that
 * is not owned by root or the user ("Bad owner or permissions"). Only the client's public,
 * world-readable files are copied: `ssh_config`, each regular file of `ssh_config.d` and
 * `ssh_known_hosts`. Host keys and the rest of /etc/ssh are never read.
 */
async function planSystemShims(options: SystemShimOptions): Promise<ShimPlan> {
  const etc = options.etcRoot ?? '/etc';
  const maxFiles = options.maxFiles ?? SHIM_MAX_FILES;
  const maxBytes = options.maxFileBytes ?? SHIM_MAX_FILE_BYTES;
  const plan: ShimPlan = { files: [], dirs: [], binds: [] };
  if (!(await isDirectory(path.join(etc, 'ssh')))) return plan;
  // Bind destinations are the real system paths (resolved, so a symlinked /etc file is
  // covered where it actually lives); a test `etcRoot` only changes where copies come from.
  const target = async (relative: string) => {
    const logical = path.join('/etc', relative);
    if (options.etcRoot) return logical;
    try {
      return await realpath(logical);
    } catch {
      return logical;
    }
  };
  for (const name of ['ssh_config', 'ssh_known_hosts']) {
    const relative = path.join('ssh', name);
    const content = await readBounded(path.join(etc, relative), maxBytes);
    if (!content) continue;
    plan.files.push({ relative, content });
    plan.binds.push({ relative, target: await target(relative) });
  }
  const configDir = path.join('ssh', 'ssh_config.d');
  if (await isDirectory(path.join(etc, configDir))) {
    // Unreadable folder: leave the original in place.
    const names = await readdir(path.join(etc, configDir)).then(
      (list) => list.sort(),
      () => undefined,
    );
    if (names) {
      plan.dirs.push(configDir);
      let copied = 0;
      for (const name of names) {
        if (copied >= maxFiles) break;
        const relative = path.join(configDir, name);
        const content = await readBounded(path.join(etc, relative), maxBytes);
        if (!content) continue;
        plan.files.push({ relative, content });
        copied += 1;
      }
      plan.binds.push({ relative: configDir, target: await target(configDir), directory: true });
    }
  }
  return plan;
}

async function writeShims(directory: string, plan: ShimPlan) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const dirs = new Set<string>();
  for (const relative of [...plan.dirs, ...plan.files.map((file) => path.dirname(file.relative))]) {
    for (let current = relative; current && current !== '.'; current = path.dirname(current)) dirs.add(current);
  }
  for (const relative of [...dirs].sort()) {
    await mkdir(path.join(directory, relative), { recursive: true, mode: 0o755 });
    await chmod(path.join(directory, relative), 0o755);
  }
  for (const file of plan.files) {
    await writeFile(path.join(directory, file.relative), file.content, { mode: 0o644, flag: 'wx' });
  }
}

/**
 * Per-user cache (0700) for shared shim copies, stable across processes so crashed or killed
 * servers leave nothing new behind; copies are content-addressed and only a few KB. A folder
 * that is a symlink, belongs to someone else or is open to others is refused (no shims).
 */
async function shimCache(): Promise<string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const root = path.join(os.tmpdir(), `adelic-system-shims-${uid ?? 'user'}`);
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(root);
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0)
    throw new Error('Pasta de cópias de configuração do sistema não é privada.');
  return root;
}

/**
 * Builds user-owned copies of root-owned client configs and returns the read-only bindings
 * that put them over the originals. With `dir`, the copies go there (a run-owned folder,
 * recreated); otherwise into a content-addressed folder of the per-process cache, so
 * repeated sandboxes reuse one copy. No system file to shim: no bindings.
 */
export async function systemConfigShims(
  options: SystemShimOptions & { dir?: string } = {},
): Promise<ReadonlyFileBinding[]> {
  const plan = await planSystemShims(options);
  if (!plan.binds.length) return [];
  let directory: string;
  const bindings: ReadonlyFileBinding[] = [];
  if (options.dir) {
    directory = path.resolve(options.dir);
    await rm(directory, { recursive: true, force: true });
    await writeShims(directory, plan);
    // The run folder is usually writable inside the sandbox: keep the copies read-only there too.
    bindings.push({ source: directory, target: directory, directory: true });
  } else {
    const hash = createHash('sha256');
    for (const relative of plan.dirs) hash.update(`d\0${relative}\0`);
    for (const file of plan.files) hash.update(`f\0${file.relative}\0${file.content.length}\0`).update(file.content);
    const root = await shimCache();
    directory = path.join(root, hash.digest('hex').slice(0, 24));
    if (!(await isDirectory(directory))) {
      // Built aside and renamed, so a concurrent sandbox never sees a half-written copy.
      const staging = path.join(root, `.staging-${randomUUID()}`);
      try {
        await writeShims(staging, plan);
        await rename(staging, directory);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        if (!(await isDirectory(directory))) throw error;
      }
    }
  }
  for (const bind of plan.binds)
    bindings.push({
      source: path.join(directory, bind.relative),
      target: bind.target,
      ...(bind.directory ? { directory: true } : {}),
    });
  return bindings;
}

/**
 * The ssh-agent socket when it lives under /tmp, which the sandbox hides behind a tmpfs:
 * bound at the same path so `SSH_AUTH_SOCK` keeps working (a read-only mount does not stop
 * `connect()`). Sockets elsewhere (/run/user/…) are already visible through `/`.
 */
export async function sshAgentBinding(env: NodeJS.ProcessEnv = process.env): Promise<ReadonlyFileBinding[]> {
  const socket = env.SSH_AUTH_SOCK;
  if (!socket || !path.isAbsolute(socket)) return [];
  const resolved = path.resolve(socket);
  if (resolved === TMP_ROOT || !isWithin(resolved, TMP_ROOT)) return [];
  try {
    const info = await stat(resolved);
    if (!info.isSocket() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return [];
  } catch {
    return [];
  }
  return [{ source: resolved, target: resolved, socket: true }];
}

export async function bubblewrap(
  command: string,
  args: string[],
  cwd: string,
  sandbox: Sandbox,
  writableRuntimeDirs: string[] = [],
  readonlyFileBindings: ReadonlyFileBinding[] = [],
  options: BubblewrapOptions = {},
): Promise<WrappedCommand> {
  const bwrap = '/usr/bin/bwrap';
  try {
    await access(bwrap);
  } catch {
    throw new Error('Política de filesystem indisponível: bubblewrap não está instalado.');
  }
  const requestedRoot = path.resolve(cwd);
  const root = await realpath(requestedRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('A pasta de trabalho do sandbox não é um diretório.');

  const runtimeDirs: { requested: string; source: string }[] = [];
  for (const directory of writableRuntimeDirs) {
    try {
      await access(directory);
      const source = await realpath(directory);
      if ((await stat(source)).isDirectory()) runtimeDirs.push({ requested: path.resolve(directory), source });
    } catch {
      /* Optional provider runtime directories may not exist yet. */
    }
  }

  const argv = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    ...(options.network === false ? ['--unshare-net'] : []),
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    TMP_ROOT,
  ];
  const bindings: { source: string; target: string; writable: boolean }[] = [];
  const workspaceWritable = sandbox === 'workspace-write';
  if (isWithin(root, TMP_ROOT) || workspaceWritable) {
    bindings.push({ source: root, target: root, writable: workspaceWritable });
  }

  // If the requested cwd was a symlink/alias below /tmp, restore that alias too so
  // provider protocols that receive the original cwd can still resolve it.
  if (requestedRoot !== root && isWithin(requestedRoot, TMP_ROOT)) {
    bindings.push({ source: requestedRoot, target: requestedRoot, writable: workspaceWritable });
  }

  for (const runtimeDir of runtimeDirs) {
    const target = isWithin(runtimeDir.requested, TMP_ROOT) ? runtimeDir.requested : runtimeDir.source;
    bindings.push({ source: runtimeDir.requested, target, writable: true });
  }

  const tmpDirectories = new Set<string>([TMP_ROOT]);
  for (const binding of bindings) {
    addTmpDirectories(argv, binding.target, tmpDirectories);
  }
  for (const binding of bindings) {
    argv.push(binding.writable ? '--bind' : '--ro-bind', binding.source, binding.target);
  }
  const extraBindings = [
    // A compatibility aid: when the copies cannot be made, the originals stay as they are.
    ...(options.systemShims === false
      ? []
      : await systemConfigShims({ dir: options.systemShims?.dir }).catch(() => [])),
    // Offline sandboxes (project checks, which also drop SSH_AUTH_SOCK) have no use for an agent.
    ...(options.sshAgent === false || options.network === false ? [] : await sshAgentBinding()),
  ];
  // File-level readonly grants must be last: later writable mounts must never
  // shadow credentials or another protected file inside a writable directory.
  for (const binding of [...extraBindings, ...readonlyFileBindings]) {
    const source = await realpath(binding.source);
    const sourceInfo = await stat(source);
    const valid = binding.socket
      ? sourceInfo.isSocket()
      : binding.directory
        ? sourceInfo.isDirectory()
        : sourceInfo.isFile();
    if (!valid) throw new Error('Caminho de runtime somente leitura inválido.');
    const target = path.resolve(binding.target);
    if (isWithin(target, TMP_ROOT)) addTmpDirectories(argv, path.dirname(target), tmpDirectories);
    argv.push('--ro-bind', source, target);
  }
  argv.push('--chdir', root, '--', command, ...args);
  return { command: bwrap, args: argv };
}

/**
 * Read-only bindings that make MCP commands reachable inside bubblewrap
 * (docs/specs/mcp-catalog.md). The sandbox already binds `/` read-only, so only commands
 * under /tmp (hidden by the tmpfs) need one: their own directory, never /tmp itself.
 * Directories inside the workspace are left alone so a read-only mount never shadows it.
 */
export async function mcpCommandBindings(commands: string[], cwd: string): Promise<ReadonlyFileBinding[]> {
  if (!commands.length) return [];
  const root = await realpath(path.resolve(cwd));
  const bindings = new Map<string, ReadonlyFileBinding>();
  for (const command of commands) {
    if (!path.isAbsolute(command)) throw new Error('Comando MCP sem caminho absoluto; nenhuma execução foi iniciada.');
    let resolved: string;
    try {
      resolved = await realpath(command);
      if (!(await stat(resolved)).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`Comando MCP indisponível: ${command}; nenhuma execução foi iniciada.`);
    }
    for (const file of new Set([path.resolve(command), resolved])) {
      const directory = path.dirname(file);
      if (!isWithin(directory, TMP_ROOT) || isWithin(directory, root)) continue;
      if (directory === TMP_ROOT)
        throw new Error(
          `Comando MCP direto em /tmp não é liberado no sandbox (${command}); mova-o para uma subpasta própria.`,
        );
      bindings.set(directory, { source: await realpath(directory), target: directory, directory: true });
    }
  }
  return [...bindings.values()];
}
