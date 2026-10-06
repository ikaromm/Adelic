import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { MemoryCatalog, MemoryListing, MemoryScope, MemoryScopeInfo } from '../shared/contracts.js';

// HTTP client for the ai-memory service. The Memory library uses the same source
// the server uses (its HTTP API), so it works whether ai-memory runs natively or
// in Docker with its data in a volume the Adelic user cannot read.
//
// Compatibility boundary (verified against ai-memory 2.1.0 and 2.5.2):
// - MCP `/mcp`: memory_query, memory_read_page, memory_write_page.
// - Read-only `/api/v1` (requires `serve --enable-web`; the official Docker image
//   enables it): GET /projects, GET /workspaces/{w}/projects/{p}/pages[/{path}].
// - `/admin/write-page`: rewrites an existing note with kind/tier/tags/pinned/title.

const DEFAULT_URL = 'http://127.0.0.1:49374';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ProjectRowSchema = z.object({
  workspace_name: z.string(),
  project_name: z.string(),
  page_count: z.number().int(),
});
const PageRowSchema = z.object({ path: z.string(), title: z.string().nullable().optional() });

const PAGE_DEFAULT = 50,
  PAGE_MAX = 100;

export class MemoryServiceError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 503): never => {
  throw new MemoryServiceError(message, status);
};

/** Base URL of the ai-memory service. Only loopback is accepted: Adelic stays local. */
export function memoryServiceUrl(): string {
  const raw = (process.env.ADELIC_MEMORY_URL || DEFAULT_URL).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`ADELIC_MEMORY_URL inválida: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('ADELIC_MEMORY_URL deve usar http ou https');
  if (!LOOPBACK.has(url.hostname))
    fail(`ADELIC_MEMORY_URL deve apontar para o loopback (127.0.0.1, localhost ou ::1), não para ${url.hostname}`);
  if (url.username || url.password || url.search || url.hash)
    fail('ADELIC_MEMORY_URL não pode conter credenciais, query ou fragmento');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// Optional machine bearer for servers started with AI_MEMORY_AUTH_TOKEN (typical in
// Docker). ADELIC_MEMORY_TOKEN / ADELIC_MEMORY_TOKEN_FILE are captured once and
// ADELIC_MEMORY_TOKEN is removed from the environment so agent subprocesses do not
// inherit it. AI_MEMORY_AUTH_TOKEN is the user's own ai-memory client setting: it is
// read as a fallback and left untouched. The token is never logged or returned.
let tokenError: string | undefined;
const capturedToken = (() => {
  const direct = process.env.ADELIC_MEMORY_TOKEN?.trim();
  delete process.env.ADELIC_MEMORY_TOKEN;
  if (direct) return direct;
  const file = process.env.ADELIC_MEMORY_TOKEN_FILE?.trim();
  if (file) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
      tokenError = `ADELIC_MEMORY_TOKEN_FILE está vazio: ${file}`;
    } catch (e) {
      tokenError = `Não foi possível ler ADELIC_MEMORY_TOKEN_FILE (${file}): ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return undefined;
})();
export function memoryAuthHeaders(): Record<string, string> {
  if (tokenError) fail(tokenError);
  const token = capturedToken || process.env.AI_MEMORY_AUTH_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface ServiceResponse {
  status: number;
  data: unknown;
  text: string;
}

/** Fetches a service route. 404 is returned to the caller; other failures throw clear errors. */
export async function serviceRequest(
  route: string,
  init: { method?: string; body?: unknown } = {},
  timeoutMs = 5000,
): Promise<ServiceResponse> {
  const url = `${memoryServiceUrl()}${route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...memoryAuthHeaders(),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (e) {
    const reason = controller.signal.aborted
      ? `sem resposta em ${timeoutMs} ms`
      : e instanceof Error
        ? e.message
        : String(e);
    return fail(`Serviço ai-memory indisponível em ${memoryServiceUrl()}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    fail(
      `O ai-memory recusou o acesso a ${route.split('?')[0]} (HTTP ${response.status}). Se o serviço usa AI_MEMORY_AUTH_TOKEN, informe o mesmo token ao Adelic em ADELIC_MEMORY_TOKEN ou ADELIC_MEMORY_TOKEN_FILE.`,
    );
  }
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (response.status === 404) return { status: 404, data, text };
  if (!response.ok) {
    const detail = (data as { error?: unknown })?.error;
    fail(
      `ai-memory ${route.split('?')[0]} retornou HTTP ${response.status}: ${typeof detail === 'string' ? detail : text.slice(0, 300) || response.statusText}`,
      response.status >= 500 ? 503 : 502,
    );
  }
  if (data === undefined) fail(`Resposta incompatível de ai-memory ${route.split('?')[0]}: JSON esperado`);
  return { status: response.status, data, text };
}

const enc = (value: string) => encodeURIComponent(value);
const scopeRoute = (scope: MemoryScope) => `/api/v1/workspaces/${enc(scope.workspace)}/projects/${enc(scope.project)}`;
const encPath = (path: string) => path.split('/').map(enc).join('/');
const missingApi = (route: string): never =>
  fail(
    `O ai-memory não oferece a API de catálogo (${route} retornou 404). Inicie o serviço com --enable-web; a imagem Docker oficial já usa essa opção.`,
  );
const validScope = (scope: MemoryScope) => Boolean(scope.workspace?.trim() && scope.project?.trim());

/** Scopes and current-note counts, as reported by the service itself. */
export async function memoryCatalog(): Promise<MemoryCatalog> {
  const r = await serviceRequest('/api/v1/projects');
  if (r.status === 404) missingApi('/api/v1/projects');
  if (!Array.isArray(r.data)) return fail('Resposta incompatível de ai-memory /api/v1/projects: lista esperada');
  const scopes: MemoryScopeInfo[] = r.data
    .map((row) => {
      const parsed = ProjectRowSchema.safeParse(row);
      if (!parsed.success)
        return fail(
          'Resposta incompatível de ai-memory /api/v1/projects: workspace_name, project_name e page_count esperados',
        );
      return {
        workspace: parsed.data.workspace_name,
        project: parsed.data.project_name,
        pageCount: parsed.data.page_count,
      };
    })
    .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.project.localeCompare(b.project));
  const totalPages = scopes.reduce((n, s) => n + s.pageCount, 0);
  if (totalPages === 0) {
    // An empty catalog must be real, not a mismatch between the catalog and the store.
    const status = await serviceRequest('/admin/status').catch(() => undefined);
    const latest = Number((status?.data as { counts?: { pages_latest?: unknown } } | undefined)?.counts?.pages_latest);
    if (status?.status === 200 && latest > 0)
      fail(`Catálogo do ai-memory vazio, mas o serviço informa ${latest} notas atuais; configuração incompatível`);
  }
  return { scopes, totalPages };
}

/** One page of note metadata for an explicit scope (no bodies). */
export async function memoryList(scope: MemoryScope, offset = 0, limit = PAGE_DEFAULT): Promise<MemoryListing> {
  if (!validScope(scope)) fail('workspace e project obrigatórios', 400);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX)
    fail('offset/limit inválidos (limit máximo 100)', 400);
  const route = `${scopeRoute(scope)}/pages`;
  const r = await serviceRequest(route);
  if (r.status === 404) {
    const detail = (r.data as { error?: unknown })?.error;
    if (typeof detail === 'string')
      fail(`Escopo ${scope.workspace}/${scope.project} não encontrado no ai-memory: ${detail}`, 404);
    missingApi('/api/v1/workspaces/{workspace}/projects/{project}/pages');
  }
  if (!Array.isArray(r.data)) return fail('Resposta incompatível de ai-memory ao listar notas: lista esperada');
  const pages = r.data
    .map((row) => {
      const parsed = PageRowSchema.safeParse(row);
      if (!parsed.success) return fail('Resposta incompatível de ai-memory ao listar notas: path esperado');
      return { path: parsed.data.path, title: parsed.data.title || parsed.data.path, snippet: '' };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { pages: pages.slice(offset, offset + limit), total: pages.length, offset, limit };
}

/** Whether the service has a current row for the path, even if MCP cannot read it. */
export async function memoryPageExists(scope: MemoryScope, path: string): Promise<boolean> {
  const r = await serviceRequest(`${scopeRoute(scope)}/pages/${encPath(path)}`);
  if (r.status !== 404) return true;
  const detail = (r.data as { error?: unknown })?.error;
  if (typeof detail !== 'string') missingApi('/api/v1/workspaces/{workspace}/projects/{project}/pages/{path}');
  // "page file not found" means the row exists but its Markdown is missing: never overwrite.
  return /file/i.test(detail as string);
}

export interface AdminWrite {
  workspace: string;
  project: string;
  path: string;
  body: string;
  title?: string;
  kind?: string;
  tier: string;
  tags: string[];
  pinned: boolean;
}

/** Rewrites an existing note through the service writer (index, checkpoint and hooks included). */
export async function adminWritePage(request: AdminWrite): Promise<void> {
  const r = await serviceRequest('/admin/write-page', { method: 'POST', body: request }, 10000);
  if (r.status === 404)
    fail('O ai-memory não oferece /admin/write-page; edição de notas existentes indisponível nesta versão');
  if (typeof (r.data as { path?: unknown })?.path !== 'string')
    fail('Resposta incompatível de ai-memory /admin/write-page');
}
