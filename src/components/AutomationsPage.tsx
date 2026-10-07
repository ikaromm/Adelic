import { CalendarClock, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  AUTOMATION_DENY_DEFAULT_MINUTES,
  AUTOMATION_DENY_MAX_MINUTES,
  AUTOMATION_INTERVAL_MAX_HOURS,
  AUTOMATION_INTERVAL_MIN_HOURS,
  AUTOMATION_NAME_MAX,
  AUTOMATION_PROMPT_MAX,
  describeScheduleWith,
  nextOccurrences,
  systemTimeZone,
  type Automation,
  type AutomationResult,
  type AutomationSchedule,
} from '../../shared/automations';
import type { Bootstrap, Mode, ProviderId } from '../../shared/contracts';
import { AUTOMATION_MESSAGES, CreateAutomationSchema, parseBody } from '../../shared/schemas';
import type { Locale } from '../../shared/i18n';
import { api, type AutomationInput } from '../api';
import { getLocale, t, useI18n, type MessageKey } from '../i18n';

const MODES: Record<Mode, MessageKey> = { auto: 'mode.auto', fast: 'mode.fast', deep: 'mode.deep' };
const RESULT: Record<AutomationResult['status'], MessageKey> = {
  running: 'automations.result.running',
  completed: 'automations.result.completed',
  cancelled: 'automations.result.cancelled',
  failed: 'automations.result.failed',
  interrupted: 'automations.result.interrupted',
  skipped: 'automations.result.skipped',
};
const TRIGGER: Record<AutomationResult['trigger'], MessageKey> = {
  schedule: 'automations.trigger.schedule',
  'catch-up': 'automations.trigger.catchUp',
  manual: 'automations.trigger.manual',
};
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** "9:00 AM" in English; pt-BR keeps the schedule's own "09:00". */
function scheduleTime(time: string, locale: Locale) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (locale === 'pt-BR' || !match) return time;
  return new Date(Date.UTC(1970, 0, 1, Number(match[1]), Number(match[2]))).toLocaleTimeString(locale, {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * describeSchedule() in the UI's language: "Diária às 09:00", "Seg, Qua às 09:00", "A cada 6 h"
 * (en "Daily at 9:00 AM", "Mon, Wed at 9:00 AM", "Every 6 hours"). The server keeps the pt-BR one.
 */
export function scheduleLabel(schedule: AutomationSchedule, locale: Locale = getLocale()) {
  return describeScheduleWith(schedule, {
    interval: (hours) => t('automations.schedule.interval', { count: hours }, locale),
    daily: (time) => t('automations.schedule.daily', { time }, locale),
    weekly: (days, time) => t('automations.schedule.weekly', { days, time }, locale),
    everyDay: (time) => t('automations.schedule.everyDay', { time }, locale),
    weekday: (day) => t(`automations.weekday.${day}` as MessageKey, undefined, locale),
    time: (time) => scheduleTime(time, locale),
  });
}

/** The form's validation messages (shared/schemas.ts, pt-BR) in the UI's language. */
const VALIDATION: [string, MessageKey, Record<string, number>?][] = [
  [AUTOMATION_MESSAGES.name, 'automations.error.name', { max: AUTOMATION_NAME_MAX }],
  [AUTOMATION_MESSAGES.prompt, 'automations.error.prompt', { max: AUTOMATION_PROMPT_MAX }],
  [AUTOMATION_MESSAGES.projectId, 'automations.error.projectId'],
  [
    AUTOMATION_MESSAGES.schedule,
    'automations.error.schedule',
    { min: AUTOMATION_INTERVAL_MIN_HOURS, max: AUTOMATION_INTERVAL_MAX_HOURS },
  ],
  [AUTOMATION_MESSAGES.timezone, 'automations.error.timezone'],
  [AUTOMATION_MESSAGES.deny, 'automations.error.deny', { max: AUTOMATION_DENY_MAX_MINUTES }],
];
const INVALID = 'Automação inválida';
export function validationMessage(message: string, locale: Locale = getLocale()) {
  if (message === INVALID) return t('automations.error.invalid', undefined, locale);
  const found = VALIDATION.find(([source]) => source === message);
  return found ? t(found[1], found[2], locale) : message;
}

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
    INVALID,
  );
  return parsed.ok ? '' : validationMessage(parsed.message);
}

/** "seg., 12 de out. 09:00" (en "Mon, Oct 12, 09:00 AM") in the automation's zone. */
export function occurrenceLabel(ms: number, timeZone: string, locale: Locale = getLocale()) {
  try {
    return new Date(ms).toLocaleString(locale, {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toLocaleString(locale);
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
  const { t, locale } = useI18n();
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

  const projectName = (id: string) => data.projects.find((p) => p.id === id)?.name ?? t('automations.projectRemoved');
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
          <div className="eyebrow">{t('automations.eyebrow')}</div>
          <h1 id={titleId}>{t('automations.title')}</h1>
          <p>{t('automations.subtitle')}</p>
        </div>
        {!draft && (
          <button
            type="button"
            className="primary-button"
            onClick={startNew}
            disabled={!data.projects.length}
            title={data.projects.length ? undefined : t('automations.needProject')}
          >
            <Plus size={15} /> {t('automations.new')}
          </button>
        )}
      </div>
      {!globalOn && (
        <div className="inline-notice automations-off" role="status">
          <span>{t('automations.globalOff')}</span>
          <button type="button" className="secondary-button" onClick={onOpenSettings}>
            {t('automations.openSettings')}
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
          <strong>{t('automations.empty')}</strong>
          <span>{data.projects.length ? t('automations.emptyHint') : t('automations.emptyNoProject')}</span>
        </div>
      )}
      {automations && automations.length > 0 && (
        <ul className="automation-list" aria-label={t('automations.list')}>
          {automations.map((automation) => {
            const result = automation.lastResult;
            return (
              <li key={automation.id} className="automation-item" aria-label={automation.name}>
                <div className="automation-main">
                  <div className="automation-title-row">
                    <strong>{automation.name}</strong>
                    <span className="command-badge">{scheduleLabel(automation.schedule, locale)}</span>
                    <span className="command-badge muted">{projectName(automation.projectId)}</span>
                  </div>
                  <p className="automation-prompt">{automation.prompt}</p>
                  <dl className="automation-facts">
                    <div>
                      <dt>{t('automations.nextRun')}</dt>
                      <dd>
                        {!automation.enabled
                          ? t('automations.off')
                          : !globalOn
                            ? t('automations.allOff')
                            : automation.nextRunAt
                              ? occurrenceLabel(Date.parse(automation.nextRunAt), automation.timezone, locale)
                              : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('automations.lastResult')}</dt>
                      <dd>
                        {result ? (
                          <span className={`automation-result ${result.status}`}>
                            {t(result.detail ? 'automations.resultLineDetail' : 'automations.resultLine', {
                              status: t(RESULT[result.status]),
                              at: occurrenceLabel(Date.parse(result.at), automation.timezone, locale),
                              trigger: t(TRIGGER[result.trigger]),
                              detail: result.detail ?? '',
                            })}
                          </span>
                        ) : (
                          t('automations.never')
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
                    aria-label={t('automations.enable', { name: automation.name })}
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
                    title={globalOn ? undefined : t('automations.turnOnFirst')}
                    onClick={() => void act(automation.id, () => api.runAutomation(automation.id))}
                  >
                    <Play size={13} /> {t('automations.runNow')}
                  </button>
                  {automation.conversationId && data.sessions.some((s) => s.id === automation.conversationId) && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onOpenConversation(automation.conversationId!)}
                    >
                      {t('automations.openConversation')}
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
                        {t('automations.confirmDelete')}
                      </button>
                      <button type="button" className="ghost-button" onClick={() => setConfirmDelete('')}>
                        {t('automations.keep')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ghost-button"
                        aria-label={t('automations.editName', { name: automation.name })}
                        onClick={() => startEdit(automation)}
                      >
                        <Pencil size={13} /> {t('automations.edit')}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        aria-label={t('automations.deleteName', { name: automation.name })}
                        onClick={() => setConfirmDelete(automation.id)}
                      >
                        <Trash2 size={13} /> {t('automations.delete')}
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
  const { t, locale } = useI18n();
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
  const label = draft.id ? t('automations.editName', { name: draft.name }) : t('automations.new');
  return (
    <form className="settings-card command-form automation-form" onSubmit={onSubmit} aria-label={label} noValidate>
      <div className="command-form-heading">
        <strong>{label}</strong>
        <button type="button" className="icon-button" aria-label={t('automations.form.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="command-form-row">
        <label>
          {t('automations.form.name')}
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            maxLength={AUTOMATION_NAME_MAX}
            placeholder={t('automations.form.namePlaceholder')}
            autoFocus
          />
        </label>
        <label>
          {t('automations.form.project')}
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
        {t('automations.form.prompt')}
        <textarea
          value={draft.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          rows={4}
          maxLength={AUTOMATION_PROMPT_MAX}
          placeholder={t('automations.form.promptPlaceholder')}
        />
        <small>{t('automations.form.promptHint', { length: draft.prompt.length, max: AUTOMATION_PROMPT_MAX })}</small>
      </label>
      <div className="command-form-row">
        <label>
          {t('automations.form.repeat')}
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as AutomationSchedule['kind'] })}>
            <option value="daily">{t('automations.form.daily')}</option>
            <option value="weekly">{t('automations.form.weekly')}</option>
            <option value="interval">{t('automations.form.interval')}</option>
          </select>
        </label>
        {draft.kind === 'interval' ? (
          <label>
            {t('automations.form.hours')}
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
            {t('automations.form.time')}
            <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
        )}
        {draft.kind !== 'interval' && (
          <label>
            {t('automations.form.timezone')}
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
          <legend>{t('automations.form.days')}</legend>
          {WEEKDAYS.map((index) => (
            <label key={index} className="automation-day">
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
              {t(`automations.weekday.${index}`)}
            </label>
          ))}
        </fieldset>
      )}
      <div className="command-form-row">
        <label>
          {t('automations.form.agent')}
          <select
            value={draft.providerId}
            onChange={(e) => set({ providerId: e.target.value as ProviderId | '', model: '' })}
          >
            <option value="">{t('automations.form.settingsDefault')}</option>
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('automations.form.model')}
          <select value={draft.model} onChange={(e) => set({ model: e.target.value })}>
            <option value="">{t('automations.form.agentDefault')}</option>
            {provider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('automations.form.mode')}
          <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Mode | '' })}>
            <option value="">{t('automations.form.settingsDefault')}</option>
            {(Object.keys(MODES) as Mode[]).map((m) => (
              <option key={m} value={m}>
                {t(MODES[m])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="automation-check">
        <input type="checkbox" checked={draft.catchUp} onChange={(e) => set({ catchUp: e.target.checked })} />
        {t('automations.form.catchUp')}
      </label>
      <div className="automation-deny">
        <label className="automation-check">
          <input type="checkbox" checked={draft.deny} onChange={(e) => set({ deny: e.target.checked })} />
          {t('automations.form.deny')}
        </label>
        <input
          type="number"
          aria-label={t('automations.form.denyMinutes')}
          min={1}
          max={AUTOMATION_DENY_MAX_MINUTES}
          disabled={!draft.deny}
          value={Number.isFinite(draft.denyMinutes) ? draft.denyMinutes : ''}
          onChange={(e) => set({ denyMinutes: e.target.valueAsNumber })}
        />
        <span>{t('automations.form.minutes')}</span>
      </div>
      <p className="automation-hint">{t('automations.form.approvalsHint')}</p>
      <div className="automation-preview" aria-live="polite">
        <strong>{t('automations.form.preview')}</strong>
        {preview ? (
          <ol aria-label={t('automations.form.preview')}>
            {preview.map((at) => (
              <li key={at}>
                {occurrenceLabel(at, draft.kind === 'interval' ? systemTimeZone() : draft.timezone, locale)}
              </li>
            ))}
          </ol>
        ) : (
          <span>{t('automations.form.previewIncomplete')}</span>
        )}
        {draft.kind === 'interval' && <span>{t('automations.form.previewInterval')}</span>}
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      <div className="automation-form-actions">
        <button type="button" className="ghost-button" onClick={onClose}>
          {t('automations.form.cancel')}
        </button>
        <button type="submit" className="primary-button" disabled={saving}>
          {draft.id ? t('automations.form.save') : t('automations.form.create')}
        </button>
      </div>
      {!draft.id && <p className="automation-hint">{t('automations.form.createdOff')}</p>}
    </form>
  );
}
