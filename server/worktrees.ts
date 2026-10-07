// Isolated git worktree per conversation (docs/specs/worktrees.md). Every command goes through
// the hardened helper of server/checkpoints.ts (execFile, no shell, timeout, no prompts, hooks
// and fsmonitor off, inherited GIT_* dropped).
//
// Guarantees:
// - The worktree lives in `<dataDir>/worktrees/<sessionId>`, outside the user's repository.
// - Commands on the worktree use an explicit GIT_DIR (the admin folder found from the main
//   repository), never the worktree's `.git` file, which the agent can rewrite.
// - The main checkout is only read (status with GIT_OPTIONAL_LOCKS=0), except by `apply`:
//   `git merge --no-ff` when it is clean and on a branch, and `git merge --abort` on conflict.
//   Nothing is ever stashed, reset or checked out there.
// - Hooks of every event, filters (clean/smudge/process) and custom merge drivers never run.
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { FileChange, Project, Session, SessionWorktree, WorktreeStatus } from '../shared/contracts.js';
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

const fail = (message: string, status = 409, conflicts?: string[]) => new CheckpointError(message, status, conflicts);

/** Main repository of a project, when the project folder is the root of a work tree with a commit. */
export async function mainRepo(project: Project): Promise<{ repo?: Repo; reason?: string }> {
  const repo = await openRepo(project.path, false);
  if (!repo) return { reason: 'a pasta do projeto não é um repositório git' };
  if (repo.root !== repo.top) return { reason: 'a pasta do projeto não é a raiz do repositório git' };
  try {
    await git(repo.top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { repo });
  } catch {
    return { reason: 'o repositório ainda não tem commits' };
  }
  return { repo };
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
  if (!repo) throw fail(`Não é possível criar uma cópia isolada: ${reason}`);
  const parent = worktreeRoot(dataDir);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  // Inside the repository the copy would show up in the user's tree.
  if (realParent === repo.top || realParent.startsWith(repo.top + sep))
    throw fail('A pasta de dados do Adelic fica dentro do repositório; a cópia isolada poluiria o projeto');
  const path = join(realParent, session.id);
  if (!/^[\w-]{1,128}$/.test(session.id)) throw fail('Identificador de conversa inválido', 400);
  if (await exists(path)) throw fail('Já existe uma pasta de cópia isolada para esta conversa');
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
  if (!main) throw fail('O repositório do projeto não existe mais', 410);
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
export async function mainBlocked(main: Repo): Promise<{ reason?: string; branch?: string }> {
  const branch = await git(main.top, ['symbolic-ref', '-q', '--short', 'HEAD'], { repo: main }).then(
    (b) => b.toString().trim(),
    () => '',
  );
  if (!branch) return { reason: 'O projeto não está em um branch (HEAD destacado); faça checkout de um branch antes' };
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
    if (await exists(join(main.gitDir, marker)))
      return { branch, reason: 'Há uma operação do git em andamento no projeto (merge, rebase ou cherry-pick)' };
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
      reason: `O projeto tem alterações não commitadas (${shown}${files.length > 5 ? ', …' : ''}); faça commit ou guarde-as antes de aplicar`,
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
export async function worktreeStatus(project: Project, worktree: SessionWorktree): Promise<WorktreeStatus> {
  const { main, tree } = await openWorktree(project, worktree);
  const result: WorktreeStatus = { enabled: true, available: true, worktree, exists: Boolean(tree) };
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
  if (!tree) result.applyBlocked = 'A pasta da cópia isolada não existe mais; descarte-a';
  else if (blocked.reason) result.applyBlocked = blocked.reason;
  else if (!result.dirty && !result.commits) result.applyBlocked = 'Não há alterações para aplicar';
  else if (!result.dirty && result.merged) result.applyBlocked = 'As alterações já estão no projeto';
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
  if (!tree) throw fail('A pasta da cópia isolada não existe mais', 410);
  const { id, changes } = await snapshot(tree, worktree.base);
  if (!changes.some((c) => c.path === path)) throw fail('Arquivo não foi alterado nesta cópia', 404);
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
  if (!tree) throw fail('A pasta da cópia isolada não existe mais; descarte-a');
  const blocked = await mainBlocked(main);
  if (blocked.reason) throw fail(blocked.reason);
  const status = await worktreeStatus(project, worktree);
  if (status.reason) throw fail(status.reason, 422);
  if (status.dirty) {
    const config = await hardened(main, { identity: true });
    await git(tree.top, ['add', '-A', '--', '.'], { repo: tree, config });
    await git(tree.top, ['commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', `Adelic: ${title}`], {
      repo: tree,
      config,
    });
  } else if (!status.commits) throw fail('Não há alterações para aplicar');
  const tip = await branchTip(main, worktree.branch);
  if (await isAncestor(main, tip, 'HEAD')) throw fail('As alterações já estão no projeto');
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
  if (present.length)
    throw fail(
      'O branch cria arquivos que já existem no projeto (ignorados pelo git); mova-os antes de aplicar',
      409,
      present,
    );
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
    if (conflicts.length)
      throw fail(
        `Conflito ao aplicar ${conflicts.length === 1 ? 'um arquivo' : `${conflicts.length} arquivos`}; o merge foi desfeito e o projeto ficou como estava.`,
        409,
        conflicts,
      );
    throw fail(`O git recusou o merge; o projeto não foi alterado (${e instanceof Error ? e.message : String(e)})`);
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

/** `git worktree prune` in the project's repository: drops admin entries of missing folders. */
export async function pruneRepo(project: Project) {
  const main = await openRepo(project.path, false);
  if (!main) return;
  await git(main.top, ['worktree', 'prune'], { repo: main, config: flat(baseConfig()) });
}
