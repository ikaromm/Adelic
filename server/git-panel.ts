import { withObservation } from './observability.js';
// Git panel of a project: status, diffs, stage/unstage/discard, commit, push and a compare
// URL for a pull request. See docs/specs/git-panel.md.
//
// Every command goes through the hardened helper of server/checkpoints.ts (execFile, no shell,
// timeout, no prompts, inherited GIT_* dropped). On top of it: hooks are off unless the project
// opted in for commits, clean/smudge/process filters named in any config are neutralized, diffs
// never run textconv or external drivers, and push refuses when the repository's own config
// would make git run a program (credential helper, ssh command, receive-pack…). The agent can
// write `.git/config`, and Adelic runs git outside the sandbox.
import { lstat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { GitCommitInfo, GitFileEntry, GitStatus, Project } from '../shared/contracts.js';
import {
  CheckpointError,
  HARDENED_BASE,
  HARDENED_CONFIG,
  LIMITS,
  NOT_GIT,
  git,
  nulSplit,
  openRepo,
  removeEmptyParents,
  type GitOptions,
  type Repo,
} from './checkpoints.js';

/** Files listed by the status endpoint; mutations still see the whole list. */
export const STATUS_LISTED = 2000;
export const LOG_LIMIT = 20;
const READ_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;

export class GitPanelError extends CheckpointError {}

/** Repository of a project (the project may sit below the top level). */
export async function projectRepo(project: Pick<Project, 'path'>): Promise<Repo> {
  const repo = await openRepo(project.path, false);
  if (!repo) throw GitPanelError.of('git.notRepo');
  return repo;
}

export async function isGitRepo(project: Pick<Project, 'path'>) {
  return Boolean(await openRepo(project.path, false));
}

/**
 * `-c` pairs that turn every configured filter driver into a no-op: `filter.<name>.clean` and
 * friends would otherwise run on add, status, diff and restore.
 */
async function filtersOff(repo: Repo): Promise<string[]> {
  const names = nulSplit(
    await git(repo.top, ['config', '-z', '--name-only', '--list'], { repo, config: HARDENED_CONFIG }).catch(() =>
      Buffer.alloc(0),
    ),
  );
  const drivers = new Set<string>();
  for (const name of names) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(name);
    if (match) drivers.add(match[1]);
  }
  return [...drivers].flatMap((d) =>
    [`filter.${d}.clean=`, `filter.${d}.smudge=`, `filter.${d}.process=`, `filter.${d}.required=false`].flatMap((c) => [
      '-c',
      c,
    ]),
  );
}

/** Git with hooks, fsmonitor, filters and signing off; the user's identity is left as configured. */
async function run(repo: Repo, args: string[], opts: GitOptions & { hooks?: boolean } = {}) {
  return withObservation('git.operation', 'git', {}, () => runUnobserved(repo, args, opts));
}
async function runUnobserved(repo: Repo, args: string[], opts: GitOptions & { hooks?: boolean } = {}) {
  const config = [
    ...(opts.hooks ? HARDENED_BASE : HARDENED_CONFIG),
    ...(await filtersOff(repo)),
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    '-c',
    'user.useConfigOnly=true',
  ];
  return git(repo.top, args, { timeoutMs: READ_TIMEOUT_MS, ...opts, repo, config });
}

const failure = (e: unknown) => {
  const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'));
  return (lines.slice(-4).join('\n') || (e instanceof Error ? e.message : String(e))).slice(0, 1500);
};

interface ParsedStatus {
  branch: string | null;
  head: string | null;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitFileEntry[];
}

/** Parses `git status --porcelain=v2 -z --branch`. Exported for tests. */
export function parseStatus(out: Buffer | string): ParsedStatus {
  const records = (typeof out === 'string' ? out : out.toString('utf8')).split('\0');
  const result: ParsedStatus = { branch: null, head: null, files: [] };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.head = value === '(initial)' ? null : value.slice(0, 12);
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = record[0];
    if (type === '?') {
      result.files.push({ path: record.slice(2), area: 'untracked', letter: '?' });
      continue;
    }
    if (type === '1' || type === '2') {
      // 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = record.split(' ');
      const xy = fields[1];
      const path = fields.slice(type === '1' ? 8 : 9).join(' ');
      const origPath = type === '2' ? records[++i] : undefined;
      if (xy[0] !== '.') result.files.push({ path, area: 'staged', letter: xy[0], ...(origPath ? { origPath } : {}) });
      if (xy[1] !== '.') result.files.push({ path, area: 'unstaged', letter: xy[1] });
      continue;
    }
    if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path: an unresolved conflict.
      result.files.push({ path: record.split(' ').slice(10).join(' '), area: 'unstaged', letter: 'U' });
    }
  }
  // Names that are not valid UTF-8 cannot be addressed safely by path: leave them out.
  result.files = result.files.filter((f) => !f.path.includes('\uFFFD') && !f.origPath?.includes('\uFFFD'));
  return result;
}

async function readStatus(repo: Repo) {
  return parseStatus(
    await run(repo, [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--renames',
      '--ignore-submodules=all',
    ]),
  );
}

/** Status for the panel; `blocked` and `runHooks` come from the caller (orchestrator, project). */
export async function gitStatus(project: Pick<Project, 'path' | 'git'>, blocked?: string): Promise<GitStatus> {
  const repo = await openRepo(project.path, false);
  if (!repo) return { repo: false, reason: NOT_GIT };
  const status = await readStatus(repo);
  const files = status.files.slice(0, STATUS_LISTED);
  return {
    repo: true,
    branch: status.branch,
    head: status.head,
    ...(status.upstream ? { upstream: status.upstream } : {}),
    ...(status.ahead !== undefined ? { ahead: status.ahead, behind: status.behind } : {}),
    files,
    ...(status.files.length > files.length ? { omitted: status.files.length - files.length } : {}),
    ...(blocked ? { blocked } : {}),
    runHooks: project.git?.runHooks === true,
  };
}

/** Cuts a diff at a line boundary below the cap, so a multi-byte character is never split. */
function capDiff(out: Buffer) {
  const truncated = out.length > LIMITS.diffBytes;
  const cut = truncated ? out.subarray(0, out.lastIndexOf(0x0a, LIMITS.diffBytes) + 1) : out;
  return { diff: cut.toString('utf8'), truncated };
}

const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=all',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** Diff of one listed file: the index (`staged`) or the working tree against the index. */
export async function gitDiff(project: Pick<Project, 'path'>, path: string, staged: boolean) {
  const repo = await projectRepo(project);
  const status = await readStatus(repo);
  const area = staged ? ['staged'] : ['unstaged', 'untracked'];
  const entry = status.files.find((f) => f.path === path && area.includes(f.area));
  if (!entry) throw GitPanelError.of('git.fileNotListed', undefined, 404);
  // Read at most one byte over the cap: a huge file never fills memory.
  const opts = { maxBytes: LIMITS.diffBytes + 1, truncate: true };
  let out: Buffer;
  if (entry.area === 'untracked') {
    const info = await lstat(join(repo.top, path)).catch(() => undefined);
    if (!info || (!info.isFile() && !info.isSymbolicLink())) return { path, staged, diff: '', truncated: false };
    out = await run(repo, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', path], { ...opts, okCodes: [1] });
  } else if (staged) {
    const paths = entry.origPath ? [entry.origPath, path] : [path];
    out = await run(repo, ['diff', '--cached', '-M', ...DIFF_FLAGS, '--', ...paths], opts);
  } else {
    out = await run(repo, ['diff', ...DIFF_FLAGS, '--', path], opts);
  }
  return { path, staged, ...capDiff(out) };
}

/** Last commits of HEAD (empty before the first commit). */
export async function gitLog(project: Pick<Project, 'path'>): Promise<GitCommitInfo[]> {
  const repo = await projectRepo(project);
  const head = await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1] });
  if (!head.toString().trim()) return [];
  const out = await run(repo, [
    'log',
    `-n${LOG_LIMIT}`,
    '-z',
    '--no-show-signature',
    '--no-color',
    '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI',
    'HEAD',
    '--',
  ]);
  return nulSplit(out).map((record) => {
    const [hash, short, subject, author, date] = record.replace(/^\n/, '').split('\x1f');
    return { hash, short, subject, author, date };
  });
}

/** Status entries matching `paths` in `areas`; any unknown path is a 400 (no arbitrary paths). */
function pick(files: GitFileEntry[], paths: string[], areas: GitFileEntry['area'][]) {
  const picked: GitFileEntry[] = [];
  for (const path of new Set(paths)) {
    const matches = files.filter((f) => f.path === path && areas.includes(f.area));
    if (!matches.length) throw GitPanelError.of('git.fileOutsideList', { path }, 400);
    picked.push(...matches);
  }
  return picked;
}

export async function gitStage(project: Pick<Project, 'path'>, input: { paths?: string[]; all?: boolean }) {
  const repo = await projectRepo(project);
  if (input.all) return void (await run(repo, ['add', '-A']).catch(rethrow));
  const status = await readStatus(repo);
  const entries = pick(status.files, input.paths ?? [], ['unstaged', 'untracked']);
  await run(repo, ['add', '-A', '--', ...new Set(entries.map((e) => e.path))]).catch(rethrow);
}

export async function gitUnstage(project: Pick<Project, 'path'>, input: { paths?: string[]; all?: boolean }) {
  const repo = await projectRepo(project);
  // `reset` (not `restore --staged`) also works before the first commit. It never moves HEAD.
  if (input.all) return void (await run(repo, ['reset', '-q']).catch(rethrow));
  const status = await readStatus(repo);
  const entries = pick(status.files, input.paths ?? [], ['staged']);
  const paths = entries.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path]));
  await run(repo, ['reset', '-q', '--', ...new Set(paths)]).catch(rethrow);
}

/**
 * Discards working-tree changes: tracked files go back to their staged (index) content and
 * untracked files are deleted. Staged content is never touched; a file with staged changes
 * too needs `mixed: true`. Conflicted files are refused.
 */
export async function gitDiscard(project: Pick<Project, 'path'>, input: { paths: string[]; mixed?: boolean }) {
  const repo = await projectRepo(project);
  const status = await readStatus(repo);
  const entries = pick(status.files, input.paths, ['unstaged', 'untracked']);
  const conflicted = entries.filter((e) => e.letter === 'U').map((e) => e.path);
  if (conflicted.length) throw GitPanelError.of('git.conflicted', { paths: conflicted.join(', ') });
  const staged = new Set(status.files.filter((f) => f.area === 'staged').map((f) => f.path));
  const mixed = entries.filter((e) => staged.has(e.path)).map((e) => e.path);
  if (mixed.length && !input.mixed) throw GitPanelError.of('git.mixed', { paths: mixed.join(', ') });
  const tracked = entries.filter((e) => e.area === 'unstaged').map((e) => e.path);
  const untracked = entries.filter((e) => e.area === 'untracked').map((e) => e.path);
  // Validate every untracked target first, so nothing is deleted when one of them is refused.
  const targets: string[] = [];
  for (const path of untracked) {
    const target = resolve(repo.top, path);
    if (!target.startsWith(repo.top + sep) || path.split('/').some((p) => p === '..' || p.toLowerCase() === '.git'))
      throw GitPanelError.of('git.invalidPath', { path }, 422);
    const info = await lstat(target).catch(() => undefined);
    if (info && !info.isFile() && !info.isSymbolicLink()) throw GitPanelError.of('git.onlyFiles', { path }, 422);
    targets.push(target);
  }
  if (tracked.length) await run(repo, ['restore', '--worktree', '--', ...tracked]).catch(rethrow);
  for (const target of targets) {
    await unlink(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await removeEmptyParents(repo.top, target);
  }
}

/** Creates a commit of the index with the user's identity. Hooks only when the project opted in. */
export async function gitCommit(project: Pick<Project, 'path' | 'git'>, message: string) {
  const repo = await projectRepo(project);
  for (const key of ['user.name', 'user.email']) {
    const value = await run(repo, ['config', '--get', key], { okCodes: [1] });
    if (!value.toString().trim()) throw GitPanelError.of('git.identity');
  }
  const status = await readStatus(repo);
  if (!status.files.some((f) => f.area === 'staged')) throw GitPanelError.of('git.nothingStaged');
  const hooks = project.git?.runHooks === true;
  await run(
    repo,
    ['commit', '-q', '--cleanup=whitespace', '--no-gpg-sign', ...(hooks ? [] : ['--no-verify']), '-F', '-'],
    {
      hooks,
      input: message,
      timeoutMs: PUSH_TIMEOUT_MS,
    },
  ).catch(rethrow);
  return (await run(repo, ['rev-parse', 'HEAD'])).toString().trim();
}

/** Keys in the repository's own config that make push run a program or redirect it. */
const PUSH_UNSAFE_LOCAL =
  /^(core\.(sshcommand|askpass|gitproxy)|credential\..*|remote\..+\.(receivepack|uploadpack|vcs)|url\..+\.(insteadof|pushinsteadof)|protocol\..+|http\..+)$/i;

/** Remote and branch the current branch tracks; undefined without an upstream. */
async function upstreamOf(repo: Repo) {
  const status = await readStatus(repo);
  if (!status.branch || !status.upstream) return undefined;
  const get = async (key: string) =>
    (await run(repo, ['config', '--get', key], { okCodes: [1] })).toString().trim() || undefined;
  const remote = await get(`branch.${status.branch}.remote`);
  const merge = await get(`branch.${status.branch}.merge`);
  if (!remote || remote === '.' || !merge?.startsWith('refs/heads/')) return undefined;
  return { branch: status.branch, remote, merge, upstream: status.upstream, ahead: status.ahead ?? 0 };
}

/** What a push would do, for the confirmation dialog; undefined without an upstream. */
export async function gitPushTarget(project: Pick<Project, 'path'>) {
  const target = await upstreamOf(await projectRepo(project));
  return target && { remote: target.remote, branch: target.branch, remoteBranch: target.merge.slice(11) };
}

/** `git push <remote> refs/heads/<branch>:<merge>`: never forced, no hooks, no prompts. */
export async function gitPush(project: Pick<Project, 'path'>) {
  const repo = await projectRepo(project);
  const target = await upstreamOf(repo);
  if (!target) throw GitPanelError.of('git.noUpstream');
  const scoped = nulSplit(
    await git(repo.top, ['config', '-z', '--show-scope', '--name-only', '--list'], { repo, config: HARDENED_CONFIG }),
  );
  const unsafe: string[] = [];
  for (let i = 0; i + 1 < scoped.length; i += 2)
    if ((scoped[i] === 'local' || scoped[i] === 'worktree') && PUSH_UNSAFE_LOCAL.test(scoped[i + 1]))
      unsafe.push(scoped[i + 1]);
  if (unsafe.length) throw GitPanelError.of('git.unsafeConfig', { keys: [...new Set(unsafe)].join(', ') });
  const sshCommand = (await run(repo, ['config', '--get', 'core.sshCommand'], { okCodes: [1] })).toString().trim();
  try {
    await run(
      repo,
      [
        'push',
        '--porcelain',
        '--no-verify',
        '--no-signed',
        '--no-follow-tags',
        '--recurse-submodules=no',
        target.remote,
        // No leading `+` and no configured refspecs: a push is never forced.
        `refs/heads/${target.branch}:${target.merge}`,
      ],
      {
        timeoutMs: PUSH_TIMEOUT_MS,
        // ssh must fail instead of asking for a passphrase or host confirmation.
        env: sshCommand ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
      },
    );
  } catch (e) {
    throw GitPanelError.of('git.pushFailed', { detail: failure(e) }, 502);
  }
  return { remote: target.remote, branch: target.branch, remoteBranch: target.merge.slice(11) };
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Compare page for a pull/merge request from an `origin` URL (https, ssh or scp-like form).
 * Only github.com and GitLab hosts; undefined otherwise. Credentials in the URL are dropped.
 */
export function compareUrl(remoteUrl: string, base: string | undefined, branch: string) {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(remoteUrl.trim());
  if (/^[a-z+]+:\/\//i.test(remoteUrl.trim())) {
    let url: URL;
    try {
      url = new URL(remoteUrl.trim());
    } catch {
      return undefined;
    }
    if (!['https:', 'http:', 'ssh:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) return undefined;
    host = url.hostname;
    path = url.pathname;
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else return undefined;
  host = host.toLowerCase();
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  if (!segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return undefined;
  const ref = (name: string) => name.split('/').map(encodeURIComponent).join('/');
  if (host === 'github.com' || host === 'www.github.com') {
    if (segments.length !== 2) return undefined;
    const range = base ? `${ref(base)}...${ref(branch)}` : ref(branch);
    return { provider: 'github' as const, url: `https://github.com/${segments.join('/')}/compare/${range}?expand=1` };
  }
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) {
    if (segments.length < 2) return undefined;
    const query = new URLSearchParams({ 'merge_request[source_branch]': branch });
    if (base) query.set('merge_request[target_branch]', base);
    return { provider: 'gitlab' as const, url: `https://${host}/${segments.join('/')}/-/merge_requests/new?${query}` };
  }
  return undefined;
}

/** Compare URL for the current branch against origin's default branch. */
export async function gitPullRequestUrl(project: Pick<Project, 'path'>) {
  const repo = await projectRepo(project);
  const status = await readStatus(repo);
  if (!status.branch) throw GitPanelError.of('git.detached');
  const origin = (await run(repo, ['config', '--get', 'remote.origin.url'], { okCodes: [1] })).toString().trim();
  if (!origin) throw GitPanelError.of('git.noOrigin');
  const head = (await run(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { okCodes: [1] }))
    .toString()
    .trim();
  let base = head.startsWith('origin/') ? head.slice(7) : undefined;
  for (const candidate of ['main', 'master']) {
    if (base) break;
    const found = await run(repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${candidate}`], {
      okCodes: [1],
    });
    if (found.toString().trim()) base = candidate;
  }
  if (base === status.branch) throw GitPanelError.of('git.defaultBranch', { base: base ?? '' });
  const result = compareUrl(origin, base, status.branch);
  if (!result) throw GitPanelError.of('git.unknownHost', undefined, 422);
  return { ...result, base: base ?? null, branch: status.branch };
}

function rethrow(e: unknown): never {
  if (e instanceof CheckpointError) throw e;
  throw new GitPanelError(failure(e), 409);
}
