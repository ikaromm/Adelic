import { Router } from 'express';
import type { Settings } from '../../shared/contracts.js';
import { error } from './common.js';
import { modes, validProviders } from './validation.js';
import type { BackendContext } from './context.js';

export function settingsRoutes({ store }: BackendContext) {
  const app = Router();
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
  app.patch('/api/skills/:id', (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) return error(res, 404, 'Skill não encontrada');
    if (typeof req.body?.enabled !== 'boolean') return error(res, 400, 'enabled deve ser booleano');
    skill.enabled = req.body.enabled;
    res.json(store.setSkill(skill));
  });
  return app;
}
