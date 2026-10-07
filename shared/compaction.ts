// Conversation compaction (docs/specs/compaction.md): pieces shared by the server and the UI.

/** Activity text while a summary is being written. */
export const COMPACTING_TEXT = 'Compactando a conversa…';
/** Default and accepted range of the automatic threshold, in input tokens. */
export const AUTO_COMPACT_DEFAULT_TOKENS = 150_000;
export const AUTO_COMPACT_MIN_TOKENS = 1_000;
export const AUTO_COMPACT_MAX_TOKENS = 2_000_000;
/** History characters per token used for the character threshold. */
export const CHARS_PER_TOKEN = 4;
export const COMPACT_INVALID = 'Use /compactar sozinho, sem texto depois';

const COMPACT_COMMAND = /^\/compactar(?=\s|$)/i;
/**
 * `/compactar` typed as the whole message: 'compact' when alone, 'invalid' with text after
 * it, undefined for anything else. The server checks it before saved-command expansion.
 */
export function compactCommand(content: string): 'compact' | 'invalid' | undefined {
  const trimmed = content.trim();
  if (!COMPACT_COMMAND.test(trimmed)) return undefined;
  return trimmed.replace(COMPACT_COMMAND, '').trim() ? 'invalid' : 'compact';
}
