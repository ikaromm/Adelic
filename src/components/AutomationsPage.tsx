import { CalendarClock, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  AUTOMATION_DENY_DEFAULT_MINUTES,
  AUTOMATION_DENY_MAX_MINUTES,
  AUTOMATION_INTERVAL_MAX_HOURS,
  AUTOMATION_INTERVAL_MIN_HOURS,
  AUTOMATION_NAME_MAX,
  AUTOMATION_PROMPT_MAX,
  WEEKDAY_LABELS,
  describeSchedule,
  nextOccurrences,
  systemTimeZone,
  type Automation,
  type AutomationResult,
  type AutomationSchedule,
} from '../../shared/automations';
import type { Bootstrap, Mode, ProviderId } from '../../shared/contracts';
import { CreateAutomationSchema, parseBody } from '../../shared/schemas';
import { api, type AutomationInput } from '../api';

const modeLabel: Record<Mode, string> = { auto: 'Auto', fast: 'Rápido', deep: 'Completo' };
const resultLabel: Record<AutomationResult['status'], string> = {
  running: 'Em execução',
  completed: 'Concluída',
  cancelled: 'Cancelada',
  failed: 'Falhou',
  interrupted: 'Interrompida',
  skipped: 'Ignorada',
};
const triggerLabel: Record<AutomationResult['trigger'], string> = {
  schedule: 'agendada',
  'catch-up': 'recuperada ao abrir',
  manual: 'manual',
};

interface Draft {
  id?: string;
  name: string;
  prompt: string;
  projectId: string;
  providerId: ProviderId | '';
  model: string;
  mode: Mode | '';
  kind: AutomationSchedule['kind'];
  time: string;
  days: number[];
  hours: number;
  timezone: string;
  catchUp: boolean;
  deny: boolean;
  denyMinutes: number;
}

function draftSchedule(draft: Draft): AutomationSchedule {
  if (draft.kind === 'interval') return { kind: 'interval', hours: draft.hours };
  if (draft.kind === 'weekly') return { kind: 'weekly', days: draft.days, time: draft.time };
  return { kind: 'daily', time: draft.time };
}
function draftInput(draft: Draft): AutomationInput {
  return {
    name: draft.name,
    prompt: draft.prompt,
    projectId: draft.projectId,
    providerId: draft.providerId || null,
    model: draft.model || null,
    mode: draft.mode || null,
    schedule: draftSchedule(draft),
    timezone: draft.timezone.trim(),
    catchUp: draft.catchUp,
    denyApprovalsAfterMinutes: draft.deny ? draft.denyMinutes : null,
  };
}
/** Same rules and messages as the API (shared/schemas.ts). */
function draftError(draft: Draft) {
  const input = draftInput(draft);
  const parsed = parseBody(
    CreateAutomationSchema,
    {
      ...input,
      providerId: input.providerId ?? undefined,
      model: input.model ?? undefined,
      mode: input.mode ?? undefined,
    },
    'Automação inválida',
  );
  return parsed.ok ? '' : parsed.message;
}

/** "seg., 12 de out. 09:00" in the automation's zone. */
export function occurrenceLabel(ms: number, timeZone: string) {
  try {
    return new Date(ms).toLocaleString('pt-BR', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toLocaleString('pt-BR');
  }
}

/**
 * "Automações": scheduled prompts that run in their own conversation while Adelic is open
 * (docs/specs/automations.md). Created disabled; nothing runs while the global switch is off.
 */
export function AutomationsPage({
  data,
  version,
  onOpenConversation,
  onOpenSettings,
}: {
  data: Bootstrap;
  /** Bumped by the stream on every automation change; the list reloads. */
  version: number;
  onOpenConversation: (sessionId: string) => void;
  onOpenSettings: () => void;
}) {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [rowNotice, setRowNotice] = useState<Record<string, string>>({});
  const titleId = useId();
  const globalOn = data.settings.automations === true;

  const reload = useCallback(async () => {
    try {
      setAutomations((await api.automations()).automations);
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, version, globalOn]);

  const projectName = (id: string) => data.projects.find((p) => p.id === id)?.name ?? 'Projeto removido';
  const startNew = () => {
    setFormError('');
    setDraft({
      name: '',
      prompt: '',
      projectId: data.projects[0]?.id ?? '',
      providerId: '',
      model: '',
      mode: '',
      kind: 'daily',
      time: '09:00',
      days: [1, 2, 3, 4, 5],
      hours: 6,
      timezone: systemTimeZone(),
      catchUp: false,
      deny: true,
      denyMinutes: AUTOMATION_DENY_DEFAULT_MINUTES,
    });
  };
  const startEdit = (automation: Automation) => {
    setFormError('');
    const schedule = automation.schedule;
    setDraft({
      id: automation.id,
      name: automation.name,
      prompt: automation.prompt,
      projectId: automation.projectId,
      providerId: automation.providerId ?? '',
      model: automation.model ?? '',
      mode: automation.mode ?? '',
      kind: schedule.kind,
      time: schedule.kind === 'interval' ? '09:00' : schedule.time,
      days: schedule.kind === 'weekly' ? schedule.days : [1, 2, 3, 4, 5],
      hours: schedule.kind === 'interval' ? schedule.hours : 6,
      timezone: automation.timezone,
      catchUp: automation.catchUp,
      deny: automation.denyApprovalsAfterMinutes !== null,
      denyMinutes: automation.denyApprovalsAfterMinutes ?? AUTOMATION_DENY_DEFAULT_MINUTES,
    });
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const problem = draftError(draft);
    if (problem) return setFormError(problem);
    setSaving(true);
    try {
      const input = draftInput(draft);
      if (draft.id) await api.updateAutomation(draft.id, input);
      else
        await api.createAutomation({
          ...input,
          providerId: input.providerId ?? undefined,
          model: input.model ?? undefined,
          mode: input.mode ?? undefined,
        });
      setDraft(null);
      await reload();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function act(id: string, work: () => Promise<unknown>) {
    setRowNotice((current) => ({ ...current, [id]: '' }));
    try {
      await work();
    } catch (error) {
      setRowNotice((current) => ({ ...current, [id]: (error as Error).message }));
    }
    await reload();
  }

  return (
    <section className="page-content automations-page" aria-labelledby={titleId}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">TAREFAS AGENDADAS</div>
          <h1 id={titleId}>Automações</h1>
          <p>
            Pedidos que rodam sozinhos num horário, cada um na sua conversa. Só rodam enquanto o Adelic está aberto.
          </p>
        </div>
        {!draft && (
          <button
            type="button"
            className="primary-button"
            onClick={startNew}
            disabled={!data.projects.length}
            title={data.projects.length ? undefined : 'Cadastre um projeto primeiro'}
          >
            <Plus size={15} /> Nova automação
          </button>
        )}
      </div>
      {!globalOn && (
        <div className="inline-notice automations-off" role="status">
          <span>Automações desativadas: nada roda até você ligar “Automações ativadas” em Configurações.</span>
          <button type="button" className="secondary-button" onClick={onOpenSettings}>
            Abrir configurações
          </button>
        </div>
      )}
      {loadError && (
        <div className="inline-notice error-notice" role="alert">
          {loadError}
        </div>
      )}
      {draft && (
        <AutomationForm
          data={data}
          draft={draft}
          error={formError}
          saving={saving}
          onChange={setDraft}
          onSubmit={save}
          onClose={() => setDraft(null)}
        />
      )}
      {automations && automations.length === 0 && !draft && (
        <div className="empty-panel">
          <div className="empty-icon">
            <CalendarClock size={18} />
          </div>
          <strong>Nenhuma automação</strong>
          <span>
            {data.projects.length
              ? 'Crie uma para rodar um pedido todo dia, em dias da semana ou a cada algumas horas.'
              : 'Automações rodam num projeto: cadastre um projeto primeiro.'}
          </span>
        </div>
      )}
      {automations && automations.length > 0 && (
        <ul className="automation-list" aria-label="Automações cadastradas">
          {automations.map((automation) => {
            const result = automation.lastResult;
            return (
              <li key={automation.id} className="automation-item" aria-label={automation.name}>
                <div className="automation-main">
                  <div className="automation-title-row">
                    <strong>{automation.name}</strong>
                    <span className="command-badge">{describeSchedule(automation.schedule)}</span>
                    <span className="command-badge muted">{projectName(automation.projectId)}</span>
                  </div>
                  <p className="automation-prompt">{automation.prompt}</p>
                  <dl className="automation-facts">
                    <div>
                      <dt>Próxima execução</dt>
                      <dd>
                        {!automation.enabled
                          ? 'Desligada'
                          : !globalOn
                            ? 'Automações desativadas'
                            : automation.nextRunAt
                              ? occurrenceLabel(Date.parse(automation.nextRunAt), automation.timezone)
                              : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Último resultado</dt>
                      <dd>
                        {result ? (
                          <span className={`automation-result ${result.status}`}>
                            {resultLabel[result.status]} · {occurrenceLabel(Date.parse(result.at), automation.timezone)}{' '}
                            ({triggerLabel[result.trigger]}){result.detail ? ` — ${result.detail}` : ''}
                          </span>
                        ) : (
                          'Nunca executada'
                        )}
                      </dd>
                    </div>
                  </dl>
                  {rowNotice[automation.id] && (
                    <div className="inline-notice error-notice" role="alert">
                      {rowNotice[automation.id]}
                    </div>
                  )}
                </div>
                <div className="automation-actions">
                  <button
                    type="button"
                    className={`toggle ${automation.enabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={automation.enabled}
                    aria-label={`Ativar ${automation.name}`}
                    onClick={() =>
                      void act(automation.id, () =>
                        api.updateAutomation(automation.id, { enabled: !automation.enabled }),
                      )
                    }
                  >
                    <span />
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!globalOn}
                    title={globalOn ? undefined : 'Ligue “Automações ativadas” em Configurações'}
                    onClick={() => void act(automation.id, () => api.runAutomation(automation.id))}
                  >
                    <Play size={13} /> Executar agora
                  </button>
                  {automation.conversationId && data.sessions.some((s) => s.id === automation.conversationId) && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onOpenConversation(automation.conversationId!)}
                    >
                      Abrir conversa
                    </button>
                  )}
                  {confirmDelete === automation.id ? (
                    <>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => {
                          setConfirmDelete('');
                          void act(automation.id, () => api.deleteAutomation(automation.id));
                        }}
                      >
                        Confirmar exclusão
                      </button>
                      <button type="button" className="ghost-button" onClick={() => setConfirmDelete('')}>
                        Manter
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ghost-button"
                        aria-label={`Editar ${automation.name}`}
                        onClick={() => startEdit(automation)}
                      >
                        <Pencil size={13} /> Editar
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        aria-label={`Excluir ${automation.name}`}
                        onClick={() => setConfirmDelete(automation.id)}
                      >
                        <Trash2 size={13} /> Excluir
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AutomationForm({
  data,
  draft,
  error,
  saving,
  onChange,
  onSubmit,
  onClose,
}: {
  data: Bootstrap;
  draft: Draft;
  error: string;
  saving: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const provider = data.providers.find((p) => p.id === (draft.providerId || data.settings.defaultProviderId));
  const preview = useMemo(() => {
    if (draftError({ ...draft, name: draft.name || 'x', prompt: draft.prompt || 'x', projectId: 'x' })) return null;
    try {
      return nextOccurrences(draftSchedule(draft), draft.timezone.trim(), Date.now(), 3);
    } catch {
      return null;
    }
  }, [draft]);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }, []);
  const label = draft.id ? `Editar ${draft.name}` : 'Nova automação';
  return (
    <form className="settings-card command-form automation-form" onSubmit={onSubmit} aria-label={label} noValidate>
      <div className="command-form-heading">
        <strong>{label}</strong>
        <button type="button" className="icon-button" aria-label="Fechar formulário" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="command-form-row">
        <label>
          Nome
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            maxLength={AUTOMATION_NAME_MAX}
            placeholder="ex.: Revisão diária"
            autoFocus
          />
        </label>
        <label>
          Projeto
          <select value={draft.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Pedido
        <textarea
          value={draft.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={4}
          maxLength={AUTOMATION_PROMPT_MAX}
          placeholder="/revisar as mudanças de ontem"
        />
        <small>
          Aceita comandos salvos (/revisar) e /plano. {draft.prompt.length}/{AUTOMATION_PROMPT_MAX}
        </small>
      </label>
      <div className="command-form-row">
        <label>
          Repetição
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as AutomationSchedule['kind'] })}>
            <option value="daily">Todo dia</option>
            <option value="weekly">Dias da semana</option>
            <option value="interval">A cada N horas</option>
          </select>
        </label>
        {draft.kind === 'interval' ? (
          <label>
            Horas entre execuções
            <input
              type="number"
              min={AUTOMATION_INTERVAL_MIN_HOURS}
              max={AUTOMATION_INTERVAL_MAX_HOURS}
              value={Number.isFinite(draft.hours) ? draft.hours : ''}
              onChange={(e) => set({ hours: e.target.valueAsNumber })}
            />
          </label>
        ) : (
          <label>
            Horário
            <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
        )}
        {draft.kind !== 'interval' && (
          <label>
            Fuso horário
            <input
              value={draft.timezone}
              onChange={(e) => set({ timezone: e.target.value })}
              list={zones.length ? 'automation-zones' : undefined}
              spellCheck={false}
            />
            {zones.length > 0 && (
              <datalist id="automation-zones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            )}
          </label>
        )}
      </div>
      {draft.kind === 'weekly' && (
        <fieldset className="automation-days">
          <legend>Dias</legend>
          {WEEKDAY_LABELS.map((day, index) => (
            <label key={day} className="automation-day">
              <input
                type="checkbox"
                checked={draft.days.includes(index)}
                onChange={(e) =>
                  set({
                    days: e.target.checked
                      ? [...draft.days, index].sort((a, b) => a - b)
                      : draft.days.filter((d) => d !== index),
                  })
                }
              />
              {day}
            </label>
          ))}
        </fieldset>
      )}
      <div className="command-form-row">
        <label>
          Agente
          <select
            value={draft.providerId}
            onChange={(e) => set({ providerId: e.target.value as ProviderId | '', model: '' })}
          >
            <option value="">Padrão das configurações</option>
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo
          <select value={draft.model} onChange={(e) => set({ model: e.target.value })}>
            <option value="">Padrão do agente</option>
            {provider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modo
          <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Mode | '' })}>
            <option value="">Padrão das configurações</option>
            {(Object.keys(modeLabel) as Mode[]).map((m) => (
              <option key={m} value={m}>
                {modeLabel[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="automation-check">
        <input type="checkbox" checked={draft.catchUp} onChange={(e) => set({ catchUp: e.target.checked })} />
        Se o Adelic estava fechado no horário, executar uma vez ao abrir
      </label>
      <div className="automation-deny">
        <label className="automation-check">
          <input type="checkbox" checked={draft.deny} onChange={(e) => set({ deny: e.target.checked })} />
          Negar aprovações automaticamente após
        </label>
        <input
          type="number"
          aria-label="Minutos até negar aprovações"
          min={1}
          max={AUTOMATION_DENY_MAX_MINUTES}
          disabled={!draft.deny}
          value={Number.isFinite(draft.denyMinutes) ? draft.denyMinutes : ''}
          onChange={(e) => set({ denyMinutes: e.target.valueAsNumber })}
        />
        <span>minutos</span>
      </div>
      <p className="automation-hint">
        Usa o sandbox e as aprovações das Configurações. Nada é aprovado sozinho: pedidos de aprovação esperam por você
        e, com a opção acima, são negados depois do prazo.
      </p>
      <div className="automation-preview" aria-live="polite">
        <strong>Próximas execuções</strong>
        {preview ? (
          <ol aria-label="Próximas execuções">
            {preview.map((at) => (
              <li key={at}>{occurrenceLabel(at, draft.kind === 'interval' ? systemTimeZone() : draft.timezone)}</li>
            ))}
          </ol>
        ) : (
          <span>Complete a agenda para ver as próximas execuções.</span>
        )}
        {draft.kind === 'interval' && <span>Contadas a partir de quando a automação for ligada ou salva.</span>}
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      <div className="automation-form-actions">
        <button type="button" className="ghost-button" onClick={onClose}>
          Cancelar
        </button>
        <button type="submit" className="primary-button" disabled={saving}>
          {draft.id ? 'Salvar automação' : 'Criar automação'}
        </button>
      </div>
      {!draft.id && <p className="automation-hint">Criada desligada: ligue-a na lista quando quiser que rode.</p>}
    </form>
  );
}
