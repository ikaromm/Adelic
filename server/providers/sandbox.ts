import { access, realpath, stat } from 'node:fs/promises';
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
}

const TMP_ROOT = '/tmp';

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

export async function bubblewrap(
  command: string,
  args: string[],
  cwd: string,
  sandbox: Sandbox,
  writableRuntimeDirs: string[] = [],
  readonlyFileBindings: ReadonlyFileBinding[] = [],
  /** `network: false` adds a private network namespace (project checks); agents keep the default. */
  options: { network?: boolean } = {},
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
  // File-level readonly grants must be last: later writable mounts must never
  // shadow credentials or another protected file inside a writable directory.
  for (const binding of readonlyFileBindings) {
    const source = await realpath(binding.source);
    const sourceInfo = await stat(source);
    if (binding.directory ? !sourceInfo.isDirectory() : !sourceInfo.isFile())
      throw new Error('Caminho de runtime somente leitura inválido.');
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
