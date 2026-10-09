import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitIn, makeGitRepo } from './git-fixtures.js';
import {
  CheckpointError,
  LIMITS,
  NOT_GIT,
  REF_PREFIX,
  checkpointAfter,
  checkpointBefore,
  checkpointDiff,
  classifyGitRepo,
  restoreCheckpoint,
} from '../server/checkpoints.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const makeRepo = () => {
  const dir = makeGitRepo();
  dirs.push(dir);
  return dir;
};
function repoState(dir: string) {
  return {
    head: gitIn(dir, 'rev-parse', 'HEAD'),
    branch: gitIn(dir, 'symbolic-ref', 'HEAD'),
    branches: gitIn(dir, 'for-each-ref', 'refs/heads', 'refs/tags'),
    stash: gitIn(dir, 'stash', 'list'),
    index: readFileSync(join(dir, '.git/index')).toString('hex'),
    status: gitIn(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
  };
}
/** Simulates what an agent does during a run. */
function agentEdits(dir: string) {
  writeFileSync(join(dir, 'README.md'), 'linha 1\nlinha 2 editada pelo usuário\nlinha 3\nlinha 4 do agente\n');
  unlinkSync(join(dir, 'remove-me.txt'));
  mkdirSync(join(dir, 'novo dir'));
  writeFileSync(join(dir, 'novo dir', 'código ü.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(dir, 'ignored.log'), 'alterado, mas ignorado\n');
}
async function runWithAgent(dir: string, runId = 'run-1', edit = agentEdits) {
  const before = await checkpointBefore(dir, runId);
  edit(dir);
  return checkpointAfter(runId, before);
}

describe('checkpoints on a real git repository', () => {
  it('never changes HEAD, branches, the index, the stash or the status', async () => {
    const dir = makeRepo();
    const initial = repoState(dir);
    const before = await checkpointBefore(dir, 'run-1');
    expect(before).toMatchObject({ available: true, root: dir });
    expect(repoState(dir)).toEqual(initial);
    agentEdits(dir);
    const expected = repoState(dir);
    const after = await checkpointAfter('run-1', before);
    expect(after.after).toMatch(/^[0-9a-f]{40}$/);
    expect(repoState(dir)).toEqual(expected);
    await checkpointDiff('run-1', after, 'README.md');
    expect(repoState(dir)).toEqual(expected);
  });

  it('stores both snapshots only under refs/adelic/checkpoints', async () => {
    const dir = makeRepo();
    const refsBefore = gitIn(dir, 'for-each-ref', '--format=%(refname)');
    const after = await runWithAgent(dir);
    const refs = gitIn(dir, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
    const added = refs.filter((r) => !refsBefore.includes(r));
    expect(added.sort()).toEqual([`${REF_PREFIX}/run-1/after`, `${REF_PREFIX}/run-1/before`]);
    expect(gitIn(dir, 'rev-parse', `${REF_PREFIX}/run-1/before`).trim()).toBe(after.before);
    expect(gitIn(dir, 'rev-parse', `${REF_PREFIX}/run-1/after^`).trim()).toBe(after.before);
    // The working tree is captured as-is: the user's uncommitted edits and untracked files count.
    const tree = gitIn(dir, 'ls-tree', '-r', '--name-only', '-z', after.before!).split('\0');
    expect(tree).toEqual(expect.arrayContaining(['untracked.txt', 'staged.txt', 'arquivo com espaço é.txt']));
    expect(tree).not.toContain('ignored.log');
    expect(tree).not.toContain('stashed.txt');
    expect(gitIn(dir, 'show', `${after.before}:README.md`)).toContain('editada pelo usuário');
  });

  it('lists changed files with status and line counts, unicode paths included', async () => {
    const dir = makeRepo();
    const after = await runWithAgent(dir);
    expect(after.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'novo dir/código ü.ts', status: 'added', additions: 2, deletions: 0 },
      { path: 'remove-me.txt', status: 'deleted', additions: 0, deletions: 1 },
    ]);
  });

  it('records an empty list and drops the refs when nothing changed', async () => {
    const dir = makeRepo();
    const after = await runWithAgent(dir, 'run-1', () => undefined);
    expect(after).toMatchObject({ available: true, files: [] });
    expect(gitIn(dir, 'for-each-ref', REF_PREFIX)).toBe('');
  });

  it('returns a bounded unified diff for a changed file and rejects other paths', async () => {
    const dir = makeRepo();
    const after = await runWithAgent(dir);
    const diff = await checkpointDiff('run-1', after, 'README.md');
    expect(diff.truncated).toBe(false);
    expect(diff.diff).toContain('+linha 4 do agente');
    expect(diff.diff).toMatch(/^diff --git a\/README.md b\/README.md/);
    await expect(checkpointDiff('run-1', after, 'untracked.txt')).rejects.toMatchObject({ status: 404 });
    await expect(checkpointDiff('run-1', after, '../etc/passwd')).rejects.toBeInstanceOf(CheckpointError);
    writeFileSync(join(dir, 'big.txt'), '');
    const big = await runWithAgent(dir, 'run-2', (d) => writeFileSync(join(d, 'big.txt'), 'linha\n'.repeat(50_000)));
    const bigDiff = await checkpointDiff('run-2', big, 'big.txt');
    expect(bigDiff.truncated).toBe(true);
    expect(Buffer.byteLength(bigDiff.diff)).toBeLessThanOrEqual(200 * 1024);
  });

  it('restores modified and deleted files, and removes added ones', async () => {
    const dir = makeRepo();
    const initialStatus = gitIn(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
    const after = await runWithAgent(dir);
    const result = await restoreCheckpoint('run-1', after);
    expect(result.restored.sort()).toEqual(['README.md', 'novo dir/código ü.ts', 'remove-me.txt']);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('linha 1\nlinha 2 editada pelo usuário\nlinha 3\n');
    expect(readFileSync(join(dir, 'remove-me.txt'), 'utf8')).toBe('adeus\n');
    expect(existsSync(join(dir, 'novo dir'))).toBe(false);
    // Ignored files are not part of the checkpoint, so they are left as the run left them.
    expect(readFileSync(join(dir, 'ignored.log'), 'utf8')).toBe('alterado, mas ignorado\n');
    expect(gitIn(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all')).toBe(initialStatus);
  });

  it('refuses to restore when a changed file was edited after the run, and writes nothing', async () => {
    const dir = makeRepo();
    const after = await runWithAgent(dir);
    writeFileSync(join(dir, 'README.md'), 'edição posterior do usuário\n');
    writeFileSync(join(dir, 'remove-me.txt'), 'recriado depois\n');
    const error = await restoreCheckpoint('run-1', after).catch((e: CheckpointError) => e);
    expect(error).toBeInstanceOf(CheckpointError);
    expect(error).toMatchObject({ status: 409, conflicts: ['README.md', 'remove-me.txt'] });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('edição posterior do usuário\n');
    // Files without conflicts are not touched either: all or nothing.
    expect(existsSync(join(dir, 'novo dir', 'código ü.ts'))).toBe(true);
  });

  it('treats a changed executable bit as a later edit', async () => {
    const dir = makeRepo();
    const after = await runWithAgent(dir);
    chmodSync(join(dir, 'README.md'), 0o755);
    await expect(restoreCheckpoint('run-1', after)).rejects.toMatchObject({ conflicts: ['README.md'] });
  });

  it('restores the mode and symlinks', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(dir, 'run.sh'), 0o755);
    symlinkSync('README.md', join(dir, 'link'));
    const after = await runWithAgent(dir, 'run-1', (d) => {
      unlinkSync(join(d, 'run.sh'));
      unlinkSync(join(d, 'link'));
      symlinkSync('remove-me.txt', join(d, 'link'));
    });
    expect(after.files?.map((f) => [f.path, f.status])).toEqual([
      ['link', 'modified'],
      ['run.sh', 'deleted'],
    ]);
    await restoreCheckpoint('run-1', after);
    expect(statSync(join(dir, 'run.sh')).mode & 0o100).toBe(0o100);
    expect(execFileSync('readlink', [join(dir, 'link')], { encoding: 'utf8' }).trim()).toBe('README.md');
  });

  it('does not run filters or hooks planted in the repository config', async () => {
    const dir = makeRepo();
    const marker = join(dir, '..', `${dir.split('/').at(-1)}-pwned`);
    gitIn(dir, 'config', 'filter.evil.clean', `sh -c "touch '${marker}'; cat"`);
    gitIn(dir, 'config', 'filter.evil.required', 'true');
    gitIn(dir, 'config', 'core.fsmonitor', `sh -c "touch '${marker}'"`);
    writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
    mkdirSync(join(dir, '.git/hooks'), { recursive: true });
    writeFileSync(join(dir, '.git/hooks/reference-transaction'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(dir, '.git/hooks/reference-transaction'), 0o755);
    const after = await runWithAgent(dir);
    await checkpointDiff('run-1', after, 'README.md');
    await restoreCheckpoint('run-1', after);
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  });

  it('refuses when the refs were removed or rewritten', async () => {
    const dir = makeRepo();
    const after = await runWithAgent(dir);
    gitIn(dir, 'update-ref', '-d', `${REF_PREFIX}/run-1/after`);
    await expect(restoreCheckpoint('run-1', after)).rejects.toMatchObject({ status: 410 });
  });

  it('classifies valid worktrees, genuine absence and failed Git probes without conflating them', async () => {
    const repo = makeRepo();
    const worktree = join(tmpdir(), `adelic-linked-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    gitIn(repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
    dirs.push(worktree);
    expect(readFileSync(join(worktree, '.git'), 'utf8')).toContain('gitdir:');
    const before = repoState(repo);
    expect(await classifyGitRepo(worktree)).toMatchObject({ status: 'available' });
    expect(repoState(repo)).toEqual(before);

    const noGit = mkdtempSync(join(tmpdir(), 'adelic-classify-nogit-'));
    dirs.push(noGit);
    expect(await classifyGitRepo(noGit)).toEqual({ status: 'absent' });

    const brokenGit = mkdtempSync(join(tmpdir(), 'adelic-classify-broken-'));
    dirs.push(brokenGit);
    writeFileSync(join(brokenGit, '.git'), 'gitdir: /missing/metadata');
    expect(await classifyGitRepo(brokenGit)).toEqual({ status: 'unknown' });
  });

  it('classifies checkpoint absence separately from a failed capture', async () => {
    const dir = makeRepo();
    const priorLimit = LIMITS.fileBytes;
    try {
      LIMITS.fileBytes = 0;
      expect(await checkpointBefore(dir, 'failed-capture')).toMatchObject({
        available: false,
        captureState: 'failed',
      });
    } finally {
      LIMITS.fileBytes = priorLimit;
    }

    const noGit = mkdtempSync(join(tmpdir(), 'adelic-nogit-'));
    dirs.push(noGit);
    writeFileSync(join(noGit, 'a.txt'), 'a');
    expect(await checkpointBefore(noGit, 'not-applicable')).toEqual({
      available: false,
      captureState: 'not_applicable',
      reason: NOT_GIT,
    });
    expect(existsSync(join(noGit, '.git'))).toBe(false);

    const brokenGit = mkdtempSync(join(tmpdir(), 'adelic-brokengit-'));
    dirs.push(brokenGit);
    writeFileSync(join(brokenGit, '.git'), 'gitdir: /missing/metadata');
    expect(await checkpointBefore(brokenGit, 'broken-git')).toEqual({
      available: false,
      captureState: 'failed',
      reason: NOT_GIT,
    });
  });

  it('only snapshots the project folder when it is below the repository root', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'pkg'));
    writeFileSync(join(dir, 'pkg', 'index.ts'), 'export {};\n');
    const sub = join(dir, 'pkg');
    // Detached conversations require their own repository, not a parent one.
    expect(await checkpointBefore(sub, 'run-0', { requireToplevel: true })).toMatchObject({ available: false });
    const after = await runWithAgent(sub, 'run-1', (d) => {
      writeFileSync(join(d, 'index.ts'), 'export const x = 1;\n');
      writeFileSync(join(dir, 'README.md'), 'fora do projeto\n');
    });
    expect(after.files).toEqual([{ path: 'pkg/index.ts', status: 'modified', additions: 1, deletions: 1 }]);
    await restoreCheckpoint('run-1', after);
    expect(readFileSync(join(sub, 'index.ts'), 'utf8')).toBe('export {};\n');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('fora do projeto\n');
  });

  it('does not restore through a parent folder that became a symlink', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'a\n');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-outside-')));
    dirs.push(outside);
    const after = await runWithAgent(dir, 'run-1', (d) => {
      rmSync(join(d, 'src'), { recursive: true });
      writeFileSync(join(outside, 'a.ts'), 'a\n');
      symlinkSync(outside, join(d, 'src'));
    });
    // The run replaced the folder by a link, so the change shows up as link added + file deleted.
    expect(after.files?.map((f) => f.status).sort()).toEqual(['added', 'deleted']);
    // Restoring removes the added link before writing src/a.ts back as a real file.
    await restoreCheckpoint('run-1', after);
    expect(statSync(join(dir, 'src')).isDirectory()).toBe(true);
    expect(readFileSync(join(outside, 'a.ts'), 'utf8')).toBe('a\n');
  });

  it('blocks a restore when a folder was replaced by a symlink after the run', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'a\n');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-outside-')));
    dirs.push(outside);
    const after = await runWithAgent(dir, 'run-1', (d) => writeFileSync(join(d, 'src', 'a.ts'), 'b\n'));
    rmSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(outside, 'a.ts'), 'b\n'); // Same content as the run's result, but outside.
    symlinkSync(outside, join(dir, 'src'));
    await expect(restoreCheckpoint('run-1', after)).rejects.toMatchObject({ status: 409, conflicts: ['src/a.ts'] });
    expect(readFileSync(join(outside, 'a.ts'), 'utf8')).toBe('b\n');
  });
});
