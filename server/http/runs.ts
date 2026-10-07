import { Router } from 'express';
import { CheckpointError, checkpointDiff } from '../checkpoints.js';
import { RestoreRunSchema, parseBody, text } from '../../shared/schemas.js';
import { error, errorStatus, message } from './common.js';
import type { BackendContext } from './context.js';

const pathQuery = text(4096);

/** What a run changed in the project (checkpoints), its diffs and undo. */
export function runsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.get('/api/runs/:id/changes', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return error(res, 404, 'Execução não encontrada');
    const c = run.checkpoint;
    res.json({
      available: Boolean(c?.available),
      ...(c?.reason ? { reason: c.reason } : {}),
      files: c?.files ?? [],
      ...(c?.omitted ? { omitted: c.omitted } : {}),
      ...(c?.restoredAt ? { restoredAt: c.restoredAt } : {}),
    });
  });
  app.get('/api/runs/:id/diff', async (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return error(res, 404, 'Execução não encontrada');
    const path = pathQuery.safeParse(req.query.path);
    if (!path.success) return error(res, 400, 'path obrigatório');
    try {
      res.json(await checkpointDiff(run.id, run.checkpoint, path.data));
    } catch (e) {
      error(res, e instanceof CheckpointError ? e.status : errorStatus(e) || 500, message(e));
    }
  });
  app.post('/api/runs/:id/restore', async (req, res) => {
    const parsed = parseBody(RestoreRunSchema, req.body, 'confirm: true é obrigatório para desfazer alterações');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(await orchestrator.restoreRun(req.params.id));
    } catch (e) {
      const status = e instanceof CheckpointError ? e.status : errorStatus(e) || 500;
      const conflicts = e instanceof CheckpointError ? e.conflicts : undefined;
      res.status(status).json({ error: message(e), ...(conflicts ? { conflicts } : {}) });
    }
  });
  return app;
}
