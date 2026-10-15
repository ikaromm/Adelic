import type { CheckEnvironmentEvidence, CheckSource } from '../shared/contracts.js';
import type { AfterEditCheck, CheckStatus } from '../shared/hooks.js';

export interface ObservedReviewCheck {
  eventId: string;
  name: string;
  command?: string;
  timeoutSec?: number;
  createdAt: string;
  status: CheckStatus;
  source?: CheckSource | null;
  environment?: CheckEnvironmentEvidence | null;
}

/** Configuration identity, not an agent-selectable check ID or proof of environment equivalence. */
function reviewCheckIdentity(check: Pick<AfterEditCheck, 'name' | 'command' | 'timeoutSec'>): string {
  return JSON.stringify([check.name, check.command, check.timeoutSec]);
}

function observedEnvironmentMatches(
  left: CheckEnvironmentEvidence | null | undefined,
  right: CheckEnvironmentEvidence | null | undefined,
): boolean {
  return Boolean(
    left?.state === 'observed' && right?.state === 'observed' && left.digest && left.digest === right.digest,
  );
}

function sourceMatches(left: CheckSource | null | undefined, right: CheckSource): boolean {
  return Boolean(
    left?.state === 'verified' &&
    right.state === 'verified' &&
    left.runId === right.runId &&
    left.root &&
    left.root === right.root &&
    left.scope === right.scope &&
    left.revision?.kind === 'source_tree' &&
    left.revision.value &&
    left.revision.value === right.revision?.value,
  );
}

/**
 * No reuse across roots or observed environments. Unknown newer observations in the current
 * cohort are barriers: they must not resurrect an older green result after a failed capture.
 * All enabled configured hooks are required; tool transcripts never create requirements.
 */
export function selectReviewChecks<T extends ObservedReviewCheck>(
  checks: readonly T[],
  required: readonly AfterEditCheck[],
  source: CheckSource,
  environment: CheckEnvironmentEvidence,
): { applicable: T[]; historical: T[]; pending: AfterEditCheck[] } {
  const applicable: T[] = [];
  const pending: AfterEditCheck[] = [];
  const selected = new Set<T>();
  const seen = new Set<string>();
  for (const requirement of required.filter((check) => check.enabled)) {
    const key = reviewCheckIdentity(requirement);
    if (seen.has(key)) continue;
    seen.add(key);
    let latest: T | undefined;
    for (const check of checks) {
      if (JSON.stringify([check.name, check.command, check.timeoutSec]) !== key) continue;
      // Proven foreign provenance is historical. Missing/changed provenance is not a pass.
      if (check.source?.root && check.source.root !== source.root) continue;
      if (check.source?.runId && check.source.runId !== source.runId) continue;
      if (
        check.source?.state === 'verified' &&
        source.state === 'verified' &&
        check.source.revision?.kind === 'source_tree' &&
        source.revision?.kind === 'source_tree' &&
        check.source.revision.value !== source.revision.value
      )
        continue;
      if (
        check.environment?.state === 'observed' &&
        environment.state === 'observed' &&
        check.environment.digest &&
        environment.digest &&
        check.environment.digest !== environment.digest
      )
        continue;
      if (!latest || Date.parse(check.createdAt) >= Date.parse(latest.createdAt)) latest = check;
    }
    if (latest && sourceMatches(latest.source, source) && observedEnvironmentMatches(latest.environment, environment)) {
      applicable.push(latest);
      selected.add(latest);
      if (latest.status === 'running' || latest.status === 'error' || latest.status === 'cancelled')
        pending.push(requirement);
    } else pending.push(requirement);
  }
  return { applicable, historical: checks.filter((check) => !selected.has(check)), pending };
}
