// Isolated git worktree per conversation (docs/specs/worktrees.md). Every command goes through
// the hardened helper of server/checkpoints.ts (execFile, no shell, timeout, no prompts, hooks
// and fsmonitor off, inherited GIT_* dropped).
//
// Guarantees:
// - The worktree lives in `<dataDir>/worktrees/<sessionId>`, outside the user's repository.
// - Commands on the worktree use an explicit GIT_DIR (the admin folder found from the main
//   repository), never the worktree's `.git` file, which the agent can rewrite.
// - Conversation worktree `apply` merges only when the main checkout is clean and attached.
//   Automatic executor integration instead applies a checked patch against the captured snapshot,
//   retaining concurrent main-checkout changes and refusing overlapping hunks. Neither path
//   stages, resets, stashes or checks out the user's main working tree.
// - Hooks of every event, filters (clean/smudge/process) and custom merge drivers never run.
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { FileChange, Project, Session, SessionWorktree, WorktreeStatus } from '../shared/contracts.js';
import type { Locale, Vars } from '../shared/i18n.js';
import { tr, type ServerKey, type Translatable } from './i18n.js';
import {
  CheckpointError,
  LIMITS,
  SAFE_CONFIG,
  changedFiles,
  git,
  nulSplit,
  openRepo,
  writeSnapshotTree,
  type Repo,
} from './checkpoints.js';

export const BRANCH_PREFIX = 'adelic/';
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
  'pre-auto-gc',
  'post-rewrite',
  'post-index-change',
  'reference-transaction',
  'fsmonitor-watchman',
];
const ADELIC_IDENTITY = ['user.name=Adelic', 'user.email=adelic@localhost'];

/** SAFE_CONFIG without its fixed identity (worktree commits keep the user's when configured). */
function baseConfig() {
  const pairs: string[] = [];
  for (let i = 0; i < SAFE_CONFIG.length; i += 2) {
    const value = SAFE_CONFIG[i + 1];
    if (!value.startsWith('user.')) pairs.push(value);
  }
  return [
    ...pairs,
    ...HOOK_EVENTS.map((event) => `hook.${event}.enabled=false`),
    'submodule.recurse=false',
    'merge.autoStash=false',
    'rebase.autoStash=false',
    'rerere.enabled=false',
    'merge.verifySignatures=false',
    'core.editor=true',
  ];
}
const flat = (pairs: string[]) => pairs.flatMap((c) => ['-c', c]);

/** Config entries matching `pattern` (names only); empty when none. */
async function configNames(repo: Repo, pattern: string) {
  try {
    return nulSplit(
      await git(repo.top, ['config', '-z', '--name-only', '--get-regexp', pattern], {
        repo,
        config: flat(baseConfig()),
      }),
    );
  } catch {
    return []; // Exit 1: no match.
  }
}
async function configured(repo: Repo, key: string) {
  try {
    return (await git(repo.top, ['config', '--get', key], { repo, config: flat(baseConfig()) })).toString().trim();
  } catch {
    return '';
  }
}

/**
 * `-c` arguments for commands that read or write file contents: hooks off, every filter
 * driver neutralised (no external command), and the Adelic identity only when the repository
 * has none.
 */
async function hardened(repo: Repo, opts: { identity?: boolean } = {}) {
  const pairs = baseConfig();
  const filters = new Set(
    (await configNames(repo, '^filter\\.')).map((name) => name.slice('filter.'.length, name.lastIndexOf('.'))),
  );
  for (const name of filters)
    if (name) pairs.push(`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`);
  for (const name of filters) if (name) pairs.push(`filter.${name}.required=false`);
  // A custom merge driver is an external command: emptied, git reports that file as a conflict.
  for (const name of await configNames(repo, '^merge\\..*\\.driver$')) pairs.push(`${name}=`);
  if (opts.identity) {
    if (!(await configured(repo, 'user.name'))) pairs.push(ADELIC_IDENTITY[0]);
    if (!(await configured(repo, 'user.email'))) pairs.push(ADELIC_IDENTITY[1]);
  }
  return flat(pairs);
}

const fail = (reason: ServerKey | Translatable, status = 409, conflicts?: string[]) => {
  const { key, vars } = typeof reason === 'string' ? { key: reason, vars: undefined } : reason;
  return CheckpointError.of(key, vars, status, conflicts);
};
/** A reason in pt-BR (what the status fields held before) with its key, so routes can translate it. */
const why = (key: ServerKey, vars?: Vars): Translatable => ({ key, vars });

/**
 * The status texts (`reason`, `applyBlocked`) in `locale`. worktreeStatus fills them in pt-BR and
 * keeps the keys in `reasons`, which is dropped here.
 */
export function localizeStatus<T extends Partial<WorktreeStatus> & { reasons?: StatusReasons }>(
  status: T,
  locale?: Locale,
): Omit<T, 'reasons'> {
  const { reasons, ...rest } = status;
  if (!reasons || !locale) return rest;
  const out = { ...rest } as Partial<WorktreeStatus>;
  if (reasons.reason) out.reason = tr(locale, reasons.reason.key, reasons.reason.vars);
  if (reasons.applyBlocked) out.applyBlocked = tr(locale, reasons.applyBlocked.key, reasons.applyBlocked.vars);
  return out as Omit<T, 'reasons'>;
}
type StatusReasons = { reason?: Translatable; applyBlocked?: Translatable };
const pt = (reason: Translatable) => tr(undefined, reason.key, reason.vars);

/** True when a Git metadata entry exists in this folder or an ancestor. */
async function gitMetadataNearby(path: string): Promise<boolean | undefined> {
  let current: string;
  try {
    current = await realpath(path);
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      await lstat(join(current, '.git'));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Main repository of a project, when the project folder is the root of a work tree with a commit. */
export async function mainRepo(project: Project): Promise<{ repo?: Repo; reason?: Translatable }> {
  const repo = await openRepo(project.path, false);
  if (!repo) return { reason: why('worktrees.notRepo') };
  if (repo.root !== repo.top) return { reason: why('worktrees.notRoot') };

  // Bind the path identity to Git's own canonical metadata before trusting the repository.
  try {
    const identity = (await git(repo.top, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { repo }))
      .toString()
      .trim()
      .split(/\r?\n/);
    if (identity.length !== 2 || !identity[0] || !identity[1]) return { reason: why('worktrees.notRepo') };
    if ((await realpath(identity[0])) !== repo.top || (await realpath(identity[1])) !== (await realpath(repo.gitDir)))
      return { reason: why('worktrees.notRepo') };
  } catch {
    return { reason: why('worktrees.notRepo') };
  }

  try {
    await git(repo.top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { repo });
  } catch {
    return { reason: why('worktrees.noCommits') };
  }
  return { repo };
}

/**
 * Automatic worktree isolation is available only for a verified Git root. Serial fallback is
 * reserved for an existing folder with no Git metadata in its ancestry; damaged/inaccessible
 * metadata, nested workspaces and unborn or malformed HEADs remain blocked.
 */
export async function executorIsolation(
  project: Project,
): Promise<{ mode: 'worktree' } | { mode: 'serial'; reason: string } | { mode: 'blocked'; reason: string }> {
  const metadata = await gitMetadataNearby(project.path);
  if (metadata === false)
    return {
      mode: 'serial',
      reason: 'A pasta autorizada não contém metadados Git; execução serial direta, sem isolamento ou paralelismo.',
    };
  if (metadata === undefined)
    return { mode: 'blocked', reason: 'Não foi possível verificar a pasta autorizada e seus metadados Git.' };

  const { repo, reason } = await mainRepo(project);
  if (!repo) {
    if (reason?.key === 'worktrees.notRoot')
      return { mode: 'blocked', reason: 'A pasta autorizada está dentro de outro repositório Git; selecione a raiz.' };
    if (reason?.key === 'worktrees.noCommits')
      return {
        mode: 'blocked',
        reason: 'HEAD ausente ou inválido; execução serial não será habilitada para um repositório Git.',
      };
    return { mode: 'blocked', reason: 'Metadados Git inválidos ou inacessíveis; execução bloqueada.' };
  }
  try {
    const blocked = await mainBlocked(repo);
    if (blocked.reason && blocked.reason.key !== 'worktrees.dirty')
      return {
        mode: 'blocked',
        reason: 'A estrutura Git está em estado incompatível com isolamento automático.',
      };
    await assertSnapshotable(repo);
  } catch {
    return {
      mode: 'blocked',
      reason: 'O estado ou snapshot do repositório não pode ser verificado com segurança; execução bloqueada.',
    };
  }
  return { mode: 'worktree' };
}

/** `adelic/<8 chars of the id>-<slug of the title>`. */
export function branchName(sessionId: string, title: string) {
  const slug =
    title
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'conversa';
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'sessao';
  return `${BRANCH_PREFIX}${short}-${slug}`;
}

export function worktreeRoot(dataDir: string) {
  return join(resolve(dataDir), 'worktrees');
}

/**
 * The admin folder (`<common>/worktrees/<name>`) whose `gitdir` points at `path`. Read from the
 * main repository, which the agent cannot write, so a rewritten `.git` file is never followed.
 */
async function adminDir(main: Repo, path: string): Promise<string | undefined> {
  const common = (await git(main.top, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { repo: main }))
    .toString()
    .trim();
  const folder = join(common, 'worktrees');
  const entries = await readdir(folder).catch(() => [] as string[]);
  for (const entry of entries) {
    const pointer = await readFile(join(folder, entry, 'gitdir'), 'utf8').catch(() => '');
    if (pointer.trim() && resolve(join(folder, entry), pointer.trim()) === join(path, '.git'))
      return join(folder, entry);
  }
  return undefined;
}

async function exists(path: string) {
  return Boolean(await lstat(path).catch(() => undefined));
}

/** Creates the worktree and its branch from the main checkout's HEAD. */
export async function createWorktree(project: Project, session: Session, dataDir: string): Promise<SessionWorktree> {
  const { repo, reason } = await mainRepo(project);
  if (!repo) throw fail(why('worktrees.cannotCreate', { reason: pt(reason!) }));
  const parent = worktreeRoot(dataDir);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  // Inside the repository the copy would show up in the user's tree.
  if (realParent === repo.top || realParent.startsWith(repo.top + sep)) throw fail('worktrees.dataInsideRepo');
  const path = join(realParent, session.id);
  if (!/^[\w-]{1,128}$/.test(session.id)) throw fail('worktrees.invalidSessionId', 400);
  if (await exists(path)) throw fail('worktrees.folderExists');
  const base = (await git(repo.top, ['rev-parse', '--verify', 'HEAD^{commit}'], { repo })).toString().trim();
  let branch = branchName(session.id, session.title);
  for (let n = 2; n < 10; n++) {
    const taken = await git(repo.top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { repo }).then(
      () => true,
      () => false,
    );
    if (!taken) break;
    branch = `${branchName(session.id, session.title)}-${n}`;
  }
  await git(repo.top, ['check-ref-format', '--branch', branch], { repo });
  await git(repo.top, ['worktree', 'add', '--quiet', '-b', branch, path, base], {
    repo,
    config: await hardened(repo),
  });
  return { path, branch, base, createdAt: new Date().toISOString() };
}

interface Opened {
  main: Repo;
  /** Undefined when the folder or its admin entry is gone. */
  tree?: Repo;
}
async function openWorktree(project: Project, worktree: SessionWorktree): Promise<Opened> {
  const main = await openRepo(project.path, false);
  if (!main) throw fail('worktrees.repoGone', 410);
  const admin = await adminDir(main, worktree.path);
  if (!admin || !(await exists(worktree.path))) return { main };
  return { main, tree: { root: worktree.path, top: worktree.path, gitDir: admin, format: main.format } };
}

async function branchTip(main: Repo, branch: string) {
  return (await git(main.top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { repo: main }))
    .toString()
    .trim();
}
async function isAncestor(main: Repo, commit: string, of: string) {
  return git(main.top, ['merge-base', '--is-ancestor', commit, of], { repo: main }).then(
    () => true,
    () => false,
  );
}

/** Why the main checkout cannot take a merge now (dirty, detached, operation in progress), if so. */
export async function mainBlocked(main: Repo): Promise<{ reason?: Translatable; branch?: string }> {
  const branch = await git(main.top, ['symbolic-ref', '-q', '--short', 'HEAD'], { repo: main }).then(
    (b) => b.toString().trim(),
    () => '',
  );
  if (!branch) return { reason: why('worktrees.detached') };
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
    if (await exists(join(main.gitDir, marker))) return { branch, reason: why('worktrees.gitOperation') };
  const status = nulSplit(
    await git(main.top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'], {
      repo: main,
      config: await hardened(main),
    }),
  );
  if (status.length) {
    const files = status.map((entry) => entry.slice(3)).filter(Boolean);
    const shown = files.slice(0, 5).join(', ');
    return {
      branch,
      reason: why('worktrees.dirty', { files: `${shown}${files.length > 5 ? ', …' : ''}` }),
    };
  }
  return { branch };
}

async function snapshot(tree: Repo, base: string) {
  const id = await writeSnapshotTree(tree);
  const changes = await changedFiles(tree, base, id);
  return { id, changes };
}

/** Panel data: branch, files changed against `base` (uncommitted included), merge state. */
export async function worktreeStatus(
  project: Project,
  worktree: SessionWorktree,
): Promise<WorktreeStatus & { reasons?: StatusReasons }> {
  const { main, tree } = await openWorktree(project, worktree);
  const result: WorktreeStatus & { reasons?: StatusReasons } = {
    enabled: true,
    available: true,
    worktree,
    exists: Boolean(tree),
  };
  const tip = await branchTip(main, worktree.branch).catch(() => '');
  if (tip) {
    result.commits = Number(
      (await git(main.top, ['rev-list', '--count', `${worktree.base}..${tip}`], { repo: main })).toString().trim(),
    );
    result.merged = await isAncestor(main, tip, 'HEAD');
    result.branchMerged = result.merged;
  }
  if (tree) {
    try {
      const { id, changes } = await snapshot(tree, worktree.base);
      const files = changes.slice(0, LIMITS.listed).map(listed);
      result.files = files;
      if (changes.length > files.length) result.omitted = changes.length - files.length;
      result.dirty = tip
        ? (await git(main.top, ['rev-parse', `${tip}^{tree}`], { repo: main })).toString().trim() !== id
        : true;
      if (result.dirty) result.merged = false;
    } catch (e) {
      result.reason = e instanceof Error ? e.message : String(e);
    }
  }
  const blocked = await mainBlocked(main);
  if (blocked.branch) result.mainBranch = blocked.branch;
  const applyBlocked = !tree
    ? why('worktrees.folderGoneDiscard')
    : blocked.reason
      ? blocked.reason
      : !result.dirty && !result.commits
        ? why('worktrees.nothingToApply')
        : !result.dirty && result.merged
          ? why('worktrees.alreadyApplied')
          : undefined;
  if (applyBlocked) {
    result.applyBlocked = pt(applyBlocked);
    result.reasons = { applyBlocked };
  }
  return result;
}
const listed = ({ path, status, additions, deletions, binary }: FileChange): FileChange => ({
  path,
  status,
  additions,
  deletions,
  ...(binary ? { binary } : {}),
});

/** Unified diff of one changed file against `base`, bounded like the checkpoint diffs. */
export async function worktreeDiff(project: Project, worktree: SessionWorktree, path: string) {
  const { tree } = await openWorktree(project, worktree);
  if (!tree) throw fail('worktrees.folderGone', 410);
  const { id, changes } = await snapshot(tree, worktree.base);
  if (!changes.some((c) => c.path === path)) throw fail('worktrees.fileNotChanged', 404);
  const out = await git(
    tree.top,
    [
      'diff-tree',
      '-p',
      '-r',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      worktree.base,
      id,
      '--',
      path,
    ],
    { repo: tree, maxBytes: 64 * 1024 * 1024 },
  );
  const truncated = out.length > LIMITS.diffBytes;
  const cut = truncated ? out.subarray(0, out.lastIndexOf(0x0a, LIMITS.diffBytes) + 1) : out;
  return { path, diff: cut.toString('utf8'), truncated };
}

/**
 * "Aplicar no projeto": commits what is pending in the worktree, then merges the branch into
 * the main checkout with `--no-ff`, only when it is clean and on a branch. On conflict the merge
 * is aborted, so the main checkout is back where it was, and the files are reported.
 */
export async function applyWorktree(project: Project, worktree: SessionWorktree, title: string) {
  const { main, tree } = await openWorktree(project, worktree);
  if (!tree) throw fail('worktrees.folderGoneDiscard');
  const blocked = await mainBlocked(main);
  if (blocked.reason) throw fail(blocked.reason);
  const status = await worktreeStatus(project, worktree);
  if (status.reason) throw new CheckpointError(status.reason, 422);
  if (status.dirty) {
    const config = await hardened(main, { identity: true });
    await git(tree.top, ['add', '-A', '--', '.'], { repo: tree, config });
    await git(tree.top, ['commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', `Adelic: ${title}`], {
      repo: tree,
      config,
    });
  } else if (!status.commits) throw fail('worktrees.nothingToApply');
  const tip = await branchTip(main, worktree.branch);
  if (await isAncestor(main, tip, 'HEAD')) throw fail('worktrees.alreadyApplied');
  const head = (await git(main.top, ['rev-parse', 'HEAD'], { repo: main })).toString().trim();
  // Checked again right before the merge: the user may have edited the project meanwhile.
  const again = await mainBlocked(main);
  if (again.reason) throw fail(again.reason);
  // git overwrites ignored files without asking; refuse when the branch adds one that exists.
  const added = nulSplit(
    await git(main.top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', head, tip], {
      repo: main,
    }),
  );
  const present: string[] = [];
  for (const path of added) if (await exists(join(main.top, path))) present.push(path);
  if (present.length) throw fail('worktrees.ignoredFiles', 409, present);
  const config = await hardened(main, { identity: true });
  try {
    await git(
      main.top,
      [
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-verify',
        '--no-autostash',
        '-m',
        `Merge branch '${worktree.branch}' (Adelic)`,
        tip,
      ],
      {
        repo: main,
        config,
      },
    );
  } catch (e) {
    const merging = await exists(join(main.gitDir, 'MERGE_HEAD'));
    const conflicts = merging
      ? nulSplit(await git(main.top, ['diff', '--name-only', '-z', '--diff-filter=U'], { repo: main, config }))
      : [];
    if (merging) await git(main.top, ['merge', '--abort'], { repo: main, config });
    if (conflicts.length) throw fail(why('worktrees.conflicts', { count: conflicts.length }), 409, conflicts);
    throw fail(why('worktrees.mergeRefused', { detail: e instanceof Error ? e.message : String(e) }));
  }
  const commit = (await git(main.top, ['rev-parse', 'HEAD'], { repo: main })).toString().trim();
  return { commit, previous: head, branch: blocked.branch! };
}

/**
 * Removes the worktree folder and its admin entry. The branch is deleted only when it is
 * merged into the main checkout's HEAD or `deleteBranch` is set. A folder git refuses to
 * remove (a rewritten `.git`) is deleted directly: it is always below `<dataDir>/worktrees`.
 */
export async function removeWorktree(
  project: Project | undefined,
  worktree: SessionWorktree,
  dataDir: string,
  opts: { deleteBranch?: boolean } = {},
) {
  const parent = await realpath(worktreeRoot(dataDir)).catch(() => worktreeRoot(dataDir));
  const ours = dirname(worktree.path) === parent && basename(worktree.path) !== '';
  const main = project ? await openRepo(project.path, false) : undefined;
  if (main) {
    const config = await hardened(main);
    if (await exists(worktree.path))
      await git(main.top, ['worktree', 'remove', '--force', worktree.path], { repo: main, config }).catch(
        () => undefined,
      );
    if (ours && (await exists(worktree.path))) await rm(worktree.path, { recursive: true, force: true });
    // The admin entry of a folder that is gone (only this one, never the user's other worktrees).
    if (await adminDir(main, worktree.path))
      await git(main.top, ['worktree', 'remove', '--force', worktree.path], { repo: main, config }).catch(
        () => undefined,
      );
  } else if (ours) await rm(worktree.path, { recursive: true, force: true });
  let branchDeleted = false;
  if (main && worktree.branch.startsWith(BRANCH_PREFIX)) {
    const tip = await branchTip(main, worktree.branch).catch(() => '');
    if (tip && (opts.deleteBranch || (await isAncestor(main, tip, 'HEAD')))) {
      // Fails when the user checked the branch out somewhere: then it stays.
      branchDeleted = await git(main.top, ['branch', '-D', '--', worktree.branch], {
        repo: main,
        config: flat(baseConfig()),
      }).then(
        () => true,
        () => false,
      );
    }
  }
  return { removed: !(await exists(worktree.path)), branchDeleted, branch: worktree.branch };
}

/** True when the recorded folder is gone (startup pruning). */
export async function worktreeMissing(worktree: SessionWorktree) {
  return !(await exists(join(worktree.path, '.git')));
}

/**
 * Executor workspaces are based on a bounded snapshot of tracked and non-ignored untracked
 * files. Ignored files, credentials excluded by Git and the user's index are never copied.
 */
async function assertSnapshotable(repo: Repo) {
  const paths = nulSplit(
    await git(repo.root, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard'], { repo }),
  );
  for (const path of paths) {
    const info = await lstat(join(repo.top, path)).catch(() => undefined);
    if (info?.isDirectory())
      throw new CheckpointError(`snapshot de submódulo ou repositório aninhado não suportado: ${path}`, 422);
    if (info && !info.isFile() && !info.isSymbolicLink())
      throw new CheckpointError(`tipo de arquivo não suportado no snapshot: ${path}`, 422);
  }
}

async function executorRepo(project: Project) {
  const { repo, reason } = await mainRepo(project);
  if (!repo) throw fail(why('worktrees.cannotCreate', { reason: pt(reason!) }));
  const blocked = await mainBlocked(repo);
  if (blocked.reason && blocked.reason.key !== 'worktrees.dirty') throw fail(blocked.reason);
  return repo;
}

export async function executorWorktreesAvailable(project: Project) {
  try {
    await executorRepo(project);
    return true;
  } catch {
    return false;
  }
}

export async function createExecutorWorktree(project: Project, task: { id: string; title: string }, dataDir: string) {
  const repo = await executorRepo(project);
  await assertSnapshotable(repo);
  const snapshotTree = await writeSnapshotTree(repo);
  const worktree = await createWorktree(project, { id: task.id, title: task.title } as Session, dataDir);
  try {
    const baseTree = (await git(repo.top, ['rev-parse', `${worktree.base}^{tree}`], { repo })).toString().trim();
    const patch = await git(
      repo.top,
      ['diff-tree', '--no-commit-id', '-p', '-r', '--binary', '--no-renames', baseTree, snapshotTree],
      {
        repo,
        config: await hardened(repo),
      },
    );
    if (patch.length) {
      const opened = await openWorktree(project, worktree);
      if (!opened.tree) throw fail('worktrees.folderGoneDiscard', 409);
      await git(opened.tree.top, ['apply', '--binary', '-'], {
        repo: opened.tree,
        input: patch,
        config: await hardened(opened.tree),
      });
    }
    return { ...worktree, snapshotTree };
  } catch (error) {
    await removeWorktree(project, worktree, dataDir);
    throw error;
  }
}

/** Changed files owned by an executor task, measured against its captured initial tree. */
export async function inspectExecutorWorktree(project: Project, worktree: SessionWorktree): Promise<FileChange[]> {
  const opened = await openWorktree(project, worktree);
  if (!opened.tree) throw fail('worktrees.folderGoneDiscard', 409);
  const baseline =
    worktree.snapshotTree ??
    (await git(opened.main.top, ['rev-parse', `${worktree.base}^{tree}`], { repo: opened.main })).toString().trim();
  await assertSnapshotable(opened.tree);
  // Match integration: retain captured paths even if task changes .gitignore, while never
  // introducing ignored files that were absent from the task's initial snapshot.
  const baselinePaths = nulSplit(
    await git(opened.tree.top, ['ls-tree', '-r', '-z', '--name-only', baseline], { repo: opened.tree }),
  );
  const after = await writeSnapshotTree(opened.tree, { includePaths: baselinePaths });
  return changedFiles(opened.tree, baseline, after);
}

/** Integrates only the executor's delta from its creation snapshot onto the current main tree. */
export async function integrateExecutorWorktree(project: Project, worktree: SessionWorktree) {
  const opened = await openWorktree(project, worktree);
  if (!opened.tree) throw fail('worktrees.folderGoneDiscard', 409);
  const blocked = await mainBlocked(opened.main);
  if (blocked.reason && blocked.reason.key !== 'worktrees.dirty') throw fail(blocked.reason);
  const baseline =
    worktree.snapshotTree ??
    (await git(opened.main.top, ['rev-parse', `${worktree.base}^{tree}`], { repo: opened.main })).toString().trim();
  await assertSnapshotable(opened.tree);
  // The baseline contains only tracked and eligible non-ignored files captured for this task.
  // Keep those paths in the final tree even if the task's .gitignore now hides them; files
  // deleted from disk remain absent, and files originally ignored were never in this list.
  const baselinePaths = nulSplit(
    await git(opened.tree.top, ['ls-tree', '-r', '-z', '--name-only', baseline], { repo: opened.tree }),
  );
  const after = await writeSnapshotTree(opened.tree, { includePaths: baselinePaths });
  const patch = await git(
    opened.tree.top,
    ['diff-tree', '--no-commit-id', '-p', '-r', '--binary', '--no-renames', baseline, after],
    {
      repo: opened.tree,
      config: await hardened(opened.tree),
    },
  );
  if (!patch.length) return { changed: false, files: [] as string[] };
  const changes = await changedFiles(opened.tree, baseline, after);
  const names = changes.map((file) => file.path);
  const config = await hardened(opened.main);
  // First recognize an exact prior application. This must precede the added-file collision
  // guard: an added path that now contains the patch's exact contents is recovery, not a clash.
  // Reverse --check validates the whole patch (including created/deleted files) without writing.
  const alreadyApplied = await git(opened.main.top, ['apply', '--binary', '--reverse', '--check', '-'], {
    repo: opened.main,
    input: patch,
    config,
  }).then(
    () => true,
    () => false,
  );
  if (alreadyApplied) return { changed: false, alreadyApplied: true, files: names };

  // Never let an added task file replace a file that appeared in the main checkout after capture
  // (notably an ignored secret, which Git's ordinary status does not report). A differing file
  // cannot pass reverse --check above, so it remains a real collision.
  const collisions: string[] = [];
  for (const file of changes)
    if (file.status === 'added' && (await exists(join(opened.main.top, file.path)))) collisions.push(file.path);
  if (collisions.length) throw fail('worktrees.ignoredFiles', 409, collisions);

  await git(opened.main.top, ['apply', '--binary', '--check', '-'], { repo: opened.main, input: patch, config });
  await git(opened.main.top, ['apply', '--binary', '-'], { repo: opened.main, input: patch, config });
  return { changed: true, alreadyApplied: false, files: names };
}

/** git worktree prune in the project's repository: drops admin entries of missing folders. */
export async function pruneRepo(project: Project) {
  const main = await openRepo(project.path, false);
  if (!main) return;
  await git(main.top, ['worktree', 'prune'], { repo: main, config: flat(baseConfig()) });
}
