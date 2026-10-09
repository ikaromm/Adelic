import type { ApprovalMode, Sandbox } from '../../shared/contracts';
import { useI18n } from '../i18n';

/** Effective settings for the next request, shown without changing them. */
export function ExecutionProfile({
  provider,
  model,
  thinking,
  sandbox,
  approval,
  delegation,
  graph,
  memory,
}: {
  provider: string;
  model?: string;
  thinking: string;
  sandbox: Sandbox;
  approval: ApprovalMode;
  delegation: boolean;
  graph: boolean;
  memory: boolean;
}) {
  const { t } = useI18n();
  const onOff = (on: boolean) => t(on ? 'profile.on' : 'profile.off');
  return (
    <details className="execution-profile">
      <summary>{t('profile.title')}</summary>
      <dl>
        <div>
          <dt>{t('profile.provider')}</dt>
          <dd>
            {provider} · {model || t('profile.defaultModel')}
          </dd>
        </div>
        <div>
          <dt>{t('profile.thinking')}</dt>
          <dd>{thinking}</dd>
        </div>
        <div>
          <dt>{t('profile.permissions')}</dt>
          <dd>
            {t(sandbox === 'workspace-write' ? 'profile.write' : 'profile.read')} ·{' '}
            {t(
              approval === 'auto-safe'
                ? 'composer.autonomy.mode.autoSafe'
                : approval === 'automatic'
                  ? 'composer.autonomy.mode.automatic'
                  : 'composer.autonomy.mode.manual',
            )}
          </dd>
        </div>
        <div>
          <dt>{t('profile.delegation')}</dt>
          <dd>{onOff(delegation)}</dd>
        </div>
        <div>
          <dt>{t('profile.graph')}</dt>
          <dd>{onOff(graph)}</dd>
        </div>
        <div>
          <dt>{t('profile.memory')}</dt>
          <dd>{onOff(memory)}</dd>
        </div>
      </dl>
      <p>{t('profile.next')}</p>
    </details>
  );
}
