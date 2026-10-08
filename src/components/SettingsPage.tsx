import { ArrowUp, Bot, Brain, Code2, Command, Languages, Layers3, Shield, X } from 'lucide-react';
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
  UsageReport,
} from '../../shared/contracts';
import type { SpendLimitsPatch } from '../api';
import { ProjectSpendCard, SpendLimitsCard } from './SpendLimits';
import { MODEL_FALLBACK_MAX } from '../../shared/schemas';
import { modelLabel } from '../../shared/model-fallback';
import { integrationName } from '../labels';
import { api } from '../api';
import type { VoiceStatus } from '../../shared/voice';
import { notificationPermission, notificationsEnabled } from '../hooks/useRunNotifications';
import { CommandsCard } from './CommandsCard';
import { DiagnosticsCard } from './DiagnosticsCard';
import { McpCard } from './McpCard';
import { DetachedMemorySetting } from './DetachedMemorySetting';
import { HooksCard } from './HooksCard';
import { ProjectTools } from './ProjectTools';
import { RemoteAccessCard } from './RemoteAccessCard';
import { RemoteHostsCard } from './RemoteHostsCard';
import { LANGUAGE_PREFERENCES, t as translate, useI18n, type LanguagePreference } from '../i18n';
import { modeLabel } from '../ComposerMenus';

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
  onDetachedMemory,
  onProjectUpdated,
  usage,
  usageError,
  onSpendLimits,
  onProjectSpendLimits,
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
      | 'updateChannel'
      | 'autoRetry'
      | 'notifications'
      | 'autoCompact'
      | 'autoCompactTokens'
      | 'voiceDictation'
      | 'terminalRemote'
      | 'internetManualApproval'
      | 'automations'
      | 'language',
    value: string | boolean | number,
  ) => void;
  onSkill: (id: string, enabled: boolean) => void;
  onModelFallback: (value: NonNullable<Settings['modelFallback']>) => void;
  onDetachedMemory: (scope: Settings['detachedMemory']) => void;
  onProjectUpdated: (project: Project) => void;
  /** Usage report of this page's scope (the project, when one is open). */
  usage: UsageReport | null;
  usageError: string;
  onSpendLimits: (patch: SpendLimitsPatch) => void;
  onProjectSpendLimits: (patch: { monthlyTokens?: number | null; monthlyCostUsd?: number | null }) => void;
  notice: string;
}) {
  const { t, preference, setLocale } = useI18n();
  const [memoryWorkspace, setMemoryWorkspace] = useState(project?.memoryWorkspace || '');
  const [memoryProject, setMemoryProject] = useState(project?.memoryProject || '');
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('settings.eyebrow')}</div>
          <h1>{t('settings.title')}</h1>
          <p>{t('settings.subtitle')}</p>
        </div>
      </div>
      {notice && <div className="inline-notice error-notice">{notice}</div>}
      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card" aria-labelledby="settings-general-title">
            <div className="settings-card-heading">
              <div className="settings-card-icon">
                <Languages size={17} />
              </div>
              <div>
                <h2 id="settings-general-title">{t('settings.general.title')}</h2>
                <p>{t('settings.general.detail')}</p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong id="settings-language-label">{t('settings.language.label')}</strong>
                <span>{t('settings.language.detail')}</span>
              </div>
              <select
                aria-labelledby="settings-language-label"
                value={preference}
                onChange={(event) => {
                  const next = event.target.value as LanguagePreference;
                  setLocale(next);
                  onSetting('language', next);
                }}
              >
                {LANGUAGE_PREFERENCES.map((value) => (
                  <option key={value} value={value}>
                    {t(
                      value === 'auto'
                        ? 'settings.language.auto'
                        : value === 'en'
                          ? 'settings.language.en'
                          : 'settings.language.ptBR',
                    )}
                  </option>
                ))}
              </select>
            </div>
          </section>
          {project && !project.remote && (
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
          {project?.remote && (
            <section className="settings-card">
              <div className="settings-card-heading">
                <div className="settings-card-icon blue">
                  <Code2 size={17} />
                </div>
                <div>
                  <h2>{t('remoteHosts.projectTitle')}</h2>
                  <p>{t('remoteHosts.projectRestrictions')}</p>
                </div>
              </div>
              <div className="remote-git-location">
                <strong>{project.remote.path}</strong>
              </div>
            </section>
          )}

          {project && !project.remote && <HooksCard project={project} />}

          {project && (
            <ProjectSpendCard
              projectName={project.name}
              limits={project.spendLimits}
              globalEnabled={data.settings.spendLimits?.enabled === true}
              report={usage}
              onChange={onProjectSpendLimits}
            />
          )}

          {project && (
            <section className="settings-card">
              <div className="settings-card-heading">
                <div className="settings-card-icon purple">
                  <Brain size={17} />
                </div>
                <div>
                  <h2>{t('settings.memoryScope.title')}</h2>
                  <p>{t('settings.memoryScope.detail')}</p>
                </div>
              </div>
              <label className="setting-row">
                <strong>{t('settings.memoryScope.workspace')}</strong>
                <input value={memoryWorkspace} onChange={(e) => setMemoryWorkspace(e.target.value)} />
              </label>
              <label className="setting-row">
                <strong>{t('settings.memoryScope.project')}</strong>
                <input value={memoryProject} onChange={(e) => setMemoryProject(e.target.value)} />
              </label>
              <button
                className="secondary-button"
                disabled={!memoryWorkspace.trim() || !memoryProject.trim()}
                onClick={() => onProjectMemoryScope(memoryWorkspace.trim(), memoryProject.trim())}
              >
                {t('settings.memoryScope.save')}
              </button>
            </section>
          )}
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon">
                <Bot size={17} />
              </div>
              <div>
                <h2>{t('settings.agents.title')}</h2>
                <p>{t('settings.agents.detail')}</p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('settings.agents.default')}</strong>
                <span>{t('settings.agents.defaultDetail')}</span>
              </div>
              <select
                value={data.settings.defaultProviderId}
                onChange={(event) => onSetting('defaultProviderId', event.target.value)}
              >
                {data.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                    {provider.available ? '' : t('settings.agents.unavailableSuffix')}
                  </option>
                ))}
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('settings.agents.mode')}</strong>
                <span>{t('settings.agents.modeDetail')}</span>
              </div>
              <select
                value={data.settings.defaultMode}
                onChange={(event) => onSetting('defaultMode', event.target.value)}
              >
                <option value="auto">{modeLabel('auto')}</option>
                <option value="fast">{modeLabel('fast')}</option>
                <option value="deep">{modeLabel('deep')}</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('settings.agents.style')}</strong>
                <span>{t('settings.agents.styleDetail')}</span>
              </div>
              <select
                value={data.settings.responseStyle}
                onChange={(event) => onSetting('responseStyle', event.target.value)}
              >
                <option value="concise">{t('settings.agents.style.concise')}</option>
                <option value="balanced">{t('settings.agents.style.balanced')}</option>
              </select>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('settings.agents.retry')}</strong>
                <span>{t('settings.agents.retryDetail')}</span>
              </div>
              <button
                className={`toggle ${data.settings.autoRetry !== false ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.autoRetry !== false}
                aria-label={t('settings.agents.retry')}
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
                <strong>{t('settings.automations.label')}</strong>
                <span>{t('settings.automations.detail')}</span>
              </div>
              <button
                className={`toggle ${data.settings.automations ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.automations === true}
                aria-label={t('settings.automations.label')}
                onClick={() => onSetting('automations', !data.settings.automations)}
              >
                <span />
              </button>
            </div>
          </section>
          <SpendLimitsCard
            limits={data.settings.spendLimits}
            report={usage}
            error={usageError}
            onChange={onSpendLimits}
          />
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon purple">
                <Brain size={17} />
              </div>
              <div>
                <h2>{t('settings.memory.title')}</h2>
                <p>{t('settings.memory.detail')}</p>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('settings.memory.allow')}</strong>
                <span>{t('settings.memory.allowDetail')}</span>
              </div>
              <button
                className={`toggle ${data.settings.memoryEnabled ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.memoryEnabled}
                aria-label={t('settings.memory.allow')}
                onClick={() => onSetting('memoryEnabled', !data.settings.memoryEnabled)}
              >
                <span />
              </button>
            </div>
            <DetachedMemorySetting
              value={data.settings.detachedMemory}
              memoryEnabled={data.settings.memoryEnabled}
              onChange={onDetachedMemory}
            />
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
                <h2>{t('settings.permissions.title')}</h2>
                <p>{t('settings.permissions.detail')}</p>
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
                  <strong>{t('settings.permissions.readOnly')}</strong>
                  <span>{t('settings.permissions.readOnlyDetail')}</span>
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
                  <strong>{t('settings.permissions.write')}</strong>
                  <span>{t('settings.permissions.writeDetail')}</span>
                </div>
                <Code2 size={16} />
              </label>
            </div>
            <div className="setting-row">
              <div>
                <strong>
                  {data.settings.approvalMode === 'manual'
                    ? t('settings.permissions.manual')
                    : t('settings.permissions.auto')}
                </strong>
                <span>
                  {data.settings.approvalMode === 'manual'
                    ? t('settings.permissions.manualDetail')
                    : t('settings.permissions.autoDetail')}
                </span>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  onSetting('approvalMode', data.settings.approvalMode === 'manual' ? 'auto-safe' : 'manual')
                }
              >
                {data.settings.approvalMode === 'manual'
                  ? t('settings.permissions.useAuto')
                  : t('settings.permissions.manual')}
              </button>
            </div>
            <div className="setting-row">
              <div>
                <strong>{t('settings.permissions.terminal')}</strong>
                <span>{t('settings.permissions.terminalDetail')}</span>
              </div>
              <button
                className={`toggle ${data.settings.terminalRemote === true ? 'on' : ''}`}
                role="switch"
                aria-checked={data.settings.terminalRemote === true}
                aria-label={t('settings.permissions.terminal')}
                disabled={!isLoopbackPage()}
                onClick={() => onSetting('terminalRemote', data.settings.terminalRemote !== true)}
              >
                <span />
              </button>
            </div>
            <p className="permission-limit">{t('settings.permissions.limit')}</p>
          </section>
          <RemoteAccessCard
            internetManualApproval={data.settings.internetManualApproval !== false}
            onInternetManualApproval={(enabled) => onSetting('internetManualApproval', enabled)}
          />
          {isLoopbackPage() && <RemoteHostsCard />}
          <section className="settings-card">
            <div className="settings-card-heading">
              <div className="settings-card-icon blue">
                <Layers3 size={17} />
              </div>
              <div>
                <h2>{t('settings.skills.title')}</h2>
                <p>{t('settings.skills.detail')}</p>
              </div>
            </div>
            {data.skills.length === 0 ? (
              <div className="muted-empty">{t('settings.skills.empty')}</div>
            ) : (
              <div className="skills-list">
                {data.skills.map((skill) => (
                  <div className="skill-row" key={skill.id}>
                    <div className="skill-symbol">
                      <Command size={14} />
                    </div>
                    <div className="skill-text">
                      <strong>{skill.name}</strong>
                      <span>{skill.description || t('settings.skills.noDescription')}</span>
                    </div>
                    <button
                      className={`toggle small ${skill.enabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={skill.enabled}
                      aria-label={t('settings.skills.toggle', { name: skill.name })}
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
          {!project?.remote && <McpCard project={project} onProjectUpdated={onProjectUpdated} />}
          <DiagnosticsCard
            updateCheck={data.settings.updateCheck === true}
            onUpdateCheck={(enabled) => onSetting('updateCheck', enabled)}
            updateChannel={data.settings.updateChannel ?? 'master'}
            onUpdateChannel={(channel) => onSetting('updateChannel', channel)}
          />
        </div>
        <aside className="settings-aside">
          <div className="provider-panel">
            <div className="provider-panel-title">
              <span>{t('settings.aside.providers')}</span>
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
                  {provider.available ? t('common.available') : t('common.unavailable')}
                </span>
              </div>
            ))}
          </div>
          <div className="settings-note">
            <div className="note-icon">
              <Shield size={15} />
            </div>
            <p>
              <strong>{t('settings.aside.localTitle')}</strong> {t('settings.aside.localBody')}
            </p>
          </div>
          <div className="system-info">
            <span>Adelic</span>
            <span>{t('settings.aside.interface')}</span>
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
  const { t } = useI18n();
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
      ? t('settings.notifications.unsupported')
      : permission === 'denied'
        ? t('settings.notifications.denied')
        : enabled && permission === 'default'
          ? t('settings.notifications.askAgain')
          : '';
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>{t('settings.notifications.label')}</strong>
          <span>{t('settings.notifications.detail')}</span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label={t('settings.notifications.label')}
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
  const { t } = useI18n();
  const [status, setStatus] = useState<VoiceStatus>();
  useEffect(() => {
    let live = true;
    api
      .voiceStatus()
      .then((value) => live && setStatus(value))
      .catch(
        (e: Error) =>
          live && setStatus({ available: false, reason: translate('settings.voice.error', { error: e.message }) }),
      );
    return () => {
      live = false;
    };
  }, []);
  const detail = !status
    ? t('settings.voice.checking')
    : status.available
      ? t('settings.voice.available', { engine: [status.engine, status.model].filter(Boolean).join(' · ') })
      : status.reason;
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>{t('settings.voice.label')}</strong>
          <span>{t('settings.voice.detail')}</span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label={t('settings.voice.label')}
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
  const { t } = useI18n();
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
          <strong>{t('settings.compact.label')}</strong>
          <span>{t('settings.compact.detail')}</span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label={t('settings.compact.label')}
          onClick={() => onEnabled(!enabled)}
        >
          <span />
        </button>
      </div>
      {enabled && (
        <div className="setting-row auto-compact-threshold">
          <div>
            <strong id={labelId}>{t('settings.compact.threshold')}</strong>
            <span id={hintId}>{t('settings.compact.thresholdDetail', { factor: CHARS_PER_TOKEN })}</span>
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
  const { t } = useI18n();
  const chosen = new Set(value.models.map(fallbackKey));
  const options = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      item: { providerId: provider.id, model: model.id },
      label: `${provider.name} · ${model.name}${provider.available ? '' : t('settings.fallback.unavailableSuffix')}`,
    })),
  );
  const setModels = (models: FallbackModel[]) => onChange({ ...value, models });
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>{t('settings.fallback.label')}</strong>
          <span>{t('settings.fallback.detail')}</span>
        </div>
        <button
          className={`toggle ${value.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={value.enabled}
          aria-label={t('settings.fallback.label')}
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
        >
          <span />
        </button>
      </div>
      {value.enabled && (
        <div className="fallback-models">
          {value.models.length === 0 && <p className="muted-empty">{t('settings.fallback.empty')}</p>}
          <ol aria-label={t('settings.fallback.list')}>
            {value.models.map((item, index) => (
              <li key={fallbackKey(item)}>
                <span className="fallback-order">{index + 1}</span>
                <span className="fallback-name">{modelLabel(providers, item)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('settings.fallback.up', { model: modelLabel(providers, item) })}
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
                  aria-label={t('settings.fallback.remove', { model: modelLabel(providers, item) })}
                  onClick={() => setModels(value.models.filter((_, i) => i !== index))}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ol>
          {value.models.length < MODEL_FALLBACK_MAX && (
            <select
              aria-label={t('settings.fallback.add')}
              value=""
              onChange={(event) => {
                const option = options.find((o) => fallbackKey(o.item) === event.target.value);
                if (option) setModels([...value.models, option.item]);
              }}
            >
              <option value="">{t('settings.fallback.addPlaceholder')}</option>
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
