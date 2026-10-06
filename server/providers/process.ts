import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class JsonRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  private exitPromise: Promise<void>;
  private exitResolve!: () => void;
  private termination?: Promise<void>;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private onMessage: (message: JsonRpcMessage) => void,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    // A provider binary may be a launcher (mise, a shell script, or a CLI that
    // starts a runtime child). Give it a process group so shutdown can reap the
    // whole tree instead of leaving the real provider running in the background.
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = sanitizeDiagnostic((this.stderrTail + chunk).slice(-3000));
    });
    this.child.on('error', (error) => this.failAll(new Error(`Provider process failed to start: ${error.message}`)));
    this.child.on('close', (code, signal) => {
      this.closed = true;
      const diagnostic = this.stderrTail.trim();
      this.failAll(
        new Error(
          `Provider process exited (${signal ?? code ?? 'unknown'})${diagnostic ? `: ${diagnostic.slice(-500)}` : ''}`,
        ),
      );
      this.exitResolve();
    });
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 4_000_000) {
      this.failAll(new Error('Provider protocol output exceeded limit'));
      this.kill();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as JsonRpcMessage);
      } catch {
        /* Ignore malformed unsolicited lines. */
      }
    }
  }

  notify(method: string, params: unknown) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Provider process is closed');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) return Promise.reject(new Error('Provider process is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Provider request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  respond(id: string | number, result: unknown) {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  respondError(id: string | number, code: number, message: string) {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  dispatch(message: JsonRpcMessage): boolean {
    if (message.id === undefined || message.method) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? 'Provider request failed'));
    else pending.resolve(message.result);
    return true;
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  kill(): Promise<void> {
    if (this.termination) return this.termination;
    this.closed = true;
    this.failAll(new Error('Provider process stopped'));
    this.termination = terminateChildProcess(this.child);
    return this.termination;
  }

  async waitExit() {
    await this.exitPromise;
  }
}

/** Gracefully stop a provider and its launcher/runtime descendants, with a hard bound. */
export async function terminateChildProcess(child: ChildProcess, graceMs = 1500, settleMs = 1000): Promise<void> {
  const pid = child.pid;
  let closeResolve!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  if (child.exitCode !== null || child.signalCode !== null) closeResolve();
  else child.once('close', closeResolve);

  const signalTree = (signal: NodeJS.Signals) => {
    if (!pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal);
      else child.kill(signal);
    } catch {
      // The leader can exit while a wrapper child remains in the process group.
      // Fall back to the direct child when the group is already gone.
      try {
        child.kill(signal);
      } catch {
        /* Already exited. */
      }
    }
  };
  const groupExists = () => {
    if (!pid || process.platform === 'win32') return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitAtMost = async (promise: Promise<void>, ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      promise.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return !timedOut;
  };

  signalTree('SIGTERM');
  const exited = await waitAtMost(closePromise, graceMs);
  // If the launcher exited but left a descendant behind, kill the remaining
  // process group immediately. If it ignored SIGTERM, escalate after the grace.
  if (!exited || groupExists()) signalTree('SIGKILL');
  await waitAtMost(closePromise, settleMs);
  child.removeListener('close', closeResolve);
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeDiagnostic(raw).slice(0, 800);
}

function sanitizeDiagnostic(raw: string) {
  return raw
    .replace(/((?:Bearer|token|api[_-]?key|secret)\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
