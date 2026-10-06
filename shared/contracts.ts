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
  capabilities: { fast: boolean; tools: boolean; approvals: boolean; cancel: boolean; reasoning?: boolean };
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
export interface RunEvent {
  id: string;
  runId: string;
  sessionId: string;
  type: 'status' | 'tool' | 'approval' | 'error';
  text: string;
  createdAt: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
}
export interface Settings {
  defaultProviderId: ProviderId;
  defaultMode: Mode;
  memoryEnabled: boolean;
  sandbox: Sandbox;
  responseStyle: 'concise' | 'balanced';
  approvalMode?: 'auto-safe' | 'manual';
  /** Opt-in: check GitHub for a newer release (one anonymous request, never installs). */
  updateCheck?: boolean;
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
  shutdown(): Promise<void>;
}
