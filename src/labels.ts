import type { Run } from '../shared/contracts';

export function timeLabel(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function shortDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

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
