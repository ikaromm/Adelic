import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { BrandMark } from './BrandMark';
import type { AuthStatus } from '../shared/remote-access';

const LOCAL: AuthStatus = { remote: false, authenticated: true, kind: 'local', login: 'none', token: false };

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
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => (r.ok ? (r.json() as Promise<AuthStatus>) : LOCAL))
      // An older server without /api/auth: behave as before (loopback only).
      .then((s) => setStatus({ ...LOCAL, ...s }))
      .catch(() => setStatus(LOCAL));
  }, []);
  if (!status) return null;
  if (status.authenticated) return <>{children}</>;
  const tokenMode = status.login === 'token' || (useToken && status.token);
  const internet = status.kind === 'internet';
  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tokenMode ? { token: password.trim() } : { username: username.trim(), password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? tokenMode
              ? 'Token inválido.'
              : 'Usuário ou senha incorretos.'
            : response.status === 429
              ? 'Muitas tentativas. Aguarde um minuto e tente de novo.'
              : body.error || `Falha no login (${response.status}).`,
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
          <h1 id="remote-gate-title">Acesso remoto indisponível</h1>
          <p>
            Nenhuma conta foi criada. No computador onde o Adelic roda, abra Configurações › Acesso remoto e defina um
            usuário e uma senha.
          </p>
        </section>
      </main>
    );
  return (
    <main className="remote-gate">
      <form onSubmit={(e) => void login(e)} aria-labelledby="remote-gate-title">
        <div className="remote-gate-brand">
          <BrandMark /> adelic
        </div>
        <h1 id="remote-gate-title">Entrar no Adelic</h1>
        <p>
          {tokenMode
            ? 'Informe o token configurado em ADELIC_REMOTE_TOKEN.'
            : internet
              ? 'Acesso pela internet. Entre com o usuário e a senha definidos neste Adelic.'
              : 'Acesso remoto. Entre com o usuário e a senha definidos neste Adelic.'}
        </p>
        {!tokenMode && (
          <label>
            Usuário
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
          {tokenMode ? 'Token de acesso' : 'Senha'}
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
          {busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} Entrar
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
            {useToken ? 'Entrar com usuário e senha' : 'Entrar com o token (ADELIC_REMOTE_TOKEN)'}
          </button>
        )}
      </form>
    </main>
  );
}
