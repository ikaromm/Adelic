import { Activity, Bot, ChevronDown, CircleAlert, Clock3, Cpu, Gauge, RefreshCw, Workflow } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bootstrap, Project, Session } from '../../shared/contracts';
import type { MessageKey } from '../i18n';
import type {
  ObservabilityEvent,
  ObservabilityFilters,
  ObservabilityOverviewResponse,
  ObservabilityRunSummary,
  ObservabilityStatus,
  ObservabilityTraceResponse,
} from '../../shared/observability';
import { api } from '../api';
import { useI18n } from '../i18n';

const PAGE_SIZE = 25;
const DISPLAY_ATTRIBUTES = new Set([
  'providerId',
  'provider',
  'model',
  'tool',
  'operation',
  'decision',
  'approvalMode',
  'reason',
  'phase',
  'attempt',
  'source',
  'rule',
  'statusCode',
  'toolName',
]);
const COMPONENT_OPTIONS = [
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
];

type Filters = Omit<ObservabilityFilters, 'offset' | 'limit'>;

export function ActivityPage({
  providers,
  projects,
  sessions,
}: {
  providers: Bootstrap['providers'];
  projects: Project[];
  sessions: Session[];
}) {
  const { t, fmt } = useI18n();
  const [filters, setFilters] = useState<Filters>({});
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ObservabilityOverviewResponse | null>(null);
  const [selectedRun, setSelectedRun] = useState('');
  const [trace, setTrace] = useState<ObservabilityTraceResponse | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const overviewRequest = useRef(0);
  const overviewInFlight = useRef(false);
  const traceRequest = useRef(0);
  const traceInFlight = useRef<{ runId: string; requestId: number } | null>(null);
  const traceRefreshPending = useRef(false);
  const refreshTraceRef = useRef<(runId: string, showLoading?: boolean) => Promise<void>>(async () => undefined);
  const selectedRunRef = useRef('');

  const filterKey = JSON.stringify(filters);
  const refreshTrace = useCallback(
    async (runId: string, showLoading = false) => {
      if (traceInFlight.current?.runId === runId) {
        traceRefreshPending.current = true;
        return;
      }
      const requestId = ++traceRequest.current;
      traceInFlight.current = { runId, requestId };
      if (showLoading) setLoadingTrace(true);
      try {
        const result = await api.observabilityTrace(runId);
        if (requestId === traceRequest.current && selectedRunRef.current === runId) setTrace(result);
      } catch (cause) {
        if (requestId === traceRequest.current && selectedRunRef.current === runId)
          setError((cause as Error).message || t('activityPage.traceFailed'));
      } finally {
        if (requestId === traceRequest.current) {
          traceInFlight.current = null;
          setLoadingTrace(false);
          if (traceRefreshPending.current && selectedRunRef.current === runId) {
            traceRefreshPending.current = false;
            queueMicrotask(() => void refreshTraceRef.current(runId));
          }
        }
      }
    },
    [t],
  );
  refreshTraceRef.current = refreshTrace;

  const load = useCallback(
    async (quiet = false) => {
      const requestId = ++overviewRequest.current;
      overviewInFlight.current = true;
      if (!quiet) setLoading(true);
      try {
        const result = await api.observability({ ...filters, offset, limit: PAGE_SIZE });
        if (requestId !== overviewRequest.current) return;
        setData(result);
        setError('');
        if (selectedRunRef.current && result.runs.some((run) => run.runId === selectedRunRef.current))
          void refreshTrace(selectedRunRef.current);
      } catch (cause) {
        if (requestId === overviewRequest.current) setError((cause as Error).message || t('activityPage.loadFailed'));
      } finally {
        if (requestId === overviewRequest.current) {
          overviewInFlight.current = false;
          setLoading(false);
        }
      }
    },
    [filters, offset, refreshTrace, t],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!overviewInFlight.current) void load(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    traceRequest.current++;
    traceInFlight.current = null;
    traceRefreshPending.current = false;
    selectedRunRef.current = '';
    setSelectedRun('');
    setTrace(null);
    setLoadingTrace(false);
    setData(null);
    setLoading(true);
  }, [filterKey, offset]);

  const setFilter = (key: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
    setOffset(0);
  };

  const chooseRun = async (runId: string) => {
    if (selectedRunRef.current === runId) {
      traceRequest.current++;
      traceInFlight.current = null;
      traceRefreshPending.current = false;
      selectedRunRef.current = '';
      setSelectedRun('');
      setLoadingTrace(false);
      return;
    }
    selectedRunRef.current = runId;
    traceRefreshPending.current = false;
    setSelectedRun(runId);
    setTrace(null);
    await refreshTrace(runId, true);
  };

  const componentOptions = useMemo(
    () => [...new Set([...COMPONENT_OPTIONS, ...(data?.overview.components.map((item) => item.component) ?? [])])],
    [data?.overview.components],
  );
  const totals = data?.overview.totals;
  const runs = data?.runs ?? [];
  const pagination = data?.pagination;
  const setDate = (key: 'since' | 'until', value: string) => {
    if (!value) return setFilter(key, '');
    const [year, month, day] = value.split('-').map(Number);
    const date = key === 'until' ? new Date(year, month - 1, day + 1, 0, 0, 0, -1) : new Date(year, month - 1, day);
    setFilter(key, date.toISOString());
  };
  const localDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const statusLabel = (status: ObservabilityStatus) => t(`activityPage.status.${status}`);

  return (
    <section className="page-content observability-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('activityPage.eyebrow')}</div>
          <h1>{t('activityPage.title')}</h1>
          <p>{t('activityPage.subtitle')}</p>
        </div>
        <span className="period-chip">
          <Activity size={14} /> {t('activityPage.localData')}
        </span>
      </div>

      {error && (
        <div className="inline-notice error-notice" role="alert">
          <CircleAlert size={15} /> {error}
        </div>
      )}

      <div className="observability-filters" aria-label={t('activityPage.filters')}>
        <label>
          <span>{t('activityPage.since')}</span>
          <input
            type="date"
            value={localDate(filters.since)}
            onChange={(event) => setDate('since', event.target.value)}
          />
        </label>
        <label>
          <span>{t('activityPage.until')}</span>
          <input
            type="date"
            value={localDate(filters.until)}
            onChange={(event) => setDate('until', event.target.value)}
          />
        </label>
        <label>
          <span>{t('activityPage.project')}</span>
          <select value={filters.projectId ?? ''} onChange={(event) => setFilter('projectId', event.target.value)}>
            <option value="">{t('activityPage.all')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('activityPage.session')}</span>
          <select value={filters.sessionId ?? ''} onChange={(event) => setFilter('sessionId', event.target.value)}>
            <option value="">{t('activityPage.all')}</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {t('activityPage.sessionOption', {
                  date: fmt.shortDate(session.updatedAt),
                  id: session.id.slice(0, 8),
                })}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('activityPage.provider')}</span>
          <select value={filters.providerId ?? ''} onChange={(event) => setFilter('providerId', event.target.value)}>
            <option value="">{t('activityPage.all')}</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('activityPage.status')}</span>
          <select value={filters.status ?? ''} onChange={(event) => setFilter('status', event.target.value)}>
            <option value="">{t('activityPage.all')}</option>
            {(['queued', 'running', 'success', 'error', 'cancelled'] as const).map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('activityPage.component')}</span>
          <select value={filters.component ?? ''} onChange={(event) => setFilter('component', event.target.value)}>
            <option value="">{t('activityPage.all')}</option>
            {componentOptions.map((component) => (
              <option key={component} value={component}>
                {component}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button observability-refresh"
          type="button"
          title={t('activityPage.refresh')}
          aria-label={t('activityPage.refresh')}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="metrics-grid observability-metrics">
        <MetricCard
          icon={<Activity size={17} />}
          label={t('activityPage.runs')}
          value={fmt.number(totals?.runs ?? 0)}
          hint={t('activityPage.activeCounts', { running: totals?.running ?? 0, queued: totals?.queued ?? 0 })}
        />
        <MetricCard
          icon={<Bot size={17} />}
          label={t('activityPage.availableAgents')}
          value={totals?.agentsAvailable == null ? '—' : fmt.number(totals.agentsAvailable)}
          hint={t('activityPage.availableAgentsHint')}
        />
        <MetricCard
          icon={<Workflow size={17} />}
          label={t('activityPage.activeTasks')}
          value={totals?.activeTasks == null ? '—' : fmt.number(totals.activeTasks)}
          hint={t('activityPage.activeTasksHint')}
        />
        <MetricCard
          icon={<CircleAlert size={17} />}
          label={t('activityPage.errors')}
          value={fmt.number(totals?.error ?? 0)}
          hint={t('activityPage.successCounts', { success: totals?.success ?? 0, cancelled: totals?.cancelled ?? 0 })}
        />
        <MetricCard
          icon={<Clock3 size={17} />}
          label={t('activityPage.duration')}
          value={percentile(fmt, data?.overview.durationMs.p50)}
          hint={t('activityPage.p95', { value: percentile(fmt, data?.overview.durationMs.p95) })}
        />
        <MetricCard
          icon={<Gauge size={17} />}
          label={t('activityPage.firstResponse')}
          value={percentile(fmt, data?.overview.firstTokenMs.p50)}
          hint={t('activityPage.p95', { value: percentile(fmt, data?.overview.firstTokenMs.p95) })}
        />
        <MetricCard
          icon={<Cpu size={17} />}
          label={t('activityPage.tokens')}
          value={usageTokens(data?.overview.usage, fmt)}
          hint={
            data?.overview.usage.costUsd == null
              ? t('activityPage.costUnknown')
              : (fmt.cost(data.overview.usage.costUsd) ?? t('activityPage.costUnknown'))
          }
        />
        <MetricCard
          icon={<Clock3 size={17} />}
          label={t('activityPage.uptime')}
          value={data ? fmt.duration(data.overview.runtime.uptimeSec * 1000) : '—'}
          hint={t('activityPage.runtimeUptime')}
        />
        <MetricCard
          icon={<Cpu size={17} />}
          label={t('activityPage.memory')}
          value={data ? formatBytes(data.overview.runtime.rssBytes) : '—'}
          hint={t('activityPage.heap', { value: data ? formatBytes(data.overview.runtime.heapUsedBytes) : '—' })}
        />
      </div>

      <section className="activity-section observability-components">
        <div className="section-title-row">
          <div>
            <h2>{t('activityPage.components')}</h2>
            <p>{t('activityPage.componentsHint')}</p>
          </div>
        </div>
        {!data?.overview.components.length ? (
          <div className="empty-panel activity-empty">
            <span>{loading ? t('activityPage.loading') : t('activityPage.noComponents')}</span>
          </div>
        ) : (
          <div className="component-grid">
            {data.overview.components.map((item) => (
              <article className="component-card" key={item.component}>
                <div className="component-name">
                  <Workflow size={15} />
                  <strong>{item.component}</strong>
                </div>
                <div>
                  <span>{t('activityPage.componentEvents', { count: item.events })}</span>
                  <span className={item.errors ? 'component-errors' : ''}>
                    {t('activityPage.componentErrors', { count: item.errors })}
                  </span>
                </div>
                <small>{t('activityPage.lastSeen', { time: fmt.relative(item.lastSeenAt, Date.now()) })}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="activity-section observability-events">
        <div className="section-title-row">
          <div>
            <h2>{t('activityPage.events')}</h2>
            <p>{t('activityPage.eventsHint')}</p>
          </div>
          <span className="count-chip">{data?.recentEvents?.length ?? 0}</span>
        </div>
        {!data?.recentEvents?.length ? (
          <div className="empty-panel activity-empty">
            <span>{loading ? t('activityPage.loading') : t('activityPage.noEvents')}</span>
          </div>
        ) : (
          <div className="observability-event-list">
            {data.recentEvents.map((event) => (
              <TraceEvent key={event.id} event={event} fmt={fmt} statusLabel={statusLabel} t={t} />
            ))}
          </div>
        )}
      </section>

      <section className="activity-section">
        <div className="section-title-row">
          <div>
            <h2>{t('activityPage.recent')}</h2>
            <p>{t('activityPage.recentHint')}</p>
          </div>
          <span className="count-chip">{pagination?.total ?? 0}</span>
        </div>
        {!runs.length ? (
          <div className="empty-panel activity-empty">
            <div className="empty-icon">
              <Activity size={18} />
            </div>
            <strong>{loading ? t('activityPage.loading') : t('activityPage.empty')}</strong>
            <span>{t('activityPage.emptyHint')}</span>
          </div>
        ) : (
          <div className="observability-run-list">
            {runs.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                selected={selectedRun === run.runId}
                trace={selectedRun === run.runId ? trace : null}
                loadingTrace={selectedRun === run.runId && loadingTrace}
                onClick={() => void chooseRun(run.runId)}
                provider={
                  providers.find((item) => item.id === run.providerId)?.name ??
                  run.providerId ??
                  t('activityPage.unknown')
                }
                session={sessions.find((item) => item.id === run.sessionId)}
                fmt={fmt}
                statusLabel={statusLabel}
                t={t}
              />
            ))}
          </div>
        )}
        <div className="observability-pagination">
          <span>
            {t('activityPage.pagination', {
              from: pagination?.total ? offset + 1 : 0,
              to: Math.min(offset + (pagination?.limit ?? PAGE_SIZE), pagination?.total ?? 0),
              total: pagination?.total ?? 0,
            })}
          </span>
          <div>
            <button
              className="secondary-button"
              disabled={offset === 0 || loading}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              {t('activityPage.previous')}
            </button>
            <button
              className="secondary-button"
              disabled={!pagination || offset + pagination.limit >= pagination.total || loading}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              {t('activityPage.next')}
            </button>
          </div>
        </div>
      </section>
    </section>
  );
}

function percentile(fmt: ReturnType<typeof useI18n>['fmt'], value?: number | null) {
  return value == null ? '—' : fmt.duration(value);
}

function RunRow({
  run,
  selected,
  trace,
  loadingTrace,
  onClick,
  provider,
  session,
  fmt,
  statusLabel,
  t,
}: {
  run: ObservabilityRunSummary;
  selected: boolean;
  trace: ObservabilityTraceResponse | null;
  loadingTrace: boolean;
  onClick: () => void;
  provider: string;
  session?: Session;
  fmt: ReturnType<typeof useI18n>['fmt'];
  statusLabel: (status: ObservabilityStatus) => string;
  t: ReturnType<typeof useI18n>['t'];
}) {
  return (
    <article className={`observability-run ${selected ? 'expanded' : ''}`}>
      <button className="observability-run-head" type="button" aria-expanded={selected} onClick={onClick}>
        <span className="observability-agent">
          <span className="provider-avatar">
            <Bot size={15} />
          </span>
          <span>
            <strong>{provider}</strong>
            <small>
              {session
                ? t('activityPage.sessionOption', {
                    date: fmt.shortDate(session.updatedAt),
                    id: session.id.slice(0, 8),
                  })
                : t('activityPage.detachedSession')}
            </small>
          </span>
        </span>
        <span className="observability-status">
          <i
            className={`run-status-dot ${run.status === 'success' ? 'completed' : run.status === 'error' ? 'failed' : run.status}`}
          />
          {statusLabel(run.status)}
        </span>
        <span>{fmt.relative(run.startedAt, Date.now())}</span>
        <span>{run.durationMs == null ? '—' : fmt.duration(run.durationMs)}</span>
        <span>{usageLabel(run.usage, fmt)}</span>
        <ChevronDown size={15} className="observability-chevron" aria-hidden="true" />
      </button>
      {run.error && (
        <p className="observability-run-error">
          <CircleAlert size={14} />
          {run.error}
        </p>
      )}
      {selected && (
        <div className="observability-trace">
          {loadingTrace ? (
            <div className="trace-loading">{t('activityPage.traceLoading')}</div>
          ) : trace?.events.length ? (
            trace.events.map((event) => (
              <TraceEvent key={event.id} event={event} fmt={fmt} statusLabel={statusLabel} t={t} />
            ))
          ) : (
            <div className="trace-loading">{t('activityPage.noTrace')}</div>
          )}
        </div>
      )}
    </article>
  );
}

function TraceEvent({
  event,
  fmt,
  statusLabel,
  t,
}: {
  event: ObservabilityEvent;
  fmt: ReturnType<typeof useI18n>['fmt'];
  statusLabel: (status: ObservabilityStatus) => string;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const attributes = Object.entries(event.attributes).filter(
    ([key, value]) => DISPLAY_ATTRIBUTES.has(key) && value != null,
  );
  return (
    <div className="trace-event">
      <span className="trace-dot" />
      <time>{fmt.time(event.at)}</time>
      <div className="trace-event-main">
        <strong>{event.name}</strong>
        <span>
          {event.component} · {statusLabel(event.status)}
          {event.durationMs == null ? '' : ` · ${fmt.duration(event.durationMs)}`}
        </span>
        {attributes.length > 0 && (
          <small>{attributes.map(([key, value]) => `${attributeName(key, t)}: ${String(value)}`).join(' · ')}</small>
        )}
      </div>
    </div>
  );
}

function usageLabel(usage: ObservabilityRunSummary['usage'], fmt: ReturnType<typeof useI18n>['fmt']) {
  if (!usage) return '—';
  const tokens = fmt.runTokens({
    inputTokens: usage.inputTokens ?? undefined,
    outputTokens: usage.outputTokens ?? undefined,
  });
  return [tokens, usage.costUsd == null ? null : fmt.cost(usage.costUsd)].filter(Boolean).join(' · ') || '—';
}

function usageTokens(
  usage: ObservabilityOverviewResponse['overview']['usage'] | undefined,
  fmt: ReturnType<typeof useI18n>['fmt'],
) {
  if (!usage) return '—';
  return (
    fmt.runTokens({ inputTokens: usage.inputTokens ?? undefined, outputTokens: usage.outputTokens ?? undefined }) || '—'
  );
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function attributeName(key: string, t: (key: MessageKey) => string) {
  const keys: Record<string, MessageKey> = {
    providerId: 'activityPage.attribute.providerId',
    provider: 'activityPage.attribute.provider',
    model: 'activityPage.attribute.model',
    tool: 'activityPage.attribute.tool',
    operation: 'activityPage.attribute.operation',
    decision: 'activityPage.attribute.decision',
    approvalMode: 'activityPage.attribute.approvalMode',
    reason: 'activityPage.attribute.reason',
    phase: 'activityPage.attribute.phase',
    attempt: 'activityPage.attribute.attempt',
    source: 'activityPage.attribute.source',
    rule: 'activityPage.attribute.rule',
    statusCode: 'activityPage.attribute.statusCode',
    toolName: 'activityPage.attribute.toolName',
  };
  return t(keys[key] ?? 'activityPage.attribute.unknown');
}

export function MetricCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span className="metric-icon">{icon}</span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
