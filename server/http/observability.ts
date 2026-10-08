import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { SQLInputValue } from 'node:sqlite';
import type {
  ObservabilityFilters,
  ObservabilityOverviewResponse,
  ObservabilityStatus,
  ObservabilityTraceResponse,
} from '../../shared/observability.js';
import { requestKind } from './auth.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

const statuses = new Set<ObservabilityStatus>(['queued', 'running', 'success', 'error', 'cancelled']);
const clientEvents = new Set([
  'ui.error',
  'ui.navigation',
  'desktop.ready',
  'desktop.backend.exit',
  'desktop.window.ready',
]);
const components = new Set([
  'http',
  'provider',
  'process',
  'memory',
  'graph',
  'git',
  'terminal',
  'ssh',
  'desktop',
  'ui',
  'queue',
  'orchestration',
  'storage',
]);
const validIso = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function queryFilters(query: Record<string, unknown>): ObservabilityFilters | undefined {
  const filters: ObservabilityFilters = { offset: 0, limit: 50 };
  for (const key of ['since', 'until'] as const) {
    if (query[key] !== undefined) {
      if (!validIso(query[key])) return;
      filters[key] = new Date(query[key]).toISOString();
    }
  }
  if (filters.since && filters.until && filters.since > filters.until) return;
  for (const key of ['projectId', 'sessionId', 'providerId', 'component'] as const) {
    if (query[key] !== undefined) {
      if (typeof query[key] !== 'string' || !query[key].trim() || query[key].length > 160) return;
      filters[key] = query[key].trim();
    }
  }
  if (filters.component && !components.has(filters.component)) return;
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !statuses.has(query.status as ObservabilityStatus)) return;
    filters.status = query.status as ObservabilityStatus;
  }
  for (const key of ['offset', 'limit'] as const) {
    if (query[key] !== undefined) {
      if (typeof query[key] !== 'string' || !/^\d+$/.test(query[key])) return;
      const parsed = Number(query[key]);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || (key === 'limit' && (parsed < 1 || parsed > 200))) return;
      filters[key] = parsed;
    }
  }
  return filters;
}

function filterSql(filters: ObservabilityFilters, alias: string) {
  const conditions: string[] = [];
  const params: Record<string, SQLInputValue> = {};
  if (filters.since) {
    conditions.push(`${alias}.started_at >= :since`);
    params.since = filters.since;
  }
  if (filters.until) {
    conditions.push(`${alias}.started_at <= :until`);
    params.until = filters.until;
  }
  for (const key of ['projectId', 'sessionId', 'providerId'] as const) {
    if (filters[key] !== undefined) {
      conditions.push(
        `${alias}.${key === 'projectId' ? 'project_id' : key === 'sessionId' ? 'session_id' : 'provider_id'} = :${key}`,
      );
      params[key] = filters[key]!;
    }
  }
  if (filters.status) {
    conditions.push(`${alias}.status = :status`);
    params.status = filters.status;
  }
  if (filters.component) {
    conditions.push(
      `EXISTS (SELECT 1 FROM observability_events oe WHERE oe.trace_id=${alias}.trace_id AND oe.component=:component)`,
    );
    params.component = filters.component;
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function percentile(
  db: BackendContext['store']['db'],
  filters: ObservabilityFilters,
  column: 'duration_ms' | 'first_token_ms',
) {
  const { where, params } = filterSql(filters, 'r');
  const by = where ? `${where} AND` : 'WHERE';
  const row = db
    .prepare(
      `WITH valueset AS (SELECT ${column} v FROM observability_runs r ${by} ${column} IS NOT NULL), ranked AS (SELECT v,ROW_NUMBER() OVER (ORDER BY v) n,COUNT(*) OVER () c FROM valueset)
    SELECT MIN(CASE WHEN n >= max(1,CAST((c*50+99)/100 AS INTEGER)) THEN v END) p50,
           MIN(CASE WHEN n >= max(1,CAST((c*95+99)/100 AS INTEGER)) THEN v END) p95 FROM ranked`,
    )
    .get(params) as { p50: number | null; p95: number | null };
  return { p50: row.p50 === null ? null : Number(row.p50), p95: row.p95 === null ? null : Number(row.p95) };
}

export function observabilityRoutes({ store, providerList }: BackendContext) {
  const app = Router();
  app.get('/api/observability', async (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, 'remotehosts.localOnly');
    const filters = queryFilters(req.query as Record<string, unknown>);
    if (!filters) return error(res, 400, 'common.invalidRequest');
    const { where, params } = filterSql(filters, 'r');
    const totals = store.db
      .prepare(
        `SELECT COUNT(*) runs,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) error,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled,
      CASE WHEN COUNT(input_tokens)=COUNT(*) THEN SUM(input_tokens) END input_tokens,
      CASE WHEN COUNT(output_tokens)=COUNT(*) THEN SUM(output_tokens) END output_tokens,
      CASE WHEN COUNT(cost_usd)=COUNT(*) THEN SUM(cost_usd) END cost_usd
      FROM observability_runs r ${where}`,
      )
      .get(params) as Record<string, number | null>;
    const queueConditions: string[] = [];
    const queueParams: Record<string, SQLInputValue> = {};
    if (filters.projectId) {
      queueConditions.push('s.project_id=:projectId');
      queueParams.projectId = filters.projectId;
    }
    if (filters.sessionId) {
      queueConditions.push('q.session_id=:sessionId');
      queueParams.sessionId = filters.sessionId;
    }
    if (filters.providerId) {
      queueConditions.push("json_extract(s.data,'$.providerId')=:providerId");
      queueParams.providerId = filters.providerId;
    }
    if (filters.component && filters.component !== 'queue') queueConditions.push('0=1');
    const queuedMessages =
      filters.status && filters.status !== 'queued'
        ? 0
        : Number(
            (
              store.db
                .prepare(
                  `SELECT COUNT(*) n FROM message_queue q JOIN sessions s ON s.id=q.session_id ${queueConditions.length ? `WHERE ${queueConditions.join(' AND ')}` : ''}`,
                )
                .get(queueParams) as { n: number }
            ).n,
          );
    const count = store.db.prepare(`SELECT COUNT(*) n FROM observability_runs r ${where}`).get(params) as { n: number };
    const rows = store.db
      .prepare(
        `SELECT r.* FROM observability_runs r ${where} ORDER BY r.started_at DESC,r.rowid DESC LIMIT :limit OFFSET :offset`,
      )
      .all({ ...params, limit: filters.limit, offset: filters.offset }) as Array<Record<string, unknown>>;
    const componentsWhere: string[] = [];
    const eventParams: Record<string, SQLInputValue> = {};
    if (filters.since) {
      componentsWhere.push('e.at >= :since');
      eventParams.since = filters.since;
    }
    if (filters.until) {
      componentsWhere.push('e.at <= :until');
      eventParams.until = filters.until;
    }
    if (filters.projectId) {
      componentsWhere.push('e.project_id = :projectId');
      eventParams.projectId = filters.projectId;
    }
    if (filters.sessionId) {
      componentsWhere.push('e.session_id = :sessionId');
      eventParams.sessionId = filters.sessionId;
    }
    if (filters.providerId) {
      componentsWhere.push(
        'EXISTS (SELECT 1 FROM observability_runs rr WHERE rr.run_id=e.run_id AND rr.provider_id=:providerId)',
      );
      eventParams.providerId = filters.providerId;
    }
    if (filters.status) {
      componentsWhere.push('e.status = :status');
      eventParams.status = filters.status;
    }
    if (filters.component) {
      componentsWhere.push('e.component = :component');
      eventParams.component = filters.component;
    }
    const cWhere = componentsWhere.length ? `WHERE ${componentsWhere.join(' AND ')}` : '';
    const componentsRows = store.db
      .prepare(
        `SELECT e.component,COUNT(*) events,SUM(CASE WHEN e.status='error' THEN 1 ELSE 0 END) errors,MAX(e.at) last_seen_at FROM observability_events e ${cWhere} GROUP BY e.component ORDER BY events DESC`,
      )
      .all(eventParams) as Array<Record<string, unknown>>;
    const availableAgents = (await providerList().catch(() => [])).filter((provider) => provider.available).length;
    const recentEventRows = store.db
      .prepare(`SELECT e.* FROM observability_events e ${cWhere} ORDER BY e.at DESC,e.rowid DESC LIMIT 25`)
      .all(eventParams) as Array<Record<string, unknown>>;
    const taskWhere = ["json_extract(d.data,'$.status')='running'"];
    const taskParams: Record<string, SQLInputValue> = {};
    if (filters.projectId) {
      taskWhere.push('d.project_id=:projectId');
      taskParams.projectId = filters.projectId;
    }
    if (filters.sessionId) {
      taskWhere.push('d.session_id=:sessionId');
      taskParams.sessionId = filters.sessionId;
    }
    if (filters.providerId) {
      taskWhere.push("json_extract(d.data,'$.providerId')=:providerId");
      taskParams.providerId = filters.providerId;
    }
    const activeTasks = Number(
      (
        store.db
          .prepare(`SELECT COUNT(*) n FROM delegated_tasks d WHERE ${taskWhere.join(' AND ')}`)
          .get(taskParams) as { n: number }
      ).n,
    );

    const response: ObservabilityOverviewResponse = {
      generatedAt: new Date().toISOString(),
      filters,
      overview: {
        queueSnapshotAt: new Date().toISOString(),
        runtime: {
          uptimeSec: Math.round(process.uptime()),
          rssBytes: process.memoryUsage().rss,
          heapUsedBytes: process.memoryUsage().heapUsed,
        },
        totals: {
          runs: Number(totals.runs ?? 0),
          queued: queuedMessages,
          running: Number(totals.running ?? 0),
          success: Number(totals.success ?? 0),
          error: Number(totals.error ?? 0),
          cancelled: Number(totals.cancelled ?? 0),
          agentsAvailable: availableAgents,
          activeTasks,
        },
        durationMs: percentile(store.db, filters, 'duration_ms'),
        firstTokenMs: percentile(store.db, filters, 'first_token_ms'),
        usage: {
          inputTokens: totals.input_tokens === null ? null : Number(totals.input_tokens),
          outputTokens: totals.output_tokens === null ? null : Number(totals.output_tokens),
          costUsd: totals.cost_usd === null ? null : Number(totals.cost_usd),
        },
        components: componentsRows.map((row) => ({
          component: String(row.component),
          events: Number(row.events),
          errors: Number(row.errors ?? 0),
          lastSeenAt: String(row.last_seen_at),
        })),
      },
      runs: rows.map((row) => ({
        runId: String(row.run_id),
        traceId: String(row.trace_id),
        sessionId: String(row.session_id),
        projectId: row.project_id === null ? null : String(row.project_id),
        providerId: row.provider_id === null ? null : String(row.provider_id),
        status: row.status as ObservabilityStatus,
        startedAt: String(row.started_at),
        completedAt: row.completed_at === null ? null : String(row.completed_at),
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        firstTokenMs: row.first_token_ms === null ? null : Number(row.first_token_ms),
        usage:
          row.input_tokens === null && row.output_tokens === null && row.cost_usd === null
            ? null
            : {
                inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
                outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
                costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
              },
        error: row.error_kind ? 'A execução falhou' : null,
      })),
      recentEvents: recentEventRows.map(observationRow),
      pagination: { offset: filters.offset, limit: filters.limit, total: Number(count.n) },
    };
    res.json(response);
  });
  app.get('/api/observability/runs/:id', (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, 'remotehosts.localOnly');
    const run = store.db
      .prepare('SELECT run_id,trace_id,session_id,project_id FROM observability_runs WHERE run_id=?')
      .get(req.params.id) as
      { run_id: string; trace_id: string; session_id: string; project_id: string | null } | undefined;
    if (!run) return error(res, 404, 'common.runNotFound');
    const rows = store.db
      .prepare('SELECT * FROM observability_events WHERE trace_id=? ORDER BY at,rowid')
      .all(run.trace_id) as Array<Record<string, unknown>>;
    const response: ObservabilityTraceResponse = {
      runId: run.run_id,
      traceId: run.trace_id,
      sessionId: run.session_id,
      projectId: run.project_id,
      events: rows.map(observationRow),
    };
    res.json(response);
  });
  app.post('/api/observability/client-events', (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, 'remotehosts.localOnly');
    const body = req.body as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['name', 'status', 'durationMs'].includes(key)) ||
      typeof body.name !== 'string' ||
      !clientEvents.has(body.name) ||
      (body.status !== undefined && !['success', 'error', 'cancelled'].includes(String(body.status))) ||
      (body.durationMs !== undefined &&
        (!Number.isFinite(body.durationMs) || Number(body.durationMs) < 0 || Number(body.durationMs) > 300_000))
    )
      return error(res, 400, 'common.invalidRequest');
    const name = body.name;
    store.recordObservabilityEvent({
      id: randomUUID(),
      traceId: randomUUID(),
      runId: randomUUID(),
      sessionId: 'system',
      at: new Date().toISOString(),
      name,
      component: name.startsWith('ui.') ? 'ui' : 'desktop',
      kind: 'event',
      status: (body.status as ObservabilityStatus | undefined) ?? 'success',
      durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
      attributes: {},
    });
    res.status(202).json({ accepted: true });
  });
  return app;
}

function observationRow(row: Record<string, unknown>): ObservabilityTraceResponse['events'][number] {
  return {
    id: String(row.id),
    traceId: String(row.trace_id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    at: String(row.at),
    name: String(row.name),
    component: String(row.component),
    kind: row.kind as 'event' | 'span',
    status: row.status as ObservabilityStatus,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    attributes: JSON.parse(String(row.attributes)) as ObservabilityTraceResponse['events'][number]['attributes'],
  };
}
