import { z } from 'zod';
import { validReasoningEffort } from './reasoning.js';
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_IMAGE_BYTES } from './attachments.js';
import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_MESSAGE_KEYS,
  COMMAND_NAME,
  COMMAND_TEMPLATE_MAX,
  commandModes,
} from './commands.js';
import { MENTION_PATH_MAX } from './mentions.js';
import { AUTO_COMPACT_MAX_TOKENS, AUTO_COMPACT_MIN_TOKENS } from './compaction.js';
import {
  MCP_ARG_MAX,
  MCP_ARGS_MAX,
  MCP_COMMAND_MAX,
  MCP_DESCRIPTION_MAX,
  MCP_ENV_MAX,
  MCP_ENV_NAME,
  MCP_ENV_VALUE_MAX,
  MCP_MESSAGE_KEYS as MCP_MESSAGES,
  MCP_NAME,
  MCP_PROJECT_MAX,
  MCP_TOOL_NAME,
  MCP_TOOLS_MAX,
} from './mcp.js';
import { TERMINAL_COMMAND_MAX, TERMINAL_TIMEOUT_MAX_SEC, TERMINAL_TIMEOUT_MIN_SEC } from './terminal.js';
import {
  AUTOMATION_DENY_MAX_MINUTES,
  AUTOMATION_INTERVAL_MAX_HOURS,
  AUTOMATION_INTERVAL_MIN_HOURS,
  AUTOMATION_NAME_MAX,
  AUTOMATION_PROMPT_MAX,
  isValidTimeZone,
} from './automations.js';
import { SPEND_COST_MAX, SPEND_TOKENS_MAX, hasCents } from './spend-limits.js';
import {
  BLOCKED_COMMANDS_MAX,
  BLOCKED_PATTERN_MAX,
  HOOK_CHECKS_MAX,
  HOOK_COMMAND_MAX,
  HOOK_NAME_MAX,
  HOOK_TIMEOUT_DEFAULT,
  HOOK_TIMEOUT_MAX,
  HOOK_TIMEOUT_MIN,
} from './hooks.js';
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, usernameProblem } from './remote-access.js';
import type { Locale, Vars } from './i18n.js';
import { isValidationKey, validationText, vmsg, type ValidationMessage } from './validation-messages.js';

// Request schemas shared by the server routes (and usable by the UI). Each field keeps
// the exact error message the API returned before zod, so clients see no change. Messages are
// catalog keys (shared/validation-messages.ts): `parseBody(…, locale)` answers in the request's
// language, pt-BR by default.
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

// Issues carrying an API message are tagged so routes can tell them from zod's defaults; the
// key and variables travel in `params` so parseBody can translate them.
const apiIssue = (ctx: z.RefinementCtx, message: ValidationMessage) =>
  ctx.addIssue({
    code: 'custom',
    message: message.text,
    params: { api: true, key: message.key, ...(message.vars ? { vars: message.vars } : {}) },
  });
const invalid = (field: string) => vmsg('validation.invalidField', { field });
const boolean = (field: string) => vmsg('validation.booleanField', { field });
const texts = <K extends string>(messages: Record<K, ValidationMessage>) =>
  Object.fromEntries(Object.entries<ValidationMessage>(messages).map(([k, m]) => [k, m.text])) as Record<K, string>;

/**
 * Optional field: `undefined` means "not sent"; anything else must match `schema`.
 * The outer `.optional()` matters: in zod 4 a transformed field is otherwise required.
 */
const optional = <T extends z.ZodType>(schema: T, message: ValidationMessage) =>
  z
    .unknown()
    .superRefine((value, ctx) => {
      if (value !== undefined && !schema.safeParse(value).success) apiIssue(ctx, message);
    })
    .transform((value) => (value === undefined ? undefined : (schema.parse(value) as z.output<T>)))
    .optional();
/** Required field with its own message. */
const required = <T extends z.ZodType>(schema: T, message: ValidationMessage) =>
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

// Usage limits (docs/specs/spend-limits.md): `null` clears a limit, absent keeps it.
export const SpendTokensSchema = z.number().int().min(0).max(SPEND_TOKENS_MAX);
export const SpendCostSchema = z.number().min(0).max(SPEND_COST_MAX).refine(hasCents);
export const SPEND_LIMITS_MESSAGE = validationText('validation.spendLimits');
export const SpendLimitsPatchSchema = z
  .object({
    enabled: z.boolean(),
    dailyTokens: SpendTokensSchema.nullable(),
    monthlyTokens: SpendTokensSchema.nullable(),
    dailyCostUsd: SpendCostSchema.nullable(),
    monthlyCostUsd: SpendCostSchema.nullable(),
  })
  .partial()
  .strict();
export const ProjectSpendLimitsPatchSchema = z.union([
  z.null(),
  z
    .object({ monthlyTokens: SpendTokensSchema.nullable(), monthlyCostUsd: SpendCostSchema.nullable() })
    .partial()
    .strict(),
]);
/** "Continuar mesmo assim": skip the usage limits for this one request (never stored). */
const overrideLimit = () => optional(z.boolean(), boolean('overrideLimit'));

/** An ai-memory scope, with the same rules as a project's memoryWorkspace/memoryProject. */
export const MemoryScopeSchema = z.object({ workspace: text(100), project: text(100) }).strict();

export const CreateProjectSchema = z.object({
  name: text(),
  path: text(4096).optional(),
  remote: z
    .object({ hostId: text(100), path: text(4096).refine((p) => p.startsWith('/') && !p.includes('\0')) })
    .strict()
    .optional(),
  memoryWorkspace: text(100),
  memoryProject: text(100),
  approvalMode: optional(z.enum(['auto-safe', 'manual', 'automatic']), invalid('approvalMode')),
});
export const PatchProjectSchema = z.object({
  name: optional(text(), vmsg('validation.projectFields')),
  git: optional(z.object({ runHooks: z.boolean() }).strict(), invalid('git')),
  memoryWorkspace: optional(text(100), vmsg('validation.projectFields')),
  memoryProject: optional(text(100), vmsg('validation.projectFields')),
  approvalMode: optional(z.union([z.null(), z.enum(['auto-safe', 'manual', 'automatic'])]), invalid('approvalMode')),
  spendLimits: optional(ProjectSpendLimitsPatchSchema, vmsg('validation.projectSpendLimits')),
});

const projectRef = z.union([z.null(), text()]);
export const CreateSessionSchema = z.object({
  projectId: optional(projectRef, invalid('projectId')),
  providerId: optional(ProviderIdSchema, invalid('providerId')),
  mode: optional(ModeSchema, invalid('mode')),
  model: optional(text(120), invalid('model')),
  thinking: optional(effort, invalid('thinking')),
  approvalMode: optional(z.enum(['auto-safe', 'manual', 'automatic']), invalid('approvalMode')),
});
export const PatchSessionSchema = z.object({
  projectId: optional(projectRef, invalid('projectId')),
  title: optional(text(160), invalid('title')),
  providerId: optional(ProviderIdSchema, invalid('providerId')),
  model: optional(z.union([z.null(), text(120)]), invalid('model')),
  mode: optional(ModeSchema, invalid('mode')),
  thinking: optional(effort, invalid('thinking')),
  planFirst: optional(z.boolean(), boolean('planFirst')),
  approvalMode: optional(z.union([z.null(), z.enum(['auto-safe', 'manual', 'automatic'])]), invalid('approvalMode')),
});
/** POST /api/sessions/:id/handoff (docs/specs/provider-handoff.md). */
export const HandoffSchema = z.object({
  providerId: required(ProviderIdSchema, invalid('providerId')),
  model: optional(text(120), invalid('model')),
  summary: required(
    z.enum(['model', 'local', 'none']),
    vmsg('validation.oneOf3', { field: 'summary', a: 'model', b: 'local', c: 'none' }),
  ),
  overrideLimit: overrideLimit(),
});

export const AttachmentIdsSchema = z
  .array(z.string().regex(/^[0-9a-f-]{36}$/i))
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .refine((ids) => new Set(ids).size === ids.length);
export const SendMessageSchema = z.object({
  content: required(text(32000), vmsg('validation.content', { max: 32000 })),
  clientMessageId: optional(text(128), invalid('clientMessageId')),
  // Ownership (each id belongs to this conversation) is checked by the route against the store.
  attachmentIds: optional(AttachmentIdsSchema, vmsg('validation.attachmentIds', { max: MAX_ATTACHMENTS_PER_MESSAGE })),
  overrideLimit: overrideLimit(),
});
/** Edit and resend a user message (docs/specs/edit-branch.md); omitted attachmentIds keep the message's own. */
export const EditMessageSchema = SendMessageSchema;
/** "Ramificar daqui": copy the conversation up to and including `messageId`. */
export const BranchSessionSchema = z.object({
  messageId: required(text(128), vmsg('validation.requiredField', { field: 'messageId' })),
});
/** Upload: file content in base64 (the route raises the JSON limit only for itself). */
export const UploadAttachmentSchema = z.object({
  name: required(text(200), vmsg('validation.attachmentName', { max: 200 })),
  mime: optional(z.string().max(100), invalid('mime')),
  data: required(
    z
      .string()
      .min(1)
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    vmsg('validation.attachmentData'),
  ),
});
const attachmentIdsField = optional(
  AttachmentIdsSchema,
  vmsg('validation.attachmentIds', { max: MAX_ATTACHMENTS_PER_MESSAGE }),
);
export const QueueMessageSchema = z.object({
  content: required(text(32000), vmsg('validation.content', { max: 32000 })),
  clientId: optional(text(128), invalid('clientId')),
  attachmentIds: attachmentIdsField,
  /** Applies only when the message starts right away (the conversation was idle). */
  overrideLimit: overrideLimit(),
});
/** "Retomar fila"; with `overrideLimit`, only the next message passes the usage limits. */
export const QueueResumeSchema = z.object({ overrideLimit: overrideLimit() });
export const QueueEditSchema = z.object({
  content: required(text(32000), vmsg('validation.content', { max: 32000 })),
});
/** "Enviar agora": new text (`content`) or a queued item (`itemId`); the route requires exactly one. */
export const SendNowSchema = z.object({
  content: optional(text(32000), vmsg('validation.content', { max: 32000 })),
  clientId: optional(text(128), invalid('clientId')),
  itemId: optional(text(128), invalid('itemId')),
  attachmentIds: attachmentIdsField,
  overrideLimit: overrideLimit(),
});
export const ApprovalDecisionSchema = z.object({
  decision: required(
    z.enum(['approve', 'deny']),
    vmsg('validation.oneOf2', { field: 'decision', a: 'approve', b: 'deny' }),
  ),
});
export const MODEL_FALLBACK_MAX = 3;
/** Settings › "Trocar de modelo se o atual estiver sobrecarregado": up to 3 distinct models. */
export const ModelFallbackSchema = z
  .object({
    enabled: z.boolean(),
    models: z
      .array(z.object({ providerId: ProviderIdSchema, model: text(120) }).strict())
      .max(MODEL_FALLBACK_MAX)
      .refine((items) => new Set(items.map((i) => `${i.providerId}\u0000${i.model}`)).size === items.length),
  })
  .strict();
/** "Tentar com outro modelo": the run is repeated with this provider and/or model. */
export const RetryRunSchema = z.object({
  providerId: optional(ProviderIdSchema, invalid('providerId')),
  model: optional(text(120), invalid('model')),
  overrideLimit: overrideLimit(),
});
/** Self-update channel of a git checkout (docs/specs/self-update.md). */
export const UpdateChannelSchema = z.enum(['master', 'develop']);
export const UpdateCheckSchema = z
  .object({
    channel: optional(UpdateChannelSchema, vmsg('validation.oneOf2', { field: 'channel', a: 'master', b: 'develop' })),
  })
  .strict();
/** "Atualizar agora": always an explicit confirmation. */
export const UpdateApplySchema = z
  .object({
    confirm: required(z.literal(true), vmsg('validation.confirm.update')),
    channel: optional(UpdateChannelSchema, vmsg('validation.oneOf2', { field: 'channel', a: 'master', b: 'develop' })),
    /** The commit or version the confirmation showed; refused if it changed since. */
    target: optional(z.string().regex(/^[0-9a-f]{7,64}$|^\d+\.\d+\.\d+$/), invalid('target')),
  })
  .strict();
export const SettingsPatchSchema = z.object({
  defaultProviderId: optional(ProviderIdSchema, invalid('defaultProviderId')),
  defaultMode: optional(ModeSchema, invalid('defaultMode')),
  memoryEnabled: optional(z.boolean(), boolean('memoryEnabled')),
  detachedMemory: optional(z.union([z.null(), MemoryScopeSchema]), vmsg('validation.detachedMemory')),
  sandbox: optional(z.enum(['read-only', 'workspace-write']), invalid('sandbox')),
  responseStyle: optional(z.enum(['concise', 'balanced']), invalid('responseStyle')),
  approvalMode: optional(z.enum(['auto-safe', 'manual', 'automatic']), invalid('approvalMode')),
  updateCheck: optional(z.boolean(), boolean('updateCheck')),
  updateChannel: optional(
    UpdateChannelSchema,
    vmsg('validation.oneOf2', { field: 'updateChannel', a: 'master', b: 'develop' }),
  ),
  autoRetry: optional(z.boolean(), boolean('autoRetry')),
  notifications: optional(z.boolean(), boolean('notifications')),
  modelFallback: optional(ModelFallbackSchema, vmsg('validation.modelFallback', { max: MODEL_FALLBACK_MAX })),
  autoCompact: optional(z.boolean(), boolean('autoCompact')),
  voiceDictation: optional(z.boolean(), boolean('voiceDictation')),
  autoCompactTokens: optional(
    z.number().int().min(AUTO_COMPACT_MIN_TOKENS).max(AUTO_COMPACT_MAX_TOKENS),
    vmsg('validation.intRange', {
      field: 'autoCompactTokens',
      min: AUTO_COMPACT_MIN_TOKENS,
      max: AUTO_COMPACT_MAX_TOKENS,
    }),
  ),
  terminalRemote: optional(z.boolean(), boolean('terminalRemote')),
  internetManualApproval: optional(z.boolean(), boolean('internetManualApproval')),
  automations: optional(z.boolean(), boolean('automations')),
  spendLimits: optional(SpendLimitsPatchSchema, vmsg('validation.spendLimits')),
  language: optional(
    z.enum(['auto', 'pt-BR', 'en']),
    vmsg('validation.oneOf3', { field: 'language', a: 'auto', b: 'pt-BR', c: 'en' }),
  ),
});
/** POST /api/projects/:id/terminal (docs/specs/terminal-preview.md). */
export const TerminalRunSchema = z
  .object({
    command: required(
      z.string().refine((value) => value.trim().length > 0 && value.length <= TERMINAL_COMMAND_MAX),
      vmsg('validation.terminalCommand', { max: TERMINAL_COMMAND_MAX }),
    ),
    timeoutSec: optional(
      z.number().int().min(TERMINAL_TIMEOUT_MIN_SEC).max(TERMINAL_TIMEOUT_MAX_SEC),
      vmsg('validation.intRange', {
        field: 'timeoutSec',
        min: TERMINAL_TIMEOUT_MIN_SEC,
        max: TERMINAL_TIMEOUT_MAX_SEC,
      }),
    ),
  })
  .strict();
export const TerminalStopSchema = z.object({}).strict();
/** "Compactar conversa" takes no options besides the one-off limit override (docs/specs/compaction.md). */
export const CompactSchema = z.object({ overrideLimit: z.boolean().optional() }).strict();
/** Isolated worktree per conversation (docs/specs/worktrees.md). */
export const CreateWorktreeSchema = z.object({}).strict();
export const ApplyWorktreeSchema = z.object({
  confirm: required(z.literal(true), vmsg('validation.confirm.applyWorktree')),
});
export const DiscardWorktreeSchema = z.object({
  deleteBranch: optional(z.boolean(), boolean('deleteBranch')),
});
export const RestoreRunSchema = z.object({
  confirm: required(z.literal(true), vmsg('validation.confirm.restore')),
});
/** Plan mode (docs/specs/plan-mode.md). */
// The global JSON body limit is 128 KB; this keeps a plan with accents well under it.
export const PLAN_MARKDOWN_MAX = 60_000;
export const PlanEditSchema = z.object({
  markdown: required(text(PLAN_MARKDOWN_MAX), vmsg('validation.planMarkdown', { max: PLAN_MARKDOWN_MAX })),
});
export const PlanApproveSchema = z.object({
  mode: required(z.enum(['all', 'next']), vmsg('validation.oneOf2', { field: 'mode', a: 'all', b: 'next' })),
  overrideLimit: overrideLimit(),
});
export const PlanTaskStatusSchema = z.object({
  status: required(
    z.enum(['skipped', 'pending']),
    vmsg('validation.oneOf2', { field: 'status', a: 'skipped', b: 'pending' }),
  ),
});
export const PlanSaveSchema = z.object({
  overwrite: optional(z.boolean(), boolean('overwrite')),
});
export const SkillPatchSchema = z.object({ enabled: required(z.boolean(), boolean('enabled')) });

// Saved commands (docs/specs/saved-commands.md).
const commandName = z.string().regex(COMMAND_NAME);
const commandDescription = z
  .string()
  .max(COMMAND_DESCRIPTION_MAX)
  .transform((value) => value.trim());
const commandTemplate = text(COMMAND_TEMPLATE_MAX);
const commandMessages = COMMAND_MESSAGE_KEYS;
export const CreateCommandSchema = z.object({
  name: required(commandName, commandMessages.name),
  description: optional(commandDescription, commandMessages.description),
  template: required(commandTemplate, commandMessages.template),
  mode: optional(z.enum(commandModes), commandMessages.mode),
  projectId: optional(projectRef, invalid('projectId')),
});
/** `mode: null` removes the override. The scope (global or project) cannot change. */
export const PatchCommandSchema = z.object({
  name: optional(commandName, commandMessages.name),
  description: optional(commandDescription, commandMessages.description),
  template: optional(commandTemplate, commandMessages.template),
  mode: optional(z.union([z.null(), z.enum(commandModes)]), commandMessages.mode),
});

// Scheduled automations (docs/specs/automations.md).
const AUTOMATION_MESSAGE_KEYS = {
  name: vmsg('validation.automation.name', { max: AUTOMATION_NAME_MAX }),
  prompt: vmsg('validation.automation.prompt', { max: AUTOMATION_PROMPT_MAX }),
  projectId: vmsg('validation.automation.projectId'),
  schedule: vmsg('validation.automation.schedule', {
    min: AUTOMATION_INTERVAL_MIN_HOURS,
    max: AUTOMATION_INTERVAL_MAX_HOURS,
  }),
  timezone: vmsg('validation.automation.timezone'),
  deny: vmsg('validation.automation.deny', { max: AUTOMATION_DENY_MAX_MINUTES }),
};
/** The pt-BR texts of the automation messages (the API's historical text). */
export const AUTOMATION_MESSAGES = texts(AUTOMATION_MESSAGE_KEYS);
const automationTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const AutomationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: automationTime }).strict(),
  z
    .object({
      kind: z.literal('weekly'),
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length)
        .transform((days) => [...days].sort((a, b) => a - b)),
      time: automationTime,
    })
    .strict(),
  z
    .object({
      kind: z.literal('interval'),
      hours: z.number().int().min(AUTOMATION_INTERVAL_MIN_HOURS).max(AUTOMATION_INTERVAL_MAX_HOURS),
    })
    .strict(),
]);
const timeZone = z.string().refine(isValidTimeZone);
const denyMinutes = z.union([z.null(), z.number().int().min(1).max(AUTOMATION_DENY_MAX_MINUTES)]);
export const CreateAutomationSchema = z.object({
  name: required(text(AUTOMATION_NAME_MAX), AUTOMATION_MESSAGE_KEYS.name),
  prompt: required(text(AUTOMATION_PROMPT_MAX), AUTOMATION_MESSAGE_KEYS.prompt),
  projectId: required(text(), AUTOMATION_MESSAGE_KEYS.projectId),
  providerId: optional(ProviderIdSchema, invalid('providerId')),
  model: optional(text(120), invalid('model')),
  mode: optional(ModeSchema, invalid('mode')),
  schedule: required(AutomationScheduleSchema, AUTOMATION_MESSAGE_KEYS.schedule),
  timezone: optional(timeZone, AUTOMATION_MESSAGE_KEYS.timezone),
  enabled: optional(z.boolean(), boolean('enabled')),
  catchUp: optional(z.boolean(), boolean('catchUp')),
  denyApprovalsAfterMinutes: optional(denyMinutes, AUTOMATION_MESSAGE_KEYS.deny),
});
/** `null` on providerId, model or mode goes back to the defaults. */
export const PatchAutomationSchema = z.object({
  name: optional(text(AUTOMATION_NAME_MAX), AUTOMATION_MESSAGE_KEYS.name),
  prompt: optional(text(AUTOMATION_PROMPT_MAX), AUTOMATION_MESSAGE_KEYS.prompt),
  projectId: optional(text(), AUTOMATION_MESSAGE_KEYS.projectId),
  providerId: optional(ProviderIdSchema.nullable(), invalid('providerId')),
  model: optional(text(120).nullable(), invalid('model')),
  mode: optional(ModeSchema.nullable(), invalid('mode')),
  schedule: optional(AutomationScheduleSchema, AUTOMATION_MESSAGE_KEYS.schedule),
  timezone: optional(timeZone, AUTOMATION_MESSAGE_KEYS.timezone),
  enabled: optional(z.boolean(), boolean('enabled')),
  catchUp: optional(z.boolean(), boolean('catchUp')),
  denyApprovalsAfterMinutes: optional(denyMinutes, AUTOMATION_MESSAGE_KEYS.deny),
});
/** Query of GET /api/usage. */
export const UsageQuerySchema = z.object({
  projectId: optional(text(200), invalid('projectId')),
});
// Per-project hooks (docs/specs/project-hooks.md).
const AfterEditCheckSchema = z
  .object({
    name: text(HOOK_NAME_MAX),
    command: text(HOOK_COMMAND_MAX).refine((value) => !value.includes('\0')),
    timeoutSec: z.number().int().min(HOOK_TIMEOUT_MIN).max(HOOK_TIMEOUT_MAX).default(HOOK_TIMEOUT_DEFAULT),
    enabled: z.boolean().default(true),
  })
  .strict();
const HOOKS_MESSAGE_KEYS = {
  afterEdit: vmsg('validation.hooks.afterEdit', {
    max: HOOK_CHECKS_MAX,
    nameMax: HOOK_NAME_MAX,
    commandMax: HOOK_COMMAND_MAX,
    timeoutMin: HOOK_TIMEOUT_MIN,
    timeoutMax: HOOK_TIMEOUT_MAX,
  }),
  blockedCommands: vmsg('validation.hooks.blockedCommands', {
    max: BLOCKED_COMMANDS_MAX,
    patternMax: BLOCKED_PATTERN_MAX,
  }),
  autoFix: boolean('autoFix'),
};
export const HOOKS_MESSAGES = texts(HOOKS_MESSAGE_KEYS);
/** PUT /api/projects/:id/hooks replaces the whole configuration; absent fields become empty/off. */
export const ProjectHooksSchema = z
  .object({
    afterEdit: optional(z.array(AfterEditCheckSchema).max(HOOK_CHECKS_MAX), HOOKS_MESSAGE_KEYS.afterEdit).transform(
      (value) => value ?? [],
    ),
    blockedCommands: optional(
      z
        .array(text(BLOCKED_PATTERN_MAX).transform((value) => value.replace(/\s+/g, ' ')))
        .max(BLOCKED_COMMANDS_MAX)
        .refine((items) => new Set(items).size === items.length),
      HOOKS_MESSAGE_KEYS.blockedCommands,
    ).transform((value) => value ?? []),
    autoFix: optional(z.boolean(), HOOKS_MESSAGE_KEYS.autoFix).transform((value) => value ?? false),
  })
  .strict();
/** POST /api/projects/:id/hooks/test runs one configured check now. */
export const HookTestSchema = z.object({
  index: required(
    z
      .number()
      .int()
      .min(0)
      .max(HOOK_CHECKS_MAX - 1),
    invalid('index'),
  ),
});

/** Query of GET /api/projects/:id/files (the file autocomplete for `@` mentions). */
export const ProjectFilesQuerySchema = z.object({
  query: optional(
    z.string().max(MENTION_PATH_MAX),
    vmsg('validation.mentionQuery', { max: MENTION_PATH_MAX }),
  ).transform((value) => value ?? ''),
  limit: optional(
    z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .refine((n) => n >= 1 && n <= 200),
    vmsg('validation.intFromTo', { field: 'limit', min: 1, max: 200 }),
  ).transform((value) => value ?? 50),
  /** The conversation asking: with a worktree, its files are listed instead of the project's. */
  sessionId: optional(text(128), invalid('sessionId')),
});

export type ParseResult<T> = { ok: true; data: T } | { ok: false; message: string };
/**
 * Parses a request body. Missing bodies count as `{}`. On failure returns the first API
 * message from the schema in `locale` (pt-BR by default), or `fallback` when the failure has
 * none of its own. A fallback that is a validation key is translated too; any other fallback
 * (plain text, a server catalog key) is returned as is, for `error()` to translate.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  fallback: string | ValidationMessage,
  locale?: Locale,
): ParseResult<z.output<T>> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues.find((item) => item.code === 'custom' && item.params?.api);
  const params =
    issue?.code === 'custom'
      ? (issue.params as { key?: unknown; vars?: Vars } | undefined)
      : typeof fallback === 'string'
        ? { key: fallback }
        : fallback;
  if (isValidationKey(params?.key)) return { ok: false, message: validationText(params.key, params.vars, locale) };
  return { ok: false, message: issue?.message ?? (typeof fallback === 'string' ? fallback : fallback.text) };
}
export { vmsg } from './validation-messages.js';

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

// MCP catalog (docs/specs/mcp-catalog.md). Only local stdio servers; remote transports are refused.
const mcpEnvItem = z
  .object({
    name: z.string().regex(MCP_ENV_NAME),
    from: z.enum(['adelic-env', 'literal']),
    value: z.string().min(1).max(MCP_ENV_VALUE_MAX).optional(),
  })
  .strict()
  .refine((item) => item.from === 'literal' || item.value === undefined);
const mcpEnv = z
  .array(mcpEnvItem)
  .max(MCP_ENV_MAX)
  .refine((items) => new Set(items.map((item) => item.name)).size === items.length);
const mcpArgs = z.array(z.string().max(MCP_ARG_MAX)).max(MCP_ARGS_MAX);
const mcpTools = z
  .array(z.string().regex(MCP_TOOL_NAME))
  .max(MCP_TOOLS_MAX)
  .refine((items) => new Set(items).size === items.length);
const mcpFields = {
  description: optional(
    z
      .string()
      .max(MCP_DESCRIPTION_MAX)
      .transform((value) => value.trim()),
    MCP_MESSAGES.description,
  ),
  transport: optional(z.literal('stdio'), MCP_MESSAGES.transport),
  args: optional(mcpArgs, MCP_MESSAGES.args),
  env: optional(mcpEnv, MCP_MESSAGES.env),
  // `null` (PATCH) removes the allowlist; an empty list is refused (it would allow nothing).
  tools: optional(z.union([z.null(), mcpTools.min(1)]), MCP_MESSAGES.tools),
};
// Remote-transport fields are refused explicitly instead of being silently dropped.
const noRemote = (value: unknown, ctx: z.RefinementCtx) => {
  if (
    value &&
    typeof value === 'object' &&
    ['url', 'headers', 'http_headers', 'bearer_token_env_var'].some((key) => key in value)
  )
    apiIssue(ctx, MCP_MESSAGES.transport);
};
export const CreateMcpServerSchema = z
  .unknown()
  .superRefine(noRemote)
  .pipe(
    z.object({
      name: required(z.string().regex(MCP_NAME), MCP_MESSAGES.name),
      command: required(text(MCP_COMMAND_MAX), MCP_MESSAGES.command),
      ...mcpFields,
    }),
  );
export const PatchMcpServerSchema = z
  .unknown()
  .superRefine(noRemote)
  .pipe(
    z.object({
      name: optional(z.string().regex(MCP_NAME), MCP_MESSAGES.name),
      command: optional(text(MCP_COMMAND_MAX), MCP_MESSAGES.command),
      ...mcpFields,
    }),
  );
export const ProjectMcpSchema = z.object({
  enabled: required(
    z
      .array(text(128))
      .max(MCP_PROJECT_MAX)
      .refine((ids) => new Set(ids).size === ids.length),
    MCP_MESSAGES.projectLimit,
  ),
});

/** Git panel (docs/specs/git-panel.md). Paths are checked against the current status list. */
export const GIT_COMMIT_MESSAGE_MAX = 5000;
const gitPaths = z.array(z.string().min(1).max(4096)).max(1000);
export const GitStageSchema = z
  .object({ paths: optional(gitPaths, invalid('paths')), all: optional(z.boolean(), invalid('all')) })
  .refine((v) => v.all === true || (v.paths?.length ?? 0) > 0, {
    message: validationText('validation.gitPaths'),
    params: { api: true, key: 'validation.gitPaths' },
  });
export const GitDiscardSchema = z.object({
  paths: required(gitPaths.min(1), vmsg('validation.requiredField', { field: 'paths' })),
  confirm: required(z.literal(true), vmsg('validation.confirm.discard')),
  /** Also confirms files that have staged changes too (those are kept). */
  mixed: optional(z.boolean(), invalid('mixed')),
});
export const GitCommitSchema = z.object({
  message: required(
    z.string().refine((m) => m.trim().length > 0 && m.length <= GIT_COMMIT_MESSAGE_MAX),
    vmsg('validation.gitMessage', { max: GIT_COMMIT_MESSAGE_MAX }),
  ),
});
export const GitPushSchema = z.object({
  confirm: required(z.literal(true), vmsg('validation.confirm.push')),
});
export const GitDiffQuerySchema = z.object({
  path: required(z.string().min(1).max(4096), vmsg('validation.requiredField', { field: 'path' })),
  staged: optional(z.enum(['0', '1', 'true', 'false']), invalid('staged')),
});

// Remote login (docs/specs/remote-access.md). Only accepted from this computer.
export const RemoteAccountSchema = z
  .object({
    username: required(
      z.string().refine((value) => !usernameProblem(value)),
      vmsg('validation.remoteUsername', { min: USERNAME_MIN, max: USERNAME_MAX }),
    ),
    password: required(
      z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
      vmsg('validation.remotePassword', { min: PASSWORD_MIN, max: PASSWORD_MAX }),
    ),
  })
  .strict();
export const RemoteFunnelSchema = z.object({ enabled: required(z.boolean(), boolean('enabled')) }).strict();
