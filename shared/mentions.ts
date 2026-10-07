// `@file` mentions (docs/specs/mentions.md), shared by the composer, the user bubble and
// the server. A mention is `@path` or `@"path with spaces"` at the start of the message or
// after whitespace, so e-mail addresses (`a@b.com`) and `x@y` are never mentions. Text inside
// Markdown code (fenced blocks and inline `code`) is skipped.

/** Mentions of one message whose content is inlined in the prompt. */
export const MAX_MENTIONED_FILES = 5;
export const MAX_MENTION_BYTES = 512 * 1024;
export const MAX_MENTION_TOTAL_BYTES = 1024 * 1024;
/** Longest path accepted in a mention (and in the file search query). */
export const MENTION_PATH_MAX = 1024;

export interface MentionToken {
  /** Index of the `@` in the message. */
  start: number;
  /** Index right after the token (closing quote included). */
  end: number;
  path: string;
}

// Punctuation that usually ends a sentence rather than a file name: `veja @a.ts, depois…`.
const TRAILING = /[.,;:!?)\]}'>]+$/;
const MENTION = /(^|\s)@(?:"([^"\n]+)"|([^\s"`]\S*))/g;

/** Same length as `content`, with Markdown code replaced by spaces so indices still match. */
function maskCode(content: string) {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return content.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** Every mention in `content`, in order (repeats included). */
export function findMentions(content: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  for (const match of maskCode(content).matchAll(MENTION)) {
    const start = match.index + match[1].length;
    let path = match[2] ?? match[3];
    let end = start + 1 + (match[2] !== undefined ? path.length + 2 : path.length);
    if (match[2] === undefined) {
      const trimmed = path.replace(TRAILING, '');
      end -= path.length - trimmed.length;
      path = trimmed;
    }
    path = path.trim();
    if (!path || path.length > MENTION_PATH_MAX) continue;
    tokens.push({ start, end, path });
  }
  return tokens;
}

/** Distinct mentioned paths, in first-mention order. */
export function parseMentions(content: string): string[] {
  return [...new Set(findMentions(content).map((t) => t.path))];
}

/** Text inserted by the composer for `path`: quoted when it has whitespace. */
export function formatMention(path: string) {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export type MessageSegment = { text: string; mention?: string };
/** `content` split into plain text and mention tokens, for rendering chips. */
export function mentionSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let at = 0;
  for (const token of findMentions(content)) {
    if (token.start > at) segments.push({ text: content.slice(at, token.start) });
    segments.push({ text: content.slice(token.start, token.end), mention: token.path });
    at = token.end;
  }
  if (at < content.length) segments.push({ text: content.slice(at) });
  return segments;
}

/**
 * The mention being typed right before the caret: `@` at the start or after whitespace,
 * followed by the partial path (an opening quote allows spaces). Undefined otherwise.
 */
export function activeMention(value: string, caret: number): { start: number; query: string } | undefined {
  const before = value.slice(0, caret);
  const match = /(^|\s)@(?:"([^"\n]*)|([^\s"`]*))$/.exec(before);
  if (!match) return undefined;
  const query = match[2] ?? match[3];
  if (query.length > MENTION_PATH_MAX) return undefined;
  return { start: match.index + match[1].length, query };
}

/**
 * Ranks project files for a query: basename prefix, then basename substring, then path
 * substring, then path subsequence (case-insensitive). Ties keep the shorter path, then
 * the listing order, so results are stable. An empty query keeps shallow files first.
 */
export function rankFiles(files: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; tier: number; index: number }[] = [];
  files.forEach((path, index) => {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let tier: number;
    if (!q) tier = path.split('/').length;
    else if (base.startsWith(q)) tier = 0;
    else if (base.includes(q)) tier = 1;
    else if (lower.includes(q)) tier = 2;
    else if (isSubsequence(q, lower)) tier = 3;
    else return;
    scored.push({ path, tier, index });
  });
  scored.sort((a, b) => a.tier - b.tier || (q ? a.path.length - b.path.length : 0) || a.index - b.index);
  return scored.map((s) => s.path);
}

function isSubsequence(needle: string, haystack: string) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) if (haystack[j] === needle[i]) i++;
  return i === needle.length;
}
