import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { MCP_MESSAGES, type McpServerRecord } from '../../shared/mcp.js';
import { CreateMcpServerSchema, PatchMcpServerSchema, ProjectMcpSchema, parseBody } from '../../shared/schemas.js';
import { mcpServerView, projectMcpReport, resolveMcpCommand } from '../mcp.js';
import { error, errorStatus, message } from './common.js';
import type { BackendContext } from './context.js';

type EnvInput = { name: string; from: 'adelic-env' | 'literal'; value?: string }[];

/**
 * Literal values are write-only: a literal sent without `value` keeps the stored value of the
 * same literal variable; a new literal must carry one.
 */
function mergeEnv(next: EnvInput, current: McpServerRecord['env'] = []): McpServerRecord['env'] {
  return next.map((item) => {
    if (item.from === 'adelic-env') return { name: item.name, from: item.from };
    const value = item.value ?? current.find((old) => old.name === item.name && old.from === 'literal')?.value;
    if (!value) throw Object.assign(new Error(MCP_MESSAGES.literal), { status: 400 });
    return { name: item.name, from: item.from, value };
  });
}

/** MCP catalog and per-project toggles (docs/specs/mcp-catalog.md). Opt-in: nothing pre-created. */
export function mcpRoutes({ store }: BackendContext, which?: (name: string) => string) {
  const app = Router();
  const taken = (name: string, except?: string) =>
    store.listMcpServers().some((s) => s.name === name && s.id !== except);
  app.get('/api/mcp-servers', (_req, res) => {
    res.json({ servers: store.listMcpServers().map(mcpServerView) });
  });
  app.post('/api/mcp-servers', (req, res) => {
    const parsed = parseBody(CreateMcpServerSchema, req.body, 'Servidor MCP inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const data = parsed.data;
    if (taken(data.name)) return error(res, 409, MCP_MESSAGES.duplicate);
    try {
      const now = new Date().toISOString();
      const server: McpServerRecord = {
        id: randomUUID(),
        name: data.name,
        description: data.description ?? '',
        transport: 'stdio',
        command: resolveMcpCommand(data.command, which),
        args: data.args ?? [],
        env: mergeEnv(data.env ?? []),
        ...(data.tools ? { tools: data.tools } : {}),
        createdAt: now,
        updatedAt: now,
      };
      res.status(201).json(mcpServerView(store.putMcpServer(server)));
    } catch (e) {
      error(res, errorStatus(e) ?? 400, message(e));
    }
  });
  app.patch('/api/mcp-servers/:id', (req, res) => {
    const current = store.getMcpServer(req.params.id);
    if (!current) return error(res, 404, MCP_MESSAGES.notFound);
    const parsed = parseBody(PatchMcpServerSchema, req.body, 'Servidor MCP inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const patch = parsed.data;
    if (patch.name && taken(patch.name, current.id)) return error(res, 409, MCP_MESSAGES.duplicate);
    try {
      const next: McpServerRecord = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        command: patch.command !== undefined ? resolveMcpCommand(patch.command, which) : current.command,
        args: patch.args ?? current.args,
        env: patch.env !== undefined ? mergeEnv(patch.env, current.env) : current.env,
        updatedAt: new Date().toISOString(),
      };
      if (patch.tools === null) delete next.tools;
      else if (patch.tools) next.tools = patch.tools;
      res.json(mcpServerView(store.putMcpServer(next)));
    } catch (e) {
      error(res, errorStatus(e) ?? 400, message(e));
    }
  });
  app.delete('/api/mcp-servers/:id', (req, res) => {
    if (!store.deleteMcpServer(req.params.id)) return error(res, 404, MCP_MESSAGES.notFound);
    res.status(204).end();
  });
  app.get('/api/projects/:id/mcp', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return error(res, 404, 'Projeto não encontrado');
    res.json(projectMcpReport(store, project));
  });
  app.put('/api/projects/:id/mcp', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return error(res, 404, 'Projeto não encontrado');
    const parsed = parseBody(ProjectMcpSchema, req.body, MCP_MESSAGES.projectLimit);
    if (!parsed.ok) return error(res, 400, parsed.message);
    const known = new Set(store.listMcpServers().map((server) => server.id));
    if (parsed.data.enabled.some((id) => !known.has(id))) return error(res, 400, MCP_MESSAGES.unknownIds);
    const updated = store.updateProject({ ...project, enabledMcp: parsed.data.enabled });
    res.json({ project: updated, report: projectMcpReport(store, updated) });
  });
  return app;
}
