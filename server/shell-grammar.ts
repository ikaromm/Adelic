// Restricted shell grammar for the safe-command classifier (docs/specs/safe-command-approvals.md).
// It parses, never executes: a list of simple commands joined by `;`, `&&`, `||` and `|`, each
// with a fully literal argv. Anything the grammar does not understand fails closed.

export const SHELL_MAX_CHARS = 4000;
export const SHELL_MAX_COMMANDS = 12;

/** The only redirections accepted: they cannot read, write or execute anything. */
export type SafeRedirect = '2>/dev/null' | '2>&1' | '>/dev/null';
export interface SimpleCommand {
  argv: string[];
  redirects: SafeRedirect[];
  /** True when the command is on the right side of a pipe (its stdin is the previous output). */
  pipedStdin: boolean;
}
export interface ShellScript {
  commands: SimpleCommand[];
  /** Whether the script used any operator (`;`, `&&`, `||`, `|`). */
  compound: boolean;
}
export type ShellParse = { ok: true; script: ShellScript } | { ok: false; reason: string };

type Token =
  | { type: 'word'; value: string }
  | { type: 'op'; value: ';' | '&&' | '||' | '|' }
  | { type: 'redir'; value: SafeRedirect };

// C0/C1 controls (tab excepted), DEL, and Unicode spaces/format characters that could make the
// text look different from what a shell parses (homoglyph and invisible-character tricks).
const FORBIDDEN_CHARS =
  /[\u0000-\u0008\u000a-\u001f\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/;
const DELIMITERS = ' \t;&|<>()';

class Fail extends Error {}

function tokenize(line: string, portable: boolean): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let started = false; // a word exists, even an empty quoted one
  let quoted = false; // the word contains a quoted or escaped part
  let pendingRedirect: 1 | 2 | 0 = 0;
  const fail = (reason: string): never => {
    throw new Fail(reason);
  };
  const endWord = () => {
    if (!started) return;
    if (pendingRedirect) {
      if (word !== '/dev/null') fail('Redirecionamento só é aceito para /dev/null.');
      tokens.push({ type: 'redir', value: pendingRedirect === 2 ? '2>/dev/null' : '>/dev/null' });
      pendingRedirect = 0;
    } else tokens.push({ type: 'word', value: word });
    word = '';
    started = false;
    quoted = false;
  };
  const op = (value: ';' | '&&' | '||' | '|') => {
    endWord();
    if (pendingRedirect) fail('Redirecionamento incompleto.');
    tokens.push({ type: 'op', value });
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) fail('Aspas não fechadas.');
      // fish treats \' and \\ inside single quotes as escapes: a portable script avoids them.
      if (portable && line.slice(i + 1, close).includes('\\'))
        fail('Barra invertida entre aspas simples não é portável entre shells.');
      word += line.slice(i + 1, close);
      started = quoted = true;
      i = close;
      continue;
    }
    if (c === '"') {
      started = quoted = true;
      for (i++; ; i++) {
        if (i >= line.length) fail('Aspas não fechadas.');
        const d = line[i]!;
        if (d === '"') break;
        if (d === '\\') {
          const next = line[i + 1];
          if (next === undefined) fail('Aspas não fechadas.');
          // fish keeps the backslash of \` inside double quotes; POSIX shells drop it.
          if (next === '`' && portable) fail('Escape não portável entre aspas.');
          if ('"\\$`'.includes(next!)) {
            word += next;
            i++;
          } else if (next === '\n' || next === '!') fail('Escape não suportado entre aspas.');
          // Before any other character the backslash is literal (POSIX and fish agree).
          else word += d;
          continue;
        }
        if (d === '$' || d === '`') fail('Expansão de shell não é aceita.');
        if (d === '!') fail('Caractere ! não é aceito.');
        word += d;
      }
      continue;
    }
    if (c === '\\') {
      const next = line[i + 1];
      // Only an escaped ASCII punctuation character: it is literal in every POSIX shell.
      if (next === undefined || !/^[!-/:-@[-`{-~ ]$/.test(next)) fail('Escape não suportado.');
      word += next;
      started = quoted = true;
      i++;
      continue;
    }
    if (c === ';') {
      op(';');
      continue;
    }
    if (c === '&') {
      if (line[i + 1] !== '&') fail('Execução em segundo plano não é aceita.');
      op('&&');
      i++;
      continue;
    }
    if (c === '|') {
      if (line[i + 1] === '|') {
        op('||');
        i++;
      } else if (line[i + 1] === '&') fail('Operador |& não é aceito.');
      else op('|');
      continue;
    }
    if (c === '>') {
      let fd: 1 | 2 = 1;
      if (started && !quoted && (word === '1' || word === '2')) {
        fd = word === '2' ? 2 : 1;
        word = '';
        started = false;
      } else endWord();
      if (pendingRedirect) fail('Redirecionamento incompleto.');
      const next = line[i + 1];
      if (next === '>') fail('Redirecionamento com >> não é aceito.');
      if (next === '|') fail('Redirecionamento >| não é aceito.');
      if (next === '&') {
        const after = line[i + 3];
        if (fd !== 2 || line[i + 2] !== '1' || (after !== undefined && !DELIMITERS.includes(after)))
          fail('Só 2>&1 é aceito entre os redirecionamentos de descritor.');
        tokens.push({ type: 'redir', value: '2>&1' });
        i += 2;
        continue;
      }
      pendingRedirect = fd;
      continue;
    }
    if (c === '<') fail('Redirecionamento de entrada não é aceito.');
    if (c === '(' || c === ')') fail('Subshell ou agrupamento não é aceito.');
    if (c === '$' || c === '`') fail('Expansão de shell não é aceita.');
    if ('{}*?[]!'.includes(c)) fail('Glob, chaves ou ! fora de aspas não são aceitos.');
    // `#` starts a comment, zsh expands `=cmd`, old fish uses `^` and `%` for redirection/jobs.
    if (!started && '#=^%'.includes(c)) fail('Comentário ou expansão no início da palavra.');
    // A tilde is expanded at the start of a word and after `=` or `:`; accept it only after a
    // letter or digit (e.g. HEAD~1), where no supported shell expands it.
    if (c === '~' && !/[A-Za-z0-9]/.test(word.at(-1) ?? '')) fail('Expansão de ~ não é aceita.');
    // zsh's extended glob gives ~, ^ and # meaning anywhere in a word.
    if (portable && '~^#'.includes(c)) fail('Caractere com significado especial em algum shell.');
    word += c;
    started = true;
  }
  endWord();
  if (pendingRedirect) fail('Redirecionamento incompleto.');
  return tokens;
}

/** Parses a restricted shell script; see the module comment for the accepted grammar. */
export function parseShell(
  line: string,
  { portable = false, maxCommands = SHELL_MAX_COMMANDS }: { portable?: boolean; maxCommands?: number } = {},
): ShellParse {
  if (line.length > SHELL_MAX_CHARS) return { ok: false, reason: 'Comando longo demais para classificação.' };
  if (FORBIDDEN_CHARS.test(line)) return { ok: false, reason: 'Caractere de controle ou invisível não é aceito.' };
  let tokens: Token[];
  try {
    tokens = tokenize(line, portable);
  } catch (error) {
    if (error instanceof Fail) return { ok: false, reason: error.message };
    throw error;
  }
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { argv: [], redirects: [], pipedStdin: false };
  let compound = false;
  for (const token of tokens) {
    if (token.type === 'word') current.argv.push(token.value);
    else if (token.type === 'redir') current.redirects.push(token.value);
    else {
      if (!current.argv.length) return { ok: false, reason: 'Comando vazio entre operadores.' };
      commands.push(current);
      compound = true;
      if (commands.length >= maxCommands) return { ok: false, reason: 'Comandos demais em uma única solicitação.' };
      current = { argv: [], redirects: [], pipedStdin: token.value === '|' };
    }
  }
  if (!current.argv.length) return { ok: false, reason: 'Comando vazio ou terminado por operador.' };
  commands.push(current);
  return { ok: true, script: { commands, compound } };
}
