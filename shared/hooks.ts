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
  /** Effective configured deadline; retained to distinguish homonymous checks with different limits. */
  timeoutSec?: number;
  status: CheckStatus;
  exitCode?: number | null;
  durationMs?: number;
  /** Last CHECK_OUTPUT_MAX characters of stdout and stderr, interleaved. */
  output?: string;
  truncated?: boolean;
  /** Why it could not run, or why it was cancelled. */
  detail?: string;
  /** Per-invocation source/environment observations; absent on legacy or settings-test events. */
  source?: import('./contracts.js').CheckSource;
  environment?: import('./contracts.js').CheckEnvironmentEvidence;
  /** Private operational log stored outside the project; full output is retrieved on demand. */
  operationalLog?: { status: 'available' | 'truncated' | 'unavailable'; bytes?: number };
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

/** Split the outer command into shell words without normalizing quoted script content. */
function shellWords(text: string): string[] | undefined {
  if (text.length > 256 * 8192) return undefined;
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\') {
        const next = text[++i];
        if (next === undefined) return undefined;
        word += next;
      } else word += c;
      started = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\') {
      const next = text[++i];
      if (next === undefined) return undefined;
      word += next;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

const shellName = (value: string) => value.split('/').at(-1);
const isShell = (value: string) => ['bash', 'sh', 'zsh', 'dash'].includes(shellName(value) ?? '');

/** Recognize a shell -c wrapper by argv boundaries, not by normalized text or a fixed flag shape. */
function wrappedScript(text: string): string | undefined {
  const words = shellWords(text);
  if (!words?.length) return undefined;
  let index = 0;
  if (shellName(words[0]!) === 'env') {
    index++;
    while (index < words.length) {
      const value = words[index]!;
      if (value.startsWith('-')) {
        if (value === '-u' || value === '--unset' || value === '-C' || value === '--chdir') index += 2;
        else if (value === '-S' || value === '--split-string') {
          const split = shellWords(words[index + 1] ?? '');
          if (!split?.length) return undefined;
          words.splice(index, 2, ...split);
        } else if (value.startsWith('--split-string=')) {
          const split = shellWords(value.slice('--split-string='.length));
          if (!split?.length) return undefined;
          words.splice(index, 1, ...split);
        } else index++;
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) index++;
      else break;
    }
  }
  if (index >= words.length || !isShell(words[index]!)) return undefined;
  let hasCommandOption = false;
  let commandIndex = -1;
  for (let i = index + 1; i < words.length; i++) {
    const option = words[i]!;
    if (option === '--command') {
      hasCommandOption = true;
      continue;
    }
    if (option === '--') {
      if (!hasCommandOption || i + 1 >= words.length) return undefined;
      commandIndex = i + 1;
      break;
    }
    if (option === '+O' || option === '+o') {
      i++;
      continue;
    }
    if (option.startsWith('-') && option !== '-') {
      // Short options may be grouped; -o/-O consume their following word even when -c is grouped.
      if (option.startsWith('--')) {
        if (option === '--rcfile' || option === '--init-file') i++;
        continue;
      }
      let hasOptionArgument = false;
      for (const flag of option.slice(1)) {
        if (flag === 'c') hasCommandOption = true;
        if (flag === 'o' || flag === 'O') {
          hasOptionArgument = true;
          break;
        }
      }
      if (hasOptionArgument) i++;
      continue;
    }
    if (!hasCommandOption) return undefined;
    commandIndex = i;
    break;
  }
  if (commandIndex < 0) return undefined;
  return words[commandIndex];
}

/** Candidate extraction preserves shell quoting until wrapper scripts and segments are parsed. */
/** Split shell control operators only outside quoted or escaped word segments. */
function shellSegments(text: string): string[] | undefined {
  if (text.length > 256 * 8192) return undefined;
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c.charCodeAt(0) === 92) i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c.charCodeAt(0) === 92) {
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c.charCodeAt(0) === 10) {
      parts.push(text.slice(start, i));
      if ((c === '&' || c === '|') && text[i + 1] === c) i++;
      start = i + 1;
    }
  }
  if (quote) return undefined;
  parts.push(text.slice(start));
  return parts;
}

export function commandCandidates(command: string): string[] {
  const out = new Set<string>();
  const visited = new Set<string>();
  const visit = (text: string, depth: number) => {
    const whole = normalizeCommand(text);
    if (!whole || visited.has(text)) return;
    visited.add(text);
    out.add(whole);
    const wrapped = wrappedScript(text);
    if (wrapped !== undefined && depth < 3) visit(wrapped, depth + 1);
    for (const part of shellSegments(text) ?? []) {
      const source = part.replace(/^[\s({]+|[\s)}]+$/g, '');
      if (normalizeCommand(source) && depth < 3) visit(source, depth + 1);
    }
  };
  visit(command, 0);
  return [...out];
}

/** Render an argv vector without changing its argument boundaries for shell-wrapper matching. */
export function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || command.length === 0 || command.length > 256) return undefined;
  if (command.some((part) => typeof part !== 'string' || part.length > 8192)) return undefined;
  const quote = (part: string) =>
    /^[A-Za-z0-9_./:@%+=,-]+$/.test(part)
      ? part
      : "'" + part.split("'").join("'" + String.fromCharCode(92) + "''") + "'";
  return command.map(quote).join(' ');
}

/** The first blocked pattern the command matches, if any. */
export function blockedBy(
  patterns: readonly string[] | undefined,
  command: string | readonly string[] | undefined,
): string | undefined {
  if (!patterns?.length || command === undefined) return undefined;
  const text = commandText(command);
  if (!text?.trim()) return undefined;
  const candidates = commandCandidates(text);
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
