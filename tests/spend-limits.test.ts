import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { UsageMeter, addUsage, applyUsage, assertWithinLimits, usageReport } from '../server/usage.js';
import type { Run, Session, UsageTotals } from '../shared/contracts.js';
import {
  dayBounds,
  hasCents,
  isReached,
  isWarning,
  limitInputText,
  limitReachedMessage,
  limitWarningMessage,
  monthBounds,
  parseLimitInput,
  spendLimitStatuses,
  unknownCostText,
} from '../shared/spend-limits.js';
import {
  CompactSchema,
  PatchProjectSchema,
  QueueResumeSchema,
  SendMessageSchema,
  SettingsPatchSchema,
  UsageQuerySchema,
  parseBody,
} from '../shared/schemas.js';
import { queuePauseLabel } from '../src/hooks/useMessageQueue.js';
import { usageLine } from '../src/components/SpendLimits.js';

const dirs: string[] = [];
const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const newStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-usage-'));
  dirs.push(dir);
  return new Store(dir);
};
const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  from: '',
  to: '',
  tokens: 0,
  costUsd: null,
  runs: 0,
  runsWithoutCost: 0,
  runsWithoutTokens: 0,
  ...over,
});
function seed(store: Store) {
  const now = new Date().toISOString();
  for (const id of ['p', 'q'])
    store.putProject({ id, name: id, path: '/tmp', createdAt: now, memoryWorkspace: 'w', memoryProject: id });
  const session = (id: string, projectId: string | null): Session => ({
    id,
    projectId,
    title: id,
    providerId: 'codex',
    mode: 'auto',
    createdAt: now,
    updatedAt: now,
  });
  store.putSession(session('sp', 'p'));
  store.putSession(session('sq', 'q'));
  store.putSession(session('sd', null));
  let n = 0;
  return (sessionId: string, startedAt: string, extra: Partial<Run> = {}) => {
    const run: Run = {
      id: `r${++n}`,
      sessionId,
      providerId: 'codex',
      status: 'completed',
      route: { level: 'fast', reason: 't', tools: false, memory: false, contextBudget: 0 },
      startedAt,
      ...extra,
    };
    store.putRun(run);
    return run;
  };
}

describe('periods in the local timezone', () => {
  it('a day starts at local midnight (São Paulo is UTC-3)', () => {
    process.env.TZ = 'America/Sao_Paulo';
    // 01:30 UTC on the 8th is still 22:30 of the 7th in São Paulo.
    expect(dayBounds(new Date('2026-10-08T01:30:00Z'))).toEqual({
      from: '2026-10-07T03:00:00.000Z',
      to: '2026-10-08T03:00:00.000Z',
    });
    expect(monthBounds(new Date('2026-11-01T02:00:00Z'))).toEqual({
      from: '2026-10-01T03:00:00.000Z',
      to: '2026-11-01T03:00:00.000Z',
    });
  });
  it('follows daylight saving changes (Berlin, 25 October 2026)', () => {
    process.env.TZ = 'Europe/Berlin';
    const day = dayBounds(new Date('2026-10-25T12:00:00Z'));
    expect(day).toEqual({ from: '2026-10-24T22:00:00.000Z', to: '2026-10-25T23:00:00.000Z' });
    expect(Date.parse(day.to) - Date.parse(day.from)).toBe(25 * 3600_000);
    expect(monthBounds(new Date('2026-12-31T23:30:00Z')).from).toBe('2026-12-31T23:00:00.000Z');
  });
});

describe('Store.usageTotals', () => {
  it('sums the runs started in each period, tasks and auxiliary runs included', () => {
    const store = newStore();
    const run = seed(store);
    const day = { from: '2026-10-07T03:00:00.000Z', to: '2026-10-08T03:00:00.000Z' };
    const month = { from: '2026-10-01T03:00:00.000Z', to: '2026-11-01T03:00:00.000Z' };
    run('sp', '2026-10-07T03:00:00.000Z', { inputTokens: 100, outputTokens: 10, costUsd: 0.25 }); // first instant of the day
    run('sp', '2026-10-07T12:00:00.000Z', { inputTokens: 1000, compaction: { auto: false } }); // manual compaction
    run('sd', '2026-10-07T13:00:00.000Z', { outputTokens: 5, handoff: { toProviderId: 'kiro' } }); // handoff summary
    run('sq', '2026-10-08T02:59:59.999Z', { inputTokens: 1, outputTokens: 1, costUsd: 1.5 }); // last instant
    run('sq', '2026-10-08T03:00:00.000Z', { inputTokens: 7 }); // next day, same month
    run('sp', '2026-10-01T02:59:59.999Z', { inputTokens: 99_999, costUsd: 9 }); // September locally
    run('sp', '2026-10-07T14:00:00.000Z', { status: 'running' }); // running: no "unknown" counts yet
    const [today, inMonth] = store.usageTotals([day, month]);
    expect(today).toMatchObject({ tokens: 1117, costUsd: 1.75, runs: 5, runsWithoutCost: 2, runsWithoutTokens: 0 });
    expect(inMonth).toMatchObject({ tokens: 1124, runs: 6, runsWithoutCost: 3 });
    expect(inMonth.costUsd).toBeCloseTo(1.75);
    const [projectToday] = store.usageTotals([day], 'p');
    expect(projectToday).toMatchObject({ tokens: 1110, costUsd: 0.25, runs: 3 });
    expect(store.usageTotals([day], 'missing')[0]).toMatchObject({ tokens: 0, costUsd: null, runs: 0 });
    expect(store.usageTotals([])).toEqual([]);
  });
  it('reports unknown cost as null and counts runs without cost or tokens', () => {
    const store = newStore();
    const run = seed(store);
    run('sp', '2026-10-07T10:00:00.000Z', { inputTokens: 4606, outputTokens: 5 });
    run('sp', '2026-10-07T11:00:00.000Z', { status: 'failed' });
    const [t] = store.usageTotals([{ from: '2026-10-07T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' }]);
    expect(t).toMatchObject({ tokens: 4611, costUsd: null, runs: 2, runsWithoutCost: 2, runsWithoutTokens: 1 });
  });
  it('stays fast over thousands of runs', () => {
    const store = newStore();
    const run = seed(store);
    store.db.exec('BEGIN');
    for (let i = 0; i < 5000; i++)
      run(i % 2 ? 'sp' : 'sq', new Date(Date.parse('2026-10-01T05:00:00Z') + i * 60_000).toISOString(), {
        inputTokens: 10,
        outputTokens: 1,
      });
    store.db.exec('COMMIT');
    const started = performance.now();
    const [m] = store.usageTotals([{ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }], 'p');
    expect(m.tokens).toBe(2500 * 11);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('limit statuses and messages', () => {
  const usage = {
    today: totals({ tokens: 850, costUsd: 1 }),
    month: totals({ tokens: 2000, costUsd: null }),
    projectMonth: totals({ tokens: 500, costUsd: 3 }),
  };
  it('lists only configured limits, and nothing while off', () => {
    expect(spendLimitStatuses(undefined, undefined, usage)).toEqual([]);
    expect(spendLimitStatuses({ enabled: false, dailyTokens: 1 }, undefined, usage)).toEqual([]);
    const list = spendLimitStatuses(
      { enabled: true, dailyTokens: 1000, monthlyCostUsd: 5, dailyCostUsd: 0 },
      { monthlyTokens: 400, monthlyCostUsd: 10 },
      usage,
    );
    expect(list.map((s) => [s.kind, s.used, s.percent])).toEqual([
      ['daily-tokens', 850, 85],
      ['daily-cost', 1, 100],
      ['monthly-cost', 0, 0], // unknown cost counts as nothing toward a cost limit, never as a value
      ['project-monthly-tokens', 500, 125],
      ['project-monthly-cost', 3, 30],
    ]);
    expect(list.filter(isWarning).map((s) => s.kind)).toEqual(['daily-tokens', 'daily-cost', 'project-monthly-tokens']);
    expect(list.filter(isReached).map((s) => s.kind)).toEqual(['daily-cost', 'project-monthly-tokens']);
    // Without a project in scope the project limits are not evaluated.
    expect(
      spendLimitStatuses({ enabled: true }, { monthlyTokens: 1 }, { today: usage.today, month: usage.month }),
    ).toEqual([]);
  });
  it('warns from exactly 80%', () => {
    const [at80] = spendLimitStatuses({ enabled: true, dailyTokens: 1000 }, undefined, {
      ...usage,
      today: totals({ tokens: 800 }),
    });
    const [below] = spendLimitStatuses({ enabled: true, dailyTokens: 1000 }, undefined, {
      ...usage,
      today: totals({ tokens: 799 }),
    });
    expect([isWarning(at80), isReached(at80), isWarning(below)]).toEqual([true, false, false]);
    expect(limitWarningMessage(at80)).toBe('Uso em 80% do limite de tokens hoje (800/1.000).');
  });
  it('formats the refusal and the reached banner', () => {
    const [s] = spendLimitStatuses({ enabled: true, monthlyTokens: 1_000_000 }, undefined, {
      ...usage,
      month: totals({ tokens: 1_250_000 }),
    });
    expect(limitReachedMessage(s)).toBe(
      "Limite de uso atingido: tokens no mês (1.250.000/1.000.000). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
    );
    expect(limitWarningMessage(s)).toMatch(/^Limite de tokens no mês atingido/);
    const [cost] = spendLimitStatuses({ enabled: true, dailyCostUsd: 2 }, undefined, usage);
    expect([cost.usedText, cost.limitText]).toEqual(['US$ 1.00', 'US$ 2.00']);
  });
  it('describes unknown costs', () => {
    expect(unknownCostText(0)).toBe('');
    expect(unknownCostText(1)).toBe('custo não informado em 1 execução');
    expect(unknownCostText(3)).toBe('custo não informado em 3 execuções');
    expect(usageLine(totals({ tokens: 1250, costUsd: 0.4, runs: 3, runsWithoutCost: 2 }))).toBe(
      '1.250 tokens · US$ 0.40 · 3 execuções · custo não informado em 2 execuções',
    );
    expect(usageLine(totals({ tokens: 5, runs: 1, runsWithoutCost: 1 }))).toBe(
      '5 tokens · custo não informado · 1 execução',
    );
    expect(usageLine(totals({ tokens: 5, runs: 3, runsWithoutCost: 2 }))).toContain('custo não informado em 2');
  });
  it('parses and shows the Settings inputs', () => {
    expect(parseLimitInput('', 'tokens')).toBeNull();
    expect(parseLimitInput('1.000.000', 'tokens')).toBe(1_000_000);
    expect(parseLimitInput('2500', 'tokens')).toBe(2500);
    expect(parseLimitInput('1,5', 'tokens')).toBeUndefined();
    expect(parseLimitInput('-1', 'tokens')).toBeUndefined();
    expect(parseLimitInput('5,25', 'cost')).toBe(5.25);
    expect(parseLimitInput('5.5', 'cost')).toBe(5.5);
    expect(parseLimitInput('5,255', 'cost')).toBeUndefined();
    expect(parseLimitInput('9999999', 'cost')).toBeUndefined();
    expect(limitInputText(undefined, 'cost')).toBe('');
    expect(limitInputText(5.5, 'cost')).toBe('5,50');
    expect(limitInputText(10, 'tokens')).toBe('10');
    // Binary floating point noise (0.1 + 0.2) still counts as two decimals.
    expect([hasCents(0.1 + 0.2), hasCents(1.005), hasCents(19.99)]).toEqual([true, false, true]);
  });
  it('labels a queue paused by a limit', () => {
    expect(
      queuePauseLabel({ sessionId: 's', items: [], paused: { reason: 'limit', at: '', error: 'Limite de uso…' } }),
    ).toBe('Limite de uso…');
    expect(queuePauseLabel({ sessionId: 's', items: [], paused: { reason: 'limit', at: '' } })).toBe(
      'Limite de uso atingido.',
    );
  });
});

describe('UsageMeter', () => {
  it('keeps the usage of failed attempts and lets the last event of an attempt win', () => {
    const meter = new UsageMeter();
    expect(meter.totals()).toEqual({ inputTokens: undefined, outputTokens: undefined, costUsd: undefined });
    meter.attempt();
    meter.event({ inputTokens: 10 });
    meter.event({ inputTokens: 30, outputTokens: 2 }); // cumulative value of the same turn
    meter.attempt(); // retried after a failure
    meter.event({ inputTokens: 5 });
    meter.result({ inputTokens: 999, outputTokens: 1, costUsd: 0.5 });
    expect(meter.totals()).toEqual({ inputTokens: 35, outputTokens: 3, costUsd: 0.5 });
  });
  it('applies and adds usage without inventing zeros', () => {
    const run = { inputTokens: 1, costUsd: 2 } as Run;
    applyUsage(run, { inputTokens: 4 });
    expect(run).toEqual({ inputTokens: 4 });
    addUsage(run, { outputTokens: 2 });
    addUsage(run, {});
    expect(run).toEqual({ inputTokens: 4, outputTokens: 2 });
  });
});

describe('usageReport and assertWithinLimits', () => {
  it('reports today and the month, with the project scope and limits', () => {
    const store = newStore();
    const run = seed(store);
    const now = new Date('2026-10-07T15:00:00Z');
    process.env.TZ = 'UTC';
    run('sp', '2026-10-07T10:00:00.000Z', { inputTokens: 900, outputTokens: 0 });
    run('sq', '2026-10-02T10:00:00.000Z', { inputTokens: 500, costUsd: 1 });
    store.setSettings({ ...store.getSettings()!, spendLimits: { enabled: true, dailyTokens: 1000 } });
    store.putProject({ ...store.getProject('p')!, spendLimits: { monthlyTokens: 900 } });
    const report = usageReport(store, 'p', now);
    expect(report.today.tokens).toBe(900);
    expect(report.month).toMatchObject({ tokens: 1400, costUsd: 1 });
    expect(report.project).toMatchObject({ id: 'p', month: { tokens: 900 } });
    expect(report.limits).toEqual({
      enabled: true,
      global: { enabled: true, dailyTokens: 1000 },
      project: { monthlyTokens: 900 },
    });
    expect(report.warnings.map((w) => w.kind)).toEqual(['daily-tokens', 'project-monthly-tokens']);
    expect(report.reached.map((w) => w.kind)).toEqual(['project-monthly-tokens']);
    expect(() => assertWithinLimits(store, 'p', now)).toThrow(/tokens do projeto no mês \(900\/900\)/);
    // Another project and detached conversations only see the global limits.
    expect(() => assertWithinLimits(store, 'q', now)).not.toThrow();
    expect(() => assertWithinLimits(store, null, now)).not.toThrow();
    expect(usageReport(store, undefined, now).project).toBeUndefined();
    store.setSettings({ ...store.getSettings()!, spendLimits: { enabled: false, dailyTokens: 1 } });
    expect(() => assertWithinLimits(store, 'p', now)).not.toThrow();
    expect(usageReport(store, 'p', now).warnings).toEqual([]);
  });
});

describe('schemas', () => {
  const settings = (spendLimits: unknown) => parseBody(SettingsPatchSchema, { spendLimits }, 'x');
  it('accepts non-negative integers, cents and null to clear', () => {
    expect(settings({ enabled: true, dailyTokens: 0, monthlyTokens: null, dailyCostUsd: 1.25 })).toEqual({
      ok: true,
      data: expect.objectContaining({
        spendLimits: { enabled: true, dailyTokens: 0, monthlyTokens: null, dailyCostUsd: 1.25 },
      }),
    });
    for (const bad of [
      { dailyTokens: -1 },
      { dailyTokens: 1.5 },
      { dailyCostUsd: 1.234 },
      { dailyCostUsd: -0.01 },
      { enabled: 'sim' },
      { weekly: 1 },
      'x',
    ]) {
      const parsed = settings(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/^spendLimits inválido/);
    }
  });
  it('validates project limits, overrideLimit and the usage query', () => {
    expect(parseBody(PatchProjectSchema, { spendLimits: null }, 'x')).toMatchObject({ ok: true });
    expect(parseBody(PatchProjectSchema, { spendLimits: { monthlyCostUsd: 3.5 } }, 'x')).toMatchObject({ ok: true });
    expect(parseBody(PatchProjectSchema, { spendLimits: { dailyTokens: 3 } }, 'x')).toMatchObject({ ok: false });
    expect(parseBody(SendMessageSchema, { content: 'oi', overrideLimit: 'sim' }, 'x')).toEqual({
      ok: false,
      message: 'overrideLimit deve ser booleano',
    });
    expect(parseBody(QueueResumeSchema, { overrideLimit: true }, 'x')).toMatchObject({ ok: true });
    expect(parseBody(CompactSchema, { overrideLimit: true }, 'x')).toMatchObject({ ok: true });
    expect(parseBody(CompactSchema, { other: 1 }, 'x')).toMatchObject({ ok: false });
    expect(parseBody(UsageQuerySchema, { projectId: '' }, 'x')).toMatchObject({ ok: false });
  });
});
