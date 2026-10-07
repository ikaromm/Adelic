import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpCircle,
  Check,
  CircleAlert,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-react';
import type { SelfUpdateStatus, UpdateChannel, UpdateProgress } from '../../shared/contracts';
import { api, type ApiError } from '../api';
import { t, useI18n } from '../i18n';

const STEP_ICON = {
  pending: <span className="update-step-dot" aria-hidden="true" />,
  running: <LoaderCircle size={14} className="spin" aria-hidden="true" />,
  done: <Check size={14} aria-hidden="true" />,
  failed: <X size={14} aria-hidden="true" />,
  skipped: <span className="update-step-dot" aria-hidden="true" />,
};
const sleep = (ms: number) => new Promise((done) => window.setTimeout(done, ms));
/** Set before the reload that follows a restart, so the card can say it worked. */
const UPDATED_KEY = 'adelic:updated';
function takeUpdated() {
  try {
    const value = sessionStorage.getItem(UPDATED_KEY);
    sessionStorage.removeItem(UPDATED_KEY);
    return value;
  } catch {
    return null;
  }
}

/** What "Atualizar agora" will do, for the confirmation dialog. */
function plan(status: SelfUpdateStatus) {
  if (status.kind === 'appimage' && status.release)
    return [
      status.release.size
        ? t('selfUpdate.plan.downloadSize', {
            version: status.release.latest,
            size: Math.round(status.release.size / 1024 / 1024),
          })
        : t('selfUpdate.plan.download', { version: status.release.latest }),
      t('selfUpdate.plan.verify'),
      t('selfUpdate.plan.replace'),
      t('selfUpdate.plan.restartApp'),
    ];
  const c = status.checkout;
  if (!c) return [];
  return [
    ...(c.switchTo ? [t('selfUpdate.plan.switch', { branch: c.switchTo })] : []),
    t('selfUpdate.plan.merge', { channel: status.channel, count: c.behind }),
    ...(c.install ? [t('selfUpdate.plan.install')] : []),
    t('selfUpdate.plan.build'),
    t('selfUpdate.plan.restartServer'),
  ];
}

/**
 * "Atualizar Adelic" in Settings › Diagnóstico (docs/specs/self-update.md): version, install
 * kind, channel, check and, when possible, an update with confirmation, live steps and the
 * reconnection after the restart.
 */
export function SelfUpdate({
  channel,
  onChannel,
}: {
  channel: UpdateChannel;
  onChannel: (channel: UpdateChannel) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SelfUpdateStatus | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  /** Opened through the remote access: updates happen only on this computer (403). */
  const [remote, setRemote] = useState(false);
  const [updated] = useState(takeUpdated);
  const watching = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.updateStatus();
      setStatus(next);
      setError('');
      if (next.busy) setProgress(await api.updateProgress());
    } catch (e) {
      if ((e as ApiError).status === 403) setRemote(true);
      else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, channel]);

  /** After the restart: wait for a new server process, then reload into the new version. */
  const reconnect = useCallback(
    async (bootId: string) => {
      setReconnecting(true);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await sleep(1000);
        try {
          const next = await api.updateStatus();
          if (next.bootId !== bootId) {
            try {
              sessionStorage.setItem(UPDATED_KEY, next.commit ?? next.version);
            } catch {
              /* Storage off: the reload alone still shows the new version. */
            }
            window.location.reload();
            return;
          }
        } catch {
          /* Down while it restarts. */
        }
      }
      setReconnecting(false);
      setError(t('selfUpdate.noReturn'));
    },
    [t],
  );

  const watch = useCallback(
    async (bootId: string) => {
      if (watching.current) return;
      watching.current = true;
      try {
        for (;;) {
          let next: UpdateProgress;
          try {
            next = await api.updateProgress();
          } catch {
            // The server went away: it is restarting.
            setProgress((p) => (p ? { ...p, state: 'restarting' } : p));
            await reconnect(bootId);
            return;
          }
          setProgress(next);
          if (next.state === 'failed') {
            void load();
            return;
          }
          if (next.state === 'restarting') {
            await reconnect(bootId);
            return;
          }
          await sleep(700);
        }
      } finally {
        watching.current = false;
      }
    },
    [load, reconnect],
  );
  useEffect(() => {
    if (status?.busy && !watching.current) void watch(status.bootId);
  }, [status, watch]);

  const check = async () => {
    setChecking(true);
    setError('');
    try {
      setStatus(await api.updateCheck(channel));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const apply = async () => {
    if (!status) return;
    setConfirming(false);
    setError('');
    try {
      setProgress(await api.updateApply({ channel, target: status.target }));
      void watch(status.bootId);
    } catch (e) {
      setError((e as Error).message);
      void load();
    }
  };

  const running = progress?.state === 'running' || progress?.state === 'restarting' || reconnecting;
  if (remote)
    return (
      <div className="setting-row">
        <div>
          <strong>{t('selfUpdate.title')}</strong>
          <span>{t('selfUpdate.remoteOnly')}</span>
        </div>
      </div>
    );
  const c = status?.checkout;
  const current = status ? `${status.version}${status.commit ? ` · ${status.commit}` : ''}` : '…';
  return (
    <div className="self-update" aria-labelledby="self-update-title">
      <div className="setting-row">
        <div>
          <strong id="self-update-title">{t('selfUpdate.title')}</strong>
          <span>
            {t('selfUpdate.version', { version: current })}
            {status ? ` · ${t(`selfUpdate.kind.${status.kind}`)}` : ''}
            {c?.branch !== undefined ? t('selfUpdate.branch', { branch: c.branch ?? t('selfUpdate.noBranch') }) : ''}
          </span>
        </div>
        <button type="button" className="secondary-button" onClick={() => void check()} disabled={checking || running}>
          {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} {t('selfUpdate.check')}
        </button>
      </div>
      {status?.kind === 'checkout' && (
        <div className="setting-row">
          <div>
            <strong>{t('selfUpdate.channel')}</strong>
            <span>{t('selfUpdate.channelDetail')}</span>
          </div>
          <select
            aria-label={t('selfUpdate.channel')}
            value={channel}
            disabled={running}
            onChange={(event) => onChannel(event.target.value as UpdateChannel)}
          >
            <option value="master">{t('selfUpdate.channel.master')}</option>
            <option value="develop">{t('selfUpdate.channel.develop')}</option>
          </select>
        </div>
      )}
      {updated && (
        <p className="update-line" role="status">
          <Check size={14} aria-hidden="true" /> {t('selfUpdate.updated', { version: updated })}
        </p>
      )}
      {status && (
        <div className="update-summary" role="status">
          {status.error && <p className="update-line error-text">{status.error}</p>}
          {status.available ? (
            <p className="update-line">
              <ArrowUpCircle size={14} aria-hidden="true" />
              {status.kind === 'checkout' && c
                ? c.switchTo
                  ? c.behind
                    ? t('selfUpdate.switchAndMerge', { branch: c.switchTo, count: c.behind })
                    : t('selfUpdate.switchTo', { branch: c.switchTo })
                  : t('selfUpdate.newCommits', { count: c.behind, channel: status.channel })
                : t('selfUpdate.newVersion', { version: status.release?.latest ?? '' })}
            </p>
          ) : (
            status.checkedAt &&
            !status.error &&
            !status.blocked && <p className="update-line">{t('selfUpdate.upToDate')}</p>
          )}
          {c && c.commits.length > 0 && (
            <ul className="update-commits" aria-label={t('selfUpdate.commits')}>
              {c.commits.map((commit) => (
                <li key={commit.hash}>
                  <code>{commit.hash}</code> {commit.subject}
                </li>
              ))}
              {c.behind > c.commits.length && (
                <li className="update-more">{t('selfUpdate.more', { count: c.behind - c.commits.length })}</li>
              )}
            </ul>
          )}
          {status.blocked && (
            <p className="update-line warning-text">
              <CircleAlert size={14} aria-hidden="true" /> {status.blocked}
            </p>
          )}
          <div className="diagnostics-actions">
            {status.canApply && !running && (
              <button type="button" className="primary-button" onClick={() => setConfirming(true)}>
                <ArrowUpCircle size={14} /> {t('selfUpdate.apply')}
              </button>
            )}
            <a
              className="update-release-link"
              href={status.release?.url ?? status.releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t('selfUpdate.releasePage')} <ExternalLink size={12} />
            </a>
          </div>
        </div>
      )}
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {progress && progress.state !== 'idle' && (
        <div className="update-progress" aria-live="polite">
          <ol aria-label={t('selfUpdate.steps')}>
            {progress.steps
              .filter((step) => step.status !== 'skipped')
              .map((step) => (
                <li
                  key={step.id}
                  className={`update-step ${step.status}`}
                  aria-label={t('selfUpdate.stepLabel', {
                    step: t(`selfUpdate.step.${step.id}`),
                    status: t(`selfUpdate.stepStatus.${step.status}`),
                  })}
                >
                  {STEP_ICON[step.status]}
                  <span>{t(`selfUpdate.step.${step.id}`)}</span>
                </li>
              ))}
          </ol>
          {(progress.state === 'restarting' || reconnecting) && (
            <p className="update-line" role="status">
              <RotateCw size={14} className="spin" aria-hidden="true" /> {t('selfUpdate.restarting')}
            </p>
          )}
          {progress.state === 'failed' && (
            <p className="update-line error-text" role="alert">
              {t('selfUpdate.failed', { error: progress.error ?? '' })}
            </p>
          )}
          {progress.log && (
            <details>
              <summary>{t('selfUpdate.output')}</summary>
              <pre className="update-log">{progress.log}</pre>
            </details>
          )}
        </div>
      )}
      {confirming && status && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setConfirming(false)}
          onKeyDown={(event) => event.key === 'Escape' && setConfirming(false)}
        >
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="update-confirm-title">
            <div className="modal-heading">
              <div className="project-avatar" aria-hidden="true">
                {status.kind === 'checkout' ? <GitBranch size={17} /> : <ArrowUpCircle size={17} />}
              </div>
              <div>
                <h2 id="update-confirm-title">{t('selfUpdate.confirm.title')}</h2>
                <p>{t('selfUpdate.confirm.detail')}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={t('selfUpdate.confirm.close')}
                onClick={() => setConfirming(false)}
              >
                <X size={17} />
              </button>
            </div>
            <ol className="update-plan">
              {plan(status).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
            {c && c.commits.length > 0 && (
              <ul className="update-commits">
                {c.commits.map((commit) => (
                  <li key={commit.hash}>
                    <code>{commit.hash}</code> {commit.subject}
                  </li>
                ))}
              </ul>
            )}
            <p className="modal-note">{t('selfUpdate.confirm.rollback')}</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>
                {t('selfUpdate.confirm.cancel')}
              </button>
              <button type="button" className="primary-button" autoFocus onClick={() => void apply()}>
                {t('selfUpdate.confirm.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
