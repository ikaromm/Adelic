import { accessSync, constants, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const LOCAL_DIRECTORY_LIMIT = 100;
const DIRECTORY_NAME_MAX = 120;

export class LocalProjectFolderError extends Error {
  constructor(readonly code: 'invalid-path' | 'not-directory' | 'unavailable' | 'invalid-name' | 'exists') {
    super(code);
  }
}

export interface LocalDirectoryEntry {
  name: string;
  path: string;
  directory: true;
  readable: boolean;
  writable: boolean;
}

function access(path: string) {
  const allowed = (mode: number) => {
    try {
      accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  };
  return { readable: allowed(constants.R_OK), writable: allowed(constants.W_OK) };
}

function canonicalDirectory(input: unknown) {
  if (input !== undefined && (typeof input !== 'string' || !input.trim() || input.includes('\0')))
    throw new LocalProjectFolderError('invalid-path');
  const requested = typeof input === 'string' ? input.trim() : homedir();
  try {
    const path = realpathSync(resolve(requested));
    if (!statSync(path).isDirectory()) throw new LocalProjectFolderError('not-directory');
    return path;
  } catch (error) {
    if (error instanceof LocalProjectFolderError) throw error;
    throw new LocalProjectFolderError('unavailable');
  }
}

/** Lists only actual directories (never symlinks or file names), capped for a compact picker. */
export function listLocalProjectFolders(path?: unknown) {
  const canonical = canonicalDirectory(path);
  try {
    const directories = readdirSync(canonical, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const entryPath = join(canonical, entry.name);
        return { name: entry.name, path: entryPath, directory: true as const, ...access(entryPath) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path: canonical,
      ...access(canonical),
      entries: directories.slice(0, LOCAL_DIRECTORY_LIMIT),
      truncated: directories.length > LOCAL_DIRECTORY_LIMIT,
    };
  } catch {
    throw new LocalProjectFolderError('unavailable');
  }
}

function validDirectoryName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DIRECTORY_NAME_MAX &&
    value === value.trim() &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/\0]/.test(value) &&
    basename(value) === value
  );
}

/** Creates one new child directory without traversing a target symlink or creating parents. */
export function createLocalProjectFolder(parentPath: unknown, name: unknown) {
  if (!validDirectoryName(name)) throw new LocalProjectFolderError('invalid-name');
  const parent = canonicalDirectory(parentPath);
  const target = join(parent, name);
  // mkdir is non-recursive and atomically refuses existing files, directories and symlinks.
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LocalProjectFolderError('exists');
    throw new LocalProjectFolderError('unavailable');
  }
  try {
    const created = realpathSync(target);
    if (created !== target || !isAbsolute(created) || !statSync(created).isDirectory())
      throw new LocalProjectFolderError('unavailable');
    return { path: created };
  } catch (error) {
    if (error instanceof LocalProjectFolderError) throw error;
    throw new LocalProjectFolderError('unavailable');
  }
}
