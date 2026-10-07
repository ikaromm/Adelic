import { describe, expect, it } from 'vitest';
import type { Plan } from '../shared/contracts';
import { upsertPlan } from '../src/hooks/usePlans';
import { planProgress } from '../src/components/PlanCard';

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'p',
  sessionId: 's',
  runId: 'r',
  title: 'T',
  status: 'draft',
  requirements: '',
  design: '',
  markdown: '',
  tasks: [],
  createdAt: '2026-10-06T10:00:00.000Z',
  updatedAt: '2026-10-06T10:00:00.000Z',
  ...over,
});

describe('plan card state', () => {
  it('applies plan events of the open conversation and never goes back to an older copy', () => {
    const first = plan();
    expect(upsertPlan([], first, 's')).toEqual([first]);
    expect(upsertPlan([], plan({ sessionId: 'other' }), 's')).toEqual([]);
    const newer = plan({ status: 'executing', updatedAt: '2026-10-06T10:00:01.000Z' });
    expect(upsertPlan([first], newer, 's')).toEqual([newer]);
    expect(upsertPlan([newer], first, 's')).toEqual([newer]);
    expect(upsertPlan([first], plan({ id: 'q' }), 's').map((p) => p.id)).toEqual(['p', 'q']);
  });

  it('orders copies saved in the same millisecond by revision (the approve race)', () => {
    const at = '2026-10-06T10:00:02.000Z';
    const running = plan({ status: 'executing', revision: 3, updatedAt: at });
    const staleExecuting = plan({ status: 'executing', revision: 2, updatedAt: at });
    // The running-task event arrived first; the approve response (older revision) must not undo it.
    expect(upsertPlan([running], staleExecuting, 's')).toEqual([running]);
    expect(upsertPlan([staleExecuting], running, 's')).toEqual([running]);
  });

  it('counts done and skipped tasks as finished', () => {
    expect(planProgress(plan())).toBe('');
    const tasks: Plan['tasks'] = [
      { id: 'a', text: 'a', status: 'done' },
      { id: 'b', text: 'b', status: 'skipped' },
      { id: 'c', text: 'c', status: 'failed' },
    ];
    expect(planProgress(plan({ tasks }))).toBe('2 de 3 tarefas concluídas');
    expect(planProgress(plan({ tasks: [tasks[0]] }))).toBe('1 de 1 tarefa concluída');
  });
});
