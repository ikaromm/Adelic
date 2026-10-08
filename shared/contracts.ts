import type { CheckResult } from './hooks.js';
import type { RunMcpServer } from './mcp.js';
import type { RemoteProject, RemoteRuntime } from './remote-hosts.js';
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
  /** path remains an operational local directory; remote.path is the SSH workspace. */
  remote?: RemoteProject;
  createdAt: string;
  memoryWorkspace: string;
  memoryProject: string;
  orchestration?: OrchestrationConfig;
  graphify?: GraphifyConfig;
  /** Optional monthly limits for this project; they apply while Settings.spendLimits is on. */
  spendLimits?: ProjectSpendLimits;
  /** MCP catalog ids enabled for runs of this project (docs/specs/mcp-catalog.md); default none. */
  enabledMcp?: string[];
  /** Git panel settings (docs/specs/git-panel.md). */
  git?: ProjectGitConfig;
}
export interface ProjectGitConfig {
  /** Run the repository's hooks (pre-commit etc.) on commit. Off by default. */
  runHooks: boolean;
}
/** Where a changed file sits: in the index, only in the working tree, or not tracked. */
export type GitFileArea = 'staged' | 'unstaged' | 'untracked';
export interface GitFileEntry {
  /** Path relative to the repository top level, `/`-separated. */
  path: string;
  area: GitFileArea;
  /** Porcelain status letter: M, A, D, R, C, T, U (conflict) or ? (untracked). */
  letter: string;
  /** Previous path of a staged rename or copy. */
  origPath?: string;
}
export type GitStatus =
  | { repo: false; reason: string }
  | {
      repo: true;
      /** Current branch, or null when HEAD is detached. */
      branch: string | null;
      /** Short id of HEAD; null before the first commit. */
      head: string | null;
      upstream?: string;
      /** Counted from local refs only (no fetch). */
      ahead?: number;
      behind?: number;
      files: GitFileEntry[];
      omitted?: number;
      /** Why stage/discard/commit/push are refused right now (a run writing, an undo). */
      blocked?: string;
      runHooks: boolean;
    };
export interface GitCommitInfo {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
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
  /** "Ramificar daqui": the conversation and message this one was copied from (docs/specs/edit-branch.md). */
  branchedFrom?: { sessionId: string; messageId: string };
  /** Isolated git worktree the conversation's runs work in (docs/specs/worktrees.md). */
  worktree?: SessionWorktree;
}
/** A conversation's own checkout, outside the user's repository (`<dataDir>/worktrees/<sessionId>`). */
export interface SessionWorktree {
  path: string;
  branch: string;
  /** Commit the branch started from. */
  base: string;
  createdAt: string;
}
/** GET /api/sessions/:id/worktree. */
export interface WorktreeStatus {
  enabled: boolean;
  /** Whether a worktree can be created (git repository root with a commit); only when not enabled. */
  available: boolean;
  reason?: string;
  worktree?: SessionWorktree;
  /** False when the folder disappeared or is no longer a checkout of the branch. */
  exists?: boolean;
  /** Changed files relative to `base`, uncommitted ones included. */
  files?: FileChange[];
  omitted?: number;
  /** Commits on the branch after `base`. */
  commits?: number;
  /** Uncommitted changes in the worktree. */
  dirty?: boolean;
  /** Everything is in the main checkout's HEAD: branch tip merged and nothing uncommitted. */
  merged?: boolean;
  /** The branch tip is in the main checkout's HEAD (no commits of its own left); discarding deletes it. */
  branchMerged?: boolean;
  /** Why "Aplicar no projeto" would be refused right now (main checkout dirty, detached…). */
  applyBlocked?: string;
  /** Branch checked out in the main checkout, when on one. */
  mainBranch?: string;
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
  /**
   * Provider handoff card (role 'system'): `content` is the summary carried to the new agent.
   * Later runs see this summary plus the messages after it (docs/specs/provider-handoff.md).
   */
  handoff?: MessageHandoff;
  /** Sent by a scheduled automation (docs/specs/automations.md), not typed by the user. */
  automationId?: string;
}
export type HandoffSummaryMode = 'model' | 'local' | 'none';
export interface MessageHandoff {
  fromProviderId: ProviderId;
  fromModel?: string;
  fromName: string;
  toProviderId: ProviderId;
  toModel?: string;
  toName: string;
  /** 'model': written by the previous agent; 'local': built by Adelic from the last messages. */
  source: 'model' | 'local';
  /** Set when a model summary was requested but the local one was used, with the reason. */
  fallback?: string;
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
  /** Its messages were discarded by "Editar" on an earlier message; kept for history and audit. */
  discardedAt?: string;
  /** A manual "Compactar conversa" run: one read-only summary call, no messages. */
  compaction?: { auto: boolean };
  /** The summary call of "Continuar com outro agente": no messages, recorded for its usage. */
  handoff?: { toProviderId: ProviderId };
  /** Started from an internet session: approvals were forced to manual for this run. */
  manualApproval?: boolean;
  /** "Corrigir automaticamente": the run started because checks of `sourceRunId` failed. */
  hookFix?: { sourceRunId: string };
}
/** A provider and one of its models; no model means the provider's default. */
export interface ModelRef {
  providerId: ProviderId;
  model?: string;
}
/** Summary that replaces the older part of a conversation as context (docs/specs/compaction.md). */
export interface Compaction {
  id: string;
  sessionId: string;
  /** The compaction run (manual) or the message run it preceded (automatic). */
  runId: string;
  summary: string;
  /** Last message covered by the summary; later messages are sent verbatim. */
  upToMessageId: string;
  createdAt: string;
  /** Made by the automatic setting before a message. */
  auto?: boolean;
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
  /** Bumped on every save; orders stream events and responses that share an `updatedAt`. */
  revision?: number;
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
  /** Approved from an internet session: its task runs use manual approval. */
  manualApproval?: boolean;
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
  /** Full command text, when the runtime sent one (matched against the project's blocked commands). */
  command?: string;
  /** The project's blocked-command pattern that denied it (docs/specs/project-hooks.md). */
  blocked?: string;
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
  /** Queued from an internet session: its run uses manual approval (docs/specs/remote-access.md). */
  manualApproval?: boolean;
  createdAt: string;
  updatedAt?: string;
}
/** Why the queue stopped starting messages on its own; cleared by "Retomar fila". */
export interface QueuePause {
  /** 'limit': the next message hit a usage limit (docs/specs/spend-limits.md). */
  reason: 'cancelled' | 'failed' | 'interrupted' | 'limit';
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
  type: 'status' | 'tool' | 'approval' | 'error' | 'retry' | 'fallback' | 'check';
  /** Persisted in the language the server produced it in (pt-BR); older events have only this. */
  text: string;
  /**
   * Catalog key of `text` (shared/event-text.ts) and its variables, on events created since the
   * server i18n: the UI shows `eventText(textKey, textVars)` in its locale, else `text`.
   */
  textKey?: string;
  textVars?: Record<string, string | number | { key: string }>;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
  /** Retry events: attempt number about to start, total attempts, wait and the error that caused it. */
  attempt?: number;
  of?: number;
  delayMs?: number;
  error?: string;
  /** 'check' events: one after-edit check of the project, updated while it runs. */
  check?: CheckResult;
}
export interface Settings {
  defaultProviderId: ProviderId;
  defaultMode: Mode;
  memoryEnabled: boolean;
  /**
   * "Memória das conversas avulsas": the ai-memory scope searched by conversations without a
   * project, like a project's own scope (docs/specs/shared-memory.md). Absent or null: off.
   */
  detachedMemory?: MemoryScope | null;
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
  /** Opt-in: check GitHub (or the git remote, in a checkout) for a newer version; never installs by itself. */
  updateCheck?: boolean;
  /** "Canal de atualização" of a git checkout (docs/specs/self-update.md). Absent: master. */
  updateChannel?: UpdateChannel;
  /** System notification when a run finishes, fails or needs approval while the window is in the background. Absent: on in the desktop app, off in a browser. */
  notifications?: boolean;
  /** Opt-in: compact long conversations before the next message (off by default). */
  autoCompact?: boolean;
  /** Input-token threshold of the last run for `autoCompact` (history chars: 4× this). */
  autoCompactTokens?: number;
  /** Microphone button in the composer, transcribed locally by voxtype (docs/specs/voice.md). Absent: on when available. */
  voiceDictation?: boolean;
  /** "Permitir terminal pelo acesso remoto": off unless set (docs/specs/terminal-preview.md). Never from the internet. */
  terminalRemote?: boolean;
  /**
   * "Pela internet, exigir aprovação manual para comandos": runs started from an internet
   * session use approvalMode 'manual' (docs/specs/remote-access.md). Absent means on.
   */
  internetManualApproval?: boolean;
  /** Tailscale Funnel requested from this computer: re-applied at startup when an account exists. */
  funnel?: { wanted: boolean; port: number };
  /** Global switch of scheduled automations (off by default): nothing runs while it is off. */
  automations?: boolean;
  /** Opt-in usage limits checked before each model call (docs/specs/spend-limits.md). */
  spendLimits?: SpendLimits;
  /** Interface language (docs/i18n.md). Absent or 'auto': the browser's language (pt → pt-BR, else en). */
  language?: 'pt-BR' | 'en' | 'auto';
}
/** Global usage limits; an absent value means no limit. Periods use the local timezone. */
export interface SpendLimits {
  enabled: boolean;
  /** Input + output tokens since 00:00. */
  dailyTokens?: number;
  /** Input + output tokens in the calendar month. */
  monthlyTokens?: number;
  /** USD, counting only runs that reported a cost. */
  dailyCostUsd?: number;
  monthlyCostUsd?: number;
}
export interface ProjectSpendLimits {
  monthlyTokens?: number;
  monthlyCostUsd?: number;
}
/** Usage of the runs started in a period [from, to). */
export interface UsageTotals {
  from: string;
  to: string;
  /** Input + output tokens of the runs that reported them. */
  tokens: number;
  /** Sum over the runs that reported a cost; null when none did (never zero for unknown). */
  costUsd: number | null;
  runs: number;
  /** Finished runs that reported no cost / no tokens. */
  runsWithoutCost: number;
  runsWithoutTokens: number;
}
export type SpendLimitKind =
  'daily-tokens' | 'monthly-tokens' | 'daily-cost' | 'monthly-cost' | 'project-monthly-tokens' | 'project-monthly-cost';
export interface SpendLimitStatus {
  kind: SpendLimitKind;
  /** pt-BR name of the limit, e.g. "tokens hoje". */
  label: string;
  used: number;
  limit: number;
  /** used / limit, rounded down (100 for a zero limit). */
  percent: number;
  usedText: string;
  limitText: string;
}
/** GET /api/usage. `warnings`: at 80% or more; `reached`: at or over the limit. */
export interface UsageReport {
  today: UsageTotals;
  month: UsageTotals;
  project?: { id: string; today: UsageTotals; month: UsageTotals };
  limits: { enabled: boolean; global: SpendLimits; project?: ProjectSpendLimits };
  warnings: SpendLimitStatus[];
  reached: SpendLimitStatus[];
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
  /** Oldest first; the latest one is the context of the next runs. */
  compactions?: Compaction[];
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
  | { type: 'compaction'; compaction: Compaction }
  /** An automation changed (created, edited, ran, finished); clients reload the list. */
  | { type: 'automations' }
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
   * Latest conversation summary (docs/specs/compaction.md). It replaces the messages it
   * covers: `history` then holds only the messages after it.
   */
  summary?: string;
  /**
   * Images attached to the current request, as absolute host paths. Text attachments are
   * not listed here: the orchestrator already inlined them into `prompt`.
   */
  attachments?: { path: string; name: string; mime: string }[];
  /**
   * The project's blocked-command patterns. Providers that auto-approve deny a matching
   * command before that decision; the orchestrator denies matching pending requests.
   */
  blockedCommands?: string[];
  /**
   * Graphify paths Adelic trusts (GraphifyService.approvalPaths): the binary and this project's
   * graph directory. The safe-command classifier auto-approves exactly the query Adelic
   * suggests. Absent (detached conversations, Graphify off or missing) → graphify asks.
   */
  graphifyApproval?: { binary: string; graphsRoot: string };
  /**
   * MCP servers the project enabled (docs/specs/mcp-catalog.md). Absent or empty means none:
   * providers keep failing closed on any MCP server. Never set for detached conversations.
   */
  mcpServers?: RunMcpServer[];
  remote?: RemoteRuntime;
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

/** Self-update (docs/specs/self-update.md): branch followed by a git checkout. */
export type UpdateChannel = 'master' | 'develop';
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['master', 'develop'];
/** How this Adelic was installed, detected at runtime. */
export type InstallKind = 'checkout' | 'appimage' | 'other';
export interface UpdateCommit {
  hash: string;
  subject: string;
}
/** GET /api/update/status, POST /api/update/check. */
export interface SelfUpdateStatus {
  kind: InstallKind;
  version: string;
  /** Short HEAD commit (checkout mode). */
  commit?: string;
  /** Random per server process; the UI waits for a new one after a restart. */
  bootId: string;
  channel: UpdateChannel;
  /** GitHub releases page (always shown). */
  releaseUrl: string;
  /** When the last network check ran; absent until one did. */
  checkedAt?: string;
  /** A newer version exists for this channel or release. */
  available: boolean;
  /** "Atualizar agora" may run: available and nothing below blocks it. */
  canApply: boolean;
  /** Why the update cannot run right now. */
  blocked?: string;
  error?: string;
  /** What the apply must reach: a commit (checkout) or a version (AppImage). */
  target?: string;
  /** An update is running. */
  busy: boolean;
  checkout?: {
    branch: string | null;
    head: string;
    behind: number;
    ahead: number;
    /** No changes in tracked files (untracked files are allowed). */
    clean: boolean;
    /** Up to 10 commits that the update brings, newest first. */
    commits: UpdateCommit[];
    /** The update first switches to this branch ("Trocar para …"). */
    switchTo?: UpdateChannel;
    /** package-lock.json changes, so `npm ci` runs. */
    install: boolean;
  };
  release?: {
    latest: string;
    url: string;
    /** The AppImage file can be replaced in place. */
    writable: boolean;
    size?: number;
  };
}
export type UpdateStepId =
  'fetch' | 'switch' | 'merge' | 'install' | 'build' | 'download' | 'verify' | 'replace' | 'restart';
export type UpdateStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
/** GET /api/update/progress. */
export interface UpdateProgress {
  state: 'idle' | 'running' | 'failed' | 'restarting';
  steps: { id: UpdateStepId; label: string; status: UpdateStepStatus }[];
  /** Last 64 KB of command output. */
  log: string;
  error?: string;
  /** Commit or version expected after the restart. */
  target?: string;
  startedAt?: string;
  finishedAt?: string;
}
