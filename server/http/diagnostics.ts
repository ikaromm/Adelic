import { Router } from 'express';
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { arch, homedir, platform, release } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findProviderBinary, type ProviderTool } from '../providers/discovery.js';
import { memoryServiceUrl, serviceRequest } from '../memory-service.js';
import { schemaVersion, userVersion } from '../migrations.js';
import type { BackendContext } from './context.js';
// Static import: esbuild inlines it into the desktop bundle, where package.json is not on disk.
import pkg from '../../package.json' with { type: 'json' };

const run = promisify(execFile);

/** Replaces the home directory with `~` so reports can be shared without the username. */
const tidy = (value: string) => (value.startsWith(homedir()) ? `~${value.slice(homedir().length)}` : value);

async function versionOf(binary: string | undefined, args = ['--version']) {
  if (!binary) return undefined;
  try {
    const { stdout, stderr } = await run(binary, args, { timeout: 3000, env: { ...process.env, NO_COLOR: '1' } });
    return (stdout || stderr).trim().split('\n')[0]?.slice(0, 120);
  } catch {
    return 'não respondeu a --version';
  }
}

async function memoryStatus() {
  const url = (() => {
    try {
      return memoryServiceUrl();
    } catch (e) {
      return `inválida: ${(e as Error).message}`;
    }
  })();
  try {
    const status = await serviceRequest('/admin/status', {}, 2000);
    const data = status.data as { version?: string; counts?: { pages_latest?: number } } | undefined;
    if (status.status === 404) return { url, reachable: true, detail: 'sem /admin/status' };
    return { url, reachable: true, version: data?.version, notes: data?.counts?.pages_latest };
  } catch (e) {
    return { url, reachable: false, detail: (e as Error).message };
  }
}

function backups(dataDir: string) {
  try {
    const dir = join(dataDir, 'backups');
    return readdirSync(dir)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => ({
        name,
        bytes: statSync(join(dir, name)).size,
        at: statSync(join(dir, name)).mtime.toISOString(),
      }))
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/**
 * Diagnostics for bug reports: versions, local paths, service status and counts. Never
 * includes credentials, tokens, environment variables or conversation content.
 */
export function diagnosticsRoutes({ store, providerList }: BackendContext) {
  const app = Router();
  app.get('/api/diagnostics', async (_req, res) => {
    const tools: ProviderTool[] = ['codex', 'claude', 'kiro', 'opencode'];
    const [providers, memory, binaries] = await Promise.all([
      providerList().catch(() => []),
      memoryStatus(),
      Promise.all(tools.map(async (tool) => [tool, await findProviderBinary(tool)] as const)),
    ]);
    const versions = await Promise.all(binaries.map(async ([tool, path]) => [tool, await versionOf(path)] as const));
    const bwrap = await versionOf('/usr/bin/bwrap');
    const count = (table: string) =>
      Number((store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n);
    res.json({
      generatedAt: new Date().toISOString(),
      app: { version: pkg.version, node: process.version, electron: process.versions.electron ?? null },
      system: { platform: platform(), arch: arch(), kernel: release() },
      data: {
        dir: tidy(store.dataDir),
        schema: { current: userVersion(store.db), supported: schemaVersion },
        counts: {
          projects: count('projects'),
          sessions: count('sessions'),
          messages: count('messages'),
          runs: count('runs'),
          approvals: count('approvals'),
          attachments: count('attachments'),
        },
        backups: backups(store.dataDir),
      },
      providers: providers.map((p) => {
        const found = binaries.find(([tool]) => tool === p.id)?.[1];
        return {
          id: p.id,
          status: p.status,
          available: p.available,
          detail: p.detail,
          models: p.models.length,
          binary: found ? tidy(found) : null,
          version: versions.find(([tool]) => tool === p.id)?.[1] ?? null,
        };
      }),
      sandbox: { bubblewrap: bwrap ?? null },
      memory,
    });
  });
  return app;
}
