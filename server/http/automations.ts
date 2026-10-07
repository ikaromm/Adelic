import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_DENY_DEFAULT_MINUTES,
  automationTitle,
  nextOccurrence,
  systemTimeZone,
  type Automation,
} from '../../shared/automations.js';
import { CreateAutomationSchema, PatchAutomationSchema, parseBody } from '../../shared/schemas.js';
import { error, errorStatus, message } from './common.js';
import type { BackendContext } from './context.js';

/** Scheduled automations (docs/specs/automations.md). */
export function automationsRoutes({ store, providerList, orchestrator, automations: service }: BackendContext) {
  const app = Router();
  const knownModel = async (providerId: string, model: string) =>
    (await providerList()).some((p) => p.id === providerId && p.models.some((m) => m.id === model));
  const nextRun = (automation: Automation, now: number) =>
    new Date(
      nextOccurrence(automation.schedule, automation.timezone, now, Date.parse(automation.anchorAt)),
    ).toISOString();

  app.get('/api/automations', (_req, res) => {
    res.json({ automations: service.list(), enabled: store.getSettings()?.automations === true });
  });
  app.post('/api/automations', async (req, res) => {
    const parsed = parseBody(CreateAutomationSchema, req.body, 'Automação inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const body = parsed.data;
    if (!store.getProject(body.projectId)) return error(res, 404, 'Projeto não encontrado');
    if (body.model && !(await knownModel(body.providerId ?? store.getSettings()!.defaultProviderId, body.model)))
      return error(res, 400, 'Modelo não anunciado para este provedor');
    const now = service.now();
    const at = new Date(now).toISOString();
    const automation: Automation = {
      id: randomUUID(),
      name: body.name,
      prompt: body.prompt,
      projectId: body.projectId,
      ...(body.providerId ? { providerId: body.providerId } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      schedule: body.schedule,
      timezone: body.timezone ?? systemTimeZone(),
      // Created disabled unless explicitly asked otherwise: the user turns it on.
      enabled: body.enabled ?? false,
      catchUp: body.catchUp ?? false,
      denyApprovalsAfterMinutes:
        body.denyApprovalsAfterMinutes === undefined ? AUTOMATION_DENY_DEFAULT_MINUTES : body.denyApprovalsAfterMinutes,
      anchorAt: at,
      createdAt: at,
      updatedAt: at,
    };
    if (automation.enabled) automation.nextRunAt = nextRun(automation, now);
    store.putAutomation(automation);
    service.reschedule();
    orchestrator.publish({ type: 'automations' });
    res.status(201).json(store.getAutomation(automation.id));
  });
  app.patch('/api/automations/:id', async (req, res) => {
    const current = store.getAutomation(req.params.id);
    if (!current) return error(res, 404, 'Automação não encontrada');
    const parsed = parseBody(PatchAutomationSchema, req.body, 'Automação inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const patch = parsed.data;
    if (patch.projectId && !store.getProject(patch.projectId)) return error(res, 404, 'Projeto não encontrado');
    const now = service.now();
    const next: Automation = { ...current, updatedAt: new Date(now).toISOString() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.prompt !== undefined) next.prompt = patch.prompt;
    if (patch.projectId !== undefined && patch.projectId !== current.projectId) {
      next.projectId = patch.projectId;
      // The conversation belongs to the old project; a new one is created on the next run.
      delete next.conversationId;
    }
    for (const key of ['providerId', 'model', 'mode'] as const) {
      const value = patch[key];
      if (value === null) delete next[key];
      else if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    if (patch.providerId !== undefined && patch.model === undefined && patch.providerId !== current.providerId)
      delete next.model;
    if (next.model && (patch.model !== undefined || patch.providerId !== undefined))
      if (!(await knownModel(next.providerId ?? store.getSettings()!.defaultProviderId, next.model)))
        return error(res, 400, 'Modelo não anunciado para este provedor');
    if (patch.timezone !== undefined) next.timezone = patch.timezone;
    if (patch.catchUp !== undefined) next.catchUp = patch.catchUp;
    if (patch.denyApprovalsAfterMinutes !== undefined) next.denyApprovalsAfterMinutes = patch.denyApprovalsAfterMinutes;
    const scheduleChanged =
      (patch.schedule !== undefined && JSON.stringify(patch.schedule) !== JSON.stringify(current.schedule)) ||
      (patch.timezone !== undefined && patch.timezone !== current.timezone);
    if (patch.schedule !== undefined) next.schedule = patch.schedule;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    const turnedOn = next.enabled && !current.enabled;
    // An interval restarts counting from now when its schedule changes or it is turned on.
    if (scheduleChanged || turnedOn) next.anchorAt = next.updatedAt;
    if (!next.enabled) delete next.nextRunAt;
    else if (scheduleChanged || turnedOn || !next.nextRunAt) next.nextRunAt = nextRun(next, now);
    store.putAutomation(next);
    const session = next.conversationId ? store.getSession(next.conversationId) : undefined;
    if (session && patch.name !== undefined && session.title !== automationTitle(next.name)) {
      const renamed = store.putSession({ ...session, title: automationTitle(next.name) });
      orchestrator.publish({ type: 'session', session: renamed });
    }
    service.reschedule();
    orchestrator.publish({ type: 'automations' });
    res.json(store.getAutomation(next.id));
  });
  // The conversation stays: it is ordinary history the user can read or delete.
  app.delete('/api/automations/:id', (req, res) => {
    if (!store.deleteAutomation(req.params.id)) return error(res, 404, 'Automação não encontrada');
    service.reschedule();
    orchestrator.publish({ type: 'automations' });
    res.status(204).end();
  });
  // "Executar agora": one occurrence now, with the same rules as a scheduled one.
  app.post('/api/automations/:id/run', async (req, res) => {
    try {
      const result = await service.fire(req.params.id, 'manual');
      if (!result.ok) return res.status(result.status).json({ error: result.message, automation: result.automation });
      res.status(202).json({ automation: result.automation, ...result.started });
    } catch (e) {
      error(res, errorStatus(e) || 500, message(e));
    }
  });
  return app;
}
