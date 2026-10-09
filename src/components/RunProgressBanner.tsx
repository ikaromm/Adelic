import type { Approval, DelegatedTask, Run, SessionDetail } from '../../shared/contracts';
import { commandPreview, commandTitle, activityForRun } from '../run-activity';
import { useNow } from '../useNow';
import { useI18n } from '../i18n';

export type RunProgressState = {
  phase: 'approval' | 'tool' | 'retry' | 'connection' | 'generating' | 'waiting' | 'eventsMissing';
  detail: string;
  lastActivityAt: number;
};

export function deriveRunProgress({
  run,
  events,
  tasks,
  approvals,
  streamUpdatedAt,
  eventsConnected,
  now = Date.now(),
}: {
  run: Run;
  events: SessionDetail['events'];
  tasks: DelegatedTask[];
  approvals: Approval[];
  streamUpdatedAt?: number;
  eventsConnected: boolean;
  now?: number;
}): RunProgressState {
  const activity = activityForRun(run.id, tasks, events);
  const runEvents = events.filter((event) => event.runId === run.id);
  const latestEventAt = runEvents.reduce((latest, event) => Math.max(latest, Date.parse(event.createdAt) || 0), 0);
  const latestNonRetryAt = runEvents
    .filter((event) => event.type !== 'retry')
    .reduce((latest, event) => Math.max(latest, Date.parse(event.createdAt) || 0), 0);
  const latestActivityAt = [
    Date.parse(run.startedAt),
    ...runEvents.map((event) => Date.parse(event.createdAt)),
    ...activity.tasks.flatMap((task) => [
      Date.parse(task.createdAt),
      task.startedAt ? Date.parse(task.startedAt) : 0,
      task.completedAt ? Date.parse(task.completedAt) : 0,
    ]),
    streamUpdatedAt ?? 0,
  ]
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), 0);
  const activeTool = [...activity.actions]
    .reverse()
    .find((event) => ['running', 'in_progress', 'started', 'pending', 'queued'].includes(event.status || ''));
  const approval = approvals.find((item) => item.runId === run.id && item.status === 'pending');
  const retry = activity.retries.at(-1);
  const retryIsCurrent = Boolean(
    retry && Date.parse(retry.createdAt) > Math.max(latestNonRetryAt, streamUpdatedAt ?? 0),
  );
  let phase: RunProgressState['phase'] = 'waiting';
  let detail = '';
  if (approval) {
    phase = 'approval';
    detail = approval.title;
  } else if (!eventsConnected) {
    phase = 'connection';
  } else if (activeTool) {
    phase = 'tool';
    detail = `${commandTitle(activeTool.toolName)}: ${commandPreview(activeTool.text, 96)}`;
  } else if (retryIsCurrent) {
    phase = 'retry';
  } else if (streamUpdatedAt && streamUpdatedAt >= latestEventAt) {
    phase = 'generating';
  } else if (!runEvents.length && now - latestActivityAt >= 30_000) {
    phase = 'eventsMissing';
  }
  return { phase, detail, lastActivityAt: latestActivityAt };
}

export function RunProgressBanner({
  run,
  events,
  tasks,
  approvals,
  streamUpdatedAt,
  eventsConnected,
  onShowActivity,
}: {
  run: Run;
  events: SessionDetail['events'];
  tasks: DelegatedTask[];
  approvals: Approval[];
  streamUpdatedAt?: number;
  eventsConnected: boolean;
  onShowActivity?: () => void;
}) {
  const { t, fmt } = useI18n();
  const now = useNow(1000, run.status === 'running');
  if (run.status !== 'running') return null;
  const state = deriveRunProgress({ run, events, tasks, approvals, streamUpdatedAt, eventsConnected, now });
  const silenceMs = state.lastActivityAt ? Math.max(0, now - state.lastActivityAt) : 0;
  const lastAction = state.lastActivityAt ? fmt.duration(silenceMs) : undefined;
  const labels: Record<RunProgressState['phase'], string> = {
    approval: t('chat.activity.waitingApproval', { title: state.detail }),
    tool: t('chat.activity.currentAction', { detail: state.detail }),
    retry: t('chat.activity.retrying'),
    connection: t('chat.activity.connectionLost'),
    generating: t('chat.activity.generating'),
    waiting: t('chat.activity.waitingModel'),
    eventsMissing: t('chat.activity.eventsMissing'),
  };
  return (
    <section className={`run-progress-banner ${state.phase}`} aria-label={t('chat.activity.label')}>
      <span className="run-progress-indicator" aria-hidden="true" />
      <div className="run-progress-copy">
        <strong aria-live="polite">{labels[state.phase]}</strong>
        {lastAction && (
          <small>
            {silenceMs >= 30_000
              ? t('chat.activity.silenceNotice', { elapsed: lastAction })
              : t('chat.activity.noUpdateFor', { elapsed: lastAction })}
          </small>
        )}
      </div>
      {onShowActivity && (
        <button type="button" onClick={onShowActivity}>
          {t('chat.activity.showActivity')}
        </button>
      )}
    </section>
  );
}
