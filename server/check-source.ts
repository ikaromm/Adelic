import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, watch as watchFs, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CheckEnvironmentEvidence, CheckSource } from '../shared/contracts.js';
import { checkEnvironment } from './hooks.js';

const MAX_ENTRIES = 100_000;
const MAX_OBSERVATION_MS = 1_000;
const MAX_BYTES = 512 * 1024 * 1024;

/**
 * Fingerprints the visible project tree without consulting or mutating Git (in particular,
 * no index refresh/write-tree). .git and node_modules are excluded; the environment digest records
 * runtime/platform, sandbox profile, and the sanitized launch environment, not installed package
 * contents. Ignored project files are included. Bounds, unreadable files, and concurrent edits yield unknown.
 */
export function observeCheckSource(root: string, runId: string): CheckSource {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
    const first = hashTree(canonicalRoot);
    return {
      runId,
      root: canonicalRoot,
      state: first ? 'verified' : 'unknown',
      ...(first ? { revision: { kind: 'source_tree' as const, value: first } } : {}),
      scope: 'filesystem-except-.git-and-node_modules',
    };
  } catch {
    return { runId, root: safeRoot(root), state: 'unknown', scope: 'filesystem-except-.git-and-node_modules' };
  }
}

/** Reobserve explicitly after a check; a differing/missing digest is not treated as stable. */
export function compareCheckSource(before: CheckSource, root: string, runId: string): CheckSource {
  const after = observeCheckSource(root, runId);
  const state =
    before.state === 'verified' && after.state === 'verified'
      ? before.revision?.value === after.revision?.value
        ? 'verified'
        : 'changed'
      : 'unknown';
  const result: CheckSource = { ...after, state };
  if (state === 'verified' && before.revision) result.revision = before.revision;
  else if (state === 'unknown') delete result.revision;
  return result;
}

/**
 * Best-effort inotify/fs.watch coverage across the included tree. An event marks the source
 * changed even if a file is restored before the after-snapshot. If any directory cannot be
 * watched, the caller must downgrade evidence to unknown; this is not a security monitor.
 */
export function watchCheckSource(root: string): { state: 'observed' | 'unknown'; changed(): boolean; close(): void } {
  const watchers: FSWatcher[] = [];
  let touched = false;
  let failed = false;
  const started = Date.now();
  try {
    const canonicalRoot = realpathSync(root);
    const stack = [''];
    let entries = 0;
    while (stack.length) {
      if (Date.now() - started > MAX_OBSERVATION_MS) throw new Error('watch time bound exceeded');
      const relDir = stack.pop()!;
      const dir = relDir ? join(canonicalRoot, relDir) : canonicalRoot;
      const watcher = watchFs(dir, { persistent: false }, () => {
        touched = true;
      });
      watcher.on('error', () => {
        failed = true;
      });
      watchers.push(watcher);
      for (const name of readdirSync(dir)) {
        if (!relDir && (name === '.git' || name === 'node_modules')) continue;
        const absolute = join(dir, name);
        entries++;
        if (entries > MAX_ENTRIES) throw new Error('watch bound exceeded');
        const stat = lstatSync(absolute);
        if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(relDir ? join(relDir, name) : name);
      }
    }
    return {
      get state() {
        return failed ? 'unknown' : 'observed';
      },
      changed: () => touched,
      close: () => watchers.forEach((watcher) => watcher.close()),
    };
  } catch {
    watchers.forEach((watcher) => watcher.close());
    return { state: 'unknown', changed: () => false, close: () => undefined };
  }
}

/** A privacy-preserving digest of precisely the allowlisted environment passed to checks. */
export function fingerprintCheckEnvironment(env: NodeJS.ProcessEnv, sandbox: string): CheckEnvironmentEvidence {
  try {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          sandbox,
          env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
        }),
      )
      .digest('hex');
    return {
      state: 'observed',
      digest: hash,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  } catch {
    return { state: 'unknown' };
  }
}
export function observeCheckEnvironment(sandbox: string): CheckEnvironmentEvidence {
  try {
    return fingerprintCheckEnvironment(checkEnvironment(), sandbox);
  } catch {
    return { state: 'unknown' };
  }
}

export function observeCheckEnvironmentAfter(
  before: CheckEnvironmentEvidence,
  sandbox: string,
): CheckEnvironmentEvidence {
  const after = observeCheckEnvironment(sandbox);
  if (before.state !== 'observed' || after.state !== 'observed') return { state: 'unknown' };
  return before.digest === after.digest ? before : { ...after, state: 'changed' };
}

function hashTree(root: string): string | undefined {
  const hash = createHash('sha256');
  // Version the canonical encoding. Each entry below is a typed record whose fields are
  // length-prefixed, so neither binary contents nor path/mode boundaries can imitate records.
  hash.update('adelic-check-source-v2');
  const started = Date.now();
  const stack = [''];
  let entries = 0;
  let bytes = 0;
  while (stack.length) {
    if (Date.now() - started > MAX_OBSERVATION_MS) return undefined;
    const relDir = stack.pop()!;
    const dir = relDir ? join(root, relDir) : root;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!relDir && (name === '.git' || name === 'node_modules')) continue;
      const rel = relDir ? join(relDir, name) : name;
      const absolute = join(root, rel);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        return undefined;
      }
      entries++;
      if (entries > MAX_ENTRIES || Date.now() - started > MAX_OBSERVATION_MS) return undefined;
      const key = relative(root, absolute).split(sep).join('/');
      // Symlink targets may expose source outside this root; do not claim a complete tree.
      if (stat.isSymbolicLink()) {
        return undefined;
      } else if (stat.isDirectory()) {
        updateTreeRecord(hash, 1, [key, String(stat.mode & 0o777)]);
        stack.push(rel);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_BYTES) return undefined;
        try {
          const before = lstatSync(absolute);
          const content = readFileSync(absolute);
          const after = lstatSync(absolute);
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            content.length !== after.size
          )
            return undefined;
          updateTreeRecord(hash, 2, [key, String(stat.mode & 0o777), content]);
        } catch {
          return undefined;
        }
      } else {
        return undefined;
      }
    }
  }
  return hash.digest('hex');
}

/** A one-byte tag and 64-bit byte lengths frame each typed record and binary field. */
function updateTreeRecord(
  hash: ReturnType<typeof createHash>,
  tag: number,
  fields: readonly (string | Buffer)[],
): void {
  hash.update(Buffer.from([tag]));
  for (const value of fields) {
    const field = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(field.length));
    hash.update(length).update(field);
  }
}

function safeRoot(root: string): string | undefined {
  try {
    return realpathSync(root);
  } catch {
    return undefined;
  }
}
