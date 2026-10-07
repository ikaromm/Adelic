import { useState } from 'react';
import {
  Check,
  ClipboardCopy,
  Download,
  ExternalLink,
  LoaderCircle,
  MonitorDown,
  RefreshCw,
  Stethoscope,
} from 'lucide-react';
import { api, type Diagnostics, type UpdateInfo } from '../api';
import { promptInstall, usePwa } from '../pwa/client';
import { copyText } from '../Markdown';
import type { UpdateChannel } from '../../shared/contracts';
import { SelfUpdate } from './SelfUpdate';
import { useI18n } from '../i18n';

const field = (label: string, value: string | number | null | undefined) => (
  <div className="diagnostics-row" key={label}>
    <dt>{label}</dt>
    <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
  </div>
);

/** Installable app (docs/specs/pwa.md): the button appears only when the browser offers it. */
function InstallRow() {
  const { t } = useI18n();
  const { installable, standalone } = usePwa();
  return (
    <div className="setting-row">
      <div>
        <strong>{t('diagnostics.app')}</strong>
        <span>{standalone ? t('diagnostics.appInstalled') : t('diagnostics.appHttps')}</span>
      </div>
      {installable && (
        <button type="button" className="secondary-button" onClick={() => void promptInstall()}>
          <MonitorDown size={14} /> {t('diagnostics.install')}
        </button>
      )}
    </div>
  );
}

/** Settings card that loads /api/diagnostics on demand and lets the user copy or save it. */
export function DiagnosticsCard({
  updateCheck,
  onUpdateCheck,
  updateChannel,
  onUpdateChannel,
}: {
  updateCheck: boolean;
  onUpdateCheck: (enabled: boolean) => void;
  updateChannel: UpdateChannel;
  onUpdateChannel: (channel: UpdateChannel) => void;
}) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const checkNow = async () => {
    setChecking(true);
    try {
      setUpdate(await api.updates(true));
    } catch (e) {
      setUpdate({ enabled: true, error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };
  const [report, setReport] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await api.diagnostics());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const json = report ? JSON.stringify(report, null, 2) : '';
  const copy = async () => {
    // copyText falls back to a textarea where the Clipboard API is missing (plain HTTP remote access).
    if (await copyText(json)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else setError(t('diagnostics.copyFailed'));
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('diagnostics.fileName', { date: report!.generatedAt.slice(0, 19).replace(/[:T]/g, '-') });
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="settings-card" aria-labelledby="diagnostics-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon">
          <Stethoscope size={17} />
        </div>
        <div>
          <h2 id="diagnostics-title">{t('diagnostics.title')}</h2>
          <p>{t('diagnostics.detail')}</p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>{t('diagnostics.updateCheck')}</strong>
          <span>{t('diagnostics.updateCheckDetail')}</span>
        </div>
        <button
          className={`toggle ${updateCheck ? 'on' : ''}`}
          role="switch"
          aria-checked={updateCheck}
          aria-label={t('diagnostics.updateCheck')}
          onClick={() => onUpdateCheck(!updateCheck)}
        >
          <span />
        </button>
      </div>
      <div className="diagnostics-actions">
        <button type="button" className="secondary-button" onClick={() => void checkNow()} disabled={checking}>
          {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} {t('diagnostics.checkNow')}
        </button>
      </div>
      {update && (
        <p className="diagnostics-note" role="status">
          {update.error ? (
            update.error
          ) : update.available ? (
            <>
              {t('diagnostics.newVersion', { latest: update.latest ?? '', current: update.current ?? '' })}{' '}
              <a href={update.url} target="_blank" rel="noreferrer">
                {t('diagnostics.openRelease')} <ExternalLink size={12} />
              </a>
            </>
          ) : (
            t('diagnostics.upToDate', { current: update.current ?? '' })
          )}
        </p>
      )}
      <SelfUpdate channel={updateChannel} onChannel={onUpdateChannel} />
      <InstallRow />
      <div className="diagnostics-actions">
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Stethoscope size={14} />}
          {report ? t('diagnostics.refresh') : t('diagnostics.generate')}
        </button>
        {report && (
          <>
            <button type="button" className="secondary-button" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}{' '}
              {copied ? t('diagnostics.copied') : t('diagnostics.copy')}
            </button>
            <button type="button" className="secondary-button" onClick={download}>
              <Download size={14} /> {t('diagnostics.download')}
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {report && (
        <div className="diagnostics-body">
          <dl>
            {field('Adelic', report.app.version)}
            {field('Node', report.app.node)}
            {field('Electron', report.app.electron)}
            {field(
              t('diagnostics.system'),
              `${report.system.platform} ${report.system.arch} · ${report.system.kernel}`,
            )}
            {field(t('diagnostics.data'), report.data.dir)}
            {field(
              t('diagnostics.schema'),
              t('diagnostics.schemaValue', {
                current: report.data.schema.current,
                supported: report.data.schema.supported,
              }),
            )}
            {field(
              t('diagnostics.content'),
              t('diagnostics.contentValue', {
                sessions: report.data.counts.sessions,
                messages: report.data.counts.messages,
                runs: report.data.counts.runs,
              }),
            )}
            {field(
              t('diagnostics.backups'),
              report.data.backups.length
                ? t('diagnostics.backupsValue', {
                    count: report.data.backups.length,
                    date: report.data.backups[0].at.slice(0, 10),
                  })
                : t('diagnostics.none'),
            )}
            {field('Bubblewrap', report.sandbox.bubblewrap ?? t('diagnostics.notFound'))}
            {field(
              'ai-memory',
              report.memory.reachable
                ? t('diagnostics.memoryValue', {
                    version: report.memory.version ?? t('diagnostics.unknownVersion'),
                    notes: report.memory.notes ?? '?',
                    url: report.memory.url,
                  })
                : t('diagnostics.memoryDown', { url: report.memory.url }),
            )}
          </dl>
          <h3>{t('diagnostics.agents')}</h3>
          <dl>
            {report.providers.map((p) =>
              field(
                p.id,
                t('diagnostics.providerValue', {
                  status: p.available ? t('diagnostics.providerAvailable') : t('diagnostics.providerUnavailable'),
                  models: p.models,
                  version: p.version ?? t('diagnostics.unknownVersion'),
                }) + (p.binary ? ` · ${p.binary}` : ''),
              ),
            )}
          </dl>
          {!report.memory.reachable && report.memory.detail && (
            <p className="diagnostics-note">{report.memory.detail}</p>
          )}
        </div>
      )}
    </section>
  );
}
