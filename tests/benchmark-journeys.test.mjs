import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertUnreplayed,
  applyProfileVerification,
  checkoutChanges,
  collectExecutedTaskIds,
  continuationBudget,
  estimateCost,
  executeAttemptSchedule,
  grade,
  isJourneyTimeout,
  maxAttemptsFor,
  MODEL,
  observedProfileStatus,
  observedProviderCall,
  parseArgs,
  rolesForExecutedTasks,
  readCostRates,
  selectedJourneyTasks,
  summarize,
} from '../scripts/benchmark-journeys.mjs';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-journey-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('general journey evaluation integrity', () => {
  it('isolates a failed attempt and keeps the alternating paired order', async () => {
    const calls = [];
    const result = await executeAttemptSchedule(['a', 'b', 'c'], async (journey, profile) => {
      calls.push(`${journey}/${profile}`);
      if (journey === 'a' && profile === 'direct') throw new Error('isolated setup failure');
      return { journey, profile, outcome: 'completed', accepted: false };
    });
    expect(calls).toEqual(['a/direct', 'a/coordinated', 'b/coordinated', 'b/direct', 'c/direct', 'c/coordinated']);
    expect(result[0]).toMatchObject({ outcome: 'runner_error', accepted: false, failure: 'isolated setup failure' });
    expect(result).toHaveLength(6);
  });

  it('selects one original paired journey while keeping the default cap at twelve', async () => {
    expect(parseArgs(['--run'])).toMatchObject({ mode: 'run', journey: null });
    expect(parseArgs(['--run', '--journey', 'continuation'])).toMatchObject({ mode: 'run', journey: 'continuation' });
    expect(selectedJourneyTasks()).toHaveLength(6);
    expect(selectedJourneyTasks('continuation').map((task) => task.id)).toEqual(['continuation']);
    expect(maxAttemptsFor()).toBe(12);
    expect(maxAttemptsFor('continuation')).toBe(2);
    expect(() => parseArgs(['--journey', 'not-a-journey'])).toThrow(/Unknown journey/);
    const scheduled = [];
    await executeAttemptSchedule([{ id: 'continuation', scheduleIndex: 3 }], async (task, profile) => {
      scheduled.push(`${task.id}/${profile}`);
      return { outcome: 'completed' };
    });
    expect(scheduled).toEqual(['continuation/coordinated', 'continuation/direct']);
  });

  it('preserves unknown costs and only estimates from explicit caller rates', () => {
    expect(readCostRates({})).toBeNull();
    expect(estimateCost(null, 200, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 })).toBeNull();
    const rates = readCostRates({
      ADELIC_JOURNEY_INPUT_USD_PER_MILLION: '1.25',
      ADELIC_JOURNEY_OUTPUT_USD_PER_MILLION: '4',
    });
    expect(estimateCost(1_000_000, 500_000, rates)).toBe(3.25);
    expect(() => readCostRates({ ADELIC_JOURNEY_INPUT_USD_PER_MILLION: '1' })).toThrow(/both explicit/);
  });

  it('shares the original continuation deadline and protects finalization reserve', () => {
    expect(continuationBudget(1_000, 1_000)).toMatchObject({ eligible: true, remainingMs: 180_000, workMs: 150_000 });
    expect(continuationBudget(1_000, 150_000)).toMatchObject({ eligible: true, remainingMs: 31_000, workMs: 1_000 });
    expect(continuationBudget(1_000, 151_000)).toMatchObject({ eligible: false, remainingMs: 30_000, workMs: 0 });
  });

  it('recognizes provider-reported timeout separately from a still-running local deadline', () => {
    expect(isJourneyTimeout({ timedOut: false, run: { status: 'failed', termination: 'timeout' } })).toBe(true);
    expect(isJourneyTimeout({ timedOut: false, run: { status: 'failed', termination: 'error' } })).toBe(false);
    expect(isJourneyTimeout({ timedOut: true, run: { status: 'running' } })).toBe(true);
  });

  it('blocks an attempt replay from the persistent append-only ledger', () => {
    const ledger = join(tempDir(), 'ledger.jsonl');
    expect(() => assertUnreplayed(ledger, 'attempt-1')).not.toThrow();
    writeFileSync(ledger, `${JSON.stringify({ event: 'attempt-start', attemptId: 'attempt-1' })}\n`);
    expect(() => assertUnreplayed(ledger, 'attempt-1')).toThrow(/Replay blocked/);
    expect(() => assertUnreplayed(ledger, 'attempt-2')).not.toThrow();
  });

  it('hashes externally observed modified, added, and removed files', () => {
    const workspace = tempDir();
    writeFileSync(join(workspace, 'changed.txt'), 'after');
    writeFileSync(join(workspace, 'new.txt'), 'new');
    const diff = checkoutChanges({
      path: workspace,
      baseline: new Map([
        ['changed.txt', 'before-hash'],
        ['deleted.txt', 'deleted-hash'],
      ]),
    });
    expect(diff.changes).toEqual([
      expect.objectContaining({ path: 'changed.txt', status: 'modified' }),
      expect.objectContaining({ path: 'deleted.txt', status: 'deleted' }),
      expect.objectContaining({ path: 'new.txt', status: 'added' }),
    ]);
    expect(diff.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('grades fixed facts from files outside the workspace and rejects agent self-report only', async () => {
    const workspace = tempDir();
    cpSync(new URL('../scripts/fixtures/general-journeys/inspection/starter', import.meta.url), workspace, {
      recursive: true,
    });
    expect(spawnSync('git', ['init', '-q'], { cwd: workspace }).status).toBe(0);
    mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true });
    expect((await grade({ id: 'inspection' }, workspace)).accepted).toBe(false);
    writeFileSync(
      join(workspace, 'findings.json'),
      JSON.stringify({
        percentageAfterSubtotal: true,
        maximumDiscountPercent: 25,
        negativeSubtotalReturnsZero: true,
      }),
    );
    expect(await grade({ id: 'inspection' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });
    writeFileSync(join(workspace, 'src/discount.js'), 'export const corrupted = true;\n');
    expect((await grade({ id: 'inspection' }, workspace)).accepted).toBe(false);
  });

  it('grades cross-area behavior through the handler entry point and rejects bypassing normalization', async () => {
    const workspace = tempDir();
    const src = join(workspace, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(src, 'query.js'),
      'export function normalizeQuery(query) { return { ...query, pageSize: Math.max(1, Math.min(50, query.pageSize ?? 20)) }; }\n',
    );
    writeFileSync(
      join(src, 'handler.js'),
      "import { normalizeQuery } from './query.js';\nexport function handle(query) { return { pageSize: normalizeQuery(query).pageSize }; }\n",
    );
    expect(await grade({ id: 'multi-area' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });

    mkdirSync(join(workspace, 'tests'), { recursive: true });
    writeFileSync(join(workspace, 'tests/query.test.js'), 'export const exists = true;\n');
    writeFileSync(join(workspace, 'tests/handler.test.js'), 'export const exists = true;\n');
    writeFileSync(join(workspace, 'README.md'), 'Implementation notes.\n');
    expect(await grade({ id: 'multi-area' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });

    writeFileSync(join(workspace, 'package.json'), '{"type":"module","dependencies":{"new-package":"1.0.0"}}\n');
    expect((await grade({ id: 'multi-area' }, workspace)).checks.dependenciesUnchanged).toBe(false);
    writeFileSync(join(workspace, 'package.json'), '{"type":"module"}\n');

    writeFileSync(
      join(src, 'handler.js'),
      'export function handle(query) { return { pageSize: query.pageSize ?? 20 }; }\n',
    );
    expect((await grade({ id: 'multi-area' }, workspace)).accepted).toBe(false);
  });

  it('allows continuation tests and other files while preserving version and public behavior', async () => {
    const workspace = tempDir();
    cpSync(new URL('../scripts/fixtures/general-journeys/continuation/starter', import.meta.url), workspace, {
      recursive: true,
    });
    writeFileSync(
      join(workspace, 'src/stats.js'),
      'export const version = 1;\nexport function summarize(values) { const count = values.length; const sum = values.reduce((a, b) => a + b, 0); return { count, sum, mean: count ? sum / count : null }; }\nexport function median(values) { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }\n',
    );
    expect(await grade({ id: 'continuation' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });

    mkdirSync(join(workspace, 'tests'), { recursive: true });
    writeFileSync(join(workspace, 'tests/stats.test.js'), 'export const smokeTest = true;\n');
    writeFileSync(join(workspace, 'README.md'), 'Implementation notes.\n');
    expect(await grade({ id: 'continuation' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });

    writeFileSync(
      join(workspace, 'src/stats.js'),
      'export const version = 0;\nexport function summarize(values) { const count = values.length; const sum = values.reduce((a, b) => a + b, 0); return { count, sum, mean: count ? sum / count : null }; }\nexport function median(values) { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }\n',
    );
    expect((await grade({ id: 'continuation' }, workspace)).checks.versionPreserved).toBe(false);
  });

  it('runs the supplied regression test against the public function and rejects the original bug', async () => {
    const workspace = tempDir();
    cpSync(new URL('../scripts/fixtures/general-journeys/bug-regression/starter', import.meta.url), workspace, {
      recursive: true,
    });
    writeFileSync(
      join(workspace, 'src/tags.test.js'),
      `import assert from 'node:assert/strict';\nexport function runRegressionTests(countTags) {\n  assert.deepEqual(countTags([' Bug ', 'bug', 'FEATURE']), { bug: 2, feature: 1 });\n  return true;\n}\n`,
    );
    const baseline = await grade({ id: 'bug-regression' }, workspace);
    expect(baseline).toMatchObject({ accepted: false, outcome: 'failed' });
    expect(baseline.detail).toMatch(/deep-equal/);

    writeFileSync(
      join(workspace, 'src/tags.js'),
      `export function countTags(tags) {\n  const counts = {};\n  for (const tag of tags) { const normalized = tag.trim().toLowerCase(); counts[normalized] = (counts[normalized] ?? 0) + 1; }\n  return counts;\n}\n`,
    );
    expect(await grade({ id: 'bug-regression' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });

    writeFileSync(
      join(workspace, 'src/tags.test.js'),
      `import assert from 'node:assert/strict';\nexport function runRegressionTests(countTags) {\n  assert.deepEqual(countTags([' Dog ', 'FEATURE']), { dog: 1, feature: 1 });\n  return true;\n}\n`,
    );
    expect(await grade({ id: 'bug-regression' }, workspace)).toMatchObject({ accepted: true, outcome: 'passed' });

    writeFileSync(join(workspace, 'src/tags.test.js'), 'export function runRegressionTests() { return true; }\n');
    expect(await grade({ id: 'bug-regression' }, workspace)).toMatchObject({
      accepted: false,
      checks: { externalBehaviorMatrix: true, regressionTestPassed: false },
    });
  });

  it('derives role evidence only from executed task IDs and keeps missing evidence unknown', () => {
    expect(
      collectExecutedTaskIds([
        {
          providerAttemptDetails: [{ taskId: 'executed-task' }, { taskId: null }],
          providerTaskIds: ['trace-task'],
        },
      ]),
    ).toEqual(new Set(['executed-task', 'trace-task']));
    expect(
      rolesForExecutedTasks(
        {
          tasks: [
            { id: 'executed-task', role: 'worker', providerId: 'codex', model: MODEL, effort: 'high' },
            { id: 'placeholder', role: 'reviewer', providerId: 'codex', model: null, effort: null },
          ],
        },
        new Set(['executed-task']),
      ),
    ).toEqual([{ taskId: 'executed-task', role: 'worker', providerId: 'codex', model: MODEL, effort: 'high' }]);
    expect(observedProviderCall(0, null)).toBe(false);
    expect(observedProviderCall(null, null)).toBeNull();
    expect(observedProviderCall(null, 1)).toBe(true);
    expect(observedProfileStatus(true, [true, null], [true, null])).toBe('unknown');
  });

  it('keeps profile unknown distinct from mismatch and preserves timeout as the primary outcome', () => {
    const attempt = { outcome: 'timeout', failure: 'budget deadline reached' };
    applyProfileVerification(attempt, {
      configuredVerified: true,
      observedModelVerified: null,
      observedEffortVerified: null,
    });
    expect(attempt).toMatchObject({
      outcome: 'timeout',
      profileVerification: { status: 'unknown', verified: false },
    });
    expect(attempt.failure).toMatch(/incomplete/);
    expect(observedProfileStatus(true, [false], [true])).toBe('mismatch');
    expect(observedProfileStatus(true, [true], [true])).toBe('verified');
  });

  it('grades diagnosis cause and permits an installation recommendation without performing it', async () => {
    const workspace = tempDir();
    cpSync(new URL('../scripts/fixtures/general-journeys/missing-runtime/starter', import.meta.url), workspace, {
      recursive: true,
    });
    writeFileSync(
      join(workspace, 'diagnosis.json'),
      JSON.stringify({
        cause: 'missing-runtime',
        executable: 'journey-missing-compiler',
        probeFoundOnPath: false,
        checkPassed: false,
        recovery: {
          requiresInstallation: true,
          checkPassed: false,
          nextStep: 'Request the approved runtime through the normal setup process.',
        },
      }),
    );
    expect(await grade({ id: 'missing-runtime' }, workspace)).toMatchObject({
      accepted: true,
      checks: { probeExecution: expect.stringMatching(/unknown/i) },
    });
  });

  it('summarizes acceptance before comparing paired timings and avoids small-sample percentiles', () => {
    const result = summarize([
      {
        journey: 'inspection',
        profile: 'direct',
        accepted: true,
        wallTimeMs: 100,
        repairAttempts: null,
        outcome: 'completed',
      },
      {
        journey: 'inspection',
        profile: 'coordinated',
        accepted: false,
        wallTimeMs: 300,
        repairAttempts: null,
        outcome: 'timeout',
      },
    ]);
    expect(result.profileStats.direct).toMatchObject({
      externallyAccepted: 1,
      medianWallTimeMs: 100,
      attemptsWithUnknownRepairCount: 1,
    });
    expect(result.pairs[0]).toMatchObject({
      directAccepted: true,
      coordinatedAccepted: false,
      directMs: 100,
      coordinatedMs: 300,
    });
    expect(result).not.toHaveProperty('p95');
  });
});
