import { mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureRunArtifactSnapshot,
  compareRunArtifactSnapshots,
  readRunArtifactFile,
  RUN_ARTIFACT_LIMITS,
} from '../server/run-artifacts';

const folders: string[] = [];
async function project() {
  const path = await mkdtemp(join(tmpdir(), 'adelic-run-artifacts-'));
  folders.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('run artifact snapshots', () => {
  it('reports added, modified by content, and deleted files without requiring Git', async () => {
    const root = await project();
    await writeFile(join(root, 'same-size.txt'), 'before');
    await writeFile(join(root, 'gone.txt'), 'gone');
    const before = await captureRunArtifactSnapshot(root);
    await writeFile(join(root, 'same-size.txt'), 'after!');
    await writeFile(join(root, 'new.txt'), 'new');
    await rm(join(root, 'gone.txt'));
    const after = await captureRunArtifactSnapshot(root);

    expect(before.status).toBe('available');
    expect(compareRunArtifactSnapshots(before, after)).toMatchObject({
      status: 'available',
      files: [
        { path: 'gone.txt', status: 'deleted' },
        { path: 'new.txt', status: 'added' },
        { path: 'same-size.txt', status: 'modified' },
      ],
    });
  });

  it('does not follow symlinks or count ignored dependency and Git trees', async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, '.git', 'index'), 'git');
    await writeFile(join(root, 'node_modules', 'pkg.js'), 'dependency');
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(root, 'linked'));
    await writeFile(join(root, 'project.txt'), 'inside');

    const snapshot = await captureRunArtifactSnapshot(root);
    expect(snapshot.status).toBe('available');
    expect(Object.keys(snapshot.entries)).toEqual(['project.txt']);
  });

  it('rejects a project root replaced with a symlink after capture', async () => {
    const root = await project();
    const outside = await project();
    const oldRoot = `${root}.old`;
    folders.push(oldRoot);
    await writeFile(join(root, 'README.md'), 'inside project');
    const captured = await captureRunArtifactSnapshot(root);
    expect(captured.status).toBe('available');

    await writeFile(join(outside, 'README.md'), 'outside secret');
    await rename(root, oldRoot);
    await symlink(outside, root);

    await expect(readRunArtifactFile(root, 'README.md')).rejects.toMatchObject({ status: 400 });
    expect((await captureRunArtifactSnapshot(root)).status).toBe('unknown');
  });

  it('rejects project-root aliases that resolve through a symlink', async () => {
    const root = await project();
    const alias = `${root}.alias`;
    folders.push(alias);
    await symlink(root, alias);
    expect((await captureRunArtifactSnapshot(alias)).status).toBe('unknown');
    await expect(readRunArtifactFile(alias, 'README.md')).rejects.toMatchObject({ status: 400 });
  });

  it('keeps inaccessible or missing snapshot state unknown instead of reporting empty success', async () => {
    const missing = join(tmpdir(), `adelic-missing-${Date.now()}`);
    const snapshot = await captureRunArtifactSnapshot(missing);
    expect(snapshot.status).toBe('unknown');
    expect(compareRunArtifactSnapshots(snapshot, { status: 'available', entries: {} })).toMatchObject({
      status: 'unknown',
      files: [],
    });
  });

  it('shows bounded-list truncation for omitted changed files', async () => {
    const before = { status: 'available' as const, entries: {} };
    const after = {
      status: 'available' as const,
      entries: { 'a.txt': { size: 1, mtimeMs: 1 }, 'b.txt': { size: 1, mtimeMs: 1 } },
    };
    expect(compareRunArtifactSnapshots(before, after, 1)).toMatchObject({
      status: 'available',
      files: [{ path: 'a.txt', status: 'added' }],
      omitted: 1,
      truncated: true,
    });
  });

  it('does not claim additions or deletions when either snapshot is partial', async () => {
    const before = {
      status: 'available' as const,
      entries: { 'previously-seen.txt': { size: 1, mtimeMs: 1 } },
    };
    const after = {
      status: 'available' as const,
      entries: { 'newly-seen.txt': { size: 1, mtimeMs: 1 } },
      truncated: true,
      omitted: 3,
    };
    expect(compareRunArtifactSnapshots(before, after)).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('membership is incomplete'),
      files: [],
      truncated: true,
      omitted: 3,
    });
  });

  it('caps large-file hashing and preserves unknown membership instead of reporting false changes', async () => {
    const root = await project();
    const path = join(root, 'large.txt');
    await writeFile(path, Buffer.alloc(RUN_ARTIFACT_LIMITS.fileBytes + 1, 65));
    const snapshot = await captureRunArtifactSnapshot(root);
    expect(snapshot.status).toBe('available');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries['large.txt']).toMatchObject({ size: RUN_ARTIFACT_LIMITS.fileBytes + 1 });
    expect(snapshot.entries['large.txt']).not.toHaveProperty('hash');
    expect(compareRunArtifactSnapshots({ status: 'available', entries: {} }, snapshot)).toMatchObject({
      status: 'unknown',
      files: [],
      truncated: true,
    });
  });

  it('serves only bounded plaintext from a contained regular path and rejects symlinks', async () => {
    const root = await project();
    const outside = await project();
    await writeFile(join(root, 'text.txt'), 'abcdef');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
    expect(await readRunArtifactFile(root, 'text.txt', 4)).toEqual({
      path: 'text.txt',
      content: 'abcd',
      truncated: true,
    });
    await expect(readRunArtifactFile(root, 'linked.txt')).rejects.toMatchObject({ status: 400 });
    await expect(readRunArtifactFile(root, '../secret.txt')).rejects.toMatchObject({ status: 400 });
  });

  it('closes the directory handle when a listed file disappears before it is read', async () => {
    const root = await project();
    const before = await readdir('/proc/self/fd');
    for (let i = 0; i < 32; i++)
      await expect(readRunArtifactFile(root, 'missing.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    const after = await readdir('/proc/self/fd');
    expect(after.length).toBe(before.length);
  });
});
