import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Project, ProjectFolder, RunArtifactsSnapshot } from '../../shared/contracts.js';
import {
  CreateProjectSchema,
  CreateProjectFolderSchema,
  HookTestSchema,
  PatchProjectSchema,
  PatchProjectFolderSchema,
  ProjectFilesQuerySchema,
  RetryTaskSchema,
  ProjectHooksSchema,
  parseBody,
  vmsg,
} from '../../shared/schemas.js';
import { searchProjectFiles } from '../mentions.js';
import { error, errorStatus, errorText } from './common.js';
import { LOCAL_ONLY, forceManualApproval, requestKind } from './auth.js';
import { graphifyConfig, mergeLimits, orchestrationConfig, projectPath } from './validation.js';
import type { BackendContext } from './context.js';
import {
  createLocalProjectFolder,
  listLocalProjectFolders,
  LocalProjectFolderError,
} from '../local-project-folders.js';

export function projectsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.get('/api/local-directories', (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, LOCAL_ONLY);
    try {
      res.json(listLocalProjectFolders(req.query.path));
    } catch (e) {
      if (e instanceof LocalProjectFolderError)
        return error(
          res,
          e.code === 'invalid-path' ? 400 : e.code === 'not-directory' ? 400 : 404,
          localFolderErrorKey(e),
        );
      error(res, 404, 'projects.localFolderUnavailable');
    }
  });
  app.post('/api/local-directories', (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, LOCAL_ONLY);
    if (
      !req.body ||
      typeof req.body.parentPath !== 'string' ||
      req.body.parentPath.length > 4096 ||
      typeof req.body.name !== 'string' ||
      req.body.name.length > 120
    )
      return error(res, 400, 'projects.localFolderInvalidName');
    try {
      res.status(201).json(createLocalProjectFolder(req.body.parentPath, req.body.name));
    } catch (e) {
      if (e instanceof LocalProjectFolderError)
        return error(
          res,
          e.code === 'invalid-name' || e.code === 'invalid-path' || e.code === 'not-directory'
            ? 400
            : e.code === 'exists'
              ? 409
              : 404,
          localFolderErrorKey(e),
        );
      error(res, 404, 'projects.localFolderUnavailable');
    }
  });
  app.get('/api/projects/:id/folders', (req, res) => {
    if (!store.getProject(req.params.id)) return error(res, 404, 'common.projectNotFound');
    res.json({ folders: store.listProjectFolders(req.params.id) });
  });
  app.post('/api/projects/:id/folders', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return error(res, 404, 'common.projectNotFound');
    const parsed = parseBody(CreateProjectFolderSchema, req.body, 'common.invalidRequest', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const parentId = parsed.data.parentId ?? null;
    if (parentId) {
      const parent = store.getProjectFolder(parentId);
      if (!parent) return error(res, 404, 'projects.folderNotFound');
      if (parent.projectId !== project.id) return error(res, 409, 'projects.folderParentInvalid');
    }
    const duplicate = store
      .listProjectFolders(project.id)
      .some((folder) => folder.parentId === parentId && folder.name.toLowerCase() === parsed.data.name.toLowerCase());
    if (duplicate) return error(res, 409, 'projects.folderNameExists');
    const now = new Date().toISOString();
    const folder: ProjectFolder = {
      id: randomUUID(),
      projectId: project.id,
      parentId,
      name: parsed.data.name,
      createdAt: now,
      updatedAt: now,
    };
    try {
      res.status(201).json(store.putProjectFolder(folder));
    } catch {
      error(res, 409, 'projects.folderNameExists');
    }
  });
  app.patch('/api/project-folders/:id', (req, res) => {
    const folder = store.getProjectFolder(req.params.id);
    if (!folder) return error(res, 404, 'projects.folderNotFound');
    const parsed = parseBody(PatchProjectFolderSchema, req.body, 'common.invalidRequest', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const duplicate = store
      .listProjectFolders(folder.projectId)
      .some(
        (item) =>
          item.id !== folder.id &&
          item.parentId === folder.parentId &&
          item.name.toLowerCase() === parsed.data.name.toLowerCase(),
      );
    if (duplicate) return error(res, 409, 'projects.folderNameExists');
    const next = { ...folder, name: parsed.data.name, updatedAt: new Date().toISOString() };
    try {
      res.json(store.putProjectFolder(next));
    } catch {
      error(res, 409, 'projects.folderNameExists');
    }
  });
  app.delete('/api/project-folders/:id', (req, res) => {
    const folder = store.getProjectFolder(req.params.id);
    if (!folder) return error(res, 404, 'projects.folderNotFound');
    if (store.projectFolderHasChildren(folder.id)) return error(res, 409, 'projects.folderHasChildren');
    const sessions = store.listSessions().filter((session) => session.folderId === folder.id);
    if (sessions.some((session) => session.activeRunId || orchestrator.isActive(session.id)))
      return error(res, 409, 'projects.folderSessionRunning');
    if (!store.deleteProjectFolder(folder.id)) return error(res, 409, 'projects.folderHasChildren');
    res.status(204).end();
  });
  app.post('/api/projects', async (req, res) => {
    const parsed = parseBody(CreateProjectSchema, req.body, 'projects.createRequired', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { name, path, remote, memoryWorkspace, memoryProject, approvalMode } = parsed.data;
    if (approvalMode === 'automatic' && requestKind(req) !== 'local') return error(res, 403, LOCAL_ONLY);
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
        ...(approvalMode ? { approvalMode } : {}),
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
  app.get('/api/tasks/:id/inspect', async (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) return error(res, 404, 'projects.taskNotFound');
    const retryRun = task.retryRunId ? store.getRun(task.retryRunId) : undefined;
    const runIds = new Set([task.runId, ...(task.retryRunId ? [task.retryRunId] : [])]);
    const retryTaskIds = new Set(
      task.retryRunId
        ? store
            .listSessionTasks(task.sessionId, 100)
            .filter((candidate) => candidate.runId === task.retryRunId)
            .map((candidate) => candidate.id)
        : [],
    );
    const events = store
      .listEvents(task.sessionId)
      .filter(
        (event) =>
          runIds.has(event.runId) &&
          (event.taskId === task.id ||
            (event.runId === task.retryRunId &&
              (retryTaskIds.has(event.taskId ?? '') ||
                (event.taskId === undefined && retryRun?.retryOfTaskId === task.id)))),
      );
    const unavailable = (reason: string): RunArtifactsSnapshot => ({ status: 'unknown', reason, files: [] });
    const project = task.projectId ? store.getProject(task.projectId) : undefined;
    const artifacts = {
      project: unavailable('Artifacts from a shared delegated run cannot be assigned to this task.'),
      worktree: task.recoveryWorktree
        ? unavailable('The pending worktree has not been independently verified.')
        : undefined,
    };
    // A retry is task-exclusive; use its persisted artifact root to distinguish project-root
    // evidence from a recovery worktree. Scope is a plan, not proof of file ownership.
    if (retryRun?.retryOfTaskId === task.id && retryRun.artifacts && retryRun.artifactRoot) {
      if (task.recoveryWorktree?.path === retryRun.artifactRoot) {
        artifacts.worktree = retryRun.artifacts;
      } else if (project?.path === retryRun.artifactRoot) {
        artifacts.project = retryRun.artifacts;
      }
    }
    if (task.recoveryWorktree)
      artifacts.worktree =
        (await orchestrator.inspectTaskWorktree(task.id)) ??
        unavailable('The pending worktree has not been independently verified.');
    res.json({ task, events, artifacts });
  });
  app.post('/api/tasks/:id/retry', async (req, res) => {
    const parsed = parseBody(RetryTaskSchema, req.body, 'common.invalidRequest', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const task = store.getTask(req.params.id);
    if (!task) return error(res, 404, 'projects.taskNotFound');
    try {
      res.status(202).json(await orchestrator.retryTask(req.params.id, forceManualApproval(req, store)));
    } catch (e) {
      error(res, errorStatus(e) ?? 500, e as Error);
    }
  });
  app.post('/api/tasks/:id/worktree', async (req, res) => {
    if (req.body?.action !== 'apply') return error(res, 400, 'validation.invalidField', { field: 'action' });
    try {
      res.json(await orchestrator.recoverTaskWorktree(req.params.id, 'apply'));
    } catch (e) {
      error(res, errorStatus(e) ?? 500, e as Error);
    }
  });
  app.delete('/api/tasks/:id/worktree', async (req, res) => {
    if (req.body?.confirm !== true) return error(res, 400, 'validation.invalidField', { field: 'confirm' });
    try {
      res.json(await orchestrator.recoverTaskWorktree(req.params.id, 'discard'));
    } catch (e) {
      error(res, errorStatus(e) ?? 500, e as Error);
    }
  });
  app.patch('/api/projects/:id', (req, res) => {
    const p = store.getProject(req.params.id);
    if (!p) return error(res, 404, 'common.projectNotFound');
    if (p.remote && (req.body?.graphify?.enabled || req.body?.git?.runHooks || req.body?.orchestration?.enabled))
      return error(res, 409, 'remotehosts.unsupported');
    // Orchestration/graphify are checked before name and scope, as before.
    const fields = parseBody(PatchProjectSchema, req.body, 'validation.projectFields', req.locale);
    if (fields.ok && fields.data.approvalMode === 'automatic' && requestKind(req) !== 'local')
      return error(res, 403, LOCAL_ONLY);
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
    if (fields.data.approvalMode === null) delete p.approvalMode;
    else if (fields.data.approvalMode !== undefined) p.approvalMode = fields.data.approvalMode;
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

function localFolderErrorKey(error: LocalProjectFolderError) {
  switch (error.code) {
    case 'invalid-name':
      return 'projects.localFolderInvalidName';
    case 'invalid-path':
      return 'projects.localFolderInvalidPath';
    case 'not-directory':
      return 'projects.localFolderNotDirectory';
    case 'exists':
      return 'projects.localFolderExists';
    case 'unavailable':
      return 'projects.localFolderUnavailable';
  }
}
