import type { Run } from '../shared/contracts';
import { formatShortDate, formatTime } from './format';

/** "14:05" in the current locale; "—" when unknown. */
export const timeLabel = (value?: string) => formatTime(value);

/** "12 de set." in the current locale; empty when unknown. */
export const shortDate = (value?: string) => formatShortDate(value);

export function statusName(status: Run['status']) {
  return {
    running: 'Em execução',
    completed: 'Concluída',
    cancelled: 'Cancelada',
    failed: 'Falhou',
    interrupted: 'Interrompida',
  }[status];
}

export function taskStatusName(status: string) {
  return (
    (
      {
        queued: 'Na fila',
        running: 'Em execução',
        completed: 'Concluída',
        cancelled: 'Cancelada',
        failed: 'Falhou',
        interrupted: 'Interrompida',
      } as Record<string, string>
    )[status] || status
  );
}

export function taskRoleName(role: string) {
  return (
    ({ planner: 'Plano', worker: 'Executor', reviewer: 'Revisor', synthesis: 'Síntese' } as Record<string, string>)[
      role
    ] || role
  );
}

export function graphStatusName(status: string) {
  return (
    (
      {
        missing: 'Graphify ausente',
        unindexed: 'Ainda não indexado',
        indexing: 'Indexando',
        ready: 'Índice pronto',
        stale: 'Índice desatualizado',
        error: 'Erro ao indexar',
        disabled: 'Desativado',
      } as Record<string, string>
    )[status] || status
  );
}

export function integrationName(status: string) {
  return (
    ({ ready: 'Conectado', missing: 'Ausente', error: 'Erro', planned: 'Planejado' } as Record<string, string>)[
      status
    ] || 'Desconhecido'
  );
}
