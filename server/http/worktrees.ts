import { Router, type Response } from 'express';
import { CheckpointError } from '../checkpoints.js';
import {
  ApplyWorktreeSchema,
  CreateWorktreeSchema,
  DiscardWorktreeSchema,
  parseBody,
  text,
} from '../../shared/schemas.js';
import { error, errorStatus, message } from './common.js';
import type { BackendContext } from './context.js';

const pathQuery = text(4096);

function fail(res: Response, e: unknown) {
  const status = e instanceof CheckpointError ? e.status : errorStatus(e) || 500;
  const conflicts = e instanceof CheckpointError ? e.conflicts : undefined;
  res.status(status).json({ error: message(e), ...(conflicts ? { conflicts } : {}) });
}

/** Isolated git worktree per conversation (docs/specs/worktrees.md). */
export function worktreesRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  const base = '/api/sessions/:id/worktree';
  app.get(base, async (req, res) => {
    try {
      res.json(await orchestrator.worktreeInfo(req.params.id));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(base, async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'Conversa não encontrada');
    const parsed = parseBody(CreateWorktreeSchema, req.body, 'Criar a cópia isolada não aceita opções');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      const session = await orchestrator.enableWorktree(req.params.id);
      res.status(201).json({ session, status: await orchestrator.worktreeInfo(req.params.id) });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(`${base}/diff`, async (req, res) => {
    const path = pathQuery.safeParse(req.query.path);
    if (!path.success) return error(res, 400, 'path obrigatório');
    try {
      res.json(await orchestrator.worktreeFileDiff(req.params.id, path.data));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(`${base}/apply`, async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'Conversa não encontrada');
    const parsed = parseBody(ApplyWorktreeSchema, req.body, 'confirm: true é obrigatório para aplicar no projeto');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(await orchestrator.applyWorktree(req.params.id));
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete(base, async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'Conversa não encontrada');
    const parsed = parseBody(DiscardWorktreeSchema, req.body, 'Pedido inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(await orchestrator.discardWorktree(req.params.id, parsed.data.deleteBranch ?? false));
    } catch (e) {
      fail(res, e);
    }
  });
  return app;
}
