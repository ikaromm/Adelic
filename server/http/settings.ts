import { Router } from 'express';
import type { Settings, SpendLimits } from '../../shared/contracts.js';
import { SettingsPatchSchema, SkillPatchSchema, UsageQuerySchema, parseBody } from '../../shared/schemas.js';
import { usageReport } from '../usage.js';
import { mergeLimits } from './validation.js';
import { checkForUpdate } from '../updates.js';
import { LOCAL_ONLY, requestKind } from './auth.js';
import { error } from './common.js';
import type { BackendContext } from './context.js';

export function settingsRoutes({ store, automations }: BackendContext) {
  const app = Router();
  app.patch('/api/settings', (req, res) => {
    const parsed = parseBody(SettingsPatchSchema, req.body, 'settings.invalid', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    // Remote-access options cannot be changed from the remote side itself; from the internet
    // the global automations switch is refused too (docs/specs/remote-access.md).
    const kind = requestKind(req);
    if (kind !== 'local' && parsed.data.approvalMode === 'automatic') return error(res, 403, LOCAL_ONLY);
    if (
      kind !== 'local' &&
      (parsed.data.terminalRemote !== undefined || parsed.data.internetManualApproval !== undefined)
    )
      return error(res, 403, LOCAL_ONLY);
    if (kind === 'internet' && parsed.data.automations !== undefined)
      return error(res, 403, 'settings.automationsInternet');
    // Unknown keys are ignored, as before; only defined fields change.
    const { spendLimits, ...rest } = parsed.data;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    const previous = store.getSettings()!;
    const next: Settings = { ...previous, ...patch };
    // Limits are merged field by field; `null` clears one. Off until the user turns them on.
    if (spendLimits)
      next.spendLimits = mergeLimits({ enabled: false, ...previous.spendLimits }, spendLimits) as SpendLimits;
    const saved = store.setSettings(next);
    if ((previous.automations === true) !== (saved.automations === true)) automations.globalChanged();
    res.json(saved);
  });
  // Usage today and this month (local time), the configured limits and those at 80% or more.
  app.get('/api/usage', (req, res) => {
    const query = parseBody(UsageQuerySchema, req.query, 'common.invalidParams', req.locale);
    if (!query.ok) return error(res, 400, query.message);
    const projectId = query.data.projectId;
    if (projectId && !store.getProject(projectId)) return error(res, 404, 'common.projectNotFound');
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
    const metadata = store.listSkills().find((skill) => skill.id === req.params.id);
    if (!metadata) return error(res, 404, 'settings.skillNotFound');
    const parsed = parseBody(SkillPatchSchema, req.body, 'remote.enabledBoolean', req.locale);
    if (!parsed.ok) return error(res, 400, parsed.message);
    // Disabling is catalog administration and must work even if a local body is absent or
    // invalid. Enabling still validates that the complete instructions can be activated.
    if (parsed.data.enabled && !store.getSkill(metadata.id)) return error(res, 400, 'settings.skillBodyInvalid');
    const updated = store.setSkillEnabled(metadata.id, parsed.data.enabled);
    if (!updated) return error(res, 404, 'settings.skillNotFound');
    res.json(updated);
  });
  return app;
}
