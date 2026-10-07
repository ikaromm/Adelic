import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { COMMAND_RESERVED, RESERVED_COMMAND_NAMES, type SavedCommand } from '../../shared/commands.js';
import { CreateCommandSchema, PatchCommandSchema, parseBody } from '../../shared/schemas.js';
import { listCommands } from '../commands.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

const DUPLICATE = 'Já existe um comando com esse nome neste escopo';

/** Saved slash commands (docs/specs/saved-commands.md). Built-ins and repository files are read-only. */
export function commandsRoutes({ store }: BackendContext) {
  const app = Router();
  const taken = (name: string, projectId: string | null, except?: string) =>
    store.listCommands(projectId).some((c) => c.name === name && c.id !== except);
  app.get('/api/commands', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
    const project = projectId ? store.getProject(projectId) : undefined;
    if (projectId && !project) return error(res, 404, 'Projeto não encontrado');
    res.json(listCommands(store, project));
  });
  app.post('/api/commands', (req, res) => {
    const parsed = parseBody(CreateCommandSchema, req.body, 'Comando inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const { name, description = '', template, mode, projectId = null } = parsed.data;
    if (RESERVED_COMMAND_NAMES.includes(name)) return error(res, 400, COMMAND_RESERVED);
    if (projectId && !store.getProject(projectId)) return error(res, 404, 'Projeto não encontrado');
    if (taken(name, projectId)) return error(res, 409, DUPLICATE);
    const now = new Date().toISOString();
    const command: SavedCommand = {
      id: randomUUID(),
      name,
      description,
      template,
      ...(mode ? { mode } : {}),
      projectId,
      createdAt: now,
      updatedAt: now,
    };
    res.status(201).json(store.putCommand(command));
  });
  app.patch('/api/commands/:id', (req, res) => {
    const current = store.getCommand(req.params.id);
    if (!current) return error(res, 404, 'Comando não encontrado');
    const parsed = parseBody(PatchCommandSchema, req.body, 'Comando inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    const patch = parsed.data;
    const next: SavedCommand = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      template: patch.template ?? current.template,
      updatedAt: new Date().toISOString(),
    };
    if (patch.name && RESERVED_COMMAND_NAMES.includes(patch.name)) return error(res, 400, COMMAND_RESERVED);
    if (patch.mode === null) delete next.mode;
    else if (patch.mode) next.mode = patch.mode;
    if (taken(next.name, next.projectId, next.id)) return error(res, 409, DUPLICATE);
    res.json(store.putCommand(next));
  });
  app.delete('/api/commands/:id', (req, res) => {
    if (!store.deleteCommand(req.params.id)) return error(res, 404, 'Comando não encontrado');
    res.status(204).end();
  });
  return app;
}
