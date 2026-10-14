import { readRunArtifactFile } from '../run-artifacts.js';
import { LOCAL_ONLY, requestKind } from './auth.js';
import { Router } from 'express';
import { CheckpointError, checkpointDiff } from '../checkpoints.js';
import { RestoreRunSchema, RetryRunSchema, parseBody, text } from '../../shared/schemas.js';
import { forceManualApproval } from './auth.js';
import { error, errorStatus, errorText, failure } from './common.js';
import type { BackendContext } from './context.js';

const pathQuery = text(4096);

/** What a run changed in the project (checkpoints), its diffs and undo. */
export function runsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.get('/api/runs/:id/changes', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return error(res, 404, 'common.runNotFound');
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
    if (!run) return error(res, 404, 'common.runNotFound');
    const path = pathQuery.safeParse(req.query.path);
    if (!path.success) return error(res, 400, 'validation.requiredField', { field: 'path' });
    try {
      res.json(await checkpointDiff(run.id, run.checkpoint, path.data));
    } catch (e) {
      error(res, e instanceof CheckpointError ? e.status : errorStatus(e) || 500, e as Error);
    }
  });
  app.post('/api/runs/:id/restore', async (req, res) => {
    const parsed = parseBody(RestoreRunSchema, req.body, 'validation.confirm.restore', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(await orchestrator.restoreRun(req.params.id));
    } catch (e) {
      const status = e instanceof CheckpointError ? e.status : errorStatus(e) || 500;
      const conflicts = e instanceof CheckpointError ? e.conflicts : undefined;
      res.status(status).json({ error: errorText(res, e), ...(conflicts ? { conflicts } : {}) });
    }
  });
  app.get('/api/runs/:id/artifacts', (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, LOCAL_ONLY);
    const run = store.getRun(req.params.id);
    if (!run) return error(res, 404, 'common.runNotFound');
    res.json(run.artifacts ?? { status: 'unknown', files: [] });
  });
  app.get('/api/runs/:id/evidence', async (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, LOCAL_ONLY);
    const run = store.getRun(req.params.id);
    if (!run) return error(res, 404, 'common.runNotFound');
    const evidence = await orchestrator.runEvidence.get(run.id).catch(() => undefined);
    if (!evidence) return error(res, 404, 'common.runNotFound');
    const eventId = typeof req.query.checkEventId === 'string' ? req.query.checkEventId : undefined;
    res.setHeader('Cache-Control', 'no-store');
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const limit = Math.min(12_000, Math.max(1, Math.floor(Number(req.query.limit) || 12_000)));
    if (req.query.review === 'true') {
      const full = evidence.fullReview ?? '';
      const review = full.slice(offset, offset + limit);
      return res.json({
        review,
        totalChars: full.length,
        nextOffset: offset + review.length < full.length ? offset + review.length : null,
      });
    }
    if (!eventId) {
      return res.json({
        runId: evidence.runId,
        sessionId: evidence.sessionId,
        capturedAt: evidence.capturedAt,
        source: evidence.source,
        environment: evidence.environment,
        artifacts: evidence.artifacts,
        outcome: evidence.outcome,
        review: evidence.review,
        checks: evidence.checks.map(
          ({ eventId, name, status, exitCode, command, truncated, detail, operationalLog, source, environment }) => ({
            eventId,
            name,
            status,
            exitCode,
            command,
            truncated,
            detail,
            operationalLog,
            source,
            environment,
          }),
        ),
      });
    }
    const check = evidence.checks.find((item) => item.eventId === eventId);
    if (!check) return error(res, 404, 'git.fileNotListed');
    const full = await orchestrator.runEvidence.getCheckLog(run.id, eventId).catch(() => undefined);
    const output = full?.slice(offset, offset + limit) ?? (offset === 0 ? (check.output ?? '').slice(-limit) : '');
    return res.json({
      ...check,
      output,
      totalChars: full?.length ?? (check.output ?? '').length,
      nextOffset: full && offset + output.length < full.length ? offset + output.length : null,
      completeLogAvailable: Boolean(full && check.operationalLog?.status === 'available'),
    });
  });
  app.get('/api/runs/:id/artifacts/file', async (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, LOCAL_ONLY);
    const run = store.getRun(req.params.id);
    if (!run) return error(res, 404, 'common.runNotFound');
    const path = pathQuery.safeParse(req.query.path);
    if (
      !path.success ||
      !run.artifactRoot ||
      !run.artifacts?.files.some((file) => file.path === path.data && file.status !== 'deleted')
    )
      return error(res, 404, 'git.fileNotListed');
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await readRunArtifactFile(run.artifactRoot, path.data));
    } catch {
      error(res, 409, 'git.invalidPath', { path: path.data });
    }
  });
  // "Tentar de novo" and "Tentar com outro modelo": the same request as a new run, optionally
  // after switching the conversation to another provider/model (validated against the catalog).
  app.post('/api/runs/:id/retry', async (req, res) => {
    const parsed = parseBody(RetryRunSchema, req.body, 'common.invalidRequest', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { overrideLimit, ...target } = parsed.data;
    try {
      res.status(202).json(
        await orchestrator.retryRun(req.params.id, target, {
          overrideLimit,
          manualApproval: forceManualApproval(req, store),
        }),
      );
    } catch (e) {
      failure(res, e);
    }
  });
  return app;
}
