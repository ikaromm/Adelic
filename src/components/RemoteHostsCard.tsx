import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, KeyRound, LoaderCircle, Plus, RefreshCw, Server, ShieldAlert, Trash2, X } from 'lucide-react';
import type { RemoteHost, RemoteProbe } from '../../shared/remote-hosts';
import { api } from '../api';
import { useI18n } from '../i18n';

const loopback = () => ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);

export function RemoteHostsCard() {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('22');
  const [name, setName] = useState('');
  const [runnerPath, setRunnerPath] = useState('');
  const [probe, setProbe] = useState<RemoteProbe | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [installAck, setInstallAck] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setHosts(await api.remoteHosts());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await work();
      if (result && typeof result === 'object' && 'detail' in result) setNotice(String(result.detail));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const onProbe = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('probe');
    setError('');
    setNotice('');
    setTrusted(false);
    try {
      const result = await api.probeRemoteHost({ target: target.trim(), port: Number(port) });
      setProbe(result);
      if (!name.trim()) setName(result.hostname);
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
    try {
      await api.createRemoteHost({
        name: name.trim(),
        target: probe.target,
        port: probe.port,
        fingerprint: probe.fingerprint,
        hostKey: probe.hostKey,
        runnerPath: runnerPath.trim(),
      });
      setProbe(null);
      setTrusted(false);
      setTarget('');
      setName('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const local = loopback();
  return (
    <section className="settings-card remote-hosts-card" aria-labelledby="remote-hosts-title">
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
        <div className="inline-notice" role="status">
          {notice}
        </div>
      )}
      <div className="remote-host-list">
        {hosts.map((host) => (
          <article className="remote-host-row" key={host.id}>
            <div className="remote-host-info">
              <strong>{host.name}</strong>
              <span>
                {host.target}:{host.port}
              </span>
              <code>{host.fingerprint}</code>
              <small>
                {t('remoteHosts.runnerPath')}: {host.runnerPath}
              </small>
            </div>
            <div className="remote-host-actions">
              <button
                className="secondary-button"
                disabled={!local || Boolean(busy)}
                onClick={() => void act(`${host.id}:test`, () => api.testRemoteHost(host.id))}
              >
                {busy === `${host.id}:test` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{' '}
                {t('remoteHosts.test')}
              </button>
              <label className="remote-install-ack">
                <input
                  type="checkbox"
                  checked={installAck[host.id] ?? false}
                  disabled={!local || Boolean(busy)}
                  onChange={(event) => setInstallAck((current) => ({ ...current, [host.id]: event.target.checked }))}
                />
                {t('remoteHosts.installAck')}
              </label>
              <button
                className="secondary-button"
                disabled={!local || !installAck[host.id] || Boolean(busy)}
                onClick={() => void act(`${host.id}:install`, () => api.installRemoteHost(host.id))}
                title={t('remoteHosts.installWarning')}
              >
                {busy === `${host.id}:install` ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{' '}
                {t('remoteHosts.install')}
              </button>
              <button
                className="secondary-button"
                disabled={!local || Boolean(busy)}
                onClick={() => void act(`${host.id}:disconnect`, () => api.disconnectRemoteHost(host.id))}
              >
                {t('remoteHosts.disconnect')}
              </button>
              <button
                className="icon-button danger"
                aria-label={t('remoteHosts.delete')}
                disabled={!local || Boolean(busy)}
                onClick={() =>
                  window.confirm(t('remoteHosts.deleteConfirm', { name: host.name })) &&
                  void act(`${host.id}:delete`, () => api.deleteRemoteHost(host.id))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
            <small className="remote-install-warning">
              <ShieldAlert size={13} /> {t('remoteHosts.installWarning')}
            </small>
          </article>
        ))}
        {hosts.length === 0 && <p className="muted-empty">{t('remoteHosts.empty')}</p>}
      </div>
      <form className="remote-host-form" onSubmit={(event) => void onProbe(event)}>
        <h3>{t('remoteHosts.add')}</h3>
        <div className="remote-host-form-grid">
          <label>
            {t('remoteHosts.target')}
            <input
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setProbe(null);
                setTrusted(false);
              }}
              placeholder="dev@192.0.2.10"
              required
              disabled={!local}
            />
          </label>
          <label>
            {t('remoteHosts.port')}
            <input
              type="number"
              min="1"
              max="65535"
              value={port}
              onChange={(event) => {
                setPort(event.target.value);
                setProbe(null);
                setTrusted(false);
              }}
              required
              disabled={!local}
            />
          </label>
        </div>
        <button type="submit" className="secondary-button" disabled={!local || busy !== '' || !target.trim()}>
          {busy === 'probe' ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{' '}
          {t('remoteHosts.probe')}
        </button>
        {probe && (
          <div className="remote-probe-result" role="group" aria-label={t('remoteHosts.probeResult')}>
            <strong>{probe.hostname}</strong>
            <span>
              {probe.target}:{probe.port}
            </span>
            <div>
              <span>{t('remoteHosts.fingerprint')}</span>
              <code>{probe.fingerprint}</code>
            </div>
            <label className="remote-trust-check">
              <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
              {t('remoteHosts.trust')}
            </label>
            <label>
              {t('remoteHosts.name')}
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              {t('remoteHosts.runnerPath')}
              <input value={runnerPath} onChange={(event) => setRunnerPath(event.target.value)} required />
            </label>
            <p>{t('remoteHosts.installWarning')}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setProbe(null);
                  setTrusted(false);
                }}
              >
                <X size={14} /> {t('remoteHosts.cancel')}
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
      </form>
    </section>
  );
}
