import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { ProviderInfo, Session } from '../../shared/contracts.js';
import { validReasoningEffort, supportsEffort } from '../../shared/reasoning.js';
import { error, errorStatus, message, str } from './common.js';
import { modes, validProviders } from './validation.js';
import type { BackendContext } from './context.js';

function knownModel(catalog: ProviderInfo[], providerId: string, model: string) {
  const provider = catalog.find((p) => p.id === providerId);
  return Boolean(provider && provider.models.some((item) => item.id === model));
}

export function sessionsRoutes({ store, orchestrator, providerList }: BackendContext) {
  const app = Router();
  app.post('/api/sessions', async (req, res) => {
    const rawProjectId = req.body?.projectId;
    if (rawProjectId !== undefined && rawProjectId !== null && typeof rawProjectId !== 'string')
      return error(res, 400, 'projectId inválido');
    const projectId = rawProjectId === null ? undefined : str(rawProjectId);
    if (rawProjectId !== undefined && rawProjectId !== null && !projectId) return error(res, 400, 'projectId inválido');
    const project = projectId ? store.getProject(projectId) : undefined;
    if (projectId && !project) return error(res, 404, 'Projeto não encontrado');
    const providerId =
      req.body?.providerId === undefined ? store.getSettings()!.defaultProviderId : req.body.providerId;
    if (!validProviders.has(providerId)) return error(res, 400, 'providerId inválido');
    const mode = req.body?.mode === undefined ? store.getSettings()!.defaultMode : req.body.mode;
    if (!modes.has(mode)) return error(res, 400, 'mode inválido');
    const model = req.body?.model === undefined ? undefined : str(req.body.model, 120);
    if (req.body?.model !== undefined && !model) return error(res, 400, 'model inválido');
    const thinking = req.body?.thinking === undefined ? undefined : req.body.thinking;
    if (thinking !== undefined && thinking !== 'auto' && !validReasoningEffort(thinking))
      return error(res, 400, 'thinking inválido');
    const needsCatalog = Boolean(model) || (thinking !== undefined && thinking !== 'auto');
    const catalog = needsCatalog ? await providerList() : undefined;
    if (model && catalog && !knownModel(catalog, providerId, model))
      return error(res, 400, 'Modelo não anunciado para este provedor');
    if (
      thinking !== undefined &&
      thinking !== 'auto' &&
      !supportsEffort(
        catalog!.find((p) => p.id === providerId),
        model,
        thinking,
      )
    )
      return error(res, 400, 'Esforço não anunciado para este modelo');
    const now = new Date().toISOString();
    const s: Session = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      title: str(req.body?.title, 160) || 'Nova conversa',
      providerId,
      model,
      mode,
      thinking,
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
    res.status(201).json(s);
  });
  app.get('/api/sessions/:id', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    res.json(store.detail(s));
  });
  app.patch('/api/sessions/:id', async (req, res) => {
    const original = store.getSession(req.params.id);
    if (!original) return error(res, 404, 'Conversa não encontrada');
    if (original.activeRunId || orchestrator.isActive(original.id))
      return error(res, 409, 'Não é possível alterar uma conversa em execução');
    const snapshot = structuredClone(original),
      body = req.body || {};
    let projectId = snapshot.projectId;
    if (body.projectId !== undefined) {
      if (body.projectId !== null && typeof body.projectId !== 'string') return error(res, 400, 'projectId inválido');
      const value = body.projectId === null ? undefined : str(body.projectId);
      if (body.projectId !== null && !value) return error(res, 400, 'projectId inválido');
      if (value && !store.getProject(value)) return error(res, 404, 'Projeto não encontrado');
      projectId = value ?? null;
    }
    const title = body.title === undefined ? snapshot.title : str(body.title, 160);
    if (!title) return error(res, 400, 'title inválido');
    const providerId = body.providerId === undefined ? snapshot.providerId : body.providerId;
    if (!validProviders.has(providerId)) return error(res, 400, 'providerId inválido');
    const providerChanged = providerId !== snapshot.providerId;
    let model = snapshot.model;
    if (providerChanged && body.model === undefined) model = undefined;
    if (body.model !== undefined) {
      if (body.model !== null && !str(body.model, 120)) return error(res, 400, 'model inválido');
      model = body.model === null ? undefined : str(body.model, 120);
    }
    const mode = body.mode === undefined ? snapshot.mode : body.mode;
    if (!modes.has(mode)) return error(res, 400, 'mode inválido');
    const modelChanged = model !== snapshot.model;
    let thinking = body.thinking === undefined ? snapshot.thinking : body.thinking;
    if (thinking !== undefined && thinking !== 'auto' && !validReasoningEffort(thinking))
      return error(res, 400, 'thinking inválido');
    let catalog: ProviderInfo[] | undefined;
    if (body.model !== undefined && model) {
      catalog = await providerList();
      if (!knownModel(catalog, providerId, model)) return error(res, 400, 'Modelo não anunciado para este provedor');
    }
    if ((providerChanged || modelChanged) && body.thinking === undefined) thinking = 'auto';
    if (body.thinking !== undefined && thinking !== undefined && thinking !== 'auto') {
      catalog ??= await providerList();
      if (
        !supportsEffort(
          catalog.find((p) => p.id === providerId),
          model,
          thinking,
        )
      )
        return error(res, 400, 'Esforço não anunciado para este modelo');
    }
    const current = store.getSession(req.params.id);
    if (!current) return error(res, 404, 'Conversa não encontrada');
    if (
      current.activeRunId ||
      orchestrator.isActive(current.id) ||
      JSON.stringify(current) !== JSON.stringify(snapshot)
    )
      return error(res, 409, 'A conversa mudou durante a atualização');
    const next: Session = {
      ...current,
      projectId,
      title,
      providerId,
      model,
      mode,
      thinking,
      updatedAt: new Date().toISOString(),
    };
    if (projectId !== snapshot.projectId || providerChanged || modelChanged) delete next.nativeSessionId;
    store.putSession(next);
    res.json(next);
  });
  app.delete('/api/sessions/:id', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    if (s.activeRunId) return error(res, 409, 'Conversa em execução');
    store.deleteSession(s.id);
    res.status(204).end();
  });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    const content = str(req.body?.content, 32000);
    if (!content) return error(res, 400, 'content obrigatório (máximo 32000 caracteres)');
    const clientMessageId = req.body?.clientMessageId === undefined ? undefined : str(req.body.clientMessageId, 128);
    if (req.body?.clientMessageId !== undefined && !clientMessageId) return error(res, 400, 'clientMessageId inválido');
    try {
      const result = await orchestrator.start(s, content, clientMessageId);
      res.status(202).json(result);
    } catch (e) {
      const status = errorStatus(e) || 500;
      error(res, status, message(e));
    }
  });
  app.post('/api/sessions/:id/cancel', async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'Conversa não encontrada');
    try {
      await orchestrator.cancel(req.params.id);
      res.status(202).json({ ok: true });
    } catch (e) {
      error(res, errorStatus(e) || 500, message(e));
    }
  });
  app.post('/api/approvals/:id', async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'deny'].includes(decision)) return error(res, 400, 'decision deve ser approve ou deny');
    const a = store.getApproval(req.params.id);
    if (!a) return error(res, 404, 'Aprovação não encontrada');
    try {
      await orchestrator.decide(a.id, a.sessionId, decision);
      res.json(store.getApproval(a.id));
    } catch (e) {
      error(res, errorStatus(e) || 500, message(e));
    }
  });
  app.get('/api/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'refresh' })}\n\n`);
    const unsub = orchestrator.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });
  return app;
}
