import type { DelegatedTask } from './contracts.js';

/**
 * Shared retry decision for the API and recovery UI.
 *
 * Missing history metadata is treated as legacy/no-marker only when there is no
 * reservation or linked attempt. The Store annotates loaded tasks with history state,
 * so unknown historical attempts cannot be mistaken for a first retry.
 */
export function canRetryTask(task: DelegatedTask): boolean {
  const retryableProcess =
    ['failed', 'interrupted', 'cancelled'].includes(task.status) &&
    (!task.delivery ||
      (['blocked', 'not_implemented'].includes(task.delivery.status) && task.delivery.recovery.action === 'retry'));
  const retryableDelivery =
    task.status === 'completed' &&
    task.delivery?.status === 'not_implemented' &&
    task.delivery.recovery.action === 'retry';

  if (!retryableProcess && !retryableDelivery) return false;
  if (task.status === 'queued' || task.status === 'running' || task.integration?.status === 'applied') return false;
  if (task.retryStartedAt && !task.retryRunId) return false;
  if (task.retryHistoryState === 'delivered' || task.retryHistoryState === 'unknown') return false;
  if (task.retryRunDelivered === true) return false;

  if (task.retryRunId) {
    return (
      ['completed', 'failed', 'interrupted', 'cancelled'].includes(task.retryRunStatus ?? '') &&
      task.retryRunDelivered === false
    );
  }

  if (task.retryHistoryState === 'empty') return task.retryRunDelivered === false;
  // A task with no attempts has no delivery outcome yet and may be retried. Older
  // clients/records lack the derived state, so only markerless records use this fallback.
  return task.retryHistoryState === 'none' || task.retryHistoryState === undefined;
}
