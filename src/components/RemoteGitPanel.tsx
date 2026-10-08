import { useCallback, useEffect, useState } from 'react';
import { GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Project } from '../../shared/contracts';
import type { RemoteHost } from '../../shared/remote-hosts';
import { api } from '../api';
import { useI18n } from '../i18n';

type Operation = 'status' | 'diff' | 'log';

export function RemoteGitPanel({ project, remoteHost }: { project: Project; remoteHost?: RemoteHost }) {
  const { t } = useI18n();
  const [operation, setOperation] = useState<Operation>('status');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setOutput((await api.remoteGit(project.id, operation)).output);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [project.id, operation]);
  useEffect(() => void refresh(), [refresh]);
  return (
    <section className="page-content remote-git-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t('remoteGit.eyebrow', { project: project.name })}</div>
          <h1>Git</h1>
          <p>{t('remoteGit.detail')}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} {t('remoteGit.refresh')}
        </button>
      </div>
      <div className="remote-git-location">
        <GitBranch size={14} />
        <span>{remoteHost?.name || t('remoteHosts.remote')}</span>
        <span>{remoteHost?.target || project.remote?.hostId}</span>
        <strong>{project.remote?.path}</strong>
      </div>
      <div className="remote-git-tabs" role="tablist" aria-label={t('remoteGit.operations')}>
        {(['status', 'diff', 'log'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={operation === item}
            className={operation === item ? 'active' : ''}
            onClick={() => setOperation(item)}
          >
            {t(`remoteGit.${item}`)}
          </button>
        ))}
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {busy && !output ? (
        <div className="run-diff-loading">
          <LoaderCircle className="spin" size={14} /> {t('remoteGit.loading')}
        </div>
      ) : (
        <pre className="remote-git-output">{output || t('remoteGit.empty')}</pre>
      )}
    </section>
  );
}
