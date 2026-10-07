import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileDiff, LoaderCircle, Undo2, X } from 'lucide-react';
import type { FileChange, Run } from '../../shared/contracts';
import { api, type ApiError } from '../api';
import { changesSummary, diffLines } from '../run-activity';

const statusName: Record<FileChange['status'], string> = {
  added: 'criado',
  modified: 'alterado',
  deleted: 'removido',
};

/** Files a run changed in a git project, their diffs and "undo"; see docs/specs/checkpoints.md. */
export function RunChanges({ run, busy }: { run: Run; busy: boolean }) {
  const checkpoint = run.checkpoint;
  const files = checkpoint?.files ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, { diff: string; truncated: boolean } | { error: string }>>({});
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<{ error?: string; conflicts?: string[]; restoredAt?: string } | null>(null);
  if (run.status === 'running' || !checkpoint?.available || !files.length) return null;
  const restoredAt = checkpoint.restoredAt ?? result?.restoredAt;

  const toggle = async (path: string) => {
    const next = selected === path ? null : path;
    setSelected(next);
    if (!next || diffs[next]) return;
    try {
      const diff = await api.runDiff(run.id, next);
      setDiffs((current) => ({ ...current, [next]: diff }));
    } catch (e) {
      setDiffs((current) => ({ ...current, [next]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const restore = async () => {
    setRestoring(true);
    try {
      const response = await api.restoreRun(run.id);
      setResult({ restoredAt: response.run.checkpoint?.restoredAt ?? new Date().toISOString() });
      setConfirming(false);
    } catch (e) {
      const error = e as ApiError;
      setResult({ error: error.message, conflicts: error.conflicts });
      setConfirming(false);
    } finally {
      setRestoring(false);
    }
  };
  const total = files.length + (checkpoint.omitted ?? 0);
  return (
    <div className="run-changes">
      <details className="run-changes-details">
        <summary>
          <FileDiff size={14} aria-hidden="true" />
          <span className="run-changes-summary">{changesSummary(files, checkpoint.omitted)}</span>
          {restoredAt && <span className="run-changes-restored">desfeito</span>}
          <ChevronDown className="activity-chevron" size={14} aria-hidden="true" />
        </summary>
        <ul className="run-changes-files">
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
        {checkpoint.omitted ? (
          <small className="run-diff-note">
            Mais {checkpoint.omitted} {checkpoint.omitted === 1 ? 'arquivo' : 'arquivos'} não listados.
          </small>
        ) : null}
        {result?.error && (
          <div className="run-changes-error" role="alert">
            <span>{result.error}</span>
            {result.conflicts?.length ? (
              <ul>
                {result.conflicts.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        {restoredAt ? (
          <p className="run-changes-done" role="status">
            Alterações desfeitas. Os arquivos voltaram ao estado de antes desta execução.
          </p>
        ) : (
          <button
            type="button"
            className="secondary-button run-changes-undo"
            disabled={busy || restoring || Boolean(checkpoint.omitted)}
            title={
              checkpoint.omitted
                ? 'Execuções com muitos arquivos não podem ser desfeitas por aqui'
                : busy
                  ? 'Aguarde a execução atual terminar'
                  : undefined
            }
            onClick={() => {
              setResult(null);
              setConfirming(true);
            }}
          >
            <Undo2 size={14} /> Desfazer alterações desta execução
          </button>
        )}
      </details>
      {confirming && (
        <ConfirmRestore
          count={total}
          added={files.filter((f) => f.status === 'added').length}
          restoring={restoring}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void restore()}
        />
      )}
    </div>
  );
}

/** "Os 2 arquivos alterados voltam…; o arquivo criado por ela é removido." */
export function restoreSentence(changed: number, added: number) {
  const back =
    changed === 1
      ? 'O arquivo alterado ou removido volta ao conteúdo que tinha antes desta execução'
      : changed
        ? `Os ${changed} arquivos alterados ou removidos voltam ao conteúdo que tinham antes desta execução`
        : '';
  const gone = added
    ? added === 1
      ? 'o arquivo criado por ela é removido'
      : `os ${added} arquivos criados por ela são removidos`
    : '';
  const text = [back, gone].filter(Boolean).join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function ConfirmRestore({
  count,
  added,
  restoring,
  onCancel,
  onConfirm,
}: {
  count: number;
  added: number;
  restoring: boolean;
  onCancel: () => void;
  onConfirm: () => void;
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
        if (event.target === event.currentTarget && !restoring) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !restoring) onCancel();
      }}
    >
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="restore-title"
        aria-describedby="restore-detail"
      >
        <div className="modal-heading">
          <div className="project-avatar" aria-hidden="true">
            <Undo2 size={17} />
          </div>
          <div>
            <h2 id="restore-title">Desfazer alterações desta execução?</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onCancel} disabled={restoring}>
            <X size={17} />
          </button>
        </div>
        <div id="restore-detail" className="restore-detail">
          <p>{restoreSentence(count - added, added)}</p>
          <p>
            Se algum deles foi editado depois da execução, nada é desfeito e a lista desses arquivos aparece aqui.
            Outros arquivos, commits, branches, índice e stash do git não são alterados.
          </p>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel} disabled={restoring}>
            Cancelar
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={restoring}>
            {restoring ? <LoaderCircle className="spin" size={14} /> : <Undo2 size={14} />}
            Desfazer alterações
          </button>
        </div>
      </div>
    </div>
  );
}
