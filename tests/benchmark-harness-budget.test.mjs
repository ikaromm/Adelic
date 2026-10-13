import { describe, expect, it } from 'vitest';
import {
  createJourneyClock,
  remainingJourneyBudget,
  requestBudget,
  runRegressionSchedule,
} from '../scripts/benchmark-harness.mjs';

function setupHarness(now, id) {
  return { harness: id, threadId: id === 'native' ? 'thread-1' : null, journeyClock: createJourneyClock(now) };
}

describe('benchmark harness per-harness active-time budget', () => {
  it('keeps interleaved journeys independent, excludes grading, and records external wait in JSON results', async () => {
    let now = 0;
    const contexts = new Map([
      ['adelic', setupHarness(() => now, 'adelic')],
      ['native', setupHarness(() => now, 'native')],
    ]);
    const starts = [];
    const results = await runRegressionSchedule(['adelic', 'native'], contexts, {
      runTurn: async (harness, context, turnIndex, budget) => {
        starts.push(`${harness}/${turnIndex}`);
        expect(budget.turnWorkTimeoutMs).toBe(60_000);
        expect(budget.totalMs).toBe(turnIndex === 0 ? 120_000 : harness === 'adelic' ? 80_000 : 90_000);
        now += harness === 'adelic' ? 40_000 : 30_000;
        return { outcome: 'completed', terminalStateConfirmed: true, failures: [], extra: {} };
      },
      evaluateTurn: async (run) => {
        // Grading can be slow, but is outside both model-work budgets.
        now += 90_000;
        run.testResult = { outcome: 'passed' };
        return run;
      },
    });
    expect(starts).toEqual(['adelic/0', 'native/0', 'native/1', 'adelic/1']);
    const serialized = JSON.parse(JSON.stringify(results));
    expect(serialized).toHaveLength(4);
    expect(serialized.map((item) => item.extra.journeyBudgetElapsedMs)).toEqual([40_000, 30_000, 60_000, 80_000]);
    expect(serialized[2].extra.journeyBudgetRemainingAtSubmissionMs).toBe(90_000);
    expect(serialized[3].extra.journeyBudgetRemainingAtSubmissionMs).toBe(80_000);
    expect(serialized[3].extra.journeyExternalWaitMs).toBeGreaterThan(0);
    expect(serialized.every((item) => item.testResult.outcome === 'passed')).toBe(true);
  });

  it('keeps the same independent budgets when the initial harness order is inverted', async () => {
    let now = 0;
    const contexts = new Map([
      ['native', setupHarness(() => now, 'native')],
      ['adelic', setupHarness(() => now, 'adelic')],
    ]);
    const starts = [];
    const results = await runRegressionSchedule(['native', 'adelic'], contexts, {
      runTurn: async (harness, _context, turnIndex, budget) => {
        starts.push(`${harness}/${turnIndex}`);
        expect(budget.turnWorkTimeoutMs).toBe(60_000);
        now += 25_000;
        return { outcome: 'completed', terminalStateConfirmed: true, failures: [], extra: {} };
      },
      evaluateTurn: async (run) => {
        now += 50_000;
        run.testResult = { outcome: 'passed' };
        return run;
      },
    });
    expect(starts).toEqual(['native/0', 'adelic/0', 'adelic/1', 'native/1']);
    expect(results.map((item) => item.extra.journeyBudgetRemainingAtSubmissionMs)).toEqual([
      120_000, 120_000, 95_000, 95_000,
    ]);
    expect(results.map((item) => item.extra.journeyBudgetElapsedMs)).toEqual([25_000, 25_000, 50_000, 50_000]);
  });

  it('gates a follow-up only when that harness spent its own active budget, not because the other harness or grading was slow', async () => {
    let now = 0;
    const contexts = new Map([
      ['adelic', setupHarness(() => now, 'adelic')],
      ['native', setupHarness(() => now, 'native')],
    ]);
    const called = [];
    const results = await runRegressionSchedule(['adelic', 'native'], contexts, {
      runTurn: async (harness, _context, turnIndex, budget) => {
        called.push(`${harness}/${turnIndex}`);
        expect(budget.turnWorkTimeoutMs).toBe(60_000);
        now += harness === 'adelic' ? 115_000 : 20_000;
        return { outcome: 'completed', terminalStateConfirmed: true, failures: [], extra: {} };
      },
      evaluateTurn: async (run) => {
        now += 200_000;
        run.testResult = { outcome: 'passed' };
        return run;
      },
    });
    expect(called).toEqual(['adelic/0', 'native/0', 'native/1']);
    const adelicFollowup = results.find((item) => item.harness === 'adelic' && item.turn === 'followup');
    expect(adelicFollowup.outcome).toBe('budget_gate');
    expect(adelicFollowup.degradation).toBe('budget_gate');
    expect(adelicFollowup.extra.journeyBudgetElapsedMs).toBe(115_000);
    expect(remainingJourneyBudget(contexts.get('adelic')).remainingMs).toBe(5_000);
    expect(requestBudget(contexts.get('native')).totalMs).toBe(80_000);
  });

  it('excludes each harness setup from its full journey budget and records setup overhead separately', async () => {
    let now = 0;
    const contexts = new Map([
      ['adelic', setupHarness(() => now, 'adelic')],
      ['native', setupHarness(() => now, 'native')],
    ]);
    // Setup both harnesses before the schedule; neither is active while this time passes.
    now += 35_000;
    contexts.get('adelic').setupOverheadMs = 20_000;
    contexts.get('native').setupOverheadMs = 15_000;
    const results = await runRegressionSchedule(['adelic', 'native'], contexts, {
      runTurn: async (_harness, _context, turnIndex, budget) => {
        expect(budget.totalMs).toBe(turnIndex === 0 ? 120_000 : 108_000);
        expect(budget.turnWorkTimeoutMs).toBe(60_000);
        now += 12_000;
        return { outcome: 'completed', terminalStateConfirmed: true, failures: [], extra: {} };
      },
      evaluateTurn: async (run) => {
        now += 5_000;
        run.testResult = { outcome: 'passed' };
        return run;
      },
    });

    expect(results.map((item) => item.extra.journeyBudgetElapsedMs)).toEqual([12_000, 12_000, 24_000, 24_000]);
    expect(results.slice(0, 2).map((item) => item.extra.setupOverheadMs)).toEqual([20_000, 15_000]);
    expect(results.slice(2).map((item) => item.extra.setupOverheadMs)).toEqual([0, 0]);
    expect(remainingJourneyBudget(contexts.get('adelic')).remainingMs).toBe(96_000);
    expect(remainingJourneyBudget(contexts.get('native')).remainingMs).toBe(96_000);
  });
});
