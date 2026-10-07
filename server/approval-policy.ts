import { realpath, access, stat, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseShell, type SimpleCommand } from './shell-grammar';
import { gitConfigSafety, globalIgnoreFiles, readConfig, type GitConfigSources } from './git-safety';

export type ApprovalInput = {
  tools: unknown;
  mode?: 'auto-safe' | 'manual';
  kind: 'command' | 'file' | 'permissions' | 'stdin' | 'unknown';
  command?: unknown;
  cwd?: unknown;
  workspace: string;
  sandbox: 'read-only' | 'workspace-write';
  networkApprovalContext?: unknown;
  trustedNonLoginShell?: boolean;
  /**
   * Graphify paths Adelic itself uses (server/graphify.ts). With both set, exactly the query
   * Adelic suggests to agents is auto-approved; absent → graphify asks like any program.
   */
  graphify?: { binary?: string; graphsRoot?: string };
  /**
   * The command runs through a shell Adelic does not control (Kiro): parse with the portable
   * grammar, whose quoting means the same in bash, zsh, dash and fish.
   */
  portableShell?: boolean;
  /** Test seam for the git configuration layers; production reads the real ones. */
  gitConfig?: GitConfigSources;
};
export type ApprovalResult = { decision: 'auto' | 'pending' | 'deny'; reason: string };
export async function canonWritePathWithin(workspace: string, raw: string): Promise<string | undefined> {
  try {
    const root = await realpath(workspace),
      target = path.resolve(root, raw);
    if (target !== root && !target.startsWith(root + path.sep)) return undefined;
    let probe = target;
    for (;;) {
      try {
        const actual = await realpath(probe);
        return actual === root || actual.startsWith(root + path.sep) ? target : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        try {
          await lstat(probe);
          return undefined;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        }
        const parent = path.dirname(probe);
        if (parent === probe) return undefined;
        probe = parent;
      }
    }
  } catch {
    return undefined;
  }
}
export async function scanCodexRules(options: { cwd: string; codexHome?: string; systemRoot?: string }): Promise<void> {
  const roots = [
    path.join(path.join(options.codexHome ?? (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), 'rules')),
    path.join(options.systemRoot ?? '/etc/codex', 'rules'),
  ];
  let current: string;
  try {
    current = await realpath(options.cwd);
  } catch (error) {
    throw new Error(
      `Não foi possível verificar regras Codex: cwd real indisponível (${(error as NodeJS.ErrnoException).code ?? 'erro'}).`,
      { cause: error },
    );
  }
  for (;;) {
    roots.push(path.join(current, '.codex', 'rules'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw new Error(`Não foi possível verificar regras Codex em ${root}: ${code ?? 'erro de leitura'}`, {
        cause: error,
      });
    }
    if (names.some((name) => name.endsWith('.rules')))
      throw new Error(`Execução de ferramentas bloqueada: arquivo .rules não inspecionado em ${root}.`);
  }
}
const pending = (reason: string): ApprovalResult => ({ decision: 'pending', reason });
const deny = (reason: string): ApprovalResult => ({ decision: 'deny', reason });

const secretSegment =
  /^(?:\.env.*|\.ssh|\.aws|\.codex|\.config|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.docker|\.kube|auth(?:entication)?\.json|credentials?(?:\.json)?|cookies?\.json|tokens?\.json|secrets?(?:\.json|\.ya?ml)?|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;
/** Hidden files that never hold credentials and agents read constantly. */
const SAFE_DOTFILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintignore',
  '.nvmrc',
  '.node-version',
  '.github',
]);
const hiddenPart = (p: string) => p.startsWith('.') && p !== '.' && p !== '..' && !SAFE_DOTFILES.has(p);
function safeLexical(value: string): boolean {
  return (
    value !== '' &&
    !path.isAbsolute(value) &&
    value.split(/[\\/]+/).every((p) => p !== '..' && !hiddenPart(p) && !secretSegment.test(p))
  );
}
type PathKind = 'file' | 'any' | 'dir';
async function safePath(value: string, cwd: string, root: string, kind: PathKind): Promise<boolean> {
  if (value.startsWith('-') || !safeLexical(value)) return false;
  const abs = path.resolve(cwd, value);
  try {
    const real = await realpath(abs);
    if (real !== root && !real.startsWith(root + path.sep)) return false;
    const rel = path.relative(root, real);
    if (rel.split(path.sep).some((part) => hiddenPart(part) || secretSegment.test(part))) return false;
    const info = await stat(real);
    return kind === 'file' ? info.isFile() : kind === 'dir' ? info.isDirectory() : info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}
const TREE_MAX_ENTRIES = 50_000;
const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'];
/**
 * Hidden names an ignore file can un-hide for ripgrep: a `!` rule overrides rg's hidden filter.
 * A literal dot-segment (`!.env.example`) un-hides that name; a segment that starts with a
 * wildcard (`!*.md`, `!**`) can un-hide any hidden entry (`wild`). null = unreadable.
 */
type Unhidden = { wild: boolean; names: Set<string> };
async function unhiddenBy(file: string, into: Unhidden): Promise<boolean> {
  const text = await readConfig(file);
  if (text === undefined) return true;
  if (text === null) return false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('!')) continue;
    for (const segment of line.slice(1).split('/')) {
      if (/^[*?[\\]/.test(segment)) into.wild = true;
      else if (segment.startsWith('.')) into.names.add(segment);
    }
  }
  return true;
}
/**
 * A recursive content search is auto only when the tree it reads holds no secret-named entry.
 * Symlinks are not followed (grep -r and rg do not follow them either). `rg` skips hidden
 * entries by default, so they are skipped here too — except those an ignore file un-hides
 * (see unhiddenBy), and all of them when a positive glob selects files (reader 'grep').
 * `grep -r` reads hidden entries (including `.git`), so any hidden entry outside SAFE_DOTFILES
 * and not excluded with --exclude-dir asks.
 */
async function secretFreeTree(
  start: string,
  reader: 'rg' | 'grep',
  skipDirs: readonly string[],
  ctx: Ctx,
): Promise<boolean> {
  const unhidden: Unhidden = { wild: false, names: new Set() };
  if (reader === 'rg') {
    const outside = await globalIgnoreFiles(ctx.input.gitConfig);
    if (!outside) return false;
    // Ignore files above the searched directory and .git/info/exclude of an enclosing repository.
    for (let dir = start; ; dir = path.dirname(dir)) {
      outside.push(path.join(dir, '.git', 'info', 'exclude'));
      if (dir !== start) for (const name of IGNORE_FILES) outside.push(path.join(dir, name));
      if (path.dirname(dir) === dir) break;
    }
    for (const file of outside) if (!(await unhiddenBy(file, unhidden))) return false;
  }
  const queue = [start];
  let seen = 0;
  while (queue.length) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    if (reader === 'rg')
      for (const entry of entries)
        if (IGNORE_FILES.includes(entry.name) && !(await unhiddenBy(path.join(dir, entry.name), unhidden)))
          return false;
    for (const entry of entries) {
      if (++seen > TREE_MAX_ENTRIES) return false;
      if (entry.isDirectory() && skipDirs.includes(entry.name)) continue;
      if (hiddenPart(entry.name)) {
        // Hidden and not un-hidden: rg skips it entirely.
        if (reader === 'rg' && !unhidden.wild && !unhidden.names.has(entry.name)) continue;
        return false;
      }
      if (secretSegment.test(entry.name)) return false;
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  return true;
}
async function executable(name: string, cwd = process.cwd()): Promise<string | null> {
  if (!path.isAbsolute(name) && name.includes('/')) return null;
  if (path.isAbsolute(name)) {
    try {
      await access(name, constants.X_OK);
      const real = await realpath(name);
      return real.startsWith('/usr/bin/') || real.startsWith('/bin/') ? real : null;
    } catch {
      return null;
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.resolve(dir || cwd, name);
    try {
      await access(candidate, constants.X_OK);
      const real = await realpath(candidate);
      if ((real.startsWith('/usr/bin/') || real.startsWith('/bin/')) && path.basename(real) === name) return real;
      return null;
    } catch {
      /* continue */
    }
  }
  return null;
}
/** Resolves a command name the way a shell would (PATH lookup, or a path relative to cwd). */
async function resolveAny(name: string, cwd: string): Promise<string | null> {
  try {
    if (name.includes('/')) return await realpath(path.resolve(cwd, name));
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.resolve(dir || cwd, name);
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch {
        /* continue */
      }
    }
  } catch {
    /* unresolvable */
  }
  return null;
}
/** One path a command reads; `tree` marks a recursive content search of a directory. */
type PathReq = { value: string; kind: PathKind; tree?: 'rg' | 'grep' | 'follow'; skipDirs?: string[] };
type Spec = { paths: PathReq[]; stdin?: boolean; git?: { cwd: string; printsUrls?: boolean } };
type Ctx = { cwd: string; root: string; input: ApprovalInput };
type Options = { positional: string[]; values: Map<string, string[]>; flags: Set<string> };

/**
 * GNU-style option parser over an explicit allowlist: short boolean flags (clusters allowed),
 * short options with a value (attached or next argument), exact long flags and long options
 * with a value (`--name=value` or `--name value`). Unknown options fail closed.
 */
function options(
  args: string[],
  spec: { short?: string; shortValued?: string; long?: string[]; longValued?: string[]; noPermute?: boolean },
): Options | null {
  const out: Options = { positional: [], values: new Map(), flags: new Set() };
  const add = (name: string, value: string) => out.values.set(name, [...(out.values.get(name) ?? []), value]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      out.positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      if (spec.long?.includes(arg)) {
        out.flags.add(arg);
        continue;
      }
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      if (!spec.longValued?.includes(name)) return null;
      if (eq >= 0) add(name, arg.slice(eq + 1));
      else {
        if (i + 1 >= args.length) return null;
        add(name, args[++i]!);
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j]!;
        if (spec.short?.includes(c)) out.flags.add(`-${c}`);
        else if (spec.shortValued?.includes(c)) {
          const rest = arg.slice(j + 1);
          if (rest) add(`-${c}`, rest);
          else {
            if (i + 1 >= args.length) return null;
            add(`-${c}`, args[++i]!);
          }
          break;
        } else return null;
      }
      continue;
    }
    if (spec.noPermute) {
      out.positional.push(...args.slice(i));
      break;
    }
    out.positional.push(arg);
  }
  return out;
}
const has = (o: Options, ...names: string[]) => names.some((n) => o.flags.has(n) || o.values.has(n));
const filesOrStdin = (files: string[]): Spec =>
  files.length ? { paths: files.map((value) => ({ value, kind: 'file' })) } : { paths: [], stdin: true };
const COUNT = /^[+-]?\d{1,9}$/;

function headTail(name: 'head' | 'tail', args: string[]): Spec | null {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (/^-\d{1,9}$/.test(a) || /^-[nc][+-]?\d{1,9}$/.test(a) || a === '-q' || a === '-v') continue;
    if (a === '-n' || a === '-c' || a === '--lines' || a === '--bytes') {
      if (!COUNT.test(args[i + 1] ?? '')) return null;
      i++;
      continue;
    }
    if (/^--(?:lines|bytes)=[+-]?\d{1,9}$/.test(a)) continue;
    if (a.startsWith('-')) return null;
    files.push(a);
  }
  void name;
  return filesOrStdin(files);
}

function grepSpec(args: string[]): Spec | null {
  const o = options(args, {
    short: 'nrRilLwEFGPvchHoqsxIz',
    shortValued: 'ABCme',
    long: [
      '--line-number',
      '--recursive',
      '--dereference-recursive',
      '--ignore-case',
      '--files-with-matches',
      '--files-without-match',
      '--word-regexp',
      '--line-regexp',
      '--extended-regexp',
      '--fixed-strings',
      '--perl-regexp',
      '--invert-match',
      '--count',
      '--no-filename',
      '--with-filename',
      '--only-matching',
      '--quiet',
      '--silent',
      '--no-messages',
      '--null',
    ],
    longValued: ['--include', '--exclude', '--exclude-dir', '--color', '--colour', '--max-count', '--regexp'],
  });
  if (!o) return null;
  for (const n of ['-A', '-B', '-C', '-m', '--max-count'])
    if ((o.values.get(n) ?? []).some((v) => !/^\d{1,9}$/.test(v))) return null;
  for (const v of [...(o.values.get('--color') ?? []), ...(o.values.get('--colour') ?? [])])
    if (!['never', 'auto', 'always'].includes(v)) return null;
  const explicit = has(o, '-e', '--regexp');
  const positional = [...o.positional];
  if (!explicit && !positional.length) return null;
  const paths = explicit ? positional : positional.slice(1);
  const follow = has(o, '-R', '--dereference-recursive');
  const recursive = follow || has(o, '-r', '--recursive');
  if (!recursive) return filesOrStdin(paths);
  const skipDirs = (o.values.get('--exclude-dir') ?? []).filter((d) => !/[*?[\]\\]/.test(d));
  return {
    paths: (paths.length ? paths : ['.']).map((value) => ({
      value,
      kind: 'any' as const,
      tree: follow ? ('follow' as const) : ('grep' as const),
      skipDirs,
    })),
  };
}

function rgSpec(args: string[]): Spec | null {
  if (!args.includes('--no-config')) return null;
  const o = options(args, {
    short: 'niwFlHSIcvsUoqx',
    shortValued: 'ABCmegt',
    long: [
      '--no-config',
      '--line-number',
      '--no-line-number',
      '--ignore-case',
      '--smart-case',
      '--case-sensitive',
      '--word-regexp',
      '--fixed-strings',
      '--files-with-matches',
      '--count',
      '--invert-match',
      '--with-filename',
      '--no-filename',
      '--no-heading',
      '--heading',
      '--only-matching',
      '--column',
      '--vimgrep',
      '--json',
      '--trim',
      '--quiet',
    ],
    longValued: ['--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--color', '--max-columns'],
  });
  if (!o) return null;
  for (const n of ['-A', '-B', '-C', '-m', '--max-count', '--context', '--max-columns'])
    if ((o.values.get(n) ?? []).some((v) => !/^\d{1,9}$/.test(v))) return null;
  if ((o.values.get('--color') ?? []).some((v) => !['never', 'auto', 'always'].includes(v))) return null;
  // A negated glob only excludes; a positive glob can select hidden files, as grep -r reads them.
  const globs = [...(o.values.get('--glob') ?? []), ...(o.values.get('--iglob') ?? []), ...(o.values.get('-g') ?? [])];
  const reader = globs.every((g) => g.startsWith('!')) ? ('rg' as const) : ('grep' as const);
  const explicit = has(o, '-e');
  if (!explicit && !o.positional.length) return null;
  const paths = explicit ? o.positional : o.positional.slice(1);
  return { paths: (paths.length ? paths : ['.']).map((value) => ({ value, kind: 'any' as const, tree: reader })) };
}

const SED_PRINT = /^(?:\d{1,9}(?:,(?:\d{1,9}|\$))?p|\$p)$/;
function sedSpec(args: string[]): Spec | null {
  let rest = args;
  if (rest[0] !== '-n') return null;
  rest = rest.slice(1);
  if (rest[0] === '-e') rest = rest.slice(1);
  const script = rest[0];
  if (script === undefined || !SED_PRINT.test(script)) return null;
  const files = rest.slice(1);
  if (files.some((f) => f.startsWith('-'))) return null;
  return filesOrStdin(files);
}

// jq builtins that read the environment or load modules are refused; jq cannot write or exec.
const JQ_FORBIDDEN = /\$ENV|\$__|\b(?:env|import|include|modulemeta|get_search_list|get_jq_origin|get_prog_origin)\b/;
function jqSpec(args: string[]): Spec | null {
  const o = options(args, {
    short: 'rcSjeanCMs',
    long: [
      '--raw-output',
      '--compact-output',
      '--sort-keys',
      '--join-output',
      '--exit-status',
      '--ascii-output',
      '--null-input',
      '--slurp',
      '--tab',
      '--monochrome-output',
      '--raw-output0',
    ],
    longValued: ['--indent', '--arg'],
  });
  if (!o || !o.positional.length) return null;
  if ((o.values.get('--indent') ?? []).some((v) => !/^\d$/.test(v))) return null;
  // `--arg NAME VALUE` takes two values; the generic parser consumed only NAME.
  if (o.values.has('--arg')) return null;
  const [filter, ...files] = o.positional;
  if (JQ_FORBIDDEN.test(filter!)) return null;
  if (has(o, '-n', '--null-input') && !files.length) return { paths: [] };
  return filesOrStdin(files);
}

function findSpec(args: string[]): Spec | null {
  const starts: string[] = [];
  let i = 0;
  for (; i < args.length && !args[i]!.startsWith('-') && args[i] !== '!'; i++) starts.push(args[i]!);
  const valued = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-wholename']);
  const flags = new Set(['-not', '!', '-print', '-a', '-and', '-o', '-or', '-print0', '-empty', '-xdev']);
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (flags.has(a)) continue;
    if (!valued.has(a)) return null;
    const v = args[++i];
    if (v === undefined) return null;
    if ((a === '-maxdepth' || a === '-mindepth') && !/^\d{1,4}$/.test(v)) return null;
    if (a === '-type' && !/^[fdlps](?:,[fdlps])*$/.test(v)) return null;
  }
  return { paths: (starts.length ? starts : ['.']).map((value) => ({ value, kind: 'dir' as const })) };
}

// --- git -------------------------------------------------------------------------------------
const GIT_FORMAT_OK = (v: string) => !/%G/.test(v);
/** A git revision/pathspec argument: stays relative, never names a secret, no pathspec magic. */
function gitPositional(value: string): boolean {
  // Pathspec globs and magic (`*.env`, `:(glob)`, `:!x`) could select secret files by pattern.
  if (!value || value.startsWith('-') || value.startsWith(':') || path.isAbsolute(value)) return false;
  if (/[*?[\]\\]/.test(value)) return false;
  const parts = value.split(':');
  return parts.every((part) => {
    if (path.isAbsolute(part) && part !== '') return false;
    return part.split('/').every((seg) => seg !== '..' && !secretSegment.test(seg));
  });
}
const GIT_LOG_LONG = [
  '--oneline',
  '--decorate',
  '--no-decorate',
  '--graph',
  '--all',
  '--branches',
  '--tags',
  '--remotes',
  '--stat',
  '--shortstat',
  '--numstat',
  '--name-only',
  '--name-status',
  '--patch',
  '--no-patch',
  '--abbrev-commit',
  '--no-abbrev-commit',
  '--no-merges',
  '--merges',
  '--first-parent',
  '--reverse',
  '--date-order',
  '--topo-order',
  '--follow',
  '--no-color',
  '--summary',
  '--full-history',
  '--simplify-by-decoration',
  '--left-right',
  '--cherry-pick',
  '--boundary',
  '--no-renames',
  '--relative-date',
];
const GIT_LOG_VALUED = [
  '--max-count',
  '--skip',
  '--since',
  '--until',
  '--after',
  '--before',
  '--author',
  '--committer',
  '--grep',
  '--format',
  '--pretty',
  '--date',
  '--abbrev',
  '--decorate',
  '--color',
  '--stat',
];
const GIT_DIFF_LONG = [
  '--stat',
  '--cached',
  '--staged',
  '--name-only',
  '--name-status',
  '--shortstat',
  '--numstat',
  '--no-color',
  '--ignore-all-space',
  '--ignore-space-change',
  '--ignore-blank-lines',
  '--check',
  '--minimal',
  '--patience',
  '--histogram',
  '--summary',
  '--no-renames',
  '--patch',
  '--no-patch',
  '--merge-base',
  '--exit-code',
  '--quiet',
];
const GIT_DIFF_VALUED = ['--unified', '--diff-filter', '--word-diff', '--stat', '--color', '--abbrev'];
function gitSub(sub: string, args: string[]): { ok: boolean; printsUrls?: boolean } {
  const fail = { ok: false };
  const positionalOk = (o: Options) => o.positional.every(gitPositional);
  const formatsOk = (o: Options) =>
    [...(o.values.get('--format') ?? []), ...(o.values.get('--pretty') ?? [])].every(GIT_FORMAT_OK) &&
    (o.values.get('--color') ?? []).every((v) => v === 'never');
  const countsOk = (o: Options, names: string[]) =>
    names.every((n) => (o.values.get(n) ?? []).every((v) => /^\d{1,9}$/.test(v)));
  let o: Options | null;
  switch (sub) {
    case 'status':
      o = options(
        args.filter((a) => !['-uno', '-unormal', '-uall'].includes(a)),
        {
          short: 'sbvz',
          long: [
            '--short',
            '--branch',
            '--porcelain',
            '--long',
            '--ignored',
            '--ahead-behind',
            '--no-ahead-behind',
            '--show-stash',
            '--no-renames',
            '--renames',
          ],
          longValued: ['--porcelain', '--untracked-files'],
        },
      );
      return {
        ok:
          !!o &&
          positionalOk(o) &&
          (o.values.get('--porcelain') ?? []).every((v) => ['v1', 'v2'].includes(v)) &&
          (o.values.get('--untracked-files') ?? []).every((v) => ['no', 'normal', 'all'].includes(v)),
      };
    case 'log': {
      const digits = args.filter((a) => /^-\d{1,9}$/.test(a));
      o = options(
        args.filter((a) => !digits.includes(a)),
        { short: 'p', shortValued: 'n', long: GIT_LOG_LONG, longValued: GIT_LOG_VALUED },
      );
      return {
        ok: !!o && positionalOk(o) && formatsOk(o) && countsOk(o, ['-n', '--max-count', '--skip', '--abbrev']),
      };
    }
    case 'show':
      o = options(args, {
        short: 'sp',
        long: GIT_LOG_LONG.filter((f) => !['--all', '--branches', '--tags', '--remotes', '--follow'].includes(f)),
        longValued: ['--format', '--pretty', '--date', '--abbrev', '--color', '--stat'],
      });
      return { ok: !!o && positionalOk(o) && formatsOk(o) && countsOk(o, ['--abbrev']) };
    case 'diff':
      o = options(args, { short: 'wbR', shortValued: 'U', long: GIT_DIFF_LONG, longValued: GIT_DIFF_VALUED });
      return {
        ok:
          !!o &&
          positionalOk(o) &&
          formatsOk(o) &&
          countsOk(o, ['-U', '--unified', '--abbrev']) &&
          (o.values.get('--word-diff') ?? []).every((v) => ['plain', 'color', 'porcelain', 'none'].includes(v)) &&
          (o.values.get('--diff-filter') ?? []).every((v) => /^[ACDMRTUXBacdmrtuxb*]+$/.test(v)),
      };
    case 'branch':
    case 'tag': {
      const nFlags = args.filter((a) => sub === 'tag' && /^-n\d{0,4}$/.test(a));
      o = options(
        args.filter((a) => !nFlags.includes(a)),
        sub === 'branch'
          ? {
              short: 'larv',
              long: [
                '--show-current',
                '--list',
                '--all',
                '--remotes',
                '--verbose',
                '--no-color',
                '--no-column',
                '--merged',
                '--no-merged',
              ],
              longValued: ['--sort', '--format', '--contains', '--no-contains', '--points-at', '--color'],
            }
          : {
              short: 'l',
              long: ['--list', '--no-column', '--no-color', '--merged', '--no-merged'],
              longValued: ['--sort', '--format', '--contains', '--no-contains', '--points-at', '--color'],
            },
      );
      // Positionals are ref name patterns here (fnmatch on refs), never pathspecs.
      if (!o || !formatsOk(o) || !o.positional.every((p) => /^[A-Za-z0-9][A-Za-z0-9._/*?-]*$/.test(p))) return fail;
      // Without --list a positional name creates a branch or tag.
      if (o.positional.length && !has(o, '-l', '--list')) return fail;
      return { ok: true };
    }
    case 'describe':
      o = options(args, {
        long: ['--tags', '--long', '--always', '--all', '--dirty', '--exact-match', '--first-parent', '--contains'],
        longValued: ['--abbrev', '--match', '--exclude', '--candidates', '--dirty'],
      });
      return { ok: !!o && positionalOk(o) && countsOk(o, ['--abbrev', '--candidates']) };
    case 'rev-parse':
      o = options(args, {
        short: 'q',
        long: [
          '--show-toplevel',
          '--abbrev-ref',
          '--short',
          '--verify',
          '--git-dir',
          '--git-common-dir',
          '--absolute-git-dir',
          '--is-inside-work-tree',
          '--is-inside-git-dir',
          '--is-bare-repository',
          '--show-prefix',
          '--show-cdup',
          '--symbolic-full-name',
          '--quiet',
        ],
        longValued: ['--short', '--abbrev-ref'],
      });
      return {
        ok:
          !!o &&
          positionalOk(o) &&
          countsOk(o, ['--short']) &&
          (o.values.get('--abbrev-ref') ?? []).every((v) => ['strict', 'loose'].includes(v)),
      };
    case 'show-ref':
      o = options(args, {
        short: 'ds',
        long: ['--tags', '--heads', '--head', '--dereference', '--hash', '--abbrev', '--verify', '--exists'],
        longValued: ['--hash', '--abbrev'],
      });
      return { ok: !!o && positionalOk(o) && countsOk(o, ['--hash', '--abbrev']) };
    case 'ls-files':
      o = options(args, {
        short: 'cdmoskuz',
        long: [
          '--cached',
          '--deleted',
          '--modified',
          '--others',
          '--stage',
          '--killed',
          '--unmerged',
          '--exclude-standard',
          '--full-name',
          '--directory',
          '--no-empty-directory',
          '--error-unmatch',
          '--eol',
        ],
      });
      return { ok: !!o && positionalOk(o) };
    case 'remote':
      if (!args.length) return { ok: true };
      if (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) return { ok: true, printsUrls: true };
      if (args.length === 2 && args[0] === 'get-url' && gitPositional(args[1]!)) return { ok: true, printsUrls: true };
      return fail;
    case 'config': {
      const key = args.length === 2 && (args[0] === '--get' || args[0] === 'get') ? args[1]! : undefined;
      if (!key || !/^[A-Za-z][A-Za-z0-9-]*(?:\.[^\s=]+)?\.[A-Za-z][A-Za-z0-9-]*$/.test(key)) return fail;
      const section = key.slice(0, key.indexOf('.')).toLowerCase();
      const name = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
      if (['credential', 'http', 'https', 'sendemail', 'url', 'gpg'].includes(section)) return fail;
      if (/token|pass|secret|auth|cookie|header|key$/.test(name)) return fail;
      return { ok: true, printsUrls: /url$/.test(name) };
    }
    case 'blame':
      o = options(args, {
        short: 'wsle',
        shortValued: 'L',
        long: ['--porcelain', '--line-porcelain', '--root', '--show-name', '--show-number', '--show-email'],
      });
      return {
        ok:
          !!o &&
          o.positional.length >= 1 &&
          positionalOk(o) &&
          (o.values.get('-L') ?? []).every((v) => /^\d{1,9}(?:,[+-]?\d{1,9})?$/.test(v)),
      };
    default:
      return fail;
  }
}
async function gitSpec(args: string[], ctx: Ctx): Promise<Spec | null> {
  let cwd = ctx.cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs'].includes(a)) continue;
    if (a === '-C') {
      const dir = args[++i];
      if (dir === undefined || !(await safePath(dir, cwd, ctx.root, 'dir'))) return null;
      cwd = await realpath(path.resolve(cwd, dir));
      continue;
    }
    break;
  }
  const sub = args[i];
  if (sub === '--version' && i === args.length - 1 && i === 0) return { paths: [] };
  if (sub === undefined || sub.startsWith('-')) return null;
  const verdict = gitSub(sub, args.slice(i + 1));
  if (!verdict.ok) return null;
  return { paths: [], git: { cwd, printsUrls: verdict.printsUrls } };
}

// --- simple commands -------------------------------------------------------------------------
const VERSION_BINARIES = new Set(['git', 'rg', 'jq', 'grep', 'sed', 'find', 'bash', 'file', 'python3', 'node']);
async function spec(name: string, args: string[], ctx: Ctx): Promise<Spec | null> {
  if (args.length === 1 && args[0] === '--version' && VERSION_BINARIES.has(name)) return { paths: [] };
  switch (name) {
    case 'pwd':
    case 'id':
    case 'whoami':
    case 'uptime':
    case 'true':
    case 'nproc':
      return args.length === 0 ? { paths: [] } : null;
    case 'uname':
      return args.length <= 1 && args.every((a) => ['-a', '-s', '-r', '-m', '-n', '-o'].includes(a))
        ? { paths: [] }
        : null;
    case 'free':
      return args.length <= 1 && args.every((a) => ['-h', '-m', '-g'].includes(a)) ? { paths: [] } : null;
    case 'df':
      return args.length === 1 && ['-h', '-H'].includes(args[0]!) ? { paths: [] } : null;
    case 'pactl':
      return (args.length === 1 && ['info', 'list', 'get-default-source', 'get-default-sink'].includes(args[0]!)) ||
        (args.length === 2 &&
          args[0] === 'list' &&
          ['sources', 'sinks', 'cards', 'short', 'short-sources', 'short-sinks', 'short-cards'].includes(args[1]!))
        ? { paths: [] }
        : null;
    case 'wpctl':
      return (args.length === 1 && args[0] === 'status') ||
        (args.length === 2 &&
          args[0] === 'get-volume' &&
          (/^\d+$/.test(args[1]!) || ['@DEFAULT_AUDIO_SOURCE@', '@DEFAULT_AUDIO_SINK@'].includes(args[1]!)))
        ? { paths: [] }
        : null;
    case 'date':
      // Only display formats; -s/--set and -f/--file are refused.
      return args.every(
        (a) => a.startsWith('+') || ['-u', '-I', '-R', '--utc', '--iso-8601', '--rfc-3339=seconds'].includes(a),
      )
        ? { paths: [] }
        : null;
    case 'echo':
      return args.every((a) => !/^-[neE]+$/.test(a)) ? { paths: [] } : null;
    case 'printf':
      // A literal format; %n does not exist in coreutils printf, and no %b escapes from data.
      return args.length >= 1 && !args[0]!.startsWith('-') ? { paths: [] } : null;
    case 'which':
      return args.length >= 1 && args.every((a) => /^[A-Za-z0-9._+-]+$/.test(a) && !a.startsWith('-'))
        ? { paths: [] }
        : null;
    case 'ls': {
      const o = options(args, {
        short: 'laAhtrSR1dFiG',
        long: ['--all', '--almost-all', '--human-readable', '--color=never', '--group-directories-first'],
      });
      if (!o) return null;
      // Listing prints names only, never contents: recursion needs no secret walk.
      return { paths: o.positional.map((value) => ({ value, kind: 'any' as const })) };
    }
    case 'tree': {
      const o = options(args, { short: 'adfiC', shortValued: 'L', long: ['--noreport', '--dirsfirst'] });
      if (!o || (o.values.get('-L') ?? []).some((v) => !/^\d{1,3}$/.test(v))) return null;
      return {
        paths: (o.positional.length ? o.positional : ['.']).map((value) => ({ value, kind: 'dir' as const })),
      };
    }
    case 'cat': {
      const o = options(args, { short: 'nbsAvET' });
      return o ? filesOrStdin(o.positional) : null;
    }
    case 'head':
    case 'tail':
      return headTail(name, args);
    case 'wc': {
      const o = options(args, { short: 'lwcmL', long: ['--lines', '--words', '--bytes', '--chars'] });
      return o ? filesOrStdin(o.positional) : null;
    }
    case 'sort': {
      const o = options(args, {
        short: 'nrufbdhVMRsz',
        shortValued: 'kt',
        long: ['--numeric-sort', '--reverse', '--unique', '--human-numeric-sort', '--version-sort', '--ignore-case'],
      });
      return o ? filesOrStdin(o.positional) : null;
    }
    case 'uniq': {
      const o = options(args, { short: 'cdui', shortValued: 'fsw', long: ['--count', '--repeated', '--unique'] });
      // A second positional is an output file.
      if (!o || o.positional.length > 1) return null;
      return filesOrStdin(o.positional);
    }
    case 'cut': {
      const o = options(args, { short: 's', shortValued: 'dfcb', long: ['--only-delimited'] });
      return o ? filesOrStdin(o.positional) : null;
    }
    case 'tr': {
      const o = options(args, { short: 'dsc' });
      return o && o.positional.length >= 1 && o.positional.length <= 2 ? { paths: [], stdin: true } : null;
    }
    case 'basename':
    case 'dirname':
      return args.length >= 1 && args.every((a) => !a.startsWith('-')) ? { paths: [] } : null;
    case 'realpath': {
      const o = options(args, { short: 'eqs', long: ['--relative-to=.'] });
      return o && o.positional.length
        ? { paths: o.positional.map((value) => ({ value, kind: 'any' as const })) }
        : null;
    }
    case 'stat': {
      const o = options(args, {
        short: 'L',
        shortValued: 'c',
        long: ['--dereference'],
        longValued: ['--format', '--printf'],
      });
      return o && o.positional.length
        ? { paths: o.positional.map((value) => ({ value, kind: 'any' as const })) }
        : null;
    }
    case 'file': {
      const o = options(args, { short: 'bLi', long: ['--brief', '--mime', '--mime-type', '--dereference'] });
      return o && o.positional.length
        ? { paths: o.positional.map((value) => ({ value, kind: 'any' as const })) }
        : null;
    }
    case 'du': {
      const o = options(args, { short: 'shcab', shortValued: 'd', longValued: ['--max-depth'] });
      if (
        !o ||
        [...(o.values.get('-d') ?? []), ...(o.values.get('--max-depth') ?? [])].some((v) => !/^\d{1,3}$/.test(v))
      )
        return null;
      return { paths: (o.positional.length ? o.positional : ['.']).map((value) => ({ value, kind: 'any' as const })) };
    }
    case 'find':
      return findSpec(args);
    case 'grep':
      return grepSpec(args);
    case 'rg':
      return rgSpec(args);
    case 'sed':
      return sedSpec(args);
    case 'jq':
      return jqSpec(args);
    case 'git':
      return gitSpec(args, ctx);
    default:
      return null;
  }
}

/** Exactly the query Adelic suggests to agents (server/graphify.ts graphifyContext). */
async function graphifyQuery(argv: string[], ctx: Ctx): Promise<boolean | null> {
  const trusted = ctx.input.graphify;
  if (!trusted?.binary || !trusted.graphsRoot) return null;
  const [name, sub, term, graphFlag, graph, budgetFlag, budget, ...extra] = argv;
  if (!name) return null;
  const [binary, expected] = await Promise.all([resolveAny(name, ctx.cwd), realpath(trusted.binary).catch(() => null)]);
  if (!binary || !expected || binary !== expected) return path.basename(name) === 'graphify' ? false : null;
  if (sub !== 'query' || term === undefined || term.startsWith('-') || extra.length) return false;
  if (graphFlag !== '--graph' || budgetFlag !== '--budget' || graph === undefined || budget === undefined) return false;
  if (!/^\d{1,4}$/.test(budget) || Number(budget) < 1 || Number(budget) > 5000) return false;
  try {
    const [graphsRoot, graphReal] = await Promise.all([
      realpath(trusted.graphsRoot),
      realpath(path.resolve(ctx.cwd, graph)),
    ]);
    if (!graphReal.startsWith(graphsRoot + path.sep) || path.basename(graphReal) !== 'graph.json') return false;
    return (await stat(graphReal)).isFile();
  } catch {
    return false;
  }
}

async function checkPaths(spec: Spec, ctx: Ctx): Promise<string | undefined> {
  for (const p of spec.paths) {
    if (!(await safePath(p.value, ctx.cwd, ctx.root, p.kind)))
      return 'Caminho inexistente, externo, oculto ou sensível.';
    if (!p.tree) continue;
    const real = await realpath(path.resolve(ctx.cwd, p.value));
    if (!(await stat(real)).isDirectory()) continue;
    if (p.tree === 'follow') return 'Busca recursiva seguindo links simbólicos exige confirmação.';
    if (!(await secretFreeTree(real, p.tree, p.skipDirs ?? [], ctx)))
      return 'A busca recursiva alcançaria arquivos sensíveis ou ocultos.';
  }
  return undefined;
}

/** Classifies one simple command of a restricted script; undefined means auto. */
async function classifySimple(command: SimpleCommand, ctx: Ctx): Promise<string | undefined> {
  const [first, ...args] = command.argv;
  if (!first) return 'Comando vazio.';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return 'Atribuição de variável de ambiente exige confirmação.';
  const graph = await graphifyQuery(command.argv, ctx);
  if (graph === true) return undefined;
  if (graph === false) return 'Graphify só é automático na consulta exata sugerida pelo Adelic.';
  if (
    ['bash', 'sh', 'zsh', 'dash', 'env', 'eval', 'source', '.', 'exec', 'xargs', 'sudo'].includes(path.basename(first))
  )
    return 'Wrapper de shell ou executor de comandos exige confirmação.';
  let name = first;
  if (name.includes('/')) {
    const resolved = await executable(name);
    if (!resolved) return 'Executável não está na allowlist nativa canônica.';
    name = path.basename(resolved);
  } else if (!(await executable(name, ctx.cwd))) return 'Executável não está na allowlist nativa canônica.';
  const result = await spec(name, args, ctx);
  if (!result) return `Comando ou argumentos fora da allowlist (${name}).`;
  if (result.stdin && !command.pipedStdin) return 'Leitura da entrada padrão fora de um pipeline exige confirmação.';
  const pathIssue = await checkPaths(result, ctx);
  if (pathIssue) return pathIssue;
  if (result.git) {
    const verdict = await gitConfigSafety(result.git.cwd, ctx.root, ctx.input.gitConfig);
    if (!verdict.safe) return `Git exige confirmação: ${verdict.reason}.`;
    if (result.git.printsUrls && verdict.credentialUrl)
      return 'Git exige confirmação: uma URL remota contém credenciais.';
  }
  return undefined;
}

export async function classifyApproval(input: ApprovalInput): Promise<ApprovalResult> {
  if (input.tools !== true) return deny('Solicitação sem ferramentas válidas disponíveis.');
  if (input.mode === 'manual') return pending('Modo manual exige confirmação.');
  if (input.kind !== 'command') return pending('Este tipo de solicitação exige confirmação.');
  if (input.networkApprovalContext != null) return pending('Contexto de aprovação de rede exige confirmação.');
  if (typeof input.command !== 'string' || typeof input.cwd !== 'string')
    return pending('Comando ou diretório ausente/ambíguo.');
  let root: string, cwd: string;
  try {
    root = await realpath(input.workspace);
    cwd = await realpath(input.cwd);
  } catch {
    return pending('Workspace ou diretório não existe.');
  }
  if (cwd !== root && !cwd.startsWith(root + path.sep)) return pending('Diretório fora do workspace.');
  const parsed = parseShell(input.command, { portable: input.portableShell === true });
  if (!parsed.ok) return pending(`Sintaxe de shell não suportada: ${parsed.reason}`);
  const { commands } = parsed.script;
  // One canonical non-login bash layer, only in the Codex-internal trusted context.
  const only = commands.length === 1 ? commands[0]! : undefined;
  const head = only?.argv[0];
  if (only && head && ['bash', '/bin/bash', '/usr/bin/bash'].includes(head)) {
    if (!input.trustedNonLoginShell) return pending('Wrapper de shell exige confirmação.');
    if (only.redirects.length) return pending('Wrapper de shell não canônico.');
    const args = only.argv.slice(1);
    const script =
      args.length === 2 && args[0] === '-c'
        ? args[1]
        : args.length === 4 && args[0] === '--noprofile' && args[1] === '--norc' && args[2] === '-c'
          ? args[3]
          : undefined;
    if (script === undefined) return pending('Wrapper de shell não canônico.');
    const resolved = await executable(head, cwd);
    if (!resolved || !['/bin/bash', '/usr/bin/bash'].includes(resolved))
      return pending('Wrapper de shell não canônico.');
    return classifyApproval({ ...input, command: script, trustedNonLoginShell: false });
  }
  const ctx: Ctx = { cwd, root, input };
  const names: string[] = [];
  for (const command of commands) {
    const reason = await classifySimple(command, ctx);
    if (reason) return pending(commands.length > 1 ? `${reason} [${command.argv[0]}]` : reason);
    names.push(path.basename(command.argv[0]!));
  }
  return {
    decision: 'auto',
    reason: `Comando de leitura permitido: ${[...new Set(names)].join(', ')}.`,
  };
}
