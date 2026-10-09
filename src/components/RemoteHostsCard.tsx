import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  ChevronRight,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type { RemoteHost, RemoteProbe } from '../../shared/remote-hosts';
import { api } from '../api';
import { useI18n } from '../i18n';

const loopback = () => ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
type Stage = 1 | 2 | 3 | 4;
type HostState = 'unknown' | 'installed' | 'ready';

export function RemoteHostsCard({ onChooseProject }: { onChooseProject?: () => void }) {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('');
  const [aliases, setAliases] = useState<string[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState('');
  const [name, setName] = useState('');
  const [runnerPath, setRunnerPath] = useState('');
  const [probe, setProbe] = useState<RemoteProbe | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [stage, setStage] = useState<Stage>(1);
  const [activeHost, setActiveHost] = useState('');
  const [states, setStates] = useState<Record<string, HostState>>({});
  const [installAck, setInstallAck] = useState<Record<string, boolean>>({});
  const local = loopback();

  const load = useCallback(async () => {
    try {
      setHosts(await api.remoteHosts());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const loadConfig = useCallback(async () => {
    if (!local) return;
    setConfigLoading(true);
    setConfigError('');
    try {
      setAliases((await api.sshConfigHosts()).aliases);
    } catch (e) {
      setConfigError((e as Error).message);
    } finally {
      setConfigLoading(false);
    }
  }, [local]);
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const act = async (key: string, work: () => Promise<unknown>, done?: () => void) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'detail' in result) setNotice(String(result.detail));
      await load();
      done?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const onProbe = async (event: FormEvent) => {
    event.preventDefault();
    if (stage !== 1) return;
    setBusy('probe');
    setError('');
    setNotice('');
    setTrusted(false);
    try {
      const found = await api.probeRemoteHost({
        target: target.trim(),
        ...(port.trim() ? { port: Number(port) } : {}),
      });
      setProbe(found);
      if (!name.trim()) setName(found.hostname);
      setStage(2);
    } catch (e) {
      setProbe(null);
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const onSave = async () => {
    if (!probe || !trusted) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const saved = await api.createRemoteHost({
        name: name.trim(),
        target: probe.target,
        port: probe.port,
        fingerprint: probe.fingerprint,
        hostKey: probe.hostKey,
        runnerPath: runnerPath.trim(),
      });
      await load();
      setActiveHost(saved.id);
      setStates((s) => ({ ...s, [saved.id]: 'unknown' }));
      setProbe(null);
      setTrusted(false);
      setStage(3);
      setNotice(t('remoteHosts.saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const runHostAction = (host: RemoteHost, action: 'test' | 'install') => {
    const key = `${host.id}:${action}`;
    setActiveHost(host.id);
    setStage(3);
    setStates((s) => ({ ...s, [host.id]: 'unknown' }));
    void act(
      key,
      () => (action === 'test' ? api.testRemoteHost(host.id) : api.installRemoteHost(host.id)),
      () => {
        setActiveHost(host.id);
        setStates((s) => ({ ...s, [host.id]: action === 'test' ? 'ready' : 'installed' }));
        if (action === 'test') {
          setStage(4);
          setNotice(t('remoteHosts.ready'));
        } else setStage(3);
      },
    );
  };
  const primary = (_host: RemoteHost) => 'test' as const;

  const restart = () => {
    setStage(1);
    setActiveHost('');
    setTarget('');
    setPort('');
    setName('');
    setRunnerPath('');
    setProbe(null);
    setTrusted(false);
    setError('');
    setNotice('');
  };

  return (
    <section className="settings-card remote-hosts-card ssh-setup" aria-labelledby="remote-hosts-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon blue">
          <Server size={17} />
        </div>
        <div>
          <h2 id="remote-hosts-title">{t('remoteHosts.title')}</h2>
          <p>{t('remoteHosts.detail')}</p>
        </div>
      </div>
      {!local && <div className="inline-notice">{t('remoteHosts.localOnly')}</div>}
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="inline-notice" role="status" aria-live="polite">
          {notice}
        </div>
      )}

      <ol className="ssh-setup-steps" aria-label={t('remoteHosts.steps')}>
        {([1, 2, 3, 4] as const).map((step) => (
          <li
            key={step}
            aria-current={stage === step ? 'step' : undefined}
            className={stage === step ? 'is-current' : stage > step ? 'is-done' : ''}
          >
            <span>{stage > step ? <Check size={14} /> : step}</span>
            {t(`remoteHosts.step${step}`)}
          </li>
        ))}
      </ol>

      <div className="remote-host-list">
        {hosts.map((host) => {
          const state = states[host.id] ?? 'unknown';
          const action = primary(host);
          return (
            <article className="remote-host-row" key={host.id}>
              <div className="remote-host-info">
                <strong>{host.name}</strong>
                <span className="ssh-ellipsis">
                  {host.target}:{host.port}
                </span>
                <span className="ssh-host-state">{t(`remoteHosts.state.${state}`)}</span>
              </div>
              <button
                type="button"
                className="primary-button ssh-primary-action"
                disabled={!local || Boolean(busy)}
                onClick={() => runHostAction(host, action)}
              >
                {busy === `${host.id}:${action}` ? (
                  <LoaderCircle className="spin" size={14} />
                ) : action === 'test' ? (
                  <RefreshCw size={14} />
                ) : (
                  <Plus size={14} />
                )}{' '}
                {t(`remoteHosts.${action}`)}
              </button>
              <details className="ssh-host-details">
                <summary>{t('remoteHosts.moreActions')}</summary>
                <div className="ssh-details-content">
                  <small>
                    <span>{t('remoteHosts.fingerprint')}</span> <code className="ssh-ellipsis">{host.fingerprint}</code>
                  </small>
                  <small className="ssh-ellipsis">
                    {t('remoteHosts.runnerPath')}: {host.runnerPath}
                  </small>
                  <label className="remote-install-ack">
                    <input
                      type="checkbox"
                      checked={installAck[host.id] ?? false}
                      disabled={!local || Boolean(busy)}
                      onChange={(e) => setInstallAck((s) => ({ ...s, [host.id]: e.target.checked }))}
                    />
                    {t('remoteHosts.installAck')}
                  </label>
                  <p className="remote-install-warning">
                    <ShieldAlert size={13} /> {t('remoteHosts.installWarning')}
                  </p>
                  <div className="ssh-detail-buttons">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!local || !installAck[host.id] || Boolean(busy)}
                      onClick={() => runHostAction(host, 'install')}
                    >
                      {t('remoteHosts.install')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!local || Boolean(busy)}
                      onClick={() =>
                        void act(
                          `${host.id}:disconnect`,
                          () => api.disconnectRemoteHost(host.id),
                          () => {
                            setStates((s) => ({ ...s, [host.id]: 'unknown' }));
                            if (activeHost === host.id) {
                              setStage(3);
                              setNotice('');
                            }
                          },
                        )
                      }
                    >
                      {t('remoteHosts.disconnect')}
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={t('remoteHosts.delete')}
                      disabled={!local || Boolean(busy)}
                      onClick={() =>
                        window.confirm(t('remoteHosts.deleteConfirm', { name: host.name })) &&
                        void act(
                          `${host.id}:delete`,
                          () => api.deleteRemoteHost(host.id),
                          () => {
                            if (activeHost === host.id) restart();
                          },
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </details>
            </article>
          );
        })}
        {hosts.length === 0 && <p className="muted-empty">{t('remoteHosts.empty')}</p>}
      </div>

      <form className="remote-host-form" onSubmit={(event) => void onProbe(event)}>
        <h3>{t('remoteHosts.add')}</h3>
        {stage === 1 && (
          <>
            <div className="remote-config-picker">
              <label>
                {t('remoteHosts.sshConfig')}
                <select
                  value={aliases.includes(target) ? target : ''}
                  disabled={!local || configLoading || Boolean(busy)}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setName(e.target.value);
                    setPort('');
                    setProbe(null);
                    setTrusted(false);
                    setError('');
                    setNotice('');
                  }}
                >
                  <option value="">
                    {configLoading
                      ? t('remoteHosts.configLoading')
                      : aliases.length
                        ? t('remoteHosts.configChoose')
                        : t('remoteHosts.configEmpty')}
                  </option>
                  {aliases.map((alias) => (
                    <option value={alias} key={alias}>
                      {alias}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={!local || configLoading || Boolean(busy)}
                onClick={() => void loadConfig()}
              >
                <RefreshCw size={14} className={configLoading ? 'spin' : undefined} /> {t('remoteHosts.configRefresh')}
              </button>
            </div>
            {configError && (
              <div className="inline-notice error-notice" role="alert">
                {configError}
                <button type="button" className="secondary-button" onClick={() => void loadConfig()}>
                  {t('remoteHosts.retry')}
                </button>
              </div>
            )}
            <p className="remote-config-hint">{t('remoteHosts.configHint')}</p>
            <details className="ssh-manual-target">
              <summary>{t('remoteHosts.manualTarget')}</summary>
              <div className="remote-host-form-grid">
                <label>
                  {t('remoteHosts.target')}
                  <input
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      setProbe(null);
                      setTrusted(false);
                      setError('');
                      setNotice('');
                    }}
                    placeholder="dev@servidor"
                    required
                    disabled={!local || Boolean(busy)}
                  />
                </label>
                <label>
                  {t('remoteHosts.port')}
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={port}
                    onChange={(e) => {
                      setPort(e.target.value);
                      setProbe(null);
                      setTrusted(false);
                      setError('');
                      setNotice('');
                    }}
                    placeholder={t('remoteHosts.configPort')}
                    disabled={!local || Boolean(busy)}
                  />
                </label>
              </div>
            </details>
            <button type="submit" className="secondary-button" disabled={!local || Boolean(busy) || !target.trim()}>
              {busy === 'probe' ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{' '}
              {t('remoteHosts.probe')}
            </button>
          </>
        )}
        {stage === 2 && probe && (
          <div className="remote-probe-result" role="group" aria-label={t('remoteHosts.probeResult')}>
            <strong>{probe.hostname}</strong>
            <span className="ssh-ellipsis">
              {probe.target}:{probe.port}
            </span>
            <label>
              {t('remoteHosts.fingerprint')}
              <code className="ssh-fingerprint">{probe.fingerprint}</code>
            </label>
            <label className="remote-trust-check">
              <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
              {t('remoteHosts.trust')}
            </label>
            <label>
              {t('remoteHosts.name')}
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              {t('remoteHosts.runnerPath')}
              <input
                value={runnerPath}
                onChange={(e) => setRunnerPath(e.target.value)}
                placeholder="/home/usuario/.local/bin/adelic-runner"
                required
              />
            </label>
            <p>{t('remoteHosts.installWarning')}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setProbe(null);
                  setTrusted(false);
                  setStage(1);
                }}
              >
                <X size={14} /> {t('remoteHosts.back')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!local || !trusted || !name.trim() || !runnerPath.startsWith('/') || Boolean(busy)}
                onClick={() => void onSave()}
              >
                {busy === 'save' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{' '}
                {t('remoteHosts.saveTrusted')}
              </button>
            </div>
          </div>
        )}
        {stage >= 3 && activeHost && (
          <div className="ssh-next-step" role="status">
            <p>{stage === 4 ? t('remoteHosts.ready') : t('remoteHosts.prepareRunner')}</p>
            {stage === 3 && (
              <button
                type="button"
                className="secondary-button"
                disabled={!activeHost || Boolean(busy)}
                onClick={() => {
                  const host = hosts.find((h) => h.id === activeHost);
                  if (host) runHostAction(host, primary(host));
                }}
              >
                <ChevronRight size={14} /> {t('remoteHosts.continue')}
              </button>
            )}
            {stage === 4 && onChooseProject && (
              <button type="button" className="secondary-button" onClick={onChooseProject}>
                {t('remoteHosts.chooseProject')}
              </button>
            )}
            {(stage === 3 || stage === 4) && (
              <button type="button" className="secondary-button" onClick={restart}>
                {t('remoteHosts.addAnother')}
              </button>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
