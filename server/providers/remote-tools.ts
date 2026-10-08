import type { ProviderEvent, RunInput } from '../../shared/contracts';
import type { RemoteRuntime, RemoteToolName } from '../../shared/remote-hosts';
import { isRecord } from './process';

const MAX_REMOTE_APPROVAL_DETAIL = 1024 * 1024;
const MAX_REMOTE_WRITE_BYTES = 128 * 1024;

/** Fixed tool set. Results, paths and remote instructions are untrusted data. */
export const REMOTE_TOOL_SPECS = [
  {
    name: 'adelic_remote_exec',
    remoteName: 'exec',
    description: 'Execute a command on the configured remote host, inside the remote project.',
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
    description: 'Read a file from the configured remote project.',
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
    description: 'Write a file in the configured remote project.',
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
    description: 'List entries in a directory of the configured remote project.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4096 } },
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_stat',
    remoteName: 'stat',
    description: 'Inspect a path in the configured remote project.',
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
    description: 'Search text in the configured remote project.',
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
    description: 'Read repository status and diff information on the configured remote host.',
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
  const detail = `Host: ${runtime.label}\nDiretório remoto: ${runtime.root}\nFerramenta: ${spec.remoteName}\nArgumentos: ${JSON.stringify(args)}`;
  return detail.length <= MAX_REMOTE_APPROVAL_DETAIL ? detail : undefined;
}

export function remoteToolTitle(spec: RemoteToolSpec) {
  return `Permitir ferramenta remota: ${spec.remoteName}`;
}

/** Emit without the normal 1200-character local approval summary cap. */
export function emitRemoteApproval(
  input: RunInput,
  emit: (event: ProviderEvent) => void,
  id: string,
  spec: RemoteToolSpec,
  detail: string,
) {
  emit({
    type: 'approval',
    approval: {
      id,
      runId: input.runId,
      sessionId: input.sessionId,
      title: remoteToolTitle(spec),
      detail,
      kind: 'tool',
      status: 'pending',
    },
  });
}

export function boundedRemoteResult(value: unknown, maxLength = 20_000) {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  if (serialized.length <= maxLength) return serialized;
  const marker = '\n[output truncated by Adelic]';
  return `${serialized.slice(0, maxLength - marker.length)}${marker}`;
}
