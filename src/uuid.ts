/**
 * RFC 4122 v4 id for client-side keys (optimistic messages, idempotency keys).
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost), so it is missing
 * when the app is opened over plain HTTP on a Tailscale address; `getRandomValues` is
 * available in every context and is just as random.
 */
export function uuid(): string {
  const native = globalThis.crypto?.randomUUID;
  if (typeof native === 'function') return native.call(globalThis.crypto);
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
