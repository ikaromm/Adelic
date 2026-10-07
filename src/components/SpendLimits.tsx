import { useId, useState } from 'react';
import { Gauge, X } from 'lucide-react';
import type { ProjectSpendLimits, SpendLimits, UsageReport, UsageTotals } from '../../shared/contracts';
import {
  formatTokenCount,
  formatUsd,
  limitInputText,
  limitWarningMessage,
  parseLimitInput,
  unknownCostText,
} from '../../shared/spend-limits';
import type { SpendLimitsPatch } from '../api';

// Usage limits (docs/specs/spend-limits.md): the Settings card, the project card, the
// conversation banner at 80% and the "Continuar mesmo assim" notice.

/** "1.250 tokens · US$ 0.40 · 3 execuções · custo não informado em 2 execuções". */
export function usageLine(totals: UsageTotals) {
  const parts = [
    `${formatTokenCount(totals.tokens)} tokens`,
    totals.costUsd === null ? 'custo não informado' : formatUsd(totals.costUsd),
    `${totals.runs} ${totals.runs === 1 ? 'execução' : 'execuções'}`,
  ];
  // With no cost at all the second part already says it; otherwise list the runs without it.
  if (totals.costUsd !== null && totals.runsWithoutCost) parts.push(unknownCostText(totals.runsWithoutCost));
  else if (totals.costUsd === null && totals.runsWithoutCost && totals.runsWithoutCost < totals.runs)
    parts.push(unknownCostText(totals.runsWithoutCost));
  return parts.join(' · ');
}

function UsageSummary({ today, month, label }: { today: UsageTotals; month: UsageTotals; label: string }) {
  return (
    <dl className="usage-summary" aria-label={label}>
      <div>
        <dt>Hoje</dt>
        <dd>{usageLine(today)}</dd>
      </div>
      <div>
        <dt>Este mês</dt>
        <dd>{usageLine(month)}</dd>
      </div>
    </dl>
  );
}

/** One limit input, committed on blur or Enter; empty removes the limit. */
function LimitInput({
  label,
  hint,
  kind,
  value,
  onCommit,
}: {
  label: string;
  hint: string;
  kind: 'tokens' | 'cost';
  value: number | undefined;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? limitInputText(value, kind);
  const parsed = parseLimitInput(text, kind);
  const invalid = parsed === undefined;
  const id = useId();
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (parsed !== undefined && parsed !== (value ?? null)) onCommit(parsed);
  };
  return (
    <div className="setting-row spend-limit-row">
      <div>
        <strong id={`${id}-label`}>{label}</strong>
        <span id={`${id}-hint`}>{invalid ? errorHint(kind) : hint}</span>
      </div>
      <input
        type="text"
        inputMode={kind === 'tokens' ? 'numeric' : 'decimal'}
        placeholder="Sem limite"
        value={text}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        aria-invalid={invalid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(null);
        }}
      />
    </div>
  );
}
const errorHint = (kind: 'tokens' | 'cost') =>
  kind === 'tokens' ? 'Use um número inteiro de tokens, ou deixe vazio.' : 'Use dólares com até 2 casas, como 5,00.';

/** Settings › Limites de uso: off by default; global daily and monthly limits. */
export function SpendLimitsCard({
  limits,
  report,
  error,
  onChange,
}: {
  limits: SpendLimits | undefined;
  report: UsageReport | null;
  error: string;
  onChange: (patch: SpendLimitsPatch) => void;
}) {
  const enabled = limits?.enabled === true;
  return (
    <section className="settings-card spend-limits-card" aria-labelledby="spend-limits-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon amber">
          <Gauge size={17} />
        </div>
        <div>
          <h2 id="spend-limits-title">Limites de uso</h2>
          <p>
            Antes de cada chamada ao agente, confere o uso de hoje e do mês (horário local). Uma resposta em andamento
            nunca é interrompida.
          </p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>Limitar uso</strong>
          <span>Avisa em 80% e pede confirmação quando um limite é atingido. Desligado, nada é bloqueado.</span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="Limitar uso"
          onClick={() => onChange({ enabled: !enabled })}
        >
          <span />
        </button>
      </div>
      {enabled && (
        <>
          <LimitInput
            label="Tokens por dia"
            hint="Entrada + saída desde 00:00."
            kind="tokens"
            value={limits?.dailyTokens}
            onCommit={(dailyTokens) => onChange({ dailyTokens })}
          />
          <LimitInput
            label="Tokens por mês"
            hint="Entrada + saída no mês corrente."
            kind="tokens"
            value={limits?.monthlyTokens}
            onCommit={(monthlyTokens) => onChange({ monthlyTokens })}
          />
          <LimitInput
            label="Custo por dia (US$)"
            hint="Só conta execuções que informaram custo."
            kind="cost"
            value={limits?.dailyCostUsd}
            onCommit={(dailyCostUsd) => onChange({ dailyCostUsd })}
          />
          <LimitInput
            label="Custo por mês (US$)"
            hint="Só conta execuções que informaram custo."
            kind="cost"
            value={limits?.monthlyCostUsd}
            onCommit={(monthlyCostUsd) => onChange({ monthlyCostUsd })}
          />
        </>
      )}
      {report ? (
        <UsageSummary today={report.today} month={report.month} label="Uso de todas as conversas" />
      ) : (
        error && <p className="muted-empty">Uso indisponível: {error}</p>
      )}
    </section>
  );
}

/** Project settings: optional monthly limits and the project's usage. */
export function ProjectSpendCard({
  projectName,
  limits,
  globalEnabled,
  report,
  onChange,
}: {
  projectName: string;
  limits: ProjectSpendLimits | undefined;
  globalEnabled: boolean;
  report: UsageReport | null;
  onChange: (patch: { monthlyTokens?: number | null; monthlyCostUsd?: number | null }) => void;
}) {
  return (
    <section className="settings-card spend-limits-card" aria-labelledby="project-spend-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon amber">
          <Gauge size={17} />
        </div>
        <div>
          <h2 id="project-spend-title">Uso do projeto</h2>
          <p>
            {projectName} · conversas vinculadas a este projeto.{' '}
            {globalEnabled ? '' : 'Os limites valem quando "Limitar uso" está ligado.'}
          </p>
        </div>
      </div>
      <LimitInput
        label="Tokens do projeto por mês"
        hint="Entrada + saída no mês corrente."
        kind="tokens"
        value={limits?.monthlyTokens}
        onCommit={(monthlyTokens) => onChange({ monthlyTokens })}
      />
      <LimitInput
        label="Custo do projeto por mês (US$)"
        hint="Só conta execuções que informaram custo."
        kind="cost"
        value={limits?.monthlyCostUsd}
        onCommit={(monthlyCostUsd) => onChange({ monthlyCostUsd })}
      />
      {report?.project && (
        <UsageSummary today={report.project.today} month={report.project.month} label="Uso do projeto" />
      )}
    </section>
  );
}

/** Non-blocking banner in the conversation when a limit is at 80% or more. */
export function SpendWarningBanner({ report, onDismiss }: { report: UsageReport | null; onDismiss: () => void }) {
  if (!report?.warnings.length) return null;
  return (
    <div className="inline-notice spend-warning" role="status">
      <span>
        {report.warnings.map((warning) => (
          <span key={warning.kind}>{limitWarningMessage(warning)}</span>
        ))}
      </span>
      <button className="icon-button" onClick={onDismiss} aria-label="Dispensar aviso de uso">
        <X size={15} />
      </button>
    </div>
  );
}

/** A refused request: the 409 message and "Continuar mesmo assim" for that one request. */
export function LimitNotice({
  message,
  busy,
  onContinue,
  onDismiss,
}: {
  message: string;
  busy: boolean;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="inline-notice error-notice spend-limit-notice" role="alert">
      <span>{message}</span>
      <span className="spend-limit-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onContinue}>
          Continuar mesmo assim
        </button>
        <button className="icon-button" onClick={onDismiss} aria-label="Dispensar aviso">
          <X size={15} />
        </button>
      </span>
    </div>
  );
}
