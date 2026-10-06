import type { ProviderInfo, Thinking } from '../shared/contracts';
import { capabilitiesReasoning, modelFor } from '../shared/reasoning';

const labels: Record<string, string> = {
  auto: 'Automático', none: 'Sem raciocínio', minimal: 'Mínimo', low: 'Baixo',
  medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo', ultra: 'Ultra',
};

export function thinkingLabel(effort?: string): string {
  return effort ? labels[effort] || effort : labels.auto;
}

export function supportedThinking(provider: ProviderInfo | undefined, modelId?: string): Thinking[] {
  const capabilities = capabilitiesReasoning(provider, modelId);
  return ['auto', ...(capabilities.reasoning ? capabilities.efforts || [] : [])];
}

export { modelFor };

export function compatibleThinking(value: Thinking | undefined, provider: ProviderInfo | undefined, modelId?: string): Thinking {
  const selected = value || 'auto';
  return supportedThinking(provider, modelId).includes(selected) ? selected : 'auto';
}
