/** Codex 0.160 exec JSON reports cumulative thread usage, including on resume. */
export function nativeUsageSnapshot(usage) {
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? null,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
    cachedInputTokens:
      usage.cached_input_tokens ??
      usage.cachedInputTokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.inputTokenDetails?.cachedTokens ??
      null,
    reasoningOutputTokens:
      usage.reasoning_output_tokens ??
      usage.reasoningOutputTokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.outputTokenDetails?.reasoningTokens ??
      null,
  };
}

export function nativeTurnUsage(snapshot, baseline) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => {
      const before = baseline === undefined ? 0 : baseline[key];
      return [
        key,
        Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(before) && before >= 0 && value >= before
          ? value - before
          : null,
      ];
    }),
  );
}
