// Integrated command runner ("Terminal") and local preview (docs/specs/terminal-preview.md).
// Shared by the server (bounded output), the UI (same bounding, URL checks) and the desktop
// navigation policy (preview frames).

/** Commands running at the same time in one project. */
export const TERMINAL_MAX_RUNNING = 3;
/** Output kept per command (stdout and stderr together): the last 256 KB. */
export const TERMINAL_OUTPUT_LIMIT = 256 * 1024;
export const TERMINAL_COMMAND_MAX = 8000;
export const TERMINAL_TIMEOUT_DEFAULT_SEC = 10 * 60;
export const TERMINAL_TIMEOUT_MIN_SEC = 60;
export const TERMINAL_TIMEOUT_MAX_SEC = 60 * 60;
/** Commands kept per project in the browser history (command text only). */
export const TERMINAL_HISTORY_MAX = 50;

export type TerminalStream = 'stdout' | 'stderr';
export interface TerminalChunk {
  stream: TerminalStream;
  text: string;
}
export interface TerminalOutput {
  chunks: TerminalChunk[];
  bytes: number;
  /** Older output was dropped to stay within the limit. */
  truncated: boolean;
}
export type TerminalStatus = 'running' | 'exited' | 'stopped' | 'timeout' | 'failed';
export interface TerminalCommandInfo {
  id: string;
  projectId: string;
  command: string;
  cwd: string;
  sandbox: 'read-only' | 'workspace-write';
  status: TerminalStatus;
  /** Exit code when the process exited by itself; null when killed or never started. */
  exitCode: number | null;
  signal?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  timeoutSec: number;
  /** Why the command could not start (e.g. bubblewrap missing). */
  error?: string;
}
export interface TerminalCommand extends TerminalCommandInfo {
  output: TerminalOutput;
}
/** GET /api/projects/:id/terminal */
export interface TerminalState {
  enabled: boolean;
  /** The request came through remote access. */
  remote: boolean;
  reason?: string;
  sandbox: 'read-only' | 'workspace-write';
  maxRunning: number;
  commands: TerminalCommand[];
}
/** Events of GET /api/projects/:id/terminal/events (SSE). */
export type TerminalEvent =
  | { type: 'snapshot'; commands: TerminalCommand[] }
  | { type: 'command'; command: TerminalCommandInfo }
  | { type: 'output'; id: string; chunks: TerminalChunk[]; truncated?: boolean };

export const emptyOutput = (): TerminalOutput => ({ chunks: [], bytes: 0, truncated: false });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLength = (text: string) => encoder.encode(text).length;
/** Drops the first `bytes` bytes of `text` (a split character at the cut is discarded). */
function dropBytes(text: string, bytes: number) {
  return decoder.decode(encoder.encode(text).subarray(bytes)).replace(/^\uFFFD/, '');
}

/**
 * Appends `text` to `output` in place and keeps only the newest `limit` bytes. Adjacent text
 * from the same stream is merged so long outputs stay a short list of chunks.
 */
export function appendOutput(
  output: TerminalOutput,
  stream: TerminalStream,
  text: string,
  limit = TERMINAL_OUTPUT_LIMIT,
): TerminalOutput {
  if (!text) return output;
  const last = output.chunks.at(-1);
  if (last?.stream === stream) last.text += text;
  else output.chunks.push({ stream, text });
  output.bytes += byteLength(text);
  while (output.bytes > limit && output.chunks.length) {
    const first = output.chunks[0];
    const size = byteLength(first.text);
    const excess = output.bytes - limit;
    output.truncated = true;
    if (size <= excess) {
      output.chunks.shift();
      output.bytes -= size;
    } else {
      first.text = dropBytes(first.text, excess);
      output.bytes -= size - byteLength(first.text);
    }
  }
  return output;
}

/** Plain text of an output (both streams in order). */
export const outputText = (output: TerminalOutput) => output.chunks.map((chunk) => chunk.text).join('');

/** Removes ANSI escape sequences (colors, cursor moves) printed by dev tools. */
export function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, '');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const effectivePort = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
/** The Adelic's own port on any loopback name (localhost:4317 is the same server as 127.0.0.1:4317). */
function sameLoopbackPort(url: URL, appOrigin: string) {
  try {
    const app = new URL(appOrigin);
    return LOOPBACK_HOSTS.has(app.hostname) && effectivePort(app) === effectivePort(url);
  } catch {
    return false;
  }
}
export type PreviewUrlResult =
  | {
      ok: true;
      url: string;
      /** False for [::1]: CSP host sources cannot list IPv6 literals, so it opens only in the browser. */
      frameable: boolean;
    }
  | { ok: false; message: string };

/**
 * Accepts only loopback http(s) URLs: localhost, 127.0.0.1 or [::1], any port, without
 * user info. The WHATWG parser is the browser's own, so the frame loads the host checked here.
 * `appOrigin` (the Adelic itself) is refused.
 */
export function validatePreviewUrl(input: string, appOrigin?: string): PreviewUrlResult {
  const raw = input.trim();
  if (!raw) return { ok: false, message: 'Informe um endereço.' };
  // "localhost:5173" alone is common; treat it as http.
  const withScheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?([/?#]|$)/i.test(raw) ? `http://${raw}` : raw;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: 'Endereço inválido. Use, por exemplo, http://localhost:5173.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, message: 'Só endereços http:// ou https:// são aceitos.' };
  if (url.username || url.password) return { ok: false, message: 'Endereços com usuário ou senha não são aceitos.' };
  if (!LOOPBACK_HOSTS.has(url.hostname))
    return { ok: false, message: 'Só endereços locais são aceitos: localhost, 127.0.0.1 ou [::1].' };
  if (appOrigin && sameLoopbackPort(url, appOrigin))
    return { ok: false, message: 'O preview não abre o próprio Adelic.' };
  return { ok: true, url: url.href, frameable: url.hostname !== '[::1]' };
}

/** Frame sources allowed by the app's Content-Security-Policy (loopback hosts only). */
export const PREVIEW_FRAME_SOURCES = [
  'http://127.0.0.1:*',
  'http://localhost:*',
  'https://127.0.0.1:*',
  'https://localhost:*',
] as const;
export const APP_CSP = `frame-src ${PREVIEW_FRAME_SOURCES.join(' ')}`;

// The host must end there (no "127.0.0.1.evil.com"); the path stops at quotes and brackets.
const DEV_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?![\w.-])(?::\d{1,5})?(?:\/[^\s'"<>`)\]]*)?/gi;

/**
 * Loopback URLs printed by dev servers ("Local: http://localhost:5173/"), newest last, at
 * most `max`. 0.0.0.0 (listening on every interface) is offered as 127.0.0.1.
 */
export function detectDevServerUrls(text: string, max = 3): string[] {
  const found: string[] = [];
  for (const match of stripAnsi(text).matchAll(DEV_URL)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, '').replace('//0.0.0.0', '//127.0.0.1');
    const result = validatePreviewUrl(candidate);
    if (!result.ok) continue;
    const index = found.indexOf(result.url);
    if (index >= 0) found.splice(index, 1);
    found.push(result.url);
  }
  return found.slice(-max);
}
