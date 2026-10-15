import { describe, expect, it } from 'vitest';
import { selectReviewChecks, type ObservedReviewCheck } from '../server/review-checks.js';
import type { CheckSource } from '../shared/contracts.js';

const source: CheckSource = {
  runId: 'run',
  root: '/project',
  state: 'verified',
  scope: 'filesystem-except-.git-and-node_modules',
  revision: { kind: 'source_tree', value: 'current' },
};
const environment = { state: 'observed' as const, digest: 'current-environment' };
const hook = { name: 'test', command: 'run-tests', timeoutSec: 10, enabled: true };
function check(overrides: Partial<ObservedReviewCheck> = {}): ObservedReviewCheck {
  return {
    eventId: 'green',
    name: hook.name,
    command: hook.command,
    timeoutSec: hook.timeoutSec,
    createdAt: '2026-10-15T00:00:01Z',
    status: 'passed',
    source,
    environment,
    ...overrides,
  };
}

describe('review check applicability', () => {
  it('keeps red history but selects the current green result', () => {
    const red = check({
      eventId: 'red',
      status: 'failed',
      createdAt: '2026-10-15T00:00:00Z',
      source: { ...source, revision: { kind: 'source_tree', value: 'before-fix' } },
    });
    const green = check();
    expect(selectReviewChecks([red, green], [hook], source, environment)).toEqual({
      applicable: [green],
      historical: [red],
      pending: [],
    });
  });

  it.each(['root', 'revision', 'environment'] as const)(
    'does not let a newer foreign %s green hide a current failure',
    (kind) => {
      const red = check({ eventId: 'red', status: 'failed' });
      const foreign = check({
        eventId: 'foreign',
        createdAt: '2026-10-15T00:00:02Z',
        ...(kind === 'root'
          ? { source: { ...source, root: '/worktree' } }
          : kind === 'revision'
            ? { source: { ...source, revision: { kind: 'source_tree', value: 'foreign-revision' } } }
            : { environment: { ...environment, digest: 'foreign-environment' } }),
      });
      expect(selectReviewChecks([red, foreign], [hook], source, environment)).toEqual({
        applicable: [red],
        historical: [foreign],
        pending: [],
      });
    },
  );

  it.each(['unknown-source', 'changed-source', 'unknown-environment', 'changed-environment'])(
    'does not resurrect an old green after %s',
    (kind) => {
      const green = check();
      const invalid = check({
        eventId: 'invalid',
        createdAt: '2026-10-15T00:00:02Z',
        ...(kind.endsWith('source')
          ? { source: { ...source, state: kind.startsWith('unknown') ? 'unknown' : 'changed' } }
          : { environment: { state: kind.startsWith('unknown') ? 'unknown' : 'changed' } }),
      });
      expect(selectReviewChecks([green, invalid], [hook], source, environment)).toEqual({
        applicable: [],
        historical: [green, invalid],
        pending: [hook],
      });
    },
  );

  it('keeps a missing homonymous command required and ignores disabled hooks', () => {
    const green = check();
    const other = { ...hook, command: 'other-tests' };
    const disabled = { ...hook, name: 'disabled', enabled: false };
    expect(selectReviewChecks([green], [hook, other, disabled], source, environment)).toEqual({
      applicable: [green],
      historical: [],
      pending: [other],
    });
  });

  it('does not satisfy a stricter timeout with a homonymous check', () => {
    const green = check();
    const strict = { ...hook, timeoutSec: 5 };
    expect(selectReviewChecks([green], [hook, strict], source, environment)).toEqual({
      applicable: [green],
      historical: [],
      pending: [strict],
    });
    const legacy = check({ timeoutSec: undefined });
    expect(selectReviewChecks([legacy], [hook], source, environment).pending).toEqual([hook]);
  });

  it.each(['running', 'error', 'cancelled'] as const)('keeps a current %s requirement pending', (status) => {
    const incomplete = check({ status });
    const selection = selectReviewChecks([incomplete], [hook], source, environment);
    expect(selection.pending).toEqual([hook]);
    expect(selection.applicable).toEqual([incomplete]);
  });

  it('keeps a new invocation with incomplete environment as a barrier to an old green', () => {
    const green = check();
    const running = check({
      eventId: 'running',
      status: 'running',
      createdAt: '2026-10-15T00:00:02Z',
      environment: { state: 'unknown' },
    });
    expect(selectReviewChecks([green, running], [hook], source, environment)).toEqual({
      applicable: [],
      historical: [green, running],
      pending: [hook],
    });
  });

  it('does not infer requirements from observations or reuse worktree results', () => {
    const worktree = check({ source: { ...source, root: '/worktree' } });
    expect(selectReviewChecks([worktree], [], source, environment)).toEqual({
      applicable: [],
      historical: [worktree],
      pending: [],
    });
    expect(selectReviewChecks([worktree], [hook], source, environment).pending).toEqual([hook]);
  });
});
