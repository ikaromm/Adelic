import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { BrandMark } from './BrandMark';
import type { AccessKind, AuthStatus } from '../shared/remote-access';
import { useI18n } from './i18n';
import { localeHeaders } from './api';

const LOCAL: AuthStatus = { remote: false, authenticated: true, kind: 'local', login: 'none', token: false };

const AccessKindContext = createContext<AccessKind>('local');
/** Where this page is connected from, as classified by the server (/api/auth/status). */
export const useAccessKind = () => useContext(AccessKindContext);

/**
 * On this computer the app renders directly. Through the tailnet or the internet (Tailscale
 * Funnel) it asks for the account's username and password first (or, on the tailnet without an
 * account, the legacy ADELIC_REMOTE_TOKEN). The server sets an HttpOnly session cookie; nothing
 * secret stays in page storage (docs/specs/remote-access.md).
 */
export function RemoteGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [useToken, setUseToken] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    fetch('/api/auth/status', { headers: localeHeaders() })
      .then((r) => (r.ok ? (r.json() as Promise<AuthStatus>) : LOCAL))
      // An older server without /api/auth: behave as before (loopback only).
      .then((s) => setStatus({ ...LOCAL, ...s }))
      .catch(() => setStatus(LOCAL));
  }, []);
  if (!status) return null;
  if (status.authenticated)
    return <AccessKindContext.Provider value={status.kind}>{children}</AccessKindContext.Provider>;
  const tokenMode = status.login === 'token' || (useToken && status.token);
  const internet = status.kind === 'internet';
  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...localeHeaders() },
        body: JSON.stringify(tokenMode ? { token: password.trim() } : { username: username.trim(), password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? tokenMode
              ? t('auth.invalidToken')
              : t('auth.badCredentials')
            : response.status === 429
              ? t('auth.tooManyAttempts')
              : body.error || t('auth.failed', { status: response.status }),
        );
      setPassword('');
      setStatus({ ...status, authenticated: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (status.login === 'unavailable')
    return (
      <main className="remote-gate">
        <section aria-labelledby="remote-gate-title">
          <div className="remote-gate-brand">
            <BrandMark /> adelic
          </div>
          <h1 id="remote-gate-title">{t('auth.unavailable.title')}</h1>
          <p>{t('auth.unavailable.body')}</p>
        </section>
      </main>
    );
  return (
    <main className="remote-gate">
      <form onSubmit={(e) => void login(e)} aria-labelledby="remote-gate-title">
        <div className="remote-gate-brand">
          <BrandMark /> adelic
        </div>
        <h1 id="remote-gate-title">{t('auth.title')}</h1>
        <p>{tokenMode ? t('auth.hint.token') : internet ? t('auth.hint.internet') : t('auth.hint.remote')}</p>
        {!tokenMode && (
          <label>
            {t('auth.username')}
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </label>
        )}
        <label>
          {tokenMode ? t('auth.token') : t('auth.password')}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus={tokenMode}
          />
        </label>
        {error && (
          <div className="inline-notice error-notice" role="alert">
            {error}
          </div>
        )}
        <button className="primary-button" disabled={busy || !password || (!tokenMode && !username.trim())}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} {t('auth.submit')}
        </button>
        {status.login === 'password' && status.token && (
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setUseToken(!useToken);
              setError('');
              setPassword('');
            }}
          >
            {useToken ? t('auth.usePassword') : t('auth.useToken')}
          </button>
        )}
      </form>
    </main>
  );
}
