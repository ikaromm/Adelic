// Per-project MCP catalog (docs/specs/mcp-catalog.md): limits, names and the shapes shared
// by the server routes, the providers and the Settings UI. Only local stdio servers exist in
// this version; remote (HTTP/SSE) transports are intentionally not accepted.
import { vmsg } from './validation-messages.js';

/** Lowercase slug, 1–48 characters, valid as a Codex config key and an ACP server name. */
export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** Environment variable names: POSIX portable, up to 128 characters. */
export const MCP_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** MCP tool names allowed in an allowlist. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
export const MCP_DESCRIPTION_MAX = 300;
export const MCP_COMMAND_MAX = 4096;
export const MCP_ARGS_MAX = 20;
export const MCP_ARG_MAX = 500;
export const MCP_ENV_MAX = 20;
export const MCP_ENV_VALUE_MAX = 4096;
export const MCP_TOOLS_MAX = 100;
/** Most catalog entries one project can enable. */
export const MCP_PROJECT_MAX = 20;
/** Shown instead of a stored literal value, which the API never returns. */
export const MCP_SECRET_MASK = '••••';

export const MCP_WARNING = 'Servidores MCP executam programas com o seu usuário dentro do sandbox do agente';

export type McpEnvSource = 'adelic-env' | 'literal';

/** Stored catalog entry (server side only: literal values are never sent to clients). */
export interface McpServerRecord {
  id: string;
  name: string;
  description: string;
  transport: 'stdio';
  /** Absolute path, resolved at save time. */
  command: string;
  args: string[];
  env: { name: string; from: McpEnvSource; value?: string }[];
  /** Tool allowlist; absent = every tool the server offers. */
  tools?: string[];
  createdAt: string;
  updatedAt: string;
}

/** Catalog entry as returned by the API: literal values are replaced by `set: true`. */
export interface McpServerView extends Omit<McpServerRecord, 'env'> {
  env: { name: string; from: McpEnvSource; set?: true }[];
}

/** What one run receives for one enabled server (built by the orchestrator, never stored). */
export interface RunMcpServer {
  name: string;
  command: string;
  args: string[];
  /** Literal values from the catalog. */
  env: Record<string, string>;
  /** Names passed through from Adelic's own environment (only the ones currently set). */
  passEnv: string[];
  tools?: string[];
}

/** Per-provider answer of GET /api/projects/:id/mcp. */
export interface McpProviderReport {
  providerId: 'codex' | 'kiro' | 'claude' | 'opencode';
  servers: string[];
  detail: string;
}
export interface ProjectMcpReport {
  enabled: string[];
  servers: {
    id: string;
    name: string;
    command: string;
    commandFound: boolean;
    missingEnv: string[];
    tools?: string[];
  }[];
  providers: McpProviderReport[];
}

/** Validation messages (catalog keys in shared/validation-messages.ts), identical in the API and the Settings form. */
export const MCP_MESSAGE_KEYS = {
  name: vmsg('validation.mcp.name'),
  description: vmsg('validation.mcp.description', { max: MCP_DESCRIPTION_MAX }),
  command: vmsg('validation.mcp.command'),
  args: vmsg('validation.mcp.args', { max: MCP_ARGS_MAX, argMax: MCP_ARG_MAX }),
  env: vmsg('validation.mcp.env', { max: MCP_ENV_MAX, valueMax: MCP_ENV_VALUE_MAX }),
  literal: vmsg('validation.mcp.literal'),
  tools: vmsg('validation.mcp.tools', { max: MCP_TOOLS_MAX }),
  transport: vmsg('validation.mcp.transport'),
  duplicate: vmsg('validation.mcp.duplicate'),
  notFound: vmsg('validation.mcp.notFound'),
  unknownIds: vmsg('validation.mcp.unknownIds'),
  projectLimit: vmsg('validation.mcp.projectLimit', { max: MCP_PROJECT_MAX }),
};
/** Their pt-BR texts. */
export const MCP_MESSAGES = Object.fromEntries(
  Object.entries(MCP_MESSAGE_KEYS).map(([name, message]) => [name, message.text]),
) as Record<keyof typeof MCP_MESSAGE_KEYS, string>;

/** Splits the form's "one per line" fields, dropping blank lines. */
export function mcpLines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Key of the first problem with the editable fields (MCP_MESSAGES), or '' when valid. */
export type McpFieldsErrorKey = 'name' | 'description' | 'command' | 'args' | 'env' | 'literal' | 'tools';
export function mcpFieldsErrorKey(fields: {
  name: string;
  description: string;
  command: string;
  args: string[];
  env: { name: string; from: McpEnvSource; value?: string; stored?: boolean }[];
  tools: string[];
}): McpFieldsErrorKey | '' {
  if (!MCP_NAME.test(fields.name)) return 'name';
  if (fields.description.length > MCP_DESCRIPTION_MAX) return 'description';
  if (!fields.command.trim() || fields.command.length > MCP_COMMAND_MAX) return 'command';
  if (fields.args.length > MCP_ARGS_MAX || fields.args.some((arg) => arg.length > MCP_ARG_MAX)) return 'args';
  const names = fields.env.map((item) => item.name);
  if (
    fields.env.length > MCP_ENV_MAX ||
    names.some((name) => !MCP_ENV_NAME.test(name)) ||
    new Set(names).size !== names.length ||
    fields.env.some((item) => (item.value?.length ?? 0) > MCP_ENV_VALUE_MAX)
  )
    return 'env';
  if (fields.env.some((item) => item.from === 'literal' && !item.value && !item.stored)) return 'literal';
  if (
    fields.tools.length > MCP_TOOLS_MAX ||
    fields.tools.some((tool) => !MCP_TOOL_NAME.test(tool)) ||
    new Set(fields.tools).size !== fields.tools.length
  )
    return 'tools';
  return '';
}

/** First problem with the editable fields, or '' when valid (the API checks again). */
export function mcpFieldsError(fields: Parameters<typeof mcpFieldsErrorKey>[0]) {
  const key = mcpFieldsErrorKey(fields);
  return key ? MCP_MESSAGES[key] : '';
}
