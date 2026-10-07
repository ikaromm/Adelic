import { Activity, Bot, Clock3, Gauge, History, Zap } from 'lucide-react';
import type { Bootstrap, Run } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { statusName } from '../labels';

export function ActivityPage({ runs, providers }: { runs: Run[]; providers: Bootstrap['providers'] }) {
  const { t, fmt } = useI18n();
  const completed = runs.filter((run) => run.status === 'completed');
  const durations = runs.flatMap((run) => (run.durationMs != null ? [run.durationMs] : []));
  const firstTokens = runs.flatMap((run) => (run.firstTokenMs != null ? [run.firstTokenMs] : []));
  const avg = (numbers: number[]) =>
    numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : null;
  const meanDuration = avg(durations),
    meanFirst = avg(firstTokens);
  // Totals only over runs that reported them; the hint says how many did.
  const withTokens = runs.filter((run) => run.inputTokens != null || run.outputTokens != null);
  const totalTokens = withTokens.reduce((sum, run) => sum + (run.inputTokens ?? 0) + (run.outputTokens ?? 0), 0);
  const withCost = runs.filter((run) => run.costUsd != null);
  const totalCost = withCost.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  return (
    <section className="page-content">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('activityPage.eyebrow')}</div>
          <h1>{t('activityPage.title')}</h1>
          <p>{t('activityPage.subtitle')}</p>
        </div>
        <span className="period-chip">
          <History size={14} /> {t('activityPage.period')}
        </span>
      </div>
      <div className="metrics-grid">
        <MetricCard
          icon={<Activity size={17} />}
          label={t('activityPage.runs')}
          value={fmt.number(runs.length)}
          hint={t('activityPage.completed', { count: completed.length })}
        />
        <MetricCard
          icon={<Zap size={17} />}
          label={t('activityPage.firstResponse')}
          value={meanFirst == null ? '—' : fmt.duration(meanFirst)}
          hint={meanFirst == null ? t('activityPage.noMeasure') : t('activityPage.untilFirstText')}
        />
        <MetricCard
          icon={<Clock3 size={17} />}
          label={t('activityPage.meanDuration')}
          value={meanDuration == null ? '—' : fmt.duration(meanDuration)}
          hint={meanDuration == null ? t('activityPage.noMeasure') : t('activityPage.ofRecordedRuns')}
        />
        <MetricCard
          icon={<Gauge size={17} />}
          label={t('activityPage.tokens')}
          value={withTokens.length ? fmt.tokens(totalTokens)! : '—'}
          hint={
            !withTokens.length
              ? t('activityPage.tokensUnreported')
              : withCost.length
                ? t('activityPage.tokensHint', {
                    reported: withTokens.length,
                    count: runs.length,
                    cost: fmt.cost(totalCost)!,
                  })
                : t('activityPage.tokensHintNoCost', { reported: withTokens.length, count: runs.length })
          }
        />
      </div>
      <div className="activity-section">
        <div className="section-title-row">
          <div>
            <h2>{t('activityPage.recent')}</h2>
            <p>{t('activityPage.recentHint')}</p>
          </div>
          <span className="count-chip">{runs.length}</span>
        </div>
        {runs.length === 0 ? (
          <div className="empty-panel activity-empty">
            <div className="empty-icon">
              <Activity size={18} />
            </div>
            <strong>{t('activityPage.empty')}</strong>
            <span>{t('activityPage.emptyHint')}</span>
          </div>
        ) : (
          <div className="run-table">
            <div className="run-table-head">
              <span>{t('activityPage.col.agent')}</span>
              <span>{t('activityPage.col.status')}</span>
              <span>{t('activityPage.col.time')}</span>
              <span>{t('activityPage.col.duration')}</span>
              <span>{t('activityPage.col.usage')}</span>
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
                        {t('activityPage.route', {
                          level: t(run.route.level === 'fast' ? 'mode.fast' : 'mode.deep'),
                          reason: run.route.reason,
                        })}
                      </small>
                    </span>
                  </div>
                  <span>
                    <i className={`run-status-dot ${run.status}`} />
                    {statusName(run.status)}
                  </span>
                  <span>
                    {t('activityPage.startedAt', { date: fmt.shortDate(run.startedAt), time: fmt.time(run.startedAt) })}
                  </span>
                  <span>{run.durationMs == null ? '—' : fmt.duration(run.durationMs)}</span>
                  <span title={run.costUsd == null ? t('activityPage.costUnreported') : undefined}>
                    {[fmt.runTokens(run), fmt.cost(run.costUsd)].filter(Boolean).join(' · ') || '—'}
                  </span>
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
