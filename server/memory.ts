import type { Integration, MemoryHit, MemoryPage, Project } from '../shared/contracts.js';
import type { MemoryScope } from '../shared/contracts.js';
import { createHash } from 'node:crypto';
import { adminWritePage, memoryAuthHeaders, memoryPageExists, memoryServiceUrl } from './memory-service.js';
import { planExistingEdit, preservedFrontmatter } from './memory-edit.js';

const endpoint = () => `${memoryServiceUrl()}/mcp`;
type Tool = { name: string; description?: string; inputSchema?: unknown };
let toolsCache: Tool[] | undefined;
let nextId = 1;
let integrationCache: Integration | undefined;
let integrationRefresh: Promise<Integration> | undefined;
let integrationCheckedAt = 0;

async function rpc(method: string, params: unknown, timeoutMs = 2500): Promise<any> {
  const url = endpoint(),
    auth = memoryAuthHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...auth },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new Error(
        `O MCP do ai-memory recusou o acesso (HTTP ${response.status}). Se o serviço usa AI_MEMORY_AUTH_TOKEN, informe o mesmo token ao Adelic em ADELIC_MEMORY_TOKEN ou ADELIC_MEMORY_TOKEN_FILE.`,
      );
    if (!response.ok) throw new Error(`ai-memory respondeu HTTP ${response.status}`);
    const raw = await response.text();
    const line = raw
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5)
      .trim();
    const data = JSON.parse(line || raw);
    if (data.error) {
      const e: any = new Error(data.error.message || 'Erro JSON-RPC do ai-memory');
      e.code = data.error.code;
      throw e;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}
async function getTools() {
  if (toolsCache) return toolsCache;
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'adelic', version: '0.1.0' },
    });
  } catch {
    /* server may already be initialized or omit initialize */
  }
  const result = await rpc('tools/list', {});
  toolsCache = result.tools ?? [];
  return toolsCache!;
}
const toolNames = { search: ['memory_query'], read: ['memory_read_page'], write: ['memory_write_page'] } as const;
async function call(kind: 'search' | 'read' | 'write', project: Project, args: Record<string, unknown>) {
  const ts = await getTools();
  const tool = ts.find((t) => toolNames[kind].includes(t.name as never));
  if (!tool)
    throw new Error(
      `ai-memory não oferece ferramenta de ${kind === 'search' ? 'busca' : kind === 'read' ? 'leitura' : 'escrita'} nesta conexão`,
    );
  const properties = (tool.inputSchema as any)?.properties ?? {};
  if (!Object.hasOwn(properties, 'workspace') || !Object.hasOwn(properties, 'project'))
    throw new Error('Ferramenta ai-memory sem escopo explícito de workspace/project');
  if (!project.memoryWorkspace || !project.memoryProject) throw new Error('Projeto sem escopo de memória configurado');
  const candidates: Record<string, unknown> = {
    workspace: project.memoryWorkspace,
    project: project.memoryProject,
    query: args.query,
    q: args.query,
    path: args.path,
    body: args.body,
    title: args.title,
    ...(kind === 'write' ? ((args.metadata as Record<string, unknown>) ?? {}) : {}),
  };
  const params = Object.fromEntries(Object.entries(candidates).filter(([k, v]) => k in properties && v !== undefined));
  const result = await rpc('tools/call', { name: tool.name, arguments: params }, 8000);
  if (result?.isError)
    throw new Error(result.content?.map((x: any) => x.text).join('\n') || 'Falha da ferramenta ai-memory');
  return result;
}
async function callScope(kind: 'search' | 'read' | 'write', scope: MemoryScope, args: Record<string, unknown>) {
  const ts = await getTools();
  const tool = ts.find((t) => toolNames[kind].includes(t.name as never));
  if (!tool) throw new Error(`ai-memory não oferece ferramenta de ${kind}`);
  const properties = (tool.inputSchema as any)?.properties ?? {};
  if (!Object.hasOwn(properties, 'workspace') || !Object.hasOwn(properties, 'project'))
    throw new Error('Ferramenta ai-memory sem escopo explícito de workspace/project');
  // memory_query accepts either `scopes` OR workspace/project. Prefer its
  // explicit scopes form so the selected scope is isolated without a union.
  const candidates: Record<string, unknown> = {
    ...(kind === 'search' && Object.hasOwn(properties, 'scopes')
      ? { scopes: [scope] }
      : { workspace: scope.workspace, project: scope.project }),
    ...args,
  };
  const params = Object.fromEntries(Object.entries(candidates).filter(([k, v]) => k in properties && v !== undefined));
  const result = await rpc('tools/call', { name: tool.name, arguments: params }, 8000);
  if (result?.isError)
    throw new Error(result.content?.map((x: any) => x.text).join('\n') || 'Falha da ferramenta ai-memory');
  return result;
}
function unwrap(result: any): any {
  const content = result?.content;
  const text = content?.find((x: any) => x.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result?.structuredContent ?? result;
}

export async function memorySearch(project: Project, q: string): Promise<MemoryHit[]> {
  const r = unwrap(await call('search', project, { query: q }));
  const hits = Array.isArray(r) ? r : (r.hits ?? r.results ?? r.pages ?? []);
  return hits.map((h: any) => ({
    path: String(h.path ?? h.relative_path ?? ''),
    title: String(h.title ?? h.name ?? h.path ?? 'Nota'),
    snippet: String(h.snippet ?? h.excerpt ?? h.content ?? '').slice(0, 600),
  }));
}
export async function memoryRead(project: Project, path: string): Promise<MemoryPage> {
  const r = unwrap(await call('read', project, { path }));
  return {
    path: String(r.path ?? path),
    title: String(r.title ?? path),
    body: String(r.body ?? r.content ?? r.text ?? ''),
    frontmatter: normalizeFrontmatter(r.frontmatter),
  } as MemoryPage;
}
export async function memoryWrite(project: Project, path: string, body: string): Promise<MemoryPage> {
  if (project.memoryProject === '_global')
    throw Object.assign(new Error('Escrita no escopo _global não permitida'), { status: 403 });
  return sharedMemoryWrite(
    { workspace: project.memoryWorkspace!, project: project.memoryProject! },
    path,
    body,
    undefined,
  );
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new Error('Frontmatter ai-memory contém valor não JSON-safe');
}
const version = (body: string, frontmatter: Record<string, unknown>) =>
  createHash('sha256')
    .update(JSON.stringify({ body, frontmatter: stable(frontmatter) }))
    .digest('hex');
function acceptsType(schema: unknown, type: string): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const declared = (schema as { type?: unknown }).type;
  return declared === type || (Array.isArray(declared) && declared.includes(type));
}
export async function sharedMemorySearch(scope: MemoryScope, q: string): Promise<MemoryHit[]> {
  const r = unwrap(await callScope('search', scope, { query: q }));
  const hits = Array.isArray(r) ? r : (r.hits ?? r.results ?? r.pages ?? []);
  return hits.map((h: any) => ({
    path: String(h.path ?? h.relative_path ?? ''),
    title: String(h.title ?? h.name ?? h.path ?? 'Nota'),
    snippet: String(h.snippet ?? h.excerpt ?? h.content ?? '').slice(0, 600),
  }));
}
export async function sharedMemoryRead(scope: MemoryScope, path: string): Promise<MemoryPage> {
  const r = unwrap(await callScope('read', scope, { path }));
  const body = String(r.body ?? r.content ?? r.text ?? '');
  const frontmatter = normalizeFrontmatter(r.frontmatter);
  return {
    path: String(r.path ?? path),
    title: String(r.title ?? path),
    body,
    frontmatter,
    version: version(body, frontmatter),
  } as MemoryPage;
}
function normalizeFrontmatter(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return stable(value as Record<string, unknown>);
}
const saves = new Map<string, Promise<MemoryPage>>();
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const missingPage = (e: unknown, scope: MemoryScope, path: string) =>
  (e as any)?.code === -32603 &&
  (e as Error).message === `page ${path} not found in resolved scope ${scope.workspace}/${scope.project}`;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
async function writeTool() {
  const ts = await getTools();
  const tool = ts.find((t) => toolNames.write.includes(t.name as never));
  if (!tool) throw new Error('ai-memory não oferece ferramenta de escrita');
  const props = (tool.inputSchema as any)?.properties ?? {};
  for (const field of ['workspace', 'project', 'path', 'body'])
    if (!acceptsType(props[field], 'string'))
      throw new Error(`Schema memory_write_page inválido: ${field} deve aceitar string`);
  return { tool, props };
}
async function mcpWrite(args: Record<string, unknown>) {
  const { tool, props } = await writeTool();
  for (const field of Object.keys(args))
    if (!Object.hasOwn(props, field))
      throw new Error(`memory_write_page não aceita ${field}; edição bloqueada para preservar os metadados`);
  const result = await rpc('tools/call', { name: tool.name, arguments: args }, 10000);
  if (result?.isError)
    throw new Error(result.content?.map((x: any) => x.text).join('\n') || 'Falha da ferramenta ai-memory');
}
export function sharedMemoryWrite(
  scope: MemoryScope,
  path: string,
  body: string,
  expectedVersion: string | null | undefined,
): Promise<MemoryPage> {
  if (scope.project === '_global')
    return Promise.reject(Object.assign(new Error('Escrita no escopo _global não permitida'), { status: 403 }));
  const key = `${scope.workspace}\0${scope.project}\0${path}`;
  const prev = saves.get(key) ?? Promise.resolve({ path, title: path, body: '', version: '' });
  const next = prev
    .catch(() => ({ path, title: path, body: '', version: '' }))
    .then(async () => {
      let current: MemoryPage | undefined;
      try {
        current = await sharedMemoryRead(scope, path);
      } catch (e) {
        // Only an absent page permits creation; MCP/network/schema failures must not
        // be mistaken for a missing note and turned into an overwrite attempt.
        if (missingPage(e, scope, path)) current = undefined;
        else throw e;
      }
      const expected = expectedVersion === undefined ? (current?.version ?? null) : expectedVersion;
      if (expected === null && current === undefined && (await memoryPageExists(scope, path)))
        throw conflict('Já existe uma nota nesse caminho; recarregue antes de editar');
      if (expected === null ? current !== undefined : !current || current.version !== expected)
        throw conflict('A nota foi alterada desde a leitura; recarregue antes de salvar');
      if (current) {
        // Existing notes are rewritten by the service itself (no access to its files),
        // only when a writer reproduces every metadata key; otherwise fail before writing.
        const plan = planExistingEdit(scope, path, current.frontmatter ?? {});
        const latest = await sharedMemoryRead(scope, path);
        if (latest.version !== current.version)
          throw conflict('A nota ou seus metadados foram alterados durante a edição; recarregue antes de salvar');
        if (plan.writer === 'admin')
          await adminWritePage({ workspace: scope.workspace, project: scope.project, path, body, ...plan.args });
        else await mcpWrite({ workspace: scope.workspace, project: scope.project, path, body, ...plan.args });
        const confirmed = await sharedMemoryRead(scope, path);
        if (confirmed.body !== body)
          throw Object.assign(
            new Error(
              'O ai-memory não confirmou o corpo salvo (o serviço pode ter alterado o texto, por exemplo ao remover dados sensíveis); recarregue a nota',
            ),
            { status: 503 },
          );
        if (
          !sameJson(
            preservedFrontmatter(path, confirmed.frontmatter ?? {}),
            preservedFrontmatter(path, current.frontmatter ?? {}),
          )
        )
          throw Object.assign(
            new Error(
              'O ai-memory salvou a nota, mas os metadados lidos depois diferem dos anteriores; confira a nota antes de editar de novo',
            ),
            { status: 503 },
          );
        return confirmed;
      }
      // Validate the write contract before attempting any write. In particular, never
      // let argument filtering silently remove the explicit scope or note body.
      await mcpWrite({ workspace: scope.workspace, project: scope.project, path, body });
      const confirmed = await sharedMemoryRead(scope, path);
      if (confirmed.body !== body)
        throw Object.assign(new Error('O MCP não confirmou o corpo recém-criado'), { status: 503 });
      return confirmed;
    });
  saves.set(key, next);
  void next
    .finally(() => {
      if (saves.get(key) === next) saves.delete(key);
    })
    .catch(() => {});
  return next;
}

const memoryStopwords = new Set([
  'a',
  'as',
  'o',
  'os',
  'de',
  'da',
  'das',
  'do',
  'dos',
  'e',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'que',
  'qual',
  'quais',
  'como',
  'para',
  'por',
  'sobre',
  'com',
  'minha',
  'meu',
  'meus',
  'nossa',
  'nosso',
  'isso',
  'essa',
  'esse',
  'antes',
  'anterior',
  'anteriores',
  'lembre',
  'lembra',
  'lembrar',
  'memoria',
  'memory',
  'decidimos',
  'decisao',
  'decisoes',
  'configuracao',
  'configuracoes',
  'what',
  'about',
  'the',
  'and',
  'our',
  'previous',
  'remember',
]);
export function memoryQueryTerms(content: string): string[] {
  const words =
    content
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  const terms = [...new Set(words.filter((word) => !memoryStopwords.has(word.toLowerCase())))];
  terms.sort((a, b) => Number(/^[A-Z0-9_-]{2,}$/.test(b)) - Number(/^[A-Z0-9_-]{2,}$/.test(a)));
  return (terms.length ? terms : ['decisão']).slice(0, 3);
}
export async function memoryContextFor(project: Project, content: string): Promise<string | undefined> {
  let hits: MemoryHit[] = [];
  for (const term of memoryQueryTerms(content)) {
    hits = await memorySearch(project, term);
    if (hits.length) break;
  }
  const hit = hits.find(
    (item) =>
      item.path.endsWith('.md') &&
      !item.path.startsWith('/') &&
      !item.path.split('/').includes('..') &&
      !item.path.includes('\\'),
  );
  if (!hit) return undefined;
  const page = await memoryRead(project, hit.path);
  const body = page.body.slice(0, 6000);
  return `Fonte: ${page.path}\n${body}${page.body.length > body.length ? '\n[Nota truncada pelo limite de contexto]' : ''}`;
}
export async function memoryIntegration(timeoutMs = 700): Promise<Integration> {
  if (integrationCache && Date.now() - integrationCheckedAt < 10000) return integrationCache;
  if (integrationRefresh) return integrationRefresh;
  integrationRefresh = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...memoryAuthHeaders(),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
        signal: controller.signal,
      });
      integrationCache = r.ok
        ? {
            id: 'ai-memory',
            name: 'ai-memory',
            kind: 'memory',
            status: 'ready',
            detail: 'Servidor MCP local disponível',
          }
        : {
            id: 'ai-memory',
            name: 'ai-memory',
            kind: 'memory',
            status: 'error',
            detail:
              r.status === 401 || r.status === 403
                ? `Servidor MCP recusou o acesso (HTTP ${r.status}); configure ADELIC_MEMORY_TOKEN ou ADELIC_MEMORY_TOKEN_FILE`
                : `Servidor MCP retornou HTTP ${r.status}`,
          };
    } catch (e) {
      integrationCache = {
        id: 'ai-memory',
        name: 'ai-memory',
        kind: 'memory',
        status: 'missing',
        detail: /ADELIC_MEMORY_/.test(String((e as Error)?.message))
          ? (e as Error).message
          : 'Servidor MCP local indisponível',
      };
    } finally {
      clearTimeout(timer);
      integrationCheckedAt = Date.now();
      integrationRefresh = undefined;
    }
    return integrationCache!;
  })();
  return integrationRefresh;
}
export function memoryIntegrationSnapshot(): Integration {
  return (
    integrationCache ?? {
      id: 'ai-memory',
      name: 'ai-memory',
      kind: 'memory',
      status: 'planned',
      detail: 'Verificando servidor MCP local',
    }
  );
}
