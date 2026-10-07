import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GraphifyConfig, OrchestrationConfig } from '../../shared/contracts.js';
import { GraphifyConfigSchema, OrchestrationPatchSchema } from '../../shared/schemas.js';
import { LocalizedError } from '../i18n.js';

const defaultOrchestration: OrchestrationConfig = { enabled: true, maxWorkers: 2, review: true };
const optionalKeys = ['workerProviderId', 'workerModel', 'reviewerProviderId', 'reviewerModel'] as const;

/** Merges an orchestration patch into `base`; `null` clears an optional field. Undefined when invalid. */
export function orchestrationConfig(value: unknown, base?: OrchestrationConfig): OrchestrationConfig | undefined {
  const parsed = OrchestrationPatchSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const merged: Record<string, unknown> = { ...(base || defaultOrchestration), ...parsed.data };
  for (const key of optionalKeys) if (merged[key] === null) delete merged[key];
  return merged as unknown as OrchestrationConfig;
}
export function graphifyConfig(value: unknown): GraphifyConfig | undefined {
  const parsed = GraphifyConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function projectPath(input: unknown) {
  if (typeof input !== 'string' || !input.trim()) throw new LocalizedError('projects.pathRequired');
  const p = realpathSync(resolve(input));
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new LocalizedError('projects.pathNotFolder');
  return p;
}

/** Merges a limits patch: absent keeps a field, `null` removes it. */
export function mergeLimits<T extends object>(base: T, patch: { [K in keyof T]?: T[K] | null }): T {
  const merged = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged as T;
}
