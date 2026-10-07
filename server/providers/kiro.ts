import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { ProviderEvent, ProviderInfo, RunInput, RunResult } from '../../shared/contracts';
import { abortError, boundedPrompt, emitApproval, IMAGES_UNSUPPORTED } from './common';
import { CommandScope } from './command';
import { bubblewrap, mcpCommandBindings } from './sandbox';
import type { RunMcpServer } from '../../shared/mcp';
import { errorMessage, isRecord, JsonRpcProcess, type JsonRpcMessage } from './process';
import { findProviderBinary, hasProviderBinaryOverride, providerBinaryMissingDetail } from './discovery';
import { classifyApproval } from '../approval-policy';
import { blockedBy } from '../../shared/hooks';

interface KiroTurn {
  input: RunInput;
  emit: (event: ProviderEvent) => void;
  process: JsonRpcProcess;
  sessionId: string;
  text: string;
  toolCalls: Map<string, { name: string; description: string }>;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abort: () => void;
}
interface KiroApproval {
  process: JsonRpcProcess;
  requestId: string | number;
  runId: string;
  sessionId: string;
  allowOptionId?: string;
  denyOptionId?: string;
}

/** Whether an ACP `initialize` result advertises image prompts (`agentCapabilities.promptCapabilities.image`). */
export function kiroAcceptsImages(initializeResult: unknown) {
  const agent = isRecord(initializeResult) ? initializeResult.agentCapabilities : undefined;
  const prompt = isRecord(agent) ? agent.promptCapabilities : undefined;
  return isRecord(prompt) && prompt.image === true;
}

/** `session/prompt` content blocks: the text, then one ACP image block per attached image. */
export async function kiroPromptBlocks(text: string, images: NonNullable<RunInput['attachments']> = []) {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text }];
  for (const image of images)
    blocks.push({ type: 'image', mimeType: image.mime, data: (await readFile(image.path)).toString('base64') });
  return blocks;
}

/**
 * ACP `session/new` `mcpServers` (stdio form: name, command, args, env as name/value pairs).
 * Pass-through names are resolved from Adelic's own environment here; the values travel in
 * the JSON-RPC body over stdin, never in argv.
 */
export function kiroMcpServers(servers: RunMcpServer[], env: NodeJS.ProcessEnv = process.env) {
  return servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args,
    env: [
      ...server.passEnv.flatMap((name) => (env[name] !== undefined ? [{ name, value: env[name]! }] : [])),
      ...Object.entries(server.env).map(([name, value]) => ({ name, value })),
    ],
  }));
}

/**
 * Kiro 2.23 answers `_kiro.dev/commands/execute` `mcp` with the servers of the session. Any
 * name outside the approved list, or an unreadable answer, blocks the run (fail closed).
 */
export function kiroForeignMcp(response: unknown, approved: string[]): string[] | undefined {
  const data = isRecord(response) && isRecord(response.data) ? response.data : undefined;
  if (!data || !Array.isArray(data.servers)) return undefined;
  const names: string[] = [];
  for (const server of data.servers) {
    if (!isRecord(server) || typeof server.name !== 'string') return undefined;
    names.push(server.name);
  }
  return names.filter((name) => !approved.includes(name));
}

/**
 * The shell command of a Kiro `session/request_permission`, only when the payload identifies
 * Kiro's own shell tool without ambiguity (Kiro 2.23, ACP v2 engine): a `Running: …` title, a
 * `rawInput` holding only the command (and Kiro's purpose note), and no other tool kind. Any
 * extra field (a working directory, for instance) leaves the request manual.
 */
export function kiroShellCommand(params: Record<string, unknown>): string | undefined {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : undefined;
  if (!toolCall) return undefined;
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : undefined;
  if (!rawInput || typeof rawInput.command !== 'string' || !rawInput.command.trim()) return undefined;
  if (Object.keys(rawInput).some((key) => key !== 'command' && key !== '__tool_use_purpose')) return undefined;
  if (toolCall.kind !== undefined && toolCall.kind !== 'execute') return undefined;
  if (typeof toolCall.title !== 'string' || !toolCall.title.startsWith('Running: ')) return undefined;
  return rawInput.command;
}

/**
 * Kiro runs shell commands with a shell Adelic does not choose. Commands are auto-approved only
 * when that shell is bash or sh: non-interactive bash reads only BASH_ENV (neutralized in
 * kiroEnvironment), and no Kiro shell override is set.
 */
export function kiroShellNeutral(env: NodeJS.ProcessEnv): boolean {
  if (['KIRO_CHAT_SHELL', 'AMAZON_Q_CHAT_SHELL', 'KIRO_SHELL', 'Q_SHELL'].some((name) => env[name])) return false;
  return !env.SHELL || ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'].includes(env.SHELL);
}

/** Kiro's environment: shell startup hooks inherited from Adelic are neutralized, as for Codex. */
export function kiroEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const next = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith('BASH_FUNC_') && !['SHELLOPTS', 'BASHOPTS', 'PS4'].includes(key),
    ),
  ) as NodeJS.ProcessEnv;
  return { ...next, KIRO_HOME: home, KIRO_LOG_NO_COLOR: '1', NO_COLOR: '1', BASH_ENV: '/dev/null', ENV: '/dev/null' };
}

export function kiroToolEvent(
  turn: Pick<KiroTurn, 'toolCalls'>,
  update: Record<string, unknown>,
  status: string,
): Extract<ProviderEvent, { type: 'tool' }> {
  const rawId =
    typeof update.toolCallId === 'string'
      ? update.toolCallId
      : typeof update.tool_call_id === 'string'
        ? update.tool_call_id
        : undefined;
  const previous = rawId ? turn.toolCalls.get(rawId) : undefined;
  const name =
    typeof update.name === 'string' && update.name.trim()
      ? update.name
      : typeof update.kind === 'string' && update.kind.trim()
        ? update.kind
        : (previous?.name ?? 'kiro-tool');
  const description =
    typeof update.title === 'string' && update.title.trim()
      ? update.title
      : (previous?.description ?? 'Ferramenta Kiro');
  if (rawId) turn.toolCalls.set(rawId, { name, description });
  return { type: 'tool', name, description, status, ...(rawId ? { toolCallId: rawId } : {}) };
}

export function parseKiroModelCatalog(stdout: string): { models: ProviderInfo['models']; defaultModel?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { models: [] };
  }
  const source = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  let defaultModel: string | undefined;
  const models = source.flatMap((entry): ProviderInfo['models'] => {
    if (!isRecord(entry) || typeof entry.model_id !== 'string') return [];
    const rawEfforts = entry.supportedReasoningEfforts ?? entry.supported_reasoning_efforts ?? entry.efforts;
    const efforts = Array.isArray(rawEfforts)
      ? rawEfforts.flatMap((value) => {
          const effort = typeof value === 'string' ? value : isRecord(value) ? value.reasoningEffort : undefined;
          return typeof effort === 'string' ? [effort] : [];
        })
      : undefined;
    const isDefault = entry.isDefault === true || entry.is_default === true;
    if (isDefault) defaultModel = entry.model_id;
    return [
      {
        id: entry.model_id,
        name: typeof entry.model_name === 'string' ? entry.model_name : entry.model_id,
        ...(efforts !== undefined ? { efforts } : {}),
        ...(isDefault ? { isDefault: true } : {}),
      },
    ];
  });
  return { models, defaultModel };
}

/**
 * Authentication verdict from `kiro-cli doctor --all`. The doctor also checks dotfiles
 * and terminal integration (Qterm, kiro-cli-term), which fail outside an integrated
 * terminal and may make the exit code non-zero even with a valid login. Only the
 * explicit `Auth` check decides: `✔ Auth` confirms, `✘ Auth`/missing/ambiguous or a
 * timed-out/killed diagnosis does not.
 */
export function parseKiroDoctorAuth(result: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): boolean {
  if (result.timedOut || result.code === null) return false;
  const lines = `${result.stdout}\n${result.stderr}`
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const auth = lines.filter((line) => /^\S+\s+Auth\b/i.test(line));
  return auth.length > 0 && auth.every((line) => /^[✓✔]\s+Auth\b/i.test(line));
}

export class KiroProvider {
  private binary?: string;
  private turns = new Map<string, KiroTurn>();
  private byProcessSession = new Map<JsonRpcProcess, Map<string, KiroTurn>>();
  private approvals = new Map<string, KiroApproval>();
  private processes = new Set<JsonRpcProcess>();
  private infoCache?: { at: number; value: ProviderInfo };
  private shuttingDown = false;
  private processIds = new WeakMap<JsonRpcProcess, number>();
  private nextProcessId = 1;
  private commands = new CommandScope();
  async info(): Promise<ProviderInfo> {
    if (this.shuttingDown) return this.shutdownInfo();
    if (this.infoCache && Date.now() - this.infoCache.at < 5 * 60_000) return this.infoCache.value;
    this.binary ??= await findProviderBinary('kiro');
    if (!this.binary)
      return this.cache({
        id: 'kiro',
        name: 'Kiro',
        installed: false,
        available: false,
        status: hasProviderBinaryOverride('kiro') ? 'error' : 'missing',
        detail: providerBinaryMissingDetail('kiro'),
        models: [],
        capabilities: {
          fast: true,
          tools: true,
          approvals: true,
          cancel: true,
          reasoning: true,
          images: true,
          steer: false,
        },
      });
    const [result, authResult] = await Promise.all([
      this.commands.run(this.binary, ['chat', '--list-models', '--format', 'json'], 6000),
      this.commands.run(this.binary, ['doctor', '--all'], 6000),
    ]);
    if (this.shuttingDown) return this.shutdownInfo();
    const { models, defaultModel } = parseKiroModelCatalog(result.stdout);
    const authenticated = parseKiroDoctorAuth(authResult);
    const ready = result.code === 0 && models.length > 0 && authenticated;
    const detail = ready
      ? `Kiro instalado e autenticação verificada pelo doctor; ${models.length} modelos anunciados pelo CLI.`
      : models.length && !authenticated
        ? 'Catálogo do Kiro disponível, mas o estado de autenticação não foi confirmado.'
        : 'Kiro instalado, mas descoberta de modelos ou autenticação falhou.';
    return this.cache({
      id: 'kiro',
      name: 'Kiro',
      installed: true,
      available: ready,
      status: ready ? 'ready' : 'error',
      detail,
      models,
      defaultModel,
      capabilities: {
        fast: true,
        tools: true,
        approvals: true,
        cancel: true,
        reasoning: true,
        images: true,
        steer: false,
      },
    });
  }
  private cache(value: ProviderInfo) {
    this.infoCache = { at: Date.now(), value };
    return value;
  }
  private shutdownInfo(): ProviderInfo {
    return {
      id: 'kiro',
      name: 'Kiro',
      installed: Boolean(this.binary),
      available: false,
      status: 'error',
      detail: 'Kiro provider is shutting down.',
      models: [],
      capabilities: {
        fast: true,
        tools: true,
        approvals: true,
        cancel: true,
        reasoning: true,
        images: true,
        steer: false,
      },
    };
  }

  private onMessage(process: JsonRpcProcess, message: JsonRpcMessage) {
    if (process.dispatch(message)) return;
    if (message.method === 'session/request_permission' && message.id !== undefined) {
      const params = isRecord(message.params) ? message.params : {};
      const sessionId = String(params.sessionId ?? '');
      const turn = this.byProcessSession.get(process)?.get(sessionId);
      const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
      const allow = options.find((option) => option.kind === 'allow_once' && typeof option.optionId === 'string');
      const deny = options.find((option) => option.kind === 'reject_once' && typeof option.optionId === 'string');
      // Requests without tools must be denied at the protocol boundary.
      if (!turn || !this.turns.has(turn.input.runId) || turn.process !== process || !turn.input.plan.tools) {
        process.respond(message.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      const processId = this.processIds.get(process) ?? this.nextProcessId++;
      this.processIds.set(process, processId);
      const approvalId = `${turn.input.runId}:${processId}:${String(message.id)}`;
      const requestId = message.id;
      const allowOptionId = allow ? String(allow.optionId) : undefined;
      const denyOptionId = deny ? String(deny.optionId) : undefined;
      // Best effort, for the project's blocked commands (they can only deny): the shell command
      // Kiro reports in the tool call, when it reports one.
      const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
      const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
      const command = typeof rawInput.command === 'string' ? rawInput.command : undefined;
      const title = String(params.title ?? toolCall.title ?? 'Permitir ferramenta Kiro');
      const shellCommand = kiroShellCommand(params);
      const respondDeny = () =>
        process.respond(
          requestId,
          denyOptionId
            ? { outcome: { outcome: 'selected', optionId: denyOptionId } }
            : { outcome: { outcome: 'cancelled' } },
        );
      // Project rules only add denials, before any automatic decision (docs/specs/project-hooks.md).
      const blocked = shellCommand !== undefined ? blockedBy(turn.input.blockedCommands, shellCommand) : undefined;
      if (blocked) {
        respondDeny();
        emitApproval(
          turn.input,
          turn.emit,
          approvalId,
          'Comando bloqueado pelas regras do projeto',
          `Padrão: ${blocked}\n${shellCommand}`,
          'command',
          'denied',
          { command: shellCommand, blocked },
        );
        return;
      }
      const askUser = (reason: string) => {
        this.approvals.set(approvalId, {
          process,
          requestId,
          runId: turn.input.runId,
          sessionId,
          ...(allowOptionId ? { allowOptionId } : {}),
          ...(denyOptionId ? { denyOptionId } : {}),
        });
        emitApproval(turn.input, turn.emit, approvalId, title, reason, 'tool', 'pending', { command });
      };
      if (shellCommand === undefined || !allowOptionId) {
        askUser(
          shellCommand === undefined
            ? 'O Kiro não identificou esta solicitação como um comando de shell completo. A solicitação permanecerá pendente para decisão manual.'
            : 'O Kiro não ofereceu allow_once; a solicitação permanecerá pendente.',
        );
        return;
      }
      // Kiro reports no per-request cwd: the command runs in the session cwd Adelic created.
      // Kiro runs it through its own shell, so the text itself must pass the portable grammar.
      const neutral = kiroShellNeutral(globalThis.process.env);
      void classifyApproval({
        tools: turn.input.plan.tools,
        mode: neutral ? (turn.input.approvalMode ?? 'auto-safe') : 'manual',
        kind: 'command',
        command: shellCommand,
        cwd: turn.input.cwd,
        workspace: turn.input.cwd,
        sandbox: turn.input.sandbox,
        trustedNonLoginShell: false,
        portableShell: true,
        ...(turn.input.graphifyApproval ? { graphify: turn.input.graphifyApproval } : {}),
      })
        .then((result) => {
          if (!this.turns.has(turn.input.runId) || turn.process !== process || turn.signal.aborted) {
            process.respond(requestId, { outcome: { outcome: 'cancelled' } });
            return;
          }
          if (result.decision === 'auto') {
            // Only this request: allow_once, never allow_always.
            process.respond(requestId, { outcome: { outcome: 'selected', optionId: allowOptionId } });
            emitApproval(
              turn.input,
              turn.emit,
              approvalId,
              'Comando aprovado automaticamente',
              `${result.reason}\n${shellCommand}`,
              'command',
              'approved',
              { command: shellCommand },
            );
            return;
          }
          if (result.decision === 'deny') {
            respondDeny();
            return;
          }
          askUser(
            neutral
              ? result.reason
              : `${result.reason} O shell do Kiro não é bash/sh neutralizado; aprovação automática desativada.`,
          );
        })
        .catch(() => process.respond(requestId, { outcome: { outcome: 'cancelled' } }));
      return;
    }
    if ((message.method !== 'session/notification' && message.method !== 'session/update') || !isRecord(message.params))
      return;
    const params = message.params;
    const turn = this.byProcessSession.get(process)?.get(String(params.sessionId ?? ''));
    if (!turn) return;
    const update = isRecord(params.update) ? params.update : {};
    const type = String(update.sessionUpdate ?? update.type ?? '');
    if (type === 'agent_message_chunk' || type === 'AgentMessageChunk') {
      const content = isRecord(update.content) ? update.content : {};
      const text = typeof content.text === 'string' ? content.text : typeof update.text === 'string' ? update.text : '';
      if (text) {
        turn.text += text;
        turn.emit({ type: 'delta', text });
      }
    } else if (
      type === 'tool_call' ||
      type === 'ToolCall' ||
      type === 'tool_call_update' ||
      type === 'ToolCallUpdate'
    ) {
      const status = String(update.status ?? (type.toLowerCase().includes('update') ? 'running' : 'pending'));
      turn.emit(kiroToolEvent(turn, update, status));
    } else if (type === 'turn_end' || type === 'TurnEnd')
      this.finish(turn, { text: turn.text, nativeSessionId: turn.sessionId, stopReason: 'completed' });
  }
  private finish(turn: KiroTurn, result: RunResult, error?: Error) {
    if (!this.turns.has(turn.input.runId)) return;
    turn.signal.removeEventListener('abort', turn.abort);
    this.turns.delete(turn.input.runId);
    this.byProcessSession.get(turn.process)?.delete(turn.sessionId);
    for (const [id, pending] of this.approvals)
      if (pending.runId === turn.input.runId && pending.process === turn.process) {
        pending.process.respond(pending.requestId, { outcome: { outcome: 'cancelled' } });
        this.approvals.delete(id);
      }
    if (error) turn.reject(error);
    else turn.resolve(result);
  }
  async run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<RunResult> {
    if (this.shuttingDown) throw new Error('Kiro provider is shutting down');
    this.binary ??= await findProviderBinary('kiro');
    if (!this.binary) throw new Error(providerBinaryMissingDetail('kiro'));
    const args = ['acp', '--agent-engine', 'v2', '--trust-tools='];
    if (input.model) args.push('--model', input.model);
    if (input.plan.effort) args.push('--effort', input.plan.effort);
    // A fresh KIRO_HOME keeps global MCP servers, extra agents, memory and steering out of this app.
    // Kiro's credential store is outside KIRO_HOME and remains owned by the CLI.
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'adelic-kiro-home-'));
    const agentDir = path.join(isolatedHome, 'agents');
    const agentName = 'adelic-runtime';
    const toolsAllowed = input.plan.tools;
    // Opt-in MCP: only runs with tools receive the project's approved servers.
    const mcp = toolsAllowed ? (input.mcpServers ?? []) : [];
    if (mcp.some((server) => server.tools)) {
      await rm(isolatedHome, { recursive: true, force: true });
      throw new Error(
        'Execução Kiro bloqueada: o Kiro não aplica a lista de ferramentas de servidores MCP recebidos por ACP. Remova a lista do servidor ou use o Codex.',
      );
    }
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, `${agentName}.json`),
      JSON.stringify({
        name: agentName,
        description: 'Runtime isolado do Adelic',
        prompt: 'Siga somente as instruções da conversa atual.',
        tools: toolsAllowed ? ['fs_read', 'fs_write', 'execute_bash', 'grep', 'glob', 'code'] : [],
        allowedTools: [],
        resources: [],
        mcpServers: {},
        includeMcpJson: false,
      }),
      { mode: 0o600 },
    );
    args.push('--agent', agentName);
    let wrapped: Awaited<ReturnType<typeof bubblewrap>>;
    try {
      wrapped = await bubblewrap(
        this.binary,
        args,
        input.cwd,
        input.sandbox,
        [isolatedHome],
        await mcpCommandBindings(
          mcp.map((server) => server.command),
          input.cwd,
        ),
        // User-owned copies of root-owned client configs (ssh), removed with KIRO_HOME.
        { systemShims: { dir: path.join(isolatedHome, 'system-shims') } },
      );
    } catch (error) {
      await rm(isolatedHome, { recursive: true, force: true });
      throw error;
    }
    if (signal.aborted) {
      await rm(isolatedHome, { recursive: true, force: true });
      throw abortError(signal);
    }
    let turn: KiroTurn | undefined;
    const process: JsonRpcProcess = new JsonRpcProcess(
      wrapped.command,
      wrapped.args,
      input.cwd,
      (message) => this.onMessage(process, message),
      kiroEnvironment(globalThis.process.env, isolatedHome),
    );
    this.processes.add(process);
    const abortStartup = () => process.kill();
    signal.addEventListener('abort', abortStartup, { once: true });
    try {
      const initialized = await raceAbort(
        process.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'adelic', version: '0.1.0' },
        }),
        signal,
      );
      if (signal.aborted) throw abortError(signal);
      // Images go only to an agent that advertises them; otherwise fail before any session.
      const images = input.attachments ?? [];
      if (images.length && !kiroAcceptsImages(initialized)) throw new Error(IMAGES_UNSUPPORTED);
      const blocks = await kiroPromptBlocks(boundedPrompt(input), images);
      if (signal.aborted) throw abortError(signal);
      const sessionRaw = await raceAbort(
        process.request('session/new', { cwd: input.cwd, mcpServers: kiroMcpServers(mcp) }),
        signal,
      );
      signal.removeEventListener('abort', abortStartup);
      if (signal.aborted) throw abortError(signal);
      const sessionId = String(isRecord(sessionRaw) ? (sessionRaw.sessionId ?? '') : '');
      if (!sessionId) throw new Error('Kiro não retornou o identificador da sessão ACP.');
      if (mcp.length) {
        const approved = mcp.map((server) => server.name);
        const report = await raceAbort(
          process
            .request('_kiro.dev/commands/execute', { sessionId, command: { command: 'mcp', args: {} } }, 15_000)
            .catch(() => undefined),
          signal,
        );
        const foreign = kiroForeignMcp(report, approved);
        if (!foreign)
          throw new Error(
            'Execução Kiro bloqueada: o Kiro não informou os servidores MCP da sessão; nenhum pedido foi enviado.',
          );
        if (foreign.length)
          throw new Error(
            `Execução Kiro bloqueada: servidor MCP não aprovado pelo Adelic na sessão (${foreign.join(', ')}); nenhum pedido foi enviado.`,
          );
        emit({ type: 'status', text: `Servidores MCP do projeto nesta execução: ${approved.join(', ')}` });
      }
      const result = await new Promise<RunResult>((resolve, reject) => {
        const current: KiroTurn = {
          input,
          emit,
          process,
          sessionId,
          text: '',
          toolCalls: new Map(),
          resolve,
          reject,
          signal,
          abort: () => {
            try {
              process.notify('session/cancel', { sessionId });
            } catch {
              /* The provider may close stdin concurrently with cancellation. */
            } finally {
              this.finish(current, { text: current.text, nativeSessionId: sessionId, stopReason: 'cancelled' });
            }
          },
        };
        turn = current;
        this.turns.set(input.runId, current);
        let sessions = this.byProcessSession.get(process);
        if (!sessions) {
          sessions = new Map();
          this.byProcessSession.set(process, sessions);
        }
        sessions.set(sessionId, current);
        signal.addEventListener('abort', current.abort, { once: true });
        emit({ type: 'session', nativeSessionId: sessionId });
        // Kiro 2.23 documents `content`; ACP v1 uses `prompt`. Send both for compatibility with
        // Kiro's legacy adapter and clients implementing the published protocol schema.
        void process
          .request('session/prompt', { sessionId, prompt: blocks, content: blocks }, 10 * 60_000)
          .then((response) => {
            if (!this.turns.has(input.runId)) return;
            const stopReason =
              isRecord(response) && String(response.stopReason ?? '').toLowerCase() === 'cancelled'
                ? 'cancelled'
                : 'completed';
            if (isRecord(response) && ['error', 'failed'].includes(String(response.stopReason ?? '').toLowerCase()))
              this.finish(
                current,
                { text: current.text, nativeSessionId: sessionId, stopReason: 'completed' },
                new Error(String(response.error ?? 'Kiro informou falha no turno.')),
              );
            else this.finish(current, { text: current.text, nativeSessionId: sessionId, stopReason });
          })
          .catch((error) =>
            this.finish(
              current,
              { text: current.text, nativeSessionId: sessionId, stopReason: 'completed' },
              new Error(errorMessage(error)),
            ),
          );
      });
      return result;
    } finally {
      signal.removeEventListener('abort', abortStartup);
      this.processes.delete(process);
      await process.kill();
      await rm(isolatedHome, { recursive: true, force: true });
      if (turn && this.turns.has(input.runId)) this.finish(turn, { text: turn.text, stopReason: 'cancelled' });
    }
  }
  async approve(approvalId: string, decision: 'approve' | 'deny') {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Aprovação não está mais pendente.');
    const turn = this.turns.get(pending.runId);
    if (
      !turn ||
      turn.process !== pending.process ||
      turn.sessionId !== pending.sessionId ||
      !turn.input.plan.tools ||
      turn.signal.aborted
    ) {
      this.approvals.delete(approvalId);
      pending.process.respond(pending.requestId, { outcome: { outcome: 'cancelled' } });
      throw new Error('Aprovação não está mais pendente.');
    }
    if (decision === 'approve' && !pending.allowOptionId)
      throw new Error('Kiro não ofereceu allow_once; a solicitação não pode ser aprovada neste adapter.');
    this.approvals.delete(approvalId);
    if (decision === 'approve')
      pending.process.respond(pending.requestId, {
        outcome: { outcome: 'selected', optionId: pending.allowOptionId! },
      });
    else if (pending.denyOptionId)
      pending.process.respond(pending.requestId, { outcome: { outcome: 'selected', optionId: pending.denyOptionId } });
    else pending.process.respond(pending.requestId, { outcome: { outcome: 'cancelled' } });
  }
  async shutdown() {
    this.shuttingDown = true;
    const commandShutdown = this.commands.shutdown();
    for (const turn of this.turns.values()) turn.abort();
    await Promise.all([commandShutdown, ...[...this.processes].map((process) => process.kill())]);
    this.processes.clear();
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
