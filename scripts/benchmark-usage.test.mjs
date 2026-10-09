import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeTurnUsage, nativeUsageSnapshot } from './benchmark-usage.mjs';
test('fresh thread usage and resumed thread usage do not count earlier turns again', () => {
  const first = nativeUsageSnapshot({ input_tokens: 78372, output_tokens: 798, cached_input_tokens: 70400 });
  const resumed = nativeUsageSnapshot({ input_tokens: 128990, output_tokens: 1417, cached_input_tokens: 118784 });
  assert.deepEqual(nativeTurnUsage(first), first);
  assert.deepEqual(nativeTurnUsage(resumed, first), {
    inputTokens: 50618,
    outputTokens: 619,
    cachedInputTokens: 48384,
    reasoningOutputTokens: null,
  });
});
test('unknown baselines and decreased cumulative counters stay unknown', () => {
  assert.deepEqual(nativeTurnUsage({ inputTokens: 50, outputTokens: 20 }, { inputTokens: null, outputTokens: 30 }), {
    inputTokens: null,
    outputTokens: null,
  });
});
