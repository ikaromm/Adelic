/** Bounded non-Git evidence of files changed by a write run. This records metadata only. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export type RunArtifactKind = 'added' | 'modified' | 'deleted';
export interface RunArtifactFile {
  /** Project-relative, `/`-separated path. */
  path: string;
  status: RunArtifactKind;
}
export interface RunArtifactEntry {
  size: number;
  mtimeMs: number;
  hash?: string;
}
export interface RunArtifactSnapshot {
  status: 'available' | 'unknown';
  reason?: string;
  entries: Record<string, RunArtifactEntry>;
  truncated?: boolean;
  omitted?: number;
}
export interface RunArtifactChanges {
  status: 'available' | 'unknown';
  reason?: string;
  files: RunArtifactFile[];
  truncated?: boolean;
  omitted?: number;
  capturedAt: string;
}
/** Persistable `Run.artifacts` shape, with no content or baseline hashes. */
export type RunArtifactsSnapshot = RunArtifactChanges;
export interface RunArtifactFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

export const RUN_ARTIFACT_LIMITS = {
  files: 5_000,
  directories: 5_000,
  depth: 32,
  listed: 500,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  durationMs: 1_000,
} as const;

const EXCLUDED = new Set([
  '.git',
  'node_modules',
  '.next',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.vite',
  '.adelic',
  '__pycache__',
  'pycache',
  '.venv',
  'venv',
]);
const relativePath = (path: string) => path.split(sep).join('/');

/** Capture regular files only. Symlinks, ignored trees, and files outside configured bounds are never read. */
export async function captureRunArtifactSnapshot(projectPath: string): Promise<RunArtifactSnapshot> {
  const entries: Record<string, RunArtifactEntry> = Object.create(null) as Record<string, RunArtifactEntry>;
  let rootHandle: FileHandle;
  try {
    rootHandle = (await openProjectRoot(projectPath)).handle;
  } catch (error) {
    return unknown(entries, safeReason(error));
  }
  let totalBytes = 0;
  let seen = 0;
  let omitted = 0;
  let truncated = false;
  let firstError: string | undefined;
  let directories = 0;
  const deadline = Date.now() + RUN_ARTIFACT_LIMITS.durationMs;
  const visit = async (
    directoryHandle: Awaited<ReturnType<typeof open>>,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    directories++;
    if (directories > RUN_ARTIFACT_LIMITS.directories || depth > RUN_ARTIFACT_LIMITS.depth) {
      truncated = true;
      omitted++;
      return;
    }
    const fdPath = `/proc/self/fd/${directoryHandle.fd}`;
    let names: string[];
    try {
      // Traverse through an already-open directory descriptor. Replacing a parent with a
      // symlink while the run is writing cannot redirect these lookups outside this directory.
      names = (await readdir(fdPath)).sort();
    } catch (error) {
      firstError ??= safeReason(error);
      return;
    }
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      if (Date.now() >= deadline) {
        truncated = true;
        omitted += names.length - index;
        return;
      }
      if (EXCLUDED.has(name)) continue;
      if (seen >= RUN_ARTIFACT_LIMITS.files || totalBytes >= RUN_ARTIFACT_LIMITS.totalBytes) {
        truncated = true;
        omitted++;
        continue;
      }
      const childPath = resolve(fdPath, name);
      let stat;
      try {
        stat = await lstat(childPath);
      } catch (error) {
        firstError ??= safeReason(error);
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        let childHandle;
        try {
          childHandle = await open(
            childPath,
            constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
          );
          await visit(childHandle, join(relativeDirectory, name), depth + 1);
        } catch (error) {
          firstError ??= safeReason(error);
        } finally {
          await childHandle?.close();
        }
        continue;
      }
      if (!stat.isFile()) continue;
      seen++;
      const path = relativePath(join(relativeDirectory, name));
      const entry: RunArtifactEntry = { size: stat.size, mtimeMs: stat.mtimeMs };
      if (stat.size <= RUN_ARTIFACT_LIMITS.fileBytes && totalBytes + stat.size <= RUN_ARTIFACT_LIMITS.totalBytes) {
        try {
          // O_NOFOLLOW closes the final-component symlink race. Match identity against lstat too.
          const file = await open(childPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = await file.stat();
            if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
              firstError ??= 'file changed while snapshotting';
              continue;
            }
            const bytes = await readBounded(file, stat.size + 1);
            const after = await file.stat();
            const pathAfter = await lstat(childPath);
            if (
              bytes.length !== stat.size ||
              after.dev !== opened.dev ||
              after.ino !== opened.ino ||
              after.size !== stat.size ||
              after.mtimeMs !== stat.mtimeMs ||
              pathAfter.dev !== opened.dev ||
              pathAfter.ino !== opened.ino
            ) {
              firstError ??= 'file changed while snapshotting';
              continue;
            }
            entry.hash = createHash('sha256').update(bytes).digest('hex');
            totalBytes += bytes.length;
          } finally {
            await file.close();
          }
        } catch (error) {
          firstError ??= safeReason(error);
          continue;
        }
      } else {
        truncated = true;
        omitted++;
      }
      entries[path] = entry;
    }
  };
  try {
    await visit(rootHandle, '', 0);
  } catch (error) {
    firstError ??= safeReason(error);
  } finally {
    await rootHandle.close().catch((error: unknown) => (firstError ??= safeReason(error)));
  }
  return {
    status: firstError ? 'unknown' : 'available',
    ...(firstError ? { reason: firstError } : {}),
    entries,
    ...(truncated ? { truncated: true, omitted } : {}),
  };
}

/** Compare two snapshots. An unknown snapshot never becomes a false empty-success result. */
export function compareRunArtifactSnapshots(
  before: RunArtifactSnapshot,
  after: RunArtifactSnapshot,
  listed: number = RUN_ARTIFACT_LIMITS.listed,
): RunArtifactChanges {
  if (before.status !== 'available' || after.status !== 'available' || before.truncated || after.truncated) {
    const partial = before.truncated || after.truncated;
    return {
      status: 'unknown',
      reason:
        [before.reason, after.reason, partial ? 'snapshot is partial; file membership is incomplete' : undefined]
          .filter(Boolean)
          .join('; ') || 'snapshot unavailable',
      files: [],
      ...(partial ? { truncated: true } : {}),
      ...((before.omitted ?? 0) + (after.omitted ?? 0) > 0
        ? { omitted: (before.omitted ?? 0) + (after.omitted ?? 0) }
        : {}),
      capturedAt: new Date().toISOString(),
    };
  }
  const changes: RunArtifactFile[] = [];
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  for (const path of [...paths].sort()) {
    const old = before.entries[path];
    const current = after.entries[path];
    if (!old) changes.push({ path, status: 'added' });
    else if (!current) changes.push({ path, status: 'deleted' });
    else if (
      old.size !== current.size ||
      old.mtimeMs !== current.mtimeMs ||
      (old.hash !== undefined && current.hash !== undefined && old.hash !== current.hash)
    )
      changes.push({ path, status: 'modified' });
  }
  const omitted = Math.max(0, changes.length - listed) + (before.omitted ?? 0) + (after.omitted ?? 0);
  return {
    status: 'available',
    files: changes.slice(0, listed),
    ...(omitted ? { omitted, truncated: true } : {}),
    capturedAt: new Date().toISOString(),
  };
}

/** Read only bounded plaintext from a contained regular file without following symlinks. */
export async function readRunArtifactFile(
  rootPath: string,
  relativePathValue: string,
  maxBytes = 256 * 1024,
): Promise<RunArtifactFileContent> {
  const normalized = relativePathValue.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Object.assign(new Error('invalid artifact path'), { status: 400 });
  const parts = normalized.split('/');
  let directory = (await openProjectRoot(rootPath)).handle;
  for (const part of parts.slice(0, -1)) {
    const path = `/proc/self/fd/${directory.fd}/${part}`;
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      await directory.close();
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await directory.close();
      throw Object.assign(new Error('invalid artifact path'), { status: 400 });
    }
    let next;
    try {
      next = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      await directory.close();
      throw error;
    }
    await directory.close();
    directory = next;
  }
  const finalPath = `/proc/self/fd/${directory.fd}/${parts.at(-1)!}`;
  let initial;
  let file;
  try {
    initial = await lstat(finalPath);
    if (initial.isSymbolicLink() || !initial.isFile())
      throw Object.assign(new Error('artifact is not a regular file'), { status: 400 });
    file = await open(finalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } finally {
    await directory.close();
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino)
      throw Object.assign(new Error('artifact changed while opening'), { status: 409 });
    const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.min(256 * 1024, Math.floor(maxBytes))) : 256 * 1024;
    const buffer = Buffer.alloc(Math.max(1, byteLimit) + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return {
      path: normalized,
      content: buffer.subarray(0, Math.min(bytesRead, byteLimit)).toString('utf8'),
      truncated: bytesRead > byteLimit || opened.size > byteLimit,
    };
  } finally {
    await file.close();
  }
}

/** Read at most `maxBytes` plus one sentinel byte, even if a file grows after its initial stat. */
async function readBounded(file: Awaited<ReturnType<typeof open>>, maxBytes: number) {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < maxBytes) {
    const { bytesRead } = await file.read(buffer, offset, Math.min(64 * 1024, maxBytes - offset), offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function unknown(entries: Record<string, RunArtifactEntry>, reason: string): RunArtifactSnapshot {
  return { status: 'unknown', reason, entries };
}

/** Open a canonical project root without accepting a symlink or a path replaced during open. */
async function openProjectRoot(rootPath: string): Promise<{ path: string; handle: FileHandle }> {
  const path = resolve(rootPath);
  const initial = await lstat(path);
  if (!initial.isDirectory() || initial.isSymbolicLink())
    throw Object.assign(new Error('project root is not a regular directory'), { status: 400 });
  if ((await realpath(path)) !== path)
    throw Object.assign(new Error('project root resolves through an alias'), { status: 400 });
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    const canonical = await realpath(path);
    if (
      !opened.isDirectory() ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      canonical !== path ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw Object.assign(new Error('project root changed while opening'), { status: 409 });
    return { path, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function safeReason(error: unknown) {
  // Avoid exposing absolute paths in UI-facing evidence.
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message.slice(0, 160) : 'snapshot failed';
}
