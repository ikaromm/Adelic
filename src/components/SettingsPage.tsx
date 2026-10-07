import { ArrowUp, Bot, Brain, Code2, Command, Layers3, Shield, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import {
  AUTO_COMPACT_DEFAULT_TOKENS,
  AUTO_COMPACT_MAX_TOKENS,
  AUTO_COMPACT_MIN_TOKENS,
  CHARS_PER_TOKEN,
} from '../../shared/compaction';
import type {
  Bootstrap,
  GraphifyQueryResult,
  GraphifyStatus,
  OrchestrationConfig,
  Project,
  ProjectCoordination,
  ProviderInfo,
  Settings,
} from '../../shared/contracts';
import { MODEL_FALLBACK_MAX } from '../../shared/schemas';
import { modelLabel } from '../../shared/model-fallback';
import { integrationName } from '../labels';
import { api } from '../api';
import type { VoiceStatus } from '../../shared/voice';
import { notificationPermission, notificationsEnabled } from '../hooks/useRunNotifications';
import { CommandsCard } from './CommandsCard';
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
  onModelFallback,
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
      | 'updateCheck'
      | 'autoRetry'
      | 'notifications'
      | 'autoCompact'
      | 'autoCompactTokens'
      | 'voiceDictation'
      | 'terminalRemote'
      | 'automations',
    value: string | boolean | number,
  ) => void;
  onSkill: (id: string, enabled: boolean) => void;
  onModelFallback: (value: NonNullable<Settings['modelFallback']>) => void;
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
            <div className="setting-row">
              <div>
                <strong>Repetir falhas temporárias</strong>
                <span>Tempo esgotado ou conexão interrompida antes de qualquer resposta: até 2 novas tentativas.</span>
              </div>
              <button
                className={`toggle ${data.settings.autoRetry !== false ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.autoRetry !== false}
                aria-label="Repetir falhas temporárias"
                onClick={() => onSetting('autoRetry', data.settings.autoRetry === false)}
              >
                <span />
              </button>
            </div>
            <ModelFallbackSetting
              providers={data.providers}
              value={data.settings.modelFallback ?? { enabled: false, models: [] }}
              onChange={onModelFallback}
            />
            <AutoCompactSetting
              enabled={data.settings.autoCompact === true}
              tokens={data.settings.autoCompactTokens ?? AUTO_COMPACT_DEFAULT_TOKENS}
              onEnabled={(enabled) => onSetting('autoCompact', enabled)}
              onTokens={(tokens) => onSetting('autoCompactTokens', tokens)}
            />
            <NotificationSetting
              enabled={notificationsEnabled(data.settings)}
              onChange={(enabled) => onSetting('notifications', enabled)}
            />
            <VoiceSetting
              enabled={data.settings.voiceDictation !== false}
              onChange={(enabled) => onSetting('voiceDictation', enabled)}
            />
            <div className="setting-row">
              <div>
                <strong>Automações ativadas</strong>
                <span>
                  Permite que as automações agendadas rodem, só enquanto o Adelic está aberto. Desligado, nada roda.
                </span>
              </div>
              <button
                className={`toggle ${data.settings.automations ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.automations === true}
                aria-label="Automações ativadas"
                onClick={() => onSetting('automations', !data.settings.automations)}
              >
                <span />
              </button>
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
            <div className="setting-row">
              <div>
                <strong>Permitir terminal pelo acesso remoto</strong>
                <span>
                  Com ADELIC_REMOTE_BIND, deixa o Terminal do projeto funcionar também em outros dispositivos, com as
                  mesmas permissões dos agentes. Só pode ser alterado neste computador.
                </span>
              </div>
              <button
                className={`toggle ${data.settings.terminalRemote === true ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.terminalRemote === true}
                aria-label="Permitir terminal pelo acesso remoto"
                disabled={!isLoopbackPage()}
                onClick={() => onSetting('terminalRemote', data.settings.terminalRemote !== true)}
              >
                <span />
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
          <CommandsCard projects={data.projects} project={project} />
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

/**
 * "Notificar quando terminar". Turning it on asks the browser for permission first; when the
 * permission is denied (or was revoked later) the setting explains why nothing appears.
 */
function NotificationSetting({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [permission, setPermission] = useState(notificationPermission);
  const [asking, setAsking] = useState(false);
  async function toggle() {
    if (enabled) return onChange(false);
    let current = notificationPermission();
    if (current === 'default') {
      setAsking(true);
      try {
        current = await Notification.requestPermission();
      } catch {
        current = notificationPermission();
      } finally {
        setAsking(false);
      }
    }
    setPermission(current);
    if (current === 'granted') onChange(true);
  }
  const problem =
    permission === 'unsupported'
      ? 'Este navegador não oferece notificações do sistema.'
      : permission === 'denied'
        ? 'As notificações estão bloqueadas para este endereço. Libere-as nas permissões do navegador e tente de novo.'
        : enabled && permission === 'default'
          ? 'Ative de novo para permitir as notificações neste navegador.'
          : '';
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>Notificar quando terminar</strong>
          <span>
            Com a janela em segundo plano: resposta pronta, falha ou aprovação pendente. Mostra só o título da conversa.
          </span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="Notificar quando terminar"
          disabled={asking}
          onClick={() => void toggle()}
        >
          <span />
        </button>
      </div>
      {problem && (
        <div className="inline-notice" role="status">
          {problem}
        </div>
      )}
    </>
  );
}

/** Local voice dictation (docs/specs/voice.md): on by default, with the server's availability. */
function VoiceSetting({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [status, setStatus] = useState<VoiceStatus>();
  useEffect(() => {
    let live = true;
    api
      .voiceStatus()
      .then((value) => live && setStatus(value))
      .catch((e: Error) => live && setStatus({ available: false, reason: `Ditado indisponível: ${e.message}` }));
    return () => {
      live = false;
    };
  }, []);
  const detail = !status
    ? 'Verificando o voxtype…'
    : status.available
      ? `Disponível: ${[status.engine, status.model].filter(Boolean).join(' · ')}, neste computador.`
      : status.reason;
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>Ditado por voz</strong>
          <span>
            Botão de microfone no campo de mensagem. O áudio é transcrito pelo voxtype neste computador e nunca sai dele
            pelo Adelic.
          </span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="Ditado por voz"
          onClick={() => onChange(!enabled)}
        >
          <span />
        </button>
      </div>
      {enabled && detail && (
        <div className="inline-notice" role="status">
          {detail}
        </div>
      )}
    </>
  );
}

type FallbackModel = NonNullable<Settings['modelFallback']>['models'][number];
const fallbackKey = (item: FallbackModel) => `${item.providerId}\u0000${item.model}`;

/** Opt-in automatic compaction (docs/specs/compaction.md); off by default. */
function AutoCompactSetting({
  enabled,
  tokens,
  onEnabled,
  onTokens,
}: {
  enabled: boolean;
  tokens: number;
  onEnabled: (enabled: boolean) => void;
  onTokens: (tokens: number) => void;
}) {
  const [draft, setDraft] = useState(String(tokens));
  const [editing, setEditing] = useState(false);
  const value = editing ? draft : String(tokens);
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= AUTO_COMPACT_MIN_TOKENS && parsed <= AUTO_COMPACT_MAX_TOKENS;
  const hintId = useId();
  const labelId = useId();
  const commit = () => {
    setEditing(false);
    if (valid && parsed !== tokens) onTokens(parsed);
  };
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>Compactar automaticamente conversas longas</strong>
          <span>
            Antes da próxima mensagem, resume a conversa quando ela passar do limite. Faz uma chamada extra ao agente só
            nesse caso.
          </span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="Compactar automaticamente conversas longas"
          onClick={() => onEnabled(!enabled)}
        >
          <span />
        </button>
      </div>
      {enabled && (
        <div className="setting-row auto-compact-threshold">
          <div>
            <strong id={labelId}>Limite para compactar</strong>
            <span id={hintId}>
              Tokens de entrada da última execução, ou {CHARS_PER_TOKEN}× esse valor em caracteres de histórico quando o
              agente não informa tokens.
            </span>
          </div>
          <input
            type="number"
            inputMode="numeric"
            min={AUTO_COMPACT_MIN_TOKENS}
            max={AUTO_COMPACT_MAX_TOKENS}
            step={1000}
            value={value}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            aria-invalid={!valid}
            onChange={(event) => {
              setEditing(true);
              setDraft(event.target.value);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
          />
        </div>
      )}
    </>
  );
}

/**
 * "Trocar de modelo se o atual estiver sobrecarregado": opt-in, with up to three models tried in
 * order after the automatic retries (docs/specs/retries.md). Only catalog models can be picked.
 */
function ModelFallbackSetting({
  providers,
  value,
  onChange,
}: {
  providers: ProviderInfo[];
  value: NonNullable<Settings['modelFallback']>;
  onChange: (value: NonNullable<Settings['modelFallback']>) => void;
}) {
  const chosen = new Set(value.models.map(fallbackKey));
  const options = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      item: { providerId: provider.id, model: model.id },
      label: `${provider.name} · ${model.name}${provider.available ? '' : ' (indisponível)'}`,
    })),
  );
  const setModels = (models: FallbackModel[]) => onChange({ ...value, models });
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>Trocar de modelo se o atual estiver sobrecarregado</strong>
          <span>
            Depois das novas tentativas, usa os modelos abaixo, em ordem, só naquela resposta. A conversa mantém o
            modelo escolhido.
          </span>
        </div>
        <button
          className={`toggle ${value.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={value.enabled}
          aria-label="Trocar de modelo se o atual estiver sobrecarregado"
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
        >
          <span />
        </button>
      </div>
      {value.enabled && (
        <div className="fallback-models">
          {value.models.length === 0 && (
            <p className="muted-empty">Escolha pelo menos um modelo; sem modelos, nada é trocado.</p>
          )}
          <ol aria-label="Modelos alternativos, em ordem">
            {value.models.map((item, index) => (
              <li key={fallbackKey(item)}>
                <span className="fallback-order">{index + 1}</span>
                <span className="fallback-name">{modelLabel(providers, item)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Subir ${modelLabel(providers, item)}`}
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...value.models];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    setModels(next);
                  }}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remover ${modelLabel(providers, item)}`}
                  onClick={() => setModels(value.models.filter((_, i) => i !== index))}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ol>
          {value.models.length < MODEL_FALLBACK_MAX && (
            <select
              aria-label="Adicionar modelo alternativo"
              value=""
              onChange={(event) => {
                const option = options.find((o) => fallbackKey(o.item) === event.target.value);
                if (option) setModels([...value.models, option.item]);
              }}
            >
              <option value="">Adicionar modelo…</option>
              {options
                .filter((option) => !chosen.has(fallbackKey(option.item)))
                .map((option) => (
                  <option key={fallbackKey(option.item)} value={fallbackKey(option.item)}>
                    {option.label}
                  </option>
                ))}
            </select>
          )}
        </div>
      )}
    </>
  );
}

/** The page was opened on this computer (not through the optional remote address). */
const isLoopbackPage = () => ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
