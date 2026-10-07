// Per-run checkpoints of a git project's working tree, stored as commits under a private
// ref namespace (refs/adelic/checkpoints/<runId>/{before,after}). See docs/specs/checkpoints.md.
//
// Guarantees: never touches HEAD, branches, the real index, the stash or the working tree,
// except `restore()`, which writes only the paths the run changed. Files are hashed as raw
// bytes (`hash-object --no-filters`), so clean/smudge filters and eol conversion from the
// repository's config never execute: an agent with workspace-write could have planted them,
// and Adelic runs git outside the sandbox. Hooks, fsmonitor and replace refs are disabled.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileChange, RunCheckpoint } from '../shared/contracts.js';

export const REF_PREFIX = 'refs/adelic/checkpoints';
export const NOT_GIT = 'não é um repositório git';
/** Limits that keep a snapshot bounded; beyond them the checkpoint is unavailable for the run. */
export const LIMITS = {
  files: 100_000,
  fileBytes: 50 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  diffBytes: 200 * 1024,
  listed: 500,
};
const TIMEOUT_MS = 120_000;

/** Every hook event git knows; config-defined hooks (`hook.<name>.command`) ignore core.hooksPath. */
const HOOK_EVENTS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'post-index-change',
];
/** Disables hooks from the hooks folder and from `hook.*` config alike. */
export const HOOKS_OFF = ['core.hooksPath=/dev/null', ...HOOK_EVENTS.map((e) => `hook.${e}.enabled=false`)].flatMap(
  (c) => ['-c', c],
);
/** `-c` pairs that stop repository config from running programs, except hooks (see HOOKS_OFF). */
export const HARDENED_BASE = [
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.splitIndex=false',
  'core.quotePath=false',
  'commit.gpgSign=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'color.ui=false',
  'log.showSignature=false',
].flatMap((c) => ['-c', c]);
/** `-c` pairs that stop repository config from running programs or redirecting output. */
export const HARDENED_CONFIG = [...HARDENED_BASE, ...HOOKS_OFF];
/** Checkpoint commits (never on a branch) carry the Adelic identity. */
export const SAFE_CONFIG = [...HARDENED_CONFIG, '-c', 'user.name=Adelic', '-c', 'user.email=adelic@localhost'];

export class CheckpointError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly conflicts?: string[],
  ) {
    super(message);
  }
}

export interface Repo {
  /** Real path of the snapshotted folder (the project); may be below the repository top. */
  root: string;
  /** Repository top level; tree and file paths are relative to it. */
  top: string;
  gitDir: string;
  format: 'sha1' | 'sha256';
}

export function baseEnv(repo?: Repo, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {};
  // Inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE…) would redirect the commands.
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
    ...(repo ? { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.top } : {}),
    ...extra,
  };
}

export interface GitOptions {
  repo?: Repo;
  input?: string | Buffer;
  env?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  /** `-c` arguments placed before the command; defaults to SAFE_CONFIG (with the Adelic identity). */
  config?: string[];
  /** Exit codes other than 0 that still count as success (e.g. 1 for `diff --no-index`). */
  okCodes?: number[];
  /** Output beyond `maxBytes` is cut instead of failing (the command is stopped). */
  truncate?: boolean;
}

/** Runs git with execFile (no shell), a timeout and the hardened environment. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = execFile(
      'git',
      [...(opts.config ?? SAFE_CONFIG), ...args],
      {
        cwd,
        env: baseEnv(opts.repo, opts.env),
        encoding: 'buffer',
        timeout: opts.timeoutMs ?? TIMEOUT_MS,
        maxBuffer: opts.maxBytes ?? 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (error && opts.truncate && code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') done(stdout);
        else if (error && typeof code === 'number' && opts.okCodes?.includes(code) && !error.killed) done(stdout);
        else if (error) {
          const detail = stderr.toString('utf8').trim().split('\n').at(-1) || error.message;
          fail(Object.assign(new Error(`git ${args[0]}: ${detail}`), { code, stderr: stderr.toString('utf8') }));
        } else done(stdout);
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/** Git records only the owner's execute bit. */
const fileMode = (mode: number) => (mode & 0o100 ? '100755' : '100644');
export const lines = (b: Buffer) => b.toString('utf8').split('\n').filter(Boolean);
export const nulSplit = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean);

/** Finds the repository for `path`, or undefined when it is not inside a work tree. */
export async function openRepo(path: string, requireToplevel: boolean): Promise<Repo | undefined> {
  let root: string;
  try {
    root = await realpath(path);
  } catch {
    return undefined;
  }
  let out: string[];
  try {
    out = lines(await git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-object-format']));
  } catch {
    return undefined;
  }
  const [topRaw, gitDir, format] = out;
  if (!topRaw || !gitDir) return undefined;
  const top = await realpath(topRaw);
  if (requireToplevel && top !== root) return undefined;
  if (relative(top, root).startsWith('..')) return undefined;
  return { root, top, gitDir, format: format === 'sha256' ? 'sha256' : 'sha1' };
}

/**
 * Tracked and non-ignored untracked files below `path` (relative to it, `/`-separated), with
 * the same hardened git invocation as the checkpoints. Undefined when `path` is not inside a
 * git work tree. Names that are not valid UTF-8 are dropped.
 */
export async function listGitFiles(
  path: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string[] | undefined> {
  const repo = await openRepo(path, false);
  if (!repo) return undefined;
  // Run from the project folder: ls-files then lists only that subtree, relative to it.
  const out = await git(repo.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    repo,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
  });
  return [...new Set(nulSplit(out))].filter((p) => !p.includes('\uFFFD'));
}

/** C-style quoting understood by `--stdin-paths` (one path per line). */
function quote(path: string) {
  return `"${path
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

/** Git blob id of `data`, computed locally (used to compare the working tree with a tree entry). */
export function blobId(data: Buffer, format: Repo['format']) {
  return createHash(format).update(`blob ${data.length}\0`).update(data).digest('hex');
}

/** Writes a tree of the folder's tracked and non-ignored files; returns its id. */
async function writeSnapshotTree(repo: Repo): Promise<string> {
  const listed = nulSplit(
    await git(repo.root, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard'], { repo }),
  );
  const paths = [...new Set(listed)];
  if (paths.length > LIMITS.files)
    throw new CheckpointError(`mais de ${LIMITS.files} arquivos na pasta do projeto`, 422);
  const regular: { path: string; mode: string }[] = [];
  const links: { path: string; target: Buffer }[] = [];
  let total = 0;
  for (const path of paths) {
    if (path.includes('\uFFFD')) throw new CheckpointError('há nomes de arquivo que não são UTF-8', 422);
    let info;
    try {
      info = await lstat(join(repo.top, path));
    } catch {
      continue; // Deleted tracked file: absent from the snapshot.
    }
    if (info.isSymbolicLink()) links.push({ path, target: await readlink(join(repo.top, path), 'buffer') });
    else if (info.isFile()) {
      if (info.size > LIMITS.fileBytes)
        throw new CheckpointError(`arquivo maior que ${LIMITS.fileBytes / 1024 / 1024} MB: ${path}`, 422);
      total += info.size;
      if (total > LIMITS.totalBytes) throw new CheckpointError('a pasta do projeto passa de 1 GB em arquivos', 422);
      regular.push({ path, mode: fileMode(info.mode) });
    }
    // Directories (submodules, nested repositories), sockets and devices are not covered.
  }
  const ids = regular.length
    ? lines(
        await git(repo.top, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
          repo,
          input: regular.map((f) => quote(f.path)).join('\n') + '\n',
        }),
      )
    : [];
  if (ids.length !== regular.length) throw new Error('git hash-object retornou uma quantidade inesperada');
  const entries = regular.map((f, i) => `${f.mode} ${ids[i]}\t${f.path}\0`);
  for (const link of links) {
    const id = (await git(repo.top, ['hash-object', '-w', '--stdin'], { repo, input: link.target })).toString().trim();
    entries.push(`120000 ${id}\t${link.path}\0`);
  }
  // A private temporary index: the user's index is never read for writing nor modified.
  const dir = await mkdtemp(join(tmpdir(), 'adelic-checkpoint-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await git(repo.top, ['update-index', '-z', '--index-info'], { repo, env, input: entries.join('') });
    return (await git(repo.top, ['write-tree'], { repo, env })).toString().trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const refFor = (runId: string, kind: 'before' | 'after') => {
  if (!/^[\w-]{1,128}$/.test(runId)) throw new Error('Identificador de execução inválido');
  return `${REF_PREFIX}/${runId}/${kind}`;
};

/** Snapshot taken before a run that may write. Never throws: failures become `available: false`. */
export async function checkpointBefore(
  path: string,
  runId: string,
  opts: { requireToplevel?: boolean } = {},
): Promise<RunCheckpoint> {
  try {
    const repo = await openRepo(path, Boolean(opts.requireToplevel));
    if (!repo) return { available: false, reason: NOT_GIT };
    const tree = await writeSnapshotTree(repo);
    const commit = (
      await git(repo.top, ['commit-tree', '--no-gpg-sign', tree, '-m', `Adelic checkpoint ${runId} before`], { repo })
    )
      .toString()
      .trim();
    await git(repo.top, ['update-ref', '-m', 'adelic checkpoint', refFor(runId, 'before'), commit, ''], { repo });
    return { available: true, root: repo.root, before: commit };
  } catch (e) {
    return { available: false, reason: reasonOf(e) };
  }
}

/** Snapshot after the run, plus the list of changed files. Drops both refs when nothing changed. */
export async function checkpointAfter(runId: string, checkpoint: RunCheckpoint): Promise<RunCheckpoint> {
  if (!checkpoint.available || !checkpoint.before || !checkpoint.root) return checkpoint;
  try {
    const repo = await openRepo(checkpoint.root, false);
    if (!repo || repo.root !== checkpoint.root) return { ...checkpoint, available: false, reason: NOT_GIT };
    const tree = await writeSnapshotTree(repo);
    const beforeTree = (await git(repo.top, ['rev-parse', `${checkpoint.before}^{tree}`], { repo })).toString().trim();
    if (beforeTree === tree) {
      await git(repo.top, ['update-ref', '-d', refFor(runId, 'before'), checkpoint.before], { repo }).catch(
        () => undefined,
      );
      return { available: true, root: checkpoint.root, files: [] };
    }
    const commit = (
      await git(
        repo.top,
        ['commit-tree', '--no-gpg-sign', tree, '-p', checkpoint.before, '-m', `Adelic checkpoint ${runId} after`],
        { repo },
      )
    )
      .toString()
      .trim();
    await git(repo.top, ['update-ref', '-m', 'adelic checkpoint', refFor(runId, 'after'), commit, ''], { repo });
    const changes = await changedFiles(repo, checkpoint.before, commit);
    const files = changes.slice(0, LIMITS.listed).map(({ path, status, additions, deletions, binary }) => ({
      path,
      status,
      additions,
      deletions,
      ...(binary ? { binary } : {}),
    }));
    return {
      ...checkpoint,
      after: commit,
      files,
      ...(changes.length > files.length ? { omitted: changes.length - files.length } : {}),
    };
  } catch (e) {
    return { ...checkpoint, available: false, reason: reasonOf(e) };
  }
}

interface RawChange extends FileChange {
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
}

async function changedFiles(repo: Repo, before: string, after: string): Promise<RawChange[]> {
  const raw = nulSplit(
    await git(repo.top, ['diff-tree', '-r', '-z', '--no-renames', '--raw', before, after], { repo }),
  );
  const changes: RawChange[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [oldMode, newMode, oldId, newId, letter] = raw[i].replace(/^:/, '').split(' ');
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    changes.push({ path: raw[i + 1], status, additions: 0, deletions: 0, oldMode, newMode, oldId, newId });
  }
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const numstat = nulSplit(
    await git(repo.top, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', before, after], { repo }),
  );
  for (const record of numstat) {
    const [added, deleted, ...rest] = record.split('\t');
    const change = byPath.get(rest.join('\t'));
    if (!change) continue;
    if (added === '-') change.binary = true;
    else {
      change.additions = Number(added) || 0;
      change.deletions = Number(deleted) || 0;
    }
  }
  return changes;
}

/** Opens the repository that holds a finished checkpoint and checks its refs are intact. */
async function openCheckpoint(runId: string, checkpoint: RunCheckpoint | undefined) {
  if (!checkpoint?.available || !checkpoint.root || !checkpoint.before || !checkpoint.after)
    throw new CheckpointError('Esta execução não tem alterações registradas', 404);
  const repo = await openRepo(checkpoint.root, false);
  if (!repo || repo.root !== checkpoint.root)
    throw new CheckpointError('O repositório do checkpoint não existe mais', 410);
  for (const kind of ['before', 'after'] as const) {
    const id = await git(repo.top, ['rev-parse', '--verify', '-q', refFor(runId, kind)], { repo })
      .then((b) => b.toString().trim())
      .catch(() => '');
    if (id !== checkpoint[kind])
      throw new CheckpointError('O checkpoint desta execução foi removido do repositório', 410);
  }
  return { repo, before: checkpoint.before, after: checkpoint.after };
}

/** Unified diff of one changed file, bounded to LIMITS.diffBytes. */
export async function checkpointDiff(runId: string, checkpoint: RunCheckpoint | undefined, path: string) {
  if (!checkpoint?.files?.some((f) => f.path === path))
    throw new CheckpointError('Arquivo não foi alterado por esta execução', 404);
  const { repo, before, after } = await openCheckpoint(runId, checkpoint);
  const out = await git(
    repo.top,
    [
      'diff-tree',
      '-p',
      '-r',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      before,
      after,
      '--',
      path,
    ],
    { repo, maxBytes: 64 * 1024 * 1024 },
  );
  const truncated = out.length > LIMITS.diffBytes;
  // Cut at a line boundary so a multi-byte character is never split.
  const cut = truncated ? out.subarray(0, out.lastIndexOf(0x0a, LIMITS.diffBytes) + 1) : out;
  return { path, diff: cut.toString('utf8'), truncated };
}

/**
 * Rejects absolute paths, `..`, `.git` and anything outside the project folder. `fileParent` is
 * the first parent that is a file or a symlink: writing through a symlinked folder could land
 * outside the project, so the restore goes on only if the run itself added that entry.
 */
async function safeTarget(repo: Repo, path: string) {
  const parts = path.split('/');
  if (!path || path.startsWith('/') || parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))
    throw new CheckpointError(`Caminho inválido no checkpoint: ${path}`, 422);
  const target = resolve(repo.top, path);
  if (!target.startsWith(repo.root + sep)) throw new CheckpointError(`Caminho fora do projeto: ${path}`, 422);
  let current = repo.top;
  let fileParent: string | undefined;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fileParent = relative(repo.top, current).split(sep).join('/');
      break;
    }
  }
  return { target, fileParent };
}

/** True when the working-tree entry at `target` equals the tree entry (mode + id), or both are absent. */
async function matches(repo: Repo, target: string, mode: string, id: string) {
  const absent = /^0+$/.test(mode);
  const info = await lstat(target).catch(() => undefined);
  if (!info) return absent;
  if (absent) return false;
  if (mode === '120000') return info.isSymbolicLink() && blobId(await readlink(target, 'buffer'), repo.format) === id;
  if (!info.isFile() || fileMode(info.mode) !== mode) return false;
  return blobId(await readFile(target), repo.format) === id;
}

/**
 * Puts back the `before` content of every path the run changed, but only when each path still
 * matches the run's `after` state; otherwise nothing is written and the conflicts are reported.
 */
export async function restoreCheckpoint(runId: string, checkpoint: RunCheckpoint | undefined) {
  if (checkpoint?.restoredAt) throw new CheckpointError('As alterações desta execução já foram desfeitas', 409);
  const { repo, before, after } = await openCheckpoint(runId, checkpoint);
  const changes = await changedFiles(repo, before, after);
  const plan: { change: RawChange; target: string }[] = [];
  const conflicts: string[] = [];
  const added = new Set(changes.filter((c) => c.status === 'added').map((c) => c.path));
  for (const change of changes) {
    const { target, fileParent } = await safeTarget(repo, change.path);
    // Below a file or symlink the path does not exist in the project, whatever lstat says.
    const ok =
      fileParent === undefined
        ? await matches(repo, target, change.newMode, change.newId)
        : added.has(fileParent) && /^0+$/.test(change.newMode);
    if (!ok) conflicts.push(change.path);
    else plan.push({ change, target });
  }
  if (conflicts.length)
    throw new CheckpointError(
      `${conflicts.length === 1 ? 'Um arquivo foi alterado' : `${conflicts.length} arquivos foram alterados`} depois desta execução; nada foi desfeito.`,
      409,
      conflicts,
    );
  // Read every blob first, so a missing object cannot leave a half-restored tree.
  const contents = new Map<string, Buffer>();
  for (const { change } of plan)
    if (change.status !== 'added')
      contents.set(change.path, await git(repo.top, ['cat-file', 'blob', change.oldId], { repo }));
  // Remove what the run added first: a file it added may sit where a deleted directory was.
  for (const { change, target } of plan) {
    if (change.status !== 'added') continue;
    await unlink(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await removeEmptyParents(repo.root, target);
  }
  for (const { change, target } of plan) {
    if (change.status === 'added') continue;
    const data = contents.get(change.path)!;
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    const temp = join(parent, `.adelic-restore-${randomBytes(6).toString('hex')}`);
    if (change.oldMode === '120000') await symlink(data, temp);
    else await writeFile(temp, data, { flag: 'wx', mode: change.oldMode === '100755' ? 0o755 : 0o644 });
    try {
      await rename(temp, target);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
  }
  return { restored: plan.map((p) => p.change.path) };
}

/** Directories left empty by removing an added file (git does not track empty directories). */
export async function removeEmptyParents(root: string, target: string) {
  for (let dir = dirname(target); dir.startsWith(root + sep); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return; // Not empty (or already gone): stop.
    }
  }
}

function reasonOf(e: unknown) {
  if (e instanceof CheckpointError) return e.message;
  return `falha ao registrar o checkpoint: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
}
