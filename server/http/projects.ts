import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  vmsg,
} from '../../shared/schemas.js';
import { searchProjectFiles } from '../mentions.js';
import { error, errorStatus, errorText } from './common.js';
import { graphifyConfig, mergeLimits, orchestrationConfig, projectPath } from './validation.js';
import type { BackendContext } from './context.js';

export function projectsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.post('/api/projects', async (req, res) => {
    const parsed = parseBody(CreateProjectSchema, req.body, 'projects.createRequired', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { name, path, remote, memoryWorkspace, memoryProject } = parsed.data;
    try {
      const id = randomUUID();
      if (remote && req.body?.orchestration?.enabled) return error(res, 409, 'remotehosts.unsupported');
      if (remote) {
        const host = store.getRemoteHost(remote.hostId);
        if (!host) return error(res, 404, 'remotehosts.notFound');
        const info = (await orchestrator.remoteHosts.call(
          host,
          remote.path,
          'stat',
          { path: '.' },
          new AbortController().signal,
        )) as { type: string };
        if (info.type !== 'directory') return error(res, 400, 'remotehosts.invalid');
      }
      const resolved = remote ? join(store.dataDir, 'remote-projects', id) : projectPath(path);
      if (remote) mkdirSync(resolved, { recursive: true, mode: 0o700 });
      const config = req.body?.orchestration === undefined ? undefined : orchestrationConfig(req.body.orchestration);
      if (req.body?.orchestration !== undefined && !config) return error(res, 400, 'projects.invalidOrchestration');
      const graphify = req.body?.graphify === undefined ? undefined : graphifyConfig(req.body.graphify);
      if (req.body?.graphify !== undefined && !graphify) return error(res, 400, 'projects.invalidGraphify');
      const p: Project = {
        id,
        name,
        path: resolved,
        createdAt: new Date().toISOString(),
        memoryWorkspace,
        memoryProject,
        orchestration: remote ? { enabled: false, maxWorkers: 1, review: false } : config,
        graphify: remote ? { enabled: false } : graphify,
        ...(remote ? { remote } : {}),
      };
      store.putProject(p);
      res.status(201).json(store.getProject(p.id));
    } catch (e) {
      error(res, 400, e as Error);
    }
  });
  app.get('/api/projects/:id/coordination', (req, res) => {
    const result = orchestrator.coordination(req.params.id);
    if (!result) return error(res, 404, 'common.projectNotFound');
    res.json(result);
  });
  // File autocomplete for `@` mentions (docs/specs/mentions.md): relative paths, ranked.
  app.get('/api/projects/:id/files', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return error(res, 404, 'common.projectNotFound');
    const query = parseBody(ProjectFilesQuerySchema, req.query, 'common.invalidParams', req.locale);
    if (!query.ok) return error(res, 400, query.message);
    try {
      if (project.remote) return res.json(await orchestrator.remoteFiles(project, query.data.query, query.data.limit));
      const session = query.data.sessionId ? store.getSession(query.data.sessionId) : undefined;
      const root = session?.projectId === project.id && session.worktree ? session.worktree.path : project.path;
      res.json(await searchProjectFiles(root, query.data.query, query.data.limit));
    } catch (e) {
      error(res, 409, 'projects.listFilesFailed', { detail: errorText(res, e) });
    }
  });
  // Per-project hooks (docs/specs/project-hooks.md): stored only in Adelic's database.
  app.get('/api/projects/:id/hooks', (req, res) => {
    if (!store.getProject(req.params.id)) return error(res, 404, 'common.projectNotFound');
    res.json(store.getHooks(req.params.id));
  });
  app.put('/api/projects/:id/hooks', (req, res) => {
    if (!store.getProject(req.params.id)) return error(res, 404, 'common.projectNotFound');
    if (store.getProject(req.params.id)?.remote) return error(res, 409, 'remotehosts.unsupported');
    const parsed = parseBody(ProjectHooksSchema, req.body, 'projects.invalidHooks', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    res.json(store.putHooks(req.params.id, parsed.data));
  });
  app.post('/api/projects/:id/hooks/test', async (req, res) => {
    const parsed = parseBody(HookTestSchema, req.body, vmsg('validation.invalidField', { field: 'index' }), req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      res.json(await orchestrator.testHook(req.params.id, parsed.data.index));
    } catch (e) {
      error(res, errorStatus(e) ?? 500, e as Error);
    }
  });
  app.get('/api/tasks/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return error(res, 404, 'projects.taskNotFound');
    res.json(task);
  });
  app.patch('/api/projects/:id', (req, res) => {
    const p = store.getProject(req.params.id);
    if (!p) return error(res, 404, 'common.projectNotFound');
    if (p.remote && (req.body?.graphify?.enabled || req.body?.git?.runHooks || req.body?.orchestration?.enabled))
      return error(res, 409, 'remotehosts.unsupported');
    // Orchestration/graphify are checked before name and scope, as before.
    const fields = parseBody(PatchProjectSchema, req.body, 'validation.projectFields', req.locale);
    if (req.body?.orchestration !== undefined) {
      const c = orchestrationConfig(req.body.orchestration, p.orchestration);
      if (!c) return error(res, 400, 'projects.invalidOrchestration');
      p.orchestration = c;
    }
    if (req.body?.graphify !== undefined) {
      const g = graphifyConfig(req.body.graphify);
      if (!g) return error(res, 400, 'projects.invalidGraphify');
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
