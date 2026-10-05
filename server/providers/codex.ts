import path from 'node:path';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { Approval, ProviderEvent, ProviderInfo, RunInput, RunResult, Sandbox } from '../../shared/contracts';
import { abortError, boundedPrompt, emitApproval } from './common';
import { CommandScope, runCommand, type CommandExecutor, type CommandResult } from './command';
import { errorMessage, isRecord, JsonRpcProcess, type JsonRpcMessage } from './process';
import { findProviderBinary, hasProviderBinaryOverride, providerBinaryMissingDetail } from './discovery';

interface CodexServer { key: string; cwd: string; tools: boolean; rpc?: JsonRpcProcess; ready: Promise<JsonRpcProcess> }
interface ActiveTurn { input: RunInput; emit: (event: ProviderEvent) => void; server: CodexServer; threadId?: string; turnId?: string; text: string; resolve: (result: RunResult) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void; requestInterrupt: () => void; interruptSent: boolean }
interface PendingApproval { runId: string; sessionId: string; server: CodexServer; requestId: string | number; method: string; params: Record<string, unknown> }

function approvalDetail(method: string, params: Record<string, unknown>) {
  if (method === 'item/commandExecution/requestApproval') {
    return [typeof params.command === 'string' ? `Comando: ${params.command}` : '', typeof params.cwd === 'string' ? `Diretório: ${params.cwd}` : '', typeof params.reason === 'string' ? `Motivo: ${params.reason}` : ''].filter(Boolean).join('\n');
  }
  if (method === 'item/fileChange/requestApproval') {
    return [typeof params.grantRoot === 'string' ? `Caminho solicitado: ${params.grantRoot}` : '', typeof params.reason === 'string' ? `Motivo: ${params.reason}` : ''].filter(Boolean).join('\n');
  }
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const fs = isRecord(permissions.fileSystem) ? permissions.fileSystem : {};
  const paths: string[] = [];
  if (Array.isArray(fs.entries)) for (const entry of fs.entries) {
    if (!isRecord(entry)) continue;
    const access = String(entry.access ?? 'access');
    const itemPath = isRecord(entry.path) ? String(entry.path.path ?? entry.path.pattern ?? (isRecord(entry.path.value) ? entry.path.value.kind ?? 'special path' : 'special path')) : '';
    if (itemPath) paths.push(`${access}: ${itemPath}`);
  }
  for (const key of ['read', 'write'] as const) if (Array.isArray(fs[key])) for (const entry of fs[key]) if (typeof entry === 'string') paths.push(`${key}: ${entry}`);
  const network = isRecord(permissions.network) && permissions.network.enabled === true ? 'Rede: acesso solicitado' : '';
  return [...paths, network, typeof params.reason === 'string' ? `Motivo: ${params.reason}` : ''].filter(Boolean).join('\n') || 'Permissões adicionais solicitadas.';
}

function approvedPermissions(turn: ActiveTurn, params: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(params.permissions)) return undefined;
  const requested = params.permissions;
  const fileSystem = isRecord(requested.fileSystem) ? requested.fileSystem : undefined;
  if (!fileSystem) return requested;
  const root = path.resolve(turn.input.cwd);
  const isWithinWorkspace = (raw: string) => {
    const resolved = path.resolve(root, raw);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  };
  if (Array.isArray(fileSystem.entries)) {
    for (const entry of fileSystem.entries) {
      if (!isRecord(entry)) return undefined;
      const access = String(entry.access ?? '');
      const permissionPath = isRecord(entry.path) ? entry.path : {};
      if (access === 'write' && (turn.input.sandbox === 'read-only' || permissionPath.type !== 'path' || typeof permissionPath.path !== 'string' || !isWithinWorkspace(permissionPath.path))) return undefined;
    }
  }
  if (Array.isArray(fileSystem.write)) {
    if (turn.input.sandbox === 'read-only' || fileSystem.write.some((entry) => typeof entry !== 'string' || !isWithinWorkspace(entry))) return undefined;
  }
  return requested;
}

async function configuredMcpNames(cwd: string): Promise<string[]> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const baseConfig = path.join(codexHome, 'config.toml');
  const files = [baseConfig];
  try {
    const config = parseToml(await readFile(baseConfig, 'utf8')) as Record<string, unknown>;
    const selected = typeof config.profile === 'string' ? config.profile : undefined;
    if (selected && /^[A-Za-z0-9_-]+$/.test(selected)) files.push(path.join(codexHome, `${selected}.config.toml`));
  } catch { /* no user config */ }
  let ancestor = path.resolve(cwd);
  for (;;) {
    files.push(path.join(ancestor, '.codex/config.toml'));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const names = new Set<string>();
  for (const file of files) {
    let config: Record<string, unknown>;
    try { config = parseToml(await readFile(file, 'utf8')) as Record<string, unknown>; } catch { continue; }
    const mcpServers = config.mcp_servers;
    if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
      for (const name of Object.keys(mcpServers)) names.add(name);
    }
  }
  return [...names];
}

export class CodexProvider {
  private binary?: string;
  private servers = new Map<string, CodexServer>();
  private discoveryProcesses = new Set<JsonRpcProcess>();
  private turns = new Map<string, ActiveTurn>();
  private byThread = new Map<string, ActiveTurn>();
  private approvals = new Map<string, PendingApproval>();
  private infoCache?: { at: number; value: ProviderInfo };
  private shuttingDown = false;
  private commands: CommandScope;
  constructor(
    private resolveBinary = () => findProviderBinary('codex'),
    command: CommandExecutor = runCommand,
    private discoverModelsOverride?: (binary: string) => Promise<ProviderInfo['models']>,
  ) { this.commands = new CommandScope(command); }
  async info(): Promise<ProviderInfo> {
    if (this.shuttingDown) return this.shutdownInfo();
    if (this.infoCache && Date.now() - this.infoCache.at < 5 * 60_000) return this.infoCache.value;
    this.binary ??= await this.resolveBinary();
    if (!this.binary) return this.cacheInfo({ id: 'codex', name: 'Codex', installed: false, available: false, status: hasProviderBinaryOverride('codex') ? 'error' : 'missing', detail: providerBinaryMissingDetail('codex'), models: [], capabilities: { fast: true, tools: true, approvals: true, cancel: true } });
    const result = await this.commands.run(this.binary, ['login', 'status'], 3000);
    if (this.shuttingDown) return this.shutdownInfo();
    const auth = parseCodexAuth(result);
    const models = auth.kind !== 'none' ? await (this.discoverModelsOverride?.(this.binary) ?? this.discoverModels(this.binary)) : [];
    if (this.shuttingDown) return this.shutdownInfo();
    const modelNote = models.length ? ` ${models.length} modelos descobertos pelo app-server.` : ' Catálogo de modelos indisponível.';
    const authDetail = auth.kind === 'chatgpt'
      ? 'Autenticação da conta ChatGPT confirmada; plano ou assinatura não verificados.'
      : auth.kind === 'api-key'
        ? 'Autenticação por chave de API confirmada; isso não verifica assinatura ChatGPT.'
        : 'Codex instalado, mas a autenticação não foi confirmada.';
    const available = auth.kind !== 'none';
    const value: ProviderInfo = { id: 'codex', name: 'Codex', installed: true, available, status: available ? 'ready' : 'error', detail: `${authDetail}${available ? modelNote : ''}`, models, capabilities: { fast: true, tools: true, approvals: true, cancel: true } };
    return this.cacheInfo(value);
  }
  private async discoverModels(binary: string): Promise<ProviderInfo['models']> {
    const discoveryCwd = os.tmpdir();
    const args = await this.serverArgs(discoveryCwd, false);
    if (this.shuttingDown) return [];
    const rpc = new JsonRpcProcess(binary, args, discoveryCwd, (message) => { rpc.dispatch(message); });
    this.discoveryProcesses.add(rpc);
    try {
      await rpc.request('initialize', { clientInfo: { name: 'adelic-discovery', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 5000);
      rpc.notify('initialized', {});
      const models: ProviderInfo['models'] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page++) {
        const response = await rpc.request('model/list', { limit: 100, includeHidden: false, cursor }, 5000);
        if (!isRecord(response) || !Array.isArray(response.data)) return [];
        for (const raw of response.data) {
          if (!isRecord(raw) || typeof raw.id !== 'string') continue;
          const efforts = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts.flatMap((item) => isRecord(item) && typeof item.reasoningEffort === 'string' ? [item.reasoningEffort] : []) : [];
          models.push({ id: raw.id, name: typeof raw.displayName === 'string' ? raw.displayName : raw.id, ...(efforts.length ? { efforts } : {}) });
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
        if (!cursor) break;
      }
      return models;
    } catch { return []; }
    finally {
      try { await rpc.kill(); }
      finally { this.discoveryProcesses.delete(rpc); }
    }
  }
  private cacheInfo(value: ProviderInfo) { this.infoCache = { at: Date.now(), value }; return value; }
  private shutdownInfo(): ProviderInfo {
    return { id: 'codex', name: 'Codex', installed: Boolean(this.binary), available: false, status: 'error', detail: 'Codex provider is shutting down.', models: [], capabilities: { fast: true, tools: true, approvals: true, cancel: true } };
  }
  private async serverArgs(cwd: string, tools: boolean) {
    const args = ['app-server', '--listen', 'stdio://'];
    for (const name of await configuredMcpNames(cwd)) {
      const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      args.push('-c', `mcp_servers.${key}.enabled=false`);
    }
    // Host-global customizations can introduce hooks, plugins, skills, or tools outside
    // the Adelic policy. Keep the runtime profile controlled in every mode.
    for (const feature of ['hooks', 'skill_search', 'apps', 'plugins', 'memories', 'multi_agent']) args.push('--disable', feature);
    if (!tools) {
      for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'multi_agent', 'image_generation', 'view_image', 'sleep_tool', 'goals', 'code_mode_host']) args.push('--disable', feature);
      args.push('-c', 'project_doc_max_bytes=0');
      args.push('--enable', 'skip_host_skill_discovery');
    }
    return args;
  }
  private async ensureServer(cwd: string, tools: boolean): Promise<CodexServer> {
    if (this.shuttingDown) throw new Error('Codex provider is shutting down');
    if (!this.binary) this.binary = await this.resolveBinary();
    if (!this.binary) throw new Error(providerBinaryMissingDetail('codex'));
    const resolvedCwd = path.resolve(cwd);
    const key = `${resolvedCwd}\0${tools ? 'tools' : 'no-tools'}`;
    let server = this.servers.get(key);
    if (server) { await server.ready; return server; }
    server = { key, cwd: resolvedCwd, tools, ready: Promise.resolve(undefined as unknown as JsonRpcProcess) };
    this.servers.set(key, server);
    server.ready = this.startServer(server);
    try { await server.ready; return server; }
    catch (error) { if (this.servers.get(key) === server) this.servers.delete(key); throw error; }
  }
  private async startServer(server: CodexServer): Promise<JsonRpcProcess> {
    const args = await this.serverArgs(server.cwd, server.tools);
    if (this.shuttingDown) throw new Error('Codex provider is shutting down');
    if (!this.binary) throw new Error(providerBinaryMissingDetail('codex'));
    const rpc = new JsonRpcProcess(this.binary, args, server.cwd, (message) => this.onMessage(server, message));
    server.rpc = rpc;
    void rpc.waitExit().then(() => {
      if (this.servers.get(server.key) === server) this.servers.delete(server.key);
      for (const turn of [...this.turns.values()]) {
        if (turn.server === server) this.finishTurn(turn, { text: turn.text, nativeSessionId: turn.threadId, stopReason: 'completed' }, new Error('Codex app-server encerrou antes de concluir o turno.'));
      }
    });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'adelic', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized', {});
      return rpc;
    } catch (error) { await rpc.kill(); throw error; }
  }
  private onMessage(server: CodexServer, message: JsonRpcMessage) {
    const rpc = server.rpc;
    if (!rpc) return;
    if (rpc.dispatch(message)) return;
    if (!message.method || message.id === undefined) {
      const params = isRecord(message.params) ? message.params : {};
      const threadId = String(params.threadId ?? '');
      const turn = this.byThread.get(`${server.key}\n${threadId}`);
      if (!turn) return;
      if (message.method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) { turn.text += delta; turn.emit({ type: 'delta', text: delta }); }
      } else if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = isRecord(params.item) ? params.item : {};
        const itemType = String(item.type ?? '');
        if (itemType === 'commandExecution' || itemType === 'mcpToolCall' || itemType === 'fileChange') turn.emit({ type: 'tool', name: itemType, description: String(item.command ?? item.title ?? itemType), status: message.method === 'item/started' ? 'running' : String(item.status ?? 'completed') });
      } else if (message.method === 'turn/started') {
        const info = isRecord(params.turn) ? params.turn : {};
        turn.turnId = String(info.id ?? '');
      } else if (message.method === 'turn/completed') {
        const turnInfo = isRecord(params.turn) ? params.turn : {};
        const status = String(turnInfo.status ?? 'completed');
        if (status === 'failed') this.finishTurn(turn, { text: turn.text, nativeSessionId: turn.threadId, stopReason: 'completed' }, new Error('Codex marcou a execução como falha.'));
        else this.finishTurn(turn, { text: turn.text, nativeSessionId: turn.threadId, stopReason: status === 'interrupted' ? 'cancelled' : 'completed' });
      } else if (message.method === 'error') {
        const err = isRecord(params.error) ? params.error : params;
        this.finishTurn(turn, { text: turn.text, nativeSessionId: turn.threadId, stopReason: 'completed' }, new Error(errorMessage(err.message ?? 'Erro do Codex.')));
      }
      return;
    }
    if (!message.method) return;
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval' || message.method === 'item/permissions/requestApproval') {
      const threadId = String(params.threadId ?? '');
      const turn = this.byThread.get(`${server.key}\n${threadId}`);
      if (!turn) { rpc.respond(message.id, message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' }); return; }
      if (!turn.input.plan.tools) {
        rpc.respond(message.id, message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
        return;
      }
      const approvalId = `${turn.input.runId}:${String(message.id)}`;
      this.approvals.set(approvalId, { runId: turn.input.runId, sessionId: turn.input.sessionId, server, requestId: message.id, method: message.method, params });
      const isFile = message.method.includes('fileChange');
      const detail = approvalDetail(message.method, params);
      emitApproval(turn.input, turn.emit, approvalId, isFile ? 'Permitir alteração de arquivo' : 'Permitir ferramenta do Codex', detail, isFile ? 'file' : 'command');
      return;
    }
    if (!rpc.dispatch(message)) rpc.respondError(message.id, -32601, 'Unsupported Codex app-server request');
  }
  private finishTurn(turn: ActiveTurn, result: RunResult, error?: Error) {
    if (!this.turns.has(turn.input.runId)) return;
    turn.signal.removeEventListener('abort', turn.abort);
    this.turns.delete(turn.input.runId);
    if (turn.threadId) this.byThread.delete(`${turn.server.key}\n${turn.threadId}`);
    for (const [id, pending] of this.approvals) if (pending.runId === turn.input.runId) {
      pending.server.rpc?.respond(pending.requestId, pending.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
      this.approvals.delete(id);
    }
    if (error) turn.reject(error); else turn.resolve(result);
  }
  async run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<RunResult> {
    const toolsAllowed = input.plan.tools && input.plan.level === 'deep';
    const server = await raceAbort(this.ensureServer(input.cwd, toolsAllowed), signal);
    if (signal.aborted) throw abortError(signal);
    const rpc = server.rpc;
    if (!rpc) throw new Error('Codex app-server não está disponível.');
    const threadRaw = await raceAbort(rpc.request('thread/start', {
      cwd: input.cwd, ephemeral: true, model: input.model ?? null,
      sandbox: input.sandbox === 'read-only' ? 'read-only' : 'workspace-write', approvalPolicy: 'on-request',
      config: toolsAllowed
        ? { model_reasoning_effort: input.plan.effort }
        : { model_reasoning_effort: input.plan.effort, web_search: 'disabled', project_doc_max_bytes: 0, features: { apps: false, memories: false, plugins: false, shell_tool: false, unified_exec: false, browser_use: false, computer_use: false, multi_agent: false, hooks: false, skill_search: false, image_generation: false, view_image: false, sleep_tool: false, goals: false, code_mode_host: false, skip_host_skill_discovery: true } },
      baseInstructions: `Responda em português salvo se o usuário pedir outra língua. ${toolsAllowed ? 'Use ferramentas necessárias, sujeito a sandbox e aprovação.' : 'Responda diretamente sem ferramentas.'}`,
    }), signal);
    if (signal.aborted) throw abortError(signal);
    const thread = isRecord(threadRaw) && isRecord(threadRaw.thread) ? threadRaw.thread : {};
    const threadId = String(thread.id ?? (isRecord(threadRaw) ? threadRaw.id ?? '' : ''));
    if (!threadId) throw new Error('Codex não retornou o identificador da thread.');
    return new Promise<RunResult>((resolve, reject) => {
      const turnInput = toolsAllowed === input.plan.tools ? input : { ...input, plan: { ...input.plan, tools: toolsAllowed } };
      const turn: ActiveTurn = { input: turnInput, emit, server, threadId, text: '', resolve, reject, signal, interruptSent: false, requestInterrupt: () => {
        if (turn.turnId && !turn.interruptSent) {
          turn.interruptSent = true;
          void rpc.request('turn/interrupt', { threadId, turnId: turn.turnId }, 3000).catch(() => undefined);
        }
      }, abort: () => {
        turn.requestInterrupt();
        this.finishTurn(turn, { text: turn.text, nativeSessionId: threadId, stopReason: 'cancelled' });
      } };
      this.turns.set(input.runId, turn); this.byThread.set(`${server.key}\n${threadId}`, turn);
      signal.addEventListener('abort', turn.abort, { once: true });
      void rpc.request('turn/start', { threadId, input: [{ type: 'text', text: boundedPrompt(input), text_elements: [] }], cwd: input.cwd, model: input.model ?? null, effort: input.plan.effort, approvalPolicy: 'on-request', sandboxPolicy: input.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: true } : { type: 'workspaceWrite', writableRoots: [path.resolve(input.cwd)], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }, 15_000).then((raw) => {
        if (isRecord(raw) && isRecord(raw.turn)) turn.turnId = String(raw.turn.id ?? '');
        if (signal.aborted) turn.requestInterrupt();
      }).catch((error) => this.finishTurn(turn, { text: turn.text, stopReason: 'completed' }, new Error(errorMessage(error))));
    });
  }
  async approve(approvalId: string, decision: 'approve' | 'deny') {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Aprovação não está mais pendente.');
    this.approvals.delete(approvalId);
    if (pending.method === 'item/permissions/requestApproval') {
      const turn = this.turns.get(pending.runId);
      const permissions = decision === 'approve' && turn ? approvedPermissions(turn, pending.params) : undefined;
      pending.server.rpc?.respond(pending.requestId, { permissions: permissions ?? {}, scope: 'turn' });
      return;
    }
    const commandDecision = decision === 'approve' ? 'accept' : 'decline';
    pending.server.rpc?.respond(pending.requestId, { decision: commandDecision });
  }
  async shutdown() {
    this.shuttingDown = true;
    const commandShutdown = this.commands.shutdown();
    for (const turn of [...this.turns.values()]) turn.abort();
    const servers = [...this.servers.values()];
    await Promise.all([commandShutdown, ...servers.map(async (server) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const rpc = server.rpc ?? await Promise.race([
          server.ready,
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2500); }),
        ]);
        await rpc?.kill();
      } catch { /* Startup failure already settled; no child remains to close. */ }
      finally { if (timer) clearTimeout(timer); }
    }), ...[...this.discoveryProcesses].map((rpc) => rpc.kill())]);
    this.servers.clear();
    this.approvals.clear();
  }
}

function parseCodexAuth(result: CommandResult): { kind: 'chatgpt' | 'api-key' | 'none' } {
  if (result.code !== 0 || result.timedOut) return { kind: 'none' };
  const status = `${result.stdout}\n${result.stderr}`;
  if (/logged\s+in\s+using\s+(?:a\s+)?chatgpt\b/i.test(status)) return { kind: 'chatgpt' };
  if (/logged\s+in\s+using\s+(?:(?:an|a)\s+)?(?:openai\s+)?api\s+key\b/i.test(status)) return { kind: 'api-key' };
  return { kind: 'none' };
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
