// `@file` mentions (docs/specs/mentions.md): the project file listing behind the composer's
// autocomplete, and the resolution that inlines mentioned text files into a run's prompt.
//
// Security: a mention is resolved only inside the project's real path. Absolute paths and `..`
// segments are refused before touching the disk, the real path (symlinks resolved) must stay
// inside the project, and the file is opened with O_NOFOLLOW and re-checked through its handle,
// so a symlink swapped in after the check is not followed. Only regular UTF-8 files without NUL
// bytes are read, within per-file, per-message and total size caps.
import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  MAX_MENTION_BYTES,
  MAX_MENTION_TOTAL_BYTES,
  MAX_MENTIONED_FILES,
  MENTION_PATH_MAX,
  rankFiles,
} from '../shared/mentions.js';
import { inlineTextBlock } from './attachments.js';
import { listGitFiles } from './checkpoints.js';

export const FILE_LIST_LIMITS = {
  /** Most files listed for a project; beyond it the listing is marked truncated. */
  entries: 20_000,
  /** Deepest folder level visited by the walk of a folder that is not a git work tree. */
  depth: 12,
  cacheMs: 10_000,
  cacheProjects: 32,
  gitTimeoutMs: 15_000,
  gitMaxBytes: 16 * 1024 * 1024,
};
/** Folders the walk never enters (hidden folders are skipped too). */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build']);

export interface FileListing {
  files: string[];
  truncated: boolean;
  source: 'git' | 'walk';
}

/**
 * Bounded walk for folders outside git: sorted, `/`-separated relative paths of regular files,
 * skipping node_modules, dist, build and hidden folders. Symbolic links are never followed nor
 * listed. Stops at FILE_LIST_LIMITS.entries entries visited.
 */
export async function walkFiles(root: string, limits = FILE_LIST_LIMITS): Promise<Omit<FileListing, 'source'>> {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const visit = async (dir: string, prefix: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable folder: skipped.
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (++visited > limits.entries) {
        truncated = true;
        return;
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile()) files.push(path);
      else if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
        if (depth >= limits.depth) {
          truncated = true;
          continue;
        }
        await visit(join(dir, entry.name), path, depth + 1);
      }
      // Symbolic links, sockets and devices are neither listed nor followed.
    }
  };
  await visit(root, '', 1);
  return { files, truncated };
}

async function loadListing(root: string, limits: typeof FILE_LIST_LIMITS): Promise<FileListing> {
  let git: string[] | undefined;
  try {
    git = await listGitFiles(root, { timeoutMs: limits.gitTimeoutMs, maxBytes: limits.gitMaxBytes });
  } catch {
    git = undefined; // git missing, too slow or failing: fall back to the walk.
  }
  if (git) {
    const files = git.filter((p) => p.length <= MENTION_PATH_MAX);
    return { files: files.slice(0, limits.entries), truncated: files.length > limits.entries, source: 'git' };
  }
  return { ...(await walkFiles(root, limits)), source: 'walk' };
}

const cache = new Map<string, { at: number; listing: Promise<FileListing> }>();
/** Forgets cached listings (tests). */
export function clearFileCache() {
  cache.clear();
}

/**
 * Files of the project folder: `git ls-files --cached --others --exclude-standard` in a git
 * work tree, otherwise the bounded walk. Cached per folder for FILE_LIST_LIMITS.cacheMs;
 * concurrent calls share one listing.
 */
export async function listProjectFiles(
  path: string,
  opts: { now?: () => number; limits?: typeof FILE_LIST_LIMITS } = {},
): Promise<FileListing> {
  const now = (opts.now ?? Date.now)();
  const limits = opts.limits ?? FILE_LIST_LIMITS;
  const root = await realpath(path);
  const hit = cache.get(root);
  if (hit && now - hit.at < limits.cacheMs) return hit.listing;
  const listing = loadListing(root, limits);
  cache.delete(root);
  cache.set(root, { at: now, listing });
  listing.catch(() => cache.get(root)?.listing === listing && cache.delete(root));
  while (cache.size > limits.cacheProjects) cache.delete(cache.keys().next().value!);
  return listing;
}

/** Ranked files for the autocomplete; `truncated` also when more matches exist than `limit`. */
export async function searchProjectFiles(path: string, query: string, limit: number) {
  const listing = await listProjectFiles(path);
  const ranked = rankFiles(listing.files, query.trim());
  return { files: ranked.slice(0, limit), truncated: listing.truncated || ranked.length > limit };
}

export interface MentionResult {
  /** Blocks to append to the prompt (empty, or starting with a blank line). */
  text: string;
  included: string[];
  ignored: { path: string; reason: string }[];
}

const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
/** Refuses what must never reach the disk: absolute paths, `..`, backslashes and NUL. */
function unsafePath(path: string) {
  return (
    path.startsWith('/') ||
    path.startsWith('~') ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').includes('..')
  );
}

type Read = { ok: true; content: string; bytes: number } | { ok: false; reason: string };
async function readMentioned(root: string, path: string, budget: number): Promise<Read> {
  if (unsafePath(path)) return { ok: false, reason: 'fora do projeto' };
  let real: string;
  try {
    real = await realpath(join(root, path));
  } catch {
    return { ok: false, reason: 'arquivo não encontrado' };
  }
  if (!inside(root, real) || real === root) return { ok: false, reason: 'fora do projeto' };
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'arquivo ilegível' };
  }
  try {
    // The file actually opened must still be inside the project (a folder on the way could
    // have been swapped for a symlink after realpath). Linux exposes it in /proc.
    const opened = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => real);
    if (!inside(root, opened)) return { ok: false, reason: 'fora do projeto' };
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'não é um arquivo' };
    if (info.size > MAX_MENTION_BYTES) return { ok: false, reason: 'maior que 512 KB' };
    if (info.size > budget) return { ok: false, reason: 'limite total de 1 MB por mensagem' };
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { ok: false, reason: 'arquivo binário' };
    try {
      return { ok: true, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: bytes.length };
    } catch {
      return { ok: false, reason: 'não é texto UTF-8' };
    }
  } catch {
    return { ok: false, reason: 'arquivo ilegível' };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the mentioned files (distinct paths, in order) from the project at `projectPath` and
 * formats them as "[Arquivo mencionado: path]" blocks. Anything that cannot be inlined is
 * reported in `ignored` with a short reason and stays plain text in the message.
 */
export async function resolveMentions(projectPath: string, paths: readonly string[]): Promise<MentionResult> {
  const result: MentionResult = { text: '', included: [], ignored: [] };
  if (!paths.length) return result;
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    for (const path of paths) result.ignored.push({ path, reason: 'pasta do projeto indisponível' });
    return result;
  }
  const blocks: string[] = [];
  let total = 0;
  for (const path of [...new Set(paths)]) {
    if (result.included.length >= MAX_MENTIONED_FILES) {
      result.ignored.push({ path, reason: `limite de ${MAX_MENTIONED_FILES} arquivos por mensagem` });
      continue;
    }
    const read = await readMentioned(root, path, MAX_MENTION_TOTAL_BYTES - total);
    if (!read.ok) {
      result.ignored.push({ path, reason: read.reason });
      continue;
    }
    total += read.bytes;
    result.included.push(path);
    blocks.push(inlineTextBlock(`Arquivo mencionado: ${path}`, read.content));
  }
  result.text = blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
  return result;
}
