import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Globe, LoaderCircle, LogOut, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { api, type ApiError } from '../api';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  passwordHintKeys,
  passwordProblemKeys,
  usernameProblemKey,
  type RemoteAccessState,
  type TailscaleState,
} from '../../shared/remote-access';
import { t, useI18n } from '../i18n';

const kindKey = { tailnet: 'remoteAccess.kind.tailnet', internet: 'remoteAccess.kind.internet' } as const;
const reasonKey = {
  credentials: 'remoteAccess.reason.credentials',
  'rate-limit': 'remoteAccess.reason.rateLimit',
  'no-account': 'remoteAccess.reason.noAccount',
} as const;
/** Limits interpolated into the translated account rules. */
const usernameVars = { min: USERNAME_MIN, max: USERNAME_MAX };
const passwordVars = { min: PASSWORD_MIN, max: PASSWORD_MAX };

/** Short device name from a user agent ("Firefox · Android"), never the whole string. */
export function deviceLabel(userAgent: string) {
  if (!userAgent) return t('remoteAccess.unknownDevice');
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : /curl\//.test(userAgent)
            ? 'curl'
            : '';
  const system = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return [browser, system].filter(Boolean).join(' · ') || userAgent.slice(0, 40);
}

/**
 * Settings › "Acesso remoto" (docs/specs/remote-access.md): the owner account, active sessions,
 * last logins, manual approval from the internet and the Tailscale Funnel switch. Credentials and
 * Funnel can only change from this computer; remote clients see the sessions and can log out.
 */
export function RemoteAccessCard({
  internetManualApproval,
  onInternetManualApproval,
}: {
  internetManualApproval: boolean;
  onInternetManualApproval: (enabled: boolean) => void;
}) {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setState(await api.remoteAccess());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (name: string, work: () => Promise<RemoteAccessState | void>) => {
    setBusy(name);
    setError('');
    try {
      const next = await work();
      if (next) setState(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const { t } = useI18n();
  const local = state?.kind === 'local';
  return (
    <section className="settings-card remote-access-card" aria-labelledby="remote-access-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon green">
          <Globe size={17} />
        </div>
        <div>
          <h2 id="remote-access-title">{t('remoteAccess.title')}</h2>
          <p>{t('remoteAccess.detail')}</p>
        </div>
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {!state ? (
        !error && <p className="remote-muted">{t('remoteAccess.loading')}</p>
      ) : (
        <>
          <AccountSection state={state} local={local} busy={busy} act={act} />
          <div className="setting-row">
            <div>
              <strong>{t('remoteAccess.manualApproval')}</strong>
              <span>{t('remoteAccess.manualApprovalDetail')}</span>
            </div>
            <button
              className={`toggle ${internetManualApproval ? 'on' : ''}`}
              role="switch"
              aria-checked={internetManualApproval}
              aria-label={t('remoteAccess.manualApproval')}
              disabled={!local}
              onClick={() => onInternetManualApproval(!internetManualApproval)}
            >
              <span />
            </button>
          </div>
          {state.funnel && local && <FunnelSection state={state} onChanged={setState} />}
          <SessionsSection state={state} busy={busy} act={act} />
          <LoginsSection state={state} />
        </>
      )}
    </section>
  );
}

type Act = (name: string, work: () => Promise<RemoteAccessState | void>) => Promise<void>;

function AccountSection({
  state,
  local,
  busy,
  act,
}: {
  state: RemoteAccessState;
  local: boolean;
  busy: string;
  act: Act;
}) {
  const { t, fmt } = useI18n();
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState(state.account?.username ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const hintsId = useId();
  const userProblemKey = username ? usernameProblemKey(username) : undefined;
  const userProblem = userProblemKey && t(`remoteAccess.problem.${userProblemKey}`, usernameVars);
  const problems = (password ? passwordProblemKeys(username, password) : []).map((key) =>
    t(`remoteAccess.problem.${key}`, passwordVars),
  );
  const hintKeys = passwordHintKeys(password);
  const score = hintKeys.score;
  const hints = hintKeys.hints.map((key) => t(`remoteAccess.hint.${key}`));
  const mismatch = Boolean(confirm) && confirm !== password;
  const valid = !usernameProblemKey(username) && password && !problems.length && confirm === password;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    void act('account', async () => {
      const next = await api.setRemoteAccount(username, password);
      setPassword('');
      setConfirm('');
      setEditing(false);
      return next;
    });
  };
  return (
    <>
      <div className="setting-row">
        <div>
          <strong>
            {state.account
              ? t('remoteAccess.account', { username: state.account.username })
              : t('remoteAccess.noAccount')}
          </strong>
          <span>
            {state.account
              ? t('remoteAccess.passwordChanged', { date: fmt.dateTime(state.account.passwordChangedAt) })
              : local
                ? t('remoteAccess.createFirst')
                : t('remoteAccess.localOnly')}
            {state.tailnet && t('remoteAccess.tailnet', { url: state.tailnet.url })}
          </span>
        </div>
        {local && !editing && (
          <div className="remote-row-actions">
            <button type="button" className="secondary-button" onClick={() => setEditing(true)}>
              {state.account ? t('remoteAccess.changePassword') : t('remoteAccess.createAccount')}
            </button>
            {state.account && (
              <button
                type="button"
                className="danger-button"
                disabled={busy === 'delete'}
                onClick={() => {
                  if (window.confirm(t('remoteAccess.deleteConfirm')))
                    void act('delete', () => api.deleteRemoteAccount());
                }}
              >
                {t('remoteAccess.deleteAccount')}
              </button>
            )}
          </div>
        )}
      </div>
      {local && editing && (
        <form className="remote-account-form" onSubmit={submit} aria-label={t('remoteAccess.form')}>
          <label>
            {t('remoteAccess.username')}
            <input
              name="remote-username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value.trim().toLowerCase())}
              aria-invalid={Boolean(userProblem)}
              required
            />
          </label>
          {userProblem && <p className="remote-problem">{userProblem}</p>}
          <label>
            {t('remoteAccess.newPassword')}
            <input
              name="remote-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={hintsId}
              aria-invalid={problems.length > 0}
              required
            />
          </label>
          <div id={hintsId} className="remote-hints" aria-live="polite">
            {password ? (
              <>
                <span className={`remote-strength s${problems.length ? 0 : score}`}>
                  {t('remoteAccess.strength', {
                    level: t(`remoteAccess.strength.${problems.length ? 0 : score}`),
                  })}
                </span>
                {[...problems, ...hints].map((text) => (
                  <span key={text}>{text}</span>
                ))}
              </>
            ) : (
              <span>{t('remoteAccess.passwordRule', { min: PASSWORD_MIN })}</span>
            )}
          </div>
          <label>
            {t('remoteAccess.repeatPassword')}
            <input
              name="remote-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch}
              required
            />
          </label>
          {mismatch && <p className="remote-problem">{t('remoteAccess.mismatch')}</p>}
          <div className="remote-row-actions">
            <button type="button" className="secondary-button" onClick={() => setEditing(false)}>
              {t('remoteAccess.cancel')}
            </button>
            <button className="primary-button" disabled={!valid || busy === 'account'}>
              {busy === 'account' && <LoaderCircle size={14} className="spin" />} {t('remoteAccess.saveAccount')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function FunnelSection({
  state,
  onChanged,
}: {
  state: RemoteAccessState;
  onChanged: (state: RemoteAccessState) => void;
}) {
  const { t } = useI18n();
  const [tailscale, setTailscale] = useState<TailscaleState | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<{ text: string; url?: string } | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setTailscale(await api.tailscale());
    } catch (e) {
      setFailure({ text: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  const toggle = async (enabled: boolean) => {
    setWorking(true);
    setFailure(null);
    try {
      const result = await api.setFunnel(enabled);
      setTailscale(result.tailscale);
      onChanged(result.state);
      setConfirming(false);
    } catch (e) {
      setFailure({ text: (e as Error).message, url: (e as ApiError).url });
      setConfirming(false);
    } finally {
      setWorking(false);
    }
  };
  const on = tailscale?.funnelOn === true;
  const ready = Boolean(tailscale?.loggedIn && tailscale.https && tailscale.funnelAllowed && tailscale.port443Allowed);
  const lastError = failure?.text ?? state.funnel?.lastError;
  return (
    <div className="remote-funnel">
      <div className="setting-row">
        <div>
          <strong>{t('remoteAccess.funnel.title')}</strong>
          <span>
            {on
              ? t('remoteAccess.funnel.on', { url: tailscale!.publicUrl ?? '' })
              : t('remoteAccess.funnel.off', {
                  host: tailscale?.dnsName ?? t('remoteAccess.funnel.hostPlaceholder'),
                  port: state.funnel!.port,
                })}
          </span>
        </div>
        <div className="remote-row-actions">
          <button type="button" className="ghost-button" onClick={() => void check()} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'spin' : undefined} /> {t('remoteAccess.funnel.check')}
          </button>
          {on ? (
            <button type="button" className="danger-button" disabled={working} onClick={() => void toggle(false)}>
              {working && <LoaderCircle size={14} className="spin" />} {t('remoteAccess.funnel.turnOff')}
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={!state.account || working || !tailscale?.installed || !tailscale.loggedIn}
              title={!state.account ? t('remoteAccess.funnel.accountFirst') : undefined}
              onClick={() => setConfirming(true)}
            >
              {t('remoteAccess.funnel.publish')}
            </button>
          )}
        </div>
      </div>
      {tailscale && (
        <dl className="remote-status" aria-label={t('remoteAccess.status.label')}>
          <div>
            <dt>Tailscale</dt>
            <dd>
              {tailscale.installed
                ? t('remoteAccess.status.installed', { version: tailscale.version ?? '?' })
                : t('remoteAccess.status.notFound')}
            </dd>
          </div>
          <div>
            <dt>{t('remoteAccess.status.connected')}</dt>
            <dd>
              {tailscale.loggedIn
                ? t('remoteAccess.status.yes')
                : (tailscale.backendState ?? t('remoteAccess.status.no'))}
            </dd>
          </div>
          <div>
            <dt>{t('remoteAccess.status.name')}</dt>
            <dd>{tailscale.dnsName ?? '—'}</dd>
          </div>
          <div>
            <dt>HTTPS</dt>
            <dd>{tailscale.https ? t('remoteAccess.status.allowed') : t('remoteAccess.status.notAllowed')}</dd>
          </div>
          <div>
            <dt>Funnel</dt>
            <dd>
              {tailscale.funnelAllowed
                ? tailscale.port443Allowed
                  ? t('remoteAccess.status.allowed')
                  : t('remoteAccess.status.port443')
                : t('remoteAccess.status.notAllowed')}
            </dd>
          </div>
          <div>
            <dt>{t('remoteAccess.status.state')}</dt>
            <dd>
              {on
                ? t('remoteAccess.status.published')
                : tailscale.stale
                  ? t('remoteAccess.status.stale')
                  : t('remoteAccess.status.off')}
            </dd>
          </div>
        </dl>
      )}
      {tailscale?.conflict && (
        <p className="remote-problem">
          {t('remoteAccess.funnel.conflict', { host: tailscale.dnsName ?? '', target: tailscale.conflict })}
        </p>
      )}
      {tailscale && !ready && tailscale.requirements.length > 0 && (
        <ul className="remote-requirements" aria-label={t('remoteAccess.funnel.requirements')}>
          {tailscale.requirements.map((item) => (
            <li key={item.text}>
              {item.text}{' '}
              {item.url && (
                <a href={item.url} target="_blank" rel="noreferrer">
                  {t('remoteAccess.funnel.openConsole')} <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {lastError && (
        <div className="inline-notice error-notice" role="alert">
          <span>
            {lastError}{' '}
            {failure?.url && (
              <a href={failure.url} target="_blank" rel="noreferrer">
                {t('remoteAccess.funnel.openTailscaleConsole')}
              </a>
            )}
          </span>
        </div>
      )}
      {confirming && (
        <FunnelConfirm
          url={tailscale?.publicUrl}
          working={working}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void toggle(true)}
        />
      )}
    </div>
  );
}

function FunnelConfirm({
  url,
  working,
  onCancel,
  onConfirm,
}: {
  url?: string;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !working) onCancel();
      }}
    >
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="funnel-confirm-title"
        aria-describedby="funnel-confirm-detail"
      >
        <div className="modal-heading">
          <div className="project-avatar" aria-hidden="true">
            <ShieldAlert size={18} />
          </div>
          <div>
            <h2 id="funnel-confirm-title">{t('remoteAccess.confirm.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('remoteAccess.confirm.close')}
            onClick={onCancel}
            disabled={working}
          >
            <X size={17} />
          </button>
        </div>
        <div id="funnel-confirm-detail" className="restore-detail">
          <p>{url ? t('remoteAccess.confirm.detail', { url }) : t('remoteAccess.confirm.detailNoUrl')}</p>
          <ul>
            <li>{t('remoteAccess.confirm.password')}</li>
            <li>{t('remoteAccess.confirm.blocked')}</li>
            <li>{t('remoteAccess.confirm.public')}</li>
          </ul>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={working}>
            {t('remoteAccess.cancel')}
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={working}>
            {working && <LoaderCircle size={14} className="spin" />} {t('remoteAccess.confirm.publish')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionsSection({ state, busy, act }: { state: RemoteAccessState; busy: string; act: Act }) {
  const { t, fmt } = useI18n();
  const local = state.kind === 'local';
  return (
    <div className="remote-list-block">
      <div className="remote-list-heading">
        <h3>{t('remoteAccess.sessions')}</h3>
        {state.sessions.length > 0 && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy === 'all'}
            onClick={() =>
              void act('all', async () => {
                const next = await api.revokeRemoteSessions();
                // Our own session ended too: back to the login screen.
                if (!local) window.location.reload();
                return next;
              })
            }
          >
            {t('remoteAccess.endAll')}
          </button>
        )}
      </div>
      {state.sessions.length ? (
        <ul className="remote-list" aria-label={t('remoteAccess.sessions')}>
          {state.sessions.map((session) => (
            <li key={session.id}>
              <div>
                <strong>
                  {deviceLabel(session.userAgent)}
                  {session.current && <span className="count-chip">{t('remoteAccess.thisSession')}</span>}
                </strong>
                <span>
                  {t('remoteAccess.sessionLine', {
                    kind: t(kindKey[session.kind]),
                    ip: session.ip,
                    date: fmt.dateTime(session.lastSeenAt),
                  })}
                  {session.method === 'token' && t('remoteAccess.tokenSuffix')}
                </span>
              </div>
              {session.current ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void act('logout', async () => {
                      await api.logout();
                      window.location.reload();
                    })
                  }
                >
                  <LogOut size={14} /> {t('remoteAccess.logout')}
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={t('remoteAccess.endSession', { device: deviceLabel(session.userAgent), ip: session.ip })}
                  disabled={busy === session.id}
                  onClick={() => void act(session.id, () => api.revokeRemoteSession(session.id))}
                >
                  {t('remoteAccess.end')}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="remote-muted">{t('remoteAccess.noSessions')}</p>
      )}
    </div>
  );
}

function LoginsSection({ state }: { state: RemoteAccessState }) {
  const { t, fmt } = useI18n();
  if (!state.logins.length) return null;
  return (
    <details className="remote-list-block">
      <summary>{t('remoteAccess.loginsCount', { count: state.logins.length })}</summary>
      <ul className="remote-list compact" aria-label={t('remoteAccess.logins')}>
        {state.logins.map((login, index) => (
          <li key={`${login.at}-${index}`}>
            <div>
              <strong className={login.ok ? 'remote-ok' : 'remote-fail'}>
                {login.ok
                  ? t('remoteAccess.loginOk')
                  : t('remoteAccess.loginFailed', {
                      reason: t(login.reason ? reasonKey[login.reason] : 'remoteAccess.reason.error'),
                    })}
                {login.username && ` · ${login.username}`}
              </strong>
              <span>
                {fmt.dateTime(login.at)} · {t(kindKey[login.kind])} · {login.ip} · {deviceLabel(login.userAgent)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
