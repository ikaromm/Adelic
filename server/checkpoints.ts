// Per-run checkpoints of a git project's working tree, stored as commits under a private
// ref namespace (refs/adelic/checkpoints/<runId>/{before,after}). See docs/specs/checkpoints.md.
//
// Guarantees: never touches HEAD, branches, the real index, the stash or the working tree,
// except `restore()`, which writes only the paths the run changed. Files are hashed as raw
// bytes (`hash-object --no-filters`), so clean/smudge filters and eol conversion from the
// repository's config never execute: an agent with workspace-write could have planted them,
// and Adelic runs git outside the sandbox. Hooks, fsmonitor and replace refs are disabled.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
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
import type { Vars } from '../shared/i18n.js';
import { localize, type ServerKey } from './i18n.js';

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
  /** A CheckpointError whose message is a catalog key, translated per request (docs/i18n.md). */
  static of<T extends CheckpointError>(
    this: new (message: string, status?: number, conflicts?: string[]) => T,
    key: ServerKey,
    vars?: Vars,
    status = 409,
    conflicts?: string[],
  ): T {
    return localize(new this('', status, conflicts), key, vars);
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
  signal?: AbortSignal;
  /** `-c` arguments placed before the command; defaults to SAFE_CONFIG (with the Adelic identity). */
  config?: string[];
  /** Exit codes other than 0 that still count as success (e.g. 1 for `diff --no-index`). */
  okCodes?: number[];
  /** Output beyond `maxBytes` is cut instead of failing (the command is stopped). */
  truncate?: boolean;
}

/** Signal and await the isolated process group for one Git invocation. */
async function stopGitProcessGroup(pid: number) {
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      // detached:true gives this invocation its own process group, so this cannot signal
      // unrelated processes even when Git has already exited and left descendants behind.
      process.kill(-pid, signal);
    } catch {
      // ESRCH means the private group is already gone; never fall back to a bare PID,
      // which could refer to an unrelated process after the Git leader exits.
    }
  };
  const groupHasLiveProcess = async () => {
    // Linux reports zombies through kill(0) too; they are no longer executing user code.
    try {
      for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let stat: string;
        try {
          stat = await readFile(`/proc/${entry}/stat`, 'utf8');
        } catch {
          continue;
        }
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
      }
      return false;
    } catch {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    }
  };

  signalGroup('SIGTERM');
  const graceUntil = Date.now() + 100;
  while ((await groupHasLiveProcess()) && Date.now() < graceUntil)
    await new Promise((resolve) => setTimeout(resolve, 10));
  signalGroup('SIGKILL');
  while (await groupHasLiveProcess()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Runs Git in a private process group and awaits all of its surviving activity. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  return new Promise((done, fail) => {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeoutError: Error | undefined;
    let abortError: Error | undefined;
    let outputLimit = false;
    let spawnError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // A process group does not contain descendants which call setsid()/spawn({ detached: true }).
    // On Linux, put the complete invocation in a private PID namespace. When its namespace
    // init (the wrapped Git process) exits or is killed, the kernel kills/reaps every remaining
    // process in that namespace, including descendants outside the process group. Never silently
    // fall back to process-group-only handling: that would release checkpoint writes unsafely.
    if (process.platform !== 'linux') {
      fail(new Error('Git process containment requires Linux PID namespaces'));
      return;
    }
    const child = spawn(
      '/usr/bin/bwrap',
      [
        '--die-with-parent',
        '--unshare-pid',
        '--bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--',
        'git',
        ...(opts.config ?? SAFE_CONFIG),
        ...args,
      ],
      {
        cwd,
        env: baseEnv(opts.repo, opts.env),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Never fall back to a bare PID after the leader may have exited and its PID been reused.
      }
    };
    const terminateGroup = () => {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 100);
    };
    const onAbort = () => {
      abortError ??= new Error(opts.signal?.reason instanceof Error ? opts.signal.reason.message : 'Git cancelled');
      abortError.name = 'AbortError';
      terminateGroup();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const capture = (target: Buffer[], current: number, chunk: Buffer) => {
      if (outputLimit) return current;
      const available = Math.max(0, maxBytes - current);
      target.push(chunk.subarray(0, available));
      const next = current + Math.min(chunk.length, available);
      if (chunk.length > available) {
        outputLimit = true;
        terminateGroup();
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = capture(stdout, stdoutBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = capture(stderr, stderrBytes, chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
    const timeout = setTimeout(() => {
      timeoutError = Object.assign(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
      terminateGroup();
    }, timeoutMs);

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      void (async () => {
        if (child.pid !== undefined) await stopGitProcessGroup(child.pid);
        if (abortError) {
          fail(Object.assign(abortError, { stderr: err.toString('utf8') }));
          return;
        }
        if (timeoutError) {
          fail(Object.assign(timeoutError, { stderr: err.toString('utf8') }));
          return;
        }
        if (outputLimit) {
          if (opts.truncate) done(out);
          else
            fail(
              Object.assign(new Error('stdout maxBuffer exceeded'), {
                code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                stderr: err.toString('utf8'),
              }),
            );
          return;
        }
        if (spawnError) {
          fail(spawnError);
          return;
        }
        if (exitCode !== 0 || signal) {
          const code: unknown = signal ?? exitCode;
          if (typeof code === 'number' && opts.okCodes?.includes(code) && !signal) {
            done(out);
            return;
          }
          const detail = err.toString('utf8').trim().split('\n').at(-1) || `exited with ${String(code)}`;
          fail(Object.assign(new Error(`git ${args[0]}: ${detail}`), { code, stderr: err.toString('utf8') }));
          return;
        }
        done(out);
      })().catch(fail);
    });
  });
}

/** Git records only the owner's execute bit. */
const fileMode = (mode: number) => (mode & 0o100 ? '100755' : '100644');
export const lines = (b: Buffer) => b.toString('utf8').split('\n').filter(Boolean);
export const nulSplit = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean);

/** Finds the repository for `path`, or undefined when it is not inside a work tree. */
export async function openRepo(
  path: string,
  requireToplevel: boolean,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Repo | undefined> {
  let root: string;
  try {
    root = await realpath(path);
  } catch {
    return undefined;
  }
  let out: string[];
  try {
    out = lines(
      await git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--show-object-format'], {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      }),
    );
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
function remainingTimeout(deadlineAt?: string, signal?: AbortSignal): number | undefined {
  // Cancellation is the first cause when it was already observed before the deadline check.
  if (signal?.aborted) {
    const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'Checkpoint cancelled');
    error.name = 'AbortError';
    throw error;
  }
  if (!deadlineAt) return undefined;
  const parsedDeadline = Date.parse(deadlineAt);
  if (!Number.isFinite(parsedDeadline)) throw new Error('Invalid finalization deadline');
  const remaining = parsedDeadline - Date.now();
  if (remaining <= 0) throw new Error('Finalization deadline exceeded');
  return Math.max(1, remaining);
}

export async function writeSnapshotTree(
  repo: Repo,
  opts: { includePaths?: string[]; deadlineAt?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const gitOpts = () => ({ repo, timeoutMs: remainingTimeout(opts.deadlineAt, opts.signal), signal: opts.signal });
  const listed = nulSplit(
    await git(repo.root, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard'], gitOpts()),
  );
  // A caller may add paths from a trusted captured tree. This keeps eligible baseline files
  // visible if a later .gitignore change would otherwise hide them, without including any
  // path that was ignored when that baseline was captured.
  const paths = [...new Set([...listed, ...(opts.includePaths ?? [])])];
  if (paths.length > LIMITS.files)
    throw new CheckpointError(`mais de ${LIMITS.files} arquivos na pasta do projeto`, 422);
  const regular: { path: string; mode: string }[] = [];
  const links: { path: string; target: Buffer }[] = [];
  let total = 0;
  for (const path of paths) {
    remainingTimeout(opts.deadlineAt, opts.signal);
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
          ...gitOpts(),
          input: regular.map((f) => quote(f.path)).join('\n') + '\n',
        }),
      )
    : [];
  if (ids.length !== regular.length) throw new Error('git hash-object retornou uma quantidade inesperada');
  const entries = regular.map((f, i) => `${f.mode} ${ids[i]}\t${f.path}\0`);
  for (const link of links) {
    const id = (await git(repo.top, ['hash-object', '-w', '--stdin'], { ...gitOpts(), input: link.target }))
      .toString()
      .trim();
    entries.push(`120000 ${id}\t${link.path}\0`);
  }
  // A private temporary index: the user's index is never read for writing nor modified.
  const dir = await mkdtemp(join(tmpdir(), 'adelic-checkpoint-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await git(repo.top, ['update-index', '-z', '--index-info'], { ...gitOpts(), env, input: entries.join('') });
    return (await git(repo.top, ['write-tree'], { ...gitOpts(), env })).toString().trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const refFor = (runId: string, kind: 'before' | 'after') => {
  if (!/^[\w-]{1,128}$/.test(runId)) throw new Error('Identificador de execução inválido');
  return `${REF_PREFIX}/${runId}/${kind}`;
};

export type GitRepoClassification = { status: 'available'; repo: Repo } | { status: 'absent' } | { status: 'unknown' };

/**
 * Read-only Git probe shared by checkpoint, panel and run-context decisions.
 * A failed probe with Git metadata is unknown, never evidence of absence.
 */
export async function classifyGitRepo(
  path: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<GitRepoClassification> {
  let repo: Repo | undefined;
  try {
    repo = await openRepo(path, false, opts);
  } catch {
    return { status: 'unknown' };
  }
  if (repo) return { status: 'available', repo };

  let current: string;
  try {
    current = resolve(await realpath(path));
  } catch {
    return { status: 'unknown' };
  }
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return { status: 'unknown' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { status: 'unknown' };
    }
    const parent = dirname(current);
    if (parent === current) return { status: 'absent' };
    current = parent;
  }
}

/** Snapshot taken before a run that may write. Never throws: failures become `available: false`. */
export async function checkpointBefore(
  path: string,
  runId: string,
  opts: { requireToplevel?: boolean; deadlineAt?: string; reserveMs?: number; signal?: AbortSignal } = {},
): Promise<RunCheckpoint> {
  try {
    const deadlineAt =
      opts.deadlineAt && opts.reserveMs
        ? new Date(Date.parse(opts.deadlineAt) - Math.max(0, opts.reserveMs)).toISOString()
        : opts.deadlineAt;
    const remaining = () => remainingTimeout(deadlineAt, opts.signal);
    remaining();
    const classification = await classifyGitRepo(path, { timeoutMs: remaining(), signal: opts.signal });
    remaining();
    if (classification.status !== 'available') {
      return {
        available: false,
        captureState: classification.status === 'absent' ? 'not_applicable' : 'failed',
        reason: NOT_GIT,
      };
    }
    const repo = classification.repo;
    if (opts.requireToplevel && repo.root !== repo.top) {
      remaining();
      return { available: false, captureState: 'not_applicable', reason: NOT_GIT };
    }
    const tree = await writeSnapshotTree(repo, { deadlineAt, signal: opts.signal });
    const commit = (
      await git(repo.top, ['commit-tree', '--no-gpg-sign', tree, '-m', `Adelic checkpoint ${runId} before`], {
        repo,
        timeoutMs: remaining(),
        signal: opts.signal,
      })
    )
      .toString()
      .trim();
    await git(repo.top, ['update-ref', '-m', 'adelic checkpoint', refFor(runId, 'before'), commit, ''], {
      repo,
      timeoutMs: remaining(),
      signal: opts.signal,
    });
    remaining();
    return { available: true, root: repo.root, before: commit };
  } catch (e) {
    return { available: false, captureState: 'failed', reason: reasonOf(e) };
  }
}

/** Snapshot after the run, plus the list of changed files. Drops both refs when nothing changed. */
export async function checkpointAfter(
  runId: string,
  checkpoint: RunCheckpoint,
  opts: { deadlineAt?: string } = {},
): Promise<RunCheckpoint> {
  if (!checkpoint.available || !checkpoint.before || !checkpoint.root) return checkpoint;
  try {
    const repo = await openRepo(checkpoint.root, false, { timeoutMs: remainingTimeout(opts.deadlineAt) });
    if (!repo || repo.root !== checkpoint.root)
      return { ...checkpoint, available: false, captureState: 'failed', reason: NOT_GIT };
    const commandOpts = () => ({ repo, timeoutMs: remainingTimeout(opts.deadlineAt) });
    const tree = await writeSnapshotTree(repo, { deadlineAt: opts.deadlineAt });
    const beforeTree = (await git(repo.top, ['rev-parse', `${checkpoint.before}^{tree}`], commandOpts()))
      .toString()
      .trim();
    if (beforeTree === tree) {
      await git(repo.top, ['update-ref', '-d', refFor(runId, 'before'), checkpoint.before], commandOpts()).catch(
        () => undefined,
      );
      return { available: true, root: checkpoint.root, files: [] };
    }
    const commit = (
      await git(
        repo.top,
        ['commit-tree', '--no-gpg-sign', tree, '-p', checkpoint.before, '-m', `Adelic checkpoint ${runId} after`],
        commandOpts(),
      )
    )
      .toString()
      .trim();
    await git(repo.top, ['update-ref', '-m', 'adelic checkpoint', refFor(runId, 'after'), commit, ''], commandOpts());
    const changes = await changedFiles(repo, checkpoint.before, commit, opts);
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
    return { ...checkpoint, available: false, captureState: 'failed', reason: reasonOf(e) };
  }
}

export interface RawChange extends FileChange {
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
}

export async function changedFiles(
  repo: Repo,
  before: string,
  after: string,
  opts: { deadlineAt?: string; signal?: AbortSignal } = {},
): Promise<RawChange[]> {
  const commandOpts = () => ({ repo, timeoutMs: remainingTimeout(opts.deadlineAt, opts.signal), signal: opts.signal });
  const raw = nulSplit(
    await git(repo.top, ['diff-tree', '-r', '-z', '--no-renames', '--raw', before, after], commandOpts()),
  );
  const changes: RawChange[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [oldMode, newMode, oldId, newId, letter] = raw[i].replace(/^:/, '').split(' ');
    const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    changes.push({ path: raw[i + 1], status, additions: 0, deletions: 0, oldMode, newMode, oldId, newId });
  }
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const numstat = nulSplit(
    await git(repo.top, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', before, after], commandOpts()),
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
    throw CheckpointError.of('checkpoints.noChanges', undefined, 404);
  const repo = await openRepo(checkpoint.root, false);
  if (!repo || repo.root !== checkpoint.root) throw CheckpointError.of('checkpoints.repoGone', undefined, 410);
  for (const kind of ['before', 'after'] as const) {
    const id = await git(repo.top, ['rev-parse', '--verify', '-q', refFor(runId, kind)], { repo })
      .then((b) => b.toString().trim())
      .catch(() => '');
    if (id !== checkpoint[kind]) throw CheckpointError.of('checkpoints.refsGone', undefined, 410);
  }
  return { repo, before: checkpoint.before, after: checkpoint.after };
}

/** Unified diff of one changed file, bounded to LIMITS.diffBytes. */
export async function checkpointDiff(runId: string, checkpoint: RunCheckpoint | undefined, path: string) {
  if (!checkpoint?.files?.some((f) => f.path === path))
    throw CheckpointError.of('checkpoints.fileNotChanged', undefined, 404);
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
    throw CheckpointError.of('checkpoints.invalidPath', { path }, 422);
  const target = resolve(repo.top, path);
  if (!target.startsWith(repo.root + sep)) throw CheckpointError.of('checkpoints.outsidePath', { path }, 422);
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
  if (checkpoint?.restoredAt) throw CheckpointError.of('orchestrator.alreadyRestored');
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
  if (conflicts.length) throw CheckpointError.of('checkpoints.conflicts', { count: conflicts.length }, 409, conflicts);
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
