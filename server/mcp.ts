// MCP catalog (docs/specs/mcp-catalog.md): command resolution, the client view (literal
// environment values are write-only), what a run receives and the per-project report.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/contracts.js';
import {
  MCP_MESSAGES,
  type McpProviderReport,
  type McpServerRecord,
  type McpServerView,
  type ProjectMcpReport,
  type RunMcpServer,
} from '../shared/mcp.js';
import type { Store } from './store.js';

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
    if (!executable(normalized))
      throw Object.assign(new Error(`Comando não encontrado ou sem permissão de execução: ${normalized}`), {
        status: 400,
      });
    return normalized;
  }
  if (command.includes('/') || command.includes('\\') || !/^[\w.+-]+$/.test(command))
    throw Object.assign(new Error(MCP_MESSAGES.command), { status: 400 });
  const found = which(command);
  if (!found || !path.isAbsolute(found) || !executable(found))
    throw Object.assign(new Error(`Comando não encontrado no PATH do Adelic: ${command}`), { status: 400 });
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
