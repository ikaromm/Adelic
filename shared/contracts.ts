export type ProviderId = 'codex' | 'claude' | 'kiro' | 'opencode';
export type Mode = 'auto' | 'fast' | 'deep';
export type ReasoningEffort = string;
export type Thinking = 'auto' | ReasoningEffort;
export type Sandbox = 'read-only' | 'workspace-write';
export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  memoryWorkspace: string;
  memoryProject: string;
  orchestration?: OrchestrationConfig;
  graphify?: GraphifyConfig;
}
export interface GraphifyConfig {
  enabled: boolean;
}
export interface GraphifyStatus {
  enabled: boolean;
  installed: boolean;
  status: 'missing' | 'unindexed' | 'indexing' | 'ready' | 'stale' | 'error' | 'disabled';
  graphPath: string;
  updatedAt?: string;
  nodes?: number;
  edges?: number;
  detail: string;
}
export interface GraphifyQueryResult {
  query: string;
  context: string;
  status: GraphifyStatus;
}
export interface OrchestrationConfig {
  enabled: boolean;
  maxWorkers: 1 | 2 | 3;
  review: boolean;
  workerProviderId?: ProviderId;
  workerModel?: string;
  reviewerProviderId?: ProviderId;
  reviewerModel?: string;
}
export const DEFAULT_ORCHESTRATION: OrchestrationConfig = { enabled: true, maxWorkers: 2, review: true };
export function projectOrchestration(project: Pick<Project, 'orchestration'>): OrchestrationConfig {
  return { ...DEFAULT_ORCHESTRATION, ...project.orchestration };
}
export type AgentRole = 'planner' | 'worker' | 'reviewer' | 'synthesis';
export interface DelegatedTask {
  id: string;
  projectId: string | null;
  sessionId: string;
  runId: string;
  role: AgentRole;
  title: string;
  instructions: string;
  scope: string[];
  dependsOn: string[];
  effort?: ReasoningEffort;
  providerId: ProviderId;
  model?: string;
  status: 'queued' | RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  output?: string;
  error?: string;
}
export interface ProjectBrief {
  projectId: string;
  updatedAt: string;
  paths: string[];
  truncated: boolean;
  objective: string;
  summary: string;
}
export interface ProjectCoordination {
  config: OrchestrationConfig;
  brief: ProjectBrief | null;
  tasks: DelegatedTask[];
}
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  installed: boolean;
  available: boolean;
  status: 'ready' | 'missing' | 'error' | 'unknown';
  detail: string;
  models: {
    id: string;
    name: string;
    efforts?: ReasoningEffort[];
    defaultReasoningEffort?: ReasoningEffort;
    isDefault?: boolean;
  }[];
  defaultModel?: string;
  capabilities: {
    fast: boolean;
    tools: boolean;
    approvals: boolean;
    cancel: boolean;
    reasoning?: boolean;
    /** Accepts extra user input during an active turn (Codex `turn/steer`). Absent means no. */
    steer?: boolean;
    /** Accepts image attachments. Kiro confirms it again at run time from its ACP initialize. */
    images?: boolean;
  };
}
/** Attachment as shown to clients: no paths. */
export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}
/** Server-side record (attachments table); `file` is relative to the session's attachment folder. */
export interface StoredAttachment extends AttachmentMeta {
  sessionId: string;
  kind: 'image' | 'text';
  file: string;
  createdAt: string;
}
export interface Session {
  id: string;
  projectId: string | null;
  title: string;
  providerId: ProviderId;
  model?: string;
  mode: Mode;
  thinking?: Thinking;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  nativeSessionId?: string;
  /** "Planejar antes": every message first produces a read-only plan to approve (docs/specs/plan-mode.md). */
  planFirst?: boolean;
}
export interface RoutePlan {
  /** Availability for this phase; fast user turns may use tools while internal planning stays false. */
  level: 'fast' | 'deep';
  reason: string;
  tools: boolean;
  memory: boolean;
  effort?: ReasoningEffort;
  contextBudget: number;
}
export interface ConversationSearchHit {
  sessionId: string;
  title: string;
  projectId: string | null;
  updatedAt: string;
  /** Up to three matching messages; `[[` and `]]` mark the matched terms in the snippet. */
  matches: { messageId: string; role: 'user' | 'assistant' | 'system'; createdAt: string; snippet: string }[];
}
export interface Message {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  status?: RunStatus;
  providerId?: ProviderId;
  route?: RoutePlan;
  durationMs?: number;
  firstTokenMs?: number;
  /** Files sent with a user message. */
  attachments?: AttachmentMeta[];
}
export interface Run {
  id: string;
  sessionId: string;
  providerId: ProviderId;
  status: RunStatus;
  route: RoutePlan;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  /** Automatic retries that happened before the final outcome (0 or absent: none). */
  retries?: number;
  /** Conversation model when the run started; absent means the provider's default. */
  model?: string;
  /**
   * Set on failures: whether repeating may help, and why it was not repeated automatically.
   * `capacity` only appears on runs recorded before it was split into overloaded and rate_limit.
   */
  failure?: {
    kind: 'transient' | 'overloaded' | 'rate_limit' | 'capacity' | 'permanent';
    reason: string;
    retryable: boolean;
    why?: string;
  };
  /** Automatic model fallback (Settings.modelFallback): the model that answered instead. */
  fallback?: { from: ModelRef; to: ModelRef; reason: string };
  /** Snapshot of the project files around a run that could write; see docs/specs/checkpoints.md. */
  checkpoint?: RunCheckpoint;
  /** Plan mode: a read-only planning run, or the run of one task of an approved plan. */
  plan?: RunPlanRef;
}
/** A provider and one of its models; no model means the provider's default. */
export interface ModelRef {
  providerId: ProviderId;
  model?: string;
}
export type RunPlanRef = { kind: 'plan' } | { kind: 'task'; planId: string; taskId: string };
export type PlanStatus = 'draft' | 'approved' | 'rejected' | 'executing' | 'done';
export type PlanTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export interface PlanTask {
  id: string;
  /** First line of the checklist item (inline Markdown). */
  text: string;
  /** Nested lines under the item, dedented. */
  details?: string;
  status: PlanTaskStatus;
  /** Run that last executed this task. */
  runId?: string;
  /** Why the last attempt did not finish (failed, cancelled, interrupted). */
  error?: string;
}
/** A spec written by a read-only planning run, approved and executed one task per run. */
export interface Plan {
  id: string;
  sessionId: string;
  /** The planning run that produced it. */
  runId: string;
  title: string;
  status: PlanStatus;
  /** Markdown of the "Requisitos" section. */
  requirements: string;
  /** Markdown of the "Design" section (the whole text when no section was found). */
  design: string;
  tasks: PlanTask[];
  /** Editable source; saving re-parses it. */
  markdown: string;
  /** While executing: 'all' runs every pending task, 'next' only one. */
  executionMode?: 'all' | 'next';
  /** "Parar após a tarefa atual": no new task starts after the running one. */
  stopRequested?: boolean;
  /** Last execution problem, shown on the card. */
  error?: string;
  /** Project-relative path of the last "Salvar no projeto". */
  savedPath?: string;
  createdAt: string;
  updatedAt: string;
}
export interface FileChange {
  /** Path relative to the repository root, `/`-separated. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  binary?: boolean;
}
export interface RunCheckpoint {
  /** False when no checkpoint could be taken (not a git repository, too large, git failed). */
  available: boolean;
  reason?: string;
  /** Real path of the snapshotted folder. */
  root?: string;
  /** Commit ids under refs/adelic/checkpoints/<runId>/{before,after}. */
  before?: string;
  after?: string;
  /** Present once the run finished; empty when it changed nothing. */
  files?: FileChange[];
  /** Changed files beyond the listed ones. */
  omitted?: number;
  restoredAt?: string;
}
export interface Approval {
  id: string;
  runId: string;
  sessionId: string;
  title: string;
  detail: string;
  kind: 'command' | 'file' | 'tool';
  status: 'pending' | 'approved' | 'denied';
}
/** A message waiting for the active run of its conversation to finish. */
export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: string;
  /** Idempotency key from the client; reused as the message's clientMessageId when it starts. */
  clientId?: string;
  /** Attachments sent with the message; resolved again from the store when it starts. */
  attachments?: AttachmentMeta[];
  createdAt: string;
  updatedAt?: string;
}
/** Why the queue stopped starting messages on its own; cleared by "Retomar fila". */
export interface QueuePause {
  reason: 'cancelled' | 'failed' | 'interrupted';
  at: string;
  error?: string;
}
export interface MessageQueue {
  sessionId: string;
  items: QueuedMessage[];
  paused?: QueuePause;
}
export const QUEUE_LIMIT = 20;
export interface RunEvent {
  id: string;
  runId: string;
  sessionId: string;
  type: 'status' | 'tool' | 'approval' | 'error' | 'retry' | 'fallback';
  text: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
  /** Retry events: attempt number about to start, total attempts, wait and the error that caused it. */
  attempt?: number;
  of?: number;
  delayMs?: number;
  error?: string;
}
export interface Settings {
  defaultProviderId: ProviderId;
  defaultMode: Mode;
  memoryEnabled: boolean;
  sandbox: Sandbox;
  responseStyle: 'concise' | 'balanced';
  approvalMode?: 'auto-safe' | 'manual';
  /** Automatic retry of transient failures that had no visible effect (default on). */
  autoRetry?: boolean;
  /**
   * Opt-in: when the model stays overloaded or rate limited after the automatic retries, try
   * these models in order, once each, for that run only (docs/specs/retries.md).
   */
  modelFallback?: { enabled: boolean; models: { providerId: ProviderId; model: string }[] };
  /** Opt-in: check GitHub for a newer release (one anonymous request, never installs). */
  updateCheck?: boolean;
  /** System notification when a run finishes, fails or needs approval while the window is in the background. Absent: on in the desktop app, off in a browser. */
  notifications?: boolean;
}
export interface Integration {
  id: string;
  name: string;
  kind: 'memory' | 'sandbox' | 'tool';
  status: 'ready' | 'missing' | 'error' | 'planned';
  detail: string;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}
export interface Bootstrap {
  projects: Project[];
  sessions: Session[];
  providers: ProviderInfo[];
  settings: Settings;
  integrations: Integration[];
  skills: Skill[];
  runs: Run[];
}
export interface SessionDetail {
  session: Session;
  messages: Message[];
  events: RunEvent[];
  approvals: Approval[];
  runs: Run[];
  tasks?: DelegatedTask[];
}
export interface MemoryScope {
  workspace: string;
  project: string;
}
export interface MemoryScopeInfo extends MemoryScope {
  pageCount: number;
}
export interface MemoryCatalog {
  scopes: MemoryScopeInfo[];
  totalPages: number;
}
export interface MemoryListing {
  pages: MemoryHit[];
  total: number;
  offset: number;
  limit: number;
}
export interface MemoryHit {
  path: string;
  title: string;
  snippet: string;
}
export interface MemoryPage {
  path: string;
  title: string;
  body: string;
  version?: string;
  frontmatter?: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'message'; message: Message }
  | { type: 'delta'; sessionId: string; runId: string; messageId: string; text: string }
  | { type: 'event'; event: RunEvent }
  | { type: 'approval'; approval: Approval }
  | { type: 'run'; run: Run }
  | { type: 'session'; session: Session }
  | { type: 'task'; task: DelegatedTask }
  | { type: 'queue'; queue: MessageQueue }
  | { type: 'plan'; plan: Plan }
  | { type: 'refresh' };

// Server-side provider contract. Each adapter owns its subprocess and pending approvals.
export interface RunInput {
  runId: string;
  sessionId: string;
  nativeSessionId?: string;
  providerId: ProviderId;
  model?: string;
  cwd: string;
  prompt: string;
  history: Message[];
  plan: RoutePlan;
  sandbox: Sandbox;
  approvalMode?: 'auto-safe' | 'manual';
  memoryContext?: string;
  /**
   * Images attached to the current request, as absolute host paths. Text attachments are
   * not listed here: the orchestrator already inlined them into `prompt`.
   */
  attachments?: { path: string; name: string; mime: string }[];
}
export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; description: string; status: string; toolCallId?: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'session'; nativeSessionId: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number };
export interface RunResult {
  text: string;
  nativeSessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  stopReason: 'completed' | 'cancelled';
}
export interface ProviderRegistry {
  list(): Promise<ProviderInfo[]>;
  run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<RunResult>;
  approve(approvalId: string, decision: 'approve' | 'deny'): Promise<void>;
  /** Sends extra input to the single active turn of `runId`; absent when no provider supports it. */
  steer?(runId: string, content: string): Promise<void>;
  shutdown(): Promise<void>;
}
