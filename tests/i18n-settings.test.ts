import { describe, expect, it } from 'vitest';
import type { SpendLimitKind, SpendLimitStatus } from '../shared/contracts.js';
import { checkHeadline, type CheckResult } from '../shared/hooks.js';
import { MCP_MESSAGES, mcpFieldsError, mcpFieldsErrorKey } from '../shared/mcp.js';
import {
  passwordHintKeys,
  passwordHints,
  passwordProblemKeys,
  passwordProblems,
  usernameProblem,
  usernameProblemKey,
} from '../shared/remote-access.js';
import { limitWarningMessage, spendLimitLabels } from '../shared/spend-limits.js';
import { t } from '../src/i18n';
import { checkResultHeadline } from '../src/components/HooksCard';
import { limitWarningText, usageLine } from '../src/components/SpendLimits';

// Settings cards translated on the client while the shared modules keep the server's pt-BR text
// (docs/i18n.md): in pt-BR both must produce the same bytes, and English must differ.

describe('settings cards: client translations match the shared pt-BR text', () => {
  it('usage limit banner lines, for every kind, below and at the limit', () => {
    for (const kind of Object.keys(spendLimitLabels) as SpendLimitKind[]) {
      const cost = kind.endsWith('cost');
      for (const used of [cost ? 0.85 : 850_000, cost ? 1.25 : 1_250_000]) {
        const limit = cost ? 1 : 1_000_000;
        const status: SpendLimitStatus = {
          kind,
          label: spendLimitLabels[kind],
          used,
          limit,
          percent: Math.floor((used / limit) * 100),
          usedText: cost ? `US$ ${used.toFixed(2)}` : used.toLocaleString('pt-BR'),
          limitText: cost ? `US$ ${limit.toFixed(2)}` : limit.toLocaleString('pt-BR'),
        };
        expect(limitWarningText(status, 'pt-BR'), kind).toBe(limitWarningMessage(status));
        expect(limitWarningText(status, 'en'), kind).not.toBe(limitWarningMessage(status));
      }
    }
    const daily: SpendLimitStatus = {
      kind: 'daily-tokens',
      label: 'tokens hoje',
      used: 850_000,
      limit: 1_000_000,
      percent: 85,
      usedText: '850.000',
      limitText: '1.000.000',
    };
    expect(limitWarningText(daily, 'en')).toBe("Usage at 85% of today's token limit (850,000/1,000,000).");
  });

  it('usage summary line in English', () => {
    const totals = { from: '', to: '', tokens: 1250, costUsd: 0.4, runs: 3, runsWithoutCost: 2, runsWithoutTokens: 0 };
    expect(usageLine(totals, 'en')).toBe('1,250 tokens · $0.40 · 3 runs · cost not reported for 2 runs');
    expect(usageLine({ ...totals, costUsd: null, runs: 1, runsWithoutCost: 1 }, 'en')).toBe(
      '1,250 tokens · cost not reported · 1 run',
    );
    expect(usageLine({ ...totals, runs: 0, runsWithoutCost: 0 }, 'pt-BR')).toBe(
      '1.250 tokens · US$ 0.40 · 0 execuções',
    );
  });

  it('check result headlines', () => {
    const cases: CheckResult[] = [
      { name: 'testes', status: 'passed', durationMs: 12_000 },
      { name: 'testes', status: 'passed' },
      { name: 'testes', status: 'failed', exitCode: 1 },
      { name: 'testes', status: 'failed' },
      { name: 'testes', status: 'timeout', durationMs: 600_000 },
      { name: 'x', status: 'running' },
      { name: 'x', status: 'cancelled', detail: 'nova execução' },
      { name: 'x', status: 'cancelled' },
      { name: 'x', status: 'error', detail: 'sem bwrap' },
      { name: 'x', status: 'error' },
    ];
    for (const result of cases) expect(checkResultHeadline(result)).toBe(checkHeadline(result));
  });

  it('remote account rules: the key exports match the pt-BR texts', () => {
    for (const name of ['ab', 'Dono', 'dono', 'x'.repeat(65)]) {
      const key = usernameProblemKey(name);
      expect(key ? t(`remoteAccess.problem.${key}`, { min: 3, max: 64 }, 'pt-BR') : undefined).toBe(
        usernameProblem(name),
      );
    }
    for (const [user, password] of [
      ['dono', 'curta'],
      ['donodonodono', 'DonoDonoDono'],
      ['dono', 'x'.repeat(300)],
    ]) {
      expect(
        passwordProblemKeys(user, password).map((key) =>
          t(`remoteAccess.problem.${key}`, { min: 12, max: 256 }, 'pt-BR'),
        ),
      ).toEqual(passwordProblems(user, password));
    }
    for (const password of ['aaaaaaaaaaaa', '123senha', 'Uma frase longa, com 5 palavras!']) {
      const keys = passwordHintKeys(password);
      expect({
        score: keys.score,
        hints: keys.hints.map((key) => t(`remoteAccess.hint.${key}`, undefined, 'pt-BR')),
      }).toEqual(passwordHints(password));
    }
  });

  it('MCP form validation: the key export matches MCP_MESSAGES', () => {
    const fields = { name: 'docs', description: '', command: '/bin/x', args: [], env: [], tools: [] };
    expect(mcpFieldsErrorKey(fields)).toBe('');
    expect(mcpFieldsErrorKey({ ...fields, name: 'NO' })).toBe('name');
    expect(mcpFieldsError({ ...fields, name: 'NO' })).toBe(MCP_MESSAGES.name);
    const pt = (key: 'description' | 'args' | 'env' | 'tools', vars: Record<string, number>) =>
      t(`mcp.error.${key}`, vars, 'pt-BR');
    expect(pt('description', { max: 300 })).toBe(MCP_MESSAGES.description);
    expect(pt('args', { count: 20, max: 500 })).toBe(MCP_MESSAGES.args);
    expect(pt('env', { count: 20, max: 4096 })).toBe(MCP_MESSAGES.env);
    expect(pt('tools', { count: 100 })).toBe(MCP_MESSAGES.tools);
    for (const key of ['name', 'command', 'literal'] as const)
      expect(t(`mcp.error.${key}`, undefined, 'pt-BR')).toBe(MCP_MESSAGES[key]);
  });
});
