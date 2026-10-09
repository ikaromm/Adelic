import type {
  ProjectSpendLimits,
  Run,
  SpendLimitKind,
  SpendLimits,
  UsageReport,
  UsageTotals,
} from '../shared/contracts.js';
import {
  SPEND_LIMIT_CODE,
  dayBounds,
  isReached,
  isWarning,
  limitReachedMessage,
  monthBounds,
  spendLimitStatuses,
} from '../shared/spend-limits.js';
import type { Store } from './store.js';
import type { ServerKey } from './i18n.js';

// Usage limits (docs/specs/spend-limits.md). Usage is aggregated on demand from the runs table
// with one SQL scan per scope (see Store.usageTotals): every model call of Adelic is recorded on
// a run (direct turns, coordinated tasks, automatic and manual compaction, handoff summaries,
// retries and model fallback attempts), so the runs table is the single source of truth and
// nothing has to be kept in sync or rebuilt at startup.

type Usage = Pick<Run, 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens' | 'costUsd'>;
const add = (a: number | undefined, b: number | undefined) =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/**
 * Usage of one model call across its attempts (automatic retries and model fallback). Usage
 * events report the latest value of the current attempt; a new attempt keeps what the previous
 * ones reported, so a failed attempt that already consumed tokens still counts.
 */
export class UsageMeter {
  private settled: Usage = {};
  private current: Usage = {};
  /** A new attempt starts. */
  attempt() {
    this.settled = this.sum();
    this.current = {};
  }
  /** A `usage` event of the current attempt. */
  event(usage: Usage) {
    this.current = {
      inputTokens: usage.inputTokens ?? this.current.inputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? this.current.cachedInputTokens,
      outputTokens: usage.outputTokens ?? this.current.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens ?? this.current.reasoningOutputTokens,
      costUsd: usage.costUsd ?? this.current.costUsd,
    };
  }
  /** The final result of the current attempt: tokens fill what events did not report; a reported cost wins. */
  result(usage: Usage) {
    this.current = {
      inputTokens: this.current.inputTokens ?? usage.inputTokens,
      cachedInputTokens: this.current.cachedInputTokens ?? usage.cachedInputTokens,
      outputTokens: this.current.outputTokens ?? usage.outputTokens,
      reasoningOutputTokens: this.current.reasoningOutputTokens ?? usage.reasoningOutputTokens,
      costUsd: usage.costUsd ?? this.current.costUsd,
    };
  }
  private sum(): Usage {
    return {
      inputTokens: add(this.settled.inputTokens, this.current.inputTokens),
      cachedInputTokens: add(this.settled.cachedInputTokens, this.current.cachedInputTokens),
      outputTokens: add(this.settled.outputTokens, this.current.outputTokens),
      reasoningOutputTokens: add(this.settled.reasoningOutputTokens, this.current.reasoningOutputTokens),
      costUsd: add(this.settled.costUsd, this.current.costUsd),
    };
  }
  /** Totals so far; a field nobody reported stays undefined (unknown, never zero). */
  totals(): Usage {
    return this.sum();
  }
}

/** Copies a meter's totals onto a run; unknown fields are removed rather than set to zero. */
export function applyUsage(run: Run, usage: Usage) {
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'costUsd'] as const) {
    const value = usage[key];
    if (value === undefined) delete run[key];
    else run[key] = value;
  }
}
/** Adds one call's usage to a run (coordinated tasks, auxiliary calls). */
export function addUsage(run: Run, usage: Usage) {
  run.inputTokens = add(run.inputTokens, usage.inputTokens);
  run.cachedInputTokens = add(run.cachedInputTokens, usage.cachedInputTokens);
  run.outputTokens = add(run.outputTokens, usage.outputTokens);
  run.reasoningOutputTokens = add(run.reasoningOutputTokens, usage.reasoningOutputTokens);
  run.costUsd = add(run.costUsd, usage.costUsd);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'costUsd'] as const)
    if (run[key] === undefined) delete run[key];
}

/** Today and this month (local time), globally and for `projectId`, with the limit statuses. */
export function usageReport(store: Store, projectId?: string, now = new Date()): UsageReport {
  const day = dayBounds(now),
    month = monthBounds(now);
  const [today, monthTotals] = store.usageTotals([day, month]);
  const settings = store.getSettings();
  const global: SpendLimits = settings?.spendLimits ?? { enabled: false };
  const project = projectId ? store.getProject(projectId) : undefined;
  let projectTotals: { today: UsageTotals; month: UsageTotals } | undefined;
  if (project) {
    const [projectToday, projectMonth] = store.usageTotals([day, month], project.id);
    projectTotals = { today: projectToday, month: projectMonth };
  }
  const statuses = spendLimitStatuses(global, project?.spendLimits, {
    today,
    month: monthTotals,
    ...(projectTotals ? { projectMonth: projectTotals.month } : {}),
  });
  return {
    today,
    month: monthTotals,
    ...(project && projectTotals ? { project: { id: project.id, ...projectTotals } } : {}),
    limits: {
      enabled: global.enabled === true,
      global,
      ...(project ? { project: project.spendLimits ?? ({} as ProjectSpendLimits) } : {}),
    },
    warnings: statuses.filter(isWarning),
    reached: statuses.filter(isReached),
  };
}

/** Error thrown (409) when a configured limit is already reached before a model call. */
export function spendLimitError(report: UsageReport) {
  const reached = report.reached[0];
  // `.message` is limitReachedMessage (pt-BR, as before); the key translates the answer. The
  // numbers keep their status format (`usedText` / `limitText`).
  const error = Object.assign(new Error(limitReachedMessage(reached)), {
    status: 409,
    code: SPEND_LIMIT_CODE,
    limit: reached,
  });
  return Object.assign(error, {
    key: REACHED_KEYS[reached.kind],
    vars: { used: reached.usedText, limit: reached.limitText },
  });
}
const REACHED_KEYS: Record<SpendLimitKind, ServerKey> = {
  'daily-tokens': 'spend.reached.dailyTokens',
  'monthly-tokens': 'spend.reached.monthlyTokens',
  'daily-cost': 'spend.reached.dailyCost',
  'monthly-cost': 'spend.reached.monthlyCost',
  'project-monthly-tokens': 'spend.reached.projectMonthlyTokens',
  'project-monthly-cost': 'spend.reached.projectMonthlyCost',
};

/**
 * Refuses a new model call when a limit is reached. `projectId` null: a detached conversation,
 * checked against the global limits only. Runs in progress are never stopped by a limit.
 */
export function assertWithinLimits(store: Store, projectId: string | null, now = new Date()) {
  if (!store.getSettings()?.spendLimits?.enabled) return;
  const report = usageReport(store, projectId ?? undefined, now);
  if (report.reached.length) throw spendLimitError(report);
}

/** True for the error above (the queue pauses with reason 'limit'). */
export const isSpendLimitError = (e: unknown) => (e as { code?: unknown } | null)?.code === SPEND_LIMIT_CODE;
