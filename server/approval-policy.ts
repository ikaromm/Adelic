import { realpath, access, stat, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

function parse(line: string): string[] | null {
  // Conservative rejection before tokenization: no line splitting or glob/tilde expansion, even quoted.
  if (/[\r\n*?[\]{}~]/.test(line)) return null;
  const out: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = '';
        continue;
      }
      if ('$`\\'.includes(c)) return null;
      word += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started) {
        out.push(word);
        word = '';
        started = false;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (';&|<>`$\\()'.includes(c)) return null;
    word += c;
    started = true;
  }
  if (quote) return null;
  if (started) out.push(word);
  return out.length ? out : null;
}
const secretSegment =
  /^(?:\.env.*|\.ssh|\.aws|\.codex|\.config|\.gnupg|\.netrc|\.npmrc|\.pypirc|auth(?:entication)?\.json|credentials?\.json|cookies?\.json|tokens?\.json|id_rsa|id_ed25519|.*\.(?:pem|key))$/i;
function safeLexical(value: string): boolean {
  return (
    !path.isAbsolute(value) &&
    value
      .split(/[\\/]+/)
      .every((p) => p !== '..' && !(p.startsWith('.') && p !== '.' && p !== '..') && !secretSegment.test(p))
  );
}
async function safePath(value: string, cwd: string, root: string, regular: boolean): Promise<boolean> {
  if (value.startsWith('-') || !safeLexical(value)) return false;
  const abs = path.resolve(cwd, value);
  try {
    const real = await realpath(abs);
    if (real !== root && !real.startsWith(root + path.sep)) return false;
    const rel = path.relative(root, real);
    if (
      rel
        .split(path.sep)
        .some((part) => (part.startsWith('.') && part !== '.' && part !== '..') || secretSegment.test(part))
    )
      return false;
    const info = await stat(real);
    return regular ? info.isFile() : info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
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
function allowed(name: string, args: string[]): boolean {
  if (['pwd', 'id', 'whoami', 'uptime'].includes(name)) return args.length === 0;
  if (name === 'uname') return args.length === 1 && ['-a', '-s', '-r', '-m'].includes(args[0]!);
  if (name === 'free') return args.length === 1 && ['-h', '-m'].includes(args[0]!);
  if (name === 'df') return args.length === 1 && args[0] === '-h';
  if (name === 'pactl')
    return (
      (args.length === 1 && ['info', 'list', 'get-default-source', 'get-default-sink'].includes(args[0]!)) ||
      (args.length === 2 &&
        args[0] === 'list' &&
        ['sources', 'sinks', 'cards', 'short', 'short-sources', 'short-sinks', 'short-cards'].includes(args[1]!))
    );
  if (name === 'wpctl')
    return (
      (args.length === 1 && args[0] === 'status') ||
      (args.length === 2 &&
        args[0] === 'get-volume' &&
        (/^\d+$/.test(args[1]!) || ['@DEFAULT_AUDIO_SOURCE@', '@DEFAULT_AUDIO_SINK@'].includes(args[1]!)))
    );
  if (name === 'ls') return args.every((a) => ['-l', '-a', '-la', '-al', '-h'].includes(a) || !a.startsWith('-'));
  if (name === 'cat') return args.length > 0 && args.every((a) => !a.startsWith('-'));
  if (name === 'head' || name === 'tail')
    return args.length > 0 && args.every((a) => !a.startsWith('-') || /^-\d+$/.test(a) || /^-[nc]\d+$/.test(a));
  if (name === 'rg') {
    const flags = new Set(['--no-config', '-n', '-i', '-w', '-F', '-l', '-H', '-S']);
    if (!args.includes('--no-config') || args.some((a) => a.startsWith('-') && !flags.has(a))) return false;
    const pos = args.filter((a) => !flags.has(a));
    return pos.length >= 2;
  }
  return false;
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
  const argv = parse(input.command);
  if (!argv) return pending('Sintaxe de shell ambígua ou não suportada.');
  // `name` is narrowed below when a trusted bash wrapper is unwrapped; `args` never changes.
  const [first, ...args] = argv;
  let name = first;
  if (name === 'bash' || name === '/bin/bash' || name === '/usr/bin/bash') {
    if (!input.trustedNonLoginShell) return pending('Wrapper de shell exige confirmação.');
    const script =
      args.length === 2 && args[0] === '-c'
        ? args[1]
        : args.length === 4 && args[0] === '--noprofile' && args[1] === '--norc' && args[2] === '-c'
          ? args[3]
          : undefined;
    if (script === undefined) return pending('Wrapper de shell não canônico.');
    const resolved = await executable(name, cwd);
    if (!resolved || !['/bin/bash', '/usr/bin/bash'].includes(resolved))
      return pending('Wrapper de shell não canônico.');
    return classifyApproval({ ...input, command: script, trustedNonLoginShell: false });
  }
  if (name === 'sh') return pending('Wrapper de shell exige confirmação.');
  if (!name) return pending('Executável não está na allowlist nativa canônica.');
  if (name.includes('/')) {
    const resolved = await executable(name);
    if (!resolved) return pending('Executável não está na allowlist nativa canônica.');
    name = path.basename(resolved);
  } else if (!(await executable(name, cwd))) return pending('Executável não está na allowlist nativa canônica.');
  if (!allowed(name, args)) return pending('Comando ou argumentos fora da allowlist.');
  let paths: string[] = [];
  if (['ls', 'cat', 'head', 'tail'].includes(name)) paths = args.filter((a) => !a.startsWith('-'));
  if (name === 'rg')
    paths = args.filter((a) => a !== '--no-config' && !['-n', '-i', '-w', '-F', '-l', '-H', '-S'].includes(a)).slice(1);
  for (const p of paths)
    if (!(await safePath(p, cwd, root, name !== 'ls')))
      return pending('Caminho inexistente, externo, não regular ou sensível.');
  return { decision: 'auto', reason: `Comando de leitura permitido: ${name}.` };
}
