import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { passwordHints, passwordProblems, usernameProblem } from '../shared/remote-access.js';
import { migrate } from './migrations.js';
import { RemoteAccounts } from './remote-auth.js';

// `npm run remote-user -- <set <username>|delete|status|revoke-sessions>` (docs/specs/remote-access.md).
// Works while the Adelic is running: it opens only the SQLite file (WAL, busy timeout) and never
// runs the Store's startup repairs. The password is read from stdin twice, without echo on a
// terminal; with a pipe, one line per read.

export interface CliIo {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}

const USAGE = `Uso: npm run remote-user -- <comando>
  set <usuário>      cria ou troca a conta do acesso remoto (pede a senha duas vezes)
  status             mostra a conta e as sessões ativas
  revoke-sessions    encerra todas as sessões abertas
  delete             apaga a conta e encerra as sessões
`;

/** Reads lines from a piped stdin, keeping the rest for the next call. */
function lineReader(stdin: Readable) {
  let buffer = '';
  let ended = false;
  const waiting: (() => void)[] = [];
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    waiting.splice(0).forEach((wake) => wake());
  });
  stdin.on('end', () => {
    ended = true;
    waiting.splice(0).forEach((wake) => wake());
  });
  return async function next(): Promise<string | undefined> {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        return line;
      }
      if (ended) {
        const rest = buffer;
        buffer = '';
        return rest.length ? rest : undefined;
      }
      await new Promise<void>((wake) => waiting.push(wake));
    }
  };
}

/** Terminal: raw mode, nothing echoed; Ctrl+C aborts. */
function readHidden(io: CliIo, prompt: string) {
  return new Promise<string>((done, fail) => {
    io.stderr.write(prompt);
    const stdin = io.stdin;
    let value = '';
    stdin.setRawMode!(true);
    stdin.setEncoding('utf8');
    const finish = (error?: Error) => {
      stdin.setRawMode!(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      io.stderr.write('\n');
      if (error) fail(error);
      else done(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') return finish(new Error('Cancelado.'));
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

export function openRemoteDb(env: NodeJS.ProcessEnv) {
  const dataDir = resolve(env.ADELIC_DATA_DIR || join(homedir(), '.local/share/adelic'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'adelic.sqlite');
  const created = !existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  // Same migrations as the app (with the usual backup); needed for the account tables.
  migrate(db, dataDir);
  return { db, dataDir, created };
}

export async function runRemoteUserCli(args: string[], io: CliIo): Promise<number> {
  const [command, username] = args;
  const out = (text: string) => io.stdout.write(`${text}\n`);
  const err = (text: string) => io.stderr.write(`${text}\n`);
  if (!command || !['set', 'status', 'revoke-sessions', 'delete'].includes(command)) {
    io.stderr.write(USAGE);
    return 2;
  }
  if (command === 'set') {
    const problem = username ? usernameProblem(username) : 'Informe o usuário: npm run remote-user -- set <usuário>';
    if (problem) {
      err(problem);
      return 2;
    }
  }
  let opened: ReturnType<typeof openRemoteDb>;
  try {
    opened = openRemoteDb(io.env);
  } catch (e) {
    err(`Não foi possível abrir os dados do Adelic: ${(e as Error).message}`);
    return 1;
  }
  const { db } = opened;
  try {
    const accounts = new RemoteAccounts(db);
    if (command === 'status') {
      const account = accounts.account();
      out(account ? `Conta: ${account.username} (senha alterada em ${account.passwordChangedAt})` : 'Nenhuma conta.');
      const sessions = accounts.listSessions();
      out(`Sessões ativas: ${sessions.length}`);
      for (const s of sessions) out(`  ${s.lastSeenAt}  ${s.kind}  ${s.ip}  ${s.userAgent || '—'}`);
      return 0;
    }
    if (command === 'revoke-sessions') {
      out(`Sessões encerradas: ${accounts.revokeAll()}`);
      return 0;
    }
    if (command === 'delete') {
      accounts.deleteAccount();
      out('Conta apagada e sessões encerradas. O login por usuário e senha fica indisponível.');
      return 0;
    }
    const read = io.stdin.isTTY && io.stdin.setRawMode ? undefined : lineReader(io.stdin);
    const ask = async (prompt: string) => {
      if (!read) return readHidden(io, prompt);
      io.stderr.write(prompt);
      const line = await read();
      io.stderr.write('\n');
      return line;
    };
    const password = await ask('Senha: ');
    const again = await ask('Repita a senha: ');
    if (password === undefined || again === undefined) {
      err('A senha não foi informada.');
      return 2;
    }
    if (password !== again) {
      err('As senhas não conferem; nada foi alterado.');
      return 2;
    }
    const problems = passwordProblems(username!, password);
    if (problems.length) {
      for (const p of problems) err(p);
      return 2;
    }
    for (const hint of passwordHints(password).hints) err(`Dica: ${hint}`);
    await accounts.setAccount(username!, password);
    out(`Conta "${username}" salva. Todas as sessões anteriores foram encerradas.`);
    return 0;
  } catch (e) {
    err((e as Error).message);
    return 1;
  } finally {
    db.close();
  }
}
