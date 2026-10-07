import { useState } from 'react';
import { ArrowRightLeft, History, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { HandoffSummaryMode, ProviderInfo } from '../../shared/contracts';
import { useI18n } from '../i18n';

export interface HandoffTarget {
  providerId: ProviderInfo['id'];
  model?: string;
}

/**
 * "Continuar com outro agente" (docs/specs/provider-handoff.md). With `fixedTarget` (a different
 * provider picked in the model menu) it only asks whether to carry a summary; otherwise it also
 * lets the user choose the agent and model.
 */
export function HandoffDialog({
  providers,
  currentProviderId,
  fixedTarget,
  busy,
  error,
  limitBlocked,
  onConfirm,
  onCancelRunning,
  onClose,
}: {
  providers: ProviderInfo[];
  currentProviderId: ProviderInfo['id'];
  fixedTarget?: HandoffTarget;
  busy: boolean;
  error: string;
  /** `error` is a usage limit: offer "Continuar mesmo assim" for the summary call. */
  limitBlocked?: boolean;
  onConfirm: (target: HandoffTarget, summary: HandoffSummaryMode, overrideLimit?: boolean) => void;
  /** Stops the summary call while it runs. */
  onCancelRunning: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const choices = providers.filter((p) => p.id !== currentProviderId);
  const firstAvailable = choices.find((p) => p.available) ?? choices[0];
  const [providerId, setProviderId] = useState(fixedTarget?.providerId ?? firstAvailable?.id);
  const [model, setModel] = useState(fixedTarget?.model ?? '');
  const [running, setRunning] = useState<HandoffSummaryMode | null>(null);
  const target = providers.find((p) => p.id === providerId);
  const current = providers.find((p) => p.id === currentProviderId);
  const canConfirm = Boolean(target?.available) && !busy;
  const confirm = (summary: HandoffSummaryMode) => {
    if (!target) return;
    setRunning(summary);
    onConfirm({ providerId: target.id, ...(model ? { model } : {}) }, summary);
  };
  const currentName = current?.name ?? t('handoff.currentFallback');
  const close = () => (busy ? onCancelRunning() : onClose());
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <div className="modal-card handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
        <div className="modal-heading">
          <div className="project-avatar" aria-hidden="true">
            <ArrowRightLeft size={17} />
          </div>
          <div>
            <h2 id="handoff-title">{fixedTarget ? t('handoff.titleFixed') : t('handoff.title')}</h2>
            <p>
              {fixedTarget && target
                ? t('handoff.introFixed', { target: target.name, current: currentName })
                : t('handoff.intro')}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label={t('handoff.close')} onClick={close}>
            <X size={17} />
          </button>
        </div>
        {!fixedTarget && (
          <>
            <label>
              {t('handoff.agent')}
              <select
                value={providerId ?? ''}
                disabled={busy}
                onChange={(event) => {
                  setProviderId(event.target.value as ProviderInfo['id']);
                  setModel('');
                }}
              >
                {choices.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.available ? p.name : t('handoff.unavailable', { name: p.name })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('handoff.model')}
              <select value={model} disabled={busy || !target} onChange={(event) => setModel(event.target.value)}>
                <option value="">
                  {target?.defaultModel
                    ? t('handoff.defaultModelNamed', { model: target.defaultModel })
                    : t('handoff.defaultModel')}
                </option>
                {target?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="handoff-options" role="group" aria-label={t('handoff.options')}>
          <button
            type="button"
            className="choice-option"
            autoFocus
            disabled={!canConfirm}
            onClick={() => confirm('model')}
          >
            <Sparkles size={15} aria-hidden="true" />
            <span>
              <b>{t('handoff.withSummary')}</b>
              <small>
                {current?.available
                  ? t('handoff.summaryBy', { name: current.name })
                  : t('handoff.summaryLocal', { name: currentName })}
              </small>
            </span>
            {busy && running === 'model' && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
          </button>
          <button type="button" className="choice-option" disabled={!canConfirm} onClick={() => confirm('none')}>
            <History size={15} aria-hidden="true" />
            <span>
              <b>{t('handoff.historyOnly')}</b>
              <small>{t('handoff.historyHint')}</small>
            </span>
          </button>
        </div>
        {busy && running === 'model' && (
          <div className="modal-note" role="status">
            <LoaderCircle className="spin" size={14} /> {t('handoff.writing')}
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {error && limitBlocked && target && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setRunning('model');
              onConfirm({ providerId: target.id, ...(model ? { model } : {}) }, 'model', true);
            }}
          >
            {t('handoff.continueAnyway')}
          </button>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={close}>
            {t('handoff.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
