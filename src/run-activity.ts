import type { DelegatedTask, RunEvent, RunStatus } from '../shared/contracts';

export interface RunActivity {
  tasks: DelegatedTask[];
  events: RunEvent[];
  errors: RunEvent[];
  actions: RunEvent[];
}

/** Keep one visible record for tool lifecycle updates such as started/completed. */
export function activityForRun(runId: string, tasks: DelegatedTask[], events: RunEvent[]): RunActivity {
  const runTasks = tasks.filter((task) => task.runId === runId);
  const runEvents = events
    .filter((event) => event.runId === runId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const actions: RunEvent[] = [];
  const pending = new Map<string, number[]>();
  const calls = new Map<string, number>();
  for (const event of runEvents) {
    if (event.type !== 'tool') continue;
    const toolCallId = event.toolCallId;
    if (toolCallId) {
      const currentIndex = calls.get(toolCallId);
      if (currentIndex == null) {
        calls.set(toolCallId, actions.length);
        actions.push(event);
      } else actions[currentIndex] = event;
      continue;
    }
    const key = `${event.toolName || ''}\0${event.text.trim()}`;
    if (isActionInProgress(event.status)) {
      const indexes = pending.get(key) || [];
      indexes.push(actions.length);
      pending.set(key, indexes);
      actions.push(event);
    } else {
      const indexes = pending.get(key);
      const startIndex = indexes?.shift();
      if (indexes?.length === 0) pending.delete(key);
      if (startIndex == null) actions.push(event);
      else actions[startIndex] = event;
    }
  }
  return {
    tasks: runTasks,
    events: runEvents.filter((event) => event.type !== 'error' && event.type !== 'tool'),
    errors: runEvents.filter((event) => event.type === 'error'),
    actions,
  };
}

export function activityIsVisible(activity: RunActivity): boolean {
  return activity.tasks.length > 0 || activity.actions.length > 0 || activity.errors.length > 0;
}

export function commandTitle(toolName?: string): string {
  if (toolName === 'commandExecution') return 'Execução de comando';
  if (toolName === 'fileChange') return 'Alteração de arquivo';
  if (toolName === 'mcpToolCall') return 'Uso de ferramenta';
  return 'Ação do agente';
}

export function actionNeedsDisclosure(event: RunEvent): boolean {
  return event.toolName === 'commandExecution' || event.text.length > 160;
}

/** One-line preview of an action; shell commands lose the `bash -lc '…'` wrapper added by runtimes. */
export function commandPreview(text: string, maxLength = 240): string {
  const trimmed = text.trim();
  const wrapped = trimmed.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  let inner = trimmed;
  if (wrapped) {
    const [, quote, body] = wrapped;
    // Unwrap only when the quotes form one shell word; otherwise show the command as received.
    if (quote === "'" && !body.replaceAll(`'\\''`, '').includes("'")) inner = body.replaceAll(`'\\''`, "'");
    if (quote === '"' && !/(^|[^\\])"/.test(body)) inner = body.replace(/\\(["\\$`])/g, '$1');
  }
  const line =
    inner
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean) || '';
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

export function statusLabel(status?: string): string {
  if (!status) return 'Registrada';
  if (isActionInProgress(status)) return 'Em andamento';
  return (
    ({ completed: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada' } as Record<string, string>)[status] || status
  );
}

function isActionInProgress(status?: string): boolean {
  return (
    status === 'running' ||
    status === 'in_progress' ||
    status === 'started' ||
    status === 'pending' ||
    status === 'queued'
  );
}

export function runStatusLabel(status?: RunStatus): string | null {
  if (!status || status === 'completed') return null;
  return { running: 'Em andamento', cancelled: 'Cancelada', interrupted: 'Interrompida', failed: 'Falhou' }[status];
}
