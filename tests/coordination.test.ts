import { describe, expect, it } from 'vitest';
import type { DelegatedTask, ProviderInfo } from '../shared/contracts.js';
import {
  boundedCoordinatorContext,
  canSkipCoordinationPlanner,
  graphifyPaths,
  latestChecksByIdentity,
  isSimpleInspectionRequest,
  minimalContinuationContext,
  parseTaskPlan,
  requiresResolvedContinuity,
  resolveAgent,
  summarizeReview,
  parseStructuredReview,
  isSafeReviewPath,
  decideReview,
  synthesisExecutionFacts,
} from '../server/coordination.js';

describe('delegated task contracts', () => {
  it("reports completed and blocked task evidence without the synthesis call's transient status", () => {
    const makeTask = (
      role: DelegatedTask['role'],
      status: DelegatedTask['status'],
      extras: Partial<DelegatedTask> = {},
    ): DelegatedTask => ({
      id: role,
      agentId: `${role}-agent`,
      projectId: 'project',
      sessionId: 'session',
      runId: 'run',
      role,
      title: role,
      instructions: 'task',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status,
      createdAt: '2026-10-09T00:00:00.000Z',
      ...extras,
    });
    const tasks = [
      makeTask('worker', 'completed', {
        integration: {
          status: 'blocked',
          cleanup: 'pending',
          reason: 'Conflict',
          recordedAt: '2026-10-09T00:00:01.000Z',
        },
        delivery: {
          status: 'partial',
          reason: 'Integração bloqueada; entrega não integrada',
          evidence: ['integration:blocked', 'recovery:workspace-retained'],
          recovery: { action: 'recover_worktree', reason: 'Inspecionar checkout' },
          recordedAt: '2026-10-09T00:00:01.000Z',
        },
      }),
      makeTask('reviewer', 'completed', { output: 'Revisão estática; typecheck não executado.' }),
      makeTask('worker', 'failed', { id: 'failed', error: 'verificação indisponível' }),
      makeTask('synthesis', 'running', { id: 'current-synthesis' }),
      makeTask('synthesis', 'completed', { id: 'previous-synthesis' }),
    ];
    const facts = JSON.parse(synthesisExecutionFacts(tasks)) as Record<string, unknown>[];
    expect(facts.map((fact) => fact.role)).toEqual(['worker', 'reviewer', 'worker']);
    expect(facts[0]).toMatchObject({
      process: { status: 'completed' },
      integration: { status: 'blocked', cleanup: 'pending', reason: 'Conflict' },
      delivery: {
        status: 'partial',
        reason: 'Integração bloqueada; entrega não integrada',
        evidence: ['integration:blocked', 'recovery:workspace-retained'],
        recovery: { action: 'recover_worktree', available: true },
      },
    });
    expect(facts[1]).toMatchObject({ process: { status: 'completed' } });
    expect(facts[2]).toMatchObject({ process: { status: 'failed', error: 'verificação indisponível' } });
    expect(JSON.stringify(facts)).not.toContain('synthesis');
  });
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

  it('repairs only a truncated JSON suffix while keeping plan validation strict', () => {
    const completeTasks = JSON.stringify({
      tasks: [
        { id: 'a', title: 'A', instructions: 'Do A', scope: ['a.ts'], dependsOn: [] },
        { id: 'b', title: 'B', instructions: 'Do B', scope: ['b.ts'], dependsOn: ['a'] },
      ],
    });
    expect(parseTaskPlan(completeTasks.slice(0, -2))).toHaveLength(2);
    expect(() => parseTaskPlan(completeTasks.slice(0, -30))).toThrow(/JSON|truncou/);
    expect(() => parseTaskPlan(completeTasks.replace('"id":"a"', '"id":"?"'))).toThrow(/ID inválido/);
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
  it('skips planning for bounded work while treating preservation as a constraint, not new work', () => {
    expect(canSkipCoordinationPlanner('Now keep the Blocked filter persistent.')).toBe(true);
    expect(canSkipCoordinationPlanner('Add a filter button to src/Tasks.tsx')).toBe(true);
    expect(
      canSkipCoordinationPlanner('Add a status filter to the task list, preserving existing dependency behavior.'),
    ).toBe(true);
    expect(canSkipCoordinationPlanner('Create a status filter and keep the current dependency rules unchanged.')).toBe(
      true,
    );
    expect(canSkipCoordinationPlanner('Add a status filter; maintain established dependency semantics.')).toBe(true);
    expect(canSkipCoordinationPlanner('Add a status filter without changing current dependency behavior.')).toBe(true);
    expect(canSkipCoordinationPlanner('Implement task dependencies across TypeScript, SQLite, and UI.')).toBe(false);
    expect(canSkipCoordinationPlanner('Add a button to the UI. Also migrate the database and change the API.')).toBe(
      false,
    );
    expect(canSkipCoordinationPlanner('Now implement it.')).toBe(true);
    expect(canSkipCoordinationPlanner('Continue: close the blockers and fix formatting.')).toBe(true);
    expect(canSkipCoordinationPlanner('Fechar os bloqueadores e corrigir a formatação.')).toBe(true);
    expect(canSkipCoordinationPlanner('Design a new architecture for the project')).toBe(false);
    expect(canSkipCoordinationPlanner('Now change the Architecture Across Multiple Modules in the project.')).toBe(
      false,
    );
    expect(
      canSkipCoordinationPlanner(
        'Change the architecture across multiple modules while preserving existing dependency behavior.',
      ),
    ).toBe(false);
  });
  it('resolves bounded continuation intent only from a matching recent user goal', () => {
    const longAssistant = 'assistant response '.repeat(200);
    const history = [
      {
        role: 'user',
        content: 'PREVIOUS_GOAL_RETENTION_RULE: implement retention policy of seven days in retention.ts',
      },
      { role: 'assistant', content: longAssistant },
    ];
    const current = 'Now implement it in retention.ts.';
    expect(requiresResolvedContinuity(current)).toBe(true);
    expect(minimalContinuationContext(history, current)).toContain(
      'PREVIOUS_GOAL_RETENTION_RULE: implement retention policy of seven days in retention.ts',
    );
    const chainedHistory = [
      ...history,
      { role: 'user', content: 'Now implement it in retention.ts.' },
      { role: 'assistant', content: longAssistant },
    ];
    const chained = minimalContinuationContext(chainedHistory, 'Now implement it in retention.ts.');
    expect(chained).toContain('seven days');
    expect(chained).toContain('retention.ts');
    expect(chained?.length).toBeLessThan(1300);
    expect(minimalContinuationContext(history, 'Now implement it in billing.ts.')).toBeUndefined();
    expect(
      minimalContinuationContext(
        [{ role: 'user', content: 'Migrate the database and change the API across multiple modules.' }],
        'Now implement it.',
      ),
    ).toBeUndefined();
    expect(minimalContinuationContext([], current)).toBeUndefined();
  });

  it('falls back when an intermediate refinement expands scope across work areas', () => {
    const history = [
      { role: 'user', content: 'Implement retention policy of seven days in retention.ts.' },
      { role: 'assistant', content: 'analysis '.repeat(500) },
      { role: 'user', content: 'Now also migrate storage and change the API.' },
    ];
    expect(minimalContinuationContext(history, 'Now implement it in retention.ts.')).toBeUndefined();
    expect(
      minimalContinuationContext(
        [{ role: 'user', content: 'Implement retention policy of seven days in retention.ts.' }],
        'Now also migrate storage and change the API.',
      ),
    ).toBeUndefined();
  });

  it('preserves refinement requirements beyond the former excerpt boundary', () => {
    const requirement =
      'Also ' +
      'keep the existing implementation stable '.repeat(5) +
      'retain failed records for seven days before cleanup.';
    const result = minimalContinuationContext(
      [
        { role: 'user', content: 'Implement retention policy in retention.ts.' },
        { role: 'assistant', content: 'intermediate response '.repeat(500) },
        { role: 'user', content: requirement },
      ],
      'Now implement it in retention.ts.',
    );
    expect(result).toContain(requirement);
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

  it('prioritizes every finding over lengthy reviewer commentary and preserves severity and location', () => {
    const review = [
      'I inspected the implementation. Long progress and background commentary '.repeat(80),
      '**1. P1 — Retry assumes a completed run was delivered**',
      'Local: server/orchestrator.ts: retryTask and TaskRecovery',
      'A completed coordinator run can hide failed worker delivery.',
      '**P1 — Task worktree inspection uses the wrong baseline**',
      'Local: server/worktrees.ts: inspectTaskWorktree',
      'Dirty baseline files are attributed to this task.',
      '**P2 — Retry tool events disappear from inspection**',
      'Local: server/http/tasks.ts: inspect endpoint',
      'Retry-associated events without taskId are omitted.',
    ].join('\n');
    const result = summarizeReview(review, 2400);
    expect(result.incomplete).toBe(true); // omitted preamble is reported as uncertain evidence
    expect(result.findings).toBe(3);
    for (const expected of ['P1', 'server/orchestrator.ts', 'server/worktrees.ts', 'P2', 'server/http/tasks.ts'])
      expect(result.text).toContain(expected);
    expect(result.text).not.toContain('Long progress and background commentary');
  });

  it('keeps useful unstructured review content and the exact raw source after context reduction', () => {
    const review = [
      'Defect: the first implementation path drops the retry result.',
      'Location: server/orchestrator.ts:3731',
      'The provider returned a valid finding without Markdown severity headings.',
      'Background details. '.repeat(180),
      'Additional source tail marker: RETAINED_RAW_TAIL',
    ].join('\n');
    expect(review.length).toBeGreaterThan(2400);

    const result = summarizeReview(review, 1600);
    expect(result.incomplete).toBe(true); // context was reduced, not provider response status
    expect(result.findings).toBe(0); // no approval/finding inference from keywords
    expect(result.text).toContain('Defect:');
    expect(result.text).toContain('server/orchestrator.ts:3731');
    expect(result.text).toContain('contexto reduzido');
    expect(result.text).toContain('RETAINED_RAW_TAIL');
  });

  it('keeps compact free-form review formats verbatim when they fit', () => {
    const review = 'Defeito — integração perde estado.\nLocalização: src/feature.ts:27\nImpacto: entrega parcial.';
    expect(summarizeReview(review, 500)).toEqual({
      text: review,
      incomplete: false,
      findings: 0,
    });
  });

  it('recognizes and preserves a high-severity heading with its location within budget', () => {
    const review = [
      '**Severidade: alta — Repetição de trabalho já entregue**',
      'Local: `store.ts:432`',
      'Uma tentativa anteriormente aplicada não impede repetir a tarefa.',
      '### [P2] Rótulo do botão',
      'Local: src/components/TaskRecovery.tsx:91',
      'O rótulo difere da API.',
    ].join('\n');

    const result = summarizeReview(review, 2000);
    expect(result.findings).toBe(2);
    expect(result.incomplete).toBe(false);
    for (const expected of [
      'Severidade: alta',
      'store.ts:432',
      'tentativa anteriormente aplicada',
      '[P2] Rótulo do botão',
      'TaskRecovery.tsx:91',
    ])
      expect(result.text).toContain(expected);
    expect(result.text).not.toContain('REVISÃO INCOMPLETA');
    expect(result.text.length).toBeLessThanOrEqual(2000);
  });

  it('preserves numbered bold P1 findings before a recognized P2 within review summaries', () => {
    const review = [
      '### 1. **[P1] Retry data loss**',
      'Local: server/orchestrator.ts',
      'This blocker needs careful investigation. '.repeat(10),
      '### 2. **[P1] Git retry duplicates work**',
      'Local: server/store.ts',
      'This blocker also needs careful investigation. '.repeat(10),
      '### [P2] Recovery events hidden',
      'Local: server/http/tasks.ts',
      'This issue needs follow-up. '.repeat(10),
    ].join('\n');

    const complete = summarizeReview(review, 2000);
    expect(complete.findings).toBe(3);
    expect(complete.incomplete).toBe(false);
    for (const expected of ['[P1] Retry data loss', '[P1] Git retry duplicates work', '[P2] Recovery events hidden'])
      expect(complete.text).toContain(expected);

    const limited = summarizeReview(review, 350);
    expect(limited.findings).toBe(3);
    expect(limited.incomplete).toBe(true);
    expect(limited.text).toContain('RESUMO REDUZIDO');
    for (const expected of ['[P1] Retry data loss', '[P1] Git retry duplicates work', '[P2] Recovery events hidden'])
      expect(limited.text).toContain(expected);
  });

  it('uses the available budget for a long high-severity prefix followed by a P2', () => {
    const prefix = [
      '**Severidade: alta — Retry de trabalho já entregue**',
      'Local: server/orchestrator.ts:1085',
      'Evidência prioritária: '.concat('x'.repeat(1150)),
    ].join('\n');
    const review = `${prefix}\n**P2 — Rótulo de recuperação**\nLocal: src/components/TaskRecovery.tsx:91\nTexto inconsistente.`;
    const result = summarizeReview(review, 2000);
    expect(review.length).toBeLessThan(2000);
    expect(result).toEqual({ text: review, incomplete: false, findings: 2 });
  });

  it('keeps a fully fitting review and unequal finding blocks without fixed allocations', () => {
    const review = [
      '**P1 — Curto**',
      'Local: server/orchestrator.ts:10',
      '**P2 — Longo**',
      'Local: server/store.ts:20',
      'Detalhe longo. '.repeat(60),
      '**P3 — Muito curto**',
      'Local: tests/retry.test.ts:30',
    ].join('\n');
    const result = summarizeReview(review, 2000);
    expect(review.length).toBeLessThan(2000);
    expect(result).toEqual({
      text: [
        '**P1 — Curto**',
        'Local: server/orchestrator.ts:10',
        '**P2 — Longo**',
        'Local: server/store.ts:20',
        'Detalhe longo. '.repeat(60).trimEnd(),
        '**P3 — Muito curto**',
        'Local: tests/retry.test.ts:30',
      ].join('\n'),
      incomplete: false,
      findings: 3,
    });
  });

  it('preserves finding anchors and signals actual truncation at the budget boundary', () => {
    const review = [
      '**P1 — Primeiro**',
      'Local: server/orchestrator.ts:10',
      'Detalhe. '.repeat(100),
      '**P2 — Segundo**',
      'Local: server/store.ts:20',
      'Detalhe. '.repeat(100),
    ].join('\n');
    const result = summarizeReview(review, 350);
    expect(result.text.length).toBeLessThanOrEqual(350);
    expect(result.incomplete).toBe(true);
    expect(result.text).toContain('P1');
    expect(result.text).toContain('P2');
    expect(result.text).toContain('server/orchestrator.ts');
    expect(result.text).toContain('server/store.ts');
    expect(result.text).toContain('RESUMO REDUZIDO');
  });

  it('marks a too-small review budget incomplete instead of implying approval', () => {
    const review = [
      'Earlier comments '.repeat(100),
      '**P1 — Failed delivery retry**',
      'A lengthy explanation that should be compacted only after severity and location are preserved. '.repeat(8),
      'Location: server/orchestrator.ts',
      '**P1 — Dirty worktree baseline**',
      'A lengthy explanation that should be compacted only after severity and location are preserved. '.repeat(8),
      'Location: server/worktrees.ts',
      '**P2 — Retry events filtered out**',
      'A lengthy explanation that should be compacted only after severity and location are preserved. '.repeat(8),
      'Location: server/http/tasks.ts',
    ].join('\n');
    const result = summarizeReview(review, 350);
    expect(result.findings).toBe(3);
    expect(result.incomplete).toBe(true);
    expect(result.text).toContain('RESUMO REDUZIDO');
    expect(result.text).toContain('P1');
    expect(result.text).toContain('P2');
    expect(result.text).toContain('saída completa em tarefa de revisão');
    for (const path of ['server/orchestrator.ts', 'server/worktrees.ts', 'server/http/tasks.ts'])
      expect(result.text).toContain(path);
    expect(summarizeReview(review, 0)).toMatchObject({ text: '', incomplete: true });
  });

  it('accepts only complete, structured review verdicts and rejects prose or malformed findings', () => {
    expect(parseStructuredReview('{"status":"approved","findings":[]}')).toEqual({
      status: 'approved',
      findings: [],
    });
    expect(
      parseStructuredReview(
        '{"status":"findings","findings":[{"id":"f1","severity":"P2","title":"Bug","file":"src/app.ts","description":"Wrong branch"}]}',
      ),
    ).toMatchObject({ status: 'findings', findings: [{ severity: 'P2', file: 'src/app.ts' }] });
    expect(
      parseStructuredReview(
        '{"status":"findings","findings":[{"id":"f1","severity":["P2"],"title":"Bug","file":"src/app.ts","description":"Wrong branch"}]}',
      ),
    ).toBeUndefined();
    expect(
      parseStructuredReview(
        '{"status":"findings","findings":[{"id":"f1","severity":2,"title":"Bug","file":"src/app.ts","description":"Wrong branch"}]}',
      ),
    ).toBeUndefined();
    expect(
      parseStructuredReview(
        '{"status":"findings","findings":[{"id":"f1","severity":"P2","title":"Bug","file":"src/app.ts"}]}',
      ),
    ).toBeUndefined();
    expect(
      parseStructuredReview(
        '{"status":"findings","findings":[{"id":"f1","severity":"P2","title":"Bug","file":"src/app.ts","description":"Wrong branch","extra":true}]}',
      ),
    ).toBeUndefined();
    expect(parseStructuredReview('The review approves this.')).toBeUndefined();
    expect(
      parseStructuredReview(
        '{"status":"findings","findings":[{"id":"f1","severity":"P2","title":"Bug","file":"../evil.ts","description":"x"}]}',
      ),
    ).toBeUndefined();
    expect(parseStructuredReview('{"status":"approved","findings":[{"id":"f1"}]}')).toBeUndefined();
    expect(parseStructuredReview('{"status":"incomplete","findings":[]}')).toBeUndefined();
    expect(parseStructuredReview('{"status":"approved","findings":[]} trailing')).toBeUndefined();
  });

  it('keeps check results separate when hooks share a name but use different commands', () => {
    const latest = latestChecksByIdentity([
      { name: 'tests', command: 'npm test', status: 'failed', createdAt: '2026-10-14T10:00:00.000Z' },
      { name: 'tests', command: 'npm test', status: 'passed', createdAt: '2026-10-14T10:01:00.000Z' },
      { name: 'tests', command: 'npm run lint', status: 'failed', createdAt: '2026-10-14T10:02:00.000Z' },
    ]);
    expect(latest).toHaveLength(2);
    expect(latest).toContainEqual(expect.objectContaining({ command: 'npm test', status: 'passed' }));
    expect(latest).toContainEqual(expect.objectContaining({ command: 'npm run lint', status: 'failed' }));
  });

  it('accepts legitimate relative report paths but rejects traversal, absolute and control paths', () => {
    for (const path of ['src/routes/[id]/page.tsx', 'src/(admin)/page.tsx', 'src/café page.tsx']) {
      expect(isSafeReviewPath(path)).toBe(true);
      expect(
        parseStructuredReview(
          JSON.stringify({
            status: 'findings',
            findings: [{ id: 'f1', severity: 'P2', title: 'Bug', file: path, description: 'Detail' }],
          }),
        ),
      ).toMatchObject({ status: 'findings', findings: [{ file: path }] });
    }
    for (const path of [
      '../outside.ts',
      '/etc/passwd',
      'C:/outside.ts',
      'src\\\\file.ts',
      'src/..',
      'src/line\\nfeed.ts',
    ]) {
      expect(isSafeReviewPath(path)).toBe(false);
      expect(
        parseStructuredReview(
          JSON.stringify({
            status: 'findings',
            findings: [{ id: 'f1', severity: 'P2', title: 'Bug', file: path, description: 'Detail' }],
          }),
        ),
      ).toBeUndefined();
    }
  });

  it('requires stable checkout identity even when no checks exist and preserves findings on invalid approval', () => {
    const finding = parseStructuredReview(
      '{"status":"findings","findings":[{"id":"f1","severity":"P2","title":"Bug","file":"src/page.tsx","description":"Detail"}]}',
    )!;
    const approved = parseStructuredReview('{"status":"approved","findings":[]}')!;
    expect(decideReview({ completed: true, review: approved, checks: [] })).toMatchObject({
      valid: false,
      identityStable: false,
      repairEligible: false,
      approved: false,
      reason: 'source-identity-unverified-or-changed',
    });
    const before = {
      runId: 'run',
      root: '/project',
      state: 'verified' as const,
      scope: 'filesystem-except-.git-and-node_modules' as const,
      revision: { kind: 'source_tree' as const, value: 'a' },
    };
    const changed = { ...before, revision: { kind: 'source_tree' as const, value: 'b' } };
    const second = decideReview({ completed: true, review: approved, before, after: changed, checks: [] });
    expect(second.approved).toBe(false);
    expect(second.valid).toBe(false);
    expect(decideReview({ completed: true, review: finding, before, after: before, checks: [] })).toMatchObject({
      valid: true,
      repairEligible: true,
      approved: false,
      findings: [{ id: 'f1' }],
    });
    const failedButSameSource = decideReview({
      completed: true,
      review: finding,
      before,
      after: before,
      checks: [{ status: 'failed', source: before }],
    });
    expect(failedButSameSource).toMatchObject({
      valid: true,
      identityStable: true,
      checksCorrespond: true,
      checksPassed: false,
      repairEligible: true,
      approved: false,
      reason: 'checks-failed',
    });
    expect(
      decideReview({
        completed: true,
        review: approved,
        before,
        after: before,
        checks: [{ status: 'failed', source: before }],
      }),
    ).toMatchObject({ valid: true, approved: false, reason: 'checks-failed' });
  });
});
