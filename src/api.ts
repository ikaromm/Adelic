import type {
  AttachmentMeta,
  ConversationSearchHit,
  Bootstrap,
  DelegatedTask,
  GraphifyQueryResult,
  GraphifyStatus,
  MemoryCatalog,
  MemoryHit,
  MemoryListing,
  MemoryPage,
  MemoryScope,
  FileChange,
  Project,
  ProjectCoordination,
  Run,
  Session,
  SessionDetail,
  Settings,
  Skill,
} from '../shared/contracts';
/** Report from /api/diagnostics: versions, paths and status only, without secrets or content. */
export interface Diagnostics {
  generatedAt: string;
  app: { version: string; node: string; electron: string | null };
  system: { platform: string; arch: string; kernel: string };
  data: {
    dir: string;
    schema: { current: number; supported: number };
    counts: Record<string, number>;
    backups: { name: string; bytes: number; at: string }[];
  };
  providers: {
    id: string;
    status: string;
    available: boolean;
    detail: string;
    models: number;
    binary: string | null;
    version: string | null;
  }[];
  sandbox: { bubblewrap: string | null };
  memory: { url: string; reachable: boolean; version?: string; notes?: number; detail?: string };
}
export interface UpdateInfo {
  enabled: boolean;
  current?: string;
  latest?: string;
  available?: boolean;
  url?: string;
  publishedAt?: string;
  checkedAt?: string;
  error?: string;
}
export interface Health {
  status: string;
  providers: { id: string; status: string; available: boolean }[];
  memory: string;
  jail: string;
}

type ProjectPatch = {
  name?: string;
  memoryWorkspace?: string;
  memoryProject?: string;
  orchestration?: Project['orchestration'];
  graphify?: Project['graphify'];
};
function serializeProjectPatch(data: ProjectPatch) {
  if (!data.orchestration) return JSON.stringify(data);
  const orchestration: Record<string, unknown> = { ...data.orchestration };
  for (const key of ['workerProviderId', 'workerModel', 'reviewerProviderId', 'reviewerModel']) {
    if (Object.hasOwn(orchestration, key) && orchestration[key] === undefined) orchestration[key] = null;
  }
  return JSON.stringify({ ...data, orchestration });
}

/** Error from the API; `conflicts` lists files that blocked an undo (409). */
export type ApiError = Error & { status: number; conflicts?: string[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; conflicts?: string[] };
    const error = new Error(body.error || `Falha na solicitação (${response.status})`) as ApiError;
    error.status = response.status;
    if (Array.isArray(body.conflicts)) error.conflicts = body.conflicts;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  health: () => request<Health>('/api/health'),
  diagnostics: () => request<Diagnostics>('/api/diagnostics'),
  searchConversations: (q: string) =>
    request<{ hits: ConversationSearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  updates: (force = false) => request<UpdateInfo>(`/api/updates${force ? '?force=1' : ''}`),
  detail: (id: string) => request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  task: (id: string) => request<DelegatedTask>(`/api/tasks/${encodeURIComponent(id)}`),
  createProject: (data: { name: string; path: string; memoryWorkspace?: string; memoryProject?: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: ProjectPatch) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: serializeProjectPatch(data) }),
  coordination: (id: string) => request<ProjectCoordination>(`/api/projects/${encodeURIComponent(id)}/coordination`),
  graphify: (id: string) => request<GraphifyStatus>(`/api/projects/${encodeURIComponent(id)}/graphify`),
  indexGraphify: (id: string) =>
    request<GraphifyStatus>(`/api/projects/${encodeURIComponent(id)}/graphify/index`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  queryGraphify: (id: string, query: string) =>
    request<GraphifyQueryResult>(`/api/projects/${encodeURIComponent(id)}/graphify/query`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  createSession: (data: {
    projectId?: string | null;
    providerId: string;
    model?: string;
    mode?: string;
    title?: string;
  }) => request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (
    id: string,
    data: Partial<Pick<Session, 'title' | 'providerId' | 'mode' | 'projectId' | 'thinking'>> & {
      model?: string | null;
    },
  ) => request<Session>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  send: (id: string, content: string, clientMessageId: string, attachmentIds: string[] = []) =>
    request<{ runId: string; messageId: string }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, clientMessageId, ...(attachmentIds.length ? { attachmentIds } : {}) }),
    }),
  /** Uploads one file (content in base64) to a conversation; returns its metadata. */
  uploadAttachment: (sessionId: string, file: { name: string; mime: string; data: string }, signal?: AbortSignal) =>
    request<AttachmentMeta>(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify(file),
      signal,
    }),
  attachmentUrl: (id: string) => `/api/attachments/${encodeURIComponent(id)}`,
  cancel: (id: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  runChanges: (id: string) =>
    request<{ available: boolean; reason?: string; files: FileChange[]; omitted?: number; restoredAt?: string }>(
      `/api/runs/${encodeURIComponent(id)}/changes`,
    ),
  runDiff: (id: string, path: string) =>
    request<{ path: string; diff: string; truncated: boolean }>(
      `/api/runs/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`,
    ),
  restoreRun: (id: string) =>
    request<{ restored: string[]; run: Run }>(`/api/runs/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }),
  approve: (id: string, decision: 'approve' | 'deny') =>
    request<void>(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  settings: (data: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(data) }),
  memorySearch: (projectId: string, q: string) =>
    request<{ hits: MemoryHit[] }>(
      `/api/memory/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`,
    ),
  memoryPage: (projectId: string, path: string) =>
    request<MemoryPage>(`/api/memory/page?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`),
  saveMemory: (projectId: string, path: string, body: string) =>
    request<MemoryPage>('/api/memory/page', { method: 'POST', body: JSON.stringify({ projectId, path, body }) }),
  memoryCatalog: () => request<MemoryCatalog>('/api/memory/catalog'),
  memoryList: (scope: MemoryScope, offset = 0, limit = 50) =>
    request<MemoryListing>(
      `/api/memory/pages?workspace=${encodeURIComponent(scope.workspace)}&project=${encodeURIComponent(scope.project)}&offset=${offset}&limit=${limit}`,
    ),
  sharedMemorySearch: (scope: MemoryScope, q: string) =>
    request<{ hits: MemoryHit[] }>(
      `/api/memory/search?workspace=${encodeURIComponent(scope.workspace)}&project=${encodeURIComponent(scope.project)}&q=${encodeURIComponent(q)}`,
    ),
  sharedMemoryPage: (scope: MemoryScope, path: string) =>
    request<MemoryPage>(
      `/api/memory/page?workspace=${encodeURIComponent(scope.workspace)}&project=${encodeURIComponent(scope.project)}&path=${encodeURIComponent(path)}`,
    ),
  saveSharedMemory: (scope: MemoryScope, path: string, body: string, expectedVersion: string | null) =>
    request<MemoryPage>('/api/memory/page', {
      method: 'POST',
      body: JSON.stringify({ ...scope, path, body, expectedVersion }),
    }),
  skill: (id: string, enabled: boolean) =>
    request<Skill>(`/api/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
};
