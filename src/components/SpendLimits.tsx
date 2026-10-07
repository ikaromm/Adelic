import { useId, useState } from 'react';
import { Gauge, X } from 'lucide-react';
import type {
  ProjectSpendLimits,
  SpendLimitKind,
  SpendLimitStatus,
  SpendLimits,
  UsageReport,
  UsageTotals,
} from '../../shared/contracts';
import { isReached, limitInputText, parseLimitInput } from '../../shared/spend-limits';
import type { SpendLimitsPatch } from '../api';
import { getLocale, t, useI18n, type Locale, type MessageKey } from '../i18n';

// Usage limits (docs/specs/spend-limits.md): the Settings card, the project card, the
// conversation banner at 80% and the "Continuar mesmo assim" notice.

/** Whole tokens with the locale's grouping (pt-BR 1.250.000, en 1,250,000), like shared formatTokenCount. */
const tokenCount = (value: number, locale: Locale) => Math.round(value).toLocaleString(locale);
/** Two decimals like shared formatUsd: "US$ 1.25" in pt-BR, "$1.25" in English. */
const usd = (value: number, locale: Locale) => (locale === 'en' ? '$' : 'US$ ') + value.toFixed(2);

/** "1.250 tokens · US$ 0.40 · 3 execuções · custo não informado em 2 execuções". */
export function usageLine(totals: UsageTotals, locale: Locale = getLocale()) {
  const unknownCost = (count: number) => t('spendLimits.unknownCost', { count }, locale);
  const parts = [
    t('spendLimits.tokens', { tokens: tokenCount(totals.tokens, locale) }, locale),
    totals.costUsd === null ? t('spendLimits.noCost', undefined, locale) : usd(totals.costUsd, locale),
    t('spendLimits.runs', { count: totals.runs }, locale),
  ];
  // With no cost at all the second part already says it; otherwise list the runs without it.
  if (totals.costUsd !== null && totals.runsWithoutCost) parts.push(unknownCost(totals.runsWithoutCost));
  else if (totals.costUsd === null && totals.runsWithoutCost && totals.runsWithoutCost < totals.runs)
    parts.push(unknownCost(totals.runsWithoutCost));
  return parts.join(' · ');
}

const KIND_KEY: Record<SpendLimitKind, string> = {
  'daily-tokens': 'dailyTokens',
  'monthly-tokens': 'monthlyTokens',
  'daily-cost': 'dailyCost',
  'monthly-cost': 'monthlyCost',
  'project-monthly-tokens': 'projectMonthlyTokens',
  'project-monthly-cost': 'projectMonthlyCost',
};
/**
 * The banner line for one limit at 80% or more, in the UI locale (shared limitWarningMessage
 * is the server's pt-BR text; this one is byte-identical in pt-BR).
 */
export function limitWarningText(s: SpendLimitStatus, locale: Locale = getLocale()) {
  const format = (value: number) => (s.kind.endsWith('cost') ? usd(value, locale) : tokenCount(value, locale));
  const key = `spendLimits.${isReached(s) ? 'reached' : 'warning'}.${KIND_KEY[s.kind]}` as MessageKey;
  return t(key, { percent: s.percent, used: format(s.used), limit: format(s.limit) }, locale);
}

function UsageSummary({ today, month, label }: { today: UsageTotals; month: UsageTotals; label: string }) {
  const { t, locale } = useI18n();
  return (
    <dl className="usage-summary" aria-label={label}>
      <div>
        <dt>{t('spendLimits.today')}</dt>
        <dd>{usageLine(today, locale)}</dd>
      </div>
      <div>
        <dt>{t('spendLimits.month')}</dt>
        <dd>{usageLine(month, locale)}</dd>
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
  const { t } = useI18n();
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
        <span id={`${id}-hint`}>
          {invalid ? t(kind === 'tokens' ? 'spendLimits.tokensError' : 'spendLimits.costError') : hint}
        </span>
      </div>
      <input
        type="text"
        inputMode={kind === 'tokens' ? 'numeric' : 'decimal'}
        placeholder={t('spendLimits.noLimit')}
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
  const { t } = useI18n();
  const enabled = limits?.enabled === true;
  return (
    <section className="settings-card spend-limits-card" aria-labelledby="spend-limits-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon amber">
          <Gauge size={17} />
        </div>
        <div>
          <h2 id="spend-limits-title">{t('spendLimits.title')}</h2>
          <p>{t('spendLimits.detail')}</p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>{t('spendLimits.enable')}</strong>
          <span>{t('spendLimits.enableDetail')}</span>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label={t('spendLimits.enable')}
          onClick={() => onChange({ enabled: !enabled })}
        >
          <span />
        </button>
      </div>
      {enabled && (
        <>
          <LimitInput
            label={t('spendLimits.dailyTokens')}
            hint={t('spendLimits.dailyTokensHint')}
            kind="tokens"
            value={limits?.dailyTokens}
            onCommit={(dailyTokens) => onChange({ dailyTokens })}
          />
          <LimitInput
            label={t('spendLimits.monthlyTokens')}
            hint={t('spendLimits.monthlyTokensHint')}
            kind="tokens"
            value={limits?.monthlyTokens}
            onCommit={(monthlyTokens) => onChange({ monthlyTokens })}
          />
          <LimitInput
            label={t('spendLimits.dailyCost')}
            hint={t('spendLimits.costHint')}
            kind="cost"
            value={limits?.dailyCostUsd}
            onCommit={(dailyCostUsd) => onChange({ dailyCostUsd })}
          />
          <LimitInput
            label={t('spendLimits.monthlyCost')}
            hint={t('spendLimits.costHint')}
            kind="cost"
            value={limits?.monthlyCostUsd}
            onCommit={(monthlyCostUsd) => onChange({ monthlyCostUsd })}
          />
        </>
      )}
      {report ? (
        <UsageSummary today={report.today} month={report.month} label={t('spendLimits.allUsage')} />
      ) : (
        error && <p className="muted-empty">{t('spendLimits.unavailable', { error })}</p>
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
  const { t } = useI18n();
  return (
    <section className="settings-card spend-limits-card" aria-labelledby="project-spend-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon amber">
          <Gauge size={17} />
        </div>
        <div>
          <h2 id="project-spend-title">{t('spendLimits.project.title')}</h2>
          <p>
            {t('spendLimits.project.detail', { project: projectName })}{' '}
            {globalEnabled ? '' : t('spendLimits.project.offNote')}
          </p>
        </div>
      </div>
      <LimitInput
        label={t('spendLimits.project.monthlyTokens')}
        hint={t('spendLimits.monthlyTokensHint')}
        kind="tokens"
        value={limits?.monthlyTokens}
        onCommit={(monthlyTokens) => onChange({ monthlyTokens })}
      />
      <LimitInput
        label={t('spendLimits.project.monthlyCost')}
        hint={t('spendLimits.costHint')}
        kind="cost"
        value={limits?.monthlyCostUsd}
        onCommit={(monthlyCostUsd) => onChange({ monthlyCostUsd })}
      />
      {report?.project && (
        <UsageSummary
          today={report.project.today}
          month={report.project.month}
          label={t('spendLimits.project.usage')}
        />
      )}
    </section>
  );
}

/** Non-blocking banner in the conversation when a limit is at 80% or more. */
export function SpendWarningBanner({ report, onDismiss }: { report: UsageReport | null; onDismiss: () => void }) {
  const { t, locale } = useI18n();
  if (!report?.warnings.length) return null;
  return (
    <div className="inline-notice spend-warning" role="status">
      <span>
        {report.warnings.map((warning) => (
          <span key={warning.kind}>{limitWarningText(warning, locale)}</span>
        ))}
      </span>
      <button className="icon-button" onClick={onDismiss} aria-label={t('spendLimits.dismissWarning')}>
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
  const { t } = useI18n();
  return (
    <div className="inline-notice error-notice spend-limit-notice" role="alert">
      <span>{message}</span>
      <span className="spend-limit-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onContinue}>
          {t('spendLimits.continue')}
        </button>
        <button className="icon-button" onClick={onDismiss} aria-label={t('spendLimits.dismiss')}>
          <X size={15} />
        </button>
      </span>
    </div>
  );
}
