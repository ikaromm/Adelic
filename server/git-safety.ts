// Read-only inspection of git configuration for the safe-command classifier. Codex and Kiro run
// git themselves, so Adelic cannot add `-c` overrides: a read-only subcommand is auto-approved
// only when no configuration layer it reads can make git run another program.
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONFIG_MAX_BYTES = 256 * 1024;

/** Why a git configuration can execute programs, or undefined when it cannot. */
export type GitConfigVerdict =
  | {
      safe: true;
      /** A remote URL in some layer carries credentials: commands that print URLs must ask. */
      credentialUrl?: boolean;
    }
  | { safe: false; reason: string };

// http(s)/ftp URLs with any userinfo, or any URL whose userinfo has a password part.
const CREDENTIAL_URL = /\b(?:https?|ftps?):\/\/[^\s/@"]+@|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@":]+:[^\s/@"]*@/i;

// Keys (section[.subsection].name, lowercased) through which the allowed read-only subcommands
// can run a program or read outside the project. Keys only used by network, editing, merging or
// signing operations (credential helpers, core.editor, mergetool) are not refused: those
// operations are never auto-approved. Aliases are not refused either: git ignores an alias that
// shadows a built-in command, and only built-in subcommands are auto-approved.
function riskyKey(section: string, subsection: string | undefined, name: string): boolean {
  if (section === 'include' || section === 'includeif') return true;
  if (section === 'filter' || section === 'submodule' || section === 'pager') return true;
  if (section === 'core')
    return ['fsmonitor', 'pager', 'sshcommand', 'hookspath', 'askpass', 'worktree', 'gitproxy'].includes(name);
  if (section === 'diff')
    return name === 'external' || (subsection !== undefined && ['command', 'textconv'].includes(name));
  if (section === 'log' && name === 'showsignature') return true;
  if (section === 'status' && name === 'submodulesummary') return true;
  return name === 'textconv';
}

/**
 * Bounded INI-ish reader. It understands `[section]`, `[section "sub"]`, `[section.sub]` and
 * `key = value` lines; anything it cannot read is reported as unsafe instead of skipped.
 */
export function inspectGitConfig(text: string, label: string): GitConfigVerdict {
  let section = '';
  const credentialUrl = CREDENTIAL_URL.test(text);
  let subsection: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(line);
      if (!header) return { safe: false, reason: `configuração do git ilegível em ${label}` };
      const [, name, sub, rest] = header;
      const dot = name!.indexOf('.');
      section = (dot >= 0 ? name!.slice(0, dot) : name!).toLowerCase();
      subsection = sub ?? (dot >= 0 ? name!.slice(dot + 1) : undefined);
      line = rest!.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    }
    if (!section) return { safe: false, reason: `configuração do git ilegível em ${label}` };
    const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/.exec(line);
    if (!key) return { safe: false, reason: `configuração do git ilegível em ${label}` };
    // A value continued on the next line could hide a key; refuse it.
    if (line.endsWith('\\')) return { safe: false, reason: `configuração do git com continuação em ${label}` };
    if (riskyKey(section, subsection, key[1]!.toLowerCase()))
      return {
        safe: false,
        reason: `a configuração do git deste repositório pode executar programas (${section}${subsection !== undefined ? `.${subsection}` : ''}.${key[1]} em ${label})`,
      };
  }
  return credentialUrl ? { safe: true, credentialUrl } : { safe: true };
}

export async function readConfig(file: string): Promise<string | undefined | null> {
  // undefined = absent, null = present but unreadable/oversized
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > CONFIG_MAX_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : null;
  }
}

/**
 * Locates the repository's git dir and common dir from `cwd` up to `root`, without running
 * git. A repository above the project root is not used: git would read outside the project.
 */
async function gitDirs(
  cwd: string,
  root: string,
): Promise<{ top: string; gitDir: string; commonDir: string } | undefined> {
  for (let current = cwd; ; current = path.dirname(current)) {
    if (current !== root && !current.startsWith(root + path.sep)) return undefined;
    const dotGit = path.join(current, '.git');
    let info;
    try {
      info = await stat(dotGit);
    } catch {
      continue;
    }
    let gitDir = dotGit;
    if (info.isFile()) {
      const text = await readConfig(dotGit);
      const match = typeof text === 'string' ? /^gitdir: (.+)$/m.exec(text) : null;
      if (!match) return undefined;
      gitDir = path.resolve(current, match[1]!.trim());
    } else if (!info.isDirectory()) return undefined;
    gitDir = await realpath(gitDir).catch(() => gitDir);
    let commonDir = gitDir;
    const common = await readConfig(path.join(gitDir, 'commondir'));
    if (common === null) return undefined;
    if (typeof common === 'string') commonDir = await realpath(path.resolve(gitDir, common.trim())).catch(() => '');
    if (!commonDir) return undefined;
    return { top: current, gitDir, commonDir };
  }
}

export interface GitConfigSources {
  home?: string;
  systemConfig?: string;
  env?: NodeJS.ProcessEnv;
}

/** System and global configuration files, with a label for messages. */
export function globalGitConfigFiles(sources: GitConfigSources = {}): [string, string][] {
  const env = sources.env ?? process.env;
  const home = sources.home ?? os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    [sources.systemConfig ?? '/etc/gitconfig', 'configuração do sistema'],
    [path.join(xdg, 'git', 'config'), 'configuração global'],
    [path.join(home, '.gitconfig'), 'configuração global'],
  ];
}

/**
 * Ignore files git and ripgrep read outside the tree: the default global excludes file and,
 * when `core.excludesFile` is set anywhere, `undefined` (an unverified location).
 */
export async function globalIgnoreFiles(sources: GitConfigSources = {}): Promise<string[] | undefined> {
  for (const [file] of globalGitConfigFiles(sources)) {
    const text = await readConfig(file);
    if (text === null) return undefined;
    if (text !== undefined && /^\s*excludesfile\s*=/im.test(text)) return undefined;
  }
  const env = sources.env ?? process.env;
  const home = sources.home ?? os.homedir();
  return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'ignore')];
}

/**
 * Checks every configuration layer a read-only git command in `cwd` would read: system,
 * global (~/.gitconfig and XDG), repository and per-worktree config. Environment variables
 * that redirect or add configuration, or run programs, also make it unsafe.
 */
export async function gitConfigSafety(
  cwd: string,
  root: string,
  sources: GitConfigSources = {},
): Promise<GitConfigVerdict> {
  const env = sources.env ?? process.env;
  for (const name of Object.keys(env)) {
    if (
      /^GIT_(?:CONFIG|CONFIG_.*|EXTERNAL_DIFF|PAGER|SSH|SSH_COMMAND|ASKPASS|EXEC_PATH|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|PROXY_COMMAND|TRACE.*)$/.test(
        name,
      ) &&
      env[name]
    )
      return { safe: false, reason: `a variável ${name} altera o comportamento do git` };
  }
  const files = globalGitConfigFiles(sources);
  const dirs = await gitDirs(cwd, root);
  if (!dirs) return { safe: false, reason: 'repositório git não localizado dentro do projeto' };
  // Submodules are separate repositories with their own configuration.
  if ((await readConfig(path.join(dirs.top, '.gitmodules'))) !== undefined)
    return { safe: false, reason: 'repositório com submódulos (configuração própria não verificada)' };
  files.push([path.join(dirs.commonDir, 'config'), 'configuração do repositório']);
  if (dirs.gitDir !== dirs.commonDir)
    files.push([path.join(dirs.gitDir, 'config.worktree'), 'configuração da worktree']);
  let credentialUrl = false;
  for (const [file, label] of files) {
    const text = await readConfig(file);
    if (text === undefined) continue;
    if (text === null) return { safe: false, reason: `não foi possível ler a ${label}` };
    const verdict = inspectGitConfig(text, label);
    if (!verdict.safe) return verdict;
    credentialUrl ||= Boolean(verdict.credentialUrl);
  }
  // Attributes can bind diff drivers/filters by path: refuse when a repository-level
  // attributes file exists outside the worktree (info/attributes); .gitattributes in the tree
  // only references drivers that must also be configured, which the checks above refuse.
  if ((await readConfig(path.join(dirs.commonDir, 'info', 'attributes'))) !== undefined)
    return { safe: false, reason: 'atributos do git no repositório podem associar programas' };
  // Read-only commands can still refresh and write the index (git status) or update refs:
  // hooks bound to those events would run.
  for (const hook of ['post-index-change', 'reference-transaction'])
    if ((await readConfig(path.join(dirs.commonDir, 'hooks', hook))) !== undefined)
      return { safe: false, reason: `hook ${hook} do repositório pode executar programas` };
  return credentialUrl ? { safe: true, credentialUrl } : { safe: true };
}
