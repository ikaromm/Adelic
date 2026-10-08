import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProviderEvent, ProviderInfo, RunInput, RunResult } from '../../shared/contracts';
import { abortError, boundedPrompt } from './common';
import { CommandScope } from './command';
import { bubblewrap } from './sandbox';
import { errorMessage, isRecord, terminateChildProcess } from './process';
import { findProviderBinary, hasProviderBinaryOverride, providerBinaryMissingDetail } from './discovery';

export class ClaudeProvider {
  private binary?: string;
  private infoCache?: { at: number; value: ProviderInfo };
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private shuttingDown = false;
  private commands = new CommandScope();
  async info(): Promise<ProviderInfo> {
    if (this.shuttingDown) return this.shutdownInfo();
    if (this.infoCache && Date.now() - this.infoCache.at < 5 * 60_000) return this.infoCache.value;
    this.binary ??= await findProviderBinary('claude');
    if (!this.binary)
      return this.cache({
        id: 'claude',
        name: 'Claude Code',
        installed: false,
        available: false,
        status: hasProviderBinaryOverride('claude') ? 'error' : 'missing',
        detail: providerBinaryMissingDetail('claude'),
        models: [],
        capabilities: { fast: true, tools: true, approvals: false, cancel: true, reasoning: true, steer: false },
      });
    const result = await this.commands.run(this.binary, ['auth', 'status', '--json'], 4000);
    if (this.shuttingDown) return this.shutdownInfo();
    let loggedIn = false;
    try {
      loggedIn = JSON.parse(result.stdout).loggedIn === true;
    } catch {
      /* auth status did not return a valid status */
    }
    return this.cache({
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      available: loggedIn,
      status: loggedIn ? 'ready' : 'error',
      detail: loggedIn
        ? 'Claude Code instalado; autenticação verificada.'
        : 'Claude Code instalado, mas não autenticado no runtime.',
      models: [],
      capabilities: { fast: true, tools: true, approvals: false, cancel: true, reasoning: true, steer: false },
    });
  }
  private cache(value: ProviderInfo) {
    this.infoCache = { at: Date.now(), value };
    return value;
  }
  private shutdownInfo(): ProviderInfo {
    return {
      id: 'claude',
      name: 'Claude Code',
      installed: Boolean(this.binary),
      available: false,
      status: 'error',
      detail: 'Claude Code provider is shutting down.',
      models: [],
      capabilities: { fast: true, tools: true, approvals: false, cancel: true, reasoning: true, steer: false },
    };
  }

  async run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<RunResult> {
    if (this.shuttingDown) throw new Error('Claude provider is shutting down');
    if (input.approvalMode === 'automatic')
      throw new Error(
        'Modo automático isolado indisponível para Claude: esta integração não controla a superfície de ferramentas nativas.',
      );
    this.binary ??= await findProviderBinary('claude');
    if (!this.binary) throw new Error(providerBinaryMissingDetail('claude'));
    const runtimeDirs = [path.join(os.homedir(), '.claude/projects'), path.join(os.homedir(), '.claude/sessions')];
    const toolsAllowed = input.plan.tools;
    const tools = toolsAllowed
      ? input.sandbox === 'workspace-write'
        ? 'Read,Glob,Grep,Edit,Write,Bash'
        : 'Read,Glob,Grep'
      : '';
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--restricted',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--tools',
      toolsAllowed ? tools : '',
      '--permission-mode',
      'manual',
      '--permission-prompts',
      'none',
    ];
    if (input.plan.effort) args.push('--effort', input.plan.effort);
    if (input.model) args.push('--model', input.model);
    const wrapped = await bubblewrap(this.binary, args, input.cwd, input.sandbox, runtimeDirs);
    if (signal.aborted) throw abortError(signal);
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.processes.set(input.runId, child);
      let buffer = '';
      let text = '';
      let exitCode: number | null = null;
      let resultError: string | undefined;
      let isError = false;
      let settled = false;
      const finish = (error?: Error, stopReason: 'completed' | 'cancelled' = 'completed') => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.processes.delete(input.runId);
        if (error) reject(error);
        else if (isError || (exitCode !== null && exitCode !== 0))
          reject(new Error(resultError ?? `Claude Code encerrou com código ${exitCode}.`));
        else resolve({ text, stopReason });
      };
      const onAbort = () => {
        void terminateChildProcess(child).then(() => finish(undefined, 'cancelled'));
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) {
          void terminateChildProcess(child).then(() =>
            finish(new Error('Claude Code excedeu o limite de saída do protocolo.')),
          );
          return;
        }
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const record: unknown = JSON.parse(line);
            if (!isRecord(record)) continue;
            if (
              record.type === 'stream_event' &&
              isRecord(record.event) &&
              isRecord(record.event.delta) &&
              record.event.delta.type === 'text_delta' &&
              typeof record.event.delta.text === 'string'
            ) {
              text += record.event.delta.text;
              emit({ type: 'delta', text: record.event.delta.text });
            } else if (record.type === 'result') {
              isError = record.is_error === true;
              if (typeof record.result === 'string') resultError = isError ? record.result : undefined;
              if (typeof record.session_id === 'string') emit({ type: 'session', nativeSessionId: record.session_id });
              if (isRecord(record.usage))
                emit({
                  type: 'usage',
                  inputTokens: Number(record.usage.input_tokens) || undefined,
                  outputTokens: Number(record.usage.output_tokens) || undefined,
                });
            }
          } catch {
            /* Ignore non-JSON CLI chatter on stdout. */
          }
        }
      });
      child.stderr.on('data', () => {
        /* Never expose raw provider stderr, which may contain credentials. */
      });
      child.on('error', (error) => finish(new Error(errorMessage(error))));
      child.on('close', (code) => {
        exitCode = code;
        finish();
      });
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdin.end(boundedPrompt(input));
    });
  }
  async approve(_approvalId: string, _decision: 'approve' | 'deny') {
    throw new Error('Claude Code CLI não oferece aprovação remota nesta integração.');
  }
  async shutdown() {
    this.shuttingDown = true;
    await Promise.all([
      this.commands.shutdown(),
      ...[...this.processes.values()].map((child) => terminateChildProcess(child)),
    ]);
    this.processes.clear();
  }
}
