import { spawn } from 'node:child_process';
import { terminateChildProcess } from './process';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type CommandExecutor = (
  command: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

/** Instance-owned command processes used for provider status/model discovery. */
export class CommandScope {
  private closed = false;
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<CommandResult>>();
  constructor(private execute: CommandExecutor = runCommand) {}

  run(command: string, args: string[], timeoutMs = 4000): Promise<CommandResult> {
    if (this.closed) return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false });
    const controller = new AbortController();
    this.controllers.add(controller);
    const operation = this.execute(command, args, timeoutMs, controller.signal);
    this.pending.add(operation);
    return operation.finally(() => {
      this.controllers.delete(controller);
      this.pending.delete(operation);
    });
  }

  async shutdown() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}

export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 4000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let stopping = false;
    if (signal?.aborted) {
      resolve({ code: null, stdout, stderr, timedOut: false });
      return;
    }
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: stdout.slice(-200_000), stderr: stderr.slice(-4000), timedOut });
    };
    const stop = async (timeout: boolean) => {
      if (done || stopping) return;
      stopping = true;
      timedOut = timeout;
      await terminateChildProcess(child);
      finish(null);
    };
    const onAbort = () => {
      void stop(false);
    };
    const timer = setTimeout(() => {
      void stop(true);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-200_000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', () => {
      if (!stopping) finish(null);
    });
    child.on('close', (code) => {
      if (!stopping) finish(code);
    });
  });
}
