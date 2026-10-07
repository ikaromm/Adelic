import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Message, ProviderInfo, Session, StoredAttachment } from '../../shared/contracts.js';
import type { Locale } from '../../shared/i18n.js';
import { attachmentMeta, decodeUpload } from '../attachments.js';
import { supportsEffort } from '../../shared/reasoning.js';
import {
  ApprovalDecisionSchema,
  BranchSessionSchema,
  CompactSchema,
  CreateSessionSchema,
  EditMessageSchema,
  HandoffSchema,
  PatchSessionSchema,
  QueueEditSchema,
  QueueMessageSchema,
  QueueResumeSchema,
  SendMessageSchema,
  UploadAttachmentSchema,
  SendNowSchema,
  parseBody,
  text,
  vmsg,
} from '../../shared/schemas.js';
import { forceManualApproval } from './auth.js';
import { error, errorStatus, errorText, failure } from './common.js';
import { localeOf, tr, type ServerKey } from '../i18n.js';

const titleSchema = text(160);
import type { BackendContext } from './context.js';

const UPLOAD_PATH = /^\/api\/sessions\/[^/]+\/attachments\/?$/;
/** The upload route parses its own (larger) JSON body; the global 128 KB parser skips it. */
export const isAttachmentUpload = (req: Request) => req.method === 'POST' && UPLOAD_PATH.test(req.path);
const uploadJson = express.json({ limit: '15mb', strict: true });
function parseUpload(req: Request, res: Response, next: NextFunction) {
  uploadJson(req, res, (e?: unknown) => {
    if ((e as { type?: string } | undefined)?.type === 'entity.too.large')
      return error(res, 413, 'sessions.uploadTooLarge');
    if (e) return error(res, 400, 'common.invalidJson');
    next();
  });
}

const roleKey: Record<Message['role'], ServerKey> = {
  user: 'sessions.export.you',
  assistant: 'sessions.export.agent',
  system: 'sessions.export.system',
};
/**
 * Markdown transcript of a conversation's visible messages (no internal events or tasks). The
 * headings follow `locale`; the messages themselves are exported as they were written.
 */
export function conversationMarkdown(session: Session, messages: Message[], locale?: Locale) {
  const lines = [
    `# ${session.title}`,
    '',
    tr(locale, 'sessions.export.header', { date: new Date().toISOString(), count: messages.length }),
    '',
  ];
  for (const m of messages) {
    if (!m.content.trim()) continue;
    lines.push(`## ${tr(locale, roleKey[m.role])} · ${m.createdAt}`, '', m.content.trim(), '');
  }
  return lines.join('\n');
}

function knownModel(catalog: ProviderInfo[], providerId: string, model: string) {
  const provider = catalog.find((p) => p.id === providerId);
  return Boolean(provider && provider.models.some((item) => item.id === model));
}

const MISSING_ATTACHMENT = 'sessions.attachmentMissing';

export function sessionsRoutes({ store, orchestrator, providerList }: BackendContext) {
  /** Attachments by id, only when every one belongs to the conversation; otherwise undefined. */
  const ownedAttachments = (sessionId: string, ids: string[]): StoredAttachment[] | undefined => {
    const found: StoredAttachment[] = [];
    for (const attachmentId of ids) {
      const attachment = store.getAttachment(attachmentId);
      if (!attachment || attachment.sessionId !== sessionId) return undefined;
      found.push(attachment);
    }
    return found;
  };
  const app = Router();
  app.post('/api/sessions', async (req, res) => {
    const parsed = parseBody(CreateSessionSchema, req.body, 'sessions.invalid', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { projectId, model, thinking } = parsed.data;
    const project = projectId ? store.getProject(projectId) : undefined;
    if (projectId && !project) return error(res, 404, 'common.projectNotFound');
    const providerId = parsed.data.providerId ?? store.getSettings()!.defaultProviderId;
    const mode = parsed.data.mode ?? store.getSettings()!.defaultMode;
    const needsCatalog = Boolean(model) || (thinking !== undefined && thinking !== 'auto');
    const catalog = needsCatalog ? await providerList() : undefined;
    if (model && catalog && !knownModel(catalog, providerId, model))
      return error(res, 400, 'common.modelNotAdvertised');
    if (
      thinking !== undefined &&
      thinking !== 'auto' &&
      !supportsEffort(
        catalog!.find((p) => p.id === providerId),
        model,
        thinking,
      )
    )
      return error(res, 400, 'sessions.effortNotAdvertised');
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
    if (!s) return error(res, 404, 'common.sessionNotFound');
    res.json(store.detail(s));
  });
  app.get('/api/search', (req, res) => {
    const q = titleSchema.safeParse(req.query.q);
    if (!q.success) return error(res, 400, 'sessions.searchQuery');
    res.json({ hits: store.searchConversations(q.data) });
  });
  // Export one conversation: Markdown with the visible messages, or the full JSON detail.
  app.get('/api/sessions/:id/export', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'common.sessionNotFound');
    const format = req.query.format === 'json' ? 'json' : 'md';
    const slug =
      s.title
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
        .slice(0, 60) || tr(req.locale, 'sessions.export.slug');
    res.setHeader('content-disposition', `attachment; filename="adelic-${slug}.${format}"`);
    if (format === 'json') return res.json(store.detail(s));
    res.type('text/markdown; charset=utf-8').send(conversationMarkdown(s, store.listMessages(s.id), localeOf(req)));
  });
  app.patch('/api/sessions/:id', async (req, res) => {
    const original = store.getSession(req.params.id);
    if (!original) return error(res, 404, 'common.sessionNotFound');
    if (original.activeRunId || orchestrator.isActive(original.id)) return error(res, 409, 'sessions.running');
    const snapshot = structuredClone(original);
    // Field order in PatchSessionSchema matches the previous checks, so the first error is unchanged.
    const parsed = parseBody(PatchSessionSchema, req.body, 'sessions.invalid', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const body = parsed.data;
    let projectId = snapshot.projectId;
    if (body.projectId !== undefined) {
      if (body.projectId && !store.getProject(body.projectId)) return error(res, 404, 'common.projectNotFound');
      projectId = body.projectId;
    }
    if (snapshot.worktree && projectId !== snapshot.projectId) return error(res, 409, 'sessions.dropWorktreeFirst');
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
      if (!knownModel(catalog, providerId, model)) return error(res, 400, 'common.modelNotAdvertised');
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
        return error(res, 400, 'sessions.effortNotAdvertised');
    }
    const current = store.getSession(req.params.id);
    if (!current) return error(res, 404, 'common.sessionNotFound');
    if (
      current.activeRunId ||
      orchestrator.isActive(current.id) ||
      JSON.stringify(current) !== JSON.stringify(snapshot)
    )
      return error(res, 409, 'sessions.changedDuringUpdate');
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
    if (body.planFirst !== undefined) {
      if (body.planFirst) next.planFirst = true;
      else delete next.planFirst;
    }
    if (projectId !== snapshot.projectId || providerChanged || modelChanged) delete next.nativeSessionId;
    store.putSession(next);
    res.json(next);
  });
  // "Continuar com outro agente": switch provider, optionally carrying a summary.
  app.post('/api/sessions/:id/handoff', async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'common.sessionNotFound');
    const parsed = parseBody(HandoffSchema, req.body, 'sessions.invalidHandoff', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { overrideLimit, ...request } = parsed.data;
    try {
      res.status(202).json(await orchestrator.handoff(req.params.id, request, { overrideLimit }));
    } catch (e) {
      failure(res, e);
    }
  });
  app.delete('/api/sessions/:id', async (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'common.sessionNotFound');
    if (s.activeRunId || orchestrator.isActive(s.id)) return error(res, 409, 'sessions.busy');
    // The worktree folder goes with the conversation; its branch stays unless merged.
    await orchestrator.dropWorktree(s);
    store.deleteSession(s.id);
    res.status(204).end();
  });
  app.post('/api/sessions/:id/attachments', parseUpload, (req, res) => {
    const s = store.getSession(String(req.params.id));
    if (!s) return error(res, 404, 'common.sessionNotFound');
    const parsed = parseBody(UploadAttachmentSchema, req.body, 'sessions.invalidAttachment', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { name, mime, data } = parsed.data;
    const decoded = decodeUpload(name, mime ?? '', data);
    if (!decoded.ok) return error(res, 400, decoded.key, decoded.vars);
    try {
      const saved = store.saveAttachment(s.id, name, decoded.kind, decoded.mime, decoded.bytes);
      res.status(201).json(attachmentMeta(saved));
    } catch (e) {
      error(res, 500, 'sessions.attachmentSaveFailed', { detail: errorText(res, e) });
    }
  });
  // Serves a stored attachment (thumbnails, opening a file). Only ids known to the store.
  app.get('/api/attachments/:id', async (req, res) => {
    const attachment = store.getAttachment(req.params.id);
    if (!attachment) return error(res, 404, 'sessions.attachmentNotFound');
    let body: Buffer;
    try {
      body = await readFile(store.attachmentPath(attachment));
    } catch {
      return error(res, 404, 'sessions.attachmentNotFound');
    }
    res.set({
      'Content-Type': attachment.kind === 'image' ? attachment.mime : 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    });
    res.send(body);
  });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'common.sessionNotFound');
    const parsed = parseBody(SendMessageSchema, req.body, vmsg('validation.content', { max: 32000 }), req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { content, clientMessageId, attachmentIds = [], overrideLimit } = parsed.data;
    const attachments = ownedAttachments(s.id, attachmentIds);
    if (!attachments) return error(res, 400, MISSING_ATTACHMENT);
    try {
      const result = await orchestrator.start(s, content, clientMessageId, attachments, {
        overrideLimit,
        ...(forceManualApproval(req, store) ? { manualApproval: true } : {}),
      });
      res.status(202).json(result);
    } catch (e) {
      failure(res, e);
    }
  });
  // Edit and resend, and branch a conversation (docs/specs/edit-branch.md).
  app.post('/api/sessions/:id/messages/:messageId/edit', async (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'common.sessionNotFound');
    // The message itself is checked by the orchestrator, after the clientMessageId lookup:
    // a repeated request finds its run even though the edited message no longer exists.
    const parsed = parseBody(EditMessageSchema, req.body, vmsg('validation.content', { max: 32000 }), req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { content, clientMessageId, attachmentIds, overrideLimit } = parsed.data;
    const attachments = attachmentIds ? ownedAttachments(s.id, attachmentIds) : undefined;
    if (attachmentIds && !attachments) return error(res, 400, MISSING_ATTACHMENT);
    try {
      const result = await orchestrator.editAndResend(
        s.id,
        req.params.messageId,
        content,
        attachments,
        clientMessageId,
        overrideLimit,
        forceManualApproval(req, store),
      );
      res.status(202).json(result);
    } catch (e) {
      failure(res, e);
    }
  });
  // Conversation compaction (docs/specs/compaction.md): one read-only summary call.
  app.post('/api/sessions/:id/compact', async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'common.sessionNotFound');
    const parsed = parseBody(CompactSchema, req.body, 'sessions.compactNoOptions', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      const { runId } = await orchestrator.compact(req.params.id, { overrideLimit: parsed.data.overrideLimit });
      res.status(202).json({ runId });
    } catch (e) {
      failure(res, e);
    }
  });
  app.post('/api/sessions/:id/branch', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'common.sessionNotFound');
    const parsed = parseBody(
      BranchSessionSchema,
      req.body,
      vmsg('validation.requiredField', { field: 'messageId' }),
      req.locale,
    );
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.status(201).json(store.branchSession(s.id, parsed.data.messageId));
    } catch (e) {
      const status = errorStatus(e);
      if (status) error(res, status, e as Error);
      else error(res, 500, 'sessions.branchFailed', { detail: errorText(res, e) });
    }
  });
  app.get('/api/sessions/:id/compactions', (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'common.sessionNotFound');
    res.json({ compactions: store.listCompactions(req.params.id) });
  });
  app.post('/api/sessions/:id/cancel', async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'common.sessionNotFound');
    try {
      await orchestrator.cancel(req.params.id);
      res.status(202).json({ ok: true });
    } catch (e) {
      error(res, errorStatus(e) || 500, e as Error);
    }
  });
  // Message queue: waits for the active run, then starts on its own (docs/specs/message-queue.md).
  // Queued messages keep their attachment ids; ownership is checked here and again when they start.
  const queueRoute =
    (handler: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      if (!store.getSession(String(req.params.id))) return error(res, 404, 'common.sessionNotFound');
      try {
        await handler(req, res);
      } catch (e) {
        failure(res, e);
      }
    };
  const id = (req: Request, key = 'id') => String(req.params[key]);
  app.get(
    '/api/sessions/:id/queue',
    queueRoute((req, res) => res.json(orchestrator.queue(id(req)))),
  );
  app.post(
    '/api/sessions/:id/queue',
    queueRoute(async (req, res) => {
      const parsed = parseBody(QueueMessageSchema, req.body, vmsg('validation.content', { max: 32000 }), req.locale);
      if (!parsed.ok) return error(res, 400, parsed.message);
      const attachments = ownedAttachments(id(req), parsed.data.attachmentIds ?? []);
      if (!attachments) return error(res, 400, MISSING_ATTACHMENT);
      const result = await orchestrator.enqueue(
        id(req),
        parsed.data.content,
        parsed.data.clientId,
        attachments.map(attachmentMeta),
        parsed.data.overrideLimit === true,
        forceManualApproval(req, store),
      );
      res.status(result.started ? 202 : 201).json({ ...result, queue: orchestrator.queue(id(req)) });
    }),
  );
  app.patch(
    '/api/sessions/:id/queue/:itemId',
    queueRoute((req, res) => {
      const parsed = parseBody(QueueEditSchema, req.body, vmsg('validation.content', { max: 32000 }), req.locale);
      if (!parsed.ok) return error(res, 400, parsed.message);
      res.json(orchestrator.editQueued(id(req), id(req, 'itemId'), parsed.data.content));
    }),
  );
  app.delete(
    '/api/sessions/:id/queue/:itemId',
    queueRoute((req, res) => {
      orchestrator.removeQueued(id(req), id(req, 'itemId'));
      res.status(204).end();
    }),
  );
  app.post(
    '/api/sessions/:id/queue/resume',
    queueRoute(async (req, res) => {
      const parsed = parseBody(QueueResumeSchema, req.body, 'common.invalidRequest', req.locale);
      if (!parsed.ok) return error(res, 400, parsed.message);
      res.json(await orchestrator.resumeQueue(id(req), parsed.data.overrideLimit === true));
    }),
  );
  app.post(
    '/api/sessions/:id/queue/:itemId/steer',
    queueRoute(async (req, res) => {
      await orchestrator.steerQueued(id(req), id(req, 'itemId'));
      res.status(202).json({ ok: true, queue: orchestrator.queue(id(req)) });
    }),
  );
  app.post(
    '/api/sessions/:id/send-now',
    queueRoute(async (req, res) => {
      const parsed = parseBody(SendNowSchema, req.body, 'sessions.sendNowBody', req.locale);
      if (!parsed.ok) return error(res, 400, parsed.message);
      const { content, clientId, itemId, attachmentIds = [], overrideLimit } = parsed.data;
      if (Boolean(content) === Boolean(itemId)) return error(res, 400, 'sessions.sendNowBody');
      if (itemId && attachmentIds.length) return error(res, 400, 'sessions.attachmentIdsWithContent');
      const attachments = ownedAttachments(id(req), attachmentIds);
      if (!attachments) return error(res, 400, MISSING_ATTACHMENT);
      const result = await orchestrator.sendNow(
        id(req),
        itemId ? { itemId } : { content: content!, clientId, attachments: attachments.map(attachmentMeta) },
        overrideLimit === true,
        forceManualApproval(req, store),
      );
      res.status(202).json({ ...result, queue: orchestrator.queue(id(req)) });
    }),
  );
  app.post('/api/approvals/:id', async (req, res) => {
    const parsed = parseBody(
      ApprovalDecisionSchema,
      req.body,
      vmsg('validation.oneOf2', { field: 'decision', a: 'approve', b: 'deny' }),
      req.locale,
    );
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { decision } = parsed.data;
    const a = store.getApproval(req.params.id);
    if (!a) return error(res, 404, 'sessions.approvalNotFound');
    try {
      await orchestrator.decide(a.id, a.sessionId, decision);
      res.json(store.getApproval(a.id));
    } catch (e) {
      error(res, errorStatus(e) || 500, e as Error);
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
