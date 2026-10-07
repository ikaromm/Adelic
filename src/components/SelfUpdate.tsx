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

const KIND_LABEL: Record<SelfUpdateStatus['kind'], string> = {
  checkout: 'checkout git (npm start)',
  appimage: 'app desktop (AppImage)',
  other: 'outra instalação',
};
const STEP_ICON = {
  pending: <span className="update-step-dot" aria-hidden="true" />,
  running: <LoaderCircle size={14} className="spin" aria-hidden="true" />,
  done: <Check size={14} aria-hidden="true" />,
  failed: <X size={14} aria-hidden="true" />,
  skipped: <span className="update-step-dot" aria-hidden="true" />,
};
const STEP_STATUS = {
  pending: 'pendente',
  running: 'em andamento',
  done: 'concluído',
  failed: 'falhou',
  skipped: 'pulado',
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
      `Baixar o AppImage ${status.release.latest}${status.release.size ? ` (${Math.round(status.release.size / 1024 / 1024)} MB)` : ''} da release no GitHub`,
      'Conferir o SHA-256 publicado na mesma release',
      'Substituir o AppImage, guardando o atual como Adelic.AppImage.previous',
      'Reiniciar o Adelic',
    ];
  const c = status.checkout;
  if (!c) return [];
  return [
    ...(c.switchTo ? [`Trocar para o branch ${c.switchTo}`] : []),
    `Avançar para origin/${status.channel} (${c.behind} commit${c.behind === 1 ? '' : 's'}, só fast-forward)`,
    ...(c.install ? ['Reinstalar as dependências (npm ci): o package-lock.json mudou'] : []),
    'Compilar a interface (npm run build); a versão atual continua no ar até o build terminar',
    'Reiniciar o servidor; execuções novas ficam bloqueadas até lá',
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
  const reconnect = useCallback(async (bootId: string) => {
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
    setError('O Adelic não voltou em 3 minutos. Confira o processo e o arquivo self-update.log na pasta de dados.');
  }, []);

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
          <strong>Atualizar Adelic</strong>
          <span>Só pode ser feito neste computador, não pelo acesso remoto.</span>
        </div>
      </div>
    );
  const c = status?.checkout;
  const current = status ? `${status.version}${status.commit ? ` · ${status.commit}` : ''}` : '…';
  return (
    <div className="self-update" aria-labelledby="self-update-title">
      <div className="setting-row">
        <div>
          <strong id="self-update-title">Atualizar Adelic</strong>
          <span>
            Versão {current}
            {status ? ` · ${KIND_LABEL[status.kind]}` : ''}
            {c?.branch !== undefined ? ` · branch ${c.branch ?? '(sem branch)'}` : ''}
          </span>
        </div>
        <button type="button" className="secondary-button" onClick={() => void check()} disabled={checking || running}>
          {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Verificar atualizações
        </button>
      </div>
      {status?.kind === 'checkout' && (
        <div className="setting-row">
          <div>
            <strong>Canal de atualização</strong>
            <span>master é a versão estável; develop recebe as mudanças antes, como prévia.</span>
          </div>
          <select
            aria-label="Canal de atualização"
            value={channel}
            disabled={running}
            onChange={(event) => onChannel(event.target.value as UpdateChannel)}
          >
            <option value="master">master (estável)</option>
            <option value="develop">develop (prévia)</option>
          </select>
        </div>
      )}
      {updated && (
        <p className="update-line" role="status">
          <Check size={14} aria-hidden="true" /> Adelic atualizado e reiniciado ({updated}).
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
                  ? `Trocar para ${c.switchTo}${c.behind ? ` e avançar ${c.behind} commit${c.behind === 1 ? '' : 's'}` : ''}.`
                  : `${c.behind} commit${c.behind === 1 ? '' : 's'} novo${c.behind === 1 ? '' : 's'} em origin/${status.channel}.`
                : `Nova versão ${status.release?.latest} disponível.`}
            </p>
          ) : (
            status.checkedAt &&
            !status.error &&
            !status.blocked && <p className="update-line">O Adelic está atualizado.</p>
          )}
          {c && c.commits.length > 0 && (
            <ul className="update-commits" aria-label="Commits da atualização">
              {c.commits.map((commit) => (
                <li key={commit.hash}>
                  <code>{commit.hash}</code> {commit.subject}
                </li>
              ))}
              {c.behind > c.commits.length && <li className="update-more">e mais {c.behind - c.commits.length}…</li>}
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
                <ArrowUpCircle size={14} /> Atualizar agora
              </button>
            )}
            <a
              className="update-release-link"
              href={status.release?.url ?? status.releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              Página da release <ExternalLink size={12} />
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
          <ol aria-label="Etapas da atualização">
            {progress.steps
              .filter((step) => step.status !== 'skipped')
              .map((step) => (
                <li
                  key={step.id}
                  className={`update-step ${step.status}`}
                  aria-label={`${step.label}: ${STEP_STATUS[step.status]}`}
                >
                  {STEP_ICON[step.status]}
                  <span>{step.label}</span>
                </li>
              ))}
          </ol>
          {(progress.state === 'restarting' || reconnecting) && (
            <p className="update-line" role="status">
              <RotateCw size={14} className="spin" aria-hidden="true" /> Reiniciando… a página recarrega quando o Adelic
              voltar.
            </p>
          )}
          {progress.state === 'failed' && (
            <p className="update-line error-text" role="alert">
              A atualização falhou: {progress.error}
            </p>
          )}
          {progress.log && (
            <details>
              <summary>Saída</summary>
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
                <h2 id="update-confirm-title">Atualizar o Adelic?</h2>
                <p>O servidor reinicia no fim; conversas e dados ficam como estão.</p>
              </div>
              <button type="button" className="icon-button" aria-label="Fechar" onClick={() => setConfirming(false)}>
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
            <p className="modal-note">
              Se algo falhar antes do reinício, o Adelic volta ao estado atual e continua no ar.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setConfirming(false)}>
                Cancelar
              </button>
              <button type="button" className="primary-button" autoFocus onClick={() => void apply()}>
                Atualizar e reiniciar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
