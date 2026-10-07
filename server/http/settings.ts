import { Router } from 'express';
import type { Settings } from '../../shared/contracts.js';
import { SettingsPatchSchema, SkillPatchSchema, parseBody } from '../../shared/schemas.js';
import { checkForUpdate } from '../updates.js';
import { isLoopbackRequest } from './auth.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

export function settingsRoutes({ store }: BackendContext) {
  const app = Router();
  app.patch('/api/settings', (req, res) => {
    const parsed = parseBody(SettingsPatchSchema, req.body, 'Configuração inválida');
    if (!parsed.ok) return error(res, 400, parsed.message);
    // The remote terminal opt-in cannot be granted from the remote side itself.
    if (parsed.data.terminalRemote !== undefined && !isLoopbackRequest(req))
      return error(res, 403, 'Esta opção só pode ser alterada neste computador, não pelo acesso remoto');
    // Unknown keys are ignored, as before; only defined fields change.
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    const next: Settings = { ...store.getSettings()!, ...patch };
    res.json(store.setSettings(next));
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
