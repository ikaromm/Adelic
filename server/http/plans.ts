import { Router, type Request, type Response } from 'express';
import {
  PlanApproveSchema,
  PlanEditSchema,
  PlanSaveSchema,
  PlanTaskStatusSchema,
  parseBody,
  vmsg,
} from '../../shared/schemas.js';
import { forceManualApproval } from './auth.js';
import { error, errorStatus, errorText } from './common.js';
import type { BackendContext } from './context.js';
import { SPEND_LIMIT_CODE } from '../../shared/spend-limits.js';

/** Plan mode (docs/specs/plan-mode.md): list, edit, approve, skip, stop, discard and save plans. */
export function plansRoutes({ store, orchestrator }: BackendContext) {
  const plans = orchestrator.plans;
  const app = Router();
  const route =
    (handler: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (e) {
        const status = errorStatus(e) || 500;
        const { exists, path, code, limit } = e as { exists?: boolean; path?: string; code?: string; limit?: unknown };
        res.status(status).json({
          error: errorText(res, e),
          ...(exists ? { exists, path } : {}),
          ...(code === SPEND_LIMIT_CODE ? { code, limit } : {}),
        });
      }
    };
  const id = (req: Request, key = 'id') => String(req.params[key]);
  app.get(
    '/api/sessions/:id/plans',
    route((req, res) => {
      if (!store.getSession(id(req))) return error(res, 404, 'common.sessionNotFound');
      res.json({ plans: plans.list(id(req)) });
    }),
  );
  app.patch(
    '/api/plans/:id',
    route((req, res) => {
      const parsed = parseBody(
        PlanEditSchema,
        req.body,
        vmsg('validation.requiredField', { field: 'markdown' }),
        req.locale,
      );
      if (!parsed.ok) return error(res, 400, parsed.message);
      res.json(plans.edit(id(req), parsed.data.markdown));
    }),
  );
  app.post(
    '/api/plans/:id/approve',
    route(async (req, res) => {
      const parsed = parseBody(
        PlanApproveSchema,
        req.body,
        vmsg('validation.oneOf2', { field: 'mode', a: 'all', b: 'next' }),
        req.locale,
      );
      if (!parsed.ok) return error(res, 400, parsed.message);
      res
        .status(202)
        .json(
          await plans.approve(
            id(req),
            parsed.data.mode,
            parsed.data.overrideLimit === true,
            forceManualApproval(req, store),
          ),
        );
    }),
  );
  app.post(
    '/api/plans/:id/tasks/:taskId',
    route((req, res) => {
      const parsed = parseBody(
        PlanTaskStatusSchema,
        req.body,
        vmsg('validation.oneOf2', { field: 'status', a: 'skipped', b: 'pending' }),
        req.locale,
      );
      if (!parsed.ok) return error(res, 400, parsed.message);
      res.json(plans.setTaskStatus(id(req), id(req, 'taskId'), parsed.data.status));
    }),
  );
  app.post(
    '/api/plans/:id/stop',
    route((req, res) => res.json(plans.stop(id(req)))),
  );
  app.post(
    '/api/plans/:id/discard',
    route((req, res) => res.json(plans.discard(id(req)))),
  );
  app.post(
    '/api/plans/:id/save',
    route((req, res) => {
      const parsed = parseBody(
        PlanSaveSchema,
        req.body,
        vmsg('validation.booleanField', { field: 'overwrite' }),
        req.locale,
      );
      if (!parsed.ok) return error(res, 400, parsed.message);
      res.json(plans.saveToProject(id(req), parsed.data.overwrite === true));
    }),
  );
  return app;
}
