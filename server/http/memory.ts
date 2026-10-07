import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  memoryRead,
  memorySearch,
  memoryWrite,
  sharedMemoryRead,
  sharedMemorySearch,
  sharedMemoryWrite,
} from '../memory.js';
import { memoryCatalog, memoryList } from '../memory-service.js';
import { ProjectMemoryWriteSchema, SharedMemoryWriteSchema, memoryPath } from '../../shared/schemas.js';
import { error, errorStatus, str } from './common.js';
import type { BackendContext } from './context.js';

const safeMemoryPath = (p: string) => memoryPath.safeParse(p).success;
// Only client-meaningful statuses reach the UI; any other service failure is 503.
function serviceStatus(e: unknown) {
  const s = errorStatus(e);
  return s !== undefined && [400, 404, 409, 502].includes(s) ? s : 503;
}
function writeStatus(e: unknown) {
  const s = errorStatus(e);
  return s !== undefined && [403, 409, 422].includes(s) ? s : 503;
}

export function memoryRoutes({ store }: BackendContext) {
  const app = Router();
  app.get('/api/memory/catalog', async (_req, res) => {
    try {
      res.json(await memoryCatalog());
    } catch (e) {
      error(res, serviceStatus(e), e as Error);
    }
  });
  function memoryScopeQuery(req: Request, res: Response) {
    const hasW = req.query.workspace !== undefined,
      hasP = req.query.project !== undefined,
      hasId = req.query.projectId !== undefined;
    if (hasW !== hasP || ((hasW || hasP) && hasId)) {
      error(res, 400, 'memory.scopeTogether');
      return;
    }
    if (hasW && hasP) {
      const workspace = str(req.query.workspace, 100),
        project = str(req.query.project, 100);
      if (!workspace || !project) {
        error(res, 400, 'memory.invalidScope');
        return;
      }
      return { workspace, project };
    }
    const p = hasId ? store.getProject(String(req.query.projectId)) : undefined;
    if (hasId && !p) {
      error(res, 400, 'memory.invalidProjectId');
      return;
    }
    return p ? { workspace: p.memoryWorkspace, project: p.memoryProject } : undefined;
  }
  app.get('/api/memory/pages', async (req, res) => {
    const scope = memoryScopeQuery(req, res);
    if (!scope) return res.headersSent ? undefined : error(res, 400, 'memory.scopeRequired');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset),
      limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    try {
      res.json(await memoryList(scope, offset, limit));
    } catch (e) {
      error(res, serviceStatus(e), e as Error);
    }
  });
  app.get('/api/memory/search', async (req, res) => {
    const scope = memoryScopeQuery(req, res),
      q = str(req.query.q, 1000);
    if (!scope || !q) return res.headersSent ? undefined : error(res, 400, 'memory.searchRequired');
    try {
      const hits =
        req.query.projectId !== undefined
          ? await memorySearch(store.getProject(String(req.query.projectId))!, q)
          : await sharedMemorySearch(scope, q);
      res.json({ hits });
    } catch (e) {
      error(res, 503, e as Error);
    }
  });
  app.get('/api/memory/page', async (req, res) => {
    const scope = memoryScopeQuery(req, res),
      path = str(req.query.path, 500);
    if (!scope || !path) return res.headersSent ? undefined : error(res, 400, 'memory.pageRequired');
    if (!safeMemoryPath(path)) return error(res, 400, 'memory.invalidPath');
    try {
      res.json(
        req.query.projectId !== undefined
          ? await memoryRead(store.getProject(String(req.query.projectId))!, path)
          : await sharedMemoryRead(scope, path),
      );
    } catch (e) {
      error(res, 503, e as Error);
    }
  });
  app.post('/api/memory/page', async (req, res) => {
    const raw = req.body ?? {};
    if (raw.workspace === undefined && raw.project === undefined && raw.expectedVersion === undefined) {
      const legacy = ProjectMemoryWriteSchema.safeParse(raw);
      const p = legacy.success ? store.getProject(legacy.data.projectId) : undefined;
      if (!legacy.success || !p) return error(res, 400, 'memory.legacyWriteRequired');
      const { path, body } = legacy.data;
      if (!safeMemoryPath(path)) return error(res, 400, 'memory.invalidPath');
      if (p.memoryProject === '_global') return error(res, 403, 'memory.globalReadOnly');
      try {
        res.json(await memoryWrite(p, path, body));
      } catch (e) {
        error(res, writeStatus(e), e as Error);
      }
      return;
    }
    const shared = SharedMemoryWriteSchema.safeParse(raw);
    if (raw.projectId !== undefined || !shared.success) return error(res, 400, 'memory.writeRequired');
    const { workspace, project, path, body, expectedVersion } = shared.data;
    if (!safeMemoryPath(path)) return error(res, 400, 'memory.invalidPath');
    if (project === '_global') return error(res, 403, 'memory.globalReadOnly');
    try {
      res.json(await sharedMemoryWrite({ workspace, project }, path, body, expectedVersion));
    } catch (e) {
      error(res, writeStatus(e), e as Error);
    }
  });
  return app;
}
