import { describe, expect, it } from 'vitest';
import type { ProviderInfo } from '../shared/contracts';
import { compatibleThinking, modelFor, supportedThinking, thinkingLabel } from '../src/reasoning';

const provider = (overrides: Partial<ProviderInfo> = {}): ProviderInfo => ({ id: 'codex', name: 'Codex', installed: true, available: true, status: 'ready', detail: '', models: [{ id: 'm1', name: 'Model 1', efforts: ['low', 'high', 'xhigh', 'max', 'ultra'] }, { id: 'm2', name: 'Model 2' }], defaultModel: 'm1', capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true }, ...overrides });

describe('Thinking options', () => {
  it('uses all advertised extra efforts and names them correctly', () => {
    expect(supportedThinking(provider(), 'm1')).toEqual(['auto', 'low', 'high', 'xhigh', 'max', 'ultra']);
    expect(thinkingLabel('none')).toBe('Sem raciocínio');
    expect(thinkingLabel('minimal')).toBe('Mínimo');
    expect(thinkingLabel('xhigh')).toBe('Muito alto');
    expect(thinkingLabel('max')).toBe('Máximo');
    expect(thinkingLabel('ultra')).toBe('Ultra');
    expect(thinkingLabel('future-tier')).toBe('future-tier');
    expect(thinkingLabel(undefined)).toBe('Automático');
  });

  it('uses the provider default model, not a guessed catalog', () => {
    expect(modelFor(provider())?.id).toBe('m1');
    expect(supportedThinking(provider())).toEqual(['auto', 'low', 'high', 'xhigh', 'max', 'ultra']);
    expect(supportedThinking(provider({ models: [], defaultModel: 'not-listed' }))).toEqual(['auto']);
    expect(supportedThinking(provider({ models: [{ id: 'plain', name: 'Plain' }], defaultModel: 'plain' }))).toEqual(['auto']);
  });

  it('uses declared defaults, accepts arbitrary advertised identifiers and deduplicates invalid entries', () => {
    const catalogue = provider({ defaultModel: undefined, models: [
      { id: 'first', name: 'First', efforts: ['tier-v2', 'tier-v2', 'auto', '', 'unsafe value'] },
      { id: 'declared', name: 'Declared default', isDefault: true, defaultReasoningEffort: 'deep-tier', efforts: ['deep-tier'] },
    ] });
    expect(modelFor(catalogue)?.id).toBe('declared');
    expect(supportedThinking(catalogue)).toEqual(['auto', 'deep-tier']);
    expect(supportedThinking(catalogue, 'first')).toEqual(['auto', 'tier-v2']);
    expect(compatibleThinking('tier-v2', catalogue, 'first')).toBe('tier-v2');
    expect(compatibleThinking('unadvertised', catalogue, 'first')).toBe('auto');
  });

  it('preserves unknown historical values for display but offers recovery through Auto', () => {
    const providerWithoutAnnouncement = provider({ models: [{ id: 'plain', name: 'Plain' }], defaultModel: 'plain' });
    expect(compatibleThinking('legacy-effort', providerWithoutAnnouncement, 'plain')).toBe('auto');
    expect(supportedThinking(providerWithoutAnnouncement, 'plain')).toEqual(['auto']);
  });

  it('resets an incompatible effort and honors a provider capability limit', () => {
    const model = provider();
    expect(compatibleThinking('medium', model, 'm1')).toBe('auto');
    const incapable = provider({ capabilities: { fast: true, tools: true, approvals: false, cancel: false, reasoning: false } });
    expect(supportedThinking(incapable, 'm1')).toEqual(['auto']);
    expect(compatibleThinking('ultra', incapable, 'm1')).toBe('auto');
  });

  it('does not offer an old unsupported value as a choice, including for unknown models', () => {
    const catalogue = provider();
    expect(supportedThinking(catalogue, 'unknown')).toEqual(['auto']);
    expect(compatibleThinking('ultra', catalogue, 'unknown')).toBe('auto');
  });
});
