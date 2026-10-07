import { useState } from 'react';
import { ArrowRightLeft, History, LoaderCircle, Sparkles, X } from 'lucide-react';
import type { HandoffSummaryMode, ProviderInfo } from '../../shared/contracts';

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
  onConfirm,
  onCancelRunning,
  onClose,
}: {
  providers: ProviderInfo[];
  currentProviderId: ProviderInfo['id'];
  fixedTarget?: HandoffTarget;
  busy: boolean;
  error: string;
  onConfirm: (target: HandoffTarget, summary: HandoffSummaryMode) => void;
  /** Stops the summary call while it runs. */
  onCancelRunning: () => void;
  onClose: () => void;
}) {
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
            <h2 id="handoff-title">{fixedTarget ? 'Levar um resumo da conversa?' : 'Continuar com outro agente'}</h2>
            <p>
              {fixedTarget && target
                ? `A conversa continua com ${target.name}. ${current?.name ?? 'O agente atual'} pode escrever um resumo para ele.`
                : 'A conversa continua com o agente escolhido; o histórico fica visível aqui.'}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={close}>
            <X size={17} />
          </button>
        </div>
        {!fixedTarget && (
          <>
            <label>
              Agente
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
                    {p.name}
                    {p.available ? '' : ' (indisponível)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Modelo
              <select value={model} disabled={busy || !target} onChange={(event) => setModel(event.target.value)}>
                <option value="">Modelo padrão{target?.defaultModel ? ` (${target.defaultModel})` : ''}</option>
                {target?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="handoff-options" role="group" aria-label="O que levar para o novo agente">
          <button
            type="button"
            className="choice-option"
            autoFocus
            disabled={!canConfirm}
            onClick={() => confirm('model')}
          >
            <Sparkles size={15} aria-hidden="true" />
            <span>
              <b>Com resumo</b>
              <small>
                {current?.available
                  ? `${current.name} resume objetivo, estado, decisões e pendências, sem ferramentas.`
                  : `${current?.name ?? 'O agente atual'} está indisponível; o Adelic monta um resumo local.`}
              </small>
            </span>
            {busy && running === 'model' && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
          </button>
          <button type="button" className="choice-option" disabled={!canConfirm} onClick={() => confirm('none')}>
            <History size={15} aria-hidden="true" />
            <span>
              <b>Só o histórico recente</b>
              <small>Sem chamada extra; o novo agente recebe as mensagens mais recentes.</small>
            </span>
          </button>
        </div>
        {busy && running === 'model' && (
          <div className="modal-note" role="status">
            <LoaderCircle className="spin" size={14} /> Escrevendo o resumo da conversa…
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={close}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
