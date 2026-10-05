import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Sandbox } from '../../shared/contracts';

export interface WrappedCommand { command: string; args: string[] }

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

export async function bubblewrap(command: string, args: string[], cwd: string, sandbox: Sandbox, writableRuntimeDirs: string[] = []): Promise<WrappedCommand> {
  const bwrap = '/usr/bin/bwrap';
  try { await access(bwrap); } catch { throw new Error('Política de filesystem indisponível: bubblewrap não está instalado.'); }
  const requestedRoot = path.resolve(cwd);
  const root = await realpath(requestedRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('A pasta de trabalho do sandbox não é um diretório.');

  const runtimeDirs: { requested: string; source: string }[] = [];
  for (const directory of writableRuntimeDirs) {
    try {
      await access(directory);
      const source = await realpath(directory);
      if ((await stat(source)).isDirectory()) runtimeDirs.push({ requested: path.resolve(directory), source });
    } catch { /* Optional provider runtime directories may not exist yet. */ }
  }

  const argv = ['--die-with-parent', '--new-session', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', TMP_ROOT];
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
  argv.push('--chdir', root, '--', command, ...args);
  return { command: bwrap, args: argv };
}
