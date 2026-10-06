import { z } from 'zod';

// Shapes of what the ai-memory MCP server sends back, validated at the boundary. Fields
// beyond the ones Adelic reads are allowed (passthrough), so newer ai-memory versions keep
// working; missing or mistyped fields Adelic depends on become clear errors.

export const JsonRpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
});

export const ToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z
      .object({ properties: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Tool = z.infer<typeof ToolSchema>;
export const ToolsListSchema = z.object({ tools: z.array(ToolSchema).default([]) }).passthrough();

/** tools/call result: MCP content blocks plus optional structured content and error flag. */
export const ToolCallResultSchema = z
  .object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
    structuredContent: z.unknown().optional(),
  })
  .passthrough();
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

const text = z.union([z.string(), z.number()]).transform(String);
/** A search hit; ai-memory versions and other servers name fields differently. */
export const HitSchema = z
  .object({
    path: text.optional(),
    relative_path: text.optional(),
    title: text.optional(),
    name: text.optional(),
    snippet: text.optional(),
    excerpt: text.optional(),
    content: text.optional(),
  })
  .passthrough()
  .transform((h) => ({
    path: h.path ?? h.relative_path ?? '',
    title: h.title ?? h.name ?? h.path ?? 'Nota',
    snippet: (h.snippet ?? h.excerpt ?? h.content ?? '').slice(0, 600),
  }));
export const SearchResultSchema = z.union([
  z.array(HitSchema),
  z
    .object({
      hits: z.array(HitSchema).optional(),
      results: z.array(HitSchema).optional(),
      pages: z.array(HitSchema).optional(),
    })
    .passthrough()
    .transform((r) => r.hits ?? r.results ?? r.pages ?? []),
]);

export const PageSchema = z
  .object({
    path: text.optional(),
    title: text.nullable().optional(),
    body: z.string().optional(),
    content: z.string().optional(),
    text: z.string().optional(),
    frontmatter: z.unknown().optional(),
  })
  .passthrough();

/** Parses or throws an error naming what the server sent, for the UI. */
export function parseService<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw Object.assign(
    new Error(
      `Resposta incompatível do ai-memory (${what}): ${issue?.path.join('.') || 'raiz'} ${issue?.message ?? ''}`.trim(),
    ),
    { status: 502 },
  );
}
