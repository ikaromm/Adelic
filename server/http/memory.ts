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
import { error, errorStatus, message, str } from './common.js';
import type { BackendContext } from './context.js';

function safeMemoryPath(p: string) {
  return !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\') && p.endsWith('.md');
}
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
      error(res, serviceStatus(e), message(e));
    }
  });
  function memoryScopeQuery(req: Request, res: Response) {
    const hasW = req.query.workspace !== undefined,
      hasP = req.query.project !== undefined,
      hasId = req.query.projectId !== undefined;
    if (hasW !== hasP || ((hasW || hasP) && hasId)) {
      error(res, 400, 'Informe workspace e project juntos, sem projectId');
      return;
    }
    if (hasW && hasP) {
      const workspace = str(req.query.workspace, 100),
        project = str(req.query.project, 100);
      if (!workspace || !project) {
        error(res, 400, 'Escopo inválido');
        return;
      }
      return { workspace, project };
    }
    const p = hasId ? store.getProject(String(req.query.projectId)) : undefined;
    if (hasId && !p) {
      error(res, 400, 'projectId inválido');
      return;
    }
    return p ? { workspace: p.memoryWorkspace, project: p.memoryProject } : undefined;
  }
  app.get('/api/memory/pages', async (req, res) => {
    const scope = memoryScopeQuery(req, res);
    if (!scope) return res.headersSent ? undefined : error(res, 400, 'workspace/project ou projectId são obrigatórios');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset),
      limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    try {
      res.json(await memoryList(scope, offset, limit));
    } catch (e) {
      error(res, serviceStatus(e), message(e));
    }
  });
  app.get('/api/memory/search', async (req, res) => {
    const scope = memoryScopeQuery(req, res),
      q = str(req.query.q, 1000);
    if (!scope || !q)
      return res.headersSent ? undefined : error(res, 400, 'projectId ou workspace/project e q são obrigatórios');
    try {
      const hits =
        req.query.projectId !== undefined
          ? await memorySearch(store.getProject(String(req.query.projectId))!, q)
          : await sharedMemorySearch(scope, q);
      res.json({ hits });
    } catch (e) {
      error(res, 503, message(e));
    }
  });
  app.get('/api/memory/page', async (req, res) => {
    const scope = memoryScopeQuery(req, res),
      path = str(req.query.path, 500);
    if (!scope || !path)
      return res.headersSent ? undefined : error(res, 400, 'projectId ou workspace/project e path são obrigatórios');
    if (!safeMemoryPath(path)) return error(res, 400, 'path inválido');
    try {
      res.json(
        req.query.projectId !== undefined
          ? await memoryRead(store.getProject(String(req.query.projectId))!, path)
          : await sharedMemoryRead(scope, path),
      );
    } catch (e) {
      error(res, 503, message(e));
    }
  });
  app.post('/api/memory/page', async (req, res) => {
    const body = req.body?.body,
      expected = req.body?.expectedVersion;
    const path = str(req.body?.path, 500);
    if (req.body?.workspace === undefined && req.body?.project === undefined && expected === undefined) {
      const p = store.getProject(str(req.body?.projectId) || '');
      if (!p || !path || typeof body !== 'string' || body.length > 50000)
        return error(res, 400, 'projectId, path e body (máximo 50000 caracteres) são obrigatórios');
      if (!safeMemoryPath(path)) return error(res, 400, 'path inválido');
      if (p.memoryProject === '_global') return error(res, 403, 'Escrita no escopo _global não permitida');
      try {
        res.json(await memoryWrite(p, path, body));
      } catch (e) {
        error(res, writeStatus(e), message(e));
      }
      return;
    }
    const workspace = str(req.body?.workspace, 100),
      project = str(req.body?.project, 100);
    if (
      req.body?.projectId !== undefined ||
      !workspace ||
      !project ||
      !path ||
      typeof body !== 'string' ||
      body.length > 50000 ||
      !(expected === null || typeof expected === 'string')
    )
      return error(res, 400, 'workspace, project, path, body e expectedVersion (string ou null) obrigatórios');
    if (!safeMemoryPath(path)) return error(res, 400, 'path inválido');
    if (project === '_global') return error(res, 403, 'Escrita no escopo _global não permitida');
    try {
      res.json(await sharedMemoryWrite({ workspace, project }, path, body, expected));
    } catch (e) {
      error(res, writeStatus(e), message(e));
    }
  });
  return app;
}
