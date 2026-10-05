import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Approval, ProviderEvent, ProviderInfo, RunInput, RunResult } from '../../shared/contracts';
import { abortError, boundedPrompt, emitApproval } from './common';
import { CommandScope } from './command';
import { bubblewrap } from './sandbox';
import { errorMessage, isRecord, JsonRpcProcess, type JsonRpcMessage } from './process';
import { findProviderBinary, hasProviderBinaryOverride, providerBinaryMissingDetail } from './discovery';

interface KiroTurn { input: RunInput; emit: (event: ProviderEvent) => void; sessionId: string; text: string; resolve: (result: RunResult) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }
interface KiroApproval { process: JsonRpcProcess; requestId: string | number; runId: string; sessionId: string; allowOptionId: string; denyOptionId: string }

export class KiroProvider {
  private binary?: string;
  private turns = new Map<string, KiroTurn>();
  private bySession = new Map<string, KiroTurn>();
  private approvals = new Map<string, KiroApproval>();
  private processes = new Set<JsonRpcProcess>();
  private infoCache?: { at: number; value: ProviderInfo };
  private shuttingDown = false;
  private commands = new CommandScope();
  async info(): Promise<ProviderInfo> {
    if (this.shuttingDown) return this.shutdownInfo();
    if (this.infoCache && Date.now() - this.infoCache.at < 5 * 60_000) return this.infoCache.value;
    this.binary ??= await findProviderBinary('kiro');
    if (!this.binary) return this.cache({ id: 'kiro', name: 'Kiro', installed: false, available: false, status: hasProviderBinaryOverride('kiro') ? 'error' : 'missing', detail: providerBinaryMissingDetail('kiro'), models: [], capabilities: { fast: true, tools: true, approvals: true, cancel: true } });
    const [result, authResult] = await Promise.all([
      this.commands.run(this.binary, ['chat', '--list-models', '--format', 'json'], 6000),
      this.commands.run(this.binary, ['doctor', '--all'], 6000),
    ]);
    if (this.shuttingDown) return this.shutdownInfo();
    let models: ProviderInfo['models'] = [];
    try {
      const parsed = JSON.parse(result.stdout) as { models?: { model_id?: string; model_name?: string }[] };
      models = (parsed.models ?? []).filter((model) => model.model_id).map((model) => ({ id: model.model_id!, name: model.model_name ?? model.model_id! }));
    } catch { /* Discovery was unavailable; never invent a model list. */ }
    const authenticated = authResult.code === 0 && /[✓✔]\s*Auth\b/i.test(`${authResult.stdout}\n${authResult.stderr}`);
    const ready = result.code === 0 && models.length > 0 && authenticated;
    const detail = ready
      ? `Kiro instalado e autenticação verificada pelo doctor; ${models.length} modelos anunciados pelo CLI.`
      : models.length && !authenticated
        ? 'Catálogo do Kiro disponível, mas o estado de autenticação não foi confirmado.'
        : 'Kiro instalado, mas descoberta de modelos ou autenticação falhou.';
    return this.cache({ id: 'kiro', name: 'Kiro', installed: true, available: ready, status: ready ? 'ready' : 'error', detail, models, capabilities: { fast: true, tools: true, approvals: true, cancel: true } });
  }
  private cache(value: ProviderInfo) { this.infoCache = { at: Date.now(), value }; return value; }
  private shutdownInfo(): ProviderInfo {
    return { id: 'kiro', name: 'Kiro', installed: Boolean(this.binary), available: false, status: 'error', detail: 'Kiro provider is shutting down.', models: [], capabilities: { fast: true, tools: true, approvals: true, cancel: true } };
  }

  private onMessage(process: JsonRpcProcess, message: JsonRpcMessage) {
    if (process.dispatch(message)) return;
    if (message.method === 'session/request_permission' && message.id !== undefined) {
      const params = isRecord(message.params) ? message.params : {};
      const sessionId = String(params.sessionId ?? '');
      const turn = this.bySession.get(sessionId);
      const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
      const allow = options.find((option) => option.kind === 'allow_once') ?? options.find((option) => String(option.kind).startsWith('allow_'));
      const deny = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => String(option.kind).startsWith('reject_'));
      // Fast turns have no tool budget. Reject at the protocol boundary so an agent cannot run a tool.
      if (!turn || !turn.input.plan.tools || !allow || !deny) {
        process.respond(message.id, { outcome: { outcome: 'selected', optionId: String(deny?.optionId ?? 'reject-once') } });
        return;
      }
      const approvalId = `${turn.input.runId}:${String(message.id)}`;
      this.approvals.set(approvalId, { process, requestId: message.id, runId: turn.input.runId, sessionId, allowOptionId: String(allow.optionId), denyOptionId: String(deny.optionId) });
      const subject = isRecord(params.subject) ? params.subject : {};
      const tool = isRecord(params.toolCall) ? params.toolCall : isRecord(subject.toolCall) ? subject.toolCall : {};
      const rawInput = tool.rawInput;
      const detail = typeof params.description === 'string' ? params.description : typeof rawInput === 'string' ? rawInput : rawInput ? JSON.stringify(rawInput) : String(tool.title ?? 'Kiro solicita permissão.');
      emitApproval(turn.input, turn.emit, approvalId, String(params.title ?? tool.title ?? 'Permitir ferramenta Kiro'), detail, String(tool.kind ?? '').includes('edit') ? 'file' : 'tool');
      return;
    }
    if ((message.method !== 'session/notification' && message.method !== 'session/update') || !isRecord(message.params)) return;
    const params = message.params;
    const turn = this.bySession.get(String(params.sessionId ?? ''));
    if (!turn) return;
    const update = isRecord(params.update) ? params.update : {};
    const type = String(update.sessionUpdate ?? update.type ?? '');
    if (type === 'agent_message_chunk' || type === 'AgentMessageChunk') {
      const content = isRecord(update.content) ? update.content : {};
      const text = typeof content.text === 'string' ? content.text : typeof update.text === 'string' ? update.text : '';
      if (text) { turn.text += text; turn.emit({ type: 'delta', text }); }
    } else if (type === 'tool_call' || type === 'ToolCall' || type === 'tool_call_update' || type === 'ToolCallUpdate') {
      const status = String(update.status ?? (type.toLowerCase().includes('update') ? 'running' : 'pending'));
      turn.emit({ type: 'tool', name: String(update.kind ?? 'kiro-tool'), description: String(update.title ?? update.toolCallId ?? 'Ferramenta Kiro'), status });
    } else if (type === 'turn_end' || type === 'TurnEnd') this.finish(turn, { text: turn.text, nativeSessionId: turn.sessionId, stopReason: 'completed' });
  }
  private finish(turn: KiroTurn, result: RunResult, error?: Error) {
    if (!this.turns.has(turn.input.runId)) return;
    turn.signal.removeEventListener('abort', turn.abort); this.turns.delete(turn.input.runId); this.bySession.delete(turn.sessionId);
    for (const [id, pending] of this.approvals) if (pending.runId === turn.input.runId) { pending.process.respond(pending.requestId, { outcome: { outcome: 'selected', optionId: pending.denyOptionId } }); this.approvals.delete(id); }
    if (error) turn.reject(error); else turn.resolve(result);
  }
  async run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<RunResult> {
    if (this.shuttingDown) throw new Error('Kiro provider is shutting down');
    this.binary ??= await findProviderBinary('kiro');
    if (!this.binary) throw new Error(providerBinaryMissingDetail('kiro'));
    const args = ['acp', '--agent-engine', 'v2', '--trust-tools='];
    if (input.model) args.push('--model', input.model);
    args.push('--effort', input.plan.effort);
    // A fresh KIRO_HOME keeps global MCP servers, extra agents, memory and steering out of this app.
    // Kiro's credential store is outside KIRO_HOME and remains owned by the CLI.
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'adelic-kiro-home-'));
    const agentDir = path.join(isolatedHome, 'agents');
    const agentName = 'adelic-runtime';
    const toolsAllowed = input.plan.tools && input.plan.level === 'deep';
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, `${agentName}.json`), JSON.stringify({
      name: agentName,
      description: 'Runtime isolado do Adelic',
      prompt: 'Siga somente as instruções da conversa atual.',
      tools: toolsAllowed ? ['fs_read', 'fs_write', 'execute_bash', 'grep', 'glob', 'code'] : [],
      allowedTools: [],
      resources: [],
      mcpServers: {},
      includeMcpJson: false,
    }), { mode: 0o600 });
    args.push('--agent', agentName);
    let wrapped: Awaited<ReturnType<typeof bubblewrap>>;
    try { wrapped = await bubblewrap(this.binary, args, input.cwd, input.sandbox, [isolatedHome]); }
    catch (error) { await rm(isolatedHome, { recursive: true, force: true }); throw error; }
    if (signal.aborted) { await rm(isolatedHome, { recursive: true, force: true }); throw abortError(signal); }
    let turn: KiroTurn | undefined;
    let process!: JsonRpcProcess;
    process = new JsonRpcProcess(wrapped.command, wrapped.args, input.cwd, (message) => this.onMessage(process, message), { ...globalThis.process.env, KIRO_HOME: isolatedHome, KIRO_LOG_NO_COLOR: '1', NO_COLOR: '1' });
    this.processes.add(process);
    const abortStartup = () => process.kill();
    signal.addEventListener('abort', abortStartup, { once: true });
    try {
      await raceAbort(process.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'adelic', version: '0.1.0' } }), signal);
      if (signal.aborted) throw abortError(signal);
      const sessionRaw = await raceAbort(process.request('session/new', { cwd: input.cwd, mcpServers: [] }), signal);
      signal.removeEventListener('abort', abortStartup);
      if (signal.aborted) throw abortError(signal);
      const sessionId = String(isRecord(sessionRaw) ? sessionRaw.sessionId ?? '' : '');
      if (!sessionId) throw new Error('Kiro não retornou o identificador da sessão ACP.');
      const result = await new Promise<RunResult>((resolve, reject) => {
        const current: KiroTurn = { input, emit, sessionId, text: '', resolve, reject, signal, abort: () => {
          process.notify('session/cancel', { sessionId });
          this.finish(current, { text: current.text, nativeSessionId: sessionId, stopReason: 'cancelled' });
        } };
        turn = current; this.turns.set(input.runId, current); this.bySession.set(sessionId, current);
        signal.addEventListener('abort', current.abort, { once: true });
        emit({ type: 'session', nativeSessionId: sessionId });
        const text = boundedPrompt(input);
        // Kiro 2.23 documents `content`; ACP v1 uses `prompt`. Send both for compatibility with
        // Kiro's legacy adapter and clients implementing the published protocol schema.
        void process.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }], content: [{ type: 'text', text }] }, 10 * 60_000)
          .then((response) => {
            if (!this.turns.has(input.runId)) return;
            const stopReason = isRecord(response) && String(response.stopReason ?? '').toLowerCase() === 'cancelled' ? 'cancelled' : 'completed';
            if (isRecord(response) && ['error', 'failed'].includes(String(response.stopReason ?? '').toLowerCase())) this.finish(current, { text: current.text, nativeSessionId: sessionId, stopReason: 'completed' }, new Error(String(response.error ?? 'Kiro informou falha no turno.')));
            else this.finish(current, { text: current.text, nativeSessionId: sessionId, stopReason });
          })
          .catch((error) => this.finish(current, { text: current.text, nativeSessionId: sessionId, stopReason: 'completed' }, new Error(errorMessage(error))));
      });
      return result;
    } finally {
      signal.removeEventListener('abort', abortStartup);
      this.processes.delete(process); await process.kill();
      await rm(isolatedHome, { recursive: true, force: true });
      if (turn && this.turns.has(input.runId)) this.finish(turn, { text: turn.text, stopReason: 'cancelled' });
    }
  }
  async approve(approvalId: string, decision: 'approve' | 'deny') {
    const pending = this.approvals.get(approvalId); if (!pending) throw new Error('Aprovação não está mais pendente.');
    this.approvals.delete(approvalId);
    pending.process.respond(pending.requestId, { outcome: { outcome: 'selected', optionId: decision === 'approve' ? pending.allowOptionId : pending.denyOptionId } });
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
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
