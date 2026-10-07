// Real temporary git repositories for the checkpoint tests. Identity is passed with -c,
// so the user's global git config is neither needed nor modified.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false'];
export function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}
/** A repository with one commit, a staged change, an unstaged change, a stash and an ignored file. */
export function makeGitRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-ckpt-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'linha 1\nlinha 2\nlinha 3\n');
  writeFileSync(join(dir, 'remove-me.txt'), 'adeus\n');
  writeFileSync(join(dir, 'arquivo com espaço é.txt'), 'olá\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, ...ID, 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'stashed.txt'), 'guardado\n');
  gitIn(dir, 'add', 'stashed.txt');
  gitIn(dir, ...ID, 'stash', 'push', '-q', '-m', 'user stash');
  writeFileSync(join(dir, 'staged.txt'), 'no índice\n');
  gitIn(dir, 'add', 'staged.txt');
  writeFileSync(join(dir, 'README.md'), 'linha 1\nlinha 2 editada pelo usuário\nlinha 3\n');
  writeFileSync(join(dir, 'ignored.log'), 'segredo local\n');
  writeFileSync(join(dir, 'untracked.txt'), 'novo do usuário\n');
  return dir;
}
