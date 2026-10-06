import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Project } from '../../shared/contracts.js';
import { error, message, str } from './common.js';
import { graphifyConfig, orchestrationConfig, projectPath } from './validation.js';
import type { BackendContext } from './context.js';

export function projectsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.post('/api/projects', (req, res) => {
    const name = str(req.body?.name),
      path = str(req.body?.path, 4096),
      memoryWorkspace = str(req.body?.memoryWorkspace, 100),
      memoryProject = str(req.body?.memoryProject, 100);
    if (!name || !path || !memoryWorkspace || !memoryProject)
      return error(res, 400, 'name, path, memoryWorkspace e memoryProject são obrigatórios');
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
  app.get('/api/tasks/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return error(res, 404, 'Tarefa não encontrada');
    res.json(task);
  });
  app.patch('/api/projects/:id', (req, res) => {
    const p = store.getProject(req.params.id);
    if (!p) return error(res, 404, 'Projeto não encontrado');
    const name = req.body?.name === undefined ? p.name : str(req.body.name);
    const workspace = req.body?.memoryWorkspace === undefined ? p.memoryWorkspace : str(req.body.memoryWorkspace, 100);
    const project = req.body?.memoryProject === undefined ? p.memoryProject : str(req.body.memoryProject, 100);
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
    if (!name || !workspace || !project) return error(res, 400, 'Campos de projeto inválidos');
    p.name = name;
    p.memoryWorkspace = workspace;
    p.memoryProject = project;
    res.json(store.updateProject(p));
  });
  return app;
}
