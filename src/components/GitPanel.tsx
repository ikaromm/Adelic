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
import { useI18n, type MessageKey } from '../i18n';
import { diffLines } from '../run-activity';

type RepoStatus = Extract<GitStatus, { repo: true }>;
type Diff = { diff: string; truncated: boolean } | { error: string };
type Confirm =
  | { kind: 'discard'; file: GitFileEntry; mixed: boolean }
  | { kind: 'push'; remote: string; branch: string; remoteBranch: string };

const AREAS: { area: GitFileArea; title: MessageKey }[] = [
  { area: 'staged', title: 'git.area.staged' },
  { area: 'unstaged', title: 'git.area.unstaged' },
  { area: 'untracked', title: 'git.area.untracked' },
];
const LETTER_NAME: Record<string, MessageKey> = {
  M: 'git.letter.modified',
  A: 'git.letter.added',
  D: 'git.letter.deleted',
  R: 'git.letter.renamed',
  C: 'git.letter.copied',
  T: 'git.letter.typeChanged',
  U: 'git.letter.conflicted',
  '?': 'git.letter.untracked',
};
/** The server's "not a git repository" reason (pt-BR, or English once the server translates it). */
const NOT_GIT_REASON = /^(não é um repositório git|is not a git repository)$/i;
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
  const { t, tRich, fmt } = useI18n();
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
      if (!target) setError(t('git.noUpstreamError'));
      else setConfirm({ kind: 'push', ...target });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const heading = (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{t('git.eyebrow', { project: project.name })}</div>
        <h1>Git</h1>
        <p>{t('git.subtitle')}</p>
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void refresh()}
        disabled={working}
        aria-label={t('git.refreshLabel')}
      >
        <RefreshCw size={14} /> {t('git.refresh')}
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
            <LoaderCircle className="spin" size={14} /> {t('git.loading')}
          </div>
        )}
      </section>
    );
  if (!status.repo)
    return (
      <section className="page-content git-page">
        {heading}
        <div className="inline-notice">
          {NOT_GIT_REASON.test(status.reason) ? t('git.notRepo') : t('git.notRepoReason', { reason: status.reason })}
        </div>
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
        <div className="git-branch-row" aria-label={t('git.branchLabel')}>
          <GitBranch size={15} aria-hidden="true" />
          <strong>
            {repo.branch ?? (repo.head ? t('git.detached', { head: repo.head }) : t('git.detachedNoCommits'))}
          </strong>
          {repo.upstream ? (
            <span className="git-upstream" title={t('git.upstreamTitle')}>
              {repo.upstream} · ↑{repo.ahead ?? 0} ↓{repo.behind ?? 0}
            </span>
          ) : (
            <span className="git-upstream">{t('git.noUpstream')}</span>
          )}
          <div className="git-branch-actions">
            {repo.upstream && (
              <button type="button" className="secondary-button" disabled={locked} onClick={() => void askPush()}>
                <ArrowUpFromLine size={14} /> {t('git.push')}
              </button>
            )}
            {repo.branch && (
              <button type="button" className="secondary-button" onClick={() => void openPullRequest()}>
                <GitPullRequest size={14} /> {t('git.openPullRequest')}
              </button>
            )}
          </div>
        </div>
        {repo.blocked && (
          <div className="inline-notice git-blocked" role="status">
            {t('git.blocked', { reason: repo.blocked })}
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

        <section className="settings-card git-changes" aria-label={t('git.changes')}>
          {repo.files.length === 0 && <p className="git-empty">{t('git.clean')}</p>}
          {AREAS.map(({ area, title }) => {
            const list = repo.files.filter((f) => f.area === area);
            if (!list.length) return null;
            const isStaged = area === 'staged';
            return (
              <div key={area} className="git-group">
                <div className="git-group-heading">
                  <h2>
                    {t(title)} <span className="git-count">{list.length}</span>
                  </h2>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={locked}
                    aria-label={isStaged ? t('git.unstageAll') : t('git.stageAll', { area: t(title) })}
                    onClick={() =>
                      void act(() =>
                        isStaged
                          ? api.git.unstage(project.id, { all: true })
                          : api.git.stage(project.id, { paths: list.map((f) => f.path) }),
                      )
                    }
                  >
                    {isStaged ? <Minus size={14} /> : <Plus size={14} />} {t('git.all')}
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
                            aria-label={t('git.fileLabel', {
                              status: LETTER_NAME[file.letter] ? t(LETTER_NAME[file.letter]) : file.letter,
                              path: file.path,
                            })}
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
                              aria-label={t('git.discardFile', { path: file.path })}
                              title={t('git.discardChanges')}
                              onClick={() => setConfirm({ kind: 'discard', file, mixed: stagedPaths.has(file.path) })}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="icon-button"
                            disabled={locked}
                            aria-label={
                              isStaged
                                ? t('git.unstageFile', { path: file.path })
                                : t('git.stageFile', { path: file.path })
                            }
                            title={isStaged ? t('git.unstage') : t('git.stage')}
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
          {repo.omitted ? <small className="run-diff-note">{t('git.omitted', { count: repo.omitted })}</small> : null}
        </section>

        <section className="settings-card git-commit" aria-label="Commit">
          <label className="git-commit-label" htmlFor="git-commit-message">
            {t('git.commitMessage')}
          </label>
          <textarea
            id="git-commit-message"
            value={message}
            maxLength={GIT_COMMIT_MESSAGE_MAX}
            rows={3}
            placeholder={t('git.commitPlaceholder')}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="git-commit-actions">
            <small>
              {repo.runHooks ? t('git.hooksOn') : t('git.hooksOff')} {message.length}/{GIT_COMMIT_MESSAGE_MAX}
            </small>
            <button
              type="button"
              className="primary-button"
              disabled={locked || !trimmed || !staged.length}
              title={!staged.length ? t('git.stageFirst') : undefined}
              onClick={() =>
                void act(async () => {
                  const { hash } = await api.git.commit(project.id, message);
                  setMessage('');
                  setNotice(t('git.committed', { hash: hash.slice(0, 7) }));
                })
              }
            >
              <GitCommitHorizontal size={14} /> {t('git.commit')}
            </button>
          </div>
        </section>

        <section className="settings-card git-log" aria-label={t('git.recentCommits')}>
          <h2>{t('git.recentCommits')}</h2>
          {commits.length === 0 ? (
            <p className="git-empty">{t('git.noCommits')}</p>
          ) : (
            <ol>
              {commits.map((c) => (
                <li key={c.hash}>
                  <code title={c.hash}>{c.short}</code>
                  <span className="git-log-subject">{c.subject}</span>
                  <span className="git-log-meta">
                    {c.author} · <time dateTime={c.date}>{fmt.relative(c.date)}</time>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="settings-card git-settings" aria-label={t('git.settings')}>
          <div className="setting-row">
            <div>
              <strong>{t('git.hooks.title')}</strong>
              <span>{t('git.hooks.detail')}</span>
            </div>
            <button
              type="button"
              className={`toggle ${repo.runHooks ? 'on' : ''}`}
              role="switch"
              aria-checked={repo.runHooks}
              aria-label={t('git.hooks.label')}
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
          title={confirm.kind === 'push' ? t('git.confirm.pushTitle') : t('git.confirm.discardTitle')}
          action={confirm.kind === 'push' ? t('git.confirm.push') : t('git.confirm.discard')}
          closeLabel={t('git.close')}
          cancelLabel={t('git.cancel')}
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
              current.kind === 'push'
                ? t('git.pushed', { target: `${current.remote}/${current.remoteBranch}` })
                : undefined,
            ).then(() => setConfirm(null));
          }}
        >
          {confirm.kind === 'push' ? (
            <p>
              {tRich('git.confirm.pushDetail', {
                command: <code>git push</code>,
                branch: <code>{confirm.branch}</code>,
                target: (
                  <code>
                    {confirm.remote}/{confirm.remoteBranch}
                  </code>
                ),
              })}
            </p>
          ) : confirm.file.area === 'untracked' ? (
            <p>{tRich('git.confirm.discardUntracked', { path: <code>{confirm.file.path}</code> })}</p>
          ) : (
            <>
              <p>{tRich('git.confirm.discardTracked', { path: <code>{confirm.file.path}</code> })}</p>
              {confirm.mixed && <p className="git-warning">{t('git.confirm.discardMixed')}</p>}
            </>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

function DiffView({ path, diff }: { path: string; diff: Diff | undefined }) {
  const { t } = useI18n();
  if (!diff)
    return (
      <div className="run-diff-loading">
        <LoaderCircle className="spin" size={12} /> {t('git.diff.loading')}
      </div>
    );
  if ('error' in diff) return <div className="form-error">{diff.error}</div>;
  if (!diff.diff) return <small className="run-diff-note">{t('git.diff.empty')}</small>;
  return (
    <>
      <pre className="run-diff" aria-label={t('git.diff.label', { path })}>
        {diffLines(diff.diff).map((line, index) => (
          <span key={index} className={`diff-${line.kind}`}>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
      {diff.truncated && <small className="run-diff-note">{t('git.diff.truncated')}</small>}
    </>
  );
}

function ConfirmDialog({
  title,
  action,
  danger,
  busy,
  closeLabel,
  cancelLabel,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  action: string;
  danger: boolean;
  busy: boolean;
  closeLabel: string;
  cancelLabel: string;
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
          <button type="button" className="icon-button" aria-label={closeLabel} onClick={onCancel} disabled={busy}>
            <X size={17} />
          </button>
        </div>
        <div id="git-confirm-detail" className="restore-detail">
          {children}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
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
