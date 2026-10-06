import { access, readdir, stat } from 'node:fs/promises';
import { constants, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderTool = 'codex' | 'claude' | 'kiro' | 'opencode';

const PROVIDERS: Record<ProviderTool, { override: string; binary: string; miseTools: string[] }> = {
  codex: { override: 'ADELIC_CODEX_BIN', binary: 'codex', miseTools: ['codex'] },
  claude: { override: 'ADELIC_CLAUDE_BIN', binary: 'claude', miseTools: ['claude'] },
  kiro: { override: 'ADELIC_KIRO_BIN', binary: 'kiro-cli', miseTools: ['kiro', 'kiro-cli'] },
  opencode: { override: 'ADELIC_OPENCODE_BIN', binary: 'opencode', miseTools: ['opencode'] },
};
const PROVIDER_LABELS: Record<ProviderTool, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  kiro: 'Kiro CLI',
  opencode: 'OpenCode',
};

export function providerBinaryMissingDetail(tool: ProviderTool, env: NodeJS.ProcessEnv = process.env): string {
  const override = PROVIDERS[tool].override;
  if (env[override] !== undefined) return `${override} está definida, mas não aponta para um arquivo executável.`;
  return `${PROVIDER_LABELS[tool]} não encontrado. Configure ${override} ou instale a CLI em um caminho local conhecido ou no PATH.`;
}
export function hasProviderBinaryOverride(tool: ProviderTool, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROVIDERS[tool].override] !== undefined;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

function miseDataDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  return [
    ...new Set(
      [
        env.MISE_DATA_DIR?.trim(),
        env.XDG_DATA_HOME?.trim() ? path.join(env.XDG_DATA_HOME.trim(), 'mise') : undefined,
        path.join(home, '.local/share/mise'),
      ].filter((item): item is string => Boolean(item)),
    ),
  ];
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile() || (info.mode & 0o111) === 0) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(candidates: Iterable<string>): Promise<string | undefined> {
  for (const candidate of candidates) if (await executableFile(candidate)) return path.resolve(candidate);
  return undefined;
}

async function directMiseCandidates(dataDirs: string[], toolNames: string[], binary: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const dataDir of dataDirs) {
    const installRoot = path.join(dataDir, 'installs');
    for (const toolName of toolNames) {
      const toolRoot = path.join(installRoot, toolName);
      candidates.push(path.join(toolRoot, 'bin', binary));
      let versions: string[];
      try {
        versions = await readdir(toolRoot);
      } catch {
        continue;
      }
      versions.sort((a, b) => {
        if (a === 'latest') return -1;
        if (b === 'latest') return 1;
        return b.localeCompare(a, undefined, { numeric: true });
      });
      for (const version of versions) {
        candidates.push(path.join(toolRoot, version, 'bin', binary));
        candidates.push(path.join(toolRoot, version, binary));
      }
    }
  }
  return candidates;
}

function localCandidates(tool: ProviderTool, home: string): string[] {
  const localBin = path.join(home, '.local/bin');
  switch (tool) {
    case 'codex':
      return [path.join(localBin, 'codex')];
    case 'claude':
      return [path.join(localBin, 'claude'), path.join(home, '.claude/local/claude')];
    case 'kiro':
      return [path.join(localBin, 'kiro-cli')];
    case 'opencode':
      return [path.join(localBin, 'opencode'), path.join(home, '.opencode/bin/opencode')];
  }
}

function pathCandidates(binary: string, env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, binary));
}

/** Locate a provider CLI without invoking a shell or trusting an invalid override as a fallback. */
export async function findProviderBinary(
  tool: ProviderTool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const provider = PROVIDERS[tool];
  const override = env[provider.override];
  if (override !== undefined) {
    const configured = override.trim();
    if (!configured) return undefined;
    const resolved = path.resolve(configured);
    return (await executableFile(resolved)) ? resolved : undefined;
  }

  const home = homeDir(env);
  const miseCandidates = await directMiseCandidates(miseDataDirs(env, home), provider.miseTools, provider.binary);
  const directMise = await firstExecutable(miseCandidates);
  if (directMise) return directMise;

  const local = await firstExecutable(localCandidates(tool, home));
  if (local) return local;
  return firstExecutable(pathCandidates(provider.binary, env));
}

function existingDirectories(candidates: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      if (statSync(normalized).isDirectory()) result.push(normalized);
    } catch {
      /* A launcher may have an incomplete PATH. */
    }
  }
  return result;
}

function versionedBinDirs(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  entries.sort((a, b) => {
    if (a === 'latest') return -1;
    if (b === 'latest') return 1;
    return b.localeCompare(a, undefined, { numeric: true });
  });
  return entries.map((entry) => path.join(root, entry, 'bin'));
}

/** Add common user and system executable paths for a GUI-launched desktop process. */
export function desktopPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = homeDir(env);
  const miseDirs = miseDataDirs(env, home);
  const candidates = [
    path.join(home, '.local/bin'),
    env.XDG_BIN_HOME?.trim(),
    path.join(home, '.bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.local/share/npm/bin'),
    path.join(home, '.local/share/pnpm'),
    env.NPM_CONFIG_PREFIX?.trim() ? path.join(env.NPM_CONFIG_PREFIX.trim(), 'bin') : undefined,
    env.PNPM_HOME?.trim(),
    path.join(home, '.opencode/bin'),
    path.join(home, '.claude/local'),
    path.join(home, '.volta/bin'),
    path.join(home, '.asdf/shims'),
    ...miseDirs.flatMap((base) => [path.join(base, 'bin'), path.join(base, 'shims')]),
    ...miseDirs.flatMap((base) => {
      const installs = path.join(base, 'installs');
      let tools: string[];
      try {
        tools = readdirSync(installs);
      } catch {
        return [];
      }
      return tools.flatMap((tool) => versionedBinDirs(path.join(installs, tool)));
    }),
    ...versionedBinDirs(path.join(env.ASDF_DATA_DIR?.trim() || path.join(home, '.asdf'), 'installs/node')),
    ...versionedBinDirs(
      env.NVM_DIR?.trim() ? path.join(env.NVM_DIR.trim(), 'versions/node') : path.join(home, '.nvm/versions/node'),
    ),
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  return existingDirectories(candidates.filter((item): item is string => Boolean(item))).join(path.delimiter);
}
