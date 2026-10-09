export type ObservabilityStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export interface ObservabilityFilters {
  since?: string;
  until?: string;
  projectId?: string;
  sessionId?: string;
  providerId?: string;
  status?: ObservabilityStatus;
  component?: string;
  offset: number;
  limit: number;
}

export interface ObservabilityUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  cachedInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
}

export interface ObservabilityRunSummary {
  runId: string;
  traceId: string;
  sessionId: string;
  projectId: string | null;
  providerId: string | null;
  status: ObservabilityStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  usage: ObservabilityUsage | null;
  error: string | null;
}

export interface ObservabilityComponentSummary {
  component: string;
  events: number;
  errors: number;
  lastSeenAt: string;
}

export interface ObservabilityEvent {
  id: string;
  traceId: string;
  parentId: string | null;
  runId: string;
  sessionId: string;
  projectId: string | null;
  at: string;
  name: string;
  component: string;
  kind: 'event' | 'span';
  status: ObservabilityStatus;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean | null>;
}

export interface ObservabilityOverviewResponse {
  generatedAt: string;
  filters: ObservabilityFilters;
  overview: {
    runtime: { uptimeSec: number; rssBytes: number; heapUsedBytes: number };
    queueSnapshotAt: string;
    totals: {
      runs: number;
      queued: number;
      running: number;
      success: number;
      error: number;
      cancelled: number;
      agentsAvailable?: number;
      activeTasks?: number;
    };
    durationMs: { p50: number | null; p95: number | null };
    firstTokenMs: { p50: number | null; p95: number | null };
    usage: ObservabilityUsage;
    components: ObservabilityComponentSummary[];
  };
  recentEvents?: ObservabilityEvent[];
  runs: ObservabilityRunSummary[];
  pagination: { offset: number; limit: number; total: number };
}

export interface ObservabilityTraceResponse {
  runId: string;
  traceId: string;
  sessionId: string;
  projectId: string | null;
  events: ObservabilityEvent[];
}

export interface ObservationContext {
  traceId?: string;
  runId?: string;
  sessionId?: string;
  projectId?: string | null;
  parentId?: string | null;
  providerId?: string;
}

export interface ObservationInput extends ObservationContext {
  id?: string;
  at?: string;
  name: string;
  component: string;
  kind?: 'event' | 'span';
  status?: ObservabilityStatus;
  durationMs?: number | null;
  attributes?: Record<string, unknown>;
}
