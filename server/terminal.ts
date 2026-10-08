import { withObservation } from './observability.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Sandbox } from '../shared/contracts.js';
import {
  TERMINAL_MAX_RUNNING,
  TERMINAL_OUTPUT_LIMIT,
  appendOutput,
  emptyOutput,
  type TerminalChunk,
  type TerminalCommand,
  type TerminalCommandInfo,
  type TerminalEvent,
  type TerminalStream,
} from '../shared/terminal.js';
import { bubblewrap, type WrappedCommand } from './providers/sandbox.js';
import { terminateChildProcess } from './providers/process.js';
import { httpError, localize } from './i18n.js';

/**
 * Integrated command runner (docs/specs/terminal-preview.md). Each command is the user's own
 * `/bin/sh -c <command>`, wrapped by the same bubblewrap builder the agents use, with the
 * sandbox captured when it starts. No PTY and no stdin; output is kept bounded in memory and
 * never sent to a model.
 */
export type TerminalWrapper = (
  command: string,
  args: string[],
  cwd: string,
  sandbox: Sandbox,
) => Promise<WrappedCommand & { infoFd?: boolean }>;

/**
 * The agents' bubblewrap profile plus `--info-fd 3`, which reports the PID of the sandbox's
 * init process. `--new-session` moves the sandboxed tree out of the launcher's process group,
 * so stopping it means killing that init: the kernel then ends the whole PID namespace.
 */
export const sandboxedTerminal: TerminalWrapper = async (command, args, cwd, sandbox) => {
  // Defaults: system config shims (ssh) from the per-process cache and the ssh-agent socket.
  const wrapped = await bubblewrap(command, args, cwd, sandbox);
  return { command: wrapped.command, args: ['--info-fd', '3', ...wrapped.args], infoFd: true };
};

export interface TerminalOptions {
  wrap?: TerminalWrapper;
  maxRunning?: number;
  outputLimit?: number;
  /** Finished commands kept per project (with their output) for the panel. */
  keepFinished?: number;
  /** Batching of output events, in milliseconds. */
  flushMs?: number;
}

export interface StartTerminalCommand {
  projectId: string;
  cwd: string;
  command: string;
  sandbox: Sandbox;
  timeoutMs: number;
  remote?: (signal: AbortSignal) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Variables never passed to the user's commands: Adelic's own credentials. */
const HIDDEN_ENV = ['ADELIC_REMOTE_TOKEN', 'ADELIC_MEMORY_TOKEN'];

export function terminalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, TERM: 'dumb', NO_COLOR: '1' };
  for (const key of HIDDEN_ENV) delete next[key];
  // Exported bash functions and init files could run code the user did not type.
  for (const key of Object.keys(next)) if (key.startsWith('BASH_FUNC_')) delete next[key];
  delete next.BASH_ENV;
  delete next.ENV;
  return next;
}

interface Entry {
  info: TerminalCommandInfo;
  output: TerminalCommand['output'];
  child?: ChildProcess;
  remoteController?: AbortController;
  /** PID (outside the sandbox) of the sandbox's init; resolves undefined without one. */
  sandboxPid?: Promise<number | undefined>;
  timer?: NodeJS.Timeout;
  stopping?: 'stopped' | 'timeout';
  pending: TerminalChunk[];
  pendingBytes: number;
  pendingTruncated: boolean;
  flushTimer?: NodeJS.Timeout;
  done: Promise<void>;
  finish: () => void;
}

/** Reads `{"child-pid": N}` from bubblewrap's info fd (closed once the sandbox is set up). */
export function sandboxInitPid(child: ChildProcess): Promise<number | undefined> {
  const info = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
  if (!info) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const pid = (JSON.parse(text) as { 'child-pid'?: unknown })['child-pid'];
        resolve(typeof pid === 'number' && Number.isInteger(pid) && pid > 1 ? pid : undefined);
      } catch {
        resolve(undefined);
      }
    };
    // Bounded: a stop never waits long for a sandbox that failed to start.
    const timer = setTimeout(done, 3000);
    info.setEncoding('utf8');
    info.on('data', (chunk: string) => {
      text = (text + chunk).slice(0, 4096);
      if (/\}\s*$/.test(text)) done();
    });
    info.once('end', done);
    info.once('error', done);
    child.once('close', done);
  });
}

export class TerminalBusyError extends Error {
  readonly status = 409;
}

export class TerminalService {
  private entries = new Map<string, Entry>();
  private listeners = new Map<string, Set<(event: TerminalEvent) => void>>();
  private closed = false;
  private readonly wrap: TerminalWrapper;
  private readonly maxRunning: number;
  private readonly outputLimit: number;
  private readonly keepFinished: number;
  private readonly flushMs: number;

  constructor(options: TerminalOptions = {}) {
    this.wrap = options.wrap ?? sandboxedTerminal;
    this.maxRunning = options.maxRunning ?? TERMINAL_MAX_RUNNING;
    this.outputLimit = options.outputLimit ?? TERMINAL_OUTPUT_LIMIT;
    this.keepFinished = options.keepFinished ?? 20;
    this.flushMs = options.flushMs ?? 50;
  }

  running(projectId: string) {
    return [...this.entries.values()].filter((e) => e.info.projectId === projectId && e.info.status === 'running')
      .length;
  }

  list(projectId: string): TerminalCommand[] {
    return [...this.entries.values()].filter((e) => e.info.projectId === projectId).map((e) => this.snapshot(e));
  }

  get(id: string): TerminalCommand | undefined {
    const entry = this.entries.get(id);
    return entry && this.snapshot(entry);
  }

  subscribe(projectId: string, listener: (event: TerminalEvent) => void) {
    let set = this.listeners.get(projectId);
    if (!set) this.listeners.set(projectId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(projectId);
    };
  }

  /** Starts a command; resolves once it is running (or failed to start). */
  async start(request: StartTerminalCommand): Promise<TerminalCommandInfo> {
    if (this.closed) throw httpError(503, 'common.shuttingDown');
    if (this.running(request.projectId) >= this.maxRunning)
      throw localize(new TerminalBusyError(''), 'terminal.busy', { count: this.maxRunning });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: Entry = {
      info: {
        id: randomUUID(),
        projectId: request.projectId,
        command: request.command,
        cwd: request.cwd,
        sandbox: request.sandbox,
        status: 'running',
        exitCode: null,
        startedAt: new Date().toISOString(),
        timeoutSec: Math.round(request.timeoutMs / 1000),
      },
      output: emptyOutput(),
      pending: [],
      pendingBytes: 0,
      pendingTruncated: false,
      done,
      finish,
    };
    // Reserved before the async wrapper so concurrent requests count it.
    this.entries.set(entry.info.id, entry);
    this.prune(request.projectId);
    this.emit(request.projectId, { type: 'command', command: { ...entry.info } });
    const started = Date.now();
    void withObservation('terminal.command', 'terminal', { projectId: request.projectId }, async () => {
      await entry.done;
      if (entry.info.status === 'stopped') throw Object.assign(new Error('Terminal cancelled'), { name: 'AbortError' });
      if (entry.info.status !== 'exited' || entry.info.exitCode !== 0) throw new Error('Terminal failed');
    }).catch(() => undefined);
    if (request.remote) {
      const controller = new AbortController();
      entry.remoteController = controller;
      entry.timer = setTimeout(() => void this.terminate(entry, 'timeout'), request.timeoutMs);
      void request
        .remote(controller.signal)
        .then((result) => {
          this.append(entry, 'stdout', result.stdout);
          this.append(entry, 'stderr', result.stderr);
          this.end(entry, started, entry.stopping ?? 'exited', entry.stopping ? null : result.exitCode);
        })
        .catch((error: unknown) => {
          this.end(entry, started, entry.stopping ?? 'failed', null, undefined, (error as Error).message);
        });
      return { ...entry.info };
    }
    let wrapped: Awaited<ReturnType<TerminalWrapper>>;
    try {
      wrapped = await this.wrap('/bin/sh', ['-c', request.command], request.cwd, request.sandbox);
      if (this.closed || entry.stopping) throw new Error('Comando parado antes de iniciar.');
    } catch (error) {
      this.end(entry, started, entry.stopping ?? 'failed', null, undefined, (error as Error).message);
      return { ...entry.info };
    }
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: request.cwd,
      env: terminalEnv(),
      // No stdin: interactive programs get EOF. fd 3 carries bubblewrap's info JSON.
      stdio: wrapped.infoFd ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group for the launcher (and for unsandboxed test runners).
      detached: process.platform !== 'win32',
    });
    entry.child = child;
    if (wrapped.infoFd) entry.sandboxPid = sandboxInitPid(child);
    const onData = (stream: TerminalStream) => (chunk: string) => this.append(entry, stream, chunk);
    child.stdout!.setEncoding('utf8').on('data', onData('stdout'));
    child.stderr!.setEncoding('utf8').on('data', onData('stderr'));
    child.once('error', (error) => this.end(entry, started, 'failed', null, undefined, error.message));
    child.once('close', (code, signal) =>
      this.end(entry, started, entry.stopping ?? 'exited', entry.stopping ? null : code, signal ?? undefined),
    );
    entry.timer = setTimeout(() => void this.terminate(entry, 'timeout'), request.timeoutMs);
    return { ...entry.info };
  }

  /** "Parar": kills the command's process group. Resolves when it has ended. */
  async stop(id: string): Promise<TerminalCommandInfo | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    await this.terminate(entry, 'stopped');
    return { ...entry.info };
  }

  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map((entry) => this.terminate(entry, 'stopped')));
  }

  private async terminate(entry: Entry, reason: 'stopped' | 'timeout') {
    if (entry.info.status !== 'running') return;
    entry.stopping ??= reason;
    entry.remoteController?.abort();
    const child = entry.child;
    if (child) {
      const pid = await entry.sandboxPid;
      // The launcher has not reaped its child while it is alive, so the PID cannot be reused.
      if (pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
      await terminateChildProcess(child);
    }
    await entry.done;
  }

  private append(entry: Entry, stream: TerminalStream, text: string) {
    appendOutput(entry.output, stream, text, this.outputLimit);
    // Pending events are bounded the same way: a burst larger than the limit only needs its tail.
    const pending = appendOutput(
      { chunks: entry.pending, bytes: entry.pendingBytes, truncated: false },
      stream,
      text,
      this.outputLimit,
    );
    entry.pending = pending.chunks;
    entry.pendingBytes = pending.bytes;
    if (pending.truncated) entry.pendingTruncated = true;
    entry.flushTimer ??= setTimeout(() => this.flush(entry), this.flushMs);
  }

  private flush(entry: Entry) {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = undefined;
    if (!entry.pending.length) return;
    const chunks = entry.pending;
    entry.pending = [];
    entry.pendingBytes = 0;
    const truncated = entry.pendingTruncated;
    entry.pendingTruncated = false;
    this.emit(entry.info.projectId, {
      type: 'output',
      id: entry.info.id,
      chunks,
      ...(truncated ? { truncated } : {}),
    });
  }

  private end(
    entry: Entry,
    started: number,
    status: TerminalCommandInfo['status'],
    exitCode: number | null,
    signal?: string,
    error?: string,
  ) {
    if (entry.info.status !== 'running') return;
    if (entry.timer) clearTimeout(entry.timer);
    this.flush(entry);
    const endedAt = new Date();
    entry.info = {
      ...entry.info,
      status,
      exitCode,
      ...(signal ? { signal } : {}),
      ...(error ? { error: error.slice(0, 500) } : {}),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - started),
    };
    entry.child = undefined;
    this.emit(entry.info.projectId, { type: 'command', command: { ...entry.info } });
    entry.finish();
    this.prune(entry.info.projectId);
  }

  /** Drops the oldest finished commands beyond `keepFinished` in a project. */
  private prune(projectId: string) {
    const finished = [...this.entries.values()].filter(
      (e) => e.info.projectId === projectId && e.info.status !== 'running',
    );
    for (const entry of finished.slice(0, Math.max(0, finished.length - this.keepFinished)))
      this.entries.delete(entry.info.id);
  }

  private snapshot(entry: Entry): TerminalCommand {
    return {
      ...entry.info,
      output: {
        chunks: entry.output.chunks.map((chunk) => ({ ...chunk })),
        bytes: entry.output.bytes,
        truncated: entry.output.truncated,
      },
    };
  }

  private emit(projectId: string, event: TerminalEvent) {
    for (const listener of this.listeners.get(projectId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
