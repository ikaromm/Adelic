import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpFromLine,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { GitCommitInfo, GitFileArea, GitFileEntry, GitStatus, Project } from '../../shared/contracts';
import { GIT_COMMIT_MESSAGE_MAX } from '../../shared/schemas';
import { api } from '../api';
import { relativeTime } from '../format';
import { diffLines } from '../run-activity';

type RepoStatus = Extract<GitStatus, { repo: true }>;
type Diff = { diff: string; truncated: boolean } | { error: string };
type Confirm =
  | { kind: 'discard'; file: GitFileEntry; mixed: boolean }
  | { kind: 'push'; remote: string; branch: string; remoteBranch: string };

const AREAS: { area: GitFileArea; title: string }[] = [
  { area: 'staged', title: 'Staged' },
  { area: 'unstaged', title: 'Não staged' },
  { area: 'untracked', title: 'Não rastreados' },
];
const LETTER_NAME: Record<string, string> = {
  M: 'modificado',
  A: 'adicionado',
  D: 'removido',
  R: 'renomeado',
  C: 'copiado',
  T: 'tipo alterado',
  U: 'em conflito',
  '?': 'não rastreado',
};
const keyOf = (f: Pick<GitFileEntry, 'path' | 'area'>) => `${f.area}:${f.path}`;

/** Whether the project folder is inside a git work tree (shows the "Git" entry points). */
export function useGitRepo(projectId: string | undefined) {
  const [repo, setRepo] = useState<{ id: string; repo: boolean } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    api.git
      .repo(projectId)
      .then((result) => active && setRepo({ id: projectId, repo: result.repo }))
      .catch(() => active && setRepo({ id: projectId, repo: false }));
    return () => {
      active = false;
    };
  }, [projectId]);
  return Boolean(projectId && repo?.id === projectId && repo.repo);
}

/** Git page of a project: status, diffs, stage, commit, push and PR link (docs/specs/git-panel.md). */
export function GitPanel({ project, onProjectUpdated }: { project: Project; onProjectUpdated: (p: Project) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, Diff>>({});
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await api.git.status(project.id);
      const log = next.repo ? await api.git.log(project.id) : { commits: [] };
      if (id !== request.current) return;
      setStatus(next);
      setCommits(log.commits);
      setDiffs({});
      setError('');
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    }
  }, [project.id]);
  useEffect(() => {
    setStatus(null);
    setSelected(null);
    void refresh();
  }, [refresh]);

  /** Runs a mutation, then reloads; errors (e.g. 409 while a run writes) show above the lists. */
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await work();
      if (done) setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh();
      setWorking(false);
    }
  };
  const toggleDiff = async (file: GitFileEntry) => {
    const key = keyOf(file);
    const next = selected === key ? null : key;
    setSelected(next);
    if (!next || diffs[key]) return;
    try {
      const diff = await api.git.diff(project.id, file.path, file.area === 'staged');
      setDiffs((current) => ({ ...current, [key]: diff }));
    } catch (e) {
      setDiffs((current) => ({ ...current, [key]: { error: (e as Error).message } }));
    }
  };
  const openPullRequest = async () => {
    setError('');
    try {
      const { url } = await api.git.prUrl(project.id);
      // Desktop: the window-open handler sends http(s) links to the system browser.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setRunHooks = (runHooks: boolean) =>
    void act(async () => onProjectUpdated(await api.updateProject(project.id, { git: { runHooks } })));
  const askPush = async () => {
    setError('');
    try {
      const { target } = await api.git.pushTarget(project.id);
      if (!target) setError('A branch atual não tem upstream.');
      else setConfirm({ kind: 'push', ...target });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const heading = (
    <div className="page-heading">
      <div>
        <div className="eyebrow">PROJETO · {project.name}</div>
        <h1>Git</h1>
        <p>Alterações, commits e envio do repositório deste projeto.</p>
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void refresh()}
        disabled={working}
        aria-label="Atualizar estado do git"
      >
        <RefreshCw size={14} /> Atualizar
      </button>
    </div>
  );
  if (!status)
    return (
      <section className="page-content git-page">
        {heading}
        {error ? (
          <div className="inline-notice error-notice" role="alert">
            {error}
          </div>
        ) : (
          <div className="run-diff-loading">
            <LoaderCircle className="spin" size={14} /> Lendo o repositório…
          </div>
        )}
      </section>
    );
  if (!status.repo)
    return (
      <section className="page-content git-page">
        {heading}
        <div className="inline-notice">A pasta do projeto {status.reason}.</div>
      </section>
    );

  const repo: RepoStatus = status;
  const locked = working || Boolean(repo.blocked);
  const staged = repo.files.filter((f) => f.area === 'staged');
  const stagedPaths = new Set(staged.map((f) => f.path));
  const trimmed = message.trim();
  return (
    <section className="page-content git-page">
      {heading}
      <div className="git-layout">
        <div className="git-branch-row" aria-label="Branch atual">
          <GitBranch size={15} aria-hidden="true" />
          <strong>{repo.branch ?? `HEAD destacado (${repo.head ?? 'sem commits'})`}</strong>
          {repo.upstream ? (
            <span className="git-upstream" title="Calculado com as refs locais, sem buscar o remoto">
              {repo.upstream} · ↑{repo.ahead ?? 0} ↓{repo.behind ?? 0}
            </span>
          ) : (
            <span className="git-upstream">sem upstream</span>
          )}
          <div className="git-branch-actions">
            {repo.upstream && (
              <button type="button" className="secondary-button" disabled={locked} onClick={() => void askPush()}>
                <ArrowUpFromLine size={14} /> Enviar (git push)
              </button>
            )}
            {repo.branch && (
              <button type="button" className="secondary-button" onClick={() => void openPullRequest()}>
                <GitPullRequest size={14} /> Abrir pull request
              </button>
            )}
          </div>
        </div>
        {repo.blocked && (
          <div className="inline-notice git-blocked" role="status">
            {repo.blocked}. Alterações pelo painel ficam bloqueadas até lá.
          </div>
        )}
        {error && (
          <div className="inline-notice error-notice git-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="inline-notice" role="status">
            {notice}
          </div>
        )}

        <section className="settings-card git-changes" aria-label="Alterações">
          {repo.files.length === 0 && <p className="git-empty">Nenhuma alteração. A árvore de trabalho está limpa.</p>}
          {AREAS.map(({ area, title }) => {
            const list = repo.files.filter((f) => f.area === area);
            if (!list.length) return null;
            const isStaged = area === 'staged';
            return (
              <div key={area} className="git-group">
                <div className="git-group-heading">
                  <h2>
                    {title} <span className="git-count">{list.length}</span>
                  </h2>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={locked}
                    aria-label={isStaged ? 'Tirar tudo do stage' : `Adicionar tudo ao stage (${title})`}
                    onClick={() =>
                      void act(() =>
                        isStaged
                          ? api.git.unstage(project.id, { all: true })
                          : api.git.stage(project.id, { paths: list.map((f) => f.path) }),
                      )
                    }
                  >
                    {isStaged ? <Minus size={14} /> : <Plus size={14} />} Tudo
                  </button>
                </div>
                <ul className="git-files">
                  {list.map((file) => {
                    const key = keyOf(file);
                    const open = selected === key;
                    const diff = diffs[key];
                    return (
                      <li key={key}>
                        <div className="git-file-row">
                          <button
                            type="button"
                            className="git-file"
                            aria-expanded={open}
                            aria-label={`${LETTER_NAME[file.letter] ?? file.letter} ${file.path}`}
                            onClick={() => void toggleDiff(file)}
                            title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                          >
                            <span
                              className={`git-letter letter-${file.letter === '?' ? 'new' : file.letter.toLowerCase()}`}
                              aria-hidden="true"
                            >
                              {file.letter}
                            </span>
                            <code>
                              {file.origPath ? `${file.origPath} → ` : ''}
                              {file.path}
                            </code>
                          </button>
                          {!isStaged && file.letter !== 'U' && (
                            <button
                              type="button"
                              className="icon-button"
                              disabled={locked}
                              aria-label={`Descartar ${file.path}`}
                              title="Descartar alterações"
                              onClick={() => setConfirm({ kind: 'discard', file, mixed: stagedPaths.has(file.path) })}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-button"
                            disabled={locked}
                            aria-label={isStaged ? `Tirar do stage ${file.path}` : `Adicionar ao stage ${file.path}`}
                            title={isStaged ? 'Tirar do stage' : 'Adicionar ao stage'}
                            onClick={() =>
                              void act(() =>
                                isStaged
                                  ? api.git.unstage(project.id, { paths: [file.path] })
                                  : api.git.stage(project.id, { paths: [file.path] }),
                              )
                            }
                          >
                            {isStaged ? <Minus size={14} /> : <Plus size={14} />}
                          </button>
                        </div>
                        {open && <DiffView path={file.path} diff={diff} />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {repo.omitted ? <small className="run-diff-note">Mais {repo.omitted} alterações não listadas.</small> : null}
        </section>

        <section className="settings-card git-commit" aria-label="Commit">
          <label className="git-commit-label" htmlFor="git-commit-message">
            Mensagem do commit
          </label>
          <textarea
            id="git-commit-message"
            value={message}
            maxLength={GIT_COMMIT_MESSAGE_MAX}
            rows={3}
            placeholder="Descreva as alterações staged"
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="git-commit-actions">
            <small>
              {repo.runHooks ? 'Hooks do git ativados para commits.' : 'Commits sem hooks do git.'} {message.length}/
              {GIT_COMMIT_MESSAGE_MAX}
            </small>
            <button
              type="button"
              className="primary-button"
              disabled={locked || !trimmed || !staged.length}
              title={!staged.length ? 'Adicione arquivos ao stage primeiro' : undefined}
              onClick={() =>
                void act(async () => {
                  const { hash } = await api.git.commit(project.id, message);
                  setMessage('');
                  setNotice(`Commit ${hash.slice(0, 7)} criado.`);
                })
              }
            >
              <GitCommitHorizontal size={14} /> Fazer commit
            </button>
          </div>
        </section>

        <section className="settings-card git-log" aria-label="Commits recentes">
          <h2>Commits recentes</h2>
          {commits.length === 0 ? (
            <p className="git-empty">Nenhum commit ainda.</p>
          ) : (
            <ol>
              {commits.map((c) => (
                <li key={c.hash}>
                  <code title={c.hash}>{c.short}</code>
                  <span className="git-log-subject">{c.subject}</span>
                  <span className="git-log-meta">
                    {c.author} · <time dateTime={c.date}>{relativeTime(c.date)}</time>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="settings-card git-settings" aria-label="Configurações do git">
          <div className="setting-row">
            <div>
              <strong>Executar hooks do git (pre-commit etc.) ao fazer commit</strong>
              <span>
                Os hooks são programas que ficam no próprio repositório e rodam fora do sandbox. Um agente que pode
                escrever no projeto pode alterá-los. Deixe desligado se não confia neles.
              </span>
            </div>
            <button
              type="button"
              className={`toggle ${repo.runHooks ? 'on' : ''}`}
              role="switch"
              aria-checked={repo.runHooks}
              aria-label="Executar hooks do git ao fazer commit"
              disabled={working}
              onClick={() => setRunHooks(!repo.runHooks)}
            >
              <span />
            </button>
          </div>
        </section>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'push' ? 'Enviar commits?' : 'Descartar alterações?'}
          action={confirm.kind === 'push' ? 'Enviar' : 'Descartar'}
          danger={confirm.kind === 'discard'}
          busy={working}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const current = confirm;
            void act(
              () =>
                current.kind === 'push'
                  ? api.git.push(project.id)
                  : api.git.discard(project.id, [current.file.path], current.mixed),
              current.kind === 'push' ? `Enviado para ${current.remote}/${current.remoteBranch}.` : undefined,
            ).then(() => setConfirm(null));
          }}
        >
          {confirm.kind === 'push' ? (
            <p>
              Roda <code>git push</code> da branch <code>{confirm.branch}</code> para{' '}
              <code>
                {confirm.remote}/{confirm.remoteBranch}
              </code>
              , sem forçar. Se o remoto pedir autenticação, o envio falha e o erro aparece aqui.
            </p>
          ) : confirm.file.area === 'untracked' ? (
            <p>
              O arquivo <code>{confirm.file.path}</code> não é rastreado e será apagado do disco. Não dá para desfazer.
            </p>
          ) : (
            <>
              <p>
                <code>{confirm.file.path}</code> volta ao conteúdo do índice; as alterações não staged são perdidas.
              </p>
              {confirm.mixed && (
                <p className="git-warning">
                  Este arquivo também tem alterações staged. Elas são mantidas; só o que não está no stage é descartado.
                </p>
              )}
            </>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

function DiffView({ path, diff }: { path: string; diff: Diff | undefined }) {
  if (!diff)
    return (
      <div className="run-diff-loading">
        <LoaderCircle className="spin" size={12} /> Carregando diferenças…
      </div>
    );
  if ('error' in diff) return <div className="form-error">{diff.error}</div>;
  if (!diff.diff) return <small className="run-diff-note">Sem diferenças de texto para mostrar.</small>;
  return (
    <>
      <pre className="run-diff" aria-label={`Diferenças em ${path}`}>
        {diffLines(diff.diff).map((line, index) => (
          <span key={index} className={`diff-${line.kind}`}>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
      {diff.truncated && <small className="run-diff-note">Diferenças cortadas em 200 KB.</small>}
    </>
  );
}

function ConfirmDialog({
  title,
  action,
  danger,
  busy,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  action: string;
  danger: boolean;
  busy: boolean;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel();
      }}
    >
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="git-confirm-title"
        aria-describedby="git-confirm-detail"
      >
        <div className="modal-heading">
          <div>
            <h2 id="git-confirm-title">{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onCancel} disabled={busy}>
            <X size={17} />
          </button>
        </div>
        <div id="git-confirm-detail" className="restore-detail">
          {children}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className={danger ? 'danger-button' : 'primary-button'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <LoaderCircle className="spin" size={14} />}
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
