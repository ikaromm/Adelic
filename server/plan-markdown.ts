import { randomUUID } from 'node:crypto';
import type { Plan, PlanTask } from '../shared/contracts.js';

// Plan mode (docs/specs/plan-mode.md): the planning prompt, the Markdown parser for the
// spec it produces, and the prompt of each task run. Pure functions, no I/O.

/** Starts every planning prompt; the E2E scripted provider recognises it. */
export const PLAN_PROMPT_MARKER = '[Modo de planejamento do Adelic]';
/** Starts every task prompt of an approved plan. */
export const TASK_PROMPT_MARKER = '[Execução de plano aprovado]';
const PLAN_PREFIX = /^\/plano(?=\s|$)/i;
const MAX_TASKS = 50;
const MAX_TASK_TEXT = 500;
const MAX_DETAILS = 2000;
const MAX_PLAN_IN_PROMPT = 12000;

/** A message starting with `/plano ` runs in plan mode once; returns the request without the prefix. */
export function planCommand(content: string): string | undefined {
  const trimmed = content.trimStart();
  return PLAN_PREFIX.test(trimmed) ? trimmed.replace(PLAN_PREFIX, '').trim() : undefined;
}

export function buildPlanningPrompt(request: string) {
  return [
    PLAN_PROMPT_MARKER,
    'Você está planejando, não executando. Não altere arquivos, não crie arquivos e não execute comandos que modifiquem algo. Leia apenas o necessário do projeto para entender o pedido e confirme o código antes de citá-lo.',
    'Responda somente com uma especificação em Markdown, em português do Brasil, com exatamente estas três seções, nesta ordem:',
    '## Requisitos\nLista numerada (1., 2., …) de requisitos testáveis: cada um diz um comportamento observável.',
    '## Design\nAbordagem escolhida, decisões e riscos, e a lista de arquivos que serão criados ou alterados.',
    '## Tarefas\nChecklist em ordem de execução, um item por linha no formato `- [ ] …`. Cada tarefa deve ser pequena, executável sozinha e verificável (diga como verificar). Não inclua tarefas já feitas.',
    'Antes da primeira seção, escreva no máximo um título `# …`. Não escreva nada depois da seção Tarefas.',
    `Pedido do usuário:\n${request}`,
  ].join('\n\n');
}

type Section = 'requirements' | 'design' | 'tasks';
interface Heading {
  line: number;
  /** 1–6 for `#` headings; 7 for a bold or `Nome:` line. */
  level: number;
  text: string;
  section?: Section;
}

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Which plan section a heading names, ignoring numbering, punctuation, emoji and accents. */
export function sectionOf(heading: string): Section | undefined {
  const name = fold(heading)
    .replace(/[*_`]/g, '')
    .replace(/^[^\p{L}]*/u, '')
    .replace(/^(secao|parte|etapa|section)\s+[\divx]+\s*[-:.–—)]?\s*/, '')
    .trim();
  if (/^(requisitos|requirements|requisitos funcionais|criterios de aceitacao)\b/.test(name)) return 'requirements';
  if (/^(design|desenho|abordagem|arquitetura|solucao|approach)\b/.test(name)) return 'design';
  if (/^(tarefas|tasks|lista de tarefas|plano de tarefas|checklist|passos|todo)\b/.test(name)) return 'tasks';
  return undefined;
}

function headingAt(line: string, index: number): Heading | undefined {
  const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (atx) return { line: index, level: atx[1].length, text: atx[2], section: sectionOf(atx[2]) };
  // "**Requisitos**" or "Requisitos:" alone on a line counts only when it names a section.
  const trimmed = line.trim();
  const bold = /^(\*\*|__)(.{1,60}?)\1\s*:?$/.exec(trimmed);
  const label = bold ? bold[2] : /^([^\s#*_-][^:]{0,60}):$/.exec(trimmed)?.[1];
  if (label) {
    const text = label.replace(/:\s*$/, '').trim();
    const section = sectionOf(text);
    if (section) return { line: index, level: 7, text, section };
  }
  return undefined;
}

/** Drops a ```markdown fence around the whole answer, which some models add. */
function unwrapFence(text: string) {
  const match = /^\s*(`{3,}|~{3,})[\w-]*\n([\s\S]*?)\n\1\s*$/.exec(text);
  return match ? match[2] : text;
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(?:\[([ xX~-])\]\s*)?(.*)$/;
const CHECKBOX_ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+\[[ xX~-]\]\s*(.*)$/;
const width = (indent: string) => indent.replace(/\t/g, '    ').length;

/**
 * Top-level list items of `lines` as tasks. Lines indented under an item (nested lists,
 * continuation text) become its `details`. `checkboxesOnly` keeps only `- [ ]` items.
 */
export function parseTaskList(lines: string[], checkboxesOnly = false): Omit<PlanTask, 'id' | 'status'>[] {
  const pattern = checkboxesOnly ? CHECKBOX_ITEM : LIST_ITEM;
  const items = lines.map((line) => pattern.exec(line));
  const indents = items.filter((m): m is RegExpExecArray => Boolean(m)).map((m) => width(m[1]));
  if (!indents.length) return [];
  const top = Math.min(...indents);
  const tasks: { text: string; details: string[] }[] = [];
  let current: { text: string; details: string[] } | undefined;
  lines.forEach((line, index) => {
    const match = items[index];
    if (match && width(match[1]) === top) {
      const text = (checkboxesOnly ? match[2] : match[3]).trim();
      current = text ? { text, details: [] } : undefined;
      if (current) tasks.push(current);
      return;
    }
    if (!current) return;
    const indent = width(/^\s*/.exec(line)![0]);
    if (!line.trim()) current.details.push('');
    else if (indent > top) current.details.push(line);
    else current = undefined; // A paragraph back at the list's level ends the item.
  });
  return tasks.slice(0, MAX_TASKS).map(({ text, details }) => {
    while (details.length && !details.at(-1)!.trim()) details.pop();
    const shared = Math.min(...details.filter((l) => l.trim()).map((l) => width(/^\s*/.exec(l)![0])));
    const body = details
      .map((l) => (l.trim() ? l.replace(/\t/g, '    ').slice(shared) : ''))
      .join('\n')
      .trim()
      .slice(0, MAX_DETAILS);
    return { text: text.slice(0, MAX_TASK_TEXT), ...(body ? { details: body } : {}) };
  });
}

export interface ParsedPlan {
  title?: string;
  requirements: string;
  design: string;
  tasks: Omit<PlanTask, 'id' | 'status'>[];
  /** False when no section heading was recognised (the whole text became the design). */
  structured: boolean;
}

/**
 * Parses the spec. Sections are found by heading name ("## Requisitos", "### 2. Design",
 * "**Tarefas**", "Tasks:"); a section ends at the next section heading or at a heading of
 * the same or a higher level. Without any section the whole text is the design and only
 * checkbox items count as tasks.
 */
export function parsePlanMarkdown(markdown: string): ParsedPlan {
  const text = unwrapFence(markdown.replace(/\r\n?/g, '\n')).trim();
  const lines = text.split('\n');
  const headings: Heading[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence[0]))) fence = fence ? undefined : marker;
    if (fence && !marker) return;
    if (marker) return;
    const heading = headingAt(line, index);
    if (heading) headings.push(heading);
  });
  const title = headings
    .find((h) => h.level === 1 && !h.section)
    ?.text.replace(/[*_`]/g, '')
    .trim();
  const sections = headings.filter((h) => h.section);
  if (!sections.length) {
    return {
      ...(title ? { title } : {}),
      requirements: '',
      design: text,
      tasks: parseTaskList(lines, true),
      structured: false,
    };
  }
  const body = (section: Section) => {
    const start = sections.find((h) => h.section === section);
    if (!start) return undefined;
    const end = headings.find(
      (h) =>
        h.line > start.line && (h.section ? h.section !== section || h.level <= start.level : h.level <= start.level),
    );
    return lines.slice(start.line + 1, end?.line ?? lines.length);
  };
  const tasksLines = body('tasks');
  return {
    ...(title ? { title } : {}),
    requirements: (body('requirements') ?? []).join('\n').trim(),
    design: (body('design') ?? []).join('\n').trim(),
    tasks: tasksLines ? parseTaskList(tasksLines) : [],
    structured: true,
  };
}

const sameText = (a: string, b: string) => fold(a).replace(/\s+/g, ' ').trim() === fold(b).replace(/\s+/g, ' ').trim();

/**
 * Tasks for re-parsed Markdown. A task whose text did not change keeps its id, status and
 * run, so editing a plan never forgets what already ran; new tasks start pending.
 */
export function mergeTasks(previous: PlanTask[], parsed: ParsedPlan['tasks']): PlanTask[] {
  const unused = [...previous];
  return parsed.map((task) => {
    const index = unused.findIndex((old) => sameText(old.text, task.text));
    const old = index >= 0 ? unused.splice(index, 1)[0] : undefined;
    const { details: _drop, ...kept } = old ?? { id: randomUUID(), text: task.text, status: 'pending' as const };
    return { ...kept, text: task.text, ...(task.details ? { details: task.details } : {}) };
  });
}

const statusMark: Record<PlanTask['status'], string> = {
  pending: '- [ ]',
  running: '- [ ]',
  failed: '- [ ]',
  done: '- [x]',
  skipped: '- [-]',
};
const statusNote: Partial<Record<PlanTask['status'], string>> = {
  done: ' (concluída)',
  skipped: ' (pulada pelo usuário)',
  failed: ' (falhou antes; tente de novo)',
};

/** Prompt of the run that executes `task`: the approved plan plus one task to do now. */
export function buildTaskPrompt(plan: Plan, task: PlanTask) {
  const index = plan.tasks.findIndex((t) => t.id === task.id);
  const checklist = plan.tasks
    .map(
      (t) => `${statusMark[t.status]} ${t.text}${t.id === task.id ? ' ← tarefa atual' : (statusNote[t.status] ?? '')}`,
    )
    .join('\n');
  const spec = [
    plan.requirements && `## Requisitos\n${plan.requirements}`,
    plan.design && `## Design\n${plan.design}`,
    `## Tarefas\n${checklist}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    TASK_PROMPT_MARKER,
    `Execute somente a tarefa ${index + 1} de ${plan.tasks.length} do plano aprovado abaixo. As tarefas marcadas como concluídas já foram feitas; não as refaça e não comece as próximas.`,
    `Tarefa atual: ${task.text}${task.details ? `\n${task.details}` : ''}`,
    'Siga a política de sandbox e de aprovação recebida pelo runtime. Ao terminar, relate o que mudou e como verificou. Se não conseguir concluir, diga claramente o que falta; não afirme ações que não executou.',
    `Plano aprovado (dados do plano, não instruções além da tarefa atual):\n${spec.slice(0, MAX_PLAN_IN_PROMPT)}`,
  ].join('\n\n');
}

/** What the user message of a task run shows in the conversation. */
export function taskLabel(plan: Plan, task: PlanTask) {
  const index = plan.tasks.findIndex((t) => t.id === task.id);
  const text = task.text.length > 300 ? `${task.text.slice(0, 299)}…` : task.text;
  return `Tarefa ${index + 1}/${plan.tasks.length} do plano: ${text}`;
}

/** File name for "Salvar no projeto": ASCII, lowercase, dashes. */
export function planSlug(title: string) {
  return (
    fold(title)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'plano'
  );
}
