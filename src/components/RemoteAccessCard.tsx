import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Globe, LoaderCircle, LogOut, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { api, type ApiError } from '../api';
import {
  PASSWORD_MIN,
  passwordHints,
  passwordProblems,
  usernameProblem,
  type RemoteAccessState,
  type TailscaleState,
} from '../../shared/remote-access';

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const kindLabel = { tailnet: 'Tailnet', internet: 'Internet' } as const;
const strength = ['Fraca', 'Aceitável', 'Boa', 'Forte'] as const;

/** Short device name from a user agent ("Firefox · Android"), never the whole string. */
export function deviceLabel(userAgent: string) {
  if (!userAgent) return 'Dispositivo desconhecido';
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
  const local = state?.kind === 'local';
  return (
    <section className="settings-card remote-access-card" aria-labelledby="remote-access-title">
      <div className="settings-card-heading">
        <div className="settings-card-icon green">
          <Globe size={17} />
        </div>
        <div>
          <h2 id="remote-access-title">Acesso remoto</h2>
          <p>
            Usuário e senha para abrir o Adelic de outro dispositivo, pela tailnet ou pela internet com o Tailscale
            Funnel. Neste computador o login não é pedido.
          </p>
        </div>
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      {!state ? (
        !error && <p className="remote-muted">Carregando…</p>
      ) : (
        <>
          <AccountSection state={state} local={local} busy={busy} act={act} />
          <div className="setting-row">
            <div>
              <strong>Pela internet, exigir aprovação manual para comandos</strong>
              <span>
                Execuções iniciadas de uma sessão pela internet pedem sua confirmação a cada solicitação do agente,
                mesmo com a aprovação automática segura ligada. Só pode ser alterado neste computador.
              </span>
            </div>
            <button
              className={`toggle ${internetManualApproval ? 'on' : ''}`}
              role="switch"
              aria-checked={internetManualApproval}
              aria-label="Pela internet, exigir aprovação manual para comandos"
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
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState(state.account?.username ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const hintsId = useId();
  const userProblem = username ? usernameProblem(username) : undefined;
  const problems = password ? passwordProblems(username, password) : [];
  const { score, hints } = passwordHints(password);
  const mismatch = Boolean(confirm) && confirm !== password;
  const valid = !usernameProblem(username) && password && !problems.length && confirm === password;
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
          <strong>{state.account ? `Conta: ${state.account.username}` : 'Nenhuma conta criada'}</strong>
          <span>
            {state.account
              ? `Senha alterada em ${when(state.account.passwordChangedAt)}. Trocar a senha encerra todas as sessões.`
              : local
                ? 'Crie o usuário e a senha antes de abrir o acesso pela internet.'
                : 'A conta só pode ser criada no computador onde o Adelic roda.'}
            {state.tailnet && ` Tailnet em ${state.tailnet.url} (o token ADELIC_REMOTE_TOKEN também vale lá).`}
          </span>
        </div>
        {local && !editing && (
          <div className="remote-row-actions">
            <button type="button" className="secondary-button" onClick={() => setEditing(true)}>
              {state.account ? 'Trocar senha' : 'Criar conta'}
            </button>
            {state.account && (
              <button
                type="button"
                className="danger-button"
                disabled={busy === 'delete'}
                onClick={() => {
                  if (window.confirm('Apagar a conta? Ninguém conseguirá entrar pela internet e as sessões terminam.'))
                    void act('delete', () => api.deleteRemoteAccount());
                }}
              >
                Apagar conta
              </button>
            )}
          </div>
        )}
      </div>
      {local && editing && (
        <form className="remote-account-form" onSubmit={submit} aria-label="Conta do acesso remoto">
          <label>
            Usuário
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
            Nova senha
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
                  Força: {problems.length ? strength[0] : strength[score]}
                </span>
                {[...problems, ...hints].map((text) => (
                  <span key={text}>{text}</span>
                ))}
              </>
            ) : (
              <span>Pelo menos {PASSWORD_MIN} caracteres, diferente do usuário. Uma frase longa funciona bem.</span>
            )}
          </div>
          <label>
            Repita a senha
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
          {mismatch && <p className="remote-problem">As senhas não conferem.</p>}
          <div className="remote-row-actions">
            <button type="button" className="secondary-button" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button className="primary-button" disabled={!valid || busy === 'account'}>
              {busy === 'account' && <LoaderCircle size={14} className="spin" />} Salvar conta
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
          <strong>Publicar na internet (Tailscale Funnel)</strong>
          <span>
            {on
              ? `Publicado em ${tailscale!.publicUrl}. Qualquer pessoa na internet vê a tela de login.`
              : `O Funnel encaminha https://${tailscale?.dnsName ?? '<máquina>.<tailnet>.ts.net'}/ para 127.0.0.1:${state.funnel!.port}, que pede login sempre.`}
          </span>
        </div>
        <div className="remote-row-actions">
          <button type="button" className="ghost-button" onClick={() => void check()} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'spin' : undefined} /> Verificar
          </button>
          {on ? (
            <button type="button" className="danger-button" disabled={working} onClick={() => void toggle(false)}>
              {working && <LoaderCircle size={14} className="spin" />} Desligar
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={!state.account || working || !tailscale?.installed || !tailscale.loggedIn}
              title={!state.account ? 'Crie o usuário e a senha antes' : undefined}
              onClick={() => setConfirming(true)}
            >
              Publicar na internet
            </button>
          )}
        </div>
      </div>
      {tailscale && (
        <dl className="remote-status" aria-label="Estado do Tailscale">
          <div>
            <dt>Tailscale</dt>
            <dd>{tailscale.installed ? `instalado (${tailscale.version ?? '?'})` : 'não encontrado'}</dd>
          </div>
          <div>
            <dt>Conectado</dt>
            <dd>{tailscale.loggedIn ? 'sim' : (tailscale.backendState ?? 'não')}</dd>
          </div>
          <div>
            <dt>Nome</dt>
            <dd>{tailscale.dnsName ?? '—'}</dd>
          </div>
          <div>
            <dt>HTTPS</dt>
            <dd>{tailscale.https ? 'permitido' : 'não permitido'}</dd>
          </div>
          <div>
            <dt>Funnel</dt>
            <dd>
              {tailscale.funnelAllowed
                ? tailscale.port443Allowed
                  ? 'permitido'
                  : 'porta 443 não permitida'
                : 'não permitido'}
            </dd>
          </div>
          <div>
            <dt>Situação</dt>
            <dd>{on ? 'publicado' : tailscale.stale ? 'aponta para uma porta antiga' : 'desligado'}</dd>
          </div>
        </dl>
      )}
      {tailscale?.conflict && (
        <p className="remote-problem">
          https://{tailscale.dnsName}/ já publica outro destino ({tailscale.conflict}). O Adelic não o substitui.
        </p>
      )}
      {tailscale && !ready && tailscale.requirements.length > 0 && (
        <ul className="remote-requirements" aria-label="O que falta na tailnet">
          {tailscale.requirements.map((item) => (
            <li key={item.text}>
              {item.text}{' '}
              {item.url && (
                <a href={item.url} target="_blank" rel="noreferrer">
                  Abrir console <ExternalLink size={12} aria-hidden="true" />
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
                Abrir console da Tailscale
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
            <h2 id="funnel-confirm-title">Publicar o Adelic na internet?</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onCancel} disabled={working}>
            <X size={17} />
          </button>
        </div>
        <div id="funnel-confirm-detail" className="restore-detail">
          <p>
            {url ?? 'O endereço .ts.net'} ficará acessível a qualquer pessoa na internet. Quem entrar com o seu usuário
            e senha controla agentes que leem e alteram arquivos e executam comandos neste computador.
          </p>
          <ul>
            <li>Use uma senha longa e exclusiva.</li>
            <li>Pela internet, o terminal, MCP, automações, verificações, git push e estas opções ficam bloqueados.</li>
            <li>O endereço fica público até você clicar em Desligar (o Tailscale mantém o Funnel após reiniciar).</li>
          </ul>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={working}>
            Cancelar
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={working}>
            {working && <LoaderCircle size={14} className="spin" />} Publicar
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionsSection({ state, busy, act }: { state: RemoteAccessState; busy: string; act: Act }) {
  const local = state.kind === 'local';
  return (
    <div className="remote-list-block">
      <div className="remote-list-heading">
        <h3>Sessões ativas</h3>
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
            Encerrar todas
          </button>
        )}
      </div>
      {state.sessions.length ? (
        <ul className="remote-list" aria-label="Sessões ativas">
          {state.sessions.map((session) => (
            <li key={session.id}>
              <div>
                <strong>
                  {deviceLabel(session.userAgent)}
                  {session.current && <span className="count-chip">esta sessão</span>}
                </strong>
                <span>
                  {kindLabel[session.kind]} · {session.ip} · visto em {when(session.lastSeenAt)}
                  {session.method === 'token' && ' · token'}
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
                  <LogOut size={14} /> Sair
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`Encerrar sessão ${deviceLabel(session.userAgent)} (${session.ip})`}
                  disabled={busy === session.id}
                  onClick={() => void act(session.id, () => api.revokeRemoteSession(session.id))}
                >
                  Encerrar
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="remote-muted">Nenhuma sessão aberta.</p>
      )}
    </div>
  );
}

function LoginsSection({ state }: { state: RemoteAccessState }) {
  if (!state.logins.length) return null;
  const reason = {
    credentials: 'senha incorreta',
    'rate-limit': 'muitas tentativas',
    'no-account': 'sem conta',
  };
  return (
    <details className="remote-list-block">
      <summary>Últimos acessos ({state.logins.length})</summary>
      <ul className="remote-list compact" aria-label="Últimos acessos">
        {state.logins.map((login, index) => (
          <li key={`${login.at}-${index}`}>
            <div>
              <strong className={login.ok ? 'remote-ok' : 'remote-fail'}>
                {login.ok ? 'Entrou' : `Falhou (${login.reason ? reason[login.reason] : 'erro'})`}
                {login.username && ` · ${login.username}`}
              </strong>
              <span>
                {when(login.at)} · {kindLabel[login.kind]} · {login.ip} · {deviceLabel(login.userAgent)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
