import { useState } from 'react';
import { FileText, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react';
import type { DelegatedTask } from '../../shared/contracts';
import { canRetryTask } from '../../shared/task-retry';
import { api, type ApiError } from '../api';
import { useI18n } from '../i18n';

function messageOf(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const conflicts = (error as ApiError).conflicts ?? [];
  return [error.message, ...conflicts].join(' · ');
}

export function TaskRecovery({
  task,
  onRefresh,
  onInspect,
  disabled = false,
}: {
  task: DelegatedTask;
  onRefresh: () => Promise<void>;
  onInspect: () => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'applying' | 'discarding' | 'retrying' | 'inspecting' | 'done' | 'error'>(
    'idle',
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof api.inspectTask>>>();
  const worktree = task.recoveryWorktree;
  const recovery = task.delivery?.recovery;
  const canRetry = recovery?.action === 'retry' && canRetryTask(task);
  // Inspection is read-only and remains available alongside retry for any persisted recovery state.
  const canInspect = Boolean((recovery && recovery.action !== 'none') || worktree || task.integration);

  const canApply = Boolean(worktree && task.integration?.status !== 'applied');
  if (!worktree && !canRetry && !canInspect && !task.integration) return null;

  const apply = async () => {
    if (disabled || !worktree || !window.confirm(t('chat.task.recoveryApplyConfirm'))) return;
    setState('applying');
    setError('');
    setNotice('');
    try {
      const result = await api.applyTaskWorktree(task.id);
      await onRefresh();
      if (result.applied) {
        setState('done');
      } else {
        // A no-op is not a delivery: keep the refreshed retry action available.
        setState('idle');
        setNotice(t('chat.task.recoveryNoChanges'));
      }
    } catch (cause) {
      setError(messageOf(cause, t('chat.task.recoveryFailed')));
      setState('error');
    }
  };
  const discard = async () => {
    if (disabled || !worktree || !window.confirm(t('chat.task.recoveryDiscardConfirm'))) return;
    setState('discarding');
    setError('');
    setNotice('');
    try {
      await api.discardTaskWorktree(task.id);
      await onRefresh();
      setState('done');
    } catch (cause) {
      setError(messageOf(cause, t('chat.task.recoveryFailed')));
      setState('error');
    }
  };
  const retry = async () => {
    if (disabled || !canRetry || !window.confirm(t('chat.task.recoveryRetryConfirm'))) return;
    setState('retrying');
    setError('');
    setNotice('');
    try {
      await api.retryTask(task.id);
      await onRefresh();
      setState('done');
    } catch (cause) {
      setError(messageOf(cause, t('chat.task.recoveryFailed')));
      setState('error');
    }
  };
  const inspect = async () => {
    if (disabled) return;
    setState('inspecting');
    setError('');
    setNotice('');
    try {
      const result = await api.inspectTask(task.id);
      await onInspect();
      setInspection(result);
      setState('idle');
    } catch (cause) {
      setError(messageOf(cause, t('chat.task.recoveryFailed')));
      setState('error');
    }
  };
  // Completion is feedback, not an in-flight request. Fresh persisted task props decide whether
  // another retry is safe; keeping `done` out of busy lets that state change take effect in place.
  const busy = disabled || ['applying', 'discarding', 'retrying', 'inspecting'].includes(state);
  const taskStatus = task.status === 'completed' ? 'completed' : task.status;
  const integration = task.integration;
  return (
    <section
      className="task-recovery"
      aria-label={t('chat.task.recoveryLabel', { title: task.title, id: task.id })}
      aria-live="polite"
    >
      <h4>{t('chat.task.recoveryHeading')}</h4>
      <dl className="task-recovery-status">
        <div>
          <dt>{t('chat.task.processStatus')}</dt>
          <dd data-testid="task-process-status">{t(`chat.task.process.${taskStatus}`)}</dd>
        </div>
        <div>
          <dt>{t('chat.task.deliveryStatus')}</dt>
          <dd data-testid="task-delivery-status">
            {task.delivery ? t(`chat.task.delivery.${task.delivery.status}`) : t('chat.task.statusUnknown')}
          </dd>
        </div>
        {integration && (
          <>
            <div>
              <dt>{t('chat.task.integrationStatus')}</dt>
              <dd data-testid="task-integration-status">{t(`chat.task.integration.${integration.status}`)}</dd>
            </div>
            <div>
              <dt>{t('chat.task.cleanupStatus')}</dt>
              <dd data-testid="task-cleanup-status">{t(`chat.task.cleanup.${integration.cleanup}`)}</dd>
            </div>
          </>
        )}
      </dl>
      {integration?.reason && <p>{integration.reason}</p>}
      {worktree && <small>{t('chat.task.recoveryAvailable', { branch: worktree.branch })}</small>}
      {recovery?.reason && <p>{recovery.reason}</p>}
      {disabled && <small>{t('chat.task.recoveryBusy')}</small>}
      <div className="retry-actions">
        {canRetry && (
          <button
            type="button"
            className="secondary-button"
            data-testid="task-recovery-retry"
            data-task-id={task.id}
            aria-label={t('chat.task.recoveryRetryFor', { title: task.title, id: task.id })}
            onClick={() => void retry()}
            disabled={busy}
          >
            {state === 'retrying' ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
            {t('chat.task.recoveryRetry')}
          </button>
        )}
        {canInspect && (
          <button
            type="button"
            className="secondary-button"
            data-testid="task-recovery-inspect"
            data-task-id={task.id}
            aria-label={t('chat.task.recoveryInspectFor', { title: task.title, id: task.id })}
            onClick={() => void inspect()}
            disabled={disabled || ['applying', 'discarding', 'retrying', 'inspecting'].includes(state)}
          >
            {state === 'inspecting' ? <LoaderCircle className="spin" size={13} /> : <FileText size={13} />}
            {t('chat.task.recoveryInspect')}
          </button>
        )}
        {canApply && worktree && (
          <button
            type="button"
            className="secondary-button"
            data-testid="task-recovery-apply"
            data-task-id={task.id}
            aria-label={t('chat.task.recoveryApplyFor', { title: task.title, id: task.id })}
            onClick={() => void apply()}
            disabled={busy}
          >
            {state === 'applying' ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
            {t('chat.task.recoveryApply')}
          </button>
        )}
        {worktree && (
          <button
            type="button"
            className="ghost-button"
            data-testid="task-recovery-discard"
            data-task-id={task.id}
            aria-label={t('chat.task.recoveryDiscardFor', { title: task.title, id: task.id })}
            onClick={() => void discard()}
            disabled={busy}
          >
            {state === 'discarding' ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
            {t('chat.task.recoveryDiscard')}
          </button>
        )}
      </div>
      {inspection && (
        <details className="task-recovery-inspection" open>
          <summary>{t('chat.task.recoveryInspection')}</summary>
          <h5>{t('chat.task.recoveryOutput')}</h5>
          <pre>{inspection.task.output || t('chat.task.recoveryNoOutput')}</pre>
          <h5>{t('chat.task.recoveryEvents', { count: inspection.events.length })}</h5>
          {inspection.events.length ? (
            <ul>
              {inspection.events.map((event) => (
                <li key={event.id}>
                  <code>{event.toolName || event.type}</code> · {event.status || event.text}
                </li>
              ))}
            </ul>
          ) : (
            <small>{t('chat.task.recoveryNoEvents')}</small>
          )}
          <h5>{t('chat.task.recoveryProjectArtifacts')}</h5>
          {inspection.artifacts.project.status === 'unknown' || inspection.artifacts.project.truncated ? (
            <small>
              {t('chat.task.recoveryEvidenceIncomplete')}
              {inspection.artifacts.project.reason ? `: ${inspection.artifacts.project.reason}` : ''}
            </small>
          ) : inspection.artifacts.project.files.length ? (
            <ul>
              {inspection.artifacts.project.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> · {file.status}
                </li>
              ))}
            </ul>
          ) : (
            <small>{t('chat.task.recoveryNoArtifacts')}</small>
          )}
          {inspection.artifacts.worktree && (
            <>
              <h5>{t('chat.task.recoveryWorktreeArtifacts')}</h5>
              {inspection.artifacts.worktree.status === 'unknown' || inspection.artifacts.worktree.truncated ? (
                <small>
                  {t('chat.task.recoveryEvidenceIncomplete')}
                  {inspection.artifacts.worktree.reason ? `: ${inspection.artifacts.worktree.reason}` : ''}
                </small>
              ) : inspection.artifacts.worktree.files.length ? (
                <ul>
                  {inspection.artifacts.worktree.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code> · {file.status}
                    </li>
                  ))}
                </ul>
              ) : (
                <small>{t('chat.task.recoveryNoArtifacts')}</small>
              )}
            </>
          )}
        </details>
      )}
      {notice && <small role="status">{notice}</small>}
      {state === 'done' && <small role="status">{t('chat.task.recoveryDone')}</small>}
      {state === 'error' && (
        <small role="alert">
          {t('chat.task.recoveryFailed')}: {error}
        </small>
      )}
    </section>
  );
}
