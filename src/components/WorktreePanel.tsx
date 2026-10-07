import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileDiff, GitBranch, GitMerge, LoaderCircle, Trash2, X } from 'lucide-react';
import type { FileChange, Session, WorktreeStatus } from '../../shared/contracts';
import { api, type ApiError } from '../api';
import { diffLines } from '../run-activity';
import { t as translate, useI18n, type MessageKey } from '../i18n';

// Isolated git worktree per conversation (docs/specs/worktrees.md).

const statusName: Record<FileChange['status'], MessageKey> = {
  added: 'worktree.status.added',
  modified: 'worktree.status.modified',
  deleted: 'worktree.status.deleted',
};

export function changedFilesLabel(count: number, base: string) {
  return translate('worktree.changedFiles', { count, base: base.slice(0, 7) });
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
  const { t } = useI18n();
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
        text: t('worktree.applied', { branch: result.branch, commit: result.commit.slice(0, 7) }),
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
          ? t('worktree.discardedDeleted', { branch: result.branch })
          : t('worktree.discardedKept', { branch: result.branch }),
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
      <section className="worktree-panel" aria-label={t('worktree.label')}>
        {status?.available && (
          <label className="worktree-toggle" title={running ? t('worktree.waitRun') : undefined}>
            <input type="checkbox" role="switch" checked={false} disabled={busy} onChange={() => void enable()} />
            <span>{t('worktree.enable')}</span>
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
    <section className="worktree-panel enabled" aria-label={t('worktree.label')}>
      <div className="worktree-row">
        <span className="worktree-branch" title={t('worktree.folder', { path: worktree.path })}>
          <GitBranch size={13} aria-hidden="true" />
          <code>{worktree.branch}</code>
        </span>
        <span className="worktree-count">
          {status
            ? status.exists === false
              ? t('worktree.missing')
              : t('worktree.changedFiles', { count, base: worktree.base.slice(0, 7) })
            : t('worktree.loading')}
          {status?.merged && !status.dirty ? t('worktree.appliedSuffix') : ''}
        </span>
        <div className="worktree-actions">
          <button
            type="button"
            className="ghost-button"
            aria-expanded={open}
            disabled={!count}
            onClick={() => setOpen((value) => !value)}
          >
            <FileDiff size={14} aria-hidden="true" /> {t('worktree.viewChanges')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || Boolean(status?.applyBlocked) || !status}
            title={running ? t('worktree.waitRun') : status?.applyBlocked}
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
            {t('worktree.apply')}
          </button>
          <button
            type="button"
            className="ghost-button danger-text"
            disabled={busy}
            title={running ? t('worktree.waitRun') : undefined}
            onClick={() => {
              setMessage(null);
              setConfirm('discard');
            }}
          >
            <Trash2 size={14} aria-hidden="true" /> {t('worktree.discard')}
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
  const { t } = useI18n();
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
                <span className={`run-change-status ${file.status}`}>{t(statusName[file.status])}</span>
                <code>{file.path}</code>
                <span className="run-change-counts">
                  {file.binary ? (
                    t('worktree.binary')
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
                    <LoaderCircle className="spin" size={12} /> {t('worktree.diff.loading')}
                  </div>
                ) : 'error' in diff ? (
                  <div className="form-error">{diff.error}</div>
                ) : (
                  <>
                    <pre className="run-diff" aria-label={t('worktree.diff.label', { path: file.path })}>
                      {diffLines(diff.diff).map((line, index) => (
                        <span key={index} className={`diff-${line.kind}`}>
                          {line.text}
                          {'\n'}
                        </span>
                      ))}
                    </pre>
                    {diff.truncated && <small className="run-diff-note">{t('worktree.diff.truncated')}</small>}
                  </>
                ))}
            </li>
          );
        })}
      </ul>
      {omitted ? <small className="run-diff-note">{t('worktree.omitted', { count: omitted })}</small> : null}
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
  const { t } = useI18n();
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
          <button
            type="button"
            className="icon-button"
            aria-label={t('worktree.close')}
            onClick={onCancel}
            disabled={working}
          >
            <X size={17} />
          </button>
        </div>
        <div id="worktree-dialog-detail" className="restore-detail">
          {children}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={working}>
            {t('worktree.cancel')}
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
  const { t, tRich } = useI18n();
  const vars = {
    branch: <code>{branch}</code>,
    command: <code>git merge --no-ff</code>,
    main: <code>{mainBranch}</code>,
  };
  const key: MessageKey = dirty
    ? mainBranch
      ? 'worktree.applyDialog.dirtyInto'
      : 'worktree.applyDialog.dirty'
    : mainBranch
      ? 'worktree.applyDialog.cleanInto'
      : 'worktree.applyDialog.clean';
  return (
    <Dialog
      title={t('worktree.applyDialog.title')}
      icon={<GitMerge size={17} />}
      working={working}
      onCancel={onCancel}
      actions={
        <button type="button" className="primary-button" onClick={onConfirm} disabled={working}>
          {working ? <LoaderCircle className="spin" size={14} /> : <GitMerge size={14} />}
          {t('worktree.applyDialog.confirm')}
        </button>
      }
    >
      <p>
        {tRich(key, vars)} {t('worktree.applyDialog.files', { count })}
      </p>
      <p>{t('worktree.applyDialog.safety')}</p>
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
  const { t, tRich } = useI18n();
  const [deleteBranch, setDeleteBranch] = useState(false);
  return (
    <Dialog
      title={t('worktree.discardDialog.title')}
      icon={<Trash2 size={17} />}
      working={working}
      onCancel={onCancel}
      actions={
        <button type="button" className="danger-button" onClick={() => onConfirm(deleteBranch)} disabled={working}>
          {working ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          {t('worktree.discardDialog.confirm')}
        </button>
      }
    >
      <p>{t('worktree.discardDialog.detail')}</p>
      {merged ? (
        <p>{tRich('worktree.discardDialog.merged', { branch: <code>{branch}</code> })}</p>
      ) : (
        <label className="worktree-toggle">
          <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />
          <span>{tRich('worktree.discardDialog.deleteBranch', { branch: <code>{branch}</code> })}</span>
        </label>
      )}
    </Dialog>
  );
}
