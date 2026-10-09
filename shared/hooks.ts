// Per-project hooks (docs/specs/project-hooks.md): checks that run after a run edits files,
// and command patterns that are always denied. The configuration lives only in Adelic's
// database; nothing here is ever read from the repository.

export const HOOK_CHECKS_MAX = 5;
export const HOOK_NAME_MAX = 60;
export const HOOK_COMMAND_MAX = 500;
export const HOOK_TIMEOUT_MIN = 5;
export const HOOK_TIMEOUT_MAX = 600;
export const HOOK_TIMEOUT_DEFAULT = 120;
export const BLOCKED_COMMANDS_MAX = 30;
export const BLOCKED_PATTERN_MAX = 200;
/** Output kept per check (the end of it). */
export const CHECK_OUTPUT_MAX = 64 * 1024;
/** Failure output sent to the automatic fix run. */
export const FIX_OUTPUT_MAX = 8 * 1024;

export interface AfterEditCheck {
  name: string;
  /** Run as `/bin/sh -c <command>` inside the project's sandbox. */
  command: string;
  timeoutSec: number;
  enabled: boolean;
}
export interface ProjectHooks {
  afterEdit: AfterEditCheck[];
  /** Glob-like patterns (`*` = any text); a matching approval request is denied. */
  blockedCommands: string[];
  /** "Corrigir automaticamente": one follow-up run when a check fails. Off by default. */
  autoFix: boolean;
}
export const EMPTY_HOOKS: ProjectHooks = { afterEdit: [], blockedCommands: [], autoFix: false };

export type CheckStatus = 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled' | 'error';
/** Result of one check, stored on its run event and returned by the test endpoint. */
export interface CheckResult {
  name: string;
  /** Configured command that was actually dispatched by the check runner. */
  command?: string;
  status: CheckStatus;
  exitCode?: number | null;
  durationMs?: number;
  /** Last CHECK_OUTPUT_MAX characters of stdout and stderr, interleaved. */
  output?: string;
  truncated?: boolean;
  /** Why it could not run, or why it was cancelled. */
  detail?: string;
}

/** Trims and collapses every run of whitespace (spaces, tabs, newlines) into one space. */
export function normalizeCommand(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whole-text glob match: `*` matches any run of characters (also empty); everything else is
 * literal, so a pattern can never act as a regular expression. Iterative, no backtracking blowup.
 */
export function globMatch(pattern: string, text: string) {
  let p = 0,
    t = 0,
    star = -1,
    mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

const SHELL_WRAPPER = /^(?:\S*\/)?(?:env\s+)?(?:bash|sh|zsh|dash)\s+(?:-[a-z]*c[a-z]*)\s+(['"])([\s\S]*)\1$/;

/**
 * Texts a command is checked against: the whole command, the script of a `bash -lc '…'`
 * wrapper, and each part split on `;`, `&&`, `||`, `|`, `&` and newlines. Splitting ignores
 * quoting on purpose: an extra candidate can only add a denial, never an approval.
 */
export function commandCandidates(command: string): string[] {
  const out = new Set<string>();
  const visit = (text: string, depth: number) => {
    const whole = normalizeCommand(text);
    if (!whole || out.has(whole)) return;
    out.add(whole);
    const wrapped = SHELL_WRAPPER.exec(whole);
    if (wrapped && depth < 3) visit(wrapped[1] === "'" ? wrapped[2].replaceAll(`'\\''`, "'") : wrapped[2], depth + 1);
    for (const part of text.split(/&&|\|\||[;|&\n]/)) {
      const normal = normalizeCommand(part.replace(/^[\s({]+|[\s)}]+$/g, ''));
      if (normal && normal !== whole && depth < 3) visit(normal, depth + 1);
    }
  };
  visit(command, 0);
  return [...out];
}

/** The first blocked pattern the command matches, if any. */
export function blockedBy(patterns: readonly string[] | undefined, command: string | undefined): string | undefined {
  if (!patterns?.length || typeof command !== 'string' || !command.trim()) return undefined;
  const candidates = commandCandidates(command);
  for (const raw of patterns) {
    const pattern = normalizeCommand(raw);
    if (pattern && candidates.some((candidate) => globMatch(pattern, candidate))) return raw;
  }
  return undefined;
}

/** Activity line for a check: "Verificação: testes passou (12 s)". */
export function checkHeadline(result: CheckResult) {
  const seconds = result.durationMs === undefined ? '' : ` (${Math.max(0, Math.round(result.durationMs / 1000))} s)`;
  const label = `Verificação: ${result.name}`;
  switch (result.status) {
    case 'running':
      return `${label} em andamento`;
    case 'passed':
      return `${label} passou${seconds}`;
    case 'failed':
      return `${label} falhou (código ${result.exitCode ?? '?'})`;
    case 'timeout':
      return `${label} excedeu o tempo limite${seconds}`;
    case 'cancelled':
      return `${label} cancelada${result.detail ? `: ${result.detail}` : ''}`;
    default:
      return `${label} não pôde rodar${result.detail ? `: ${result.detail}` : ''}`;
  }
}
