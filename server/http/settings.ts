import { Router } from 'express';
import type { Settings } from '../../shared/contracts.js';
import { SettingsPatchSchema, SkillPatchSchema, parseBody } from '../../shared/schemas.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

export function settingsRoutes({ store }: BackendContext) {
  const app = Router();
  app.patch('/api/settings', (req, res) => {
    const parsed = parseBody(SettingsPatchSchema, req.body, 'Configuração inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    // Unknown keys are ignored, as before; only defined fields change.
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    const next: Settings = { ...store.getSettings()!, ...patch };
    res.json(store.setSettings(next));
  });
  app.patch('/api/skills/:id', (req, res) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) return error(res, 404, 'Skill não encontrada');
    const parsed = parseBody(SkillPatchSchema, req.body, 'enabled deve ser booleano');
    if (!parsed.ok) return error(res, 400, parsed.message);
    skill.enabled = parsed.data.enabled;
    res.json(store.setSkill(skill));
  });
  return app;
}
