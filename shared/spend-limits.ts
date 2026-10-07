import type { ProjectSpendLimits, SpendLimitKind, SpendLimitStatus, SpendLimits, UsageTotals } from './contracts.js';

// Usage limits (docs/specs/spend-limits.md): period bounds in the local timezone, the status of
// each configured limit and the pt-BR messages shared by the server and the UI. No I/O.

/** Non-blocking warning from this share of a limit on. */
export const SPEND_WARNING_PERCENT = 80;
/** `code` of the 409 body when a limit blocks a model call. */
export const SPEND_LIMIT_CODE = 'spend_limit';
export const SPEND_TOKENS_MAX = 1_000_000_000_000;
export const SPEND_COST_MAX = 1_000_000;

/** Today, from 00:00 local time to the next 00:00, as ISO instants (DST-safe). */
export function dayBounds(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}
/** The calendar month of `now` in local time, as ISO instants. */
export function monthBounds(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export const spendLimitLabels: Record<SpendLimitKind, string> = {
  'daily-tokens': 'tokens hoje',
  'monthly-tokens': 'tokens no mês',
  'daily-cost': 'custo hoje',
  'monthly-cost': 'custo no mês',
  'project-monthly-tokens': 'tokens do projeto no mês',
  'project-monthly-cost': 'custo do projeto no mês',
};

/** Whole tokens with pt-BR grouping: 1.250.000. */
export const formatTokenCount = (value: number) => Math.round(value).toLocaleString('pt-BR');
/** Same style as the rest of the app (src/format.ts): US$ 1.25. */
export const formatUsd = (value: number) => `US$ ${value.toFixed(2)}`;

/** Two decimals at most (cents), tolerant to binary floating point. */
export const hasCents = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

/** Usage the limits are compared with; cost counts only runs that reported it. */
export interface LimitUsage {
  today: UsageTotals;
  month: UsageTotals;
  /** The project's month, when the call belongs to a project. */
  projectMonth?: UsageTotals;
}

function status(kind: SpendLimitKind, used: number, limit: number): SpendLimitStatus {
  const cost = kind.endsWith('cost');
  return {
    kind,
    label: spendLimitLabels[kind],
    used,
    limit,
    percent: limit > 0 ? Math.floor((used / limit) * 100) : 100,
    usedText: cost ? formatUsd(used) : formatTokenCount(used),
    limitText: cost ? formatUsd(limit) : formatTokenCount(limit),
  };
}

/** Every configured limit with its usage, in a fixed order. Empty while the limits are off. */
export function spendLimitStatuses(
  limits: SpendLimits | undefined,
  project: ProjectSpendLimits | undefined,
  usage: LimitUsage,
): SpendLimitStatus[] {
  if (!limits?.enabled) return [];
  const list: SpendLimitStatus[] = [];
  const add = (kind: SpendLimitKind, used: number, limit: number | undefined) => {
    if (limit !== undefined && limit !== null) list.push(status(kind, used, limit));
  };
  add('daily-tokens', usage.today.tokens, limits.dailyTokens);
  add('monthly-tokens', usage.month.tokens, limits.monthlyTokens);
  add('daily-cost', usage.today.costUsd ?? 0, limits.dailyCostUsd);
  add('monthly-cost', usage.month.costUsd ?? 0, limits.monthlyCostUsd);
  if (usage.projectMonth) {
    add('project-monthly-tokens', usage.projectMonth.tokens, project?.monthlyTokens);
    add('project-monthly-cost', usage.projectMonth.costUsd ?? 0, project?.monthlyCostUsd);
  }
  return list;
}

export const isReached = (s: SpendLimitStatus) => s.used >= s.limit;
export const isWarning = (s: SpendLimitStatus) => s.limit === 0 || s.used * 100 >= s.limit * SPEND_WARNING_PERCENT;

/** The 409 message when a limit blocks a new model call. */
export function limitReachedMessage(s: SpendLimitStatus) {
  return `Limite de uso atingido: ${s.label} (${s.usedText}/${s.limitText}). Ajuste em Configurações ou use 'Continuar mesmo assim'.`;
}
/** The non-blocking banner line for one limit at 80% or more. */
export function limitWarningMessage(s: SpendLimitStatus) {
  return isReached(s)
    ? `Limite de ${s.label} atingido (${s.usedText}/${s.limitText}). A próxima mensagem pede confirmação.`
    : `Uso em ${s.percent}% do limite de ${s.label} (${s.usedText}/${s.limitText}).`;
}

/**
 * A limit typed in Settings: empty clears it (null); tokens accept digits with `.` grouping,
 * cost accepts `,` or `.` as decimal separator with up to two decimals. Undefined when invalid.
 */
export function parseLimitInput(value: string, kind: 'tokens' | 'cost'): number | null | undefined {
  const text = value.trim().replace(/\s+/g, '');
  if (!text) return null;
  if (kind === 'tokens') {
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(text)) return undefined;
    const n = Number(text.replace(/\./g, ''));
    return Number.isSafeInteger(n) && n <= SPEND_TOKENS_MAX ? n : undefined;
  }
  if (!/^\d+([.,]\d{1,2})?$/.test(text)) return undefined;
  const n = Number(text.replace(',', '.'));
  return n <= SPEND_COST_MAX ? n : undefined;
}
/** How a stored limit shows in its input (the inverse of parseLimitInput). */
export function limitInputText(value: number | undefined, kind: 'tokens' | 'cost') {
  if (value === undefined || value === null) return '';
  return kind === 'tokens' ? String(value) : value.toFixed(2).replace('.', ',');
}

/** "custo não informado em N execuções", or empty when every run reported its cost. */
export function unknownCostText(runsWithoutCost: number) {
  if (!runsWithoutCost) return '';
  return `custo não informado em ${runsWithoutCost} ${runsWithoutCost === 1 ? 'execução' : 'execuções'}`;
}
