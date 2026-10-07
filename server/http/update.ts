import { Router, type Request } from 'express';
import { UpdateApplySchema, UpdateCheckSchema, parseBody } from '../../shared/schemas.js';
import { localizeUpdateStatus, type SelfUpdater, type UpdateGuard } from '../self-update.js';
import { requestKind } from './auth.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

/**
 * Who may check for and apply app updates: only requests made on this computer (loopback),
 * never the remote access. One place to switch to a finer request classification later.
 */
/** Only this computer may update: not the tailnet, not the internet (Funnel arrives on loopback too). */
export const updateRequestAllowed = (req: Request) => requestKind(req) === 'local';

/** "Atualizar Adelic" (docs/specs/self-update.md). */
export function updateRoutes({ store, orchestrator }: BackendContext, updater: SelfUpdater) {
  const app = Router();
  const guard: UpdateGuard = {
    block: () => orchestrator.updateBlock(),
    blockReason: () => orchestrator.updateBlockReason(),
    begin: () => orchestrator.beginUpdate(),
  };
  app.use('/api/update', (req, res, next) =>
    updateRequestAllowed(req) ? next() : error(res, 403, 'update.localOnly'),
  );
  const fail = (res: Parameters<typeof error>[0], e: unknown) =>
    error(res, (e as { status?: number }).status ?? 500, e as Error);
  app.get('/api/update/status', async (req, res) => {
    try {
      res.json(localizeUpdateStatus(await updater.status(store.getSettings()!, guard), req.locale));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post('/api/update/check', async (req, res) => {
    const parsed = parseBody(UpdateCheckSchema, req.body, 'common.invalidParams', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(localizeUpdateStatus(await updater.check(store.getSettings()!, guard, parsed.data.channel), req.locale));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post('/api/update/apply', async (req, res) => {
    const parsed = parseBody(UpdateApplySchema, req.body, 'common.invalidParams', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.status(202).json(
        await updater.apply(store.getSettings()!, guard, {
          channel: parsed.data.channel,
          target: parsed.data.target,
        }),
      );
    } catch (e) {
      fail(res, e);
    }
  });
  app.get('/api/update/progress', (_req, res) => res.json(updater.progress()));
  return app;
}
