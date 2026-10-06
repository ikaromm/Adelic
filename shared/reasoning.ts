import type { ProviderInfo, ReasoningEffort } from './contracts.js';

export const REASONING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const validReasoningEffort = (value: unknown): value is ReasoningEffort => typeof value === 'string' && REASONING_ID.test(value);
export const modelFor = (provider: ProviderInfo | undefined, model?: string) => {
  if (!provider) return undefined;
  if (model) return provider.models.find(item => item.id === model);
  return (provider.defaultModel ? provider.models.find(item => item.id === provider.defaultModel) : undefined) ?? provider.models.find(item => item.isDefault);
};
const advertisedEfforts = (provider: ProviderInfo | undefined, model?: string) => {
  const values = modelFor(provider, model)?.efforts ?? [];
  return [...new Set(values.filter(value => validReasoningEffort(value) && value !== 'auto'))];
};
export const capabilitiesReasoning = (provider: ProviderInfo | undefined, model?: string) => {
  const efforts = advertisedEfforts(provider, model);
  return { reasoning: provider?.capabilities.reasoning !== false && Boolean(efforts.length), efforts: efforts.length ? efforts : undefined };
};
export const supportsEffort = (provider: ProviderInfo | undefined, model: string | undefined, effort: string) => {
  const caps = capabilitiesReasoning(provider, model);
  return caps.reasoning && Boolean(caps.efforts?.includes(effort));
};
export const adaptEffort = (provider: ProviderInfo | undefined, model: string | undefined, requested?: string): string | undefined => {
  const info = modelFor(provider, model), efforts = advertisedEfforts(provider, model);
  if (!efforts.length || provider?.capabilities.reasoning === false) return undefined;
  if (!requested || requested === 'auto') return efforts.includes('low') ? 'low' : info?.defaultReasoningEffort && efforts.includes(info.defaultReasoningEffort) ? info.defaultReasoningEffort : efforts[0];
  if (efforts.includes(requested)) return requested;
  const order = ['none','minimal','low','medium','high','xhigh','max','ultra'];
  const rank = order.indexOf(requested);
  if (rank < 0) return info?.defaultReasoningEffort && efforts.includes(info.defaultReasoningEffort) ? info.defaultReasoningEffort : efforts[0];
  const lower = efforts.filter(value => order.indexOf(value) >= 0 && order.indexOf(value) <= rank);
  return lower.sort((a,b)=>order.indexOf(b)-order.indexOf(a))[0] ?? efforts
    .filter(value=>order.indexOf(value)>=0)
    .sort((a,b)=>order.indexOf(a)-order.indexOf(b))[0]
    ?? (info?.defaultReasoningEffort && efforts.includes(info.defaultReasoningEffort) ? info.defaultReasoningEffort : efforts[0]);
};
