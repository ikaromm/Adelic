import { Bot, Brain, Code2, Command, Layers3, Shield } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type {
  Bootstrap,
  GraphifyQueryResult,
  GraphifyStatus,
  OrchestrationConfig,
  Project,
  ProjectCoordination,
} from '../../shared/contracts';
import { integrationName } from '../labels';
import { DiagnosticsCard } from './DiagnosticsCard';
import { ProjectTools } from './ProjectTools';

export function SettingsPage({
  data,
  project,
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
  onProjectMemoryScope,
  onSetting,
  onSkill,
  notice,
}: {
  data: Bootstrap;
  project?: Project;
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
  onProjectMemoryScope: (workspace: string, project: string) => void;
  onSetting: (
    key:
      | 'defaultProviderId'
      | 'defaultMode'
      | 'memoryEnabled'
      | 'sandbox'
      | 'responseStyle'
      | 'approvalMode'
      | 'updateCheck',
    value: string | boolean,
  ) => void;
  onSkill: (id: string, enabled: boolean) => void;
  notice: string;
}) {
  const [memoryWorkspace, setMemoryWorkspace] = useState(project?.memoryWorkspace || '');
  const [memoryProject, setMemoryProject] = useState(project?.memoryProject || '');
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREFERÊNCIAS DO WORKSPACE</div>
          <h1>Configurações</h1>
          <p>Defina como os agentes executam tarefas neste computador.</p>
        </div>
      </div>
      {notice && <div className="inline-notice error-notice">{notice}</div>}
      <div className="settings-layout">
        <div className="settings-main">
          {project && (
            <ProjectTools
              project={project}
              data={data}
              coordination={coordination}
              graphifyStatus={graphifyStatus}
              graphQueryResult={graphQueryResult}
              projectQuery={projectQuery}
              projectBusy={projectBusy}
              coordinatorProviderId={coordinatorProviderId}
              onProjectQueryChange={onProjectQueryChange}
              onProjectQuery={onProjectQuery}
              onOrchestration={onOrchestration}
              onGraphifyEnabled={onGraphifyEnabled}
              onIndexGraphify={onIndexGraphify}
              onRefreshProject={onRefreshProject}
            />
          )}

          {project && (
            <section className="settings-card">
              <div className="settings-card-heading">
                <div className="settings-card-icon purple">
                  <Brain size={17} />
                </div>
                <div>
                  <h2>Escopo de memória do projeto</h2>
                  <p>Define a biblioteca consultada por conversas vinculadas; não altera o escopo da tela Memória.</p>
                </div>
              </div>
              <label className="setting-row">
                <strong>Workspace</strong>
                <input value={memoryWorkspace} onChange={(e) => setMemoryWorkspace(e.target.value)} />
              </label>
              <label className="setting-row">
                <strong>Projeto na memória</strong>
                <input value={memoryProject} onChange={(e) => setMemoryProject(e.target.value)} />
              </label>
              <button
                className="secondary-button"
                disabled={!memoryWorkspace.trim() || !memoryProject.trim()}
                onClick={() => onProjectMemoryScope(memoryWorkspace.trim(), memoryProject.trim())}
              >
                Salvar escopo
              </button>
            </section>
          )}
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon">
                <Bot size={17} />
              </div>
              <div>
                <h2>Agentes e respostas</h2>
                <p>Escolha os padrões para novas conversas.</p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>Agente padrão</strong>
                <span>Usado ao criar uma conversa</span>
              </div>
              <select
                value={data.settings.defaultProviderId}
                onChange={(event) => onSetting('defaultProviderId', event.target.value)}
              >
                {data.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                    {provider.available ? '' : ' · indisponível'}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>Modo padrão</strong>
                <span>Auto adapta o esforço ao pedido</span>
              </div>
              <select
                value={data.settings.defaultMode}
                onChange={(event) => onSetting('defaultMode', event.target.value)}
              >
                <option value="auto">Auto</option>
                <option value="fast">Rápido</option>
                <option value="deep">Completo</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>Estilo de resposta</strong>
                <span>Como o agente organiza as respostas</span>
              </div>
              <select
                value={data.settings.responseStyle}
                onChange={(event) => onSetting('responseStyle', event.target.value)}
              >
                <option value="concise">Conciso</option>
                <option value="balanced">Equilibrado</option>
              </select>
            </div>
          </section>
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon purple">
                <Brain size={17} />
              </div>
              <div>
                <h2>Memória compartilhada</h2>
                <p>Busca notas do escopo do projeto quando o pedido precisa de contexto anterior.</p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>Permitir busca de memória</strong>
                <span>Uma busca só ocorre quando a solicitação indicar contexto relevante.</span>
              </div>
              <button
                className={`toggle ${data.settings.memoryEnabled ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.memoryEnabled}
                aria-label="Permitir busca de memória"
                onClick={() => onSetting('memoryEnabled', !data.settings.memoryEnabled)}
              >
                <span />
              </button>
            </div>
            <div className="integration-list">
              {data.integrations
                .filter((item) => item.kind === 'memory' || item.kind === 'sandbox')
                .map((item) => (
                  <div className="integration-row" key={item.id}>
                    <div className={`integration-icon ${item.kind}`}>
                      {item.kind === 'memory' ? <Brain size={15} /> : <Shield size={15} />}
                    </div>
                    <div>
                      <strong>{item.name}</strong>
                      <span>{item.detail}</span>
                    </div>
                    <span className={`integration-status-pill ${item.status}`}>{integrationName(item.status)}</span>
                  </div>
                ))}
            </div>
          </section>
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon amber">
                <Shield size={17} />
              </div>
              <div>
                <h2>Permissões de execução</h2>
                <p>Escolha o que o agente pode alterar e quando pedir confirmação.</p>
              </div>
            </div>
            <div className="sandbox-options">
              <label className={data.settings.sandbox === 'read-only' ? 'sandbox-option selected' : 'sandbox-option'}>
                <input
                  type="radio"
                  name="sandbox"
                  checked={data.settings.sandbox === 'read-only'}
                  onChange={() => onSetting('sandbox', 'read-only')}
                />
                <div>
                  <strong>Somente leitura</strong>
                  <span>O agente pode inspecionar arquivos.</span>
                </div>
                <Shield size={16} />
              </label>
              <label
                className={data.settings.sandbox === 'workspace-write' ? 'sandbox-option selected' : 'sandbox-option'}
              >
                <input
                  type="radio"
                  name="sandbox"
                  checked={data.settings.sandbox === 'workspace-write'}
                  onChange={() => onSetting('sandbox', 'workspace-write')}
                />
                <div>
                  <strong>Escrita no projeto</strong>
                  <span>Permite alterações dentro da pasta de trabalho.</span>
                </div>
                <Code2 size={16} />
              </label>
            </div>
            <div className="setting-row">
              <div>
                <strong>
                  {data.settings.approvalMode === 'manual' ? 'Confirmar solicitações' : 'Aprovação automática segura'}
                </strong>
                <span>
                  {data.settings.approvalMode === 'manual'
                    ? 'Pede confirmação quando o agente oferece essa opção.'
                    : 'Algumas leituras e alterações podem ser aprovadas automaticamente.'}
                </span>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  onSetting('approvalMode', data.settings.approvalMode === 'manual' ? 'auto-safe' : 'manual')
                }
              >
                {data.settings.approvalMode === 'manual' ? 'Usar aprovação segura' : 'Confirmar solicitações'}
              </button>
            </div>
            <p className="permission-limit">
              O Codex aprova leituras reconhecidas. No Kiro, os pedidos ainda exigem confirmação; Claude não oferece
              confirmação pelo Adelic. Leituras e alterações feitas sem solicitação e scripts podem alterar ou excluir
              arquivos.
            </p>
          </section>
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon blue">
                <Layers3 size={17} />
              </div>
              <div>
                <h2>Skills</h2>
                <p>Procedimentos disponíveis aos agentes, conforme o runtime.</p>
              </div>
            </div>
            {data.skills.length === 0 ? (
              <div className="muted-empty">Nenhuma skill cadastrada.</div>
            ) : (
              <div className="skills-list">
                {data.skills.map((skill) => (
                  <div className="skill-row" key={skill.id}>
                    <div className="skill-symbol">
                      <Command size={14} />
                    </div>
                    <div className="skill-text">
                      <strong>{skill.name}</strong>
                      <span>{skill.description || 'Sem descrição.'}</span>
                    </div>
                    <button
                      className={`toggle small ${skill.enabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={`Ativar skill ${skill.name}`}
                      onClick={() => onSkill(skill.id, !skill.enabled)}
                    >
                      <span />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
          <DiagnosticsCard
            updateCheck={data.settings.updateCheck === true}
            onUpdateCheck={(enabled) => onSetting('updateCheck', enabled)}
          />
        </div>
        <aside className="settings-aside">
          <div className="provider-panel">
            <div className="provider-panel-title">
              <span>AGENTES INSTALADOS</span>
              <span className="count-chip">
                {data.providers.filter((p) => p.available).length}/{data.providers.length}
              </span>
            </div>
            {data.providers.map((provider) => (
              <div className="provider-row" key={provider.id}>
                <div className="provider-avatar">
                  <Bot size={15} />
                </div>
                <div>
                  <strong>{provider.name}</strong>
                  <span>{provider.detail}</span>
                </div>
                <span className={`provider-state ${provider.available ? 'ready' : 'missing'}`}>
                  {provider.available ? 'Disponível' : 'Indisponível'}
                </span>
              </div>
            ))}
          </div>
          <div className="settings-note">
            <div className="note-icon">
              <Shield size={15} />
            </div>
            <p>
              <strong>Seus dados ficam locais.</strong> Projetos, conversas e preferências são mantidos neste
              computador.
            </p>
          </div>
          <div className="system-info">
            <span>Adelic</span>
            <span>Interface local</span>
          </div>
        </aside>
      </div>
    </section>
  );
}
