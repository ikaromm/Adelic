import { Router, type Response } from 'express';
import {
  GitCommitSchema,
  GitDiffQuerySchema,
  GitDiscardSchema,
  GitPushSchema,
  GitStageSchema,
  parseBody,
  vmsg,
} from '../../shared/schemas.js';
import type { Project } from '../../shared/contracts.js';
import { CheckpointError } from '../checkpoints.js';
import {
  gitCommit,
  gitDiff,
  gitDiscard,
  gitLog,
  gitPullRequestUrl,
  gitPush,
  gitPushTarget,
  gitStage,
  gitStatus,
  gitUnstage,
  isGitRepo,
} from '../git-panel.js';
import { error, errorStatus } from './common.js';
import type { BackendContext } from './context.js';
import { tr } from '../i18n.js';

/** Git panel of a project (docs/specs/git-panel.md). */
export function gitRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  const base = '/api/projects/:id/git';
  const fail = (res: Response, e: unknown) =>
    error(res, e instanceof CheckpointError ? e.status : errorStatus(e) || 500, e as Error);
  const projectOf = (id: string, res: Response): Project | undefined => {
    const project = store.getProject(id);
    if (!project) error(res, 404, 'common.projectNotFound');
    return project;
  };
  /** Mutations: refused with 409 while a run writes there, an undo runs or another git operation runs. */
  const mutate = (project: Project, work: () => Promise<unknown>) => orchestrator.withGitOperation(project.path, work);

  // Cheap probe for the UI entry points (no `git status`).
  app.get(`${base}/repo`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    res.json({ repo: await isGitRepo(project) });
  });
  app.get(`${base}/status`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    try {
      const blocked = orchestrator.gitBlockReason(project.path);
      res.json(await gitStatus(project, blocked && tr(req.locale, blocked.key)));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(`${base}/diff`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    const query = parseBody(
      GitDiffQuerySchema,
      req.query,
      vmsg('validation.requiredField', { field: 'path' }),
      req.locale,
    );
    if (!query.ok) return error(res, 400, query.message);
    try {
      const staged = query.data.staged === '1' || query.data.staged === 'true';
      res.json(await gitDiff(project, query.data.path, staged));
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(`${base}/log`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    try {
      res.json({ commits: await gitLog(project) });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(`${base}/push-target`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    try {
      res.json({ target: (await gitPushTarget(project)) ?? null });
    } catch (e) {
      fail(res, e);
    }
  });
  app.get(`${base}/pr-url`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    try {
      res.json(await gitPullRequestUrl(project));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(`${base}/stage`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    const body = parseBody(GitStageSchema, req.body, 'validation.gitPaths', req.locale);
    if (!body.ok) return error(res, 400, body.message);
    try {
      await mutate(project, () => gitStage(project, body.data));
      res.json(await gitStatus(project));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(`${base}/unstage`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    const body = parseBody(GitStageSchema, req.body, 'validation.gitPaths', req.locale);
    if (!body.ok) return error(res, 400, body.message);
    try {
      await mutate(project, () => gitUnstage(project, body.data));
      res.json(await gitStatus(project));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(`${base}/discard`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    const body = parseBody(GitDiscardSchema, req.body, 'validation.confirm.discard', req.locale);
    if (!body.ok) return error(res, 400, body.message);
    try {
      await mutate(project, () => gitDiscard(project, body.data));
      res.json(await gitStatus(project));
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(`${base}/commit`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    const body = parseBody(GitCommitSchema, req.body, 'git.messageRequired', req.locale);
    if (!body.ok) return error(res, 400, body.message);
    try {
      const hash = await mutate(project, () => gitCommit(project, body.data.message));
      res.status(201).json({ hash });
    } catch (e) {
      fail(res, e);
    }
  });
  app.post(`${base}/push`, async (req, res) => {
    const project = projectOf(req.params.id, res);
    if (!project) return;
    const body = parseBody(GitPushSchema, req.body, 'validation.confirm.push', req.locale);
    if (!body.ok) return error(res, 400, body.message);
    try {
      res.json(await mutate(project, () => gitPush(project)));
    } catch (e) {
      fail(res, e);
    }
  });
  return app;
}
