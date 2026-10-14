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
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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

/** Budget contract shared by coordinated executor preparation and integration. */
export interface WorktreeBudget {
  deadlineAt?: string;
  reserveMs?: number;
  signal?: AbortSignal;
}
function workDeadline(opts: WorktreeBudget = {}) {
  if (opts.signal?.aborted) {
    const error = new Error(
      opts.signal.reason instanceof Error ? opts.signal.reason.message : 'Worktree operation cancelled',
    );
    error.name = 'AbortError';
    throw error;
  }
  if (!opts.deadlineAt) return undefined;
  const parsed = Date.parse(opts.deadlineAt);
  if (!Number.isFinite(parsed)) throw new Error('Invalid worktree deadline');
  const deadline = parsed - Math.max(0, opts.reserveMs ?? 0);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Worktree preparation deadline exceeded');
  return Math.max(1, remaining);
}
function budgetGit(opts: WorktreeBudget = {}) {
  return { timeoutMs: workDeadline(opts), signal: opts.signal };
}
function budgetDeadlineAt(opts: WorktreeBudget = {}) {
  if (!opts.deadlineAt) return undefined;
  return new Date(Date.parse(opts.deadlineAt) - Math.max(0, opts.reserveMs ?? 0)).toISOString();
}

/** Config entries matching `pattern` (names only); empty when none. */
async function configNames(repo: Repo, pattern: string, budget: WorktreeBudget = {}) {
  try {
    return nulSplit(
      await git(repo.top, ['config', '-z', '--name-only', '--get-regexp', pattern], {
        repo,
        config: flat(baseConfig()),
        ...budgetGit(budget),
      }),
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return []; // Exit 1: no match.
    throw error;
  }
}
async function configured(repo: Repo, key: string, budget: WorktreeBudget = {}) {
  try {
    return (await git(repo.top, ['config', '--get', key], { repo, config: flat(baseConfig()), ...budgetGit(budget) }))
      .toString()
      .trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return '';
    throw error;
  }
}

/**
 * `-c` arguments for commands that read or write file contents: hooks off, every filter
 * driver neutralised (no external command), and the Adelic identity only when the repository
 * has none.
 */
async function hardened(repo: Repo, opts: WorktreeBudget & { identity?: boolean } = {}) {
  const pairs = baseConfig();
  const filters = new Set(
    (await configNames(repo, '^filter\\.', opts)).map((name) => name.slice('filter.'.length, name.lastIndexOf('.'))),
  );
  for (const name of filters)
    if (name) pairs.push(`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`);
  for (const name of filters) if (name) pairs.push(`filter.${name}.required=false`);
  // A custom merge driver is an external command: emptied, git reports that file as a conflict.
  for (const name of await configNames(repo, '^merge\\..*\\.driver$', opts)) pairs.push(`${name}=`);
  if (opts.identity) {
    if (!(await configured(repo, 'user.name', opts))) pairs.push(ADELIC_IDENTITY[0]);
    if (!(await configured(repo, 'user.email', opts))) pairs.push(ADELIC_IDENTITY[1]);
  }
  return flat(pairs);
}

const fail = (reason: ServerKey | Translatable, status = 409, conflicts?: string[]) => {
  const { key, vars } = typeof reason === 'string' ? { key: reason, vars: undefined } : reason;
  return CheckpointError.of(key, vars, status, conflicts);
};
type RecoveryStage = SessionWorktree & {
  /** Explicit persisted state: a worktree was created, but baseline preparation did not finish. */
  preparationFailed?: boolean;
  executionStarted?: boolean;
};
const preparationFailed = (worktree: SessionWorktree) => (worktree as RecoveryStage).preparationFailed === true;
const requireWorktreeOwnership = (worktree: SessionWorktree) => {
  if (worktree.ownershipVerified !== true || !ownershipNonce(worktree))
    throw new Error(
      'Propriedade/continuidade da worktree não comprovada; conteúdo e recursos foram preservados para inspeção.',
    );
};
const requireTaskReady = (worktree: SessionWorktree) => {
  requireWorktreeOwnership(worktree);
  if (preparationFailed(worktree))
    throw new Error(
      'Preparação da worktree incompleta; baseline parcial não pode ser inspecionado ou aplicado como entrega.',
    );
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
export async function mainRepo(
  project: Project,
  budget: WorktreeBudget = {},
): Promise<{ repo?: Repo; reason?: Translatable }> {
  const repo = await openRepo(project.path, false, budgetGit(budget));
  if (!repo) return { reason: why('worktrees.notRepo') };
  if (repo.root !== repo.top) return { reason: why('worktrees.notRoot') };

  // Bind the path identity to Git's own canonical metadata before trusting the repository.
  try {
    const identity = (
      await git(repo.top, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { repo, ...budgetGit(budget) })
    )
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
    await git(repo.top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { repo, ...budgetGit(budget) });
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
  budget: WorktreeBudget = {},
): Promise<{ mode: 'worktree' } | { mode: 'serial'; reason: string } | { mode: 'blocked'; reason: string }> {
  const metadata = await gitMetadataNearby(project.path);
  if (metadata === false)
    return {
      mode: 'serial',
      reason: 'A pasta autorizada não contém metadados Git; execução serial direta, sem isolamento ou paralelismo.',
    };
  if (metadata === undefined)
    return { mode: 'blocked', reason: 'Não foi possível verificar a pasta autorizada e seus metadados Git.' };

  let main: Awaited<ReturnType<typeof mainRepo>>;
  try {
    main = await mainRepo(project, budget);
  } catch (error) {
    return { mode: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  }
  const { repo, reason } = main;
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
    const blocked = await mainBlocked(repo, budget);
    if (blocked.reason && blocked.reason.key !== 'worktrees.dirty')
      return {
        mode: 'blocked',
        reason: 'A estrutura Git está em estado incompatível com isolamento automático.',
      };
    await assertSnapshotable(repo, budget);
  } catch {
    return {
      mode: 'blocked',
      reason: 'O estado ou snapshot do repositório não pode ser verificado com segurança; execução bloqueada.',
    };
  }
  workDeadline(budget);
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
async function adminDir(main: Repo, path: string, budget: WorktreeBudget = {}): Promise<string | undefined> {
  const common = (
    await git(main.top, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      repo: main,
      ...budgetGit(budget),
    })
  )
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

const OWNERSHIP_MARKER = 'adelic-ownership';
function ownershipNonce(worktree: SessionWorktree) {
  const prefix = 'refs/adelic/recovery-intents/';
  if (!worktree.ownershipProofRef?.startsWith(prefix)) return undefined;
  const nonce = worktree.ownershipProofRef.slice(prefix.length);
  return /^[0-9a-f-]{36}$/.test(nonce) ? nonce : undefined;
}
async function hasOwnershipMarker(admin: string | undefined, worktree: SessionWorktree) {
  const nonce = ownershipNonce(worktree);
  if (!admin || !nonce) return false;
  const marker = join(admin, OWNERSHIP_MARKER);
  const info = await lstat(marker).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  return (await readFile(marker, 'utf8').catch(() => '')).trim() === nonce;
}

/** Creates the worktree and its branch from the main checkout's HEAD. */
export async function createWorktree(
  project: Project,
  session: Session,
  dataDir: string,
  budget: WorktreeBudget = {},
): Promise<SessionWorktree> {
  workDeadline(budget);
  const { repo, reason } = await mainRepo(project, budget);
  if (!repo) throw fail(why('worktrees.cannotCreate', { reason: pt(reason!) }));
  const parent = worktreeRoot(dataDir);
  workDeadline(budget);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  // Inside the repository the copy would show up in the user's tree.
  if (realParent === repo.top || realParent.startsWith(repo.top + sep)) throw fail('worktrees.dataInsideRepo');
  const path = join(realParent, session.id);
  if (!/^[\w-]{1,128}$/.test(session.id)) throw fail('worktrees.invalidSessionId', 400);
  if (await exists(path)) throw fail('worktrees.folderExists');
  const base = (await git(repo.top, ['rev-parse', '--verify', 'HEAD^{commit}'], { repo, ...budgetGit(budget) }))
    .toString()
    .trim();
  let branch = branchName(session.id, session.title);
  for (let n = 2; n < 10; n++) {
    const taken = await git(repo.top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], {
      repo,
      ...budgetGit(budget),
    }).then(
      () => true,
      (error) => {
        if ((error as { code?: unknown }).code === 1) return false;
        throw error;
      },
    );
    if (!taken) break;
    branch = `${branchName(session.id, session.title)}-${n}`;
  }
  await git(repo.top, ['check-ref-format', '--branch', branch], { repo, ...budgetGit(budget) });
  // Every producer (session and executor) records a unique continuation capability. Legacy
  // records without this creation-bound proof remain uncertain and are never promoted.
  const ownershipProofRef = `refs/adelic/recovery-intents/${randomUUID()}`;
  if (ownershipProofRef) {
    const zero = '0'.repeat(base.length);
    await git(repo.top, ['update-ref', ownershipProofRef, base, zero], {
      repo,
      config: flat(baseConfig()),
      ...budgetGit(budget),
    });
  }
  let worktreeCreatedByCall = false;
  let ownershipMarkerWritten = false;
  try {
    await git(repo.top, ['worktree', 'add', '--quiet', '-b', branch, path, base], {
      repo,
      config: await hardened(repo, budget),
      ...budgetGit(budget),
    });
    worktreeCreatedByCall = true;
    if (ownershipProofRef) {
      const admin = await adminDir(repo, path, budget);
      if (!admin) throw new Error('AdminDir ausente após criação da worktree.');
      await writeFile(
        join(admin, OWNERSHIP_MARKER),
        ownershipProofRef.slice('refs/adelic/recovery-intents/'.length) + '\n',
        { flag: 'wx' },
      );
      ownershipMarkerWritten = true;
    }
    // The unique admin-directory marker records continuity of this exact Git checkout.
    // The intent ref remains CAS evidence, but path/branch/base/AdminDir coincidence alone
    // never authorizes a later occupant.
  } catch (error) {
    // Finalization gets only the original reserved tail; each command and discovery query is
    // bounded by the same absolute hard deadline. If it cannot prove ownership or finish, leave
    // the resource in place for recovery rather than guessing from a branch name.
    const cleanupStarted = Date.now();
    // The failed/cancelled writer has settled. Finalization intentionally ignores the already
    // observed abort signal, but remains bounded by the original absolute deadline and can use
    // only the reserved tail; if that window is gone, all unverified resources are preserved.
    const cleanupBudget: WorktreeBudget = { deadlineAt: budget.deadlineAt, reserveMs: 0 };
    let admin: string | undefined;
    let tip = '';
    let cleanupReason = 'limpeza incompleta: descoberta não concluída';
    try {
      admin = await adminDir(repo, path, cleanupBudget);
      const symbolic = await branchIsSymbolic(repo, branch, cleanupBudget);
      tip = await branchTip(repo, branch, cleanupBudget);
      if (
        worktreeCreatedByCall &&
        (!ownershipProofRef ||
          (ownershipMarkerWritten &&
            (await hasOwnershipMarker(admin, { path, branch, base, createdAt: '', ownershipProofRef })))) &&
        admin &&
        !symbolic &&
        tip === base
      ) {
        if (await exists(path)) {
          await git(repo.top, ['worktree', 'remove', '--force', path], {
            repo,
            config: flat(baseConfig()),
            ...budgetGit(cleanupBudget),
          });
        }
        if ((await exists(path)) && dirname(path) === realParent) await rm(path, { recursive: true, force: true });
        const branchDeleted =
          !(await exists(path)) && (await deleteBranchIfEligible(repo, branch, base, path, cleanupBudget));
        if (ownershipProofRef)
          await git(repo.top, ['update-ref', '--no-deref', '-d', ownershipProofRef, base], {
            repo,
            config: flat(baseConfig()),
            ...budgetGit(cleanupBudget),
          });
        cleanupReason = branchDeleted ? 'limpeza concluída' : 'worktree removida; ref preservada por segurança';
      }
    } catch (cleanupError) {
      cleanupReason = `limpeza interrompida: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
    if (
      !worktreeCreatedByCall &&
      ownershipProofRef &&
      !(await exists(path)) &&
      !(await branchTip(repo, branch).catch(() => ''))
    ) {
      // The ref was created by this invocation but no path or branch resource remains.
      // If discovery is inconclusive, preserve it for explicit recovery.
      await git(repo.top, ['update-ref', '--no-deref', '-d', ownershipProofRef, base], {
        repo,
        config: flat(baseConfig()),
      }).catch(() => undefined);
    }
    const cleanupMs = Date.now() - cleanupStarted;
    // Persist a recovery intent regardless of whether bounded discovery could confirm Git
    // metadata. The exact path/ref/base were selected before creating anything; this is not
    // evidence of ownership and consumers must not apply or delete it automatically.
    const cause = error instanceof Error ? error.message : String(error);
    const candidate: SessionWorktree = {
      path,
      branch,
      base,
      createdAt: new Date().toISOString(),
      ownershipVerified: worktreeCreatedByCall && (!ownershipProofRef || ownershipMarkerWritten),
      ...(ownershipProofRef ? { ownershipProofRef } : {}),
      ...(worktreeCreatedByCall && tip ? { cleanupBranchTip: tip } : {}),
      ...(worktreeCreatedByCall ? { preparationFailed: true, executionStarted: false } : {}),
      ...(worktreeCreatedByCall && ownershipProofRef
        ? {
            recoveryEvidence: {
              intentRecorded: true as const,
              creation: 'confirmed' as const,
              ownership: ownershipMarkerWritten ? ('confirmed' as const) : ('unknown' as const),
              preparation: 'incomplete' as const,
              taskExecution: 'not_started' as const,
            },
          }
        : {}),
      recoveryReason: `Intenção registrada antes da criação; criação ${worktreeCreatedByCall ? 'confirmada por esta execução' : 'não comprovada'}; preparação/baseline não iniciada. Falha: ${cause}. ${cleanupReason}; observação AdminDir: ${admin ? 'presente' : 'ausente/não confirmada'}; tip da branch: ${tip ? (tip === base ? 'observado no base' : 'observado diferente do base') : 'não observado'}; propriedade ${worktreeCreatedByCall && (!ownershipProofRef || ownershipMarkerWritten) ? 'confirmada no limite de criação' : 'incerta, sem promoção automática'}; ${cleanupMs} ms.`,
    };
    // If cleanup actually completed and no candidate resources remain, there is nothing to
    // recover. Otherwise retain the unverified intent, including when discovery timed out.
    const pathRemains = await exists(path).catch(() => true);
    if (cleanupReason !== 'limpeza concluída' || pathRemains)
      Object.assign(error instanceof Error ? error : {}, { recoveryWorktree: candidate });
    if (error instanceof Error)
      error.message += ` (${cleanupReason}; AdminDir ${admin ? 'observado' : 'não observado'}; tip da branch ${tip ? (tip === base ? 'observado no base' : 'observado diferente do base') : 'não observado'}; ${cleanupMs} ms)`;
    throw error;
  }
  return {
    path,
    branch,
    base,
    createdAt: new Date().toISOString(),
    ownershipVerified: true,
    ownershipProofRef,
  };
}

interface Opened {
  main: Repo;
  /** Undefined when the folder or its admin entry is gone. */
  tree?: Repo;
}
async function openWorktree(project: Project, worktree: SessionWorktree, budget: WorktreeBudget = {}): Promise<Opened> {
  const main = await openRepo(project.path, false, budgetGit(budget));
  if (!main) throw fail('worktrees.repoGone', 410);
  const admin = await adminDir(main, worktree.path, budget);
  if (!admin || !(await exists(worktree.path))) return { main };
  if (worktree.ownershipVerified === true && !(await hasOwnershipMarker(admin, worktree)))
    throw new Error('A continuidade do ocupante atual não foi comprovada; recurso preservado para inspeção.');
  return { main, tree: { root: worktree.path, top: worktree.path, gitDir: admin, format: main.format } };
}

async function branchTip(main: Repo, branch: string, budget: WorktreeBudget = {}) {
  return (
    await git(main.top, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], {
      repo: main,
      ...budgetGit(budget),
    })
  )
    .toString()
    .trim();
}
async function isAncestor(main: Repo, commit: string, of: string, budget: WorktreeBudget = {}) {
  try {
    await git(main.top, ['merge-base', '--is-ancestor', commit, of], { repo: main, ...budgetGit(budget) });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}
async function branchIsSymbolic(main: Repo, branch: string, budget: WorktreeBudget = {}) {
  try {
    await git(main.top, ['symbolic-ref', '-q', `refs/heads/${branch}`], { repo: main, ...budgetGit(budget) });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/**
 * A ref can be deleted only after Git confirms no remaining checkout is attached to it.
 * Use porcelain output (not folder names or Adelic branch naming) so this also protects
 * retries after the worktree being removed has already disappeared.
 */
async function anotherCheckoutUsesBranch(
  main: Repo,
  branch: string,
  removingPath: string,
  budget: WorktreeBudget = {},
) {
  let output: string;
  try {
    output = (
      await git(main.top, ['worktree', 'list', '--porcelain', '-z'], {
        repo: main,
        config: flat(baseConfig()),
        ...budgetGit(budget),
      })
    ).toString();
  } catch (error) {
    if ((error as { name?: unknown }).name === 'AbortError' || (error as { code?: unknown }).code === 'ETIMEDOUT')
      throw error;
    return undefined;
  }

  // NUL delimited records avoid path quoting/escaping ambiguities. Treat malformed output as
  // inconclusive: deleting on a failed discovery would risk breaking another checkout.
  const fields = output.split('\0');
  if (fields.at(-1) !== '') return undefined;
  fields.pop();
  const removingPathExists = await exists(removingPath);
  let record: string[] = [];
  let records = 0;
  let found = false;
  for (const field of fields) {
    if (field) {
      record.push(field);
      continue;
    }
    if (!record.length) continue;
    const checkout = record.find((entry) => entry.startsWith('worktree '));
    if (!checkout) return undefined;
    records++;
    const path = resolve(checkout.slice('worktree '.length));
    const removing = !removingPathExists && path === resolve(removingPath);
    if (!removing && record.includes(`branch refs/heads/${branch}`)) found = true;
    if (!removing && record.includes('detached')) {
      const admin = await adminDir(main, path, budget);
      if (!admin) return undefined;
      for (const marker of [
        'rebase-merge',
        'rebase-apply',
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        // Bisect detaches HEAD but needs its saved start ref for `git bisect reset`.
        'BISECT_START',
        'BISECT_LOG',
      ]) {
        if (!(await exists(join(admin, marker)))) continue;
        const operationBranch = await readFile(join(admin, marker, 'head-name'), 'utf8').catch(() => '');
        if (operationBranch.trim() === `refs/heads/${branch}` || !marker.startsWith('rebase-')) found = true;
        else if (!operationBranch.trim()) return undefined;
      }
    }
    record = [];
  }
  if (record.length || records === 0) return undefined;
  return found;
}

/**
 * The single automatic ref-deletion sink. Callers establish their reason for deletion;
 * this helper independently rechecks symbolic refs, checkout/operation safety, and the exact
 * observed OID before performing compare-and-delete.
 */
async function deleteBranchIfEligible(
  main: Repo,
  branch: string,
  expectedTip: string,
  removingPath: string,
  budget: WorktreeBudget = {},
): Promise<boolean> {
  if (await branchIsSymbolic(main, branch, budget)) return false;
  const tip = await branchTip(main, branch, budget).catch((error) => {
    if ((error as { code?: unknown }).code === 1) return '';
    throw error;
  });
  if (!tip || tip !== expectedTip) return false;
  if ((await anotherCheckoutUsesBranch(main, branch, removingPath, budget)) !== false) return false;
  return await git(main.top, ['update-ref', '--no-deref', '-d', `refs/heads/${branch}`, expectedTip], {
    repo: main,
    config: flat(baseConfig()),
    ...budgetGit(budget),
  }).then(
    () => true,
    (error) => {
      if ((error as { name?: unknown }).name === 'AbortError' || (error as { code?: unknown }).code === 'ETIMEDOUT')
        throw error;
      return false;
    },
  );
}

/** Why the main checkout cannot take a merge now (dirty, detached, operation in progress), if so. */
export async function mainBlocked(
  main: Repo,
  budget: WorktreeBudget = {},
): Promise<{ reason?: Translatable; branch?: string }> {
  const branch = await git(main.top, ['symbolic-ref', '-q', '--short', 'HEAD'], {
    repo: main,
    ...budgetGit(budget),
  }).then(
    (b) => b.toString().trim(),
    () => '',
  );
  if (!branch) return { reason: why('worktrees.detached') };
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])
    if (await exists(join(main.gitDir, marker))) return { branch, reason: why('worktrees.gitOperation') };
  const status = nulSplit(
    await git(main.top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'], {
      repo: main,
      config: await hardened(main, budget),
      ...budgetGit(budget),
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
  if (worktree.ownershipVerified !== true || preparationFailed(worktree)) {
    const message =
      worktree.ownershipVerified === false
        ? 'Propriedade não comprovada: caminho, branch, base e metadados coincidentes são apenas intenção/observação; candidato preservado sem inspeção de conteúdo, aplicação ou descarte automático.'
        : 'Propriedade confirmada, mas preparação/baseline incompleta; execução não iniciada. O candidato é preservado e não pode ser inspecionado ou aplicado como entrega.';
    result.reason = message;
    result.applyBlocked = message;
    return result;
  }
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
  requireTaskReady(worktree);
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
  requireTaskReady(worktree);
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
 * Removes the worktree folder and its admin entry. The branch is deleted only when `deleteBranch`
 * is explicitly true; omitted/false preserves it. A folder git refuses to
 * remove (a rewritten `.git`) is deleted directly: it is always below `<dataDir>/worktrees`.
 * Ref deletion uses an OID compare-and-delete; update-ref itself does not protect checked-out branches,
 * so remaining checkouts are explicitly discovered before that atomic ref operation.
 */
export async function removeWorktree(
  project: Project | undefined,
  worktree: SessionWorktree,
  dataDir: string,
  opts: {
    deleteBranch?: boolean;
    onCleanupAuthorized?: (tip: string) => Promise<void>;
    /** Deterministic fault-injection seam; production callers leave this unset. */
    afterWorktreeRemoval?: () => Promise<void>;
  } & WorktreeBudget = {},
): Promise<{
  removed: boolean;
  branchDeleted: boolean;
  branch: string;
  branchTip?: string;
  cleanupResources: {
    worktree: 'removed' | 'preserved' | 'unknown';
    branch: 'removed' | 'preserved' | 'unknown';
    ownershipProof: 'removed' | 'preserved' | 'unknown';
  };
}> {
  requireWorktreeOwnership(worktree);
  const parent = await realpath(worktreeRoot(dataDir)).catch(() => worktreeRoot(dataDir));
  const ours = dirname(worktree.path) === parent && basename(worktree.path) !== '';
  const main = project ? await openRepo(project.path, false, budgetGit(opts)) : undefined;
  let currentCheckoutVerified = false;
  // This is the only authorization snapshot for ref deletion. A later reread may verify it
  // is unchanged, but must never authorize a newer OID.
  let authorizedTip = worktree.cleanupBranchTip;
  if (main && ours && (await exists(worktree.path))) {
    const admin = await adminDir(main, worktree.path, opts);
    const headFile = admin ? await readFile(join(admin, 'HEAD'), 'utf8').catch(() => '') : '';
    const listings = await git(main.top, ['worktree', 'list', '--porcelain'], {
      repo: main,
      config: flat(baseConfig()),
      ...budgetGit(opts),
    })
      .then((output) => output.toString())
      .catch(() => '');
    const records = listings.split(/\n\n/);
    const continuityVerified = worktree.ownershipVerified !== true || (await hasOwnershipMarker(admin, worktree));
    currentCheckoutVerified =
      Boolean(admin) &&
      continuityVerified &&
      headFile.trim() === `ref: refs/heads/${worktree.branch}` &&
      records.some((record) => {
        const pathLine = record.split('\n').find((line) => line.startsWith('worktree '));
        return pathLine && resolve(pathLine.slice('worktree '.length)) === resolve(worktree.path);
      });
    if (!currentCheckoutVerified)
      throw new Error(
        'O ocupante atual não foi comprovado como a worktree registrada; caminho e conteúdo foram preservados para inspeção.',
      );
    const config = await hardened(main, opts);
    // Capture the ref version while the owned checkout is still present. Cleanup may then
    // remove the folder, but an intervening ref advance is preserved by the CAS sink.
    if (!authorizedTip) {
      authorizedTip = await branchTip(main, worktree.branch, opts).catch((error) => {
        if ((error as { code?: unknown }).code === 1) return '';
        throw error;
      });
    }
    if (opts.deleteBranch === true && authorizedTip) await opts.onCleanupAuthorized?.(authorizedTip);
    try {
      await git(main.top, ['worktree', 'remove', '--force', worktree.path], {
        repo: main,
        config,
        ...budgetGit(opts),
      });
    } catch {
      // Direct fallback is allowed only after the current registered checkout was verified above.
      if (!(await adminDir(main, worktree.path, opts))) throw new Error('AdminDir desapareceu durante descarte.');
      workDeadline(opts);
      await rm(worktree.path, { recursive: true, force: true });
    }
    await opts.afterWorktreeRemoval?.();
    const staleAdmin = await adminDir(main, worktree.path, opts);
    if (staleAdmin && !(await exists(worktree.path))) {
      // We verified this exact admin pointer before removal; once its path is gone, remove
      // only that stale metadata directory (never run a broad prune across user worktrees).
      await rm(staleAdmin, { recursive: true, force: true });
    }
  } else if (await exists(worktree.path)) {
    if (!project)
      return {
        removed: false,
        branchDeleted: false,
        branch: worktree.branch,
        cleanupResources: { worktree: 'unknown', branch: 'unknown', ownershipProof: 'unknown' },
      };
    throw new Error(
      'O ocupante atual não foi comprovado como recurso Adelic; caminho e conteúdo foram preservados para inspeção.',
    );
  }
  let branchDeleted = false;
  let observedTip = '';
  if (main && worktree.branch.startsWith(BRANCH_PREFIX)) {
    const symbolic = await branchIsSymbolic(main, worktree.branch, opts);
    observedTip = symbolic
      ? ''
      : await branchTip(main, worktree.branch, opts).catch((error) => {
          if ((error as { code?: unknown }).code === 1) return '';
          throw error;
        });
    const proof = worktree.ownershipProofRef
      ? await git(main.top, ['rev-parse', '--verify', '-q', worktree.ownershipProofRef], {
          repo: main,
          ...budgetGit(opts),
        }).then(
          (value) => value.toString().trim(),
          (error) => ((error as { code?: unknown }).code === 1 ? '' : Promise.reject(error)),
        )
      : '';
    // A current checkout authorized its exact pre-removal OID above. A retry without the
    // checkout may use only the persisted cleanup pin; rereading an advanced tip is not authority.
    const provenanceConfirmed =
      proof === worktree.base &&
      Boolean(authorizedTip) &&
      observedTip === authorizedTip &&
      (currentCheckoutVerified || worktree.cleanupBranchTip === authorizedTip) &&
      (await isAncestor(main, worktree.base, authorizedTip, opts));
    if (observedTip && provenanceConfirmed) {
      // A merged branch is still retained unless deletion was explicitly requested.
      if (opts.deleteBranch === true)
        branchDeleted = await deleteBranchIfEligible(main, worktree.branch, authorizedTip!, worktree.path, opts);
    }
  }
  // Explicitly keeping a session branch ends Adelic's recovery ownership: preserve the user's
  // branch, but retire this checkout's proof so the conversation can start a fresh worktree.
  // Automatic cleanup may retire the proof only after the branch itself is gone.
  const explicitlyKeptBranch = opts.deleteBranch === false && Boolean(observedTip) && !branchDeleted;
  // Once checkout is absent, retry removal of this record's own CAS proof independently.
  if (
    main &&
    !(await exists(worktree.path)) &&
    (branchDeleted || !observedTip || explicitlyKeptBranch) &&
    worktree.ownershipVerified === true &&
    worktree.ownershipProofRef
  ) {
    const proof = await git(main.top, ['rev-parse', '--verify', '-q', worktree.ownershipProofRef], {
      repo: main,
      ...budgetGit(opts),
    }).then(
      (value) => value.toString().trim(),
      (error) => {
        if ((error as { code?: unknown }).code === 1) return '';
        throw error;
      },
    );
    if (proof === worktree.base)
      await git(main.top, ['update-ref', '--no-deref', '-d', worktree.ownershipProofRef, worktree.base], {
        repo: main,
        config: flat(baseConfig()),
        ...budgetGit(opts),
      });
  }
  const pathRemains = await exists(worktree.path);
  const remainingTip =
    main &&
    (await branchTip(main, worktree.branch, opts).catch((error) => {
      if ((error as { code?: unknown }).code === 1) return '';
      throw error;
    }));
  const proofRemains = !main
    ? undefined
    : worktree.ownershipProofRef
      ? await git(main.top, ['rev-parse', '--verify', '-q', worktree.ownershipProofRef], {
          repo: main,
          ...budgetGit(opts),
        }).then(
          () => true,
          (error) => ((error as { code?: unknown }).code === 1 ? false : Promise.reject(error)),
        )
      : false;
  return {
    removed: !pathRemains,
    branchDeleted,
    branch: worktree.branch,
    cleanupResources: {
      worktree: pathRemains ? 'preserved' : 'removed',
      branch: !main ? 'unknown' : remainingTip ? 'preserved' : 'removed',
      ownershipProof: proofRemains === undefined ? 'unknown' : proofRemains ? 'preserved' : 'removed',
    },
    // Carry forward only the OID this cleanup authorized. A reread of a newer tip is
    // observation, not permission to delete it on a later retry.
    ...(remainingTip && authorizedTip && remainingTip === authorizedTip ? { branchTip: authorizedTip } : {}),
  };
}

/** True when the recorded folder is gone (startup pruning). */
export async function worktreeMissing(worktree: SessionWorktree) {
  return !(await exists(join(worktree.path, '.git')));
}

/**
 * Executor workspaces are based on a bounded snapshot of tracked and non-ignored untracked
 * files. Ignored files, credentials excluded by Git and the user's index are never copied.
 */
async function assertSnapshotable(repo: Repo, budget: WorktreeBudget = {}) {
  const paths = nulSplit(
    await git(repo.root, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard'], {
      repo,
      ...budgetGit(budget),
    }),
  );
  for (const path of paths) {
    workDeadline(budget);
    const info = await lstat(join(repo.top, path)).catch(() => undefined);
    if (info?.isDirectory())
      throw new CheckpointError(`snapshot de submódulo ou repositório aninhado não suportado: ${path}`, 422);
    if (info && !info.isFile() && !info.isSymbolicLink())
      throw new CheckpointError(`tipo de arquivo não suportado no snapshot: ${path}`, 422);
  }
  workDeadline(budget);
}

async function executorRepo(project: Project, budget: WorktreeBudget = {}) {
  const { repo, reason } = await mainRepo(project, budget);
  if (!repo) throw fail(why('worktrees.cannotCreate', { reason: pt(reason!) }));
  const blocked = await mainBlocked(repo, budget);
  if (blocked.reason && blocked.reason.key !== 'worktrees.dirty') throw fail(blocked.reason);
  return repo;
}

export async function executorWorktreesAvailable(project: Project, budget: WorktreeBudget = {}) {
  try {
    await executorRepo(project, budget);
    return true;
  } catch {
    return false;
  }
}

export async function createExecutorWorktree(
  project: Project,
  task: { id: string; title: string },
  dataDir: string,
  budget: WorktreeBudget = {},
) {
  const repo = await executorRepo(project, budget);
  await assertSnapshotable(repo, budget);
  const snapshotTree = await writeSnapshotTree(repo, { deadlineAt: budgetDeadlineAt(budget), signal: budget.signal });
  const worktree = await createWorktree(project, { id: task.id, title: task.title } as Session, dataDir, budget);
  try {
    const baseTree = (await git(repo.top, ['rev-parse', `${worktree.base}^{tree}`], { repo, ...budgetGit(budget) }))
      .toString()
      .trim();
    const patch = await git(
      repo.top,
      ['diff-tree', '--no-commit-id', '-p', '-r', '--binary', '--no-renames', baseTree, snapshotTree],
      {
        repo,
        config: await hardened(repo, budget),
        ...budgetGit(budget),
      },
    );
    if (patch.length) {
      const opened = await openWorktree(project, worktree, budget);
      if (!opened.tree) throw fail('worktrees.folderGoneDiscard', 409);
      await git(opened.tree.top, ['apply', '--binary', '-'], {
        repo: opened.tree,
        input: patch,
        config: await hardened(opened.tree, budget),
        ...budgetGit(budget),
      });
    }
    return { ...worktree, snapshotTree };
  } catch (error) {
    // Creation succeeded in this call, but preparation may have applied only part of the
    // captured baseline. Never report that as task execution or a completed delivery.
    let cleaned = false;
    let cleanupBranchTip: string | undefined;
    let cleanupDetail = '';
    try {
      const result = await removeWorktree(project, worktree, dataDir, { ...budget, reserveMs: 0 });
      cleanupBranchTip = result.branchTip;
      cleaned = result.removed && result.branchDeleted;
      if (!cleaned) cleanupDetail = 'cleanup conservou caminho ou ref por segurança';
    } catch (cleanupError) {
      cleanupDetail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
    if (!cleaned) {
      const recovery: RecoveryStage = {
        ...worktree,
        snapshotTree,
        ...(cleanupBranchTip ? { cleanupBranchTip } : {}),
        ownershipVerified: true,
        preparationFailed: true,
        executionStarted: false,
        recoveryEvidence: {
          intentRecorded: true,
          creation: 'confirmed',
          ownership: 'confirmed',
          preparation: 'incomplete',
          taskExecution: 'not_started',
        },
        recoveryReason: `Criação confirmada por esta execução; baseline capturada (${snapshotTree}); preparação incompleta/falhou; execução da tarefa não iniciada. ${cleanupDetail}`,
      };
      Object.assign(error instanceof Error ? error : {}, { recoveryWorktree: recovery });
      if (error instanceof Error) error.message += ` (recurso criado preservado para recuperação: ${cleanupDetail})`;
    }
    throw error;
  }
}

/** Changed files owned by an executor task, measured against its captured initial tree. */
export async function inspectExecutorWorktree(
  project: Project,
  worktree: SessionWorktree,
  budget: WorktreeBudget = {},
): Promise<FileChange[]> {
  requireTaskReady(worktree);
  workDeadline(budget);
  const opened = await openWorktree(project, worktree, budget);
  if (!opened.tree) throw fail('worktrees.folderGoneDiscard', 409);
  const baseline =
    worktree.snapshotTree ??
    (await git(opened.main.top, ['rev-parse', `${worktree.base}^{tree}`], { repo: opened.main, ...budgetGit(budget) }))
      .toString()
      .trim();
  await assertSnapshotable(opened.tree, budget);
  // Match integration: retain captured paths even if task changes .gitignore, while never
  // introducing ignored files that were absent from the task's initial snapshot.
  const baselinePaths = nulSplit(
    await git(opened.tree.top, ['ls-tree', '-r', '-z', '--name-only', baseline], {
      repo: opened.tree,
      ...budgetGit(budget),
    }),
  );
  const after = await writeSnapshotTree(opened.tree, {
    includePaths: baselinePaths,
    deadlineAt: budgetDeadlineAt(budget),
    signal: budget.signal,
  });
  return changedFiles(opened.tree, baseline, after, { deadlineAt: budgetDeadlineAt(budget), signal: budget.signal });
}

/**
 * Later verification for a persisted unverified intent. It requires the recorded child path to
 * be a registered checkout whose checked-out branch and tip match the persisted ref/base tuple;
 * a branch name or matching ref alone is never sufficient.
 */
export async function verifyExecutorWorktreeCandidate(
  project: Project,
  worktree: SessionWorktree,
  dataDir: string,
): Promise<boolean> {
  // A pre-created ref records intent only. If creation ownership was not recorded at the
  // creation boundary, current path/branch/base/AdminDir coincidence cannot prove it later.
  if (worktree.ownershipVerified !== true) return false;
  if (!worktree.ownershipProofRef || !ownershipNonce(worktree)) return false;
  const ownershipProofRef = worktree.ownershipProofRef!;
  const root = await realpath(worktreeRoot(dataDir)).catch(() => undefined);
  if (!root || dirname(worktree.path) !== root || basename(worktree.path) === '') return false;
  const pathExists = await exists(worktree.path);
  const canonicalPath = pathExists ? await realpath(worktree.path).catch(() => undefined) : undefined;
  if (pathExists && (!canonicalPath || canonicalPath !== worktree.path)) return false;
  try {
    // A missing child is safe to inspect only from a previously ownership-verified record with
    // its invocation-specific nonce. Remaining resources are checked below; a fully empty
    // inventory is an already-completed cleanup, not authority to remove anything. A present
    // occupant is independently revalidated below.
    if (!pathExists) {
      const main = await openRepo(project.path, false);
      if (!main || (await branchIsSymbolic(main, worktree.branch))) return false;
      const [proof, tip] = await Promise.all([
        git(main.top, ['rev-parse', '--verify', '-q', ownershipProofRef], { repo: main }).then(
          (value) => value.toString().trim(),
          (error) => ((error as { code?: unknown }).code === 1 ? '' : Promise.reject(error)),
        ),
        branchTip(main, worktree.branch).catch((error) => {
          if ((error as { code?: unknown }).code === 1) return '';
          throw error;
        }),
      ]);
      if (!proof && !tip) return true; // Previously authorized record; all resources are already absent.
      if (proof !== worktree.base) return false;
      if (!tip) return true; // Only this invocation's proof remains; cleanup may retry that resource.
      return tip === (worktree.cleanupBranchTip ?? worktree.base) && (await isAncestor(main, worktree.base, tip));
    }
    const opened = await openWorktree(project, worktree);
    if (!opened.tree) return false;
    const [proof, branch, head, tip] = await Promise.all([
      git(opened.main.top, ['rev-parse', '--verify', ownershipProofRef], { repo: opened.main }),
      git(opened.tree.top, ['symbolic-ref', '--short', 'HEAD'], { repo: opened.tree }),
      git(opened.tree.top, ['rev-parse', '--verify', 'HEAD^{commit}'], { repo: opened.tree }),
      branchTip(opened.main, worktree.branch),
    ]);
    if (proof.toString().trim() !== worktree.base) return false;
    if (branch.toString().trim() !== worktree.branch) return false;
    const headOid = head.toString().trim();
    if (!headOid || headOid !== tip.toString().trim()) return false;
    return await isAncestor(opened.main, worktree.base, headOid);
  } catch {
    return false;
  }
}

/** Git's reverse apply check can warn and succeed when only a mode differs. Confirm the
 * filesystem entry against the expected post-delta tree before treating a section as applied.
 * lstat is deliberate: symlinks must never be followed while checking their type/mode. */
async function matchesExpectedTreeEntry(repo: Repo, tree: string, path: string, budget: WorktreeBudget) {
  const entries = nulSplit(
    await git(repo.top, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', path], {
      repo,
      ...budgetGit(budget),
    }),
  );
  const entry = entries.find((line) => {
    const tab = line.indexOf('\t');
    return tab >= 0 && line.slice(tab + 1) === path;
  });
  const filesystemPath = join(repo.top, path);
  const actual = await lstat(filesystemPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
      return undefined;
    throw error;
  });
  if (!entry) return actual === undefined;
  if (!actual) return false;
  const tab = entry.indexOf('\t');
  if (tab < 0) return false;
  const [mode, type, oid] = entry.slice(0, tab).split(' ');
  if (type !== 'blob' || !oid) return false;
  const expected = await git(repo.top, ['cat-file', 'blob', oid], { repo, ...budgetGit(budget) });
  if (mode === '120000') {
    if (!actual.isSymbolicLink()) return false;
    const target = await readlink(filesystemPath, { encoding: 'buffer' });
    return Buffer.compare(target, expected) === 0;
  }
  if (!actual.isFile() || actual.isSymbolicLink()) return false;
  const executable = (actual.mode & 0o100) !== 0;
  if (mode !== (executable ? '100755' : '100644')) return false;
  const contents = await readFile(filesystemPath);
  return Buffer.compare(contents, expected) === 0;
}

/** Compare only lstat type/mode, without following symlinks or normalizing file contents. */
async function matchesExpectedTreeMode(repo: Repo, tree: string, path: string, budget: WorktreeBudget) {
  const entries = nulSplit(
    await git(repo.top, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', path], {
      repo,
      ...budgetGit(budget),
    }),
  );
  const entry = entries.find((line) => {
    const tab = line.indexOf(String.fromCharCode(9));
    return tab >= 0 && line.slice(tab + 1) === path;
  });
  const filesystemPath = join(repo.top, path);
  const actual = await lstat(filesystemPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
      return undefined;
    throw error;
  });
  if (!entry) return actual === undefined;
  if (!actual) return false;
  const tab = entry.indexOf(String.fromCharCode(9));
  if (tab < 0) return false;
  const [mode, type] = entry.slice(0, tab).split(' ');
  if (type !== 'blob') return false;
  if (mode === '120000') return actual.isSymbolicLink();
  if (!actual.isFile() || actual.isSymbolicLink()) return false;
  return mode === ((actual.mode & 0o100) !== 0 ? '100755' : '100644');
}

/** Integrates only the executor's delta from its creation snapshot onto the current main tree. */
export async function integrateExecutorWorktree(
  project: Project,
  worktree: SessionWorktree,
  budget: WorktreeBudget = {},
) {
  requireTaskReady(worktree);
  workDeadline(budget);
  const opened = await openWorktree(project, worktree, budget);
  if (!opened.tree) throw fail('worktrees.folderGoneDiscard', 409);
  const blocked = await mainBlocked(opened.main, budget);
  if (blocked.reason && blocked.reason.key !== 'worktrees.dirty') throw fail(blocked.reason);
  const baseline =
    worktree.snapshotTree ??
    (await git(opened.main.top, ['rev-parse', `${worktree.base}^{tree}`], { repo: opened.main, ...budgetGit(budget) }))
      .toString()
      .trim();
  await assertSnapshotable(opened.tree, budget);
  // The baseline contains only tracked and eligible non-ignored files captured for this task.
  // Keep those paths in the final tree even if the task's .gitignore now hides them; files
  // deleted from disk remain absent, and files originally ignored were never in this list.
  const baselinePaths = nulSplit(
    await git(opened.tree.top, ['ls-tree', '-r', '-z', '--name-only', baseline], {
      repo: opened.tree,
      ...budgetGit(budget),
    }),
  );
  const after = await writeSnapshotTree(opened.tree, {
    includePaths: baselinePaths,
    deadlineAt: budgetDeadlineAt(budget),
    signal: budget.signal,
  });
  const changes = await changedFiles(opened.tree, baseline, after, {
    deadlineAt: budgetDeadlineAt(budget),
    signal: budget.signal,
  });
  if (!changes.length) return { changed: false, files: [] as string[] };
  const names = changes.map((file) => file.path);
  const config = await hardened(opened.main, budget);
  // Collect complete per-path deltas, including every section Git emits for type changes.
  // Validate the entire patch once, then apply it in one Git operation.
  const pending: Buffer[] = [];
  const alreadyAppliedPaths = new Set<string>();
  for (const file of changes) {
    const delta = await git(
      opened.tree.top,
      [
        '--literal-pathspecs',
        'diff-tree',
        '--no-commit-id',
        '-p',
        '-r',
        '--binary',
        '--no-renames',
        baseline,
        after,
        '--',
        file.path,
      ],
      { repo: opened.tree, config: await hardened(opened.tree, budget), ...budgetGit(budget) },
    );
    if (!delta.length) throw new Error(`Delta ausente para o caminho literal: ${file.path}`);
    const isModeOnly = file.additions === 0 && file.deletions === 0;
    const alreadyApplied = await git(opened.main.top, ['apply', '--binary', '--reverse', '--check', '-'], {
      repo: opened.main,
      input: delta,
      config,
      ...budgetGit(budget),
    }).then(
      () => true,
      (error) => {
        // Exit 1 means this complete path delta is not present. Timeout, cancellation and other
        // failures are inconclusive and must not be converted into an apply attempt.
        if ((error as { code?: unknown }).code === 1) return false;
        throw error;
      },
    );
    if (alreadyApplied) {
      // Reverse-check alone may warn success for a pending mode change. For textual deltas only
      // type/mode must match, so a merged distant edit is preserved; mode-only deltas additionally
      // require exact post-image bytes before they may be omitted.
      const entryMatches = isModeOnly
        ? await matchesExpectedTreeEntry(opened.main, after, file.path, budget)
        : await matchesExpectedTreeMode(opened.main, after, file.path, budget);
      if (entryMatches) {
        alreadyAppliedPaths.add(file.path);
        continue;
      }
    }
    // Type transitions remain ordinary complete Git patches; never materialize from a tree or
    // use restore, which can apply checkout conversions and cannot make mixed writes atomic.
    pending.push(delta);
  }
  if (!pending.length) return { changed: false, alreadyApplied: true, files: names };
  const remainingPatch = Buffer.concat(pending);

  // Never let an added task file replace a file that appeared in the main checkout after capture
  // (notably an ignored secret, which Git's ordinary status does not report). Exact prior
  // applications have already been excluded; differing files remain real collisions.
  const collisions: string[] = [];
  for (const file of changes)
    if (
      file.status === 'added' &&
      !alreadyAppliedPaths.has(file.path) &&
      (await exists(join(opened.main.top, file.path)))
    )
      collisions.push(file.path);
  if (collisions.length) throw fail('worktrees.ignoredFiles', 409, collisions);

  // A single complete-patch check prevents ordinary conflicts from partially writing earlier paths.
  await git(opened.main.top, ['apply', '--binary', '--check', '-'], {
    repo: opened.main,
    input: remainingPatch,
    config,
    ...budgetGit(budget),
  });
  await git(opened.main.top, ['apply', '--binary', '-'], {
    repo: opened.main,
    input: remainingPatch,
    config,
    ...budgetGit(budget),
  });
  return { changed: true, alreadyApplied: false, files: names };
}

/** git worktree prune in the project's repository: drops admin entries of missing folders. */
export async function pruneRepo(project: Project) {
  const main = await openRepo(project.path, false);
  if (!main) return;
  await git(main.top, ['worktree', 'prune'], { repo: main, config: flat(baseConfig()) });
}
