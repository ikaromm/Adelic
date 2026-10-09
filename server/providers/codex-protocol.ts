import { z } from 'zod';

// Schemas for the Codex app-server notifications Adelic consumes. Each parse is lenient
// about extra fields (newer Codex versions add them) and strict about the fields Adelic
// acts on: a missing thread id or an unexpected type returns undefined, so the event is
// ignored instead of being half-applied.

const id = z.union([z.string(), z.number()]).transform(String);

export const DeltaParams = z.object({ threadId: id, delta: z.string() }).passthrough();

export const ItemParams = z
  .object({
    threadId: id,
    item: z
      .object({
        id: id.optional(),
        type: z.string(),
        command: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const TurnParams = z
  .object({
    threadId: id,
    turn: z.object({ id: id.optional(), status: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const ErrorParams = z
  .object({
    threadId: id,
    error: z.object({ message: z.unknown().optional() }).passthrough().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();

const count = z.number().int().nonnegative();
const Usage = z
  .object({
    inputTokens: count.optional(),
    cachedInputTokens: count.optional(),
    outputTokens: count.optional(),
    reasoningOutputTokens: count.optional(),
  })
  .passthrough();
/** thread/tokenUsage/updated: `last` is the latest turn, `total` the whole thread. No cost is sent. */
export const TokenUsageParams = z
  .object({
    threadId: id,
    turnId: id.optional(),
    tokenUsage: z.object({ last: Usage.optional(), total: Usage.optional() }).passthrough(),
  })
  .passthrough();

export const ThreadIdParams = z.object({ threadId: id.optional() }).passthrough();

export type CodexTokenCounts = z.output<typeof Usage>;

/**
 * Converts Codex's cumulative thread totals into cumulative usage for the active turn.
 * Duplicate notifications are harmless: callers emit the same value and UsageMeter replaces
 * the current attempt's snapshot. A resumed thread seeds the baseline from its last known total.
 */
export class CodexThreadUsage {
  private readonly latestByThread = new Map<string, CodexTokenCounts>();
  private baseline: CodexTokenCounts = {};

  beginTurn(threadId: string) {
    this.baseline = { ...(this.latestByThread.get(threadId) ?? {}) };
  }

  update(threadId: string, total: CodexTokenCounts | undefined): CodexTokenCounts | undefined {
    if (!total || Object.values(total).every((value) => value === undefined)) return undefined;
    const previous = this.latestByThread.get(threadId) ?? {};
    const latest = { ...previous };
    const delta: CodexTokenCounts = {};
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const) {
      const current = total[key];
      if (current === undefined) continue;
      // Totals are cumulative. A lower value can occur if the protocol resets accounting for
      // a resumed thread; start a fresh baseline at that value instead of emitting negatives.
      const prior = previous[key] ?? 0;
      if (current < prior) {
        latest[key] = current;
        this.baseline[key] = current;
        delta[key] = 0;
      } else {
        const base = this.baseline[key] ?? 0;
        latest[key] = current;
        delta[key] = Math.max(0, current - base);
      }
    }
    this.latestByThread.delete(threadId);
    this.latestByThread.set(threadId, latest);
    while (this.latestByThread.size > 512) this.latestByThread.delete(this.latestByThread.keys().next().value!);
    return delta;
  }
}

/** Parses notification params; undefined when they do not match. */
export const parseParams = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> | undefined => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

/** Tool-like items surfaced in the activity panel. */
export const TOOL_ITEM_TYPES = new Set(['commandExecution', 'mcpToolCall', 'fileChange']);
