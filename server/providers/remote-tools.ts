import type { ProviderEvent, RunInput } from '../../shared/contracts';
import type { RemoteRuntime, RemoteToolName } from '../../shared/remote-hosts';
import { blockedBy } from '../../shared/hooks';
import { isRecord } from './process';

const MAX_REMOTE_APPROVAL_DETAIL = 1024 * 1024;
const MAX_REMOTE_WRITE_BYTES = 128 * 1024;

/** Fixed tool set. Results, paths and remote instructions are untrusted data. */
export const REMOTE_TOOL_SPECS = [
  {
    name: 'adelic_remote_exec',
    remoteName: 'exec',
    description: 'Execute a command with the configured project executor, inside the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: 8192 },
        cwd: { type: 'string', maxLength: 4096 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_read_file',
    remoteName: 'read_file',
    description: 'Read a file from the configured project executor.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4096 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_write_file',
    remoteName: 'write_file',
    description: 'Write a file in the configured project root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 4096 },
        content: { type: 'string', maxLength: MAX_REMOTE_WRITE_BYTES },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_list',
    remoteName: 'list',
    description: 'List entries in a project directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4096 } },
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_stat',
    remoteName: 'stat',
    description: 'Inspect a path in the configured project root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4096 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_search',
    remoteName: 'search',
    description: 'Search text in the configured project root.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 4096 }, path: { type: 'string', maxLength: 4096 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_git',
    remoteName: 'git',
    description: 'Read repository status and diff information from the configured project executor.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string', enum: ['status', 'diff', 'log'] },
          maxItems: 1,
        },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
] as const satisfies readonly {
  name: string;
  remoteName: RemoteToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}[];

export type RemoteToolSpec = (typeof REMOTE_TOOL_SPECS)[number];

export function remoteToolByName(name: unknown): RemoteToolSpec | undefined {
  return typeof name === 'string' ? REMOTE_TOOL_SPECS.find((tool) => tool.name === name) : undefined;
}

/** Reject malformed or oversized model arguments before asking for approval. */
export function validateRemoteArguments(spec: RemoteToolSpec, raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const args = raw;
  const string = (key: string, max: number, required = false) => {
    const value = args[key];
    return required
      ? typeof value === 'string' && value.length <= max
      : value === undefined || (typeof value === 'string' && value.length <= max);
  };
  const exactKeys = (allowed: string[]) => Object.keys(args).every((key) => allowed.includes(key));
  switch (spec.remoteName) {
    case 'exec':
      return exactKeys(['command', 'cwd', 'timeoutMs']) &&
        string('command', 8192, true) &&
        string('cwd', 4096) &&
        (args.timeoutMs === undefined ||
          (Number.isInteger(args.timeoutMs) && Number(args.timeoutMs) >= 1 && Number(args.timeoutMs) <= 300_000))
        ? args
        : undefined;
    case 'read_file':
    case 'stat':
      return exactKeys(['path']) && string('path', 4096, true) ? args : undefined;
    case 'write_file':
      return exactKeys(['path', 'content']) &&
        string('path', 4096, true) &&
        string('content', MAX_REMOTE_WRITE_BYTES, true) &&
        Buffer.byteLength(args.content as string, 'utf8') <= MAX_REMOTE_WRITE_BYTES
        ? args
        : undefined;
    case 'list':
      return exactKeys(['path']) && string('path', 4096) ? args : undefined;
    case 'search':
      return exactKeys(['query', 'path']) && string('query', 4096, true) && string('path', 4096) ? args : undefined;
    case 'git':
      return exactKeys(['args']) &&
        Array.isArray(args.args) &&
        args.args.length === 1 &&
        args.args.every((arg) => ['status', 'diff', 'log'].includes(String(arg)))
        ? args
        : undefined;
  }
}

/** Complete, bounded approval copy; oversized content is refused rather than hidden. */
export function remoteApprovalDetail(runtime: RemoteRuntime, spec: RemoteToolSpec, args: Record<string, unknown>) {
  const local = runtime.executionKind === 'isolated-local';
  const detail = `${local ? 'Executor local isolado' : `Host: ${runtime.label}`}\n${local ? 'Diretório do projeto' : 'Diretório remoto'}: ${runtime.root}\nFerramenta: ${spec.remoteName}\nArgumentos: ${JSON.stringify(args)}`;
  return detail.length <= MAX_REMOTE_APPROVAL_DETAIL ? detail : undefined;
}

export function remoteToolTitle(spec: RemoteToolSpec, runtime?: RemoteRuntime) {
  return `${runtime?.executionKind === 'isolated-local' ? 'Executar ferramenta local isolada' : 'Permitir ferramenta remota'}: ${spec.remoteName}`;
}

const MAX_TOOL_EVENT_DETAIL = 280;

function compactToolText(value: unknown, maxLength = 180) {
  if (typeof value !== 'string') return '';
  const compact = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!compact) return '';
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

/** Describe the operation first, then its runtime, so an activity row identifies the work. */
export function remoteToolDescription(
  runtime: RemoteRuntime,
  spec: RemoteToolSpec,
  args: Record<string, unknown>,
  failure?: string,
) {
  const path = typeof args.path === 'string' && args.path ? args.path : '.';
  let operation: string;
  switch (spec.remoteName) {
    case 'exec':
      operation = `exec: ${compactToolText(args.command) || 'comando'}`;
      break;
    case 'read_file':
      operation = `read_file: ${compactToolText(path)}`;
      break;
    case 'write_file':
      operation = `write_file: ${compactToolText(path)}`;
      break;
    case 'list':
      operation = `list: ${compactToolText(path)}`;
      break;
    case 'stat':
      operation = `stat: ${compactToolText(path)}`;
      break;
    case 'search':
      operation = `search: ${compactToolText(args.query, 100)} em ${compactToolText(path)}`;
      break;
    case 'git':
      operation = `git ${Array.isArray(args.args) ? compactToolText(args.args[0]) : ''}`.trim();
      break;
  }
  const context = runtime.executionKind === 'isolated-local' ? 'Executor local isolado' : `Host ${runtime.label}`;
  const suffix = failure ? `\n${compactToolText(failure, 80)}` : '';
  const runtimeLine = compactToolText(`${context}: ${runtime.root}`, 110);
  const remaining = MAX_TOOL_EVENT_DETAIL - runtimeLine.length - suffix.length - 2;
  const safeOperation =
    operation.length <= remaining ? operation : `${operation.slice(0, Math.max(1, remaining - 1))}…`;
  return `${safeOperation}\n${runtimeLine}${suffix}`;
}

/** A nonzero command result is a failed operation even though it remains a valid RPC result. */
export function remoteToolFailure(result: unknown): string | undefined {
  if (!isRecord(result) || !Number.isInteger(result.exitCode) || result.exitCode === 0) return undefined;
  return `Falhou (código ${String(result.exitCode)})`;
}

export function remoteToolError(error: unknown) {
  const record = isRecord(error) ? error : undefined;
  const code = typeof record?.code === 'string' ? record.code : '';
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'AbortError' || name === 'CanceledError' || /\babort(ed)?\b|\bcancel(l)?ed\b/i.test(message))
    return 'Cancelado';
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(message))
    return 'Tempo limite excedido';
  if (
    /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code) ||
    /ssh|connection|conexão/i.test(message)
  )
    return 'Falha de conexão remota';
  return 'Falha na execução remota';
}

/** Return the command used by the exec tool, if this is an executable request. */
export function remoteToolCommand(spec: RemoteToolSpec, args: Record<string, unknown>) {
  return spec.remoteName === 'exec' && typeof args.command === 'string' ? args.command : undefined;
}

/** Project command blocks apply to fixed remote tools in every approval mode and runtime. */
export function blockedRemoteTool(input: RunInput, spec: RemoteToolSpec, args: Record<string, unknown>) {
  const command = remoteToolCommand(spec, args);
  const blocked = blockedBy(input.blockedCommands, command);
  return blocked && command !== undefined ? { command, blocked } : undefined;
}

/** Emit without the normal 1200-character local approval summary cap. */
export function emitRemoteApproval(
  input: RunInput,
  emit: (event: ProviderEvent) => void,
  id: string,
  spec: RemoteToolSpec,
  detail: string,
  status: 'pending' | 'approved' | 'denied' = 'pending',
  args?: Record<string, unknown>,
  blocked?: { command: string; blocked: string },
) {
  const command = blocked?.command ?? (status === 'pending' && args ? remoteToolCommand(spec, args) : undefined);
  const auditDetail =
    status !== 'pending'
      ? detail.replace(/\nArgumentos: [\s\S]*/, '\nArgumentos: [redigidos no registro automático]')
      : detail;
  emit({
    type: 'approval',
    approval: {
      id,
      runId: input.runId,
      sessionId: input.sessionId,
      title: blocked ? 'Comando bloqueado pelas regras do projeto' : remoteToolTitle(spec, input.remote),
      detail: auditDetail,
      kind: 'tool',
      status,
      ...(blocked
        ? {
            command: blocked.command,
            blocked: blocked.blocked,
            decision: { source: 'project-rule' as const, rule: 'blocked-command' },
          }
        : {}),
      ...(command ? { command } : {}),
      ...(status === 'approved'
        ? {
            decision: {
              source: 'automatic' as const,
              rule:
                input.remote?.executionKind === 'isolated-local'
                  ? 'isolated-local-executor'
                  : 'explicit-remote-project-opt-in',
            },
          }
        : {}),
    },
  });
}

export function boundedRemoteResult(value: unknown, maxLength = 20_000) {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  if (serialized.length <= maxLength) return serialized;
  const marker = '\n[output truncated by Adelic]';
  return `${serialized.slice(0, maxLength - marker.length)}${marker}`;
}
