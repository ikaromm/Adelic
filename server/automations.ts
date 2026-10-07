import { randomUUID } from 'node:crypto';
import type { Run, Session, StreamEvent } from '../shared/contracts.js';
import {
  AUTOMATION_GLOBAL_OFF,
  AUTOMATION_SKIPPED_ACTIVE,
  automationTitle,
  nextOccurrence,
  type Automation,
  type AutomationResult,
} from '../shared/automations.js';
import type { Orchestrator } from './orchestrator.js';
import type { Store } from './store.js';
import { errorKey, httpError, type Translatable } from './i18n.js';

/**
 * Scheduled automations (docs/specs/automations.md). Lives only inside the Adelic server
 * process: one timer to the next due occurrence, recomputed on every change, cleared on
 * shutdown. Nothing runs while Settings.automations is off, and nothing runs when Adelic is
 * closed. Each automation writes into its own conversation; an occurrence that finds that
 * conversation busy is skipped and recorded, so two occurrences never run at once.
 */
export interface AutomationClock {
  now(): number;
}
/** Longest single wait: later occurrences are re-evaluated, which absorbs wall-clock jumps. */
export const MAX_WAIT_MS = 60 * 60_000;
/** A timer that fires this late (sleep/suspend) counts as a missed occurrence. */
export const LATE_TOLERANCE_MS = 15 * 60_000;

type Trigger = AutomationResult['trigger'];
export type FireResult =
  | { ok: true; automation: Automation; started: { runId: string; messageId: string } }
  | { ok: false; automation: Automation; status: number; message: string; reason?: Translatable };

export class AutomationService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Automations whose start is in progress (between the checks and orchestrator.start). */
  private firing = new Set<string>();
  /** Auto-deny timers by approval id. */
  private denyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  private readonly clock: AutomationClock;

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    clock?: AutomationClock,
  ) {
    this.clock = clock ?? { now: () => Date.now() };
    this.unsubscribe = orchestrator.subscribe((event) => this.onEvent(event));
  }

  now() {
    return this.clock.now();
  }
  private globalOn() {
    return this.store.getSettings()?.automations === true;
  }
  private emit() {
    this.orchestrator.publish({ type: 'automations' });
  }
  private save(automation: Automation) {
    this.store.putAutomation(automation);
    return automation;
  }
  /** Next occurrence after `after` (default now), on the automation's interval grid. */
  private next(automation: Automation, after = this.now()) {
    return new Date(
      nextOccurrence(automation.schedule, automation.timezone, after, Date.parse(automation.anchorAt)),
    ).toISOString();
  }

  /**
   * Startup: reconciles results of runs cut by a restart, then handles occurrences missed while
   * Adelic was closed (one catch-up run per automation with catchUp; the others just move on)
   * and arms the timer.
   */
  start() {
    for (const automation of this.store.listAutomations()) {
      const runId = automation.lastResult?.runId;
      if (runId && automation.lastResult?.status === 'running') {
        const status = this.store.getRun(runId)?.status ?? 'interrupted';
        if (status !== 'running') this.save({ ...automation, lastResult: { ...automation.lastResult!, status } });
      }
    }
    this.tick(true);
  }

  /** Stops the timer and every approval timeout; called on shutdown. */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.denyTimers.values()) clearTimeout(timer);
    this.denyTimers.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Whether a timer is armed (tests and diagnostics). */
  get armed() {
    return this.timer !== undefined;
  }
  get pendingDenials() {
    return this.denyTimers.size;
  }

  list() {
    this.refreshStale();
    return this.store.listAutomations();
  }

  /** Recomputes next runs and the timer; call after any change to automations or settings. */
  reschedule() {
    if (this.stopped) return;
    this.refreshStale();
    this.arm();
  }

  /**
   * Due times in the past that will not run (switch off, or just turned on) move to the next
   * occurrence, so the list never shows a stale "next run" and turning the switch on later
   * does not fire a backlog.
   */
  private refreshStale() {
    const now = this.now();
    for (const automation of this.store.listAutomations()) {
      if (!automation.enabled) continue;
      const due = automation.nextRunAt ? Date.parse(automation.nextRunAt) : NaN;
      if (Number.isNaN(due) || (due <= now && !this.globalOn()))
        this.save({ ...automation, nextRunAt: this.next(automation, now) });
    }
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.globalOn()) return;
    const dues = this.store
      .listAutomations()
      .filter((a) => a.enabled && a.nextRunAt)
      .map((a) => Date.parse(a.nextRunAt!));
    if (!dues.length) return;
    const wait = Math.min(Math.max(0, Math.min(...dues) - this.now()), MAX_WAIT_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick(false);
    }, wait);
    this.timer.unref?.();
  }

  /**
   * Runs every due automation once. An occurrence counts as missed when found at startup or
   * when the timer fired more than LATE_TOLERANCE_MS late (the computer slept); missed ones
   * run only with catchUp. The next occurrence is always computed from now.
   */
  private tick(startup: boolean) {
    if (this.stopped) return;
    const now = this.now();
    if (this.globalOn())
      for (const automation of this.store.listAutomations()) {
        if (!automation.enabled || !automation.nextRunAt) continue;
        const due = Date.parse(automation.nextRunAt);
        if (due > now) continue;
        const missed = startup || now - due > LATE_TOLERANCE_MS;
        const advanced = this.save({ ...automation, nextRunAt: this.next(automation, now) });
        if (missed && !automation.catchUp) continue;
        void this.fire(advanced.id, missed ? 'catch-up' : 'schedule');
      }
    this.refreshStale();
    this.arm();
  }

  /**
   * Starts one occurrence. Refused while the global switch is off; skipped (and recorded) when
   * the automation's conversation already has a run, a start in progress or an executing plan.
   */
  async fire(id: string, trigger: Trigger): Promise<FireResult> {
    const automation = this.store.getAutomation(id);
    if (!automation) throw httpError(404, 'automations.notFound');
    if (!this.globalOn())
      return {
        ok: false,
        automation,
        status: 409,
        message: AUTOMATION_GLOBAL_OFF,
        reason: { key: 'automations.globalOff' },
      };
    const project = this.store.getProject(automation.projectId);
    if (!project)
      return this.record(automation, trigger, 'failed', 'Projeto não encontrado', 404, {
        key: 'common.projectNotFound',
      });
    const existing = automation.conversationId ? this.store.getSession(automation.conversationId) : undefined;
    if (
      this.firing.has(id) ||
      (existing &&
        (existing.activeRunId ||
          this.orchestrator.isActive(existing.id) ||
          this.store.listPlans(existing.id).some((plan) => plan.status === 'executing')))
    )
      return this.record(automation, trigger, 'skipped', AUTOMATION_SKIPPED_ACTIVE, 409, {
        key: 'automations.skippedActive',
      });
    this.firing.add(id);
    try {
      const session = this.conversation(automation, existing);
      const current = { ...automation, conversationId: session.id };
      const started = await this.orchestrator.start(session, automation.prompt, undefined, [], {
        automationId: automation.id,
      });
      const at = new Date(this.now()).toISOString();
      const latest = this.store.getAutomation(id);
      // Deleted meanwhile: nothing to record; the run continues in its conversation.
      if (!latest) return { ok: true, automation: current, started };
      const saved = this.save({
        ...latest,
        conversationId: session.id,
        lastRunAt: at,
        lastResult: { runId: started.runId, status: this.runStatus(started.runId), at, trigger },
      });
      this.emit();
      return { ok: true, automation: saved, started };
    } catch (error) {
      const status = (error as { status?: number }).status;
      const latest = this.store.getAutomation(id);
      if (!latest) throw error;
      // A conflict found by the orchestrator itself (a run started meanwhile) is a skip too.
      return status === 409 && /execução ativa/.test(String((error as Error).message))
        ? this.record(latest, trigger, 'skipped', AUTOMATION_SKIPPED_ACTIVE, 409, { key: 'automations.skippedActive' })
        : this.record(
            latest,
            trigger,
            'failed',
            (error as Error).message.slice(0, 300),
            status ?? 500,
            errorKey(error),
          );
    } finally {
      this.firing.delete(id);
    }
  }

  /** The run may already have finished by the time start() returns (fast providers). */
  private runStatus(runId: string): Run['status'] {
    return this.store.getRun(runId)?.status ?? 'running';
  }

  private record(
    automation: Automation,
    trigger: Trigger,
    status: 'skipped' | 'failed',
    detail: string,
    httpStatus: number,
    /** The answer's catalog key; `detail` (pt-BR) is what the automation keeps as history. */
    reason?: Translatable,
  ): FireResult {
    const at = new Date(this.now()).toISOString();
    const saved = this.save({ ...automation, lastResult: { status, at, trigger, detail } });
    this.emit();
    return { ok: false, automation: saved, status: httpStatus, message: detail, ...(reason ? { reason } : {}) };
  }

  /**
   * The automation's conversation: created on the first run, then reused. Its title follows the
   * automation's name, and the automation's agent, model and mode (when set) are applied before
   * each run; a different agent or model starts a fresh native session, like a manual change.
   */
  private conversation(automation: Automation, existing: Session | undefined): Session {
    const settings = this.store.getSettings()!;
    const now = new Date(this.now()).toISOString();
    if (!existing || existing.projectId !== automation.projectId) {
      const created = this.store.putSession({
        id: randomUUID(),
        projectId: automation.projectId,
        title: automationTitle(automation.name),
        providerId: automation.providerId ?? settings.defaultProviderId,
        ...(automation.model ? { model: automation.model } : {}),
        mode: automation.mode ?? settings.defaultMode,
        createdAt: now,
        updatedAt: now,
      });
      // Clients add conversations they do not know on a refresh.
      this.orchestrator.publish({ type: 'refresh' });
      return created;
    }
    const next: Session = { ...existing, title: automationTitle(automation.name) };
    if (automation.providerId && automation.providerId !== existing.providerId) {
      next.providerId = automation.providerId;
      delete next.model;
      delete next.nativeSessionId;
    }
    if (automation.model && automation.model !== next.model) {
      next.model = automation.model;
      delete next.nativeSessionId;
    }
    if (automation.mode) next.mode = automation.mode;
    if (JSON.stringify(next) === JSON.stringify(existing)) return existing;
    this.store.putSession(next);
    this.orchestrator.publish({ type: 'session', session: next });
    return next;
  }

  private onEvent(event: StreamEvent) {
    if (event.type === 'run') this.onRun(event.run);
    else if (event.type === 'approval') {
      const { approval } = event;
      if (approval.status !== 'pending') {
        const timer = this.denyTimers.get(approval.id);
        if (timer) clearTimeout(timer);
        this.denyTimers.delete(approval.id);
        return;
      }
      const automation = this.automationOfRun(approval.sessionId, approval.runId);
      const minutes = automation?.denyApprovalsAfterMinutes;
      if (!minutes || this.denyTimers.has(approval.id) || this.stopped) return;
      const timer = setTimeout(() => {
        this.denyTimers.delete(approval.id);
        // Only ever deny: an unattended run never gets an approval it did not ask a person for.
        void this.orchestrator
          .decide(
            approval.id,
            approval.sessionId,
            'deny',
            `Negado automaticamente após ${minutes} min sem resposta (automação)`,
          )
          .catch(() => undefined);
      }, minutes * 60_000);
      timer.unref?.();
      this.denyTimers.set(approval.id, timer);
    }
  }

  /** The automation that sent a run's user message (Message.automationId), if any. */
  private automationOfRun(sessionId: string, runId: string) {
    const id = this.store
      .listMessages(sessionId)
      .find((m) => m.runId === runId && m.role === 'user' && m.automationId)?.automationId;
    return id ? this.store.getAutomation(id) : undefined;
  }

  /** Final status of a run an automation started, for "Último resultado". */
  private onRun(run: Run) {
    if (run.status === 'running') return;
    const automation = this.store.listAutomations().find((a) => a.lastResult?.runId === run.id);
    if (!automation || automation.lastResult!.status === run.status) return;
    this.save({ ...automation, lastResult: { ...automation.lastResult!, status: run.status } });
    this.emit();
  }

  /**
   * The global switch changed. Turning it on never fires a backlog: due times already in the
   * past move to their next occurrence. Turning it off clears the timer.
   */
  globalChanged() {
    if (this.stopped) return;
    if (this.globalOn()) {
      const now = this.now();
      for (const automation of this.store.listAutomations())
        if (automation.enabled && (!automation.nextRunAt || Date.parse(automation.nextRunAt) <= now))
          this.save({ ...automation, nextRunAt: this.next(automation, now) });
    }
    this.reschedule();
    this.emit();
  }
}
