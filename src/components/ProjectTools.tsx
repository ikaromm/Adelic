import { Bot, GitBranch, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { type FormEvent, useLayoutEffect, useRef, useState } from 'react';
import {
  type Bootstrap,
  type GraphifyQueryResult,
  type GraphifyStatus,
  type OrchestrationConfig,
  type Project,
  type ProjectCoordination,
  projectOrchestration,
} from '../../shared/contracts';
import { graphStatusName, taskStatusName } from '../labels';
import { useI18n } from '../i18n';

export function ProjectTools({
  project,
  data,
  coordination,
  graphifyStatus,
  graphQueryResult,
  projectQuery,
  projectBusy,
  coordinatorProviderId,
  onProjectQueryChange,
  onProjectQuery,
  onOrchestration,
  onGraphifyEnabled,
  onIndexGraphify,
  onRefreshProject,
}: {
  project: Project;
  data: Bootstrap;
  coordination: ProjectCoordination | null;
  graphifyStatus: GraphifyStatus | null;
  graphQueryResult: GraphifyQueryResult | null;
  projectQuery: string;
  projectBusy: boolean;
  coordinatorProviderId: string;
  onProjectQueryChange: (value: string) => void;
  onProjectQuery: (event: FormEvent) => void;
  onOrchestration: (patch: Partial<OrchestrationConfig>) => void;
  onGraphifyEnabled: (enabled: boolean) => void;
  onIndexGraphify: () => void;
  onRefreshProject: () => void;
}) {
  const { t, fmt } = useI18n();
  const config = projectOrchestration(project);
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [briefClipped, setBriefClipped] = useState(false);
  const objectiveRef = useRef<HTMLParagraphElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  // The brief is clamped by rendered lines (CSS), so overflow must be measured, not guessed from length.
  useLayoutEffect(() => {
    if (briefExpanded) return;
    const nodes = [objectiveRef.current, summaryRef.current].filter((node): node is HTMLParagraphElement =>
      Boolean(node),
    );
    if (!nodes.length) {
      setBriefClipped(false);
      return;
    }
    const measure = () => setBriefClipped(nodes.some((node) => node.scrollHeight > node.clientHeight + 1));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [briefExpanded, coordination?.brief?.objective, coordination?.brief?.summary]);
  const providerFor = (providerId?: string) =>
    data.providers.find((provider) => provider.id === (providerId || coordinatorProviderId));
  const modelOptions = (providerId?: string) => providerFor(providerId)?.models || [];
  const graphEnabled = project.graphify?.enabled !== false;
  const status = graphifyStatus?.status || (graphEnabled ? 'unindexed' : 'disabled');
  return (
    <>
      <section className="settings-card project-orchestration-card">
        <div className="settings-card-heading">
          <div className="settings-card-icon">
            <Bot size={17} />
          </div>
          <div>
            <h2>{t('projectTools.orchestration.title')}</h2>
            <p>{t('projectTools.orchestration.detail', { project: project.name })}</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t('projectTools.delegate.title')}</strong>
            <span>{config.enabled ? t('projectTools.delegate.on') : t('projectTools.delegate.off')}</span>
          </div>
          <button
            className={`toggle ${config.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={config.enabled}
            aria-label={t('projectTools.delegate.label')}
            onClick={() => onOrchestration({ enabled: !config.enabled })}
          >
            <span />
          </button>
        </div>
        {config.enabled && (
          <>
            <div className="setting-row">
              <div>
                <strong>{t('projectTools.workers.title')}</strong>
                <span>{t('projectTools.workers.detail')}</span>
              </div>
              <select
                value={config.maxWorkers}
                onChange={(event) =>
                  onOrchestration({ maxWorkers: Number(event.target.value) as OrchestrationConfig['maxWorkers'] })
                }
              >
                {[1, 2, 3].map((count) => (
                  <option key={count} value={count}>
                    {t('projectTools.workers', { count })}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('projectTools.review.title')}</strong>
                <span>{t('projectTools.review.detail')}</span>
              </div>
              <button
                className={`toggle ${config.review ? 'on' : ''}`}
                role="switch"
                aria-checked={config.review}
                aria-label={t('projectTools.review.label')}
                onClick={() => onOrchestration({ review: !config.review })}
              >
                <span />
              </button>
            </div>
            <div className="project-agent-grid">
              {(['worker', 'reviewer'] as const).map((role) => {
                const isWorker = role === 'worker';
                const selectedProvider = isWorker ? config.workerProviderId : config.reviewerProviderId;
                const selectedModel = isWorker ? config.workerModel : config.reviewerModel;
                const models = modelOptions(selectedProvider);
                const title = isWorker ? t('projectTools.role.worker') : t('projectTools.role.reviewer');
                return (
                  <div className="project-agent-card" key={role}>
                    <strong>{title}</strong>
                    <label>
                      {title}
                      <select
                        value={selectedProvider || ''}
                        onChange={(event) =>
                          onOrchestration(
                            isWorker
                              ? {
                                  workerProviderId:
                                    (event.target.value as OrchestrationConfig['workerProviderId']) || undefined,
                                  workerModel: undefined,
                                }
                              : {
                                  reviewerProviderId:
                                    (event.target.value as OrchestrationConfig['reviewerProviderId']) || undefined,
                                  reviewerModel: undefined,
                                },
                          )
                        }
                      >
                        <option value="">{t('projectTools.inheritAgent')}</option>
                        {data.providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.available
                              ? provider.name
                              : t('projectTools.providerUnavailable', { provider: provider.name })}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('projectTools.model')}
                      <select
                        value={selectedModel || ''}
                        onChange={(event) =>
                          onOrchestration(
                            isWorker
                              ? { workerModel: event.target.value || undefined }
                              : { reviewerModel: event.target.value || undefined },
                          )
                        }
                      >
                        <option value="">{t('projectTools.defaultModel')}</option>
                        {models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <small>
                      {selectedProvider
                        ? providerFor(selectedProvider)?.available
                          ? t('projectTools.catalogFound')
                          : t('projectTools.agentUnavailable')
                        : t('projectTools.inherited', { provider: providerFor()?.name || coordinatorProviderId })}
                    </small>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div className="project-overview">
          <div className="project-overview-heading">
            <strong>{t('projectTools.context.title')}</strong>
            <button
              className="icon-button"
              title={t('projectTools.context.refresh')}
              aria-label={t('projectTools.context.refresh')}
              onClick={onRefreshProject}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {coordination?.brief ? (
            <>
              <p ref={objectiveRef} className={`brief-objective ${briefExpanded ? 'expanded' : ''}`}>
                {coordination.brief.objective || t('projectTools.context.noObjective')}
              </p>
              <p ref={summaryRef} className={`brief-summary ${briefExpanded ? 'expanded' : ''}`}>
                {coordination.brief.summary || t('projectTools.context.noSummary')}
              </p>
              {(briefExpanded || briefClipped) && (
                <button
                  type="button"
                  className="link-button brief-toggle"
                  aria-expanded={briefExpanded}
                  onClick={() => setBriefExpanded((value) => !value)}
                >
                  {briefExpanded ? t('projectTools.context.showLess') : t('projectTools.context.showMore')}
                </button>
              )}
              <div className="brief-paths">
                {coordination.brief.paths.slice(0, 8).map((path) => (
                  <code key={path}>{path}</code>
                ))}
                {coordination.brief.paths.length > 8 && (
                  <span>{t('projectTools.context.morePaths', { count: coordination.brief.paths.length - 8 })}</span>
                )}
              </div>
              {coordination.brief.truncated && <small>{t('projectTools.context.truncated')}</small>}
            </>
          ) : (
            <p className="muted-empty">{t('projectTools.context.empty')}</p>
          )}
          {coordination?.tasks.length ? (
            <div className="recent-project-tasks">
              <strong>{t('projectTools.context.recentTasks')}</strong>
              {coordination.tasks.slice(0, 4).map((task) => (
                <div key={task.id}>
                  <span className={`run-status-dot ${task.status}`} />
                  <span>{task.title}</span>
                  <small>{taskStatusName(task.status)}</small>
                  {task.summary && <p>{task.summary}</p>}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <section className="settings-card graphify-card">
        <div className="settings-card-heading">
          <div className="settings-card-icon blue">
            <GitBranch size={17} />
          </div>
          <div>
            <h2>{t('projectTools.graph.title')}</h2>
            <p>{t('projectTools.graph.detail')}</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t('projectTools.graph.use')}</strong>
            <span>{t('projectTools.graph.useDetail')}</span>
          </div>
          <button
            className={`toggle ${graphEnabled ? 'on' : ''}`}
            role="switch"
            aria-checked={graphEnabled}
            aria-label={t('projectTools.graph.label')}
            onClick={() => onGraphifyEnabled(!graphEnabled)}
            disabled={projectBusy}
          >
            <span />
          </button>
        </div>
        <div className="graph-status-row">
          <span
            className={`run-status-dot ${status === 'ready' ? 'completed' : status === 'error' ? 'failed' : status === 'indexing' ? 'running' : ''}`}
          />
          <strong>{graphStatusName(status)}</strong>
          <span>
            {graphifyStatus?.nodes != null && graphifyStatus.edges != null
              ? t('projectTools.graph.counts', {
                  nodes: graphifyStatus.nodes,
                  edges: graphifyStatus.edges,
                })
              : graphifyStatus?.detail ||
                (graphEnabled ? t('projectTools.graph.waiting') : t('projectTools.graph.disabled'))}
          </span>
          {graphifyStatus?.updatedAt && (
            <small>{t('projectTools.graph.updated', { date: fmt.shortDate(graphifyStatus.updatedAt) })}</small>
          )}
        </div>
        {graphifyStatus?.detail && graphifyStatus.status !== 'ready' && (
          <p className="graph-detail">{graphifyStatus.detail}</p>
        )}
        <div className="graph-actions">
          <button
            className="secondary-button"
            onClick={onIndexGraphify}
            disabled={!graphEnabled || projectBusy || status === 'indexing'}
          >
            {projectBusy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            {status === 'ready' || status === 'stale' ? t('projectTools.graph.reindex') : t('projectTools.graph.index')}
          </button>
        </div>
        {graphEnabled && (
          <form className="graph-query" onSubmit={onProjectQuery}>
            <label htmlFor="graph-query-input">{t('projectTools.graph.query')}</label>
            <div>
              <input
                id="graph-query-input"
                value={projectQuery}
                onChange={(event) => onProjectQueryChange(event.target.value)}
                placeholder={t('projectTools.graph.queryPlaceholder')}
              />
              <button
                type="submit"
                className="secondary-button"
                disabled={projectBusy || !projectQuery.trim() || status !== 'ready'}
              >
                {projectBusy ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}
                {t('projectTools.graph.querySubmit')}
              </button>
            </div>
          </form>
        )}
        {graphQueryResult && (
          <div className="graph-query-result">
            <strong>{t('projectTools.graph.result', { query: graphQueryResult.query })}</strong>
            {graphQueryResult.context ? (
              <pre>
                {graphQueryResult.context.slice(0, 1800)}
                {graphQueryResult.context.length > 1800 ? '\n…' : ''}
              </pre>
            ) : (
              <p>{t('projectTools.graph.noContext')}</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
