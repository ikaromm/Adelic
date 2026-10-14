// MCP catalog (docs/specs/mcp-catalog.md): command resolution, the client view (literal
// environment values are write-only), what a run receives and the per-project report.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRole, Project } from '../shared/contracts.js';
import {
  type McpProviderReport,
  type McpServerRecord,
  type McpServerView,
  type ProjectMcpReport,
  type RunMcpServer,
} from '../shared/mcp.js';
import type { Store } from './store.js';
import type { SkillsMcpSnapshot } from './skills-mcp.js';
import { httpError } from './i18n.js';

/** Client view: literal values are replaced by `set: true` and never leave the server. */
export function mcpServerView(server: McpServerRecord): McpServerView {
  return {
    ...server,
    env: server.env.map(({ name, from, value }) => ({
      name,
      from,
      ...(from === 'literal' && value ? { set: true as const } : {}),
    })),
  };
}

function executable(file: string) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path for a catalog command: an absolute path must be an executable file; a bare
 * name is looked up with `which` once, at save time, and its absolute path is stored.
 * Relative paths with a slash are refused (they would depend on the agent's cwd).
 */
export function resolveMcpCommand(input: string, which = defaultWhich): string {
  const command = input.trim();
  if (path.isAbsolute(command)) {
    const normalized = path.normalize(command);
    if (!executable(normalized)) throw httpError(400, 'mcp.commandNotExecutable', { command: normalized });
    return normalized;
  }
  if (command.includes('/') || command.includes('\\') || !/^[\w.+-]+$/.test(command))
    throw httpError(400, 'validation.mcp.command');
  const found = which(command);
  if (!found || !path.isAbsolute(found) || !executable(found))
    throw httpError(400, 'mcp.commandNotInPath', { command });
  return path.normalize(found);
}

function defaultWhich(name: string) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split('\n')[0];
  } catch {
    return '';
  }
}

/** Catalog entries a project enabled, in catalog order; unknown ids are ignored. */
function enabledEntries(store: Store, project: Project) {
  const ids = new Set(project.enabledMcp ?? []);
  return store.listMcpServers().filter((server) => ids.has(server.id));
}

/**
 * Servers a run of this project receives. Detached conversations never get any, and the
 * pass-through names only include variables set in Adelic's own environment right now.
 */
export function runMcpServers(
  store: Store,
  project: Project,
  detached: boolean,
  env: NodeJS.ProcessEnv = process.env,
): RunMcpServer[] {
  if (detached || project.id.startsWith('detached:')) return [];
  return enabledEntries(store, project).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.fromEntries(
      server.env.flatMap((item) =>
        item.from === 'literal' && item.value !== undefined ? [[item.name, item.value]] : [],
      ),
    ),
    passEnv: server.env
      .filter((item) => item.from === 'adelic-env' && env[item.name] !== undefined)
      .map((item) => item.name),
    ...(server.tools?.length ? { tools: [...server.tools] } : {}),
  }));
}

function skillsMcpSourcePaths() {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    entry: path.join(serverDir, 'skills-mcp-cli.ts'),
    loader: path.resolve(serverDir, '../node_modules/tsx/dist/loader.mjs'),
  };
}

/** Build a role-filtered, private snapshot containing only this capability's skill data. */
export function createSkillsMcpSnapshotFile(store: Store, role: AgentRole): string {
  const diagnostics = store.getSkillCatalogDiagnostics();
  const snapshot: SkillsMcpSnapshot = {
    version: 1,
    skills: store.listSkillsForRole(role).map((metadata) => {
      const skill = store.getSkill(metadata.id);
      const references = Object.fromEntries(
        (metadata.references ?? []).flatMap((reference) => {
          const content = store.loadSkillReference(metadata.id, reference);
          return content === undefined ? [] : [[reference, content]];
        }),
      );
      return {
        metadata,
        ...(skill?.body !== undefined ? { body: skill.body } : {}),
        references,
        ...(diagnostics.find((entry) => entry.skillId === metadata.id)
          ? { diagnostic: diagnostics.find((entry) => entry.skillId === metadata.id)!.message }
          : {}),
      };
    }),
  };
  const directory = mkdtempSync(path.join('/tmp', 'adelic-skills-mcp-'));
  const file = path.join(directory, 'catalog.json');
  writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
  return file;
}

/** Build the internal, run-scoped skills MCP entry for dev (tsx) or a packaged bundle. */
export function skillsMcpRunServer(role: AgentRole, store: Store): RunMcpServer {
  const packagedEntry = process.env.ADELIC_SKILLS_MCP_ENTRY;
  const source = packagedEntry ? undefined : skillsMcpSourcePaths();
  const entry = packagedEntry || source!.entry;
  const electronRuntime = Boolean(process.versions.electron);
  return {
    name: 'adelic-skills',
    command: process.execPath,
    args: packagedEntry ? [entry] : ['--import', source!.loader, entry],
    env: {
      ADELIC_SKILLS_SNAPSHOT: createSkillsMcpSnapshotFile(store, role),
      ADELIC_SKILL_ROLE: role,
      ...(electronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    passEnv: [],
    // Kiro/ACP cannot enforce per-server tool allowlists. This MCP process exposes only its
    // three fixed read-only tools itself, so do not set an ACP allowlist.
  };
}

/** Exact capability check used by remote/isolated provider profiles; names alone are not trusted. */
export function isSkillsMcpServer(server: RunMcpServer): boolean {
  const entry = process.env.ADELIC_SKILLS_MCP_ENTRY;
  const source = entry ? undefined : skillsMcpSourcePaths();
  const expectedEntry = entry || source!.entry;
  const expectedArgs = entry ? [expectedEntry] : ['--import', source!.loader, expectedEntry];
  const validRoles = new Set<AgentRole>(['worker', 'planner', 'reviewer', 'synthesis']);
  const envKeys = Object.keys(server.env).sort();
  const expectedEnvKeys = (
    process.versions.electron
      ? ['ADELIC_SKILL_ROLE', 'ADELIC_SKILLS_SNAPSHOT', 'ELECTRON_RUN_AS_NODE']
      : ['ADELIC_SKILL_ROLE', 'ADELIC_SKILLS_SNAPSHOT']
  ).sort();
  return (
    server.name === 'adelic-skills' &&
    server.command === process.execPath &&
    server.args.length === expectedArgs.length &&
    server.args.every((arg, index) => arg === expectedArgs[index]) &&
    server.passEnv.length === 0 &&
    server.tools === undefined &&
    envKeys.length === expectedEnvKeys.length &&
    envKeys.every((key, index) => key === expectedEnvKeys[index]) &&
    path.isAbsolute(server.env.ADELIC_SKILLS_SNAPSHOT ?? '') &&
    path.basename(server.env.ADELIC_SKILLS_SNAPSHOT ?? '') === 'catalog.json' &&
    path.basename(path.dirname(server.env.ADELIC_SKILLS_SNAPSHOT ?? '')).startsWith('adelic-skills-mcp-') &&
    validRoles.has(server.env.ADELIC_SKILL_ROLE as AgentRole) &&
    (!process.versions.electron || server.env.ELECTRON_RUN_AS_NODE === '1')
  );
}

/** Remove only private run-scoped snapshots owned by this exact internal capability. */
export function cleanupSkillsMcpSnapshots(servers: RunMcpServer[] | undefined): void {
  for (const server of servers ?? []) {
    if (!isSkillsMcpServer(server)) continue;
    const snapshot = server.env.ADELIC_SKILLS_SNAPSHOT!;
    const directory = path.dirname(snapshot);
    const relative = path.relative('/tmp', directory);
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      !path.basename(directory).startsWith('adelic-skills-mcp-')
    )
      continue;
    try {
      const directoryInfo = lstatSync(directory);
      const snapshotInfo = lstatSync(snapshot);
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (
        !directoryInfo.isDirectory() ||
        !snapshotInfo.isFile() ||
        (uid !== undefined && (directoryInfo.uid !== uid || snapshotInfo.uid !== uid)) ||
        (directoryInfo.mode & 0o077) !== 0 ||
        (snapshotInfo.mode & 0o077) !== 0 ||
        realpathSync(snapshot) !== snapshot
      )
        continue;
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Cleanup must not change the provider's result; an invalid or already removed path is ignored.
    }
  }
}

/** GET /api/projects/:id/mcp: which servers each provider would use, without secrets. */
export function projectMcpReport(
  store: Store,
  project: Project,
  env: NodeJS.ProcessEnv = process.env,
): ProjectMcpReport {
  const entries = enabledEntries(store, project);
  const names = entries.map((server) => server.name);
  const withTools = entries.filter((server) => server.tools?.length).map((server) => server.name);
  const providers: McpProviderReport[] = [
    {
      providerId: 'codex',
      servers: names,
      detail: names.length
        ? 'Configurados só para a thread de cada execução com ferramentas (thread/start). Qualquer outro MCP ativo bloqueia a execução.'
        : 'Nenhum servidor: a execução é bloqueada se o Codex tiver qualquer MCP ativo.',
    },
    {
      providerId: 'kiro',
      servers: withTools.length ? [] : names,
      detail: withTools.length
        ? `Execuções Kiro bloqueadas: o Kiro não aplica a lista de ferramentas de servidores recebidos por ACP (${withTools.join(', ')}).`
        : names.length
          ? 'Enviados em session/new nas execuções com ferramentas; outro servidor relatado pelo Kiro bloqueia a execução.'
          : 'Nenhum servidor: session/new recebe uma lista vazia e o Kiro roda com um KIRO_HOME isolado.',
    },
    {
      providerId: 'claude',
      servers: [],
      detail: 'Não suportado: o Claude roda com --strict-mcp-config e nenhum servidor.',
    },
    {
      providerId: 'opencode',
      servers: [],
      detail: 'Não suportado: a integração do OpenCode ainda não executa conversas.',
    },
  ];
  return {
    enabled: entries.map((server) => server.id),
    servers: entries.map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      commandFound: executable(server.command),
      missingEnv: server.env
        .filter((item) => item.from === 'adelic-env' && env[item.name] === undefined)
        .map((item) => item.name),
      ...(server.tools?.length ? { tools: server.tools } : {}),
    })),
    providers,
  };
}
