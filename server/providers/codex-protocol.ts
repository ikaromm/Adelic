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

export const ThreadIdParams = z.object({ threadId: id.optional() }).passthrough();

/** Parses notification params; undefined when they do not match. */
export const parseParams = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> | undefined => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

/** Tool-like items surfaced in the activity panel. */
export const TOOL_ITEM_TYPES = new Set(['commandExecution', 'mcpToolCall', 'fileChange']);
