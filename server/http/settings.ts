import { Router } from 'express';
import type { Settings, SpendLimits } from '../../shared/contracts.js';
import { SettingsPatchSchema, SkillPatchSchema, UsageQuerySchema, parseBody } from '../../shared/schemas.js';
import { usageReport } from '../usage.js';
import { mergeLimits } from './validation.js';
import { checkForUpdate } from '../updates.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

export function settingsRoutes({ store }: BackendContext) {
  const app = Router();
  app.patch('/api/settings', (req, res) => {
    const parsed = parseBody(SettingsPatchSchema, req.body, 'Configuração inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    // Unknown keys are ignored, as before; only defined fields change.
    const { spendLimits, ...rest } = parsed.data;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    const current = store.getSettings()!;
    const next: Settings = { ...current, ...patch };
    // Limits are merged field by field; `null` clears one. Off until the user turns them on.
    if (spendLimits)
      next.spendLimits = mergeLimits({ enabled: false, ...current.spendLimits }, spendLimits) as SpendLimits;
    res.json(store.setSettings(next));
  });
  // Usage today and this month (local time), the configured limits and those at 80% or more.
  app.get('/api/usage', (req, res) => {
    const query = parseBody(UsageQuerySchema, req.query, 'Parâmetros inválidos');
    if (!query.ok) return error(res, 400, query.message);
    const projectId = query.data.projectId;
    if (projectId && !store.getProject(projectId)) return error(res, 404, 'Projeto não encontrado');
    res.json(usageReport(store, projectId));
  });
  // Opt-in update check. `force` (manual "Verificar agora") works even when the automatic
  // check is off, since the user asked for it explicitly.
  app.get('/api/updates', async (req, res) => {
    const force = req.query.force === '1';
    if (!force && !store.getSettings()?.updateCheck) return res.json({ enabled: false });
    res.json({ enabled: true, ...(await checkForUpdate({ force })) });
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
