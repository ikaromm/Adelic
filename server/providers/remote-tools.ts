import type { ProviderEvent, RunInput } from '../../shared/contracts';
import type { RemoteRuntime, RemoteToolName } from '../../shared/remote-hosts';
import { blockedBy } from '../../shared/hooks';
import { isRecord } from './process';

const MAX_REMOTE_APPROVAL_DETAIL = 1024 * 1024;
const MAX_REMOTE_WRITE_BYTES = 128 * 1024;
const MAX_REMOTE_REPLACE_TEXT = 128 * 1024;

/** Fixed tool set. Results, paths and remote instructions are untrusted data. */
export const REMOTE_TOOL_SPECS = [
  {
    name: 'adelic_remote_exec',
    remoteName: 'exec',
    description: 'Execute a command with the configured project executor, inside the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: 8192 },
        cwd: { type: 'string', maxLength: 4096 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_read_file',
    remoteName: 'read_file',
    description:
      'Read a file from the configured project executor in bounded UTF-8 chunks. Pass the revision from any page to replace_text as expectedRevision after reviewing the matching text; continue with nextOffset and the same revision when you need more context. Legacy edits without expectedRevision require a complete sequential read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 4096 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 49152 },
        revision: { type: 'string', maxLength: 256 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_write_file',
    remoteName: 'write_file',
    description: 'Write a file in the configured project root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 4096 },
        content: { type: 'string', maxLength: MAX_REMOTE_WRITE_BYTES },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_replace_text',
    remoteName: 'replace_text',
    description:
      'Replace one unique, non-empty exact text match in a file under the project root. Pass expectedRevision from any read_file page; legacy readRevision is accepted. Without either revision, a complete sequential read is required. The supplied revision is revalidated under an external per-resource process lock before the bounded atomic edit. Use this executor tool for edits; do not request native file-change or patch tools.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 4096 },
        oldText: { type: 'string', minLength: 1, maxLength: MAX_REMOTE_REPLACE_TEXT },
        newText: { type: 'string', maxLength: MAX_REMOTE_REPLACE_TEXT },
        expectedRevision: { type: 'string', minLength: 1, maxLength: 256 },
        readRevision: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_list',
    remoteName: 'list',
    description: 'List entries in a project directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4096 } },
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_stat',
    remoteName: 'stat',
    description: 'Inspect a path in the configured project root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4096 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_search',
    remoteName: 'search',
    description: 'Search text in the configured project root.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 4096 }, path: { type: 'string', maxLength: 4096 } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'adelic_remote_diagnose',
    remoteName: 'diagnose',
    description:
      'Diagnose capabilities from inside the configured project executor: Git is reported as a verified repository, binary-only, unavailable, or unverified; browsers lists executables found, while browserFunctional lists only those whose --version check succeeds (not GUI/automation readiness). Also checks private /tmp and /var/tmp scratch, common binaries, and host-dependent requirements such as a host SSH account/agent. Read-only; does not install tools or inspect secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'adelic_remote_git',
    remoteName: 'git',
    description: 'Read repository status and diff information from the configured project executor.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string', enum: ['status', 'diff', 'log'] },
          maxItems: 1,
        },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
] as const satisfies readonly {
  name: string;
  remoteName: RemoteToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}[];

export type RemoteToolSpec = (typeof REMOTE_TOOL_SPECS)[number];

export function remoteToolByName(name: unknown): RemoteToolSpec | undefined {
  return typeof name === 'string' ? REMOTE_TOOL_SPECS.find((tool) => tool.name === name) : undefined;
}

/** Derive permission guidance only from the effective run; never imply capabilities universally. */
export function executorContextInstructions(
  input: Pick<RunInput, 'executorContext' | 'providerId' | 'sandbox' | 'remote' | 'approvalMode' | 'plan'>,
): string {
  const context = input.executorContext;
  const executor = input.remote;
  if (!context && !executor) return '';
  const remoteToolsEnabled = Boolean(executor && input.plan.tools);
  const profile = !input.plan.tools
    ? 'sem ferramentas'
    : executor
      ? 'executor de projeto'
      : input.providerId === 'codex'
        ? input.plan.level === 'fast'
          ? 'ferramentas locais rápidas'
          : 'ferramentas nativas'
        : `ferramentas nativas de ${input.providerId}`;
  const git = executor
    ? 'A capacidade Git do checkout principal não é herdada: verifique-a neste executor/worktree antes de assumir que está disponível.'
    : context?.git === 'available'
      ? 'Git foi verificado como acessível neste projeto.'
      : context?.git === 'unavailable'
        ? 'Git não está disponível neste executor; não execute comandos Git.'
        : 'A disponibilidade/acessibilidade de Git não foi verificada.';
  const checks = [
    ...new Set(
      (context?.checks ?? [])
        .filter((check) => typeof check === 'string' && check.trim())
        .map((check) => check.trim().slice(0, 120)),
    ),
  ].slice(0, 6);
  const permissions = remoteToolsEnabled
    ? input.sandbox === 'read-only'
      ? 'O executor configurado está em modo somente leitura: use ferramentas apenas para inspeção; operações mutantes serão recusadas.'
      : 'O executor configurado está em workspace-write: operações mutantes no projeto são permitidas dentro do escopo do executor.'
    : executor
      ? 'O executor está configurado, mas as ferramentas estão desativadas neste run; não solicite seu uso.'
      : 'Não há executor de projeto configurado neste run.';
  const native =
    input.providerId === 'codex' && remoteToolsEnabled
      ? ' Neste perfil Codex de executor, mantenha as ferramentas nativas Codex em read-only; use somente o executor para acessar o projeto.'
      : '';
  const approval = input.approvalMode
    ? ` Modo de aprovação efetivo: ${input.approvalMode}; aprovação não amplia as permissões do sandbox.`
    : '';
  const scratch =
    executor?.executionKind === 'isolated-local'
      ? ' /tmp e /var/tmp são scratch privados deste executor; testes que exigem conta SSH/agente ainda dependem do host, e isso não disponibiliza os diretórios temporários do host.'
      : '';
  return `Perfil efetivo: ${profile}. ${permissions}${native}${approval} ${git}${scratch}${checks.length ? ` Verificações conhecidas: ${checks.join(', ')}. Execute somente verificações relevantes; testes dependentes do host, browser/GUI ou serviços externos podem não funcionar no executor.` : ''} Diagnostique o executor antes de repetir testes inviáveis. Não instale ferramentas nem leia segredos.`;
}

/** Reject malformed or oversized model arguments before asking for approval. */
export function validateRemoteArguments(spec: RemoteToolSpec, raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const args = raw;
  const string = (key: string, max: number, required = false) => {
    const value = args[key];
    return required
      ? typeof value === 'string' && value.length <= max
      : value === undefined || (typeof value === 'string' && value.length <= max);
  };
  const exactKeys = (allowed: string[]) => Object.keys(args).every((key) => allowed.includes(key));
  switch (spec.remoteName) {
    case 'exec':
      return exactKeys(['command', 'cwd', 'timeoutMs']) &&
        string('command', 8192, true) &&
        string('cwd', 4096) &&
        (args.timeoutMs === undefined ||
          (Number.isInteger(args.timeoutMs) && Number(args.timeoutMs) >= 1 && Number(args.timeoutMs) <= 300_000))
        ? args
        : undefined;
    case 'read_file':
      return exactKeys(['path', 'offset', 'limit', 'revision']) &&
        string('path', 4096, true) &&
        (args.offset === undefined || (Number.isSafeInteger(args.offset) && Number(args.offset) >= 0)) &&
        (args.limit === undefined ||
          (Number.isInteger(args.limit) && Number(args.limit) >= 1 && Number(args.limit) <= 49152)) &&
        (args.revision === undefined || (typeof args.revision === 'string' && args.revision.length <= 256))
        ? args
        : undefined;
    case 'stat':
      return exactKeys(['path']) && string('path', 4096, true) ? args : undefined;
    case 'write_file':
      return exactKeys(['path', 'content']) &&
        string('path', 4096, true) &&
        string('content', MAX_REMOTE_WRITE_BYTES, true) &&
        Buffer.byteLength(args.content as string, 'utf8') <= MAX_REMOTE_WRITE_BYTES
        ? args
        : undefined;
    case 'replace_text':
      return exactKeys(['path', 'oldText', 'newText', 'expectedRevision', 'readRevision']) &&
        string('path', 4096, true) &&
        string('oldText', MAX_REMOTE_REPLACE_TEXT, true) &&
        (args.oldText as string).length > 0 &&
        string('newText', MAX_REMOTE_REPLACE_TEXT, true) &&
        (args.expectedRevision === undefined ||
          (typeof args.expectedRevision === 'string' &&
            args.expectedRevision.length > 0 &&
            args.expectedRevision.length <= 256)) &&
        (args.readRevision === undefined ||
          (typeof args.readRevision === 'string' && args.readRevision.length > 0 && args.readRevision.length <= 256)) &&
        (args.expectedRevision === undefined ||
          args.readRevision === undefined ||
          args.expectedRevision === args.readRevision) &&
        Buffer.byteLength(args.oldText as string, 'utf8') <= MAX_REMOTE_REPLACE_TEXT &&
        Buffer.byteLength(args.newText as string, 'utf8') <= MAX_REMOTE_REPLACE_TEXT
        ? args
        : undefined;
    case 'list':
      return exactKeys(['path']) && string('path', 4096) ? args : undefined;
    case 'search':
      return exactKeys(['query', 'path']) && string('query', 4096, true) && string('path', 4096) ? args : undefined;
    case 'diagnose':
      return exactKeys([]) ? args : undefined;
    case 'git':
      return exactKeys(['args']) &&
        Array.isArray(args.args) &&
        args.args.length === 1 &&
        args.args.every((arg) => ['status', 'diff', 'log'].includes(String(arg)))
        ? args
        : undefined;
  }
}

/** Complete, bounded approval copy; oversized content is refused rather than hidden. */
export function remoteApprovalDetail(runtime: RemoteRuntime, spec: RemoteToolSpec, args: Record<string, unknown>) {
  const local = runtime.executionKind === 'isolated-local';
  const detail = `${local ? 'Executor local isolado' : `Host: ${runtime.label}`}\n${local ? 'Diretório do projeto' : 'Diretório remoto'}: ${runtime.root}\nFerramenta: ${spec.remoteName}\nArgumentos: ${JSON.stringify(args)}`;
  return detail.length <= MAX_REMOTE_APPROVAL_DETAIL ? detail : undefined;
}

export function remoteToolTitle(spec: RemoteToolSpec, runtime?: RemoteRuntime) {
  return `${runtime?.executionKind === 'isolated-local' ? 'Executar ferramenta local isolada' : 'Permitir ferramenta remota'}: ${spec.remoteName}`;
}

const MAX_TOOL_EVENT_DETAIL = 280;

function compactToolText(value: unknown, maxLength = 180) {
  if (typeof value !== 'string') return '';
  const compact = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!compact) return '';
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

/** Describe the operation first, then its runtime, so an activity row identifies the work. */
export function remoteToolDescription(
  runtime: RemoteRuntime,
  spec: RemoteToolSpec,
  args: Record<string, unknown>,
  failure?: string,
) {
  const path = typeof args.path === 'string' && args.path ? args.path : '.';
  let operation: string;
  switch (spec.remoteName) {
    case 'exec':
      operation = `exec: ${compactToolText(args.command) || 'comando'}`;
      break;
    case 'read_file':
      operation = `read_file: ${compactToolText(path)}`;
      break;
    case 'write_file':
      operation = `write_file: ${compactToolText(path)}`;
      break;
    case 'replace_text':
      operation = `replace_text: ${compactToolText(path)}`;
      break;
    case 'list':
      operation = `list: ${compactToolText(path)}`;
      break;
    case 'stat':
      operation = `stat: ${compactToolText(path)}`;
      break;
    case 'search':
      operation = `search: ${compactToolText(args.query, 100)} em ${compactToolText(path)}`;
      break;
    case 'diagnose':
      operation = 'diagnose executor capabilities';
      break;
    case 'git':
      operation = `git ${Array.isArray(args.args) ? compactToolText(args.args[0]) : ''}`.trim();
      break;
  }
  const context = runtime.executionKind === 'isolated-local' ? 'Executor local isolado' : `Host ${runtime.label}`;
  const suffix = failure ? `\n${compactToolText(failure, 80)}` : '';
  const runtimeLine = compactToolText(`${context}: ${runtime.root}`, 110);
  const remaining = MAX_TOOL_EVENT_DETAIL - runtimeLine.length - suffix.length - 2;
  const safeOperation =
    operation.length <= remaining ? operation : `${operation.slice(0, Math.max(1, remaining - 1))}…`;
  return `${safeOperation}\n${runtimeLine}${suffix}`;
}

/** A nonzero command result is a failed operation even though it remains a valid RPC result. */
export function remoteToolFailure(result: unknown): string | undefined {
  if (isRecord(result) && result.error === 'tool result exceeds model transport limit')
    return 'Resultado excedeu o limite do transporte; reduza limit/escopo e retome com nextOffset e revision.';
  if (!isRecord(result) || !Number.isInteger(result.exitCode) || result.exitCode === 0) return undefined;
  return `Falhou (código ${String(result.exitCode)})`;
}

export function remoteToolError(error: unknown) {
  const record = isRecord(error) ? error : undefined;
  // Only expose a bounded, allowlisted OS error code in the activity feed; never echo the
  // exception text here because executor errors can contain command arguments or credentials.
  const rawCode = typeof record?.code === 'string' ? record.code : '';
  const knownCodes = [
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ENOENT',
    'ENOTDIR',
    'EACCES',
    'EPERM',
    'EEXIST',
    'ENOTEMPTY',
  ];
  const code = knownCodes.includes(rawCode) ? rawCode : '';
  const rawStatus = record?.status;
  const status =
    typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : undefined;
  const rawCategory = typeof record?.category === 'string' ? record.category : '';
  const category =
    ['timeout', 'not_found', 'permission', 'invalid_request', 'conflict', 'executor'].find(
      (item) => item === rawCategory,
    ) || '';
  const safeDiagnostic = error instanceof Error ? error.message : '';
  if (safeDiagnostic === 'command cancelled') return 'Cancelado';
  if (category === 'timeout') return 'Tempo limite; reduza escopo ou aumente timeoutMs.';
  if (category === 'not_found' && safeDiagnostic === 'parent directory does not exist')
    return 'Pasta pai não encontrada; crie ou selecione uma pasta existente antes de editar.';
  if (category === 'not_found') return 'Não encontrado; confira o caminho e use stat/list antes de tentar novamente.';
  if (category === 'permission') return 'Permissão negada; confira acesso ao caminho antes de repetir.';
  if (category === 'invalid_request' && safeDiagnostic === 'file exceeds read limit')
    return 'Arquivo acima do limite de leitura; use read_file com offset/limit e continue até truncated=false.';
  if (category === 'invalid_request' && safeDiagnostic === 'offset exceeds file size')
    return 'Offset fora do arquivo; consulte stat ou reinicie a leitura a partir de offset 0.';
  if (category === 'invalid_request' && safeDiagnostic === 'offset is not a UTF-8 boundary')
    return 'Offset não coincide com limite UTF-8; retome exatamente pelo nextOffset retornado.';
  if (category === 'invalid_request' && safeDiagnostic === 'read limit is too small for a UTF-8 character')
    return 'Limite curto demais para um caractere UTF-8; aumente limit e reinicie a página.';
  if (category === 'invalid_request' && safeDiagnostic === 'file is not valid UTF-8')
    return 'Arquivo não é UTF-8 válido; confirme o formato antes de ler ou editar.';
  if (category === 'conflict' && safeDiagnostic === 'file must be read completely before replace_text')
    return 'Para editar apenas o trecho revisado, leia essa página e passe sua revision como expectedRevision; só chamadas legadas sem revisão exigem leitura sequencial até truncated=false.';
  if (category === 'conflict' && safeDiagnostic === 'file changed before edit')
    return 'O arquivo mudou desde a leitura; use uma revision atual de read_file e revise o trecho antes de repetir.';
  if (category === 'conflict' && safeDiagnostic === 'file changed while reading')
    return 'O arquivo mudou durante a leitura; reinicie a leitura em offset 0.';
  if (category === 'invalid_request' && safeDiagnostic === 'file exceeds edit limit')
    return 'Arquivo acima do limite de edição de 32 MiB; reduza o escopo ou divida a alteração.';
  if (
    safeDiagnostic.toLowerCase().includes('somente leitura') ||
    safeDiagnostic.toLowerCase().includes('read-only') ||
    safeDiagnostic.toLowerCase().includes('read only')
  )
    return 'Recusado pela política somente leitura do executor; a operação não é permitida neste modo. Não tente repeti-la nem alterar argumentos para contornar a política.';
  if (status === 409)
    return 'Operação recusada por política do executor (HTTP 409); não repita a chamada nem tente corrigir argumentos para contornar a recusa.';
  if (category === 'invalid_request') return 'Argumentos inválidos; corrija os argumentos e tente novamente.';
  if (category === 'conflict' && safeDiagnostic === 'oldText must match exactly once')
    return 'Trecho de substituição ausente ou duplicado; releia o estado atual e escolha um trecho único.';
  if (category === 'conflict') return 'Conflito; leia o estado atual antes de repetir.';
  if (category === 'executor') return 'Falha interna do executor; verifique a configuração antes de repetir.';
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'AbortError' || name === 'CanceledError' || /\babort(ed)?\b|\bcancel(l)?ed\b/i.test(message))
    return 'Cancelado';
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(message))
    return 'Tempo limite; reduza escopo ou aumente timeoutMs.';
  if (
    /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/.test(code) ||
    /ssh|connection|conexão/i.test(message)
  )
    return 'Conexão ' + (code || 'indisponível') + '; confira host, porta e executor.';
  if (/^(ENOENT|ENOTDIR)$/.test(code)) return 'Não encontrado (' + code + '); confira caminho/ferramenta instalada.';
  if (/^(EACCES|EPERM)$/.test(code)) return 'Permissão negada (' + code + '); confira acesso ao caminho.';
  if (/^(EEXIST|ENOTEMPTY)$/.test(code))
    return 'Destino existe (' + code + '); escolha outro caminho ou leia o estado atual.';
  if (status === 429) return 'Limite HTTP 429; aguarde e reduza a frequência das tentativas.';
  if (status === 401 || status === 403)
    return 'Acesso HTTP ' + status + '; confirme a autenticação/configuração do executor.';
  if (status && status >= 400 && status < 500)
    return 'Requisição HTTP ' + status + '; corrija os argumentos ou caminho.';
  if (status && status >= 500) return 'Executor HTTP ' + status + '; aguarde e tente novamente uma vez.';
  return code
    ? 'Falha (' + code + '); ajuste argumentos, caminho ou permissões antes de repetir.'
    : 'Falha no executor; altere argumentos/caminho antes de tentar novamente.';
}

/** Return the command used by the exec tool, if this is an executable request. */
export function remoteToolCommand(spec: RemoteToolSpec, args: Record<string, unknown>) {
  return spec.remoteName === 'exec' && typeof args.command === 'string' ? args.command : undefined;
}

/** Project command blocks apply to fixed remote tools in every approval mode and runtime. */
export function blockedRemoteTool(input: RunInput, spec: RemoteToolSpec, args: Record<string, unknown>) {
  const command = remoteToolCommand(spec, args);
  const blocked = blockedBy(input.blockedCommands, command);
  return blocked && command !== undefined ? { command, blocked } : undefined;
}

/** Emit without the normal 1200-character local approval summary cap. */
export function emitRemoteApproval(
  input: RunInput,
  emit: (event: ProviderEvent) => void,
  id: string,
  spec: RemoteToolSpec,
  detail: string,
  status: 'pending' | 'approved' | 'denied' = 'pending',
  args?: Record<string, unknown>,
  blocked?: { command: string; blocked: string },
) {
  const command = blocked?.command ?? (status === 'pending' && args ? remoteToolCommand(spec, args) : undefined);
  const auditDetail =
    status !== 'pending'
      ? detail.replace(/\nArgumentos: [\s\S]*/, '\nArgumentos: [redigidos no registro automático]')
      : detail;
  emit({
    type: 'approval',
    approval: {
      id,
      runId: input.runId,
      sessionId: input.sessionId,
      title: blocked ? 'Comando bloqueado pelas regras do projeto' : remoteToolTitle(spec, input.remote),
      detail: auditDetail,
      kind: 'tool',
      status,
      ...(blocked
        ? {
            command: blocked.command,
            blocked: blocked.blocked,
            decision: { source: 'project-rule' as const, rule: 'blocked-command' },
          }
        : {}),
      ...(command ? { command } : {}),
      ...(status === 'approved'
        ? {
            decision: {
              source: 'automatic' as const,
              rule:
                input.remote?.executionKind === 'isolated-local'
                  ? 'isolated-local-executor'
                  : 'explicit-remote-project-opt-in',
            },
          }
        : {}),
    },
  });
}

const MAX_REMOTE_RESULT_BYTES = 512 * 1024;

/** Preserve a complete tool result or return a parseable, actionable transport error. */
export function boundedRemoteResult(value: unknown, maxBytes = MAX_REMOTE_RESULT_BYTES) {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return serialized;
  return JSON.stringify({
    error: 'tool result exceeds model transport limit',
    resultBytes: bytes,
    maxResultBytes: maxBytes,
    recovery:
      'For read_file, request a smaller limit (for example 16384 bytes) and resume at the returned nextOffset with the same revision. For other tools, narrow the path, query, or command output.',
  });
}
