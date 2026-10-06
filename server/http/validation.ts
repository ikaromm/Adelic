import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphifyConfig, Mode, OrchestrationConfig, ProviderId } from '../../shared/contracts.js';

export const validProviders = new Set<ProviderId>(['codex', 'claude', 'kiro', 'opencode']);
export const modes = new Set<Mode>(['auto', 'fast', 'deep']);
export function orchestrationConfig(value: unknown, base?: OrchestrationConfig): OrchestrationConfig | undefined {
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
export function graphifyConfig(value: unknown): GraphifyConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== 'enabled') || typeof b.enabled !== 'boolean') return undefined;
  return { enabled: b.enabled };
}
export function projectPath(input: unknown) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path obrigatório');
  const p = realpathSync(resolve(input));
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error('O caminho precisa ser uma pasta existente');
  return p;
}
