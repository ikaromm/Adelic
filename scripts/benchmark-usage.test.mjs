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
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });
});

test('native counters preserve units, aliases, and valid cached/reasoning subsets', () => {
  const snapshot = nativeUsageSnapshot({
    input_tokens: 120,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens_details: { reasoning_tokens: 12 },
  });
  assert.deepEqual(snapshot, {
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 80,
    reasoningOutputTokens: 12,
  });
  assert.deepEqual(nativeTurnUsage(snapshot), snapshot);
});

test('invalid or unavailable native counters remain unknown instead of becoming zero', () => {
  assert.deepEqual(nativeUsageSnapshot({}), {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });
  assert.deepEqual(nativeUsageSnapshot({ input_tokens: -1, output_tokens: '4' }), {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });
  assert.deepEqual(nativeTurnUsage({ inputTokens: null, outputTokens: null }), {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });
});

test('cached input and reasoning output cannot exceed their parent counters', () => {
  assert.deepEqual(
    nativeUsageSnapshot({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 11,
      reasoning_output_tokens: 6,
    }),
    {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    },
  );
  assert.deepEqual(
    nativeTurnUsage(
      { inputTokens: 20, cachedInputTokens: 15, outputTokens: 10, reasoningOutputTokens: 8 },
      { inputTokens: 10, cachedInputTokens: 8, outputTokens: 8, reasoningOutputTokens: 7 },
    ),
    { inputTokens: 10, cachedInputTokens: 7, outputTokens: 2, reasoningOutputTokens: 1 },
  );
});
