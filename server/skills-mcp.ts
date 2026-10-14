import type { AgentRole, SkillCatalogEntry } from '../shared/contracts.js';
import type { Store } from './store.js';

export interface SkillsMcpSnapshotItem {
  metadata: SkillCatalogEntry;
  body?: string;
  references: Record<string, string>;
  diagnostic?: string;
}
export interface SkillsMcpSnapshot {
  version: 1;
  skills: SkillsMcpSnapshotItem[];
}
interface SkillsSource {
  listSkillsForRole(role: AgentRole): SkillCatalogEntry[];
  getSkillBody(id: string): string | undefined;
  getReference(id: string, reference: string): string | undefined;
  diagnostic(id: string): string | undefined;
  close(): void;
}

export const SKILLS_MCP_OUTPUT_MAX = 128_000;
export const SKILLS_MCP_CATALOG_MAX = 12_000;
export const SKILLS_MCP_PAGE_SIZE = 10;
const roles = new Set<AgentRole>(['worker', 'planner', 'reviewer', 'synthesis']);

export interface SkillsMcpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}
export interface SkillsMcpResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface SkillsMcpServer {
  handle(message: SkillsMcpRequest): SkillsMcpResponse | undefined;
  close(): void;
}

const toolSchemas = [
  {
    name: 'list_skills',
    description:
      'Lista por páginas os metadados das skills habilitadas e autorizadas para o papel desta execução. Não retorna instruções.',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'get_skill_body',
    description:
      'Carrega integralmente o corpo de uma skill habilitada e permitida para este papel. Nunca trunca o conteúdo.',
    inputSchema: {
      type: 'object',
      properties: { skillId: { type: 'string' } },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_skill_reference',
    description:
      'Carrega integralmente uma referência declarada no manifesto de uma skill habilitada e permitida para este papel.',
    inputSchema: {
      type: 'object',
      properties: { skillId: { type: 'string' }, reference: { type: 'string' } },
      required: ['skillId', 'reference'],
      additionalProperties: false,
    },
  },
] as const;
const initializeResult = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'adelic-skills', version: '1.0.0' },
};
function textResult(value: string, isError = false) {
  return { content: [{ type: 'text', text: value }], isError };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validArgs(args: unknown, keys: string[]): args is Record<string, string> {
  return (
    object(args) &&
    Object.keys(args).every((key) => keys.includes(key)) &&
    keys.every((key) => typeof args[key] === 'string')
  );
}
function visibleSkills(source: SkillsSource, role: AgentRole) {
  return source.listSkillsForRole(role);
}

export function createSkillsMcpServer(store: Store, role: AgentRole): SkillsMcpServer {
  return createSkillsMcpServerForSource(
    {
      listSkillsForRole: (currentRole) => store.listSkillsForRole(currentRole),
      getSkillBody: (id) => store.getSkill(id)?.body,
      getReference: (id, reference) => store.loadSkillReference(id, reference),
      diagnostic: (id) => store.getSkillCatalogDiagnostics().find((entry) => entry.skillId === id)?.message,
      close: () => store.close(),
    },
    role,
  );
}

export function createSkillsMcpServerFromSnapshot(snapshot: SkillsMcpSnapshot, role: AgentRole): SkillsMcpServer {
  if (snapshot.version !== 1 || !Array.isArray(snapshot.skills)) throw new Error('Invalid skills capability snapshot.');
  const byId = new Map(snapshot.skills.map((item) => [item.metadata.id, item]));
  const source: SkillsSource = {
    listSkillsForRole: (currentRole) =>
      snapshot.skills
        .filter((item) => item.metadata.enabled && (!item.metadata.roles || item.metadata.roles.includes(currentRole)))
        .map((item) => item.metadata),
    getSkillBody: (id) => byId.get(id)?.body,
    getReference: (id, reference) => byId.get(id)?.references[reference],
    diagnostic: (id) => byId.get(id)?.diagnostic,
    close() {},
  };
  return createSkillsMcpServerForSource(source, role);
}

function createSkillsMcpServerForSource(source: SkillsSource, role: AgentRole): SkillsMcpServer {
  if (!roles.has(role)) throw new Error('Invalid skill role.');
  let emittedChars = 0;
  const respond = (id: unknown, result: unknown): SkillsMcpResponse => ({ jsonrpc: '2.0', id, result });
  const toolError = (id: unknown, message: string) => respond(id, textResult(message, true));
  const emitText = (id: unknown, value: string): SkillsMcpResponse => {
    if (emittedChars + value.length > SKILLS_MCP_OUTPUT_MAX)
      return toolError(
        id,
        `Skill tool budget exceeded (${SKILLS_MCP_OUTPUT_MAX} characters); no content was truncated.`,
      );
    emittedChars += value.length;
    return respond(id, textResult(value));
  };
  return {
    handle(message) {
      if (!object(message) || message.jsonrpc !== '2.0' || !('id' in message)) return undefined;
      const id = message.id;
      if (message.method === 'initialize') return respond(id, initializeResult);
      if (message.method === 'tools/list') return respond(id, { tools: toolSchemas });
      if (message.method !== 'tools/call')
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } };
      const params = object(message.params) ? message.params : {};
      const name = params.name;
      const args = params.arguments ?? {};
      const allowed = visibleSkills(source, role);
      if (name === 'list_skills') {
        if (
          !object(args) ||
          Object.keys(args).some((key) => key !== 'cursor') ||
          (args.cursor !== undefined && typeof args.cursor !== 'string')
        )
          return toolError(id, 'Invalid arguments.');
        const cursor = args.cursor ?? '0';
        if (!/^(0|[1-9][0-9]*)$/.test(cursor)) return toolError(id, 'Invalid catalog cursor.');
        const offset = Number(cursor);
        if (!Number.isSafeInteger(offset) || offset > allowed.length) return toolError(id, 'Invalid catalog cursor.');
        const page: { id: string; name: string; description: string; references: string[] }[] = [];
        let chars = 0;
        for (const { id: skillId, name: skillName, description, references } of allowed.slice(
          offset,
          offset + SKILLS_MCP_PAGE_SIZE,
        )) {
          const entry = { id: skillId, name: skillName, description, references: references ?? [] };
          const size = JSON.stringify(entry).length + (page.length ? 1 : 0);
          if (chars + size > SKILLS_MCP_CATALOG_MAX) {
            if (!page.length)
              return toolError(
                id,
                'One skill catalog entry exceeds the metadata response limit; no content was truncated.',
              );
            break;
          }
          page.push(entry);
          chars += size;
        }
        const next = offset + page.length;
        return emitText(id, JSON.stringify({ skills: page, nextCursor: next < allowed.length ? String(next) : null }));
      }
      if (name === 'get_skill_body' || name === 'get_skill_reference') {
        const required = name === 'get_skill_body' ? ['skillId'] : ['skillId', 'reference'];
        if (!validArgs(args, required)) return toolError(id, 'Invalid arguments.');
        const skillId = args.skillId as string;
        const metadata = allowed.find((skill) => skill.id === skillId);
        if (!metadata) return toolError(id, 'Skill unavailable for this run role or disabled by administrator.');
        if (name === 'get_skill_body') {
          const body = source.getSkillBody(skillId);
          if (body === undefined)
            return toolError(id, source.diagnostic(skillId) ?? 'Complete skill body unavailable.');
          return emitText(id, body);
        }
        const reference = args.reference as string;
        if (!metadata.references?.includes(reference)) return toolError(id, 'Reference is not declared by this skill.');
        const content = source.getReference(skillId, reference);
        if (content === undefined)
          return toolError(id, source.diagnostic(skillId) ?? 'Declared reference could not be loaded completely.');
        return emitText(id, content);
      }
      return toolError(id, 'Unknown skill tool.');
    },
    close() {
      source.close();
    },
  };
}

export function attachSkillsMcpStdio(
  server: SkillsMcpServer,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): () => void {
  let buffer = '';
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let request: SkillsMcpRequest;
      try {
        request = JSON.parse(line) as SkillsMcpRequest;
      } catch {
        output.write(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }) + '\n',
        );
        continue;
      }
      const response = server.handle(request);
      if (response) output.write(JSON.stringify(response) + '\n');
    }
  };
  const onEnd = () => server.close();
  input.on('data', onData);
  input.once('end', onEnd);
  return () => {
    input.off('data', onData);
    input.off('end', onEnd);
  };
}
