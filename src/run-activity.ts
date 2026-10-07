import type { DelegatedTask, FileChange, RunEvent, RunStatus } from '../shared/contracts';
import { t } from './i18n';

export interface RunActivity {
  tasks: DelegatedTask[];
  events: RunEvent[];
  errors: RunEvent[];
  actions: RunEvent[];
  /** Automatic retries, newest last. */
  retries: RunEvent[];
  /** Automatic model switches (Settings.modelFallback). */
  fallbacks: RunEvent[];
  /** After-edit checks of the project, in order (docs/specs/project-hooks.md). */
  checks: RunEvent[];
  /** Approvals denied by the project's blocked commands. */
  blocked: RunEvent[];
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
  const isBlocked = (event: RunEvent) => event.type === 'approval' && event.status === 'blocked';
  return {
    tasks: runTasks,
    events: runEvents.filter(
      (event) =>
        event.type !== 'error' &&
        event.type !== 'tool' &&
        event.type !== 'retry' &&
        event.type !== 'fallback' &&
        event.type !== 'check' &&
        !isBlocked(event),
    ),
    errors: runEvents.filter((event) => event.type === 'error'),
    actions,
    retries: runEvents.filter((event) => event.type === 'retry'),
    fallbacks: runEvents.filter((event) => event.type === 'fallback'),
    checks: runEvents.filter((event) => event.type === 'check' && event.check),
    blocked: runEvents.filter(isBlocked),
  };
}

export function activityIsVisible(activity: RunActivity): boolean {
  return (
    activity.tasks.length > 0 ||
    activity.actions.length > 0 ||
    activity.errors.length > 0 ||
    activity.retries.length > 0 ||
    activity.fallbacks.length > 0 ||
    activity.blocked.length > 0
  );
}

export function commandTitle(toolName?: string): string {
  if (toolName === 'commandExecution') return t('activity.tool.command');
  if (toolName === 'fileChange') return t('activity.tool.fileChange');
  if (toolName === 'mcpToolCall') return t('activity.tool.mcp');
  return t('activity.tool.other');
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
  if (!status) return t('activity.status.recorded');
  if (isActionInProgress(status)) return t('activity.status.inProgress');
  if (status === 'completed') return t('activity.status.completed');
  if (status === 'failed') return t('activity.status.failed');
  if (status === 'cancelled') return t('activity.status.cancelled');
  return status;
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
  const keys = {
    running: 'activity.status.inProgress',
    cancelled: 'activity.status.cancelled',
    interrupted: 'activity.status.interrupted',
    failed: 'activity.status.failed',
  } as const;
  return t(keys[status]);
}

/** "Alterou 3 arquivos (+12 −4)"; counts include files beyond the listed ones when known. */
export function changesSummary(files: FileChange[], omitted = 0): string {
  const count = files.length + omitted;
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return t('activity.changes', { count, additions, deletions });
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';
/** Classifies a unified diff line for coloring; `---`/`+++` headers before a hunk are metadata. */
export function diffLines(diff: string): { text: string; kind: DiffLineKind }[] {
  let inHunk = false;
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => {
      let kind: DiffLineKind = 'context';
      if (text.startsWith('diff --git')) inHunk = false;
      if (text.startsWith('@@')) {
        inHunk = true;
        kind = 'hunk';
      } else if (!inHunk || text.startsWith('\\')) kind = 'meta';
      else if (text.startsWith('+')) kind = 'add';
      else if (text.startsWith('-')) kind = 'del';
      return { text, kind };
    });
}

/** "2 verificações · 1 falhou" for the activity headline; '' without checks. */
export function checksSummary(checks: RunEvent[]): string {
  if (!checks.length) return '';
  const statuses = checks.map((event) => event.check?.status);
  const failed = statuses.filter((status) => status === 'failed' || status === 'timeout' || status === 'error').length;
  const running = statuses.filter((status) => status === 'running').length;
  const total = t('activity.checks', { count: checks.length });
  if (running) return t('activity.checksRunning', { checks: total });
  return failed
    ? t('activity.checksFailed', { checks: total, count: failed })
    : t('activity.checksOk', { checks: total });
}
