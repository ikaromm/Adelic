import type {
  DelegatedTask,
  Project,
  ProjectBrief,
  ProviderInfo,
  ProviderId,
  TaskDeliveryResult,
} from '../shared/contracts.js';
import { hasFileReference } from './router.js';

export interface PlannedTask {
  id: string;
  title: string;
  instructions: string;
  scope: string[];
  dependsOn: string[];
}

/** Extract only Graphify's canonical source attributes, never node labels or basenames. */
export function graphifyPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/\[([^\]]*?)\]/g)) {
    const source = match[1].match(/(?:^|\s)src=(.*?)(?=\s+[\w.-]+=|$)/)?.[1]?.trim();
    if (
      !source ||
      source.startsWith('/') ||
      source.startsWith('\\') ||
      /^[a-z]:/i.test(source) ||
      source.includes('\\')
    )
      continue;
    const parts = source.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) continue;
    if (!paths.includes(source)) paths.push(source);
    if (paths.length >= 160) break;
  }
  return paths;
}

/** Close only a truncated JSON container at EOF. Strings, malformed tokens and schema errors are never repaired. */
function closeTruncatedJson(text: string): string | undefined {
  if (text.length > 32_000) return undefined;
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return undefined;
    }
  }
  if (quoted || stack.length < 1 || stack.length > 3) return undefined;
  return text.trimEnd() + stack.reverse().join('');
}

/** Validates and bounds the planner's JSON before it can create runtime work. */
export function parseTaskPlan(text: string): PlannedTask[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (parseError) {
    const detail = parseError instanceof Error ? parseError.message.slice(0, 180) : 'JSON inválido';
    const repaired = closeTruncatedJson(text);
    if (!repaired) throw new Error(`O planejador não retornou JSON válido: ${detail}`, { cause: parseError });
    try {
      value = JSON.parse(repaired);
    } catch (repairError) {
      throw new Error(`O planejador truncou JSON em estrutura não recuperável: ${detail}`, { cause: repairError });
    }
  }
  const raw = (value as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(raw)) throw new Error('Plano deve conter uma lista tasks');
  if (raw.length < 1 || raw.length > 6) throw new Error('Plano deve conter de 1 a 6 tarefas');
  const ids = new Set<string>();
  const tasks: PlannedTask[] = raw.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object') throw new Error(`Tarefa ${index + 1} inválida`);
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(t.id) || ids.has(t.id))
      throw new Error(`ID inválido ou repetido na tarefa ${index + 1}`);
    ids.add(t.id);
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 160)
      throw new Error(`Título inválido na tarefa ${index + 1}`);
    if (typeof t.instructions !== 'string' || !t.instructions.trim() || t.instructions.length > 5000)
      throw new Error(`Instruções inválidas na tarefa ${index + 1}`);
    if (!Array.isArray(t.scope) || t.scope.length > 30 || t.scope.some((p) => typeof p !== 'string' || p.length > 300))
      throw new Error(`Escopo inválido na tarefa ${index + 1}`);
    if (!Array.isArray(t.dependsOn) || t.dependsOn.length > 6 || t.dependsOn.some((id) => typeof id !== 'string'))
      throw new Error(`Dependências inválidas na tarefa ${index + 1}`);
    return {
      id: t.id,
      title: t.title.trim(),
      instructions: t.instructions.trim(),
      scope: [...new Set(t.scope as string[])],
      dependsOn: [...new Set(t.dependsOn as string[])],
    };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks)
    for (const dep of task.dependsOn)
      if (!byId.has(dep) || dep === task.id) throw new Error(`Dependência inválida em ${task.id}`);
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('O plano contém dependências cíclicas');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((t) => visit(t.id));
  return tasks;
}

export function resolveAgent(
  info: ProviderInfo[],
  configuredProvider: ProviderId | undefined,
  configuredModel: string | undefined,
  role: 'worker' | 'reviewer',
  fallbackProvider: ProviderId,
  fallbackModel?: string,
) {
  const providerId = configuredProvider || fallbackProvider;
  const provider = info.find((p) => p.id === providerId);
  if (!provider?.available)
    throw new Error(
      `${role === 'worker' ? 'Executor' : 'Revisor'} indisponível: ${provider?.detail || `provedor ${providerId} não disponível`}`,
    );
  const models = provider.models;
  const preferredId = role === 'worker' ? 'gpt-6-luna' : 'gpt-6-sol';
  const preferred =
    configuredModel ||
    (role === 'worker'
      ? models.find((m) => m.id === preferredId)?.id || models.find((m) => /luna/i.test(`${m.id} ${m.name}`))?.id
      : models.find((m) => m.id === preferredId)?.id || models.find((m) => /sol/i.test(`${m.id} ${m.name}`))?.id);
  const model = preferred || (providerId === fallbackProvider ? fallbackModel : undefined) || provider.defaultModel;
  if (model && !provider.models.some((m) => m.id === model || m.name === model))
    throw new Error(`Modelo ${model} não está disponível em ${providerId}`);
  return { providerId, model };
}

export function boundedCoordinatorContext(
  history: { role: string; content: string }[],
  current: string,
  brief: ProjectBrief | null,
  paths: string[],
  maxChars = 7000,
) {
  const recent = history
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(-900)}`)
    .join('\n');
  const map = paths.slice(0, 160).join('\n');
  const briefText = brief
    ? `Resumo persistido: ${brief.summary.slice(0, 1800)}\nObjetivo anterior: ${brief.objective.slice(0, 500)}`
    : '';
  const prefix = `Pedido atual: ${current}`;
  const remainder = Math.max(0, maxChars - prefix.length - 2);
  const supporting = [
    briefText,
    map ? `Mapa de caminhos (índice, não conteúdo):\n${map}` : '',
    recent ? `Mensagens recentes:\n${recent}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, remainder);
  return supporting ? `${prefix}\n\n${supporting}` : prefix;
}

/**
 * Facts observed and persisted by the orchestrator for synthesis. These fields are deliberately
 * separate: a provider process can complete while delivery remains partial or blocked.
 */
export function synthesisExecutionFacts(tasks: DelegatedTask[]): string {
  const facts = tasks.map((task) => ({
    role: task.role,
    title: task.title,
    providerId: task.providerId,
    model: task.model ?? null,
    effort: task.effort ?? null,
    process: {
      status: task.status,
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
      error: task.error ?? null,
    },
    integration: task.integration
      ? {
          status: task.integration.status,
          cleanup: task.integration.cleanup,
          reason: task.integration.reason ?? null,
          recordedAt: task.integration.recordedAt,
        }
      : null,
    delivery: task.delivery
      ? {
          status: task.delivery.status,
          reason: task.delivery.reason,
          evidence: task.delivery.evidence,
          recovery: {
            action: task.delivery.recovery.action,
            reason: task.delivery.recovery.reason,
            available: task.delivery.recovery.action !== 'none',
            retainedWorkspace: Boolean(task.recoveryWorktree),
          },
        }
      : null,
  }));
  return JSON.stringify(facts);
}

/**
 * Keep review findings, not conversational lead-in or progress chatter, in bounded coordinator
 * context. Findings are recognised by explicit severity/issue headings; when the source or the
 * budget cannot be represented completely the returned text says so rather than implying approval.
 */
export function summarizeReview(
  text: string,
  maxChars = 1600,
): { text: string; incomplete: boolean; findings: number } {
  const lines = text.split(/\r?\n/);
  const findingStart =
    /^\s*(?:[-*+]\s+|\d+[.)]\s*)?(?:#{1,6}\s*)?(?:\*\*)?(?:\d+[.)]\s*)?(?:\*\*)?\[?(?:P[0-3]|critical|high|medium|low|bloqueador|blocker|achado|finding|severidade\s*:\s*(?:alta|high))\b/i;
  const starts = lines.map((line, index) => (findingStart.test(line) ? index : -1)).filter((index) => index >= 0);
  if (maxChars <= 0)
    return {
      text: '', // no non-empty warning can fit a zero/negative character budget
      incomplete: true,
      findings: starts.length,
    };
  if (starts.length === 0) {
    const compact = text.trim();
    if (compact.length <= maxChars) return { text: compact, incomplete: false, findings: 0 };
    const marker = 'REVISÃO INCOMPLETA: saída sem achados estruturados foi truncada; não concluir aprovação.';
    return { text: marker.slice(0, maxChars), incomplete: true, findings: 0 };
  }

  const prefixLines = lines
    .slice(0, starts[0])
    .map((line) => line.trim())
    .filter(Boolean);
  const location = /(?:[\w.-]+\/)+[\w.-]+\.[a-z\d]+(?::\d+(?:[-:]\d+)?)?/i;
  const blocks = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const blockLines = lines
      .slice(start, end)
      .map((line) => line.trim())
      .filter(Boolean);
    const locations = blockLines.slice(1).filter((line) => location.test(line));
    const details = blockLines.slice(1).filter((line) => !location.test(line));
    return { anchors: [blockLines[0], ...locations].filter(Boolean), details };
  });
  const findingCount = blocks.length;
  const allLines = [...prefixLines, ...blocks.flatMap((block) => [...block.anchors, ...block.details])];
  const completeText = allLines.join('\n');
  if (completeText.length <= maxChars) return { text: completeText, incomplete: false, findings: findingCount };

  const markerText = ' [REVISÃO INCOMPLETA: achados ou detalhes omitidos pelo limite; não concluir aprovação.]';
  const marker = markerText.slice(0, maxChars);
  let remaining = Math.max(0, maxChars - marker.length);
  const kept: string[] = [];
  const append = (value: string) => {
    if (!value || remaining <= 0) return;
    const separator = kept.length ? '\n' : '';
    const available = Math.max(0, remaining - separator.length);
    if (value.length <= available) {
      kept.push(value);
      remaining -= separator.length + value.length;
    } else {
      const fragment = value.slice(0, Math.max(0, available - 1)).trimEnd();
      if (fragment) kept.push(`${fragment}…`);
      remaining -= separator.length + (fragment ? fragment.length + 1 : 0);
    }
  };

  // Under pressure, unparsed lead-in is dropped rather than crowding out recognized
  // findings. Retain every finding heading and location before explanatory details.
  blocks.forEach((block) => block.anchors.forEach(append));
  blocks.forEach((block) => block.details.forEach(append));
  const content = kept.join('\n');
  return { text: `${content}${marker}`.slice(0, maxChars), incomplete: true, findings: findingCount };
}

export function briefFor(project: Project, objective: string, summary: string, paths: string[]): ProjectBrief {
  const unique = [...new Set(paths)].slice(0, 160);
  const truncated = paths.length > unique.length;
  return {
    projectId: project.id,
    updatedAt: new Date().toISOString(),
    paths: unique,
    truncated,
    objective: objective.slice(0, 1000),
    summary: summary.slice(0, 4000),
  };
}

export function isSimpleInspectionRequest(text: string) {
  const mutating =
    /\b(implemente|implement|crie|create|edite|edit|corrija|fix|altere|change|write|escreva|delete|remova|refatore|refactor|instale|install|rode|run|execute|build|compile|teste|test|deploy)\b/i;
  const inspection =
    /\b(leia|read|abra|open|inspecione|inspect|analise|analyze|explique|explain|resuma|summari[sz]e|summarize)\b/i;
  const file =
    /\b(arquivo|file|projeto|project|c[oó]digo|code|repo|reposit[oó]rio|readme|pasta|directory|m[oó]dulo|module|componente|component)\b/i;
  const complex =
    /\b(v[aá]rios|m[uú]ltiplos|multiple|several|whole|todo o|toda a|arquitetura|architecture|etapas|steps|plano|plan|trade-?off|recomend|recommend)\b|\b(duas|dois|tr[eê]s|quatro|cinco|seis|quarta?|quint[oa]s?|sext[oa]s?|two|three|four|five|six|fourth|fifth|sixth|[2-6])\s+(?:independentes?\s+|independent\s+)?(partes?|tarefas?|etapas?|arquivos?|m[oó]dulos?|parts?|tasks?|stages?|files?|modules?)\b|\b(partes?|tarefas?|etapas?|arquivos?|m[oó]dulos?|parts?|tasks?|stages?|files?|modules?)\s+(independentes?|independent)\b|\bem paralelo\b|\bparallel(?:ly)?\b/i;
  return (
    inspection.test(text) && (file.test(text) || hasFileReference(text)) && !mutating.test(text) && !complex.test(text)
  );
}

/**
 * Classifies delivery from orchestrator-observed process/tool facts. A clean provider stop is
 * deliberately not treated as proof that files changed; successful tool calls still require review.
 */
export function assessTaskDelivery(
  role: DelegatedTask['role'],
  status: DelegatedTask['status'],
  error: string | undefined,
  toolCalls: { name: string; status: string }[],
  changedFiles: string[] = [],
  expectsImplementation = true,
): TaskDeliveryResult {
  const successfulTools = toolCalls.filter((call) => /completed|success|succeeded/i.test(call.status));
  const evidence = [
    `process:${status}`,
    ...toolCalls.map((call) => `tool:${call.name}:${call.status}`),
    ...changedFiles.map((path) => `artifact:${path}`),
  ];
  let delivery: TaskDeliveryResult['status'];
  let reason: string;
  let action: TaskDeliveryResult['recovery']['action'];
  if (status === 'failed' || status === 'interrupted') {
    delivery = 'blocked';
    reason = error || 'A fase terminou sem conclusão do processo.';
    action = 'retry';
  } else if (status === 'cancelled') {
    delivery = toolCalls.length ? 'partial' : 'blocked';
    reason = error || 'A fase foi cancelada antes da confirmação de entrega.';
    action = delivery === 'partial' ? 'inspect' : 'retry';
  } else if (role !== 'worker') {
    delivery = 'unverified';
    reason = 'A fase de coordenação terminou; isso não comprova implementação de uma tarefa de código.';
    action = 'none';
  } else if (!expectsImplementation) {
    delivery = 'unverified';
    reason =
      'O pedido não solicitou alteração de artefatos; a conclusão do processo não é apresentada como implementação.';
    action = 'none';
  } else if (successfulTools.length && changedFiles.length) {
    delivery = 'implemented';
    reason = 'O processo terminou e a comparação dos artefatos observou arquivos alterados.';
    action = 'inspect';
  } else if (!successfulTools.length) {
    delivery = 'not_implemented';
    reason = 'O processo terminou, mas não há chamada de ferramenta bem-sucedida registrada; entrega não implementada.';
    action = 'retry';
  } else {
    delivery = 'unverified';
    reason = 'Há chamadas de ferramenta bem-sucedidas, mas a comparação não confirmou arquivos alterados.';
    action = 'inspect';
  }
  return {
    status: delivery,
    reason,
    evidence,
    recovery: {
      action,
      reason:
        action === 'retry'
          ? 'Reenviar a execução de origem'
          : action === 'inspect'
            ? 'Inspecionar artefatos antes de aceitar'
            : 'Nenhuma ação de recuperação necessária',
    },
    recordedAt: new Date().toISOString(),
  };
}

export function taskRecord(input: Omit<DelegatedTask, 'createdAt' | 'status'>): DelegatedTask {
  return { ...input, status: 'queued', createdAt: new Date().toISOString() };
}
