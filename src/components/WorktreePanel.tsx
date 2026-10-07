import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileDiff, GitBranch, GitMerge, LoaderCircle, Trash2, X } from 'lucide-react';
import type { FileChange, Session, WorktreeStatus } from '../../shared/contracts';
import { api, type ApiError } from '../api';
import { diffLines } from '../run-activity';

// Isolated git worktree per conversation (docs/specs/worktrees.md).

const statusName: Record<FileChange['status'], string> = { added: 'criado', modified: 'alterado', deleted: 'removido' };

export function changedFilesLabel(count: number, base: string) {
  return `${count === 1 ? '1 arquivo alterado' : `${count} arquivos alterados`} em relação a ${base.slice(0, 7)}`;
}

/**
 * Strip above the conversation of a project: the "Trabalhar em uma cópia isolada" toggle, or,
 * once enabled, the branch, how many files changed and the "Ver alterações", "Aplicar no
 * projeto" and "Descartar worktree" actions.
 */
export function WorktreePanel({
  session,
  running,
  onSession,
}: {
  session: Session;
  /** A run (or a send) is in progress in this conversation. */
  running: boolean;
  onSession: (session: Session) => void;
}) {
  const [info, setInfo] = useState<{ id: string; status: WorktreeStatus } | null>(null);
  const [working, setWorking] = useState<'enable' | 'apply' | 'discard' | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'done'; text: string; files?: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<'apply' | 'discard' | null>(null);
  const status = info?.id === session.id ? info.status : null;
  const enabled = Boolean(session.worktree);
  const sessionId = session.id;

  const refresh = useCallback(async () => {
    try {
      const next = await api.worktree(sessionId);
      setInfo({ id: sessionId, status: next });
    } catch (e) {
      setInfo({ id: sessionId, status: { enabled, available: false, reason: (e as Error).message } });
    }
  }, [sessionId, enabled]);
  // Reloads when the conversation, its worktree or its running state change (a run ends).
  useEffect(() => {
    setMessage(null);
    setOpen(false);
    setConfirm(null);
  }, [sessionId]);
  useEffect(() => {
    if (!running) void refresh();
  }, [refresh, running, session.worktree?.path]);

  const fail = (e: unknown) => {
    const error = e as ApiError;
    setMessage({ kind: 'error', text: error.message, files: error.conflicts });
  };
  const enable = async () => {
    setWorking('enable');
    setMessage(null);
    try {
      const result = await api.enableWorktree(sessionId);
      onSession(result.session);
      setInfo({ id: sessionId, status: result.status });
    } catch (e) {
      fail(e);
    } finally {
      setWorking(null);
    }
  };
  const apply = async () => {
    setWorking('apply');
    setMessage(null);
    try {
      const result = await api.applyWorktree(sessionId);
      setInfo({ id: sessionId, status: result.status });
      setMessage({
        kind: 'done',
        text: `Alterações aplicadas em ${result.branch} (merge ${result.commit.slice(0, 7)}).`,
      });
    } catch (e) {
      fail(e);
      void refresh();
    } finally {
      setWorking(null);
      setConfirm(null);
    }
  };
  const discard = async (deleteBranch: boolean) => {
    setWorking('discard');
    setMessage(null);
    try {
      const result = await api.discardWorktree(sessionId, deleteBranch);
      onSession(result.session);
      setOpen(false);
      setMessage({
        kind: 'done',
        text: result.branchDeleted
          ? `Cópia isolada descartada; o branch ${result.branch} foi apagado.`
          : `Cópia isolada descartada; o branch ${result.branch} continua no repositório.`,
      });
    } catch (e) {
      fail(e);
    } finally {
      setWorking(null);
      setConfirm(null);
    }
  };

  if (session.projectId === null) return null;
  const busy = running || working !== null;
  const feedback = message && (
    <div
      className={message.kind === 'error' ? 'run-changes-error' : 'worktree-done'}
      role={message.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{message.text}</span>
      {message.files?.length ? (
        <ul>
          {message.files.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  if (!session.worktree) {
    // Shown only for git repositories (the toggle explains why it is disabled during a run).
    if (!status?.available && !feedback) return null;
    return (
      <section className="worktree-panel" aria-label="Cópia isolada">
        {status?.available && (
          <label className="worktree-toggle" title={running ? 'Aguarde a execução atual terminar' : undefined}>
            <input type="checkbox" role="switch" checked={false} disabled={busy} onChange={() => void enable()} />
            <span>Trabalhar em uma cópia isolada (worktree)</span>
            {working === 'enable' && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
          </label>
        )}
        {feedback}
      </section>
    );
  }

  const worktree = session.worktree;
  const files = status?.files ?? [];
  const count = files.length + (status?.omitted ?? 0);
  return (
    <section className="worktree-panel enabled" aria-label="Cópia isolada">
      <div className="worktree-row">
        <span className="worktree-branch" title={`Pasta: ${worktree.path}`}>
          <GitBranch size={13} aria-hidden="true" />
          <code>{worktree.branch}</code>
        </span>
        <span className="worktree-count">
          {status
            ? status.exists === false
              ? 'A pasta da cópia não existe mais'
              : changedFilesLabel(count, worktree.base)
            : 'Carregando…'}
          {status?.merged && !status.dirty ? ' · aplicado' : ''}
        </span>
        <div className="worktree-actions">
          <button
            type="button"
            className="ghost-button"
            aria-expanded={open}
            disabled={!count}
            onClick={() => setOpen((value) => !value)}
          >
            <FileDiff size={14} aria-hidden="true" /> Ver alterações
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || Boolean(status?.applyBlocked) || !status}
            title={running ? 'Aguarde a execução atual terminar' : status?.applyBlocked}
            onClick={() => {
              setMessage(null);
              setConfirm('apply');
            }}
          >
            {working === 'apply' ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <GitMerge size={14} aria-hidden="true" />
            )}
            Aplicar no projeto
          </button>
          <button
            type="button"
            className="ghost-button danger-text"
            disabled={busy}
            title={running ? 'Aguarde a execução atual terminar' : undefined}
            onClick={() => {
              setMessage(null);
              setConfirm('discard');
            }}
          >
            <Trash2 size={14} aria-hidden="true" /> Descartar worktree
          </button>
        </div>
      </div>
      {status?.applyBlocked && !running && status.exists !== false && (count > 0 || status.dirty) && (
        <small className="worktree-hint">{status.applyBlocked}</small>
      )}
      {open && <WorktreeFiles sessionId={sessionId} files={files} omitted={status?.omitted} />}
      {feedback}
      {confirm === 'apply' && (
        <ApplyDialog
          branch={worktree.branch}
          mainBranch={status?.mainBranch}
          count={count}
          dirty={Boolean(status?.dirty)}
          working={working === 'apply'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void apply()}
        />
      )}
      {confirm === 'discard' && (
        <DiscardDialog
          branch={worktree.branch}
          merged={Boolean(status?.branchMerged)}
          working={working === 'discard'}
          onCancel={() => setConfirm(null)}
          onConfirm={(deleteBranch) => void discard(deleteBranch)}
        />
      )}
    </section>
  );
}

function WorktreeFiles({ sessionId, files, omitted }: { sessionId: string; files: FileChange[]; omitted?: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, { diff: string; truncated: boolean } | { error: string }>>({});
  const toggle = async (path: string) => {
    const next = selected === path ? null : path;
    setSelected(next);
    if (!next) return;
    try {
      const diff = await api.worktreeDiff(sessionId, next);
      setDiffs((current) => ({ ...current, [next]: diff }));
    } catch (e) {
      setDiffs((current) => ({ ...current, [next]: { error: (e as Error).message } }));
    }
  };
  return (
    <>
      <ul className="run-changes-files worktree-files">
        {files.map((file) => {
          const diff = diffs[file.path];
          const open = selected === file.path;
          return (
            <li key={file.path}>
              <button
                type="button"
                className="run-change-file"
                aria-expanded={open}
                onClick={() => void toggle(file.path)}
              >
                <span className={`run-change-status ${file.status}`}>{statusName[file.status]}</span>
                <code>{file.path}</code>
                <span className="run-change-counts">
                  {file.binary ? (
                    'binário'
                  ) : (
                    <>
                      <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
                    </>
                  )}
                </span>
              </button>
              {open &&
                (!diff ? (
                  <div className="run-diff-loading">
                    <LoaderCircle className="spin" size={12} /> Carregando diferenças…
                  </div>
                ) : 'error' in diff ? (
                  <div className="form-error">{diff.error}</div>
                ) : (
                  <>
                    <pre className="run-diff" aria-label={`Diferenças em ${file.path}`}>
                      {diffLines(diff.diff).map((line, index) => (
                        <span key={index} className={`diff-${line.kind}`}>
                          {line.text}
                          {'\n'}
                        </span>
                      ))}
                    </pre>
                    {diff.truncated && <small className="run-diff-note">Diferenças cortadas em 200 KB.</small>}
                  </>
                ))}
            </li>
          );
        })}
      </ul>
      {omitted ? (
        <small className="run-diff-note">
          Mais {omitted} {omitted === 1 ? 'arquivo' : 'arquivos'} não listados.
        </small>
      ) : null}
    </>
  );
}

function Dialog({
  title,
  icon,
  working,
  onCancel,
  children,
  actions,
}: {
  title: string;
  icon: ReactNode;
  working: boolean;
  onCancel: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
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
        aria-labelledby="worktree-dialog-title"
        aria-describedby="worktree-dialog-detail"
      >
        <div className="modal-heading">
          <div className="project-avatar" aria-hidden="true">
            {icon}
          </div>
          <div>
            <h2 id="worktree-dialog-title">{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onCancel} disabled={working}>
            <X size={17} />
          </button>
        </div>
        <div id="worktree-dialog-detail" className="restore-detail">
          {children}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={working}>
            Cancelar
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}

function ApplyDialog({
  branch,
  mainBranch,
  count,
  dirty,
  working,
  onCancel,
  onConfirm,
}: {
  branch: string;
  mainBranch?: string;
  count: number;
  dirty: boolean;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title="Aplicar no projeto?"
      icon={<GitMerge size={17} />}
      working={working}
      onCancel={onCancel}
      actions={
        <button type="button" className="primary-button" onClick={onConfirm} disabled={working}>
          {working ? <LoaderCircle className="spin" size={14} /> : <GitMerge size={14} />}
          Aplicar
        </button>
      }
    >
      <p>
        {dirty ? 'As alterações pendentes da cópia viram um commit no branch ' : 'O branch '}
        <code>{branch}</code>
        {dirty ? ', que' : ''} entra no projeto com <code>git merge --no-ff</code>
        {mainBranch ? (
          <>
            {' '}
            em <code>{mainBranch}</code>
          </>
        ) : null}
        . {count === 1 ? '1 arquivo alterado.' : `${count} arquivos alterados.`}
      </p>
      <p>
        Só acontece se o projeto estiver sem alterações não commitadas e em um branch. Se houver conflito, o merge é
        desfeito e o projeto fica como estava. Nada é guardado no stash nem descartado.
      </p>
    </Dialog>
  );
}

function DiscardDialog({
  branch,
  merged,
  working,
  onCancel,
  onConfirm,
}: {
  branch: string;
  merged: boolean;
  working: boolean;
  onCancel: () => void;
  onConfirm: (deleteBranch: boolean) => void;
}) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  return (
    <Dialog
      title="Descartar a cópia isolada?"
      icon={<Trash2 size={17} />}
      working={working}
      onCancel={onCancel}
      actions={
        <button type="button" className="danger-button" onClick={() => onConfirm(deleteBranch)} disabled={working}>
          {working ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          Descartar
        </button>
      }
    >
      <p>
        A pasta da cópia é apagada, com alterações não commitadas. As próximas mensagens voltam a trabalhar na pasta do
        projeto.
      </p>
      {merged ? (
        <p>
          O branch <code>{branch}</code> não tem commits fora do projeto e também é apagado.
        </p>
      ) : (
        <label className="worktree-toggle">
          <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />
          <span>
            Apagar o branch também (<code>{branch}</code> não foi aplicado; os commits dele se perdem)
          </span>
        </label>
      )}
    </Dialog>
  );
}
