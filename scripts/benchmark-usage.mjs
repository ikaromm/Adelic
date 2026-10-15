/** Codex 0.160 exec JSON reports cumulative thread usage, including on resume. */
function usageCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function nativeUsageSnapshot(usage) {
  const snapshot = {
    inputTokens: usageCounter(usage.input_tokens ?? usage.inputTokens),
    outputTokens: usageCounter(usage.output_tokens ?? usage.outputTokens),
    cachedInputTokens: usageCounter(
      usage.cached_input_tokens ??
        usage.cachedInputTokens ??
        usage.input_tokens_details?.cached_tokens ??
        usage.inputTokenDetails?.cachedTokens,
    ),
    reasoningOutputTokens: usageCounter(
      usage.reasoning_output_tokens ??
        usage.reasoningOutputTokens ??
        usage.output_tokens_details?.reasoning_tokens ??
        usage.outputTokenDetails?.reasoningTokens,
    ),
  };
  if (
    snapshot.cachedInputTokens !== null &&
    (snapshot.inputTokens === null || snapshot.cachedInputTokens > snapshot.inputTokens)
  ) {
    snapshot.cachedInputTokens = null;
  }
  if (
    snapshot.reasoningOutputTokens !== null &&
    (snapshot.outputTokens === null || snapshot.reasoningOutputTokens > snapshot.outputTokens)
  ) {
    snapshot.reasoningOutputTokens = null;
  }
  return snapshot;
}

export function nativeTurnUsage(snapshot, baseline) {
  const turn = Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => {
      const before = baseline === undefined ? 0 : baseline[key];
      return [
        key,
        usageCounter(value) !== null && usageCounter(before) !== null && value >= before ? value - before : null,
      ];
    }),
  );

  if (turn.cachedInputTokens !== null && (turn.inputTokens === null || turn.cachedInputTokens > turn.inputTokens)) {
    turn.cachedInputTokens = null;
  }
  if (
    turn.reasoningOutputTokens !== null &&
    (turn.outputTokens === null || turn.reasoningOutputTokens > turn.outputTokens)
  ) {
    turn.reasoningOutputTokens = null;
  }
  return turn;
}
