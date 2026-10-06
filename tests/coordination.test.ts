import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '../shared/contracts.js';
import {
  boundedCoordinatorContext,
  graphifyPaths,
  isSimpleInspectionRequest,
  parseTaskPlan,
  resolveAgent,
} from '../server/coordination.js';

describe('delegated task contracts', () => {
  it('accepts bounded task plans with forward dependencies', () => {
    expect(
      parseTaskPlan(
        JSON.stringify({
          tasks: [
            {
              id: 'later',
              title: 'Second',
              instructions: 'Use the first result',
              scope: ['src/b.ts'],
              dependsOn: ['first'],
            },
            {
              id: 'first',
              title: 'First',
              instructions: 'Inspect the implementation',
              scope: ['src/a.ts'],
              dependsOn: [],
            },
          ],
        }),
      ),
    ).toHaveLength(2);
  });

  it('rejects cycles and plans that exceed the task limit', () => {
    expect(() =>
      parseTaskPlan(
        JSON.stringify({
          tasks: [
            { id: 'a', title: 'A', instructions: 'A', scope: [], dependsOn: ['b'] },
            { id: 'b', title: 'B', instructions: 'B', scope: [], dependsOn: ['a'] },
          ],
        }),
      ),
    ).toThrow(/cíclicas/);
    expect(() =>
      parseTaskPlan(
        JSON.stringify({
          tasks: Array.from({ length: 7 }, (_, i) => ({
            id: `t${i}`,
            title: 'T',
            instructions: 'Do it',
            scope: [],
            dependsOn: [],
          })),
        }),
      ),
    ).toThrow(/1 a 6/);
  });

  it('bounds root context and labels the project map as paths only', () => {
    const context = boundedCoordinatorContext(
      [{ role: 'user', content: 'old'.repeat(2000) }],
      'current',
      null,
      ['src/a.ts'],
      900,
    );
    expect(context.length).toBeLessThanOrEqual(900);
    expect(context).toContain('Mapa de caminhos (índice, não conteúdo)');
  });

  it('preserves the session provider when inheriting a Luna model', () => {
    const providers = [
      {
        id: 'codex',
        name: 'Codex',
        installed: true,
        available: true,
        status: 'ready' as const,
        detail: '',
        models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }],
        capabilities: { fast: true, tools: true, approvals: true, cancel: true },
      },
      {
        id: 'kiro',
        name: 'Kiro',
        installed: true,
        available: true,
        status: 'ready' as const,
        detail: '',
        models: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
        capabilities: { fast: true, tools: true, approvals: true, cancel: true },
      },
    ] satisfies ProviderInfo[];
    expect(resolveAgent(providers, undefined, undefined, 'worker', 'kiro', 'session-model')).toEqual({
      providerId: 'kiro',
      model: 'gpt-5.6-luna',
    });
  });

  it('never truncates the current request to fit historical context budgets', () => {
    const current = `${'x'.repeat(7000)}END-OF-REQUEST`;
    const context = boundedCoordinatorContext(
      [{ role: 'user', content: 'history'.repeat(1000) }],
      current,
      null,
      ['src/a.ts'],
      1200,
    );
    expect(context).toContain('END-OF-REQUEST');
    expect(context.length).toBeGreaterThan(1200);
  });
  it('prefers GPT-6 over older Luna and Sol models regardless of catalog order', () => {
    const provider: ProviderInfo = {
      id: 'codex',
      name: 'Codex',
      installed: true,
      available: true,
      status: 'ready',
      detail: '',
      models: ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-sol'].map((id) => ({ id, name: id })),
      capabilities: { fast: true, tools: true, approvals: true, cancel: true },
    };
    expect(resolveAgent([provider], undefined, undefined, 'worker', 'codex').model).toBe('gpt-6-luna');
    expect(resolveAgent([provider], undefined, undefined, 'reviewer', 'codex').model).toBe('gpt-6-sol');
  });
  it('routes explicitly independent parts to the multi-step planner without promoting simple counts', () => {
    expect(
      isSimpleInspectionRequest(
        'Analise o código em duas partes independentes, sem alterar arquivos: (1) localize routeMessage; (2) verifique Graphify.',
      ),
    ).toBe(false);
    expect(
      isSimpleInspectionRequest(
        'Analyze the project in two independent parts: (1) locate routeMessage; (2) inspect Graphify.',
      ),
    ).toBe(false);
    expect(isSimpleInspectionRequest('Read two files')).toBe(false);
    expect(isSimpleInspectionRequest('Read four independent modules')).toBe(false);
    expect(isSimpleInspectionRequest('Read README and list two features')).toBe(true);
    expect(isSimpleInspectionRequest('Leia o README e liste dois recursos')).toBe(true);
  });
  it('keeps a single explicit filename on the simple inspection path', () => {
    expect(isSimpleInspectionRequest('Leia src/App.tsx')).toBe(true);
  });
  it('extracts only safe canonical Graphify source paths', () => {
    const graph =
      'NODE router.ts [src=server/router.ts loc=L1 community=]\nNODE routeMessage() [src=server/router.ts loc=L17 community=]';
    expect(graphifyPaths(graph)).toEqual(['server/router.ts']);
    expect(
      graphifyPaths(
        'NODE a [src=src/my file.ts loc=L1]\nNODE b [src=../secret.ts loc=L2]\nNODE c [src=/etc/passwd loc=L3]',
      ),
    ).toEqual(['src/my file.ts']);
  });
});
