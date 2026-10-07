import { z } from 'zod';
import { validReasoningEffort } from './reasoning.js';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES } from './attachments.js';

// Request schemas shared by the server routes (and usable by the UI). Each field keeps
// the exact error message the API returned before zod, so clients see no change.
// Strings follow the API's convention: trimmed, non-empty and length-bounded.

export const providerIds = ['codex', 'claude', 'kiro', 'opencode'] as const;
export const modeIds = ['auto', 'fast', 'deep'] as const;
export const ProviderIdSchema = z.enum(providerIds);
export const ModeSchema = z.enum(modeIds);

/** Trimmed, non-empty string up to `max` characters (the API's former `str()` helper). */
export const text = (max = 200) =>
  z
    .string()
    .refine((value) => value.trim().length > 0 && value.length <= max)
    .transform((value) => value.trim());
const effort = z.string().refine((value) => value === 'auto' || validReasoningEffort(value));

// Issues carrying an API message are tagged so routes can tell them from zod's defaults.
const apiIssue = (ctx: z.RefinementCtx, message: string) =>
  ctx.addIssue({ code: 'custom', message, params: { api: true } });

/**
 * Optional field: `undefined` means "not sent"; anything else must match `schema`.
 * The outer `.optional()` matters: in zod 4 a transformed field is otherwise required.
 */
const optional = <T extends z.ZodType>(schema: T, message: string) =>
  z
    .unknown()
    .superRefine((value, ctx) => {
      if (value !== undefined && !schema.safeParse(value).success) apiIssue(ctx, message);
    })
    .transform((value) => (value === undefined ? undefined : (schema.parse(value) as z.output<T>)))
    .optional();
/** Required field with its own message. */
const required = <T extends z.ZodType>(schema: T, message: string) =>
  z
    .unknown()
    .superRefine((value, ctx) => {
      if (!schema.safeParse(value).success) apiIssue(ctx, message);
    })
    .transform((value) => schema.parse(value) as z.output<T>);

const workerModel = z.string().refine((value) => value.trim().length > 0 && value.length <= 120);
/** Patch for a project's orchestration; `null` removes an optional field. Merged with the current config. */
export const OrchestrationPatchSchema = z
  .object({
    enabled: z.boolean(),
    maxWorkers: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    review: z.boolean(),
    workerProviderId: ProviderIdSchema.nullable(),
    workerModel: workerModel.nullable(),
    reviewerProviderId: ProviderIdSchema.nullable(),
    reviewerModel: workerModel.nullable(),
  })
  .partial()
  .strict();
export const GraphifyConfigSchema = z.object({ enabled: z.boolean() }).strict();

export const CreateProjectSchema = z.object({
  name: text(),
  path: text(4096),
  memoryWorkspace: text(100),
  memoryProject: text(100),
});
export const PatchProjectSchema = z.object({
  name: optional(text(), 'Campos de projeto inválidos'),
  memoryWorkspace: optional(text(100), 'Campos de projeto inválidos'),
  memoryProject: optional(text(100), 'Campos de projeto inválidos'),
});

const projectRef = z.union([z.null(), text()]);
export const CreateSessionSchema = z.object({
  projectId: optional(projectRef, 'projectId inválido'),
  providerId: optional(ProviderIdSchema, 'providerId inválido'),
  mode: optional(ModeSchema, 'mode inválido'),
  model: optional(text(120), 'model inválido'),
  thinking: optional(effort, 'thinking inválido'),
});
export const PatchSessionSchema = z.object({
  projectId: optional(projectRef, 'projectId inválido'),
  title: optional(text(160), 'title inválido'),
  providerId: optional(ProviderIdSchema, 'providerId inválido'),
  model: optional(z.union([z.null(), text(120)]), 'model inválido'),
  mode: optional(ModeSchema, 'mode inválido'),
  thinking: optional(effort, 'thinking inválido'),
});

export const AttachmentIdsSchema = z
  .array(z.string().regex(/^[0-9a-f-]{36}$/i))
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .refine((ids) => new Set(ids).size === ids.length);
export const SendMessageSchema = z.object({
  content: required(text(32000), 'content obrigatório (máximo 32000 caracteres)'),
  clientMessageId: optional(text(128), 'clientMessageId inválido'),
  // Ownership (each id belongs to this conversation) is checked by the route against the store.
  attachmentIds: optional(
    AttachmentIdsSchema,
    `attachmentIds inválido (até ${MAX_ATTACHMENTS_PER_MESSAGE} anexos, sem repetição)`,
  ),
});
/** Upload: file content in base64 (the route raises the JSON limit only for itself). */
export const UploadAttachmentSchema = z.object({
  name: required(text(200), 'name obrigatório (até 200 caracteres)'),
  mime: optional(z.string().max(100), 'mime inválido'),
  data: required(
    z
      .string()
      .min(1)
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    'data deve ser o conteúdo do arquivo em base64',
  ),
});
export const ApprovalDecisionSchema = z.object({
  decision: required(z.enum(['approve', 'deny']), 'decision deve ser approve ou deny'),
});
export const SettingsPatchSchema = z.object({
  defaultProviderId: optional(ProviderIdSchema, 'defaultProviderId inválido'),
  defaultMode: optional(ModeSchema, 'defaultMode inválido'),
  memoryEnabled: optional(z.boolean(), 'memoryEnabled deve ser booleano'),
  sandbox: optional(z.enum(['read-only', 'workspace-write']), 'sandbox inválido'),
  responseStyle: optional(z.enum(['concise', 'balanced']), 'responseStyle inválido'),
  approvalMode: optional(z.enum(['auto-safe', 'manual']), 'approvalMode inválido'),
  updateCheck: optional(z.boolean(), 'updateCheck deve ser booleano'),
  autoRetry: optional(z.boolean(), 'autoRetry deve ser booleano'),
});
export const SkillPatchSchema = z.object({ enabled: required(z.boolean(), 'enabled deve ser booleano') });

export type ParseResult<T> = { ok: true; data: T } | { ok: false; message: string };
/**
 * Parses a request body. Missing bodies count as `{}`. On failure returns the first
 * API message from the schema, or `fallback` when the failure has none of its own.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown, fallback: string): ParseResult<z.output<T>> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues.find((item) => item.code === 'custom' && item.params?.api);
  return { ok: false, message: issue?.message ?? fallback };
}

/** Relative `.md` note path inside a memory scope (no absolute paths, `..` or backslashes). */
export const memoryPath = text(500).refine(
  (p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\') && p.endsWith('.md'),
);
const memoryBody = z.string().max(50000);
/** Editor save: explicit scope; `expectedVersion` null creates, a string edits that version. */
export const SharedMemoryWriteSchema = z.object({
  workspace: text(100),
  project: text(100),
  path: text(500),
  body: memoryBody,
  expectedVersion: z.union([z.null(), z.string()]),
});
/** Legacy save bound to an Adelic project (no version check from the client). */
export const ProjectMemoryWriteSchema = z.object({ projectId: text(), path: text(500), body: memoryBody });
