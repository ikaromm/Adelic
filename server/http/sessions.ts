import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Message, ProviderInfo, Session } from '../../shared/contracts.js';
import { supportsEffort } from '../../shared/reasoning.js';
import {
  ApprovalDecisionSchema,
  CreateSessionSchema,
  PatchSessionSchema,
  SendMessageSchema,
  parseBody,
  text,
} from '../../shared/schemas.js';
import { error, errorStatus, message } from './common.js';

const titleSchema = text(160);
import type { BackendContext } from './context.js';

const roleName: Record<Message['role'], string> = { user: 'Você', assistant: 'Agente', system: 'Sistema' };
/** Markdown transcript of a conversation's visible messages (no internal events or tasks). */
export function conversationMarkdown(session: Session, messages: Message[]) {
  const lines = [
    `# ${session.title}`,
    '',
    `Exportado do Adelic em ${new Date().toISOString()} · ${messages.length} mensagens`,
    '',
  ];
  for (const m of messages) {
    if (!m.content.trim()) continue;
    lines.push(`## ${roleName[m.role]} · ${m.createdAt}`, '', m.content.trim(), '');
  }
  return lines.join('\n');
}

function knownModel(catalog: ProviderInfo[], providerId: string, model: string) {
  const provider = catalog.find((p) => p.id === providerId);
  return Boolean(provider && provider.models.some((item) => item.id === model));
}

export function sessionsRoutes({ store, orchestrator, providerList }: BackendContext) {
  const app = Router();
  app.post('/api/sessions', async (req, res) => {
    const parsed = parseBody(CreateSessionSchema, req.body, 'Conversa inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { projectId, model, thinking } = parsed.data;
    const project = projectId ? store.getProject(projectId) : undefined;
    if (projectId && !project) return error(res, 404, 'Projeto não encontrado');
    const providerId = parsed.data.providerId ?? store.getSettings()!.defaultProviderId;
    const mode = parsed.data.mode ?? store.getSettings()!.defaultMode;
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
      title: titleSchema.safeParse(req.body?.title).data || 'Nova conversa',
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
  app.get('/api/search', (req, res) => {
    const q = titleSchema.safeParse(req.query.q);
    if (!q.success) return error(res, 400, 'q obrigatório (até 160 caracteres)');
    res.json({ hits: store.searchConversations(q.data) });
  });
  // Export one conversation: Markdown with the visible messages, or the full JSON detail.
  app.get('/api/sessions/:id/export', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    const format = req.query.format === 'json' ? 'json' : 'md';
    const slug =
      s.title
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
        .slice(0, 60) || 'conversa';
    res.setHeader('content-disposition', `attachment; filename="adelic-${slug}.${format}"`);
    if (format === 'json') return res.json(store.detail(s));
    res.type('text/markdown; charset=utf-8').send(conversationMarkdown(s, store.listMessages(s.id)));
  });
  app.patch('/api/sessions/:id', async (req, res) => {
    const original = store.getSession(req.params.id);
    if (!original) return error(res, 404, 'Conversa não encontrada');
    if (original.activeRunId || orchestrator.isActive(original.id))
      return error(res, 409, 'Não é possível alterar uma conversa em execução');
    const snapshot = structuredClone(original);
    // Field order in PatchSessionSchema matches the previous checks, so the first error is unchanged.
    const parsed = parseBody(PatchSessionSchema, req.body, 'Conversa inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const body = parsed.data;
    let projectId = snapshot.projectId;
    if (body.projectId !== undefined) {
      if (body.projectId && !store.getProject(body.projectId)) return error(res, 404, 'Projeto não encontrado');
      projectId = body.projectId;
    }
    const title = body.title ?? snapshot.title;
    const providerId = body.providerId ?? snapshot.providerId;
    const providerChanged = providerId !== snapshot.providerId;
    let model = snapshot.model;
    if (providerChanged && body.model === undefined) model = undefined;
    if (body.model !== undefined) model = body.model ?? undefined;
    const mode = body.mode ?? snapshot.mode;
    const modelChanged = model !== snapshot.model;
    let thinking = body.thinking === undefined ? snapshot.thinking : body.thinking;
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
    const parsed = parseBody(SendMessageSchema, req.body, 'content obrigatório (máximo 32000 caracteres)');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { content, clientMessageId } = parsed.data;
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
    const parsed = parseBody(ApprovalDecisionSchema, req.body, 'decision deve ser approve ou deny');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { decision } = parsed.data;
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
