import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { BrandMark } from './BrandMark';

type Status = { remote: boolean; authenticated: boolean };

/**
 * On loopback the app renders directly. When opened through the optional remote address
 * (ADELIC_REMOTE_BIND), it asks for the access token first; the server sets an HttpOnly
 * cookie on success, so the token never stays in page storage.
 */
export function RemoteGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : { remote: false, authenticated: true }))
      .then(setStatus)
      // An older server without /api/auth: behave as before (loopback only).
      .catch(() => setStatus({ remote: false, authenticated: true }));
  }, []);
  if (!status) return null;
  if (status.authenticated) return <>{children}</>;
  const login = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? 'Token inválido.' : `Falha no login (${response.status}).`);
      setToken('');
      setStatus({ remote: true, authenticated: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="remote-gate">
      <form onSubmit={(e) => void login(e)} aria-labelledby="remote-gate-title">
        <div className="remote-gate-brand">
          <BrandMark /> adelic
        </div>
        <h1 id="remote-gate-title">Acesso remoto</h1>
        <p>Este Adelic está sendo acessado de outro dispositivo. Informe o token configurado em ADELIC_REMOTE_TOKEN.</p>
        <label>
          Token de acesso
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
          />
        </label>
        {error && (
          <div className="inline-notice error-notice" role="alert">
            {error}
          </div>
        )}
        <button className="primary-button" disabled={busy || !token.trim()}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />} Entrar
        </button>
      </form>
    </main>
  );
}
