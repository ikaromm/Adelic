import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { PLAN_PROMPT_MARKER, TASK_PROMPT_MARKER } from '../server/plan-markdown.js';
import { Store } from '../server/store.js';
import { NO_TASKS } from '../server/plans.js';
import type { Plan, ProviderRegistry, Run, RunInput, RunResult, Session, StreamEvent } from '../shared/contracts.js';
import { gitIn, makeGitRepo } from './git-fixtures.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SPEC = `# Exportar CSV

## Requisitos
1. Exporta um CSV.

## Design
Gerar à mão em \`src/export.ts\`.

## Tarefas
- [ ] Criar o exportador
- [ ] Ligar o botão
`;

/**
 * Provider whose task turns finish when the test says so (`finish` / `fail` the oldest open
 * turn); planning turns answer `planAnswer` right away. A planning turn also tries a file
 * change approval, as a model could, to check it is refused.
 */
function scripted(planAnswer = SPEC) {
  const inputs: RunInput[] = [];
  const open: { resolve: (r: RunResult) => void; reject: (e: Error) => void; emit: (t: string) => void }[] = [];
  const approvals: { id: string; decision: string }[] = [];
  const waiters: (() => void)[] = [];
  const providers: ProviderRegistry = {
    async list() {
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: '',
          models: [{ id: 'm', name: 'm', isDefault: true }],
          defaultModel: 'm',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    },
    run(input, emit, signal) {
      inputs.push(input);
      for (const w of waiters.splice(0)) w();
      if (input.prompt.startsWith(PLAN_PROMPT_MARKER)) {
        if (input.prompt.includes('[falhar]')) return Promise.reject(new Error('modelo indisponível'));
        emit({
          type: 'approval',
          approval: {
            id: `a-${input.runId}`,
            runId: input.runId,
            sessionId: input.sessionId,
            title: 'Editar README.md',
            detail: '',
            kind: 'file',
            status: 'pending',
          },
        });
        emit({ type: 'delta', text: planAnswer });
        return Promise.resolve({ text: planAnswer, stopReason: 'completed' });
      }
      if (input.prompt.startsWith(TASK_PROMPT_MARKER) || input.prompt.includes('[esperar]'))
        return new Promise<RunResult>((resolve, reject) => {
          const turn = {
            resolve,
            reject,
            emit: (text: string) => emit({ type: 'delta', text }),
          };
          open.push(turn);
          signal.addEventListener(
            'abort',
            () => {
              open.splice(open.indexOf(turn), 1);
              resolve({ text: '', stopReason: 'cancelled' });
            },
            { once: true },
          );
        });
      emit({ type: 'delta', text: 'resposta' });
      return Promise.resolve({ text: 'resposta', stopReason: 'completed' });
    },
    async approve(id, decision) {
      approvals.push({ id, decision });
    },
    async shutdown() {},
  };
  const started = async (count: number) => {
    while (inputs.length < count) await new Promise<void>((r) => waiters.push(r));
    // Let the turn register before the test finishes it.
    await new Promise((r) => setTimeout(r, 5));
  };
  return {
    providers,
    inputs,
    approvals,
    started,
    finish(text = 'Tarefa concluída') {
      const turn = open.shift()!;
      turn.emit(text);
      turn.resolve({ text, stopReason: 'completed' });
    },
    fail(message = 'quebrou') {
      open.shift()!.reject(new Error(message));
    },
  };
}

async function setup(opts: { sandbox?: 'read-only' | 'workspace-write'; project?: string; planAnswer?: string } = {}) {
  const dataDir = tempDir('adelic-plans-data-');
  const store = new Store(dataDir);
  store.setSettings({
    ...store.getSettings()!,
    sandbox: opts.sandbox ?? 'workspace-write',
    approvalMode: 'manual',
    autoRetry: false,
  });
  const now = new Date().toISOString();
  if (opts.project)
    store.putProject({
      id: 'p',
      name: 'P',
      path: opts.project,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      // Orchestration on: plan mode must still be one direct call per run.
      orchestration: { enabled: true, maxWorkers: 2, review: true },
    });
  const session: Session = {
    id: 's',
    projectId: opts.project ? 'p' : null,
    title: 'Nova conversa',
    providerId: 'codex',
    mode: 'auto',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const provider = scripted(opts.planAnswer);
  const { app, orchestrator } = createBackend(store, provider.providers, undefined, undefined, { retries: 0 });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    await orchestrator.shutdown();
    await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in assertions
      body: (await response.json().catch(() => ({}))) as Record<string, any>,
    };
  };
  const events: StreamEvent[] = [];
  orchestrator.subscribe((e) => events.push(e));
  const finished = (runId: string) =>
    new Promise<Run>((resolve) => {
      const check = () => {
        const run = store.getRun(runId);
        if (run && run.status !== 'running' && !orchestrator.isActive('s')) return resolve(run);
        setTimeout(check, 5);
      };
      check();
    });
  const plan = () => store.listPlans('s').at(-1)!;
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 400 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(predicate()).toBe(true);
  };
  return { store, orchestrator, provider, call, events, finished, plan, until, session };
}

async function makePlan(t: Awaited<ReturnType<typeof setup>>, content = '/plano exportar CSV') {
  const { runId } = await t.orchestrator.start(t.session, content);
  await t.finished(runId);
  return t.plan();
}
const statuses = (plan: Plan) => plan.tasks.map((task) => task.status);

describe('plan runs', () => {
  it('forces a read-only sandbox, denies file changes and stores the parsed plan', async () => {
    const repo = makeGitRepo();
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
    const t = await setup({ sandbox: 'workspace-write', project: repo });
    const plan = await makePlan(t);
    const input = t.provider.inputs[0];
    // Settings say workspace-write; the planning run is read-only, with no checkpoint.
    expect(input.sandbox).toBe('read-only');
    expect(input.prompt.startsWith(PLAN_PROMPT_MARKER)).toBe(true);
    expect(input.prompt).toContain('Pedido do usuário:\nexportar CSV');
    expect(t.provider.inputs).toHaveLength(1); // one direct call even with orchestration on
    const run = t.store.getRun(plan.runId)!;
    expect(run.plan).toEqual({ kind: 'plan' });
    expect(run.checkpoint).toBeUndefined();
    expect(gitIn(repo, 'for-each-ref', 'refs/adelic/')).toBe('');
    // The file change request was refused without waiting for the user.
    expect(t.provider.approvals).toEqual([{ id: `a-${plan.runId}`, decision: 'deny' }]);
    expect(t.store.listApprovals('s')).toMatchObject([{ kind: 'file', status: 'denied' }]);
    expect(plan).toMatchObject({
      status: 'draft',
      title: 'Exportar CSV',
      requirements: '1. Exporta um CSV.',
      design: 'Gerar à mão em `src/export.ts`.',
      markdown: SPEC.trim(),
    });
    expect(plan.tasks.map((task) => [task.text, task.status])).toEqual([
      ['Criar o exportador', 'pending'],
      ['Ligar o botão', 'pending'],
    ]);
    expect(t.store.getSession('s')!.title).toBe('exportar CSV');
    expect(t.events.some((e) => e.type === 'plan')).toBe(true);
  });

  it('plans every message while "Planejar antes" is on, and never for ordinary messages', async () => {
    const t = await setup();
    const normal = await t.orchestrator.start(t.session, 'Qual a capital da França?');
    await t.finished(normal.runId);
    expect(t.provider.inputs[0].prompt.startsWith(PLAN_PROMPT_MARKER)).toBe(false);
    expect(t.store.getRun(normal.runId)!.plan).toBeUndefined();
    expect(t.store.listPlans('s')).toEqual([]);

    const patched = await t.call('PATCH', '/api/sessions/s', { planFirst: true });
    expect(patched.body.planFirst).toBe(true);
    expect((await t.call('PATCH', '/api/sessions/s', { planFirst: 'sim' })).status).toBe(400);
    const planned = await t.orchestrator.start(t.store.getSession('s')!, 'exportar CSV');
    await t.finished(planned.runId);
    expect(t.provider.inputs[1].prompt).toContain('Pedido do usuário:\nexportar CSV');
    expect(t.provider.inputs[1].sandbox).toBe('read-only');
    expect(t.store.listPlans('s')).toHaveLength(1);
    const off = await t.call('PATCH', '/api/sessions/s', { planFirst: false });
    expect(off.body.planFirst).toBeUndefined();

    await expect(t.orchestrator.start(t.store.getSession('s')!, '/plano   ')).rejects.toMatchObject({ status: 400 });
  });

  it('plans the expanded saved command with "Planejar antes", and /plano wins over a command named plano', async () => {
    const t = await setup();
    const now = new Date().toISOString();
    for (const [name, template] of [
      ['refatorar', 'Refatore {{args}} sem mudar o comportamento'],
      ['plano', 'NÃO USAR'],
    ])
      t.store.putCommand({
        id: `cmd-${name}`,
        name,
        description: '',
        template,
        projectId: null,
        createdAt: now,
        updatedAt: now,
      });
    await t.call('PATCH', '/api/sessions/s', { planFirst: true });
    const planned = await t.orchestrator.start(t.store.getSession('s')!, '/refatorar o parser');
    await t.finished(planned.runId);
    expect(t.provider.inputs[0].prompt).toContain('Refatore o parser sem mudar o comportamento');
    expect(t.provider.inputs[0].sandbox).toBe('read-only');
    await t.call('PATCH', '/api/sessions/s', { planFirst: false });
    const direct = await t.orchestrator.start(t.store.getSession('s')!, '/plano exportar CSV');
    await t.finished(direct.runId);
    expect(t.provider.inputs[1].prompt).toContain('Pedido do usuário:\nexportar CSV');
    expect(t.provider.inputs[1].prompt).not.toContain('NÃO USAR');
  });

  it('keeps a plan without tasks as a draft that cannot be approved until edited', async () => {
    const t = await setup({ planAnswer: 'Não sei bem; preciso de mais detalhes.' });
    const plan = await makePlan(t);
    expect(plan).toMatchObject({ requirements: '', design: 'Não sei bem; preciso de mais detalhes.', tasks: [] });
    const refused = await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    expect(refused).toMatchObject({ status: 409, body: { error: NO_TASKS } });
    const edited = await t.call('PATCH', `/api/plans/${plan.id}`, { markdown: '## Tarefas\n- [ ] Única' });
    expect(edited.body.tasks).toMatchObject([{ text: 'Única', status: 'pending' }]);
    expect(edited.body.status).toBe('draft');
  });

  it('does not create a plan when the planning run fails', async () => {
    const t = await setup();
    const { runId } = await t.orchestrator.start(t.session, '/plano [falhar]');
    expect((await t.finished(runId)).status).toBe('failed');
    expect(t.store.listPlans('s')).toEqual([]);
  });
});

describe('sequential plan execution', () => {
  it('runs every task in order, one run each, respecting the sandbox, and marks the plan done', async () => {
    const repo = makeGitRepo();
    cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
    const t = await setup({ sandbox: 'workspace-write', project: repo });
    const plan = await makePlan(t);
    const approved = await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    expect(approved.status).toBe(202);
    expect(approved.body.started.runId).toBeTruthy();
    await t.provider.started(2);
    expect(statuses(t.plan())).toEqual(['running', 'pending']);
    expect(t.plan().status).toBe('executing');
    const first = t.provider.inputs[1];
    expect(first.sandbox).toBe('workspace-write');
    expect(first.approvalMode).toBe('manual');
    expect(first.prompt.startsWith(TASK_PROMPT_MARKER)).toBe(true);
    expect(first.prompt).toContain('Tarefa atual: Criar o exportador');
    // Each task run is a writing run with its own checkpoint.
    const firstRun = t.store.getRun(t.plan().tasks[0].runId!)!;
    expect(firstRun.plan).toEqual({ kind: 'task', planId: plan.id, taskId: plan.tasks[0].id });
    // While a task runs, the plan cannot be changed.
    expect((await t.call('PATCH', `/api/plans/${plan.id}`, { markdown: 'x' })).status).toBe(409);
    expect((await t.call('POST', `/api/plans/${plan.id}/discard`, {})).status).toBe(409);
    expect((await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' })).status).toBe(409);

    t.provider.finish();
    await t.provider.started(3);
    expect(statuses(t.plan())).toEqual(['done', 'running']);
    expect(t.provider.inputs[2].prompt).toContain('- [x] Criar o exportador (concluída)');
    t.provider.finish();
    await t.until(() => t.plan().status === 'done');
    expect(statuses(t.plan())).toEqual(['done', 'done']);
    expect((await t.finished(t.plan().tasks[1].runId!)).checkpoint?.available).toBe(true);
    const users = t.store.listMessages('s').filter((m) => m.role === 'user');
    expect(users.map((m) => m.content)).toEqual([
      '/plano exportar CSV',
      'Tarefa 1/2 do plano: Criar o exportador',
      'Tarefa 2/2 do plano: Ligar o botão',
    ]);
  });

  it('"next" runs only one task, then waits', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'next' });
    await t.provider.started(2);
    t.provider.finish();
    await t.until(() => t.plan().status === 'approved');
    expect(statuses(t.plan())).toEqual(['done', 'pending']);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.provider.inputs).toHaveLength(2);
  });

  it('stops on failure, marks the task failed, and retries it on the next approval', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    await t.provider.started(2);
    t.provider.fail('compilação quebrou');
    await t.until(() => t.plan().status === 'approved');
    expect(statuses(t.plan())).toEqual(['failed', 'pending']);
    expect(t.plan().tasks[0].error).toBe('compilação quebrou');
    expect(t.plan().error).toBe('A tarefa 1 falhou. Tente de novo ou pule-a para continuar.');
    await new Promise((r) => setTimeout(r, 30));
    expect(t.provider.inputs).toHaveLength(2); // nothing else started

    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    await t.provider.started(3);
    expect(t.provider.inputs[2].prompt).toContain('Tarefa atual: Criar o exportador');
    t.provider.finish();
    await t.provider.started(4);
    t.provider.finish();
    await t.until(() => t.plan().status === 'done');
  });

  it('skips a task and can bring it back; done tasks cannot be skipped', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    const [a, b] = plan.tasks;
    expect((await t.call('POST', `/api/plans/${plan.id}/tasks/${a.id}`, { status: 'done' })).status).toBe(400);
    expect((await t.call('POST', `/api/plans/${plan.id}/tasks/nope`, { status: 'skipped' })).status).toBe(404);
    const skipped = await t.call('POST', `/api/plans/${plan.id}/tasks/${a.id}`, { status: 'skipped' });
    expect(skipped.body.tasks[0].status).toBe('skipped');
    expect(skipped.body.status).toBe('draft');
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    await t.provider.started(2);
    expect(t.provider.inputs[1].prompt).toContain('Tarefa atual: Ligar o botão');
    expect(t.provider.inputs[1].prompt).toContain('- [-] Criar o exportador (pulada pelo usuário)');
    t.provider.finish();
    await t.until(() => t.plan().status === 'done');
    expect((await t.call('POST', `/api/plans/${plan.id}/tasks/${b.id}`, { status: 'skipped' })).status).toBe(409);
    const back = await t.call('POST', `/api/plans/${plan.id}/tasks/${a.id}`, { status: 'pending' });
    expect(back.body).toMatchObject({ status: 'approved', tasks: [{ status: 'pending' }, { status: 'done' }] });
  });

  it('"stop after the current task" lets it finish and starts nothing else', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    expect((await t.call('POST', `/api/plans/${plan.id}/stop`, {})).status).toBe(409);
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    await t.provider.started(2);
    expect((await t.call('POST', `/api/plans/${plan.id}/stop`, {})).body.stopRequested).toBe(true);
    t.provider.finish();
    await t.until(() => t.plan().status === 'approved');
    expect(statuses(t.plan())).toEqual(['done', 'pending']);
    expect(t.plan().stopRequested).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.provider.inputs).toHaveLength(2);
  });

  it('cancelling the run never marks its task done and stops the plan', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    await t.provider.started(2);
    await t.orchestrator.cancel('s');
    await t.until(() => t.plan().status === 'approved');
    expect(statuses(t.plan())).toEqual(['pending', 'pending']);
    expect(t.plan().tasks[0].error).toBe('Cancelada pelo usuário');
    await new Promise((r) => setTimeout(r, 30));
    expect(t.provider.inputs).toHaveLength(2);
  });

  it('a queued message waits for the whole plan', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    await t.provider.started(2);
    await t.orchestrator.enqueue('s', 'depois do plano');
    t.provider.finish();
    await t.provider.started(3);
    expect(t.provider.inputs[2].prompt.startsWith(TASK_PROMPT_MARKER)).toBe(true);
    expect(t.orchestrator.queue('s').items).toHaveLength(1);
    t.provider.finish();
    await t.until(() => t.provider.inputs.length === 4);
    expect(t.provider.inputs[3].prompt).toContain('depois do plano');
  });

  it('an approval that cannot start rolls the plan back', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    const busy = await t.orchestrator.start(t.session, '[esperar]');
    await t.provider.started(2);
    const refused = await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' });
    expect(refused.status).toBe(409);
    expect(t.plan().status).toBe('draft');
    t.provider.finish('ok');
    await t.finished(busy.runId);
  });
});

describe('plan routes', () => {
  it('lists, validates, edits, discards and answers 404', async () => {
    const t = await setup();
    expect((await t.call('GET', '/api/sessions/nope/plans')).status).toBe(404);
    expect((await t.call('GET', '/api/sessions/s/plans')).body).toEqual({ plans: [] });
    const plan = await makePlan(t);
    expect((await t.call('GET', '/api/sessions/s/plans')).body.plans).toHaveLength(1);
    expect((await t.call('PATCH', '/api/plans/nope', { markdown: 'x' })).status).toBe(404);
    expect((await t.call('PATCH', `/api/plans/${plan.id}`, { markdown: ' ' })).status).toBe(400);
    expect((await t.call('PATCH', `/api/plans/${plan.id}`, { markdown: 'x'.repeat(60_001) })).status).toBe(400);
    expect((await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'some' })).status).toBe(400);
    expect((await t.call('POST', '/api/plans/nope/approve', { mode: 'all' })).status).toBe(404);
    const edited = await t.call('PATCH', `/api/plans/${plan.id}`, {
      markdown: SPEC.replace('- [ ] Ligar o botão', '- [ ] Ligar o botão\n- [ ] Documentar'),
    });
    expect(edited.body.tasks.map((task: { id: string }) => task.id).slice(0, 2)).toEqual(
      plan.tasks.map((task) => task.id),
    );
    expect(edited.body.tasks).toHaveLength(3);
    const discarded = await t.call('POST', `/api/plans/${plan.id}/discard`, {});
    expect(discarded.body.status).toBe('rejected');
    expect((await t.call('POST', `/api/plans/${plan.id}/discard`, {})).status).toBe(409);
    expect((await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'all' })).status).toBe(409);
    expect((await t.call('PATCH', `/api/plans/${plan.id}`, { markdown: 'x' })).status).toBe(409);
    // Deleting the conversation removes its plans.
    expect((await t.call('DELETE', '/api/sessions/s', {})).status).toBe(204);
    expect(t.store.getPlan(plan.id)).toBeUndefined();
  });

  it('resets running tasks of an executing plan after a restart', async () => {
    const t = await setup();
    const plan = await makePlan(t);
    t.store.putPlan({
      ...plan,
      status: 'executing',
      executionMode: 'all',
      tasks: [{ ...plan.tasks[0], status: 'running' }, plan.tasks[1]],
    });
    const reopened = new Store(t.store.dataDir);
    const after = reopened.getPlan(plan.id)!;
    reopened.close();
    expect(after).toMatchObject({ status: 'approved', tasks: [{ status: 'pending' }, { status: 'pending' }] });
    expect(after.executionMode).toBeUndefined();
    expect(after.tasks[0].error).toContain('reinício');
  });
});

describe('saving a plan in the project', () => {
  it('writes .adelic/specs/<slug>.md, refuses to overwrite without confirmation, and overwrites when asked', async () => {
    const project = tempDir('adelic-plans-project-');
    const t = await setup({ sandbox: 'read-only', project });
    const plan = await makePlan(t);
    expect((await t.call('POST', `/api/plans/${plan.id}/save`, {})).status).toBe(409); // draft
    await t.call('POST', `/api/plans/${plan.id}/approve`, { mode: 'next' });
    await t.provider.started(2);
    t.provider.finish();
    await t.until(() => t.plan().status === 'approved');
    const saved = await t.call('POST', `/api/plans/${plan.id}/save`, {});
    expect(saved).toMatchObject({ status: 200, body: { path: '.adelic/specs/exportar-csv.md' } });
    const file = join(project, '.adelic/specs/exportar-csv.md');
    expect(readFileSync(file, 'utf8')).toBe(`${SPEC.trim()}\n`);
    writeFileSync(file, 'editado pelo usuário\n');
    const again = await t.call('POST', `/api/plans/${plan.id}/save`, {});
    expect(again).toMatchObject({ status: 409, body: { exists: true, path: '.adelic/specs/exportar-csv.md' } });
    expect(readFileSync(file, 'utf8')).toBe('editado pelo usuário\n');
    expect((await t.call('POST', `/api/plans/${plan.id}/save`, { overwrite: 'sim' })).status).toBe(400);
    const forced = await t.call('POST', `/api/plans/${plan.id}/save`, { overwrite: true });
    expect(forced.status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe(`${SPEC.trim()}\n`);
    expect(t.plan().savedPath).toBe('.adelic/specs/exportar-csv.md');
  });

  it('never writes outside the project through a symlink, and refuses detached conversations', async () => {
    const project = tempDir('adelic-plans-project-');
    const outside = tempDir('adelic-plans-outside-');
    mkdirSync(join(project, '.adelic'));
    symlinkSync(outside, join(project, '.adelic', 'specs'));
    const t = await setup({ project });
    const plan = await makePlan(t);
    t.store.putPlan({ ...plan, status: 'approved' });
    const refused = await t.call('POST', `/api/plans/${plan.id}/save`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('link simbólico');
    expect(existsSync(join(outside, 'exportar-csv.md'))).toBe(false);

    rmSync(join(project, '.adelic', 'specs'));
    mkdirSync(join(project, '.adelic', 'specs'));
    symlinkSync(join(outside, 'alvo.md'), join(project, '.adelic', 'specs', 'exportar-csv.md'));
    const linked = await t.call('POST', `/api/plans/${plan.id}/save`, { overwrite: true });
    expect(linked.status).toBe(409);
    expect(existsSync(join(outside, 'alvo.md'))).toBe(false);

    const detached = await setup();
    const loose = await makePlan(detached);
    detached.store.putPlan({ ...loose, status: 'approved' });
    const noProject = await detached.call('POST', `/api/plans/${loose.id}/save`, {});
    expect(noProject).toMatchObject({ status: 409, body: { error: 'Esta conversa não está vinculada a um projeto' } });
  });
});
