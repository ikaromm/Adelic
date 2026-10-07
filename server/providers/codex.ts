import path from 'node:path';
import { copyFile, lstat, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import type { ProviderEvent, ProviderInfo, RunInput, RunResult, Sandbox } from '../../shared/contracts';
import { abortError, boundedPrompt, emitApproval } from './common';
import { CommandScope, runCommand, type CommandExecutor, type CommandResult } from './command';
import {
  DeltaParams,
  ErrorParams,
  ItemParams,
  TOOL_ITEM_TYPES,
  ThreadIdParams,
  TokenUsageParams,
  TurnParams,
  parseParams,
} from './codex-protocol';
import { errorMessage, isRecord, JsonRpcProcess, type JsonRpcMessage } from './process';
import { findProviderBinary, hasProviderBinaryOverride, providerBinaryMissingDetail } from './discovery';
import { canonWritePathWithin, classifyApproval, scanCodexRules } from '../approval-policy';
import { bubblewrap, type ReadonlyFileBinding, type WrappedCommand } from './sandbox';

type CodexToolProfile = 'no-tools' | 'fast-local-tools' | 'deep-tools';
interface CodexServer {
  key: string;
  cwd: string;
  profile: CodexToolProfile;
  scratch: string;
  rpc?: JsonRpcProcess;
  ready: Promise<JsonRpcProcess>;
  cleanup?: Promise<void>;
}
interface ActiveTurn {
  input: RunInput;
  emit: (event: ProviderEvent) => void;
  server: CodexServer;
  threadId?: string;
  turnId?: string;
  localEnvironmentVerified: boolean;
  text: string;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abort: () => void;
  requestInterrupt: () => void;
  interruptSent: boolean;
}
interface PendingApproval {
  runId: string;
  sessionId: string;
  server: CodexServer;
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
}
type CodexWrapper = (
  command: string,
  args: string[],
  cwd: string,
  sandbox: Sandbox,
  writableRuntimeDirs?: string[],
  readonlyFileBindings?: ReadonlyFileBinding[],
) => Promise<WrappedCommand>;

/**
 * `turn/start` input: the prompt text plus one `localImage` item per attached image.
 * Codex 0.160 lists `localImage` (field `path`) among the UserInput variants; the
 * app-server reads the file itself, so the path must be visible inside its sandbox.
 */
export function codexTurnInput(text: string, imagePaths: string[] = []) {
  return [
    { type: 'text', text, text_elements: [] as unknown[] },
    ...imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
  ];
}

/**
 * Copies attached images into the run's private scratch (0700, removed with the run), which
 * the bubblewrap wrapper binds into the sandbox even when the data folder lives under /tmp.
 */
export async function stageCodexImages(scratch: string, images: NonNullable<RunInput['attachments']>) {
  if (!images.length) return [];
  const directory = path.join(scratch, 'attachments');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staged: string[] = [];
  for (const [index, image] of images.entries()) {
    const target = path.join(directory, `${index}-${path.basename(image.path)}`);
    await copyFile(image.path, target);
    await chmod(target, 0o600);
    staged.push(target);
  }
  return staged;
}

function approvalDetail(method: string, params: Record<string, unknown>) {
  if (method === 'item/commandExecution/requestApproval') {
    return [
      typeof params.command === 'string' ? `Comando: ${params.command}` : '',
      typeof params.cwd === 'string' ? `Diretório: ${params.cwd}` : '',
      typeof params.reason === 'string' ? `Motivo: ${params.reason}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (method === 'item/fileChange/requestApproval') {
    return [
      typeof params.grantRoot === 'string' ? `Caminho solicitado: ${params.grantRoot}` : '',
      typeof params.reason === 'string' ? `Motivo: ${params.reason}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const permissions = isRecord(params.permissions) ? params.permissions : {};
  const fs = isRecord(permissions.fileSystem) ? permissions.fileSystem : {};
  const paths: string[] = [];
  if (Array.isArray(fs.entries))
    for (const entry of fs.entries) {
      if (!isRecord(entry)) continue;
      const access = String(entry.access ?? 'access');
      const itemPath = isRecord(entry.path)
        ? String(
            entry.path.path ??
              entry.path.pattern ??
              (isRecord(entry.path.value) ? (entry.path.value.kind ?? 'special path') : 'special path'),
          )
        : '';
      if (itemPath) paths.push(`${access}: ${itemPath}`);
    }
  for (const key of ['read', 'write'] as const)
    if (Array.isArray(fs[key]))
      for (const entry of fs[key]) if (typeof entry === 'string') paths.push(`${key}: ${entry}`);
  const network =
    isRecord(permissions.network) && permissions.network.enabled === true ? 'Rede: acesso solicitado' : '';
  return (
    [...paths, network, typeof params.reason === 'string' ? `Motivo: ${params.reason}` : '']
      .filter(Boolean)
      .join('\n') || 'Permissões adicionais solicitadas.'
  );
}

async function approvedPermissions(
  turn: ActiveTurn,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (!isRecord(params.permissions)) return undefined;
  const requested = params.permissions;
  if (Object.keys(requested).some((key) => !['fileSystem', 'network'].includes(key))) return undefined;
  if (
    requested.network !== undefined &&
    (!isRecord(requested.network) ||
      Object.keys(requested.network).some((key) => key !== 'enabled') ||
      typeof requested.network.enabled !== 'boolean')
  )
    return undefined;
  const fileSystem = isRecord(requested.fileSystem) ? requested.fileSystem : undefined;
  if (requested.fileSystem !== undefined && !fileSystem) return undefined;
  if (
    fileSystem &&
    (Object.keys(fileSystem).some((key) => !['entries', 'read', 'write'].includes(key)) ||
      (fileSystem.entries !== undefined && !Array.isArray(fileSystem.entries)) ||
      (fileSystem.read !== undefined && !Array.isArray(fileSystem.read)) ||
      (fileSystem.write !== undefined && !Array.isArray(fileSystem.write)))
  )
    return undefined;
  let root: string;
  try {
    root = await (await import('node:fs/promises')).realpath(turn.input.cwd);
  } catch {
    return undefined;
  }
  const safeWrite = async (raw: string) => Boolean(await canonWritePathWithin(root, raw));
  if (Array.isArray(fileSystem?.entries)) {
    for (const entry of fileSystem.entries) {
      if (!isRecord(entry)) return undefined;
      if (Object.keys(entry).some((key) => !['access', 'path'].includes(key))) return undefined;
      const access = String(entry.access ?? '');
      const permissionPath = isRecord(entry.path) ? entry.path : {};
      if (!['read', 'write'].includes(access)) return undefined;
      if (
        access === 'write' &&
        (turn.input.sandbox === 'read-only' ||
          permissionPath.type !== 'path' ||
          typeof permissionPath.path !== 'string' ||
          !(await safeWrite(permissionPath.path)))
      )
        return undefined;
    }
  }
  if (Array.isArray(fileSystem?.read) && fileSystem.read.some((entry) => typeof entry !== 'string')) return undefined;
  if (Array.isArray(fileSystem?.write)) {
    if (
      turn.input.sandbox === 'read-only' ||
      fileSystem.write.some((entry) => typeof entry !== 'string') ||
      !(await Promise.all(fileSystem.write.map((entry) => safeWrite(entry as string)))).every(Boolean)
    )
      return undefined;
  }
  return requested;
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
  private scratchBase?: string;
  private ownedScratch = new Set<string>();
  private serverNonce = 0;
  private commands: CommandScope;
  constructor(
    private resolveBinary = () => findProviderBinary('codex'),
    command: CommandExecutor = runCommand,
    private discoverModelsOverride?: (binary: string) => Promise<ProviderInfo['models']>,
    dataDir?: string,
    private wrapCommand: CodexWrapper = bubblewrap,
  ) {
    this.commands = new CommandScope(command);
    this.scratchBase = dataDir ? path.join(dataDir, 'codex-tmp') : undefined;
  }
  async info(): Promise<ProviderInfo> {
    if (this.shuttingDown) return this.shutdownInfo();
    if (this.infoCache && Date.now() - this.infoCache.at < 5 * 60_000) return this.infoCache.value;
    this.binary ??= await this.resolveBinary();
    if (!this.binary)
      return this.cacheInfo({
        id: 'codex',
        name: 'Codex',
        installed: false,
        available: false,
        status: hasProviderBinaryOverride('codex') ? 'error' : 'missing',
        detail: providerBinaryMissingDetail('codex'),
        models: [],
        capabilities: {
          fast: true,
          tools: true,
          approvals: true,
          cancel: true,
          reasoning: true,
          images: true,
          steer: true,
        },
      });
    const result = await this.commands.run(this.binary, ['login', 'status'], 3000);
    if (this.shuttingDown) return this.shutdownInfo();
    const auth = parseCodexAuth(result);
    const models =
      auth.kind !== 'none'
        ? await (this.discoverModelsOverride?.(this.binary) ?? this.discoverModels(this.binary))
        : [];
    if (this.shuttingDown) return this.shutdownInfo();
    const modelNote = models.length
      ? ` ${models.length} modelos descobertos pelo app-server.`
      : ' Catálogo de modelos indisponível.';
    const authDetail =
      auth.kind === 'chatgpt'
        ? 'Autenticação da conta ChatGPT confirmada; plano ou assinatura não verificados.'
        : auth.kind === 'api-key'
          ? 'Autenticação por chave de API confirmada; isso não verifica assinatura ChatGPT.'
          : 'Codex instalado, mas a autenticação não foi confirmada.';
    const available = auth.kind !== 'none';
    const value: ProviderInfo = {
      id: 'codex',
      name: 'Codex',
      installed: true,
      available,
      status: available ? 'ready' : 'error',
      detail: `${authDetail}${available ? modelNote : ''}`,
      models,
      defaultModel: models.find((model) => model.isDefault)?.id,
      capabilities: {
        fast: true,
        tools: true,
        approvals: true,
        cancel: true,
        reasoning: true,
        images: true,
        steer: true,
      },
    };
    return this.cacheInfo(value);
  }
  private async discoverModels(binary: string): Promise<ProviderInfo['models']> {
    const discoveryCwd = os.tmpdir();
    const args = await this.serverArgs(discoveryCwd, 'no-tools');
    if (this.shuttingDown) return [];
    const rpc = new JsonRpcProcess(binary, args, discoveryCwd, (message) => {
      rpc.dispatch(message);
    });
    this.discoveryProcesses.add(rpc);
    try {
      await rpc.request(
        'initialize',
        { clientInfo: { name: 'adelic-discovery', version: '0.1.0' }, capabilities: { experimentalApi: true } },
        5000,
      );
      rpc.notify('initialized', {});
      const models: ProviderInfo['models'] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page++) {
        const response = await rpc.request('model/list', { limit: 100, includeHidden: false, cursor }, 5000);
        if (!isRecord(response) || !Array.isArray(response.data)) return [];
        for (const raw of response.data) {
          if (!isRecord(raw) || typeof raw.id !== 'string') continue;
          const efforts = Array.isArray(raw.supportedReasoningEfforts)
            ? raw.supportedReasoningEfforts.flatMap((item) =>
                isRecord(item) && typeof item.reasoningEffort === 'string' ? [item.reasoningEffort] : [],
              )
            : [];
          const isDefault = raw.isDefault === true;
          const defaultReasoningEffort =
            typeof raw.defaultReasoningEffort === 'string' ? raw.defaultReasoningEffort : undefined;
          models.push({
            id: raw.id,
            name: typeof raw.displayName === 'string' ? raw.displayName : raw.id,
            ...(Array.isArray(raw.supportedReasoningEfforts) ? { efforts } : {}),
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            ...(isDefault ? { isDefault: true } : {}),
          });
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
        if (!cursor) break;
      }
      return models;
    } catch {
      return [];
    } finally {
      try {
        await rpc.kill();
      } finally {
        this.discoveryProcesses.delete(rpc);
      }
    }
  }
  private cacheInfo(value: ProviderInfo) {
    this.infoCache = { at: Date.now(), value };
    return value;
  }
  private shutdownInfo(): ProviderInfo {
    return {
      id: 'codex',
      name: 'Codex',
      installed: Boolean(this.binary),
      available: false,
      status: 'error',
      detail: 'Codex provider is shutting down.',
      models: [],
      capabilities: {
        fast: true,
        tools: true,
        approvals: true,
        cancel: true,
        reasoning: true,
        images: true,
        steer: true,
      },
    };
  }
  private async serverArgs(cwd: string, profile: CodexToolProfile) {
    const args = ['app-server', '--listen', 'stdio://'];
    // Host-global customizations can introduce hooks, plugins, skills, or tools outside
    // the Adelic policy. Keep the runtime profile controlled in every mode.
    for (const feature of [
      'hooks',
      'skill_search',
      'apps',
      'plugins',
      'memories',
      'multi_agent',
      'guardian_approval',
      'shell_snapshot',
    ])
      args.push('--disable', feature);
    args.push('-c', 'allow_login_shell=false');
    if (profile !== 'deep-tools') {
      for (const feature of ['browser_use', 'computer_use', 'image_generation', 'view_image', 'sleep_tool', 'goals'])
        args.push('--disable', feature);
      args.push('-c', 'project_doc_max_bytes=0');
      args.push('--enable', 'skip_host_skill_discovery');
    }
    if (profile === 'fast-local-tools')
      for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host']) args.push('--enable', feature);
    if (profile === 'no-tools')
      for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host']) args.push('--disable', feature);
    return args;
  }
  private async ensureServer(
    cwd: string,
    sandbox: Sandbox,
    profile: CodexToolProfile,
    runId: string,
    signal: AbortSignal,
  ): Promise<CodexServer> {
    if (this.shuttingDown) throw new Error('Codex provider is shutting down');
    if (signal.aborted) throw abortError(signal);
    if (!this.binary) this.binary = await this.resolveBinary();
    if (signal.aborted) throw abortError(signal);
    if (!this.binary) throw new Error(providerBinaryMissingDetail('codex'));
    const resolvedCwd = await realpath(path.resolve(cwd));
    if (signal.aborted) throw abortError(signal);
    // App-server state (including unified-exec children) belongs to one run only.
    const key = `${resolvedCwd}\0${sandbox}\0${profile}\0${runId}\0${++this.serverNonce}`;
    const server: CodexServer = {
      key,
      cwd: resolvedCwd,
      profile,
      scratch: '',
      ready: Promise.resolve(undefined as unknown as JsonRpcProcess),
    };
    this.servers.set(key, server);
    server.ready = (async () => {
      if (signal.aborted) throw abortError(signal);
      const base = this.scratchBase ?? os.tmpdir();
      if (this.scratchBase) await mkdir(base, { recursive: true, mode: 0o700 });
      if (signal.aborted) throw abortError(signal);
      server!.scratch = await mkdtemp(path.join(base, 'adelic-codex-'));
      this.ownedScratch.add(server!.scratch);
      await chmod(server!.scratch, 0o700);
      if (signal.aborted) throw abortError(signal);
      return this.startServer(server!, signal);
    })();
    try {
      await server.ready;
      return server;
    } catch (error) {
      await this.cleanupServer(server);
      throw error;
    }
  }
  private cleanupServer(server: CodexServer): Promise<void> {
    if (server.cleanup) return server.cleanup;
    server.cleanup = (async () => {
      try {
        await server.rpc?.kill();
      } finally {
        if (this.servers.get(server.key) === server) this.servers.delete(server.key);
        if (server.scratch) await this.removeScratch(server.scratch);
      }
    })();
    return server.cleanup;
  }
  private async authBinding(scratch: string, cwd: string, sandbox: Sandbox): Promise<ReadonlyFileBinding[]> {
    const isolatedHome = path.join(scratch, 'CODEX_HOME');
    await mkdir(isolatedHome, { mode: 0o700 });
    const placeholder = path.join(isolatedHome, 'auth.json');
    await writeFile(placeholder, '{}\n', { mode: 0o600 });
    const configuredHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const sourcePath = path.join(configuredHome, 'auth.json');
    try {
      const sourceInfo = await lstat(sourcePath);
      if (
        !sourceInfo.isFile() ||
        sourceInfo.isSymbolicLink() ||
        typeof process.getuid !== 'function' ||
        sourceInfo.uid !== process.getuid()
      )
        return [];
      const source = await realpath(sourcePath);
      const verified = await stat(source);
      if (!verified.isFile() || verified.uid !== process.getuid()) return [];
      const credentialHome = await realpath(configuredHome);
      const workspace = await realpath(cwd);
      const within = (child: string, parent: string) => {
        const relative = path.relative(parent, child);
        return (
          relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
        );
      };
      if (sandbox === 'workspace-write' && within(workspace, credentialHome)) {
        throw new Error(
          'Sandbox workspace-write incompatível: a pasta de trabalho está dentro do CODEX_HOME, que contém credenciais.',
        );
      }
      const bindings: ReadonlyFileBinding[] = [];
      if (sandbox === 'workspace-write' && within(credentialHome, workspace)) {
        const relative = path.relative(workspace, credentialHome);
        const firstChild = path.join(workspace, relative.split(path.sep)[0]!);
        const canonicalChild = await realpath(firstChild);
        bindings.push({ source: canonicalChild, target: firstChild, directory: true });
      }
      bindings.push({ source, target: placeholder });
      return bindings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (error instanceof Error && error.message.includes('workspace-write incompatível')) throw error;
      throw new Error('Não foi possível validar a autenticação Codex para o sandbox.', { cause: error });
    }
  }
  private async startServer(server: CodexServer, signal: AbortSignal): Promise<JsonRpcProcess> {
    const args = await this.serverArgs(server.cwd, server.profile);
    if (signal.aborted) throw abortError(signal);
    if (this.shuttingDown) throw new Error('Codex provider is shutting down');
    if (!this.binary) throw new Error(providerBinaryMissingDetail('codex'));
    const sandbox = server.key.split('\0')[1] as Sandbox;
    const readonlyAuth = await this.authBinding(server.scratch, server.cwd, sandbox);
    if (signal.aborted) throw abortError(signal);
    if (this.shuttingDown) throw new Error('Codex provider is shutting down');
    const isolatedHome = path.join(server.scratch, 'CODEX_HOME');
    const wrapped = await this.wrapCommand(this.binary, args, server.cwd, sandbox, [server.scratch], readonlyAuth);
    if (signal.aborted) throw abortError(signal);
    if (this.shuttingDown) throw new Error('Codex provider is shutting down');
    const runtimeEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('BASH_FUNC_') &&
          !key.startsWith('CODEX_EXEC_SERVER') &&
          !['SHELLOPTS', 'BASHOPTS', 'PS4'].includes(key),
      ),
    ) as NodeJS.ProcessEnv;
    Object.assign(runtimeEnv, {
      CODEX_HOME: isolatedHome,
      TMPDIR: server.scratch,
      BASH_ENV: '/dev/null',
      ENV: '/dev/null',
    });
    const rpc = new JsonRpcProcess(
      wrapped.command,
      wrapped.args,
      server.cwd,
      (message) => this.onMessage(server, message),
      runtimeEnv,
    );
    server.rpc = rpc;
    void rpc.waitExit().then(async () => {
      await this.cleanupServer(server);
      for (const turn of [...this.turns.values()]) {
        if (turn.server === server && !turn.signal.aborted)
          this.finishTurn(
            turn,
            { text: turn.text, nativeSessionId: turn.threadId, stopReason: 'completed' },
            new Error('Codex app-server encerrou antes de concluir o turno.'),
          );
      }
    });
    const abortStartup = () => {
      void rpc.kill();
    };
    signal.addEventListener('abort', abortStartup, { once: true });
    try {
      if (signal.aborted) throw abortError(signal);
      await rpc.request('initialize', {
        clientInfo: { name: 'adelic', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      if (signal.aborted) throw abortError(signal);
      rpc.notify('initialized', {});
      return rpc;
    } catch (error) {
      await rpc.kill();
      if (signal.aborted) throw abortError(signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', abortStartup);
    }
  }
  private async assertNoEnabledMcp(rpc: JsonRpcProcess, cwd: string): Promise<void> {
    const raw = await rpc.request(
      'config/read',
      { cwd: await realpath(path.resolve(cwd)), includeLayers: false },
      5000,
    );
    const object = (value: unknown): value is Record<string, unknown> => isRecord(value) && !Array.isArray(value);
    if (
      !object(raw) ||
      !object(raw.config) ||
      (raw.config.mcp_servers !== undefined &&
        (!object(raw.config.mcp_servers) ||
          Object.values(raw.config.mcp_servers).some(
            (entry) => !object(entry) || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean'),
          )))
    ) {
      throw new Error('Execução Codex bloqueada: configuração MCP efetiva desconhecida; nenhuma thread foi iniciada.');
    }
    const servers = raw.config.mcp_servers ?? {};
    if (Object.values(servers).some((entry) => !isRecord(entry) || entry.enabled !== false)) {
      throw new Error(
        'Execução Codex bloqueada: MCPs personalizados ativos não são suportados neste perfil isolado. Desative-os na configuração efetiva; MCPs integrados do Adelic permanecem disponíveis.',
      );
    }
  }
  private async removeScratch(directory: string) {
    await rm(directory, { recursive: true, force: true });
    this.ownedScratch.delete(directory);
  }
  private onMessage(server: CodexServer, message: JsonRpcMessage) {
    const rpc = server.rpc;
    if (!rpc) return;
    if (rpc.dispatch(message)) return;
    if (!message.method || message.id === undefined) {
      const threadId = parseParams(ThreadIdParams, message.params)?.threadId ?? '';
      const turn = this.byThread.get(`${server.key}\n${threadId}`);
      if (!turn) return;
      if (message.method === 'item/agentMessage/delta') {
        const params = parseParams(DeltaParams, message.params);
        if (params?.delta) {
          turn.text += params.delta;
          turn.emit({ type: 'delta', text: params.delta });
        }
      } else if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = parseParams(ItemParams, message.params)?.item;
        if (item && TOOL_ITEM_TYPES.has(item.type))
          turn.emit({
            type: 'tool',
            name: item.type,
            description: item.command ?? item.title ?? item.type,
            status: message.method === 'item/started' ? 'running' : (item.status ?? 'completed'),
            ...(item.id !== undefined ? { toolCallId: item.id } : {}),
          });
      } else if (message.method === 'thread/tokenUsage/updated') {
        // Token counts only: Codex does not report cost, which stays unknown (never zero).
        const usage = parseParams(TokenUsageParams, message.params)?.tokenUsage.last;
        if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined))
          turn.emit({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      } else if (message.method === 'turn/started') {
        turn.turnId = parseParams(TurnParams, message.params)?.turn?.id ?? '';
      } else if (message.method === 'turn/completed') {
        const status = parseParams(TurnParams, message.params)?.turn?.status ?? 'completed';
        if (status === 'failed')
          this.finishTurn(
            turn,
            { text: turn.text, nativeSessionId: turn.threadId, stopReason: 'completed' },
            new Error('Codex marcou a execução como falha.'),
          );
        else
          this.finishTurn(turn, {
            text: turn.text,
            nativeSessionId: turn.threadId,
            stopReason: status === 'interrupted' ? 'cancelled' : 'completed',
          });
      } else if (message.method === 'error') {
        const params = parseParams(ErrorParams, message.params);
        this.finishTurn(
          turn,
          { text: turn.text, nativeSessionId: turn.threadId, stopReason: 'completed' },
          new Error(errorMessage(params?.error?.message ?? params?.message ?? 'Erro do Codex.')),
        );
      }
      return;
    }
    if (!message.method) return;
    const params = isRecord(message.params) ? message.params : {};
    if (
      message.method === 'item/commandExecution/requestApproval' ||
      message.method === 'item/fileChange/requestApproval' ||
      message.method === 'item/permissions/requestApproval'
    ) {
      const threadId = String(params.threadId ?? '');
      const turn = this.byThread.get(`${server.key}\n${threadId}`);
      if (!turn) {
        rpc.respond(
          message.id,
          message.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : { decision: 'decline' },
        );
        return;
      }
      if (!turn.input.plan.tools) {
        rpc.respond(
          message.id,
          message.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : { decision: 'decline' },
        );
        return;
      }
      const approvalId = `${turn.input.runId}:${String(message.id)}`;
      const kind =
        message.method === 'item/commandExecution/requestApproval'
          ? params.kind === 'writeStdin'
            ? 'stdin'
            : params.kind === undefined || params.kind === 'command'
              ? 'command'
              : 'unknown'
          : message.method.includes('fileChange')
            ? 'file'
            : 'permissions';
      if (kind === 'command') {
        const environmentTrusted = turn.localEnvironmentVerified && params.environmentId === 'local';
        void classifyApproval({
          tools: turn.input.plan.tools,
          mode: environmentTrusted ? (turn.input.approvalMode ?? 'auto-safe') : 'manual',
          kind,
          command: params.command,
          cwd: params.cwd,
          workspace: turn.input.cwd,
          sandbox: turn.input.sandbox,
          networkApprovalContext: params.networkApprovalContext,
          trustedNonLoginShell: environmentTrusted,
        })
          .then((result) => {
            if (
              this.turns.get(turn.input.runId) !== turn ||
              this.byThread.get(`${server.key}\n${threadId}`) !== turn ||
              turn.signal.aborted
            ) {
              rpc.respond(message.id as string | number, { decision: 'decline' });
              return;
            }
            const detail = `${result.reason}\n${approvalDetail(message.method!, params)}`;
            if (result.decision === 'auto') {
              rpc.respond(message.id as string | number, { decision: 'accept' });
              emitApproval(
                turn.input,
                turn.emit,
                approvalId,
                'Comando aprovado automaticamente',
                detail,
                'command',
                'approved',
              );
              return;
            }
            this.approvals.set(approvalId, {
              runId: turn.input.runId,
              sessionId: turn.input.sessionId,
              server,
              requestId: message.id as string | number,
              method: message.method!,
              params,
            });
            emitApproval(turn.input, turn.emit, approvalId, 'Permitir ferramenta do Codex', detail, 'tool');
          })
          .catch(() => rpc.respond(message.id as string | number, { decision: 'decline' }));
        return;
      }
      this.approvals.set(approvalId, {
        runId: turn.input.runId,
        sessionId: turn.input.sessionId,
        server,
        requestId: message.id,
        method: message.method,
        params,
      });
      const isFile = message.method.includes('fileChange');
      const detail = approvalDetail(message.method, params);
      emitApproval(
        turn.input,
        turn.emit,
        approvalId,
        isFile ? 'Permitir alteração de arquivo' : 'Permitir ferramenta do Codex',
        detail,
        isFile ? 'file' : 'command',
      );
      return;
    }
    if (!rpc.dispatch(message)) rpc.respondError(message.id, -32601, 'Unsupported Codex app-server request');
  }
  private finishTurn(turn: ActiveTurn, result: RunResult, error?: Error) {
    if (!this.turns.has(turn.input.runId)) return;
    turn.signal.removeEventListener('abort', turn.abort);
    this.turns.delete(turn.input.runId);
    if (turn.threadId) this.byThread.delete(`${turn.server.key}\n${turn.threadId}`);
    for (const [id, pending] of this.approvals)
      if (pending.runId === turn.input.runId) {
        pending.server.rpc?.respond(
          pending.requestId,
          pending.method === 'item/permissions/requestApproval'
            ? { permissions: {}, scope: 'turn' }
            : { decision: 'decline' },
        );
        this.approvals.delete(id);
      }
    if (error) turn.reject(error);
    else turn.resolve(result);
  }
  async run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal): Promise<RunResult> {
    let ownedServer: CodexServer | undefined;
    try {
      const toolsAllowed = input.plan.tools;
      const profile: CodexToolProfile = !toolsAllowed
        ? 'no-tools'
        : input.plan.level === 'fast'
          ? 'fast-local-tools'
          : 'deep-tools';
      if (signal.aborted) throw abortError(signal);
      if (toolsAllowed) await scanCodexRules({ cwd: input.cwd });
      const server = (ownedServer = await this.ensureServer(input.cwd, input.sandbox, profile, input.runId, signal));
      if (signal.aborted) throw abortError(signal);
      const rpc = server.rpc;
      if (!rpc) throw new Error('Codex app-server não está disponível.');
      // Recheck on every run because the app-server caches its config while host files may change.
      await raceAbort(this.assertNoEnabledMcp(rpc, input.cwd), signal);
      if (signal.aborted) throw abortError(signal);
      const imagePaths = await stageCodexImages(server.scratch, input.attachments ?? []);
      if (signal.aborted) throw abortError(signal);
      const threadRaw = await raceAbort(
        rpc.request('thread/start', {
          cwd: server.cwd,
          ephemeral: true,
          model: input.model ?? null,
          sandbox: input.sandbox === 'read-only' ? 'read-only' : 'workspace-write',
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          config: {
            allow_login_shell: false,
            shell_environment_policy: {
              set: {
                TMPDIR: server.scratch,
                BASH_ENV: '/dev/null',
                ENV: '/dev/null',
                PATH: process.env.PATH ?? '/usr/bin:/bin',
              },
              exclude: ['BASH_FUNC_*', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'CODEX_EXEC_SERVER*'],
            },
            ...(profile === 'deep-tools'
              ? {
                  ...(input.plan.effort ? { model_reasoning_effort: input.plan.effort } : {}),
                  features: { guardian_approval: false, shell_snapshot: false },
                }
              : {
                  ...(input.plan.effort ? { model_reasoning_effort: input.plan.effort } : {}),
                  web_search: 'disabled',
                  project_doc_max_bytes: 0,
                  features: {
                    guardian_approval: false,
                    shell_snapshot: false,
                    apps: false,
                    memories: false,
                    plugins: false,
                    shell_tool: toolsAllowed,
                    unified_exec: toolsAllowed,
                    browser_use: false,
                    computer_use: false,
                    multi_agent: false,
                    hooks: false,
                    skill_search: false,
                    image_generation: false,
                    view_image: false,
                    sleep_tool: false,
                    goals: false,
                    code_mode_host: profile === 'fast-local-tools',
                    skip_host_skill_discovery: true,
                  },
                }),
          },
          baseInstructions: `Responda em português salvo se o usuário pedir outra língua. ${toolsAllowed ? (profile === 'fast-local-tools' ? 'Responda diretamente; use ferramentas locais somente se necessário para verificar informações do computador. Não afirme falta de acesso sem tentar. Sujeito a sandbox e aprovação.' : 'Use ferramentas necessárias, sujeito a sandbox e aprovação.') : 'Responda diretamente sem ferramentas.'}`,
        }),
        signal,
      );
      if (signal.aborted) throw abortError(signal);
      const thread = isRecord(threadRaw) && isRecord(threadRaw.thread) ? threadRaw.thread : {};
      const threadId = String(thread.id ?? (isRecord(threadRaw) ? (threadRaw.id ?? '') : ''));
      if (!threadId) throw new Error('Codex não retornou o identificador da thread.');
      // The reserved native ID is trusted only for a complete local announcement
      // that matches this process's canonical workspace exactly.
      const environments = Array.isArray(thread.environments) ? thread.environments : [];
      let localEnvironmentVerified = false;
      if (environments.length === 1 && isRecord(environments[0]) && environments[0].environmentId === 'local') {
        const environment = environments[0];
        const roots = environment.runtimeWorkspaceRoots;
        if (
          typeof environment.cwd === 'string' &&
          Array.isArray(roots) &&
          roots.length === 1 &&
          typeof roots[0] === 'string'
        ) {
          try {
            const announcedCwd = path.resolve(environment.cwd);
            const announcedRoot = path.resolve(roots[0]);
            if (
              announcedCwd === server.cwd &&
              announcedRoot === server.cwd &&
              (await realpath(announcedCwd)) === server.cwd &&
              (await realpath(announcedRoot)) === server.cwd
            )
              localEnvironmentVerified = true;
          } catch {
            /* Unverified environments remain manual. */
          }
        }
      }
      if (signal.aborted) throw abortError(signal);
      return await new Promise<RunResult>((resolve, reject) => {
        const turn: ActiveTurn = {
          input,
          emit,
          server,
          threadId,
          localEnvironmentVerified,
          text: '',
          resolve,
          reject,
          signal,
          interruptSent: false,
          requestInterrupt: () => {
            if (turn.turnId && !turn.interruptSent) {
              turn.interruptSent = true;
              void rpc.request('turn/interrupt', { threadId, turnId: turn.turnId }, 3000).catch(() => undefined);
            }
          },
          abort: () => {
            // The app-server owns the tool executor process tree. Interrupting a
            // turn only changes protocol/UI state; kill and reap this run's private
            // process group before reporting cancellation or removing its scratch.
            void this.cleanupServer(server).then(() =>
              this.finishTurn(turn, { text: turn.text, nativeSessionId: threadId, stopReason: 'cancelled' }),
            );
          },
        };
        this.turns.set(input.runId, turn);
        this.byThread.set(`${server.key}\n${threadId}`, turn);
        signal.addEventListener('abort', turn.abort, { once: true });
        void rpc
          .request(
            'turn/start',
            {
              threadId,
              input: codexTurnInput(boundedPrompt(input), imagePaths),
              cwd: server.cwd,
              model: input.model ?? null,
              ...(input.plan.effort ? { effort: input.plan.effort } : {}),
              approvalPolicy: 'untrusted',
              approvalsReviewer: 'user',
              sandboxPolicy:
                input.sandbox === 'read-only'
                  ? { type: 'readOnly', networkAccess: true }
                  : {
                      type: 'workspaceWrite',
                      writableRoots: [server.cwd, server.scratch],
                      networkAccess: true,
                      excludeTmpdirEnvVar: true,
                      excludeSlashTmp: true,
                    },
            },
            15_000,
          )
          .then((raw) => {
            if (isRecord(raw) && isRecord(raw.turn)) turn.turnId = String(raw.turn.id ?? '');
            if (signal.aborted) turn.requestInterrupt();
          })
          .catch((error) => {
            if (!signal.aborted)
              this.finishTurn(turn, { text: turn.text, stopReason: 'completed' }, new Error(errorMessage(error)));
          });
      });
    } finally {
      if (ownedServer) await this.cleanupServer(ownedServer);
    }
  }
  /**
   * Adds user input to the running turn with app-server `turn/steer` (verified in
   * codex-cli 0.160.0's protocol: threadId, input, expectedTurnId). Coordinated runs
   * use `<runId>:<taskId>`; only a single unambiguous turn is steered.
   */
  async steer(runId: string, content: string): Promise<boolean> {
    const turns = [...this.turns.values()].filter(
      (turn) => (turn.input.runId === runId || turn.input.runId.startsWith(`${runId}:`)) && !turn.signal.aborted,
    );
    if (!turns.length) return false;
    if (turns.length > 1)
      throw new Error('Há mais de uma tarefa do Codex em andamento; não é possível orientar uma só.');
    const turn = turns[0];
    if (!turn.threadId || !turn.turnId) throw new Error('O Codex ainda não iniciou este turno; tente em instantes.');
    const rpc = turn.server.rpc;
    if (!rpc) throw new Error('Codex app-server não está disponível.');
    await rpc.request(
      'turn/steer',
      {
        threadId: turn.threadId,
        expectedTurnId: turn.turnId,
        input: [{ type: 'text', text: content, text_elements: [] }],
      },
      10_000,
    );
    return true;
  }
  async approve(approvalId: string, decision: 'approve' | 'deny') {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error('Aprovação não está mais pendente.');
    const turn = this.turns.get(pending.runId);
    if (pending.method === 'item/permissions/requestApproval') {
      const permissions = decision === 'approve' && turn ? await approvedPermissions(turn, pending.params) : undefined;
      this.assertPending(approvalId, pending, turn);
      if (decision === 'approve' && !permissions)
        throw new Error('Permissão solicitada excede o sandbox; negue a solicitação para continuar.');
      this.approvals.delete(approvalId);
      pending.server.rpc?.respond(pending.requestId, { permissions: permissions ?? {}, scope: 'turn' });
      return;
    }
    if (decision === 'approve' && pending.method === 'item/fileChange/requestApproval') {
      const grant = typeof pending.params.grantRoot === 'string' ? pending.params.grantRoot : undefined;
      const safeGrant = grant && turn ? await canonWritePathWithin(turn.input.cwd, grant) : undefined;
      this.assertPending(approvalId, pending, turn);
      if (
        !turn ||
        turn.input.sandbox === 'read-only' ||
        (!grant && turn.input.sandbox !== 'workspace-write') ||
        (grant && !safeGrant)
      )
        throw new Error('Alteração solicitada excede o sandbox; negue a solicitação para continuar.');
    }
    this.assertPending(approvalId, pending, turn);
    this.approvals.delete(approvalId);
    const commandDecision = decision === 'approve' ? 'accept' : 'decline';
    pending.server.rpc?.respond(pending.requestId, { decision: commandDecision });
  }
  private assertPending(approvalId: string, pending: PendingApproval, turn: ActiveTurn | undefined) {
    if (
      this.approvals.get(approvalId) !== pending ||
      this.turns.get(pending.runId) !== turn ||
      !turn ||
      turn.signal.aborted
    )
      throw new Error('Aprovação não está mais pendente.');
  }
  async shutdown() {
    this.shuttingDown = true;
    const commandShutdown = this.commands.shutdown();
    for (const turn of [...this.turns.values()]) turn.abort();
    const servers = [...this.servers.values()];
    await Promise.all([
      commandShutdown,
      ...servers.map(async (server) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const rpc =
            server.rpc ??
            (await Promise.race([
              server.ready,
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), 2500);
              }),
            ]));
          await rpc?.kill();
        } catch {
          /* Startup failure already settled; no child remains to close. */
        } finally {
          if (timer) clearTimeout(timer);
          if (server.scratch) await this.removeScratch(server.scratch);
        }
      }),
      ...[...this.discoveryProcesses].map((rpc) => rpc.kill()),
    ]);
    this.servers.clear();
    await Promise.all([...this.ownedScratch].map((dir) => this.removeScratch(dir)));
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
