import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  GraphifyConfig,
  Mode,
  OrchestrationConfig,
  Project,
  ProviderId,
  ProviderRegistry,
  Session,
  Settings,
} from '../shared/contracts.js';
import {
  memoryIntegration,
  memoryIntegrationSnapshot,
  memoryRead,
  memorySearch,
  memoryWrite,
  sharedMemoryRead,
  sharedMemorySearch,
  sharedMemoryWrite,
} from './memory.js';
import { memoryCatalog, memoryList } from './memory-service.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import { GraphifyService, graphify, mountGraphifyRoutes } from './graphify.js';
import { validReasoningEffort, supportsEffort } from '../shared/reasoning.js';

const validProviders = new Set<ProviderId>(['codex', 'claude', 'kiro', 'opencode']);
const modes = new Set<Mode>(['auto', 'fast', 'deep']);
function orchestrationConfig(value: unknown, base?: OrchestrationConfig): OrchestrationConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  const merged = { ...(base || { enabled: true, maxWorkers: 2, review: true }), ...b };
  for (const key of ['workerProviderId', 'workerModel', 'reviewerProviderId', 'reviewerModel'] as const)
    if (b[key] === null) delete (merged as any)[key];
  if (
    typeof merged.enabled !== 'boolean' ||
    ![1, 2, 3].includes(merged.maxWorkers as number) ||
    typeof merged.review !== 'boolean'
  )
    return undefined;
  for (const key of ['workerProviderId', 'reviewerProviderId'] as const)
    if (merged[key] !== undefined && !validProviders.has(merged[key] as ProviderId)) return undefined;
  for (const key of ['workerModel', 'reviewerModel'] as const)
    if (
      merged[key] !== undefined &&
      (typeof merged[key] !== 'string' || !(merged[key] as string).trim() || (merged[key] as string).length > 120)
    )
      return undefined;
  const allowed = new Set([
    'enabled',
    'maxWorkers',
    'review',
    'workerProviderId',
    'workerModel',
    'reviewerProviderId',
    'reviewerModel',
  ]);
  if (Object.keys(b).some((k) => !allowed.has(k))) return undefined;
  return merged as OrchestrationConfig;
}
function graphifyConfig(value: unknown): GraphifyConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== 'enabled') || typeof b.enabled !== 'boolean') return undefined;
  return { enabled: b.enabled };
}
const error = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
const str = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;
function originGuard(req: Request, res: Response, next: NextFunction) {
  const host = (req.get('host') || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) return error(res, 403, 'Host inválido');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.is('application/json')) return error(res, 415, 'Mutação exige application/json');
    const origin = req.get('origin');
    if (origin) {
      try {
        const u = new URL(origin);
        if (!['http:', 'https:'].includes(u.protocol) || u.host.toLowerCase() !== host)
          return error(res, 403, 'Origin externo bloqueado');
      } catch {
        return error(res, 403, 'Origin inválido');
      }
    }
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return error(res, 403, 'Origem externa bloqueada');
  }
  next();
}
function projectPath(input: unknown) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path obrigatório');
  const p = realpathSync(resolve(input));
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error('O caminho precisa ser uma pasta existente');
  return p;
}

export function createBackend(store: Store, providers: ProviderRegistry, graphifyService: GraphifyService = graphify) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb', strict: true }));
  const orchestrator = new Orchestrator(store, providers, undefined, graphifyService, providerList);
  let providersCache: { at: number; value: Awaited<ReturnType<typeof providers.list>> } | undefined;
  let providersPending: Promise<Awaited<ReturnType<typeof providers.list>>> | undefined;
  async function providerList() {
    if (providersCache && Date.now() - providersCache.at <= 10000) return providersCache.value;
    if (!providersPending)
      providersPending = providers
        .list()
        .then((value) => {
          providersCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          providersPending = undefined;
        });
    return providersPending;
  }
  function knownModel(catalog: Awaited<ReturnType<typeof providers.list>>, providerId: string, model: string) {
    const provider = catalog.find((p) => p.id === providerId);
    return Boolean(provider && provider.models.some((item) => item.id === model));
  }
  let jail: string | undefined;
  function jailIntegration() {
    if (!jail) {
      try {
        jail = execFileSync('which', ['ai-jail'], {
          encoding: 'utf8',
          timeout: 300,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        jail = '';
      }
    }
    return {
      id: 'ai-jail',
      name: 'ai-jail',
      kind: 'sandbox' as const,
      status: jail ? ('planned' as const) : ('missing' as const),
      detail: jail
        ? 'ai-jail instalado; os runtimes ainda não estão integrados a ele'
        : 'ai-jail não encontrado no PATH',
    };
  }
  function integrations() {
    return [
      memoryIntegrationSnapshot(),
      jailIntegration(),
      {
        id: 'runtime-tools',
        name: 'Ferramentas dos runtimes',
        kind: 'tool' as const,
        status: 'ready' as const,
        detail: 'Capacidades declaradas individualmente por cada provedor',
      },
    ];
  }
  app.use(originGuard);
  app.get('/api/bootstrap', async (_req, res) => {
    try {
      const [providersResult] = await Promise.all([providerList(), memoryIntegration()]);
      res.json(store.bootstrap(providersResult, integrations()));
    } catch (e) {
      error(res, 500, message(e));
    }
  });
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
  app.post('/api/sessions', async (req, res) => {
    const rawProjectId = req.body?.projectId;
    if (rawProjectId !== undefined && rawProjectId !== null && typeof rawProjectId !== 'string')
      return error(res, 400, 'projectId inválido');
    const projectId = rawProjectId === null ? undefined : str(rawProjectId);
    if (rawProjectId !== undefined && rawProjectId !== null && !projectId) return error(res, 400, 'projectId inválido');
    const project = projectId ? store.getProject(projectId) : undefined;
    if (projectId && !project) return error(res, 404, 'Projeto não encontrado');
    const providerId =
      req.body?.providerId === undefined ? store.getSettings()!.defaultProviderId : req.body.providerId;
    if (!validProviders.has(providerId)) return error(res, 400, 'providerId inválido');
    const mode = req.body?.mode === undefined ? store.getSettings()!.defaultMode : req.body.mode;
    if (!modes.has(mode)) return error(res, 400, 'mode inválido');
    const model = req.body?.model === undefined ? undefined : str(req.body.model, 120);
    if (req.body?.model !== undefined && !model) return error(res, 400, 'model inválido');
    const thinking = req.body?.thinking === undefined ? undefined : req.body.thinking;
    if (thinking !== undefined && thinking !== 'auto' && !validReasoningEffort(thinking))
      return error(res, 400, 'thinking inválido');
    const needsCatalog = Boolean(model) || (thinking !== undefined && thinking !== 'auto');
    const catalog = needsCatalog ? await providerList() : undefined;
    if (model && catalog && !knownModel(catalog, providerId, model))
      return error(res, 400, 'Modelo não anunciado para este provedor');
    if (
      thinking !== undefined &&
      thinking !== 'auto' &&
      !supportsEffort(
        catalog!.find((p) => p.id === providerId),
        model,
        thinking,
      )
    )
      return error(res, 400, 'Esforço não anunciado para este modelo');
    const now = new Date().toISOString();
    const s: Session = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      title: str(req.body?.title, 160) || 'Nova conversa',
      providerId,
      model,
      mode,
      thinking,
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
    res.status(201).json(s);
  });
  app.get('/api/sessions/:id', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    res.json(store.detail(s));
  });
  app.patch('/api/sessions/:id', async (req, res) => {
    const original = store.getSession(req.params.id);
    if (!original) return error(res, 404, 'Conversa não encontrada');
    if (original.activeRunId || orchestrator.isActive(original.id))
      return error(res, 409, 'Não é possível alterar uma conversa em execução');
    const snapshot = structuredClone(original),
      body = req.body || {};
    let projectId = snapshot.projectId;
    if (body.projectId !== undefined) {
      if (body.projectId !== null && typeof body.projectId !== 'string') return error(res, 400, 'projectId inválido');
      const value = body.projectId === null ? undefined : str(body.projectId);
      if (body.projectId !== null && !value) return error(res, 400, 'projectId inválido');
      if (value && !store.getProject(value)) return error(res, 404, 'Projeto não encontrado');
      projectId = value ?? null;
    }
    const title = body.title === undefined ? snapshot.title : str(body.title, 160);
    if (!title) return error(res, 400, 'title inválido');
    const providerId = body.providerId === undefined ? snapshot.providerId : body.providerId;
    if (!validProviders.has(providerId)) return error(res, 400, 'providerId inválido');
    const providerChanged = providerId !== snapshot.providerId;
    let model = snapshot.model;
    if (providerChanged && body.model === undefined) model = undefined;
    if (body.model !== undefined) {
      if (body.model !== null && !str(body.model, 120)) return error(res, 400, 'model inválido');
      model = body.model === null ? undefined : str(body.model, 120);
    }
    const mode = body.mode === undefined ? snapshot.mode : body.mode;
    if (!modes.has(mode)) return error(res, 400, 'mode inválido');
    const modelChanged = model !== snapshot.model;
    let thinking = body.thinking === undefined ? snapshot.thinking : body.thinking;
    if (thinking !== undefined && thinking !== 'auto' && !validReasoningEffort(thinking))
      return error(res, 400, 'thinking inválido');
    let catalog: Awaited<ReturnType<typeof providers.list>> | undefined;
    if (body.model !== undefined && model) {
      catalog = await providerList();
      if (!knownModel(catalog, providerId, model)) return error(res, 400, 'Modelo não anunciado para este provedor');
    }
    if ((providerChanged || modelChanged) && body.thinking === undefined) thinking = 'auto';
    if (body.thinking !== undefined && thinking !== undefined && thinking !== 'auto') {
      catalog ??= await providerList();
      if (
        !supportsEffort(
          catalog.find((p) => p.id === providerId),
          model,
          thinking,
        )
      )
        return error(res, 400, 'Esforço não anunciado para este modelo');
    }
    const current = store.getSession(req.params.id);
    if (!current) return error(res, 404, 'Conversa não encontrada');
    if (
      current.activeRunId ||
      orchestrator.isActive(current.id) ||
      JSON.stringify(current) !== JSON.stringify(snapshot)
    )
      return error(res, 409, 'A conversa mudou durante a atualização');
    const next: Session = {
      ...current,
      projectId,
      title,
      providerId,
      model,
      mode,
      thinking,
      updatedAt: new Date().toISOString(),
    };
    if (projectId !== snapshot.projectId || providerChanged || modelChanged) delete next.nativeSessionId;
    store.putSession(next);
    res.json(next);
  });
  app.delete('/api/sessions/:id', (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    if (s.activeRunId) return error(res, 409, 'Conversa em execução');
    store.deleteSession(s.id);
    res.status(204).end();
  });
  app.post('/api/sessions/:id/messages', async (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) return error(res, 404, 'Conversa não encontrada');
    const content = str(req.body?.content, 32000);
    if (!content) return error(res, 400, 'content obrigatório (máximo 32000 caracteres)');
    const clientMessageId = req.body?.clientMessageId === undefined ? undefined : str(req.body.clientMessageId, 128);
    if (req.body?.clientMessageId !== undefined && !clientMessageId) return error(res, 400, 'clientMessageId inválido');
    try {
      const result = await orchestrator.start(s, content, clientMessageId);
      res.status(202).json(result);
    } catch (e) {
      const status = (e as any)?.status || 500;
      error(res, status, message(e));
    }
  });
  app.post('/api/sessions/:id/cancel', async (req, res) => {
    if (!store.getSession(req.params.id)) return error(res, 404, 'Conversa não encontrada');
    try {
      await orchestrator.cancel(req.params.id);
      res.status(202).json({ ok: true });
    } catch (e) {
      error(res, (e as any)?.status || 500, message(e));
    }
  });
  app.post('/api/approvals/:id', async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'deny'].includes(decision)) return error(res, 400, 'decision deve ser approve ou deny');
    const a = store.getApproval(req.params.id);
    if (!a) return error(res, 404, 'Aprovação não encontrada');
    try {
      await orchestrator.decide(a.id, a.sessionId, decision);
      res.json(store.getApproval(a.id));
    } catch (e) {
      error(res, (e as any)?.status || 500, message(e));
    }
  });
  app.get('/api/events', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'refresh' })}\n\n`);
    const unsub = orchestrator.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  });
  app.patch('/api/settings', (req, res) => {
    const old = store.getSettings()!;
    const b = req.body || {};
    const next: Settings = { ...old };
    if (b.defaultProviderId !== undefined) {
      if (!validProviders.has(b.defaultProviderId)) return error(res, 400, 'defaultProviderId inválido');
      next.defaultProviderId = b.defaultProviderId;
    }
    if (b.defaultMode !== undefined) {
      if (!modes.has(b.defaultMode)) return error(res, 400, 'defaultMode inválido');
      next.defaultMode = b.defaultMode;
    }
    if (b.memoryEnabled !== undefined) {
      if (typeof b.memoryEnabled !== 'boolean') return error(res, 400, 'memoryEnabled deve ser booleano');
      next.memoryEnabled = b.memoryEnabled;
    }
    if (b.sandbox !== undefined) {
      if (!['read-only', 'workspace-write'].includes(b.sandbox)) return error(res, 400, 'sandbox inválido');
      next.sandbox = b.sandbox;
    }
    if (b.responseStyle !== undefined) {
      if (!['concise', 'balanced'].includes(b.responseStyle)) return error(res, 400, 'responseStyle inválido');
      next.responseStyle = b.responseStyle;
    }
    if (b.approvalMode !== undefined) {
      if (!['auto-safe', 'manual'].includes(b.approvalMode)) return error(res, 400, 'approvalMode inválido');
      next.approvalMode = b.approvalMode;
    }
    res.json(store.setSettings(next));
  });
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
        error(res, [403, 409, 422].includes((e as any)?.status) ? (e as any).status : 503, message(e));
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
      error(res, [403, 409, 422].includes((e as any)?.status) ? (e as any).status : 503, message(e));
    }
  });
  app.patch('/api/skills/:id', (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) return error(res, 404, 'Skill não encontrada');
    if (typeof req.body?.enabled !== 'boolean') return error(res, 400, 'enabled deve ser booleano');
    skill.enabled = req.body.enabled;
    res.json(store.setSkill(skill));
  });
  app.get('/api/health', async (_req, res) => {
    res.json({
      status: 'ok',
      providers: (await providerList()).map((p) => ({ id: p.id, status: p.status, available: p.available })),
      memory: (await memoryIntegration()).status,
      jail: jailIntegration().status === 'planned' ? 'installed' : 'missing',
    });
  });
  app.get('/api/export', (_req, res) => res.json(store.exportData()));
  mountGraphifyRoutes(app, store, graphifyService);
  app.use('/api', (req, res) => error(res, 404, 'Endpoint não encontrado'));
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => error(res, 400, message(e)));
  return { app, orchestrator, graphify: graphifyService };
}
function safeMemoryPath(p: string) {
  return !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\') && p.endsWith('.md');
}
function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
// Only client-meaningful statuses reach the UI; any other service failure is 503.
function serviceStatus(e: unknown) {
  const s = (e as any)?.status;
  return [400, 404, 409, 502].includes(s) ? s : 503;
}
