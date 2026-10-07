import type { Run } from '../shared/contracts';
import { formatShortDate, formatTime } from './format';
import { t, type MessageKey } from './i18n';

// Status names in the current locale (src/i18n/messages/labels.ts). Call them at render time.

/** "14:05" in the current locale; "—" when unknown. */
export const timeLabel = (value?: string) => formatTime(value);

/** "12 de set." in the current locale; empty when unknown. */
export const shortDate = (value?: string) => formatShortDate(value);

const RUN_STATUS: Record<Run['status'], MessageKey> = {
  running: 'labels.run.running',
  completed: 'labels.run.completed',
  cancelled: 'labels.run.cancelled',
  failed: 'labels.run.failed',
  interrupted: 'labels.run.interrupted',
};
const TASK_STATUS: Record<string, MessageKey> = { ...RUN_STATUS, queued: 'labels.task.queued' };
const TASK_ROLE: Record<string, MessageKey> = {
  planner: 'labels.role.planner',
  worker: 'labels.role.worker',
  reviewer: 'labels.role.reviewer',
  synthesis: 'labels.role.synthesis',
};
const GRAPH_STATUS: Record<string, MessageKey> = {
  missing: 'labels.graph.missing',
  unindexed: 'labels.graph.unindexed',
  indexing: 'labels.graph.indexing',
  ready: 'labels.graph.ready',
  stale: 'labels.graph.stale',
  error: 'labels.graph.error',
  disabled: 'labels.graph.disabled',
};
const INTEGRATION: Record<string, MessageKey> = {
  ready: 'labels.integration.ready',
  missing: 'labels.integration.missing',
  error: 'labels.integration.error',
  planned: 'labels.integration.planned',
};
const lookup = (map: Record<string, MessageKey>, value: string) =>
  Object.hasOwn(map, value) ? t(map[value]) : undefined;

export function statusName(status: Run['status']) {
  return t(RUN_STATUS[status]);
}

export function taskStatusName(status: string) {
  return lookup(TASK_STATUS, status) || status;
}

export function taskRoleName(role: string) {
  return lookup(TASK_ROLE, role) || role;
}

export function graphStatusName(status: string) {
  return lookup(GRAPH_STATUS, status) || status;
}

export function integrationName(status: string) {
  return lookup(INTEGRATION, status) || t('labels.integration.unknown');
}
