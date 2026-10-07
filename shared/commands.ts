// Saved slash commands (docs/specs/saved-commands.md): name rules, limits, parsing of a
// message that starts with `/name`, and template expansion. Shared by the server (which
// expands) and the composer (which only suggests names).
import type { Mode } from './contracts.js';

/** Lowercase letters, digits and hyphens, 1–32 characters, not starting with a hyphen. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const COMMAND_DESCRIPTION_MAX = 160;
export const COMMAND_TEMPLATE_MAX = 8000;
/** Files read from `<project>/.adelic/commands/`; the rest are reported and ignored. */
export const REPO_COMMANDS_MAX_FILES = 50;
export const commandModes = ['fast', 'balanced', 'deep'] as const;
export type CommandMode = (typeof commandModes)[number];
export type CommandSource = 'builtin' | 'global' | 'repo' | 'project';

/** Validation messages, identical in the API and the Settings form. */
export const COMMAND_MESSAGES = {
  name: 'Nome inválido: use de 1 a 32 letras minúsculas, números ou hífens, começando por letra ou número',
  description: `Descrição até ${COMMAND_DESCRIPTION_MAX} caracteres`,
  template: `Modelo obrigatório (até ${COMMAND_TEMPLATE_MAX} caracteres)`,
  mode: 'mode deve ser fast, balanced ou deep',
};

/** First problem with a command's editable fields, or '' when valid (the API checks again). */
export function commandFieldsError(fields: { name: string; description: string; template: string }) {
  if (!COMMAND_NAME.test(fields.name)) return COMMAND_MESSAGES.name;
  if (fields.description.length > COMMAND_DESCRIPTION_MAX) return COMMAND_MESSAGES.description;
  if (!fields.template.trim() || fields.template.length > COMMAND_TEMPLATE_MAX) return COMMAND_MESSAGES.template;
  return '';
}

/** Precedence, highest first: project command > repository file > global command > built-in. */
export const COMMAND_PRECEDENCE: CommandSource[] = ['project', 'repo', 'global', 'builtin'];

/** A user command stored in SQLite (`projectId: null` = global). */
export interface SavedCommand {
  id: string;
  name: string;
  description: string;
  template: string;
  mode?: CommandMode;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}
/** A command as listed by GET /api/commands, from any source. */
export interface CommandEntry {
  id: string;
  name: string;
  description: string;
  template: string;
  mode?: CommandMode;
  source: CommandSource;
  projectId: string | null;
  /** Built-ins and repository files cannot be edited or deleted from the UI. */
  readOnly: boolean;
  /** False when a command with the same name and higher precedence wins. */
  active: boolean;
  /** Repository commands: path relative to the project root. */
  file?: string;
}
/** A repository command file that was ignored, and why. */
export interface CommandIssue {
  file: string;
  reason: string;
}
export interface CommandList {
  commands: CommandEntry[];
  issues: CommandIssue[];
}

/** `/name args` at the very start of a message; undefined for anything else. */
export function parseSlash(content: string): { name: string; args: string } | undefined {
  const match = /^\/([a-z0-9][a-z0-9-]{0,31})(?=\s|$)([\s\S]*)$/.exec(content);
  return match ? { name: match[1], args: match[2].trim() } : undefined;
}

const ARGS_SOURCE = String.raw`\{\{\s*args\s*\}\}`;
/**
 * Replaces every `{{args}}` with the text typed after the command (empty when none).
 * A template without `{{args}}` gets the arguments appended after a blank line, so
 * nothing the user typed is lost.
 */
export function expandTemplate(template: string, args: string) {
  if (new RegExp(ARGS_SOURCE).test(template)) return template.replace(new RegExp(ARGS_SOURCE, 'g'), () => args).trim();
  return args ? `${template.trim()}\n\n${args}` : template.trim();
}

/** Conversation mode used for one run: "balanced" means the adaptive router (Auto). */
export function runModeFor(mode: CommandMode | undefined): Mode | undefined {
  if (!mode) return undefined;
  return mode === 'balanced' ? 'auto' : mode;
}
