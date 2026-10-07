import type { ProviderInfo, Thinking } from '../shared/contracts';
import { capabilitiesReasoning, modelFor } from '../shared/reasoning';
import { t, type MessageKey } from './i18n/catalog';

const LEVELS = new Set(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Name of a reasoning effort in the current locale; unknown tiers show their id. */
export function thinkingLabel(effort?: string): string {
  const value = effort || 'auto';
  return LEVELS.has(value) ? t(`thinking.${value}` as MessageKey) : value;
}

export function supportedThinking(provider: ProviderInfo | undefined, modelId?: string): Thinking[] {
  const capabilities = capabilitiesReasoning(provider, modelId);
  return ['auto', ...(capabilities.reasoning ? capabilities.efforts || [] : [])];
}

export { modelFor };

export function compatibleThinking(
  value: Thinking | undefined,
  provider: ProviderInfo | undefined,
  modelId?: string,
): Thinking {
  const selected = value || 'auto';
  return supportedThinking(provider, modelId).includes(selected) ? selected : 'auto';
}
