import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plan, Run, Session, StreamEvent } from '../shared/contracts.js';
import type { Store } from './store.js';
import { httpError, tr } from './i18n.js';
import type { StartOptions } from './orchestrator.js';
import { titleFromMessage } from './router.js';
import { buildTaskPrompt, mergeTasks, parsePlanMarkdown, planCommand, planSlug, taskLabel } from './plan-markdown.js';

// Plan mode (docs/specs/plan-mode.md): plans written by read-only planning runs, edited and
// approved by the user, then executed one task per run, in order. A task is done only when
// its run completed; a failure or a cancel stops the plan with the task back for the user.

type Deps = {
  start: (session: Session, content: string, options: StartOptions) => Promise<{ runId: string; messageId: string }>;
  isActive: (sessionId: string) => boolean;
  emit: (event: StreamEvent) => void;
};
export const NO_TASKS = tr(undefined, 'plans.noTasks');

export class Plans {
  constructor(
    private readonly store: Store,
    private readonly deps: Deps,
  ) {}
  list(sessionId: string) {
    return this.store.listPlans(sessionId);
  }
  private require(planId: string) {
    const plan = this.store.getPlan(planId);
    if (!plan) throw httpError(404, 'plans.notFound');
    return plan;
  }
  private session(plan: Plan) {
    const session = this.store.getSession(plan.sessionId);
    if (!session) throw httpError(404, 'common.sessionNotFound');
    return session;
  }
  /** Mutations wait for the conversation to be idle (the stop request is the exception). */
  private requireIdle(plan: Plan) {
    const session = this.session(plan);
    if (session.activeRunId || this.deps.isActive(session.id)) throw httpError(409, 'orchestrator.runInProgress');
    return session;
  }
  private save(plan: Plan) {
    plan.updatedAt = new Date().toISOString();
    this.store.putPlan(plan);
    this.deps.emit({ type: 'plan', plan });
    return plan;
  }
  /** Status after a change to the tasks: done once nothing is left to run. */
  private settle(plan: Plan) {
    if (plan.status === 'rejected' || plan.status === 'draft') return;
    const left = plan.tasks.some((t) => t.status !== 'done' && t.status !== 'skipped');
    plan.status = plan.tasks.length && !left ? 'done' : 'approved';
  }

  edit(planId: string, markdown: string) {
    const plan = this.require(planId);
    this.requireIdle(plan);
    if (plan.status === 'executing' || plan.status === 'rejected')
      throw httpError(409, plan.status === 'rejected' ? 'plans.discarded' : 'plans.executing');
    const parsed = parsePlanMarkdown(markdown);
    plan.markdown = markdown;
    plan.requirements = parsed.requirements;
    plan.design = parsed.design;
    plan.tasks = mergeTasks(plan.tasks, parsed.tasks);
    if (parsed.title) plan.title = parsed.title.slice(0, 160);
    delete plan.error;
    this.settle(plan);
    return this.save(plan);
  }

  /** `overrideLimit` ("Continuar mesmo assim") lets only the first task pass the usage limits. */
  async approve(planId: string, mode: 'all' | 'next', overrideLimit = false, manualApproval = false) {
    const plan = this.require(planId);
    this.requireIdle(plan);
    if (plan.status === 'rejected') throw httpError(409, 'plans.discarded');
    if (plan.status === 'executing') throw httpError(409, 'plans.alreadyExecuting');
    if (!plan.tasks.length) throw httpError(409, 'plans.noTasks');
    if (!plan.tasks.some((t) => t.status === 'pending' || t.status === 'failed'))
      throw httpError(409, 'plans.noPendingTasks');
    const previous = plan.status;
    plan.status = 'executing';
    plan.executionMode = mode;
    // Approved from the internet: every task of this execution waits for manual approval.
    if (manualApproval) plan.manualApproval = true;
    else delete plan.manualApproval;
    delete plan.stopRequested;
    delete plan.error;
    this.save(plan);
    try {
      return { plan: this.store.getPlan(plan.id)!, started: await this.startNext(plan, overrideLimit) };
    } catch (error) {
      const latest = this.store.getPlan(plan.id) ?? plan;
      latest.status = previous === 'draft' ? 'draft' : 'approved';
      delete latest.executionMode;
      latest.error = error instanceof Error ? error.message : String(error);
      this.save(latest);
      throw error;
    }
  }

  /** Starts the first pending (or failed, i.e. retried) task. */
  private async startNext(plan: Plan, overrideLimit = false) {
    const task = plan.tasks.find((t) => t.status === 'pending' || t.status === 'failed');
    if (!task) throw httpError(409, 'plans.noPendingTasks');
    return this.deps.start(this.session(plan), taskLabel(plan, task), {
      planTask: { planId: plan.id, taskId: task.id, prompt: buildTaskPrompt(plan, task) },
      ...(overrideLimit ? { overrideLimit } : {}),
      ...(plan.manualApproval ? { manualApproval: true } : {}),
    });
  }

  /** Called by the orchestrator once the run of a task exists. */
  taskStarted(planId: string, taskId: string, runId: string) {
    const plan = this.store.getPlan(planId);
    const task = plan?.tasks.find((t) => t.id === taskId);
    if (!plan || !task) return;
    task.status = 'running';
    task.runId = runId;
    delete task.error;
    this.save(plan);
  }

  /** "Parar após a tarefa atual": the running task finishes, nothing else starts. */
  stop(planId: string) {
    const plan = this.require(planId);
    if (plan.status !== 'executing') throw httpError(409, 'plans.notExecuting');
    plan.stopRequested = true;
    return this.save(plan);
  }

  setTaskStatus(planId: string, taskId: string, status: 'skipped' | 'pending') {
    const plan = this.require(planId);
    this.requireIdle(plan);
    if (plan.status === 'rejected') throw httpError(409, 'plans.discarded');
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) throw httpError(404, 'plans.taskNotFound');
    if (task.status === 'done' || task.status === 'running')
      throw httpError(409, task.status === 'done' ? 'plans.taskDone' : 'plans.taskRunning');
    task.status = status;
    if (status === 'skipped') delete task.error;
    if (plan.status !== 'draft' && plan.status !== 'executing') this.settle(plan);
    return this.save(plan);
  }

  discard(planId: string) {
    const plan = this.require(planId);
    this.requireIdle(plan);
    if (plan.status === 'rejected') throw httpError(409, 'plans.alreadyDiscarded');
    plan.status = 'rejected';
    delete plan.executionMode;
    delete plan.stopRequested;
    return this.save(plan);
  }

  /**
   * Writes the plan to `<project>/.adelic/specs/<slug>.md`. Refuses detached conversations,
   * paths that leave the project through a symlink, and an existing file unless `overwrite`
   * (409 with `exists: true`, so the UI can ask first).
   */
  saveToProject(planId: string, overwrite = false) {
    const plan = this.require(planId);
    if (plan.status === 'draft' || plan.status === 'rejected') throw httpError(409, 'plans.approveBeforeSave');
    const session = this.session(plan);
    const project = session.projectId === null ? undefined : this.store.getProject(session.projectId);
    if (!project) throw httpError(409, 'plans.noProject');
    let root: string;
    try {
      root = realpathSync(project.path);
    } catch {
      throw httpError(409, 'plans.projectGone');
    }
    const dir = join(root, '.adelic', 'specs');
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync(dir);
    if (realDir !== dir || !within(root, realDir)) throw httpError(409, 'plans.specsSymlink');
    const target = join(realDir, `${planSlug(plan.title)}.md`);
    const path = relative(root, target).split(sep).join('/');
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(target);
    } catch {
      existing = undefined;
    }
    if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
      throw httpError(409, 'plans.notRegularFile', { path });
    if (existing && !overwrite) throw httpError(409, 'plans.exists', { path }, { exists: true, path });
    const body = plan.markdown.endsWith('\n') ? plan.markdown : `${plan.markdown}\n`;
    if (existing) {
      const temp = join(realDir, `.${randomUUID()}.tmp`);
      writeFileSync(temp, body, { flag: 'wx' });
      renameSync(temp, target);
    } else {
      // `wx` fails if the file appeared meanwhile: never overwrites without the flag.
      try {
        writeFileSync(target, body, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw httpError(409, 'plans.exists', { path }, { exists: true, path });
        throw error;
      }
    }
    plan.savedPath = path;
    this.save(plan);
    return { path, plan };
  }

  /** End of any run: creates the plan of a planning run, or advances the task of a task run. */
  runEnded(run: Run, response: string) {
    if (run.plan?.kind === 'plan') {
      if (run.status === 'completed' && response.trim()) this.createFromRun(run, response);
      return;
    }
    if (run.plan?.kind !== 'task') return;
    const plan = this.store.getPlan(run.plan.planId);
    const task = plan?.tasks.find((t) => t.id === (run.plan as { taskId: string }).taskId);
    if (!plan || !task || task.runId !== run.id) return;
    if (run.status === 'completed') {
      task.status = 'done';
      delete task.error;
    } else if (run.status === 'failed') {
      task.status = 'failed';
      task.error = run.error || 'A execução falhou';
    } else {
      task.status = 'pending';
      task.error = run.status === 'cancelled' ? 'Cancelada pelo usuário' : 'Execução interrompida';
    }
    const next = plan.tasks.find((t) => t.status === 'pending' || t.status === 'failed');
    const keepGoing =
      run.status === 'completed' && plan.status === 'executing' && plan.executionMode === 'all' && !plan.stopRequested;
    if (keepGoing && next) {
      this.save(plan);
      void this.startNext(plan).catch((error: unknown) => {
        const latest = this.store.getPlan(plan.id);
        if (!latest) return;
        latest.status = 'approved';
        delete latest.executionMode;
        latest.error = `Não foi possível iniciar a próxima tarefa: ${error instanceof Error ? error.message : String(error)}`;
        this.save(latest);
      });
      return;
    }
    if (run.status === 'failed')
      plan.error = `A tarefa ${plan.tasks.indexOf(task) + 1} falhou. Tente de novo ou pule-a para continuar.`;
    plan.status = 'approved';
    delete plan.executionMode;
    delete plan.stopRequested;
    this.settle(plan);
    this.save(plan);
  }

  private createFromRun(run: Run, response: string) {
    const parsed = parsePlanMarkdown(response);
    const request = this.store.listMessages(run.sessionId).find((m) => m.runId === run.id && m.role === 'user');
    const asked = request ? (planCommand(request.content) ?? request.content) : '';
    const now = new Date().toISOString();
    const plan: Plan = {
      id: randomUUID(),
      sessionId: run.sessionId,
      runId: run.id,
      title: (parsed.title || titleFromMessage(asked) || 'Plano').slice(0, 160),
      status: 'draft',
      requirements: parsed.requirements,
      design: parsed.design,
      tasks: mergeTasks([], parsed.tasks),
      markdown: response.trim(),
      createdAt: now,
      updatedAt: now,
    };
    this.store.putPlan(plan);
    this.deps.emit({ type: 'plan', plan });
    return plan;
  }
}

function within(root: string, path: string) {
  return path === root || path.startsWith(root + sep);
}
