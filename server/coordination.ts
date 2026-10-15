import type {
  DelegatedTask,
  Project,
  ProjectBrief,
  ProviderInfo,
  ProviderId,
  TaskDeliveryResult,
  CheckSource,
  RunEvent,
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
  // The synthesis call is still running while it receives these facts. Feeding its own
  // transient `running` status back into the final-answer prompt creates a false open item.
  // Its lifecycle remains persisted/observable on the task; omit only self-referential facts.
  const facts = tasks
    .filter((task) => task.role !== 'synthesis')
    .map((task) => ({
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

/** Compact index of checks actually recorded for the run; raw commands and outputs stay out. */
export function synthesisValidationIndex(events: RunEvent[]): string {
  const latest = new Map<string, RunEvent>();
  for (const event of events) {
    if (event.type === 'check') latest.set(event.id, event);
  }
  const checks = [...latest.values()].map((event) => {
    const check = event.check;
    return {
      checkEventId: event.id,
      status: check?.status ?? 'unknown',
      exitCode: check?.exitCode ?? null,
      sourceState: check?.source?.state ?? 'unknown',
      logAvailability: check?.operationalLog?.status ?? 'unknown',
      inlineOutputAvailability: check?.output === undefined ? 'unknown' : check.truncated ? 'truncated' : 'available',
    };
  });
  return JSON.stringify({
    registeredCheckCount: checks.length,
    checks,
    checksListComplete: true,
    validationStatus: checks.length ? 'recorded-results' : 'unknown',
    ...(checks.length
      ? {}
      : {
          absence:
            'No check events were recorded; this does not establish whether validation ran outside Adelic checks.',
          missingLogsRecoverable: false,
        }),
  });
}

export interface StructuredReviewFinding {
  id: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  title: string;
  file: string;
  description: string;
}

export type StructuredReview =
  { status: 'approved'; findings: [] } | { status: 'findings'; findings: StructuredReviewFinding[] };

/** Paths are validated for reporting; write authorization is separately restricted to observed scope. */
export function isSafeReviewPath(path: string): boolean {
  if (
    !path ||
    path.length > 300 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[a-z]:/i.test(path) ||
    path.includes('\\') ||
    /\p{Cc}/u.test(path)
  )
    return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export interface ReviewDecisionInput {
  completed: boolean;
  review?: StructuredReview;
  before?: CheckSource;
  after?: CheckSource;
  checks: { status: string; source?: CheckSource | null }[];
}

/** One state decision shared by approval, correction, and finding-resolution consumers. */
export function decideReview(input: ReviewDecisionInput): {
  valid: boolean;
  identityStable: boolean;
  checksCorrespond: boolean;
  checksPassed: boolean;
  repairEligible: boolean;
  approved: boolean;
  findings: StructuredReviewFinding[];
  reason?: string;
} {
  const findings = input.review?.status === 'findings' ? input.review.findings : [];
  const before = input.before;
  const after = input.after;
  const stableIdentity = Boolean(
    before &&
    after &&
    before.state === 'verified' &&
    after.state === 'verified' &&
    before.runId === after.runId &&
    before.root &&
    before.root === after.root &&
    before.revision?.kind === 'source_tree' &&
    before.revision.value &&
    before.revision.value === after.revision?.value,
  );
  const checksMatch =
    input.checks.length === 0 ||
    (stableIdentity &&
      input.checks.every(
        (check) =>
          check.source?.state === 'verified' &&
          check.source.runId === before?.runId &&
          check.source.root === before?.root &&
          check.source.revision?.value === before?.revision?.value,
      ));
  const checksPassed = input.checks.every((check) => check.status === 'passed');
  const valid = input.completed && Boolean(input.review) && stableIdentity && checksMatch;
  const repairEligible = valid && findings.length > 0;
  return {
    valid,
    identityStable: stableIdentity,
    checksCorrespond: checksMatch,
    checksPassed,
    repairEligible,
    approved: valid && input.review?.status === 'approved' && checksPassed,
    findings,
    ...(!input.completed
      ? { reason: 'review-incomplete' }
      : !input.review
        ? { reason: 'review-contract-invalid' }
        : !stableIdentity
          ? { reason: 'source-identity-unverified-or-changed' }
          : !checksMatch
            ? { reason: 'checks-do-not-match-reviewed-source' }
            : !checksPassed
              ? { reason: 'checks-failed' }
              : {}),
  };
}

/** A review is actionable only as a complete, strictly validated JSON result. */
export function parseStructuredReview(text: string): StructuredReview | undefined {
  if (text.length > 32_000) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['status', 'findings'].includes(key))) return undefined;
  if (!Array.isArray(record.findings) || record.findings.length > 12) return undefined;
  if (record.status === 'approved' && record.findings.length === 0) return { status: 'approved', findings: [] };
  if (record.status !== 'findings' || record.findings.length === 0) return undefined;
  const ids = new Set<string>();
  const findings: StructuredReviewFinding[] = [];
  for (const candidate of record.findings) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const finding = candidate as Record<string, unknown>;
    if (Object.keys(finding).some((key) => !['id', 'severity', 'title', 'file', 'description'].includes(key)))
      return undefined;
    if (
      typeof finding.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(finding.id) ||
      ids.has(finding.id) ||
      typeof finding.severity !== 'string' ||
      !['P0', 'P1', 'P2', 'P3'].includes(finding.severity) ||
      typeof finding.title !== 'string' ||
      !finding.title.trim() ||
      finding.title.length > 180 ||
      typeof finding.file !== 'string' ||
      !isSafeReviewPath(finding.file) ||
      typeof finding.description !== 'string' ||
      !finding.description.trim() ||
      finding.description.length > 1600
    )
      return undefined;
    ids.add(finding.id);
    findings.push({
      id: finding.id,
      severity: finding.severity as StructuredReviewFinding['severity'],
      title: finding.title.trim(),
      file: finding.file,
      description: finding.description.trim(),
    });
  }
  return { status: 'findings', findings };
}

/** Keep the newest check for each configured name+command identity. */
export function latestChecksByIdentity<T extends { name: string; command?: string; createdAt: string }>(
  checks: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const check of checks) {
    const identity = JSON.stringify([check.name, check.command ?? null]);
    const prior = latest.get(identity);
    if (!prior || Date.parse(check.createdAt) >= Date.parse(prior.createdAt)) latest.set(identity, check);
  }
  return [...latest.values()];
}

/**
 * Reduce review text for coordinator context. `incomplete` describes this bounded context only;
 * it says nothing about provider completion or review approval. Full output is persisted on the
 * reviewer task and can be fetched on demand through the task-output endpoint.
 */
export function summarizeReview(
  text: string,
  maxChars = 1600,
  rawReference = 'tarefa de revisão',
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
    // Unstructured reviews are common (including free-form audit reports). Preserve both
    // ends of the source in context rather than replacing a defect at the start with a generic warning.
    const marker = ` … [contexto reduzido; saída completa em ${rawReference}] … `;
    const available = Math.max(0, maxChars - marker.length);
    const headLength = Math.ceil(available / 2);
    const tailLength = Math.floor(available / 2);
    const excerpt = `${text.slice(0, headLength)}${marker.slice(0, Math.max(0, maxChars - headLength - tailLength))}${tailLength ? text.slice(-tailLength) : ''}`;
    return { text: excerpt, incomplete: true, findings: 0 };
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

  const markerText = ` [RESUMO REDUZIDO: achados/detalhes omitidos; saída completa em ${rawReference}.]`;
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
    /\b(implemente|implementar|implement|crie|criar|create|adicione|adicionar|add|acrescente|acrescentar|append|insira|inserir|insert|atualize|atualizar|update|modifique|modificar|modify|substitua|substituir|replace|renomeie|renomear|rename|edite|editar|edit|corrija|corrigir|fix|altere|alterar|change|write|escreva|escrever|delete|remova|remover|remove|apague|apagar|exclua|excluir|refatore|refatorar|refactor|instale|instalar|install|rode|rodar|run|execute|build|compile|teste|testar|test|deploy)\b/i;
  const inspection =
    /\b(leia|read|abra|open|inspecione|inspect|analise|analyze|explique|explain|resuma|summari[sz]e|summarize)\b/i;
  const file =
    /\b(arquivo|file|projeto|project|c[oó]digo|code|repo|reposit[oó]rio|readme|pasta|directory|m[oó]dulo|module|componente|component)\b/i;
  const complex =
    /\b(v[aá]rios|m[uú]ltiplos|multiple|several|whole|todo o|toda a|arquitetura|architecture|etapas|steps|plano|plan|trade-?off|recomend|recommend)\b|\b(duas|dois|tr[eê]s|quatro|cinco|seis|quarta?|quint[oa]s?|sext[oa]s?|two|three|four|five|six|fourth|fifth|sixth|[2-6])\s+(?:independentes?\s+|independent\s+)?(partes?|tarefas?|etapas?|arquivos?|m[oó]dulos?|parts?|tasks?|stages?|files?|modules?)\b|\b(partes?|tarefas?|etapas?|arquivos?|m[oó]dulos?|parts?|tasks?|stages?|files?|modules?)\s+(independentes?|independent)\b|\bem paralelo\b|\bparallel(?:ly)?\b/i;
  // Code identifiers and calls can contain words such as `summarize`, `add`, or
  // `update`; only prose outside code should select the read-only fast path.
  const inspectionRequest = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[$\w]+\s*\([^)]*\)/g, ' ');
  return (
    inspection.test(inspectionRequest) &&
    (file.test(text) || hasFileReference(text)) &&
    !mutating.test(text) &&
    !complex.test(text)
  );
}

/**
 * Conservative lexical fast path for cohesive defect reports, one small change, or an explicit short follow-up.
 * It is not a model classification: broad/multi-area requests keep the planner and Graphify
 * planning pass; the worker still receives only this conversation's bounded context.
 */
export function canSkipCoordinationPlanner(text: string): boolean {
  const request = text.trim();
  // A first-turn defect report can be longer than a small feature request because it
  // includes reproduction steps and expected/actual behavior. Keep that bounded separately.
  if (!request || request.length > 1200) return false;
  // Preservation constraints describe boundaries, not work to decompose. Detect them by
  // meaning-bearing verbs and references to established behavior/rules, not a benchmark phrase.
  const preservationConstraint =
    /^\s*(?:(?:and|while|but)\s+)?(?:(?:please)\s+)?(?:preserv(?:e|ing)|keep(?:ing)?|maintain(?:ing)?|retain(?:ing)?|ensure|without\s+chang(?:e|ing)|do\s+not\s+(?:change|alter|break))\b.*\b(?:existing|current|previous|established|prior|backward[- ]compatible)\b.*\b(?:behavior|behaviour|rules?|semantics?|contract|compatib(?:ility|le)|dependenc(?:y|ies)|funcionalidade|comportamento|regras?|contrato)\b/i;
  const actionableClauses = request
    .split(/[;,.!?\n]+|\b(?:and|while|but)\b|(?=\bwithout\s+chang(?:e|ing)\b)/i)
    .filter((clause) => !preservationConstraint.test(clause));
  const workRequest = actionableClauses.join(' ');
  const complex =
    /\b(multiple|several|independent|across|architecture|architectural|dependency|dependencies|depend[eê]ncia|depend[eê]ncias|workflow|end-to-end|full[- ]stack|multi[- ]step|v[aá]rios|m[uú]ltiplos|etapas|arquitetura|integra[cç][aã]o)\b|\b(?:[2-9]|two|three|four|five|duas|dois|tr[eê]s|quatro)\s+(?:files?|arquivos?|modules?|m[oó]dulos?|tasks?|tarefas?|steps?|etapas?)\b|(?:^|\n)\s*(?:[-*]|\d+[.)])\s/im;
  if (complex.test(workRequest)) return false;
  // Distinct technical domains imply coordination even when the request does not say
  // "multiple modules". This is category-based rather than phrase-specific.
  const workAreas = [
    /\b(ui|user interface|interface|frontend|front[- ]end|client[- ]side|tela|interface do usu[aá]rio)\b/i,
    /\b(database|db|sqlite|schema|migration|migrate|storage|persistence|banco de dados|esquema|migra[cç][aã]o|persist[eê]ncia)\b/i,
    /\b(api|endpoint|backend|back[- ]end|service|servi[cç]o|rota|route)\b/i,
    /\b(authentication|authorization|cache|queue|messaging|autentica[cç][aã]o|autoriza[cç][aã]o|fila)\b/i,
  ];
  if (workAreas.filter((area) => area.test(workRequest)).length > 1) return false;
  // One described defect is usually one cohesive investigation, even when its complete
  // report mentions reproduction, observed behavior, expected behavior, and a regression
  // test. Explicitly plural issues or separately requested features remain planner work.
  const multipleDefects =
    /\b(?:multiple|several|both|two|three|four|v[aá]rios|m[uú]ltiplos|ambos|duas?|dois|tr[eê]s|quatro)\s+(?:bugs?|defects?|regressions?|issues?|failures?|problems?|erros?|defeitos?|falhas?|problemas?)\b/i.test(
      request,
    );
  const separateFeature =
    /\b(?:separate(?:ly)?|unrelated|independent|another feature|additionally|em separado|independente|outro recurso|outra funcionalidade)\b/i.test(
      request,
    ) ||
    /\b(?:and|also|e|tamb[eé]m)\s+(?:add|create|implement|change|update|migrate|build|design|refactor|adicione|crie|implemente|altere|atualize|migre|construa|refatore)\s+(?!(?:a\s+)?(?:(?:regression|unit|integration|regress[aã]o|unit[aá]rio|integra[cç][aã]o)\s+)?tests?\b)/i.test(
      request,
    );
  if (multipleDefects || separateFeature) return false;
  const cohesiveDefect =
    /\b(fix|resolve|correct|repair|address|corrija|conserte|resolva|repare)\b/i.test(workRequest) &&
    /\b(bug|defect|regression|issue|failure|broken|falha|erro|defeito|regress[aã]o)\b/i.test(request);
  if (cohesiveDefect) return true;
  if (request.length > 600) return false;
  const continuation =
    /\b(now|then|also|instead|continue|continuing|continuar|fechar|fechando|corrigir|corrija|corrigindo|fix|fixed|fixing|formatar|formate|formatação|format|formatted|same|that|this|it|keep|make it|additionally|agora|depois|tamb[eé]m|ent[aã]o|mantenha|isso|esse|essa|nele|nela)\b/i.test(
      request,
    );
  const followUp = continuation;
  const smallStandalone =
    request.length <= 260 &&
    /\b(add|implement|create|change|edit|fix|make|persist|filter|toggle|button|setting|field|implemente|crie|altere|edite|corrija|adicione|filtro|persist|bot[aã]o|configura[cç][aã]o)\b/i.test(
      request,
    ) &&
    (/\b(file|arquivo|component|componente|page|p[aá]gina|button|bot[aã]o|filter|filtro|toggle|setting|configura[cç][aã]o|field|campo|modal|dialog|di[aá]logo)\b/i.test(
      request,
    ) ||
      hasFileReference(request));
  return followUp || smallStandalone;
}

/** True when the current request uses a reference whose subject must come from this conversation. */
export function requiresResolvedContinuity(text: string): boolean {
  return /\b(it|this|that|these|those|same|isso|isto|aquilo|esse|essa|esses|essas|nele|nela|now|then|also|instead|continue|continuing|continuar|continuei|continuem|additionally|agora|depois|tamb[eé]m|ent[aã]o|mantenha)\b/i.test(
    text,
  );
}

const technicalWorkIntent =
  /\b(implement|create|change|alter|refactor|migrate|add|build|design|redesign|fix|write|implemente|crie|altere|refatore|migre|adicione|construa|projete|corrija|escreva)\b/i;
const conceptualQuestion =
  /^\s*(?:what|why|how|when|where|who|which|is|are|does|do|can|could|would|will|o que|por que|como|quando|onde|quem|qual|quais|[ée]\s+que|isso\s+|ser[aá]\s+que)\b/i;

/** A plain informational question should not enter delegated software-work phases. */
export function isSimpleConceptualQuestion(text: string): boolean {
  const request = text.trim();
  return request.length <= 240 && conceptualQuestion.test(request) && !technicalWorkIntent.test(request);
}

/** A continuity fallback is justified only by a technical-work ancestor, not a conceptual topic. */
export function hasTechnicalWorkAncestor(history: { role: string; content: string }[], current: string): boolean {
  if (!requiresResolvedContinuity(current)) return false;
  const users = history.slice(-24).filter((message) => message.role === 'user' && message.content.trim());
  for (const message of users.reverse().slice(0, 12)) {
    const turn = message.content.trim();
    if (!requiresResolvedContinuity(turn)) return technicalWorkIntent.test(turn) && !isSimpleConceptualQuestion(turn);
  }
  return false;
}

/**
 * Resolve only a recent user-authored goal from this conversation. The user request is the
 * source of intent; assistant prose is never treated as authority, and the excerpt is bounded.
 */
export function minimalContinuationContext(
  history: { role: string; content: string }[],
  current: string,
): string | undefined {
  if (!requiresResolvedContinuity(current)) return undefined;

  // Follow references across successive user turns, but never use assistant prose as intent.
  // A few bounded user turns preserve the original goal plus refinements without replaying
  // long answers or the full transcript.
  const userTurns = history.slice(-24).filter((message) => message.role === 'user' && message.content.trim());
  const chain: string[] = [current.trim()];
  let root: string | undefined;
  for (const message of userTurns.reverse().slice(0, 12)) {
    const turn = message.content.trim();
    if (requiresResolvedContinuity(turn)) {
      if (chain.length >= 4) return undefined;
      chain.push(turn);
      continue;
    }
    root = turn;
    break;
  }
  if (!root) return undefined;
  const currentFiles = [...chain.join(' ').matchAll(/\b[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|sql)\b/gi)].map(
    (match) => match[0].toLowerCase(),
  );
  const intent = root;
  if (currentFiles.length && !currentFiles.some((file) => root!.toLowerCase().includes(file))) return undefined;
  if (
    !/\b(implement|create|change|add|edit|fix|migrate|write|build|implemente|crie|altere|adicione|edite|corrija|migre|escreva)\b/i.test(
      intent,
    )
  )
    return undefined;
  // Broad roots or an intermediate expansion cannot be collapsed to one worker.
  // Check the full chain before composing it; never silently cut a requirement.
  const refinements = chain.slice(1).reverse();
  const completeChain = [intent, ...refinements].join(' → ');
  if (
    completeChain.length > 1200 ||
    !canSkipCoordinationPlanner(current) ||
    !canSkipCoordinationPlanner(intent) ||
    refinements.some((turn) => !canSkipCoordinationPlanner(turn)) ||
    !canSkipCoordinationPlanner(completeChain)
  )
    return undefined;
  return `Intenção mínima resolvida da mesma conversa (mensagens do usuário): ${completeChain}`;
}

/**
 * Preserve the complete bounded chain of user-authored follow-ups, including broad refinements
 * that deliberately require planning. Assistant replies are excluded so verbose answers cannot
 * evict the original goal from planner/executor context.
 */
export function boundedContinuationContext(
  history: { role: string; content: string }[],
  current: string,
  maxChars = 3000,
): string | undefined {
  if (!requiresResolvedContinuity(current)) return undefined;

  const userTurns = history
    .slice(-24)
    .filter((message) => message.role === 'user' && message.content.trim())
    .slice(-12);
  const reversedChain = [current.trim()];
  let foundRoot = false;
  for (const message of userTurns.reverse()) {
    const turn = message.content.trim();
    reversedChain.push(turn);
    if (!requiresResolvedContinuity(turn)) {
      foundRoot = true;
      break;
    }
  }
  if (!foundRoot) return undefined;

  const chain = reversedChain.reverse();
  const completeChain = chain.join(' → ');
  // Never silently truncate an instruction-bearing user turn.
  if (completeChain.length > maxChars) return undefined;
  return `Contexto ancestral limitado (mensagens do usuário, da raiz ao pedido atual): ${completeChain}`;
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
