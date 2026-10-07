import { readFile } from 'node:fs/promises';
import type { AttachmentMeta, RunInput, StoredAttachment } from '../shared/contracts.js';
import { checkAttachment, sniffImage, type AttachmentKind } from '../shared/attachments.js';
import type { Store } from './store.js';

export const attachmentMeta = ({ id, name, mime, size }: StoredAttachment): AttachmentMeta => ({
  id,
  name,
  mime,
  size,
});

export type DecodedUpload =
  { ok: true; kind: AttachmentKind; mime: string; bytes: Buffer } | { ok: false; message: string };

/**
 * Validates an upload from its decoded bytes: the size and type rules from
 * shared/attachments.ts, then the content itself (image signature, UTF-8 text without NUL).
 */
export function decodeUpload(name: string, declaredMime: string, base64: string): DecodedUpload {
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.byteLength) return { ok: false, message: `“${name}” está vazio.` };
  const check = checkAttachment(name, declaredMime, bytes.byteLength);
  if (!check.ok) return check;
  if (check.kind === 'image') {
    const actual = sniffImage(bytes);
    if (!actual) return { ok: false, message: `“${name}” não é uma imagem PNG, JPEG, WebP ou GIF válida.` };
    return { ok: true, kind: 'image', mime: actual, bytes };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: `“${name}” não é texto UTF-8.` };
  }
  if (text.includes('\u0000')) return { ok: false, message: `“${name}” parece ser um arquivo binário.` };
  return { ok: true, kind: 'text', mime: 'text/plain', bytes };
}

/** Markdown fence longer than any backtick run in `content`, so the file cannot close it early. */
function fenceFor(content: string) {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

/** `[label]` followed by `content` in a fence it cannot close; used for attachments and mentions. */
export function inlineTextBlock(label: string, content: string) {
  const fence = fenceFor(content);
  return `[${label}]\n${fence}\n${content}\n${fence}`;
}

/** Delimited block that inlines a text attachment into the prompt. */
export function inlineTextAttachment(name: string, content: string) {
  return inlineTextBlock(`Arquivo anexado: ${name}`, content);
}

export interface RunAttachments {
  /** Images, passed to the runtime as files (RunInput.attachments). */
  images: NonNullable<RunInput['attachments']>;
  /** Text files already formatted for the prompt; empty when there are none. */
  text: string;
}

/** Reads a message's attachments from disk for a run. Files are capped at upload (512 KB for text). */
export async function loadRunAttachments(store: Store, attachments: StoredAttachment[]): Promise<RunAttachments> {
  const images: RunAttachments['images'] = [];
  const blocks: string[] = [];
  for (const attachment of attachments) {
    const path = store.attachmentPath(attachment);
    if (attachment.kind === 'image') {
      images.push({ path, name: attachment.name, mime: attachment.mime });
      continue;
    }
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      throw new Error(`O anexo “${attachment.name}” não foi encontrado nos dados do Adelic.`);
    }
    blocks.push(inlineTextAttachment(attachment.name, content));
  }
  return { images, text: blocks.length ? `\n\n${blocks.join('\n\n')}` : '' };
}

export { IMAGES_UNSUPPORTED } from './providers/common.js';
