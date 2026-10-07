import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Project } from '../../shared/contracts.js';
import {
  CreateProjectSchema,
  HookTestSchema,
  PatchProjectSchema,
  ProjectFilesQuerySchema,
  ProjectHooksSchema,
  parseBody,
} from '../../shared/schemas.js';
import { searchProjectFiles } from '../mentions.js';
import { error, errorStatus, message } from './common.js';
import { graphifyConfig, mergeLimits, orchestrationConfig, projectPath } from './validation.js';
import type { BackendContext } from './context.js';

export function projectsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.post('/api/projects', (req, res) => {
    const parsed = parseBody(
      CreateProjectSchema,
      req.body,
      'name, path, memoryWorkspace e memoryProject são obrigatórios',
    );
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { name, path, memoryWorkspace, memoryProject } = parsed.data;
    try {
      const resolved = projectPath(path);
      const config = req.body?.orchestration === undefined ? undefined : orchestrationConfig(req.body.orchestration);
      if (req.body?.orchestration !== undefined && !config) return error(res, 400, 'orchestration inválida');
      const graphify = req.body?.graphify === undefined ? undefined : graphifyConfig(req.body.graphify);
      if (req.body?.graphify !== undefined && !graphify) return error(res, 400, 'graphify inválido');
      const p: Project = {
        id: randomUUID(),
        name,
        path: resolved,
        createdAt: new Date().toISOString(),
        memoryWorkspace,
        memoryProject,
        orchestration: config,
        graphify,
      };
      store.putProject(p);
      res.status(201).json(store.getProject(p.id));
    } catch (e) {
      error(res, 400, message(e));
    }
  });
  app.get('/api/projects/:id/coordination', (req, res) => {
    const result = orchestrator.coordination(req.params.id);
    if (!result) return error(res, 404, 'Projeto não encontrado');
    res.json(result);
  });
  // File autocomplete for `@` mentions (docs/specs/mentions.md): relative paths, ranked.
  app.get('/api/projects/:id/files', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return error(res, 404, 'Projeto não encontrado');
    const query = parseBody(ProjectFilesQuerySchema, req.query, 'Parâmetros inválidos');
    if (!query.ok) return error(res, 400, query.message);
    try {
      const session = query.data.sessionId ? store.getSession(query.data.sessionId) : undefined;
      const root = session?.projectId === project.id && session.worktree ? session.worktree.path : project.path;
      res.json(await searchProjectFiles(root, query.data.query, query.data.limit));
    } catch (e) {
      error(res, 409, `Não foi possível listar os arquivos do projeto: ${message(e)}`);
    }
  });
  // Per-project hooks (docs/specs/project-hooks.md): stored only in Adelic's database.
  app.get('/api/projects/:id/hooks', (req, res) => {
    if (!store.getProject(req.params.id)) return error(res, 404, 'Projeto não encontrado');
    res.json(store.getHooks(req.params.id));
  });
  app.put('/api/projects/:id/hooks', (req, res) => {
    if (!store.getProject(req.params.id)) return error(res, 404, 'Projeto não encontrado');
    const parsed = parseBody(ProjectHooksSchema, req.body, 'Configuração de verificações inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    res.json(store.putHooks(req.params.id, parsed.data));
  });
  app.post('/api/projects/:id/hooks/test', async (req, res) => {
    const parsed = parseBody(HookTestSchema, req.body, 'index inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(await orchestrator.testHook(req.params.id, parsed.data.index));
    } catch (e) {
      error(res, errorStatus(e) ?? 500, message(e));
    }
  });
  app.get('/api/tasks/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return error(res, 404, 'Tarefa não encontrada');
    res.json(task);
  });
  app.patch('/api/projects/:id', (req, res) => {
    const p = store.getProject(req.params.id);
    if (!p) return error(res, 404, 'Projeto não encontrado');
    // Orchestration/graphify are checked before name and scope, as before.
    const fields = parseBody(PatchProjectSchema, req.body, 'Campos de projeto inválidos');
    if (req.body?.orchestration !== undefined) {
      const c = orchestrationConfig(req.body.orchestration, p.orchestration);
      if (!c) return error(res, 400, 'orchestration inválida');
      p.orchestration = c;
    }
    if (req.body?.graphify !== undefined) {
      const g = graphifyConfig(req.body.graphify);
      if (!g) return error(res, 400, 'graphify inválido');
      p.graphify = g;
    }
    if (!fields.ok) return error(res, 400, fields.message);
    p.name = fields.data.name ?? p.name;
    p.memoryWorkspace = fields.data.memoryWorkspace ?? p.memoryWorkspace;
    p.memoryProject = fields.data.memoryProject ?? p.memoryProject;
    // Monthly usage limits of the project: merged field by field; `null` clears one or all.
    const limits = fields.data.spendLimits;
    if (limits === null) delete p.spendLimits;
    else if (limits) {
      const merged = mergeLimits(p.spendLimits ?? {}, limits);
      if (Object.keys(merged).length) p.spendLimits = merged;
      else delete p.spendLimits;
    }
    if (fields.data.git) p.git = fields.data.git;
    res.json(store.updateProject(p));
  });
  return app;
}
