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
import { graphStatusName, shortDate, taskStatusName } from '../labels';

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
            <h2>Orquestração do projeto</h2>
            <p>
              {project.name} · as mudanças valem no próximo turno. O agente da conversa coordena; executores usam
              contexto curto.
            </p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Delegar tarefas</strong>
            <span>
              {config.enabled
                ? 'Agente da conversa coordena os executores'
                : 'Mensagens seguem direto para o agente da conversa'}
            </span>
          </div>
          <button
            className={`toggle ${config.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={config.enabled}
            aria-label="Ativar orquestração do projeto"
            onClick={() => onOrchestration({ enabled: !config.enabled })}
          >
            <span />
          </button>
        </div>
        {config.enabled && (
          <>
            <div className="setting-row">
              <div>
                <strong>Executores simultâneos</strong>
                <span>Limite de tarefas em paralelo</span>
              </div>
              <select
                value={config.maxWorkers}
                onChange={(event) =>
                  onOrchestration({ maxWorkers: Number(event.target.value) as OrchestrationConfig['maxWorkers'] })
                }
              >
                <option value="1">1 executor</option>
                <option value="2">2 executores</option>
                <option value="3">3 executores</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>Revisão independente</strong>
                <span>Solicitar revisão quando o trabalho exigir</span>
              </div>
              <button
                className={`toggle ${config.review ? 'on' : ''}`}
                role="switch"
                aria-checked={config.review}
                aria-label="Ativar revisão independente"
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
                const title = isWorker ? 'Executor' : 'Revisor';
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
                        <option value="">Herdar agente da conversa</option>
                        {data.providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name}
                            {provider.available ? '' : ' · indisponível'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Modelo
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
                        <option value="">Padrão do agente</option>
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
                          ? 'Catálogo descoberto neste computador'
                          : 'Agente indisponível neste computador'
                        : `Herdado da conversa (${providerFor()?.name || coordinatorProviderId})`}
                    </small>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div className="project-overview">
          <div className="project-overview-heading">
            <strong>Contexto do coordenador</strong>
            <button
              className="icon-button"
              title="Atualizar visão do projeto"
              aria-label="Atualizar visão do projeto"
              onClick={onRefreshProject}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {coordination?.brief ? (
            <>
              <p ref={objectiveRef} className={`brief-objective ${briefExpanded ? 'expanded' : ''}`}>
                {coordination.brief.objective || 'Objetivo ainda não registrado.'}
              </p>
              <p ref={summaryRef} className={`brief-summary ${briefExpanded ? 'expanded' : ''}`}>
                {coordination.brief.summary || 'Sem resumo disponível.'}
              </p>
              {(briefExpanded || briefClipped) && (
                <button
                  type="button"
                  className="link-button brief-toggle"
                  aria-expanded={briefExpanded}
                  onClick={() => setBriefExpanded((value) => !value)}
                >
                  {briefExpanded ? 'Mostrar menos' : 'Mostrar resumo completo'}
                </button>
              )}
              <div className="brief-paths">
                {coordination.brief.paths.slice(0, 8).map((path) => (
                  <code key={path}>{path}</code>
                ))}
                {coordination.brief.paths.length > 8 && <span>+{coordination.brief.paths.length - 8} caminhos</span>}
              </div>
              {coordination.brief.truncated && <small>Mapa limitado ao contexto relevante.</small>}
            </>
          ) : (
            <p className="muted-empty">Ainda não há mapa ou resumo do projeto.</p>
          )}
          {coordination?.tasks.length ? (
            <div className="recent-project-tasks">
              <strong>Tarefas recentes</strong>
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
            <h2>Mapa de código (Graphify)</h2>
            <p>Índice local usado como mapa inicial pelo coordenador e pelos executores.</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Usar mapa do projeto</strong>
            <span>O índice contém estrutura de código, sem enviar arquivos para fora.</span>
          </div>
          <button
            className={`toggle ${graphEnabled ? 'on' : ''}`}
            role="switch"
            aria-checked={graphEnabled}
            aria-label="Ativar mapa do projeto"
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
              ? `${graphifyStatus.nodes} nós · ${graphifyStatus.edges} relações`
              : graphifyStatus?.detail || (graphEnabled ? 'Aguardando estado do índice.' : 'Desativado')}
          </span>
          {graphifyStatus?.updatedAt && <small>Atualizado {shortDate(graphifyStatus.updatedAt)}</small>}
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
            {status === 'ready' || status === 'stale' ? 'Indexar novamente' : 'Criar índice'}
          </button>
        </div>
        {graphEnabled && (
          <form className="graph-query" onSubmit={onProjectQuery}>
            <label htmlFor="graph-query-input">Consultar mapa</label>
            <div>
              <input
                id="graph-query-input"
                value={projectQuery}
                onChange={(event) => onProjectQueryChange(event.target.value)}
                placeholder="Ex.: onde ficam as rotas da API?"
              />
              <button
                type="submit"
                className="secondary-button"
                disabled={projectBusy || !projectQuery.trim() || status !== 'ready'}
              >
                {projectBusy ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}Consultar
              </button>
            </div>
          </form>
        )}
        {graphQueryResult && (
          <div className="graph-query-result">
            <strong>Resultado para “{graphQueryResult.query}”</strong>
            {graphQueryResult.context ? (
              <pre>
                {graphQueryResult.context.slice(0, 1800)}
                {graphQueryResult.context.length > 1800 ? '\n…' : ''}
              </pre>
            ) : (
              <p>O Graphify não retornou contexto para esta consulta.</p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
