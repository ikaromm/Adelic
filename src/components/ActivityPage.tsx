import { Activity, Bot, Clock3, Gauge, History, Zap } from 'lucide-react';
import type { Bootstrap, Run } from '../../shared/contracts';
import { formatDuration } from '../format';
import { shortDate, statusName, timeLabel } from '../labels';

export function ActivityPage({ runs, providers }: { runs: Run[]; providers: Bootstrap['providers'] }) {
  const completed = runs.filter((run) => run.status === 'completed');
  const durations = runs.flatMap((run) => (run.durationMs != null ? [run.durationMs] : []));
  const firstTokens = runs.flatMap((run) => (run.firstTokenMs != null ? [run.firstTokenMs] : []));
  const avg = (numbers: number[]) =>
    numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : null;
  const meanDuration = avg(durations),
    meanFirst = avg(firstTokens);
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">USO E EXECUÇÕES</div>
          <h1>Atividade</h1>
          <p>Acompanhe execuções reais dos seus agentes.</p>
        </div>
        <span className="period-chip">
          <History size={14} /> Todo o histórico
        </span>
      </div>
      <div className="metrics-grid">
        <MetricCard
          icon={<Activity size={17} />}
          label="Execuções"
          value={String(runs.length)}
          hint={`${completed.length} concluídas`}
        />
        <MetricCard
          icon={<Zap size={17} />}
          label="1ª resposta média"
          value={meanFirst == null ? '—' : formatDuration(meanFirst)}
          hint={meanFirst == null ? 'Sem medição disponível' : 'até o primeiro texto'}
        />
        <MetricCard
          icon={<Clock3 size={17} />}
          label="Duração média"
          value={meanDuration == null ? '—' : formatDuration(meanDuration)}
          hint={meanDuration == null ? 'Sem medição disponível' : 'das execuções registradas'}
        />
        <MetricCard icon={<Gauge size={17} />} label="Custo" value="—" hint="Indisponível pelo provedor" />{' '}
      </div>
      <div className="activity-section">
        <div className="section-title-row">
          <div>
            <h2>Execuções recentes</h2>
            <p>Os dados são registrados localmente.</p>
          </div>
          <span className="count-chip">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <div className="empty-panel activity-empty">
            <div className="empty-icon">
              <Activity size={18} />
            </div>
            <strong>Nenhuma execução ainda</strong>
            <span>As conversas concluídas aparecerão aqui.</span>
          </div>
        ) : (
          <div className="run-table">
            <div className="run-table-head">
              <span>AGENTE / MODO</span>
              <span>STATUS</span>
              <span>HORÁRIO</span>
              <span>DURAÇÃO</span>
              <span>CUSTO</span>
            </div>
            {[...runs]
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
              .map((run) => (
                <div className="run-table-row" key={run.id}>
                  <div className="run-provider-cell">
                    <div className="provider-avatar">
                      <Bot size={15} />
                    </div>
                    <span>
                      <strong>{providers.find((p) => p.id === run.providerId)?.name || run.providerId}</strong>
                      <small>
                        {run.route.level === 'fast' ? 'Rápido' : 'Completo'} · {run.route.reason}
                      </small>
                    </span>
                  </div>
                  <span>
                    <i className={`run-status-dot ${run.status}`} />
                    {statusName(run.status)}
                  </span>
                  <span>
                    {shortDate(run.startedAt)} às {timeLabel(run.startedAt)}
                  </span>
                  <span>{run.durationMs == null ? '—' : formatDuration(run.durationMs)}</span>
                  <span>{run.costUsd == null ? '—' : `$${run.costUsd.toFixed(4)}`}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span className="metric-icon">{icon}</span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
