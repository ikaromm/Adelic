import type {
  AttachmentMeta,
  Compaction,
  ConversationSearchHit,
  Bootstrap,
  DelegatedTask,
  GraphifyQueryResult,
  GraphifyStatus,
  HandoffSummaryMode,
  Message,
  MemoryCatalog,
  MemoryHit,
  MemoryListing,
  MemoryPage,
  MemoryScope,
  FileChange,
  GitCommitInfo,
  GitStatus,
  MessageQueue,
  Plan,
  Project,
  QueuedMessage,
  ProjectCoordination,
  Run,
  Session,
  SessionDetail,
  SelfUpdateStatus,
  Settings,
  Skill,
  SpendLimitStatus,
  UpdateChannel,
  UpdateProgress,
  UsageReport,
  WorktreeStatus,
} from '../shared/contracts';
import type { CommandList, CommandMode, SavedCommand } from '../shared/commands';
import type { VoiceStatus } from '../shared/voice';
import type { TerminalCommand, TerminalCommandInfo, TerminalState } from '../shared/terminal';
import type { Automation, AutomationSchedule } from '../shared/automations';
import type { CheckResult, ProjectHooks } from '../shared/hooks';
import type { McpEnvSource, McpServerView, ProjectMcpReport } from '../shared/mcp';
import type { RemoteAccessState, TailscaleState } from '../shared/remote-access';
import { t } from './i18n/catalog';
import { getLocale } from './i18n/store';
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
  /** `null` clears all; a field set to `null` clears that limit. */
  spendLimits?: { monthlyTokens?: number | null; monthlyCostUsd?: number | null } | null;
  git?: Project['git'];
};
/** Settings › Limites de uso: absent keeps a field, `null` clears a limit. */
export type SpendLimitsPatch = {
  enabled?: boolean;
  dailyTokens?: number | null;
  monthlyTokens?: number | null;
  dailyCostUsd?: number | null;
  monthlyCostUsd?: number | null;
};
export type SettingsPatch = Partial<Omit<Settings, 'spendLimits'>> & { spendLimits?: SpendLimitsPatch };
/** Body flag of "Continuar mesmo assim": that one request passes the usage limits. */
const override = (overrideLimit?: boolean) => (overrideLimit ? { overrideLimit: true } : {});
function serializeProjectPatch(data: ProjectPatch) {
  if (!data.orchestration) return JSON.stringify(data);
  const orchestration: Record<string, unknown> = { ...data.orchestration };
  for (const key of ['workerProviderId', 'workerModel', 'reviewerProviderId', 'reviewerModel']) {
    if (Object.hasOwn(orchestration, key) && orchestration[key] === undefined) orchestration[key] = null;
  }
  return JSON.stringify({ ...data, orchestration });
}

/**
 * Error from the API; `conflicts` lists files that blocked an undo (409), `exists` a file not
 * overwritten, `code: 'spend_limit'` a usage limit that "Continuar mesmo assim" can pass.
 */
export type ApiError = Error & {
  status: number;
  conflicts?: string[];
  exists?: boolean;
  code?: string;
  limit?: SpendLimitStatus;
  /** A page that explains how to fix the error (Tailscale admin console). */
  url?: string;
};

/** Accept-Language of the chosen UI locale: the server translates its `{ error }` texts (docs/i18n.md). */
export const localeHeaders = (): Record<string, string> => ({ 'Accept-Language': getLocale() });
/** EventSource cannot set headers: event-stream URLs carry the locale as `?lang=`. */
export function eventsUrl(path: string) {
  return `${path}${path.includes('?') ? '&' : '?'}lang=${encodeURIComponent(getLocale())}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...localeHeaders(), ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      conflicts?: string[];
      exists?: boolean;
      code?: string;
      limit?: SpendLimitStatus;
      url?: string;
    };
    const error = new Error(body.error || t('common.requestFailed', { status: response.status })) as ApiError;
    error.status = response.status;
    if (Array.isArray(body.conflicts)) error.conflicts = body.conflicts;
    if (body.exists === true) error.exists = true;
    if (typeof body.code === 'string') error.code = body.code;
    if (body.limit) error.limit = body.limit;
    if (typeof body.url === 'string' && body.url.startsWith('https://login.tailscale.com/')) error.url = body.url;
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
  /** "Atualizar Adelic" (docs/specs/self-update.md); only on this computer. */
  updateStatus: () => request<SelfUpdateStatus>('/api/update/status'),
  updateCheck: (channel?: UpdateChannel) =>
    request<SelfUpdateStatus>('/api/update/check', {
      method: 'POST',
      body: JSON.stringify(channel ? { channel } : {}),
    }),
  updateApply: (data: { channel?: UpdateChannel; target?: string }) =>
    request<UpdateProgress>('/api/update/apply', { method: 'POST', body: JSON.stringify({ confirm: true, ...data }) }),
  updateProgress: () => request<UpdateProgress>('/api/update/progress'),
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
    data: Partial<Pick<Session, 'title' | 'providerId' | 'mode' | 'projectId' | 'thinking' | 'planFirst'>> & {
      model?: string | null;
    },
  ) => request<Session>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  /** "Continuar com outro agente" (docs/specs/provider-handoff.md). */
  handoff: (
    id: string,
    body: { providerId: string; model?: string; summary: HandoffSummaryMode },
    overrideLimit?: boolean,
  ) =>
    request<{ session: Session; message?: Message }>(`/api/sessions/${encodeURIComponent(id)}/handoff`, {
      method: 'POST',
      body: JSON.stringify({ ...body, ...override(overrideLimit) }),
    }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  send: (id: string, content: string, clientMessageId: string, attachmentIds: string[] = [], overrideLimit?: boolean) =>
    request<{ runId: string; messageId: string }>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        clientMessageId,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...override(overrideLimit),
      }),
    }),
  /** Edit and resend (docs/specs/edit-branch.md): discards this message and the later ones. */
  editMessage: (
    id: string,
    messageId: string,
    content: string,
    clientMessageId: string,
    attachmentIds: string[],
    overrideLimit?: boolean,
  ) =>
    request<{ runId: string; messageId: string }>(
      `/api/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/edit`,
      {
        method: 'POST',
        body: JSON.stringify({ content, clientMessageId, attachmentIds, ...override(overrideLimit) }),
      },
    ),
  /** "Ramificar daqui": a new conversation with the messages up to and including `messageId`. */
  branch: (id: string, messageId: string) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}/branch`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),
  /** Uploads one file (content in base64) to a conversation; returns its metadata. */
  uploadAttachment: (sessionId: string, file: { name: string; mime: string; data: string }, signal?: AbortSignal) =>
    request<AttachmentMeta>(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify(file),
      signal,
    }),
  /** Local voice dictation (docs/specs/voice.md). */
  voiceStatus: () => request<VoiceStatus>('/api/transcribe/status'),
  transcribe: (audio: { mime: string; data: string }, signal?: AbortSignal) =>
    request<{ text: string }>('/api/transcribe', { method: 'POST', body: JSON.stringify(audio), signal }),
  attachmentUrl: (id: string) => `/api/attachments/${encodeURIComponent(id)}`,
  queue: (id: string) => request<MessageQueue>(`/api/sessions/${encodeURIComponent(id)}/queue`),
  enqueue: (id: string, content: string, clientId: string, attachmentIds: string[] = []) =>
    request<{ item?: QueuedMessage; started?: { runId: string; messageId: string }; queue: MessageQueue }>(
      `/api/sessions/${encodeURIComponent(id)}/queue`,
      {
        method: 'POST',
        body: JSON.stringify({ content, clientId, ...(attachmentIds.length ? { attachmentIds } : {}) }),
      },
    ),
  editQueued: (id: string, itemId: string, content: string) =>
    request<QueuedMessage>(`/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  removeQueued: (id: string, itemId: string) =>
    // The origin guard requires a JSON body on every mutation, DELETE included.
    request<void>(`/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      body: JSON.stringify({}),
    }),
  resumeQueue: (id: string, overrideLimit?: boolean) =>
    request<{ queue: MessageQueue }>(`/api/sessions/${encodeURIComponent(id)}/queue/resume`, {
      method: 'POST',
      body: JSON.stringify(override(overrideLimit)),
    }),
  steerQueued: (id: string, itemId: string) =>
    request<{ queue: MessageQueue }>(
      `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}/steer`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  sendNow: (id: string, body: { content: string; clientId: string; attachmentIds?: string[] } | { itemId: string }) =>
    request<{ queue: MessageQueue }>(`/api/sessions/${encodeURIComponent(id)}/send-now`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Conversation compaction (docs/specs/compaction.md).
  compact: (sessionId: string, overrideLimit?: boolean) =>
    request<{ runId: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
      method: 'POST',
      body: JSON.stringify(override(overrideLimit)),
    }),
  compactions: (sessionId: string) =>
    request<{ compactions: Compaction[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/compactions`),
  // Plan mode (docs/specs/plan-mode.md).
  plans: (sessionId: string) => request<{ plans: Plan[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/plans`),
  editPlan: (id: string, markdown: string) =>
    request<Plan>(`/api/plans/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ markdown }) }),
  approvePlan: (id: string, mode: 'all' | 'next', overrideLimit?: boolean) =>
    request<{ plan: Plan; started: { runId: string; messageId: string } }>(
      `/api/plans/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: JSON.stringify({ mode, ...override(overrideLimit) }) },
    ),
  planTask: (id: string, taskId: string, status: 'skipped' | 'pending') =>
    request<Plan>(`/api/plans/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  stopPlan: (id: string) =>
    request<Plan>(`/api/plans/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({}) }),
  discardPlan: (id: string) =>
    request<Plan>(`/api/plans/${encodeURIComponent(id)}/discard`, { method: 'POST', body: JSON.stringify({}) }),
  savePlan: (id: string, overwrite = false) =>
    request<{ path: string; plan: Plan }>(`/api/plans/${encodeURIComponent(id)}/save`, {
      method: 'POST',
      body: JSON.stringify(overwrite ? { overwrite } : {}),
    }),
  cancel: (id: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  runChanges: (id: string) =>
    request<{ available: boolean; reason?: string; files: FileChange[]; omitted?: number; restoredAt?: string }>(
      `/api/runs/${encodeURIComponent(id)}/changes`,
    ),
  runDiff: (id: string, path: string) =>
    request<{ path: string; diff: string; truncated: boolean }>(
      `/api/runs/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`,
    ),
  // Isolated worktree per conversation (docs/specs/worktrees.md).
  worktree: (sessionId: string) => request<WorktreeStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/worktree`),
  enableWorktree: (sessionId: string) =>
    request<{ session: Session; status: WorktreeStatus }>(`/api/sessions/${encodeURIComponent(sessionId)}/worktree`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  worktreeDiff: (sessionId: string, path: string) =>
    request<{ path: string; diff: string; truncated: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/worktree/diff?path=${encodeURIComponent(path)}`,
    ),
  applyWorktree: (sessionId: string) =>
    request<{ commit: string; branch: string; status: WorktreeStatus }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/worktree/apply`,
      { method: 'POST', body: JSON.stringify({ confirm: true }) },
    ),
  // The origin guard requires a JSON body on every mutation, DELETE included.
  discardWorktree: (sessionId: string, deleteBranch: boolean) =>
    request<{ removed: boolean; branchDeleted: boolean; branch: string; session: Session }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/worktree`,
      { method: 'DELETE', body: JSON.stringify({ deleteBranch }) },
    ),
  restoreRun: (id: string) =>
    request<{ restored: string[]; run: Run }>(`/api/runs/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }),
  /** Repeats a finished run's request; with a target, switches the conversation to it first. */
  retryRun: (id: string, target: { providerId?: string; model?: string } = {}, overrideLimit?: boolean) =>
    request<{ runId: string; messageId: string; session: Session }>(`/api/runs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      body: JSON.stringify({ ...target, ...override(overrideLimit) }),
    }),
  approve: (id: string, decision: 'approve' | 'deny') =>
    request<void>(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  settings: (data: SettingsPatch) =>
    request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(data) }),
  /** Settings › Acesso remoto (docs/specs/remote-access.md). */
  remoteAccess: () => request<RemoteAccessState>('/api/remote-access'),
  setRemoteAccount: (username: string, password: string) =>
    request<RemoteAccessState>('/api/remote-access/account', {
      method: 'PUT',
      body: JSON.stringify({ username, password }),
    }),
  deleteRemoteAccount: () =>
    request<RemoteAccessState>('/api/remote-access/account', { method: 'DELETE', body: JSON.stringify({}) }),
  revokeRemoteSession: (id: string) =>
    request<RemoteAccessState>(`/api/remote-access/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({}),
    }),
  revokeRemoteSessions: () =>
    request<RemoteAccessState>('/api/remote-access/sessions/revoke-all', { method: 'POST', body: JSON.stringify({}) }),
  tailscale: () => request<TailscaleState>('/api/remote-access/tailscale'),
  setFunnel: (enabled: boolean) =>
    request<{ tailscale: TailscaleState; state: RemoteAccessState }>('/api/remote-access/funnel', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  logout: () => request<{ authenticated: false }>('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }),
  /** Usage today and this month, the limits and those at 80% or more (docs/specs/spend-limits.md). */
  usage: (projectId?: string) =>
    request<UsageReport>(`/api/usage${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
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
  /** Integrated command runner (docs/specs/terminal-preview.md). */
  terminal: (projectId: string) => request<TerminalState>(`/api/projects/${encodeURIComponent(projectId)}/terminal`),
  runTerminal: (projectId: string, command: string, timeoutSec: number) =>
    request<{ id: string; command: TerminalCommandInfo }>(`/api/projects/${encodeURIComponent(projectId)}/terminal`, {
      method: 'POST',
      body: JSON.stringify({ command, timeoutSec }),
    }),
  terminalCommand: (id: string) => request<TerminalCommand>(`/api/terminal/${encodeURIComponent(id)}`),
  stopTerminal: (id: string) =>
    request<TerminalCommandInfo>(`/api/terminal/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  skill: (id: string, enabled: boolean) =>
    request<Skill>(`/api/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  /** Ranked project files for `@` mentions (relative paths). */
  projectFiles: (projectId: string, query: string, limit = 50, signal?: AbortSignal, sessionId?: string) =>
    request<{ files: string[]; truncated: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ query, limit: String(limit), ...(sessionId ? { sessionId } : {}) })}`,
      { signal },
    ),
  /** Git panel (docs/specs/git-panel.md). */
  git: {
    repo: (id: string) => request<{ repo: boolean }>(`/api/projects/${encodeURIComponent(id)}/git/repo`),
    status: (id: string) => request<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/status`),
    diff: (id: string, path: string, staged: boolean) =>
      request<{ path: string; staged: boolean; diff: string; truncated: boolean }>(
        `/api/projects/${encodeURIComponent(id)}/git/diff?${new URLSearchParams({ path, staged: staged ? '1' : '0' })}`,
      ),
    log: (id: string) => request<{ commits: GitCommitInfo[] }>(`/api/projects/${encodeURIComponent(id)}/git/log`),
    pushTarget: (id: string) =>
      request<{ target: { remote: string; branch: string; remoteBranch: string } | null }>(
        `/api/projects/${encodeURIComponent(id)}/git/push-target`,
      ),
    prUrl: (id: string) =>
      request<{ provider: 'github' | 'gitlab'; url: string; base: string | null; branch: string }>(
        `/api/projects/${encodeURIComponent(id)}/git/pr-url`,
      ),
    stage: (id: string, body: { paths?: string[]; all?: boolean }) =>
      request<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/stage`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    unstage: (id: string, body: { paths?: string[]; all?: boolean }) =>
      request<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/unstage`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    discard: (id: string, paths: string[], mixed: boolean) =>
      request<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/discard`, {
        method: 'POST',
        body: JSON.stringify({ paths, confirm: true, mixed }),
      }),
    commit: (id: string, message: string) =>
      request<{ hash: string }>(`/api/projects/${encodeURIComponent(id)}/git/commit`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
    push: (id: string) =>
      request<{ remote: string; branch: string; remoteBranch: string }>(
        `/api/projects/${encodeURIComponent(id)}/git/push`,
        { method: 'POST', body: JSON.stringify({ confirm: true }) },
      ),
  },
  // Per-project hooks (docs/specs/project-hooks.md).
  projectHooks: (projectId: string) => request<ProjectHooks>(`/api/projects/${encodeURIComponent(projectId)}/hooks`),
  saveProjectHooks: (projectId: string, hooks: ProjectHooks) =>
    request<ProjectHooks>(`/api/projects/${encodeURIComponent(projectId)}/hooks`, {
      method: 'PUT',
      body: JSON.stringify(hooks),
    }),
  testProjectHook: (projectId: string, index: number) =>
    request<CheckResult>(`/api/projects/${encodeURIComponent(projectId)}/hooks/test`, {
      method: 'POST',
      body: JSON.stringify({ index }),
    }),
  commands: (projectId?: string | null) =>
    request<CommandList>(`/api/commands${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createCommand: (data: CommandInput & { projectId: string | null }) =>
    request<SavedCommand>('/api/commands', { method: 'POST', body: JSON.stringify(data) }),
  updateCommand: (id: string, data: Partial<CommandInput>) =>
    request<SavedCommand>(`/api/commands/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  // The origin guard requires a JSON body on every mutation, DELETE included.
  deleteCommand: (id: string) =>
    request<void>(`/api/commands/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) }),
  mcpServers: () => request<{ servers: McpServerView[] }>('/api/mcp-servers'),
  createMcpServer: (data: McpServerInput) =>
    request<McpServerView>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
  updateMcpServer: (id: string, data: Partial<Omit<McpServerInput, 'tools'>> & { tools?: string[] | null }) =>
    request<McpServerView>(`/api/mcp-servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteMcpServer: (id: string) =>
    request<void>(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) }),
  projectMcp: (projectId: string) => request<ProjectMcpReport>(`/api/projects/${encodeURIComponent(projectId)}/mcp`),
  setProjectMcp: (projectId: string, enabled: string[]) =>
    request<{ project: Project; report: ProjectMcpReport }>(`/api/projects/${encodeURIComponent(projectId)}/mcp`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  /** Scheduled automations (docs/specs/automations.md); `enabled` is the global switch. */
  automations: () => request<{ automations: Automation[]; enabled: boolean }>('/api/automations'),
  createAutomation: (data: AutomationInput) =>
    request<Automation>('/api/automations', { method: 'POST', body: JSON.stringify(data) }),
  updateAutomation: (id: string, data: Partial<AutomationInput> & { enabled?: boolean }) =>
    request<Automation>(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAutomation: (id: string) =>
    request<void>(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) }),
  runAutomation: (id: string) =>
    request<{ automation: Automation; runId: string; messageId: string }>(
      `/api/automations/${encodeURIComponent(id)}/run`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};
/** Editable fields of an automation; `null` on providerId, model or mode goes back to the defaults. */
export interface AutomationInput {
  name: string;
  prompt: string;
  projectId: string;
  providerId?: Automation['providerId'] | null;
  model?: string | null;
  mode?: Automation['mode'] | null;
  schedule: AutomationSchedule;
  timezone: string;
  catchUp: boolean;
  denyApprovalsAfterMinutes: number | null;
  enabled?: boolean;
}
/** Editable fields of an MCP catalog entry; a literal without `value` keeps the stored one. */
export interface McpServerInput {
  name: string;
  description: string;
  command: string;
  args: string[];
  env: { name: string; from: McpEnvSource; value?: string }[];
  tools?: string[];
}
/** Editable fields of a saved command; `mode: null` removes the override on PATCH. */
export interface CommandInput {
  name: string;
  description: string;
  template: string;
  mode?: CommandMode | null;
}
